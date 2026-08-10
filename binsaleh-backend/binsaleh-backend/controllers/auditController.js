// controllers/auditController.js
// Activity log (#14) — reads the AuditLog collection for the admin panel.

const AuditLog = require('../models/AuditLog');

// GET /api/admin/audit?category=&limit=
exports.getAuditLogs = async (req, res) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 200, 500);
    const filter = {};
    if (req.query.category) filter.category = req.query.category;
    const logs = await AuditLog.find(filter).sort({ createdAt: -1 }).limit(limit).lean();
    res.json(logs);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// DELETE /api/admin/audit
exports.clearAuditLogs = async (req, res) => {
  try {
    await AuditLog.deleteMany({});
    res.json({ message: 'Audit log cleared' });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};
