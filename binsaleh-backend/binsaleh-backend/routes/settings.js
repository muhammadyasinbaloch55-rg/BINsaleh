// routes/settings.js

const express = require('express');
const router = express.Router();
const { getSetting, getAllSettings, updateSetting, deleteSetting } = require('../controllers/settingsController');
const { protect, isAdmin } = require('../middleware/auth');
const config = require('../config/security');
const { sendEmail } = require('../services/emailService');

// Admin-only: list all settings
router.get('/', protect, isAdmin, getAllSettings);

// Public read for store frontend (announcements, slider, etc.)
// Sensitive keys like admin_setup_key are protected — but allow when authenticated
router.get('/:key', async (req, res) => {
  // Block sensitive keys from public access ONLY if not authenticated
  const sensitiveKeys = ['admin_setup_key', 'jwt_secret', 'smtp_settings'];
  if (sensitiveKeys.includes(req.params.key)) {
    // Check if the request has a valid admin token (via Authorization header)
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
      try {
        const jwt = require('jsonwebtoken');
        const decoded = jwt.verify(authHeader.slice(7), config.JWT_SECRET);
        if (decoded && decoded.role === 'admin') {
          return getSetting(req, res);
        }
      } catch(e) {
        // Token invalid — fall through to deny
      }
    }
    return res.status(403).json({ message: 'Access denied. Admin authentication required.' });
  }
  return getSetting(req, res);
});

// Public: Get enabled payment methods (without sensitive gateway config)
router.get('/public/payment-methods', async (req, res) => {
  try {
    const Settings = require('../models/Settings');
    let setting = await Settings.findOne({ key: 'payment_settings' });
    if (!setting) {
      return res.status(404).json({ message: 'Payment settings not configured' });
    }
    const paymentSettings = typeof setting.value === 'string' ? JSON.parse(setting.value) : setting.value;
    
    // Return only enabled methods, strip sensitive config
    const methods = (paymentSettings.methods || [])
      .filter(m => m.enabled)
      .map(m => ({
        id: m.id,
        name: m.name,
        icon: m.icon,
        type: m.type,
        sortOrder: m.sortOrder || 99,
        // For gateway types, only expose non-sensitive info
        ...(m.type === 'gateway' ? {
          hasConfig: !!(m.config && (
            (m.id === 'paypal' && m.config.clientId) ||
            (m.id === 'stripe' && m.config.publishableKey)
          ))
        } : {})
      }))
      .sort((a, b) => (a.sortOrder || 99) - (b.sortOrder || 99));
    
    res.json({ methods });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Admin: test email configuration
router.post('/test-email', protect, isAdmin, async (req, res) => {
  try {
    const { to } = req.body;
    const targetEmail = to || 'binsalehllc946@gmail.com';
    const result = await sendEmail({
      to: targetEmail,
      subject: '🔧 Test Email — BIN SALEH Store',
      html: '<h2>Test Email</h2><p>If you received this, your email settings are working correctly!</p><p>Sent from BIN SALEH Store Admin Panel.</p>'
    });
    // sendEmail never throws — it resolves with { success: true/false }.
    // Report the REAL result so the admin panel can show failures accurately.
    if (result && result.success) {
      return res.json({ message: 'Test email sent successfully' });
    }
    const reason = (result && result.error) || 'SMTP credentials missing or invalid';
    return res.status(500).json({ message: 'Email failed to send: ' + reason });
  } catch (err) {
    res.status(500).json({ message: 'Email failed to send: ' + err.message });
  }
});

// Admin-only: update or delete settings
router.put('/:key', protect, isAdmin, updateSetting);
router.delete('/:key', protect, isAdmin, deleteSetting);

module.exports = router;