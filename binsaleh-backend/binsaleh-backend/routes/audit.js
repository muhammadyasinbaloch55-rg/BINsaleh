// routes/audit.js
// Activity / audit log (#14)

const express = require('express');
const router = express.Router();
const { protect, isAdmin } = require('../middleware/auth');
const { getAuditLogs, clearAuditLogs } = require('../controllers/auditController');

// GET /api/admin/audit?category=&limit=
router.get('/', protect, isAdmin, getAuditLogs);

// DELETE /api/admin/audit
router.delete('/', protect, isAdmin, clearAuditLogs);

module.exports = router;
