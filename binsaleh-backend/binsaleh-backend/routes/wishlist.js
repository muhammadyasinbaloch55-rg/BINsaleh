// routes/wishlist.js
// Wishlist endpoints (#4)

const express = require('express');
const router = express.Router();
const { protect, isAdmin } = require('../middleware/auth');
const {
  getWishlist,
  addToWishlist,
  removeFromWishlist,
  syncWishlist,
  getWishlistStats
} = require('../controllers/wishlistController');

// Customer wishlist
router.get('/', protect, getWishlist);
router.post('/', protect, addToWishlist);
router.delete('/:productId', protect, removeFromWishlist);
router.post('/sync', protect, syncWishlist);

// Admin stats
router.get('/stats', protect, isAdmin, getWishlistStats);

module.exports = router;
