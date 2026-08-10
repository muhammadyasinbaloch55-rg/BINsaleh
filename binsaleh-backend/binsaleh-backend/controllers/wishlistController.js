// controllers/wishlistController.js
// Complete wishlist system (#4).
// Customers can add/remove/view wishlist items; after login the guest
// localStorage wishlist is merged server-side (POST /api/wishlist/sync).

const Wishlist = require('../models/Wishlist');
const Product = require('../models/Product');
const { log } = require('../services/auditService');

async function getWishlistDoc(userId) {
  let doc = await Wishlist.findOne({ user: userId });
  if (!doc) {
    doc = await Wishlist.create({ user: userId, items: [] });
  }
  return doc;
}

// GET /api/wishlist — list wishlist with populated products
exports.getWishlist = async (req, res) => {
  try {
    const doc = await getWishlistDoc(req.user.id);
    const items = await Promise.all((doc.items || []).map(async it => {
      let product = null;
      try { product = await Product.findById(it.product).lean(); } catch (e) { /* skip */ }
      return product ? { _id: it._id, productId: it.product, addedAt: it.addedAt, product } : null;
    }));
    res.json({ items: items.filter(Boolean) });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// POST /api/wishlist — { productId }
exports.addToWishlist = async (req, res) => {
  try {
    const { productId } = req.body;
    if (!productId) return res.status(400).json({ message: 'productId required' });
    const product = await Product.findById(productId);
    if (!product) return res.status(404).json({ message: 'Product not found' });

    const doc = await getWishlistDoc(req.user.id);
    const exists = (doc.items || []).some(i => String(i.product) === String(productId));
    if (!exists) {
      doc.items.push({ product: productId, addedAt: new Date() });
      await doc.save();
    }
    const itemCount = doc.items.length;
    await log({ category: 'admin_action', action: 'Wishlist add', details: { product: product.name, userId: String(req.user.id) }, actor: req.user?.email || 'user' });
    res.json({ message: 'Added to wishlist', itemCount });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// DELETE /api/wishlist/:productId
exports.removeFromWishlist = async (req, res) => {
  try {
    const doc = await getWishlistDoc(req.user.id);
    doc.items = (doc.items || []).filter(i => String(i.product) !== String(req.params.productId));
    await doc.save();
    res.json({ message: 'Removed from wishlist', itemCount: doc.items.length });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// POST /api/wishlist/sync — merge guest localStorage items after login
// Body: { productIds: string[] }
exports.syncWishlist = async (req, res) => {
  try {
    const productIds = Array.isArray(req.body.productIds) ? req.body.productIds : [];
    const doc = await getWishlistDoc(req.user.id);
    const existing = new Set((doc.items || []).map(i => String(i.product)));
    for (const pid of productIds) {
      if (!existing.has(String(pid))) {
        const product = await Product.findById(pid).select('_id').lean();
        if (product) {
          doc.items.push({ product: pid, addedAt: new Date() });
          existing.add(String(pid));
        }
      }
    }
    await doc.save();
    res.json({ message: 'Wishlist synced', itemCount: doc.items.length });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// GET /api/wishlist/stats — admin: total wishlist users + most-wished products
exports.getWishlistStats = async (req, res) => {
  try {
    const docs = await Wishlist.find().lean();
    const productCount = {};
    let totalUsers = 0;
    docs.forEach(doc => {
      if (doc.items && doc.items.length) {
        totalUsers++;
        doc.items.forEach(i => {
          const pid = String(i.product);
          productCount[pid] = (productCount[pid] || 0) + 1;
        });
      }
    });
    const topProducts = await Promise.all(
      Object.entries(productCount)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10)
        .map(async ([pid, count]) => {
          const p = await Product.findById(pid).lean().select('name price img images');
          return { product: p ? p.name : pid, productId: pid, count, image: p ? (p.img || (p.images && p.images[0]) || '') : '' };
        })
    );
    res.json({ totalUsers, totalItems: docs.reduce((s, d) => s + (d.items ? d.items.length : 0), 0), topProducts });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};
