// controllers/notificationController.js
// Admin Notification Center — fully DB-backed (#9, #10).
// Replaces the old counts-only endpoint with a real CRUD API:
//   GET    /api/admin/notifications         (list, ?unreadOnly=1, ?limit)
//   PUT    /api/admin/notifications/:id     (mark read/unread)
//   PUT    /api/admin/notifications/read-all (mark all read)
//   DELETE /api/admin/notifications/:id     (delete)
//   DELETE /api/admin/notifications        (clear all)

const Notification = require('../models/Notification');

// GET /api/admin/notifications
exports.getNotifications = async (req, res) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 50, 200);
    const filter = {};
    if (req.query.unreadOnly === '1') filter.read = false;

    const [notifications, unreadCount, totalCount] = await Promise.all([
      Notification.find(filter).sort({ createdAt: -1 }).limit(limit).lean(),
      Notification.countDocuments({ read: false }),
      Notification.countDocuments()
    ]);

    res.json({ notifications, unreadCount, totalCount, serverTime: new Date().toISOString() });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// PUT /api/admin/notifications/:id — mark read/unread
exports.updateNotification = async (req, res) => {
  try {
    const read = req.body.read;
    const update = {};
    if (typeof read === 'boolean') update.read = read;
    if (read === true) update.readAt = new Date();
    const notif = await Notification.findByIdAndUpdate(req.params.id, update, { returnDocument: 'after' });
    if (!notif) return res.status(404).json({ message: 'Notification not found' });
    res.json(notif);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
};

// PUT /api/admin/notifications/read-all
exports.markAllRead = async (req, res) => {
  try {
    await Notification.updateMany({ read: false }, { $set: { read: true, readAt: new Date() } });
    res.json({ message: 'All notifications marked as read' });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// DELETE /api/admin/notifications/:id
exports.deleteNotification = async (req, res) => {
  try {
    const notif = await Notification.findByIdAndDelete(req.params.id);
    if (!notif) return res.status(404).json({ message: 'Notification not found' });
    res.json({ message: 'Notification deleted' });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// DELETE /api/admin/notifications — clear all
exports.clearAll = async (req, res) => {
  try {
    await Notification.deleteMany({});
    res.json({ message: 'All notifications cleared' });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};
