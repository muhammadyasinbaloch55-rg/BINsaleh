// models/LoginHistory.js
// Audit log for EVERY login attempt (success + failure) — requirement #8.
// Used for brute-force detection, user notifications (#9), and admin review.

const mongoose = require('mongoose');

const loginHistorySchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true },
    email: { type: String, lowercase: true, index: true },

    success: { type: Boolean, default: false },
    reason: String, // 'success' | 'invalid_credentials' | 'user_not_found' | 'locked' | 'email_unverified' | '2fa_required' | '2fa_failed' | '2fa_ok'

    // Context
    ip: String,
    country: String,
    city: String,
    userAgent: String,
    browser: String,
    os: String,
    deviceType: String,
    deviceName: String,

    // Duration of the login request (ms) — helps spot credential-stuffing bots
    durationMs: Number
  },
  { timestamps: true }
);

// Auto-expire audit records after 90 days to keep the collection lean.
loginHistorySchema.index({ createdAt: 1 }, { expireAfterSeconds: 90 * 24 * 60 * 60 });

module.exports = mongoose.model('LoginHistory', loginHistorySchema);
