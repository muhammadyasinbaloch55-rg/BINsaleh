// models/Product.js
// Ye fields exactly admainpenal.html ke saveProduct() function se match karte hain,
// taake frontend mein zyada tabdeeli na karni pade.

const mongoose = require('mongoose');

const colorVariantSchema = new mongoose.Schema({
  name: { type: String, trim: true },
  hex: { type: String, trim: true }
}, { _id: false });

const productSchema = new mongoose.Schema({
  name:      { type: String, required: true, trim: true },
  category:  { type: String, required: true, trim: true }, // tops, bottoms, footwear, accessories, fragrances, tracksuits, home-kitchen
  price:     { type: Number, required: true },
  oldPrice:  { type: Number, default: 0 },
  currency:  { type: String, default: 'AED' },              // AED / USD (store currency is AED)
  badge:     { type: String, default: '' },                 // e.g. "New", "Sale"
  inStock:   { type: Boolean, default: true },

  // ===== Inventory Management (#1) =====
  stock:            { type: Number, default: 0 },   // numeric quantity on hand
  lowStockThreshold:{ type: Number, default: 5 },   // alert when stock <= this

  images:    [{ type: String }],  // gallery image URLs
  img:       { type: String },    // main/cover image (images[0])

  colors:    [colorVariantSchema],

  details:   { type: String, default: '' },
  care:      { type: String, default: '' },
  size:      { type: String, default: '' },
  shipping:  { type: String, default: '' }
}, {
  timestamps: true // createdAt, updatedAt auto add ho jayenge
});

// Keep the legacy inStock boolean in sync with numeric stock when stock is present.
// NOTE: synchronous hook (no `next`) — required for Mongoose 9, where the
// callback-style `next` argument is no longer passed to pre-save middleware.
productSchema.pre('save', function () {
  if (typeof this.stock === 'number' && this.isModified('stock')) {
    this.inStock = this.stock > 0;
  }
});

// Ensure 'id' is included in JSON output alongside '_id'
productSchema.set('toJSON', { virtuals: true });

module.exports = mongoose.model('Product', productSchema);
