// routes/auth.js

const express = require('express');
const router = express.Router();
const {
  register, login, getMe, registerAdmin, subscribeNewsletter,
  getSubscribers, getUsers, changePassword, changeEmail,
  verifyEmail, resendVerification,
  refresh, logout, logoutAll, getSessions, revokeSession,
  setup2FA, enable2FA, disable2FA, verify2FA,
  confirmDevice, denyDevice, getLoginHistory,
  approveAdminRequest, denyAdminRequest, getAdminApprovals,
  getAdminDevices, revokeAdminDevice
} = require('../controllers/authController');
const { protect, isAdmin } = require('../middleware/auth');
const { authLimiter, refreshLimiter } = require('../middleware/security');

// ---- Public endpoints (rate-limited to deter brute force / abuse) (#7) ----
router.post('/register', authLimiter, register);
router.post('/login', authLimiter, login);
router.post('/register-admin', authLimiter, registerAdmin);
router.post('/refresh', refreshLimiter, refresh);
router.get('/verify-email', verifyEmail);            // link opened from email
router.post('/resend-verification', authLimiter, resendVerification);
router.post('/newsletter/subscribe', subscribeNewsletter);

// ---- "Was this you?" security links (opened from email, unauthenticated) (#3) ----
router.get('/security/device-confirm', confirmDevice);
router.get('/security/device-deny', denyDevice);

// ---- Admin approval links (opened from owner's email, unauthenticated) (#5) ----
router.get('/approval/allow', approveAdminRequest);
router.get('/approval/deny', denyAdminRequest);

// ---- Admin approval management (admin panel convenience) ----
router.get('/approvals', protect, isAdmin, getAdminApprovals);

// ---- Admin trusted-device management (owner convenience) ----
router.get('/admin-devices', protect, isAdmin, getAdminDevices);
router.post('/admin-devices/revoke', protect, isAdmin, revokeAdminDevice);

// ---- Protected endpoints ----
router.get('/me', protect, getMe);
router.post('/change-password', protect, changePassword);
router.post('/change-email', protect, changeEmail);
router.post('/logout', protect, logout);
router.post('/logout-all', protect, logoutAll);
router.get('/sessions', protect, getSessions);
router.post('/sessions/:id/revoke', protect, revokeSession);

// ---- 2FA (#18) ----
router.post('/2fa/setup', protect, setup2FA);
router.post('/2fa/enable', protect, enable2FA);
router.post('/2fa/disable', protect, disable2FA);
router.post('/2fa/verify', authLimiter, verify2FA); // step 2 of login (temp token + code)

// ---- Admin-only ----
router.get('/subscribers', protect, isAdmin, getSubscribers);
router.delete('/subscribers/:id', protect, isAdmin, async (req, res) => {
  try {
    const User = require('../models/User');
    const user = await User.findByIdAndUpdate(req.params.id, { newsletter: false }, { new: true });
    if (!user) return res.status(404).json({ message: 'User not found' });
    res.json({ message: 'Subscriber removed' });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});
router.get('/users', protect, isAdmin, getUsers);
router.get('/security/login-history', protect, isAdmin, getLoginHistory);

module.exports = router;
