// services/auditService.js
// Writes entries to the AuditLog collection (#14).
// Used for: stock changes, coupon usage, invoice generation, report exports,
//           review moderation, admin actions.

const AuditLog = require('../models/AuditLog');

async function log({ category, action, details = {}, actor = 'system', ip = '' }) {
  try {
    const entry = await AuditLog.create({ category, action, details, actor, ip });
    return entry;
  } catch (e) {
    console.warn('⚠️ Audit log write failed:', e.message);
    return null;
  }
}

module.exports = { log };
