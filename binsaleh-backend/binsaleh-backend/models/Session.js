// models/Session.js
// Tracks every active login session so we can:
//  - Issue & rotate refresh tokens (#14)
//  - Terminate all sessions instantly ("No, secure my account") (#4)
//  - Auto-expire inactive sessions (#15)
// The refresh token is stored ONLY as a sha256 hash (never plaintext).

const mongoose = require('mongoose');

const sessionSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    refreshTokenHash: { type: String, required: true, unique: true, index: true }, // sha256(refreshToken)

    // Device / context captured at login
    ip: String,
    country: String,
    city: String,
    userAgent: String,
    device: {
      fingerprint: String,
      name: String,
      browser: String,
      os: String,
      deviceType: String
    },

    // Lifecycle
    createdAt: { type: Date, default: Date.now },
    lastActiveAt: { type: Date, default: Date.now }, // touched on every protected request
    expiresAt: { type: Date, required: true },       // absolute expiry (SESSION_MAX_DAYS)
    revokedAt: Date,                                  // set when terminated (logout, password change, deny)
    revokedReason: String
  },
  { timestamps: true }
);

// Auto-expire: index so the cleanup job can find stale sessions fast.
sessionSchema.index({ expiresAt: 1 });
sessionSchema.index({ revokedAt: 1 });

// Convenience: is this session still usable right now?
sessionSchema.methods.isActive = function () {
  return !this.revokedAt && (!this.expiresAt || this.expiresAt > new Date());
};

module.exports = mongoose.model('Session', sessionSchema);
