// services/stockService.js
// Inventory management helpers (#1, #2):
//   - decrementStock: reduce product stock when an order is placed (never negative)
//   - restoreStock:   add stock back when an order is cancelled/refunded
//   - checkLowStock:  after any stock change, if stock <= lowStockThreshold,
//                     send an email to the business + create a dashboard notification.

const Product = require('../models/Product');
const { sendLowStockAlert } = require('./emailService');
const { emit } = require('./realtime');
const { log } = require('./auditService');
const Notification = require('../models/Notification');

/**
 * Decrement stock for the items in an order. Uses findOneAndUpdate with a
 * $gte guard on the current stock so we can never push stock below 0.
 * Returns { ok: true } or { ok: false, shortages: [productName, ...] }.
 */
async function decrementStockForOrder(items) {
  const shortages = [];
  for (const item of items || []) {
    if (!item.productId) continue;
    const product = await Product.findById(item.productId);
    if (!product) continue;

    const qty = Number(item.quantity) || 1;

    // ATOMIC decrement with a stock guard — prevents the read-then-write race
    // where two concurrent orders could both decrement from the same stale value.
    // findOneAndUpdate with { stock: { $gte: qty } } + $inc only succeeds if there
    // is enough stock, giving us a clean insufficient-stock signal.
    const updated = await Product.findOneAndUpdate(
      { _id: item.productId, stock: { $gte: qty } },
      { $inc: { stock: -qty }, $set: { inStock: true } },
      { returnDocument: 'after' }
    );

    if (!updated) {
      // Not enough stock for the full quantity — flag it so the admin knows
      // stock wasn't fully decremented. Also includes fully-out-of-stock items.
      const current = await Product.findById(item.productId);
      if (current) {
        shortages.push((current.name || item.productId) + ' (only ' + (Number(current.stock) || 0) + ' left)');
      }
      continue;
    }

    const newStock = Number(updated.stock) || 0;
    // If stock hit exactly 0, mark out of stock
    if (newStock <= 0) {
      await Product.updateOne({ _id: updated._id }, { $set: { inStock: false } });
    }

    await log({
      category: 'stock',
      action: 'Stock decremented',
      details: { product: updated.name, productId: String(updated._id), by: qty, newStock },
      actor: 'system'
    });
    emit('stock_update', { productId: String(updated._id), stock: newStock, name: updated.name });
    // Low-stock check right after the change
    await checkLowStock(updated);
  }
  return shortages.length ? { ok: false, shortages } : { ok: true };
}

/** Add stock back for cancelled/refunded orders. */
async function restoreStockForOrder(items) {
  for (const item of items || []) {
    if (!item.productId) continue;
    const product = await Product.findById(item.productId);
    if (!product) continue;
    const qty = Number(item.quantity) || 1;
    const newStock = (Number(product.stock) || 0) + qty;
    const updated = await Product.findByIdAndUpdate(
      item.productId,
      { $set: { stock: newStock, inStock: true } },
      { returnDocument: 'after' }
    );
    if (updated) {
      await log({
        category: 'stock',
        action: 'Stock restored',
        details: { product: updated.name, productId: String(updated._id), by: qty, newStock },
        actor: 'system'
      });
      emit('stock_update', { productId: String(updated._id), stock: newStock, name: updated.name });
    }
  }
}

/** If stock <= threshold, email the owner + create a low_stock notification. */
async function checkLowStock(product) {
  try {
    if (!product) return;
    const threshold = Number(product.lowStockThreshold != null ? product.lowStockThreshold : 5);
    const stock = Number(product.stock) || 0;
    if (stock > threshold) return;

    // Email the owner
    sendLowStockAlert({
      productName: product.name,
      productId: product._id ? String(product._id) : '',
      stock,
      threshold
    }).catch(() => {});

    // Dashboard notification
    const existing = await Notification.findOne({
      type: 'low_stock',
      refType: 'product',
      refId: String(product._id),
      read: false
    });
    if (!existing) {
      await Notification.create({
        type: 'low_stock',
        title: '⚠️ Low Stock: ' + (product.name || 'Product'),
        message: `Only ${stock} left (threshold ${threshold}).`,
        refType: 'product',
        refId: String(product._id)
      });
      emit('low_stock', { productId: String(product._id), name: product.name, stock, threshold });
      emit('notification', { type: 'low_stock' });
    }
  } catch (e) {
    console.warn('⚠️ Low stock check failed:', e.message);
  }
}

/**
 * Pre-flight stock validation before an order is persisted.
 * Returns { ok: true } or { ok: false, shortages: [productName (only X left), ...] }.
 */
async function validateStockForOrder(items) {
  const shortages = [];
  for (const item of items || []) {
    if (!item.productId) continue;
    const product = await Product.findById(item.productId);
    if (!product) {
      shortages.push('Unknown product');
      continue;
    }
    const qty = Number(item.quantity) || 1;
    if ((Number(product.stock) || 0) < qty) {
      shortages.push((product.name || 'Product') + ' (only ' + (Number(product.stock) || 0) + ' left)');
    }
  }
  return shortages.length ? { ok: false, shortages } : { ok: true };
}

module.exports = { decrementStockForOrder, restoreStockForOrder, checkLowStock, validateStockForOrder };
