// models/Review.js
// Product reviews stored in MongoDB — Admin can approve/reject/delete

const mongoose = require('mongoose');

const reviewSchema = new mongoose.Schema({
  product: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', required: true },
  name:    { type: String, required: true, trim: true },
  email:   { type: String, default: '' },
  rating:  { type: Number, required: true, min: 1, max: 5 },
  text:    { type: String, required: true, trim: true },
  verified:{ type: Boolean, default: false },
  status:  { type: String, enum: ['pending', 'approved', 'rejected'], default: 'pending' },
  // Admin reply shown on the product page under the review
  reply:   { type: String, default: '' },
  replyAt: { type: Date, default: null }
}, {
  timestamps: true
});

reviewSchema.set('toJSON', { virtuals: true });

module.exports = mongoose.model('Review', reviewSchema);
