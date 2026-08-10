// models/User.js
// Enterprise security fields added to support:
//  - Email verification (#10)
//  - Brute-force lockout & failed attempt tracking (#5, #6, #8)
//  - 2FA / TOTP (#18)
//  - Known-device tracking ("Was this you?" flow) (#2, #3, #4)
//  - Forced password reset / must-change-password flag (#4)

const mongoose = require('mongoose');

// A device fingerprint tracked against the account so logins from a NEW
// device/browser/location can trigger a "Was this you?" security alert.
const knownDeviceSchema = new mongoose.Schema(
  {
    fingerprint: { type: String, required: true, index: true }, // sha256(UA + accept-language)
    name: { type: String, default: 'Unknown device' },          // e.g. "Chrome on Windows 11"
    browser: { type: String, default: 'Unknown' },
    os: { type: String, default: 'Unknown' },
    deviceType: { type: String, default: 'desktop' },
    ip: String,
    country: String,
    city: String,
    firstSeen: { type: Date, default: Date.now },
    lastSeen: { type: Date, default: Date.now },
    verified: { type: Boolean, default: false }, // true after user clicks "Yes, it was me"
    // true after the OWNER approves this device via the admin approval workflow —
    // trusted devices bypass the per-login approval email (password + 2FA only).
    trusted: { type: Boolean, default: false }
  },
  { _id: false }
);

const userSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    password: { type: String, required: true }, // bcrypt-hashed only — never plaintext (#12, #13)
    newsletter: { type: Boolean, default: false },
    role: { type: String, enum: ['customer', 'admin'], default: 'customer' },

    // ---------- Email verification (#10) ----------
    emailVerified: { type: Boolean, default: false },
    emailVerificationTokenHash: String,      // sha256 of the plaintext token
    emailVerificationExpires: Date,
    emailVerifiedAt: Date,

    // ---------- Brute-force lockout (#5, #6, #8) ----------
    failedLoginAttempts: { type: Number, default: 0 },
    lockUntil: Date,                          // temporary lock expiry
    lockStrikes: { type: Number, default: 0 }, // for escalating lock duration
    lastFailedAt: Date,
    lastFailedIp: String,

    // ---------- Last successful login ----------
    lastLoginAt: Date,
    lastLoginIp: String,
    lastLoginCountry: String,

    // ---------- Forced password reset (#4) ----------
    passwordChangedAt: Date,                  // used to invalidate old access JWTs (iat < passwordChangedAt)
    mustChangePassword: { type: Boolean, default: false },

    // ---------- 2FA / TOTP (#18) ----------
    twoFactorEnabled: { type: Boolean, default: false },
    twoFactorSecret: String,                  // base32 secret (encrypt at rest in production)
    twoFactorBackupCodes: { type: [String], default: [] }, // hashed backup codes

    // ---------- Admin approval workflow (#3, #4, #6) ----------
    // Admin accounts are NOT active until the owner approves the request.
    adminApproved: { type: Boolean, default: false },
    adminBlocked: { type: Boolean, default: false },

    // ---------- Known devices ("Was this you?") ----------
    knownDevices: { type: [knownDeviceSchema], default: [] }
  },
  {
    timestamps: true
  }
);

// Ensure 'id' is included in JSON output alongside '_id'
userSchema.set('toJSON', { virtuals: true });

module.exports = mongoose.model('User', userSchema);
