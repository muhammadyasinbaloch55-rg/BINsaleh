// controllers/orderController.js

const Order = require('../models/Order');
const Settings = require('../models/Settings');
const { sendOrderConfirmation, sendAdminNewOrderNotification, sendOrderStatusEmail } = require('../services/emailService');
const { decrementStockForOrder, restoreStockForOrder, validateStockForOrder } = require('../services/stockService');
const { emit } = require('../services/realtime');
const { log } = require('../services/auditService');
const Notification = require('../models/Notification');

// Helper: read a settings key, auto-creating nothing (returns null if missing)
async function getSettingValue(key) {
  try {
    const s = await Settings.findOne({ key });
    if (!s) return null;
    return typeof s.value === 'string' ? JSON.parse(s.value) : s.value;
  } catch (e) {
    return null;
  }
}

// Helper: compute the COD advance required for an order total
async function computeAdvance(total, paymentMethod) {
  if (paymentMethod !== 'cod') return 0;
  const cod = await getSettingValue('cod_settings') || { enabled: true, advanceType: 'fixed', fixedAmount: 50, percentage: 30 };
  if (cod.enabled === false) return 0;
  if (cod.advanceType === 'percentage') {
    return Math.round((Number(total) || 0) * (Number(cod.percentage) || 0) / 100);
  }
  if (cod.advanceType === 'none') return 0;
  return Number(cod.fixedAmount) || 0; // fixed (default)
}

// POST /api/orders
// addTocurt.html ka placeOrder() ye call karega
exports.createOrder = async (req, res) => {
  try {
    const body = req.body;

    if (!body.items || !body.items.length) {
      return res.status(400).json({ message: 'Order must have at least one item' });
    }

    const customerName = body.shippingAddress?.firstName || 'Valued Customer';
    const customerEmail = body.contact?.includes('@') ? body.contact : null;
    const paymentMethod = body.paymentMethod || 'cod';

    // SECURITY: never trust a client-supplied paymentStatus='paid'. If the
    // frontend claims an online gateway payment succeeded, the backend re-verifies
    // it with the gateway's API using the transaction id. If verification fails or
    // the transaction id is missing, the order is created as 'pending' (the admin
    // confirms payment manually) — a malicious client can never forge a paid order.
    let gatewayVerified = null;
    if (['zeina', 'paypal'].includes(paymentMethod) && body.paymentStatus === 'paid') {
      try {
        const { verifyGatewayPayment } = require('./paymentController');
        gatewayVerified = await verifyGatewayPayment(paymentMethod, body.paymentDetails && body.paymentDetails.transactionId);
        if (!gatewayVerified || !gatewayVerified.verified) {
          console.warn('⚠️ Gateway payment verification failed (' + paymentMethod + '):', gatewayVerified && gatewayVerified.reason);
        }
      } catch (e) {
        console.warn('⚠️ Gateway payment verification error (' + paymentMethod + '):', e.message);
        gatewayVerified = { verified: false, reason: e.message };
      }
    }
    const isGatewayPaid = !!(gatewayVerified && gatewayVerified.verified);
    const paymentStatus = isGatewayPaid ? 'paid' : 'pending';

    // ---- Coupon application (#3) ----
    // Validate the coupon WITHOUT consuming a use first (via validateCoupon),
    // compute the discount server-side, then after the order is persisted we
    // consume the use through applyCoupon. This avoids losing a use if the
    // order creation fails and prevents client-side tampering of the amount.
    let couponInfo = null;
    if (body.coupon && body.coupon.code) {
      try {
        const { validateCoupon } = require('./couponController');
        let vResult = null;
        await validateCoupon(
          { body: { code: body.coupon.code, subtotal: Number(body.subtotal) || 0, customerEmail: body.contact && body.contact.includes('@') ? body.contact : null } },
          { json: (d) => { vResult = d; }, status: () => ({ json: (d) => { vResult = d; } }) }
        );
        if (vResult && vResult.valid) {
          couponInfo = {
            code: vResult.code,
            type: vResult.type,
            discount: vResult.discount,
            discountAmount: vResult.discountAmount
          };
        }
      } catch (e) {
        // Coupon failure shouldn't block the order — log and continue
        console.warn('⚠️ Coupon validate failed:', e.message);
      }
    }

    // Authoritative total: subtotal + shipping − coupon discount.
    // This prevents double-discounting if the client already applied the coupon
    // to the total it sent. We trust only the raw subtotal + shippingCost here.
    const rawSubtotal = Number(body.subtotal) || 0;
    const rawShipping = Number(body.shippingCost) || 0;
    const couponDiscount = couponInfo ? (Number(couponInfo.discountAmount) || 0) : 0;
    const total = Math.max(0, rawSubtotal + rawShipping - couponDiscount);

    // ---- COD advance payment (#2) ----
    // advanceRequired is ALWAYS derived server-side from cod_settings
    // (fixed / percentage / none) so the client can't tamper with it.
    // advancePaid comes from the customer (0 if not paid yet).
    // remainingAmount = total - advancePaid (what's due at delivery).
    const advanceRequired = await computeAdvance(total, paymentMethod);
    // For fully-paid online orders (Zeina/PayPal) the whole amount is settled,
    // so the remaining-on-delivery balance is 0. Only COD keeps a balance due.
    const isPaidOnline = paymentStatus === 'paid';
    // Client-supplied advances are NEVER trusted at creation (#1): for a paid
    // online order the amount comes from the gateway verification (server-side),
    // never from the client; for COD the advance starts at 0 and is only recorded
    // by the admin via the payment-confirmation endpoint after verification.
    const advancePaid = isPaidOnline ? (Number(gatewayVerified && gatewayVerified.paidAmount) || total) : 0;
    const remainingAmount = isPaidOnline ? 0 : Math.max(0, total - advancePaid);

    const orderData = {
      user: req.user ? req.user.id : null,
      items: body.items,
      contact: body.contact,
      shippingAddress: body.shippingAddress,
      shippingMethod: body.shippingMethod,
      shippingCost: body.shippingCost,
      paymentMethod: paymentMethod,
      paymentStatus: paymentStatus,
      subtotal: body.subtotal,
      total: total,
      currency: body.currency || 'AED',
      advanceRequired: advanceRequired,
      advancePaid: advancePaid,
      remainingAmount: remainingAmount
    };

    // Attach coupon if it validated successfully — total is ALREADY the
    // authoritative discounted value (subtotal + shipping − discount).
    if (couponInfo) {
      orderData.coupon = couponInfo;
      // remainingAmount reflects the discounted total for COD
      if (remainingAmount > 0) orderData.remainingAmount = Math.max(0, total - advancePaid);
    }

    // Include paymentDetails if provided (for non-COD payments with transaction ID)
    if (body.paymentDetails) {
      orderData.paymentDetails = {
        transactionId: body.paymentDetails.transactionId || '',
        paidAmount: body.paymentDetails.paidAmount || total || 0,
        paidAt: body.paymentDetails.paidAt ? new Date(body.paymentDetails.paidAt) : new Date(),
        confirmedBy: body.paymentDetails.confirmedBy || body.contact || '',
        notes: body.paymentDetails.notes || ''
      };
    }

    // ---- Stock availability check (#1) ----
    // Reject the order outright if any item exceeds available stock so the
    // customer is informed immediately instead of getting a partial order.
    const stockCheck = await validateStockForOrder(body.items);
    if (!stockCheck.ok) {
      return res.status(400).json({
        message: 'Some items are out of stock or exceed available quantity: ' + stockCheck.shortages.join(', ')
      });
    }

    const order = await Order.create(orderData);

    // ---- Consume coupon use AFTER successful order creation (#3) ----
    if (couponInfo) {
      try {
        const { applyCoupon } = require('./couponController');
        await applyCoupon(
          { body: { code: couponInfo.code, subtotal: rawSubtotal, customerEmail: body.contact && body.contact.includes('@') ? body.contact : null } },
          { json: () => {}, status: () => ({ json: () => {} }) }
        );
        await log({
          category: 'coupon',
          action: 'Coupon applied to order',
          details: { orderId: String(order._id), code: couponInfo.code, discountAmount: couponInfo.discountAmount },
          actor: body.contact || 'guest'
        });
      } catch (e) {
        console.warn('⚠️ Coupon consumption failed:', e.message);
      }
    }

    // ---- Decrement stock (#1) ----
    // Do this asynchronously so the order response isn't delayed, but if the
    // order exceeds available stock we still record it (stock clamps at 0).
    // Use the persisted order.items (server-verified) rather than raw client body.
    decrementStockForOrder(order.items).then(r => {
      if (r && !r.ok) console.warn('⚠️ Some items were out of stock:', r.shortages);
    }).catch(e => console.warn('⚠️ Stock decrement failed:', e.message));

    // ---- Admin notification + real-time push (#9, #11) ----
    const shortId = order._id ? String(order._id).slice(-6).toUpperCase() : '';
    Notification.create({
      type: 'new_order',
      title: '🆕 New Order #' + shortId,
      message: (customerName || 'Customer') + ' — ' + (order.currency || 'AED') + ' ' + (order.total || 0).toLocaleString(),
      refType: 'order',
      refId: String(order._id)
    }).catch(() => {});
    emit('new_order', { orderId: String(order._id), total: order.total, shortId });
    emit('notification', { type: 'new_order' });
    emit('revenue_change', { total: order.total });
    if (req.user) emit('new_customer', { userId: String(req.user.id) });

    // Send email notifications asynchronously (don't block response)
    if (customerEmail) {
      sendOrderConfirmation({
        customerEmail,
        customerName,
        orderId: order._id.toString(),
        items: body.items,
        total: order.total,
        paymentMethod: body.paymentMethod,
        currency: order.currency || 'AED'
      }).catch(() => {});
    }
    
    // Always send admin notification (authoritative discounted total)
    sendAdminNewOrderNotification({
      orderId: order._id.toString(),
      customerName,
      customerContact: body.contact,
      total: order.total,
      paymentMethod: body.paymentMethod
    }).catch(() => {});

    res.status(201).json(order);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
};

// GET /api/orders
// Admin panel ke liye — sab orders
exports.getOrders = async (req, res) => {
  try {
    // Fetch all orders sorted newest first, using lean() for plain JS objects
    const orders = await Order.find().sort({ createdAt: -1 }).lean();
    
    // For each order, try to look up product images from the Product collection
    const Product = require('../models/Product');
    const populatedOrders = await Promise.all(orders.map(async (order) => {
      if (order.items && order.items.length > 0) {
        const populatedItems = await Promise.all(order.items.map(async (item) => {
          // If the item already has an image, keep it
          if (item.image) return item;
          // Try to find the product in the database
          if (item.productId) {
            try {
              const product = await Product.findById(item.productId).lean().select('img images name');
              if (product) {
                // If item doesn't have a name, use product's name
                if (!item.name && product.name) item.name = product.name;
                // Set the image from the product
                if (!item.image) {
                  item.image = product.img || (product.images && product.images.length > 0 ? product.images[0] : '');
                }
              }
            } catch (e) {
              // If product lookup fails, keep item as-is
            }
          }
          return item;
        }));
        order.items = populatedItems;
      }
      return order;
    }));
    
    res.json(populatedOrders);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// GET /api/orders/stats
// Admin dashboard ke liye — live aggregate stats straight from the DB (#5)
exports.getStats = async (req, res) => {
  try {
    const User = require('../models/User');
    const Review = require('../models/Review');

    const [
      totalOrders,
      pendingOrders,
      confirmedOrders,
      processingOrders,
      packedOrders,
      shippedOrders,
      outForDeliveryOrders,
      deliveredOrders,
      cancelledOrders,
      refundedOrders,
      revenueAgg,
      totalCustomers,
      totalReviews,
      totalSubscribers
    ] = await Promise.all([
      Order.countDocuments(),
      Order.countDocuments({ status: 'pending' }),
      Order.countDocuments({ status: 'confirmed' }),
      Order.countDocuments({ status: 'processing' }),
      Order.countDocuments({ status: 'packed' }),
      Order.countDocuments({ status: 'shipped' }),
      Order.countDocuments({ status: 'out_for_delivery' }),
      Order.countDocuments({ status: 'delivered' }),
      Order.countDocuments({ status: 'cancelled' }),
      Order.countDocuments({ status: 'refunded' }),
      // Revenue excludes cancelled AND refunded orders
      Order.aggregate([
        { $match: { status: { $nin: ['cancelled', 'refunded'] } } },
        { $group: { _id: null, total: { $sum: '$total' } } }
      ]),
      User.countDocuments({ role: 'customer' }),
      Review.countDocuments(),
      User.countDocuments({ newsletter: true })
    ]);

    res.json({
      totalOrders,
      pendingOrders,
      confirmedOrders,
      processingOrders,
      packedOrders,
      shippedOrders,
      outForDeliveryOrders,
      deliveredOrders,
      cancelledOrders,
      refundedOrders,
      totalRevenue: revenueAgg.length ? revenueAgg[0].total : 0,
      totalCustomers,
      totalReviews,
      totalSubscribers
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// GET /api/orders/my
// Logged-in customer apni orders dekhe (profile.html ke liye)
exports.getMyOrders = async (req, res) => {  try {
    const orders = await Order.find({ user: req.user.id }).sort({ createdAt: -1 });
    res.json(orders);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// GET /api/orders/:id
exports.getOrderById = async (req, res) => {
  try {
    const order = await Order.findById(req.params.id);
    if (!order) return res.status(404).json({ message: 'Order not found' });
    // IDOR protection: a customer can only view their own order; admins see
    // all. Guest (ownerless) orders are admin-only — no customer should be able
    // to fetch another person's order by guessing its id.
    if (req.user.role !== 'admin' && (!order.user || String(order.user) !== String(req.user.id))) {
      return res.status(403).json({ message: 'Access denied' });
    }
    res.json(order);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// PUT /api/orders/:id/status
// Order tracking (#13): admin updates the status; we record history,
// email the customer, restore stock on cancel/refund, and push real-time events.
const STATUS_LABELS = {
  pending: 'Pending', confirmed: 'Confirmed', processing: 'Processing', packed: 'Packed',
  shipped: 'Shipped', out_for_delivery: 'Out for Delivery', delivered: 'Delivered',
  cancelled: 'Cancelled', refunded: 'Refunded'
};

exports.updateOrderStatus = async (req, res) => {
  try {
    const { status, note, trackingNumber } = req.body;
    if (!STATUS_LABELS[status]) return res.status(400).json({ message: 'Invalid status' });

    const existing = await Order.findById(req.params.id);
    if (!existing) return res.status(404).json({ message: 'Order not found' });

    // Build history + updates
    const historyEntry = {
      status,
      note: note || '',
      changedAt: new Date(),
      by: req.user ? req.user.email || req.user.name || 'admin' : 'admin'
    };
    const update = {
      $set: { status },
      $push: { statusHistory: historyEntry }
    };
    if (trackingNumber) update.$set.trackingNumber = trackingNumber;

    // Restore stock when cancelled/refunded
    const cancelsStock = status === 'cancelled' || status === 'refunded';
    const wasNotCancelled = existing.status !== 'cancelled' && existing.status !== 'refunded';
    if (cancelsStock && wasNotCancelled) {
      restoreStockForOrder(existing.items).catch(e => console.warn('⚠️ Stock restore failed:', e.message));
    }

    const order = await Order.findByIdAndUpdate(req.params.id, update, { returnDocument: 'after', runValidators: true });

    // Email the customer on status change (#13)
    const customerEmail = existing.contact && existing.contact.includes('@') ? existing.contact : null;
    const customerName = (existing.shippingAddress && existing.shippingAddress.firstName) || 'Valued Customer';
    if (customerEmail && status !== 'pending') {
      sendOrderStatusEmail({
        customerEmail,
        customerName,
        orderId: order._id.toString(),
        status,
        trackingNumber: trackingNumber || existing.trackingNumber || '',
        extra: note
      }).catch(() => {});
    }

    // Notification + real-time event
    const shortId = order._id ? String(order._id).slice(-6).toUpperCase() : '';
    Notification.create({
      type: 'order_status',
      title: '📦 Order #' + shortId + ' → ' + (STATUS_LABELS[status] || status),
      message: customerName + ' — status updated',
      refType: 'order',
      refId: String(order._id)
    }).catch(() => {});
    emit('order_status', { orderId: String(order._id), status, shortId });
    emit('notification', { type: 'order_status' });

    await log({
      category: 'order',
      action: 'Order status changed',
      details: { orderId: String(order._id), from: existing.status, to: status, note: note || '' },
      actor: req.user ? req.user.email || 'admin' : 'admin',
      ip: req.ip || ''
    });

    res.json(order);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
};

// PUT /api/orders/:id/payment
// Admin panel se payment confirm karna (transaction ID, paid amount, etc.)
exports.confirmPayment = async (req, res) => {
  try {
    const { transactionId, paidAmount, notes } = req.body;
    // Keep advance fields consistent: Remaining = Total - Advance Paid (#2)
    const existing = await Order.findById(req.params.id);
    if (!existing) return res.status(404).json({ message: 'Order not found' });
    const orderTotal = existing.total || 0;
    const paid = Number(paidAmount) || Number(req.body.total) || orderTotal;
    // Accumulate onto any advance already recorded (don't overwrite), capped at total
    const advancePaid = Math.min(orderTotal, (Number(existing.advancePaid) || 0) + paid);
    const remainingAmount = Math.max(0, orderTotal - advancePaid);
    const order = await Order.findByIdAndUpdate(
      req.params.id,
      {
        paymentStatus: 'paid',
        advancePaid: advancePaid,
        remainingAmount: remainingAmount,
        paymentDetails: {
          transactionId: transactionId || '',
          paidAmount: advancePaid,
          paidAt: new Date(),
          confirmedBy: req.user ? req.user.email || req.user.name || 'admin' : 'admin',
          notes: notes || ''
        }
      },
      { returnDocument: 'after', runValidators: true }
    );
    if (!order) return res.status(404).json({ message: 'Order not found' });

    // Payment-success notification + real-time event (#9)
    const shortId = order._id ? String(order._id).slice(-6).toUpperCase() : '';
    Notification.create({
      type: 'payment_success',
      title: '✅ Payment Confirmed #' + shortId,
      message: (order.currency || 'AED') + ' ' + advancePaid.toLocaleString() + ' paid',
      refType: 'order',
      refId: String(order._id)
    }).catch(() => {});
    emit('payment_success', { orderId: String(order._id), amount: advancePaid, shortId });
    emit('notification', { type: 'payment_success' });
    emit('revenue_change', { total: order.total });

    await log({
      category: 'order',
      action: 'Payment confirmed',
      details: { orderId: String(order._id), amount: advancePaid },
      actor: req.user ? req.user.email || 'admin' : 'admin',
      ip: req.ip || ''
    });

    res.json(order);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
};

// PUT /api/orders/:id/payment-status
// Generalized admin payment-status update: paid | failed | cancelled.
//  - paid:      record transaction + amount (same behaviour as confirmPayment)
//  - failed:    mark FAILED and restore the reserved stock (order won't ship)
//  - cancelled: mark CANCELLED and restore the reserved stock
// The customer's own "I have paid" click can never reach this endpoint —
// it is admin-only (protect + isAdmin).
exports.setPaymentStatus = async (req, res) => {
  try {
    const { status, transactionId, paidAmount, notes } = req.body;
    const target = String(status || '').toLowerCase();
    if (!['paid', 'failed', 'cancelled'].includes(target)) {
      return res.status(400).json({ message: 'Invalid payment status. Use paid, failed or cancelled.' });
    }

    const existing = await Order.findById(req.params.id);
    if (!existing) return res.status(404).json({ message: 'Order not found' });

    const orderTotal = existing.total || 0;
    const paid = Number(paidAmount) || Number(req.body.total) || orderTotal;
    const advancePaid = Math.min(orderTotal, (Number(existing.advancePaid) || 0) + paid);
    const remainingAmount = Math.max(0, orderTotal - advancePaid);

    const updates = {
      paymentStatus: target,
      awaitingVerification: false
    };
    if (target === 'paid') {
      updates.advancePaid = advancePaid;
      updates.remainingAmount = remainingAmount;
      updates.paymentDetails = {
        transactionId: transactionId || existing.providerReference || '',
        paidAmount: advancePaid,
        paidAt: new Date(),
        confirmedBy: req.user ? req.user.email || req.user.name || 'admin' : 'admin',
        notes: notes || ''
      };
    } else {
      // failed / cancelled — release the reserved stock exactly once
      // (stockRestored guards against a double-restore on later deletion)
      if (!existing.stockRestored) {
        restoreStockForOrder(existing.items).catch(e => console.warn('⚠️ Stock restore failed:', e.message));
        updates.stockRestored = true;
      }
      // A cancelled payment means the order will not be fulfilled — mirror
      // the customer-side cancelBankAppPayment behaviour (status: cancelled).
      if (target === 'cancelled') updates.status = 'cancelled';
    }

    const order = await Order.findByIdAndUpdate(req.params.id, updates, { returnDocument: 'after', runValidators: true });
    if (!order) return res.status(404).json({ message: 'Order not found' });

    const shortId = order._id ? String(order._id).slice(-6).toUpperCase() : '';
    const isPaid = target === 'paid';
    Notification.create({
      type: isPaid ? 'payment_success' : 'order_status',
      title: (isPaid ? '✅ Payment Confirmed #' : '💳 Payment ' + target.toUpperCase() + ' #') + shortId,
      message: (order.currency || 'AED') + ' ' + (order.total || 0).toLocaleString(),
      refType: 'order',
      refId: String(order._id)
    }).catch(() => {});
    emit(isPaid ? 'payment_success' : 'order_status', { orderId: String(order._id), amount: order.total, shortId });
    emit('notification', { type: isPaid ? 'payment_success' : 'order_status' });
    if (isPaid) emit('revenue_change', { total: order.total });

    await log({
      category: 'order',
      action: 'Payment ' + target,
      details: { orderId: String(order._id), amount: order.total, status: target },
      actor: req.user ? req.user.email || 'admin' : 'admin',
      ip: req.ip || ''
    });

    res.json(order);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
};

// DELETE /api/orders/:id
exports.deleteOrder = async (req, res) => {
  try {
    const order = await Order.findByIdAndDelete(req.params.id);
    if (!order) return res.status(404).json({ message: 'Order not found' });
    // Restore stock for cancelled/deleted orders
    if (order.status !== 'cancelled' && order.status !== 'refunded' && !order.stockRestored) {
      restoreStockForOrder(order.items).catch(e => console.warn('⚠️ Stock restore failed:', e.message));
    }
    await log({
      category: 'order',
      action: 'Order deleted',
      details: { orderId: String(order._id) },
      actor: req.user ? req.user.email || 'admin' : 'admin',
      ip: req.ip || ''
    });
    emit('order_deleted', { orderId: String(order._id) });
    res.json({ message: 'Order deleted successfully' });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};
