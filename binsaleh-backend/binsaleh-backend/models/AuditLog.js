// models/AuditLog.js
// Records admin/system actions for the Activity Log page (#14):
//   stock changes, coupon usage, invoice generation, report exports,
//   review moderation, admin actions, etc.

const mongoose = require('mongoose');

const auditLogSchema = new mongoose.Schema({
  category: {
    type: String,
    enum: ['stock', 'coupon', 'invoice', 'report', 'review', 'admin_action', 'order', 'product', 'auth', 'system'],
    default: 'system'
  },
  action:   { type: String, required: true },   // e.g. "Stock decremented", "Coupon applied", "Invoice generated"
  details:  { type: mongoose.Schema.Types.Mixed, default: {} },
  actor:    { type: String, default: 'system' }, // admin email or 'system'
  ip:       { type: String, default: '' }
}, { timestamps: true });

auditLogSchema.index({ createdAt: -1 });
auditLogSchema.index({ category: 1, createdAt: -1 });

auditLogSchema.set('toJSON', { virtuals: true });

module.exports = mongoose.model('AuditLog', auditLogSchema);
