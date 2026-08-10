// models/AdminApproval.js
// Tracks PENDING admin login/registration requests that require manual
// owner approval before access is granted (requirements #3, #4, #5, #6).
//
// Workflow:
//  1. Admin attempts login or register  → status = 'pending'
//  2. Owner receives email with Allow/Deny links (signed tokens)
//  3. Allow  → status = 'approved', access granted
//     Deny   → status = 'denied',     access blocked
//  4. Approved login/register requests can then be consumed (user logs in).

const mongoose = require('mongoose');

const adminApprovalSchema = new mongoose.Schema(
  {
    kind: { type: String, enum: ['login', 'register'], required: true }, // what is being requested

    // Who is requesting access
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true },
    email: { type: String, lowercase: true, required: true },
    name: { type: String, default: '' },

    // Request context (included in the owner's notification email)
    ip: String,
    country: String,
    city: String,
    browser: String,
    os: String,
    deviceType: String,
    deviceName: String,
    userAgent: String,
    deviceFingerprint: String, // sha256(UA + accept-language) — used to mark device trusted on Allow

    // Approval lifecycle
    status: { type: String, enum: ['pending', 'approved', 'denied', 'expired'], default: 'pending' },
    decidedAt: Date,
    consumedAt: Date,            // set when the approved request is actually used (login)
    expiresAt: { type: Date, default: () => new Date(Date.now() + 48 * 60 * 60 * 1000) } // 48h links
  },
  { timestamps: true }
);

adminApprovalSchema.index({ status: 1, createdAt: -1 });

module.exports = mongoose.model('AdminApproval', adminApprovalSchema);
