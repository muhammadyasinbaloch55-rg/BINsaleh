// routes/notifications.js
// Admin Notification Center (#9, #10)

const express = require('express');
const router = express.Router();
const { protect, isAdmin } = require('../middleware/auth');
const {
  getNotifications,
  updateNotification,
  markAllRead,
  deleteNotification,
  clearAll
} = require('../controllers/notificationController');

// GET /api/admin/notifications?unreadOnly=1&limit=
router.get('/', protect, isAdmin, getNotifications);

// PUT /api/admin/notifications/read-all
router.put('/read-all', protect, isAdmin, markAllRead);

// PUT /api/admin/notifications/:id — mark read/unread
router.put('/:id', protect, isAdmin, updateNotification);

// DELETE /api/admin/notifications/:id
router.delete('/:id', protect, isAdmin, deleteNotification);

// DELETE /api/admin/notifications — clear all
router.delete('/', protect, isAdmin, clearAll);

module.exports = router;
