// controllers/productController.js

const Product = require('../models/Product');

/* -------------------------------------------------------------------------
   Helper: normalize a product's image fields for frontend compatibility
   Creates a NEW object — does NOT mutate the original.
   Ensures both `images[]` and `img` are always present (never undefined).
   Handles edge cases:
     - images being a string instead of array
     - images containing empty/null/undefined entries
     - img being an array instead of string
     - images[0] containing a falsy value
-------------------------------------------------------------------------- */
function normalizeImages(p) {
  if (!p) return p;
  // Build output with spread (lean() returns plain objects, so spread is safe)
  const out = { ...p };

  // ----- Normalize images field -----
  let imgArray = out.images;
  let imgStr = out.img;

  // If images is a plain string, convert to single-element array
  if (typeof imgArray === 'string') {
    imgArray = imgArray ? [imgArray] : [];
  }
  // If images is not a valid array, try to build from img
  if (!Array.isArray(imgArray) || !imgArray.length) {
    imgArray = (imgStr && typeof imgStr === 'string') ? [imgStr] : [];
  } else {
    // Filter out any falsy/empty entries from the array
    imgArray = imgArray.filter(function(url) {
      return url && typeof url === 'string' && url !== 'undefined' && url !== 'null' && url.trim() !== '';
    });
  }
  out.images = imgArray;

  // ----- Normalize img field -----
  // If img is an array (edge case), use its first element
  if (Array.isArray(imgStr)) {
    imgStr = imgStr.length ? imgStr[0] : '';
  }
  // If img is missing or empty, fall back to images[0]
  if (!imgStr || imgStr === 'undefined' || imgStr === 'null') {
    imgStr = (imgArray.length) ? imgArray[0] : '';
  }
  out.img = imgStr;

  // Final consistency check: if one field is truthy but the other isn't
  if (!imgArray.length && imgStr) {
    out.images = [imgStr];
  }

  return out;
}

// GET /api/products
// Sab products laane ke liye (index.html, viewall.html, category pages)
exports.getProducts = async (req, res) => {
  try {
    const { category } = req.query;
    // Case-insensitive category matching using regex
    // Also trim and lowercase the query param for robust matching
    let filter = {};
    if (category) {
      const catSlug = category.trim().toLowerCase();
      filter = { category: { $regex: new RegExp('^' + catSlug.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$', 'i') } };
    }
    const products = await Product.find(filter).sort({ createdAt: -1 }).lean();
    // Normalize each product — creates clean copies, never mutates originals
    const normalized = products.map(p => normalizeImages(p));
    res.json(normalized);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// GET /api/products/:id
// Single product details page
exports.getProductById = async (req, res) => {
  try {
    const product = await Product.findById(req.params.id).lean();
    if (!product) return res.status(404).json({ message: 'Product not found' });
    res.json(normalizeImages(product));
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// POST /api/products
// Naya product banane ke liye (admin panel se)
exports.createProduct = async (req, res) => {
  try {
    const body = { ...req.body };

    // Ensure images[] contains at least img if images is missing
    if (!body.images || !Array.isArray(body.images) || !body.images.length) {
      body.images = body.img ? [body.img] : [];
    }
    // Ensure img is set from images[0] if missing
    if (!body.img && body.images.length) {
      body.img = body.images[0];
    }

    // Stock defaults (#1)
    if (typeof body.stock !== 'number') body.stock = Number(body.stock) || 0;
    if (typeof body.lowStockThreshold !== 'number') body.lowStockThreshold = Number(body.lowStockThreshold) || 5;
    body.inStock = body.stock > 0;

    const product = await Product.create(body);
    const { log } = require('../services/auditService');
    const { emit } = require('../services/realtime');
    await log({ category: 'product', action: 'Product created', details: { name: product.name, productId: String(product._id), stock: product.stock }, actor: req.user ? req.user.email || 'admin' : 'admin' });
    emit('stock_update', { productId: String(product._id), stock: product.stock, name: product.name });
    res.status(201).json(product);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
};

// PUT /api/products/:id
// Product edit karne ke liye (admin panel se)
exports.updateProduct = async (req, res) => {
  try {
    const body = { ...req.body };

    // Ensure images[] contains at least img if images is missing
    if (!body.images || !Array.isArray(body.images) || !body.images.length) {
      body.images = body.img ? [body.img] : [];
    }
    // Ensure img is set from images[0] if missing
    if (!body.img && body.images.length) {
      body.img = body.images[0];
    }

    // Stock handling — if stock provided, sync inStock; check low-stock after (#1, #2)
    let lowStockCheck = null;
    if (body.stock !== undefined) {
      const prev = await Product.findById(req.params.id).lean();
      body.stock = Number(body.stock) || 0;
      if (typeof body.lowStockThreshold !== 'number') {
        body.lowStockThreshold = prev && prev.lowStockThreshold != null ? prev.lowStockThreshold : 5;
      }
      body.inStock = body.stock > 0;
      lowStockCheck = { prev, next: { ...prev, ...body } };
    }

    const product = await Product.findByIdAndUpdate(req.params.id, body, {
      returnDocument: 'after',
      runValidators: true
    });

    if (!product) return res.status(404).json({ message: 'Product not found' });

    // Audit + real-time + low-stock alert on manual stock changes (#14, #11, #2)
    const { log } = require('../services/auditService');
    const { emit } = require('../services/realtime');
    const { checkLowStock } = require('../services/stockService');
    if (lowStockCheck) {
      await log({
        category: 'stock',
        action: 'Stock updated (manual)',
        details: { name: product.name, productId: String(product._id), from: lowStockCheck.prev ? (lowStockCheck.prev.stock || 0) : 'n/a', to: product.stock },
        actor: req.user ? req.user.email || 'admin' : 'admin'
      });
      emit('stock_update', { productId: String(product._id), stock: product.stock, name: product.name });
      checkLowStock(product).catch(e => console.warn('⚠️ Low stock check failed:', e.message));
    }
    res.json(product);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
};

// DELETE /api/products/:id
exports.deleteProduct = async (req, res) => {
  try {
    const product = await Product.findByIdAndDelete(req.params.id);
    if (!product) return res.status(404).json({ message: 'Product not found' });
    const { log } = require('../services/auditService');
    const { emit } = require('../services/realtime');
    await log({ category: 'product', action: 'Product deleted', details: { name: product.name, productId: String(product._id) }, actor: req.user ? req.user.email || 'admin' : 'admin' });
    emit('product_deleted', { productId: String(product._id) });
    res.json({ message: 'Product deleted' });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};
