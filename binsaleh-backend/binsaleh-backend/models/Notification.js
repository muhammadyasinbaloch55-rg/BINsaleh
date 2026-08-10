// models/Notification.js
// Admin Notification Center — persisted in MongoDB.
// Types: new_order | new_review | low_stock | admin_login_request | payment_success | order_status | stock_update | coupon

const mongoose = require('mongoose');

const notificationSchema = new mongoose.Schema({
  type: {
    type: String,
    enum: ['new_order', 'new_review', 'low_stock', 'admin_login_request', 'payment_success', 'order_status', 'stock_update', 'coupon', 'system'],
    default: 'system'
  },
  title:   { type: String, required: true },
  message: { type: String, default: '' },
  // Reference to the related entity (order id, review id, product id, approval id, etc.)
  refType: { type: String, default: '' },
  refId:   { type: mongoose.Schema.Types.Mixed, default: null },
  read:    { type: Boolean, default: false },
  readAt:  { type: Date, default: null }
}, { timestamps: true });

notificationSchema.index({ read: 1, createdAt: -1 });
notificationSchema.index({ createdAt: -1 });

notificationSchema.set('toJSON', { virtuals: true });

module.exports = mongoose.model('Notification', notificationSchema);
