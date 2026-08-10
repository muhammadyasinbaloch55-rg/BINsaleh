// models/Wishlist.js
// Customer wishlist. A user may have at most ONE wishlist document;
// guest wishlists are stored in localStorage and merged on login.

const mongoose = require('mongoose');

const wishlistSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, unique: true },
  items: [
    {
      product:  { type: mongoose.Schema.Types.ObjectId, ref: 'Product', required: true },
      addedAt:  { type: Date, default: Date.now }
    }
  ]
}, { timestamps: true });

wishlistSchema.set('toJSON', { virtuals: true });

module.exports = mongoose.model('Wishlist', wishlistSchema);
