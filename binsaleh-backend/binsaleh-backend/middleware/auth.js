// middleware/auth.js
// Session-aware JWT protection.
//
// Access token payload: { id, role, sid } where sid = Session._id.
// Every protected request:
//   1. Verifies the access JWT (#14)
//   2. Loads the session record → rejects revoked/expired sessions (#4, #15)
//   3. Loads the user → rejects locked accounts (#6)
//   4. Rejects JWTs issued before a password change (#4, #15)
//   5. Touches lastActiveAt (throttled) for idle-expiry (#15)

const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');
const Session = require('../models/Session');
const User = require('../models/User');
const config = require('../config/security');

const IDLE_MS = config.SESSION_IDLE_DAYS * 24 * 60 * 60 * 1000;

// Load session + user, applying all active-session checks.
// Returns { user, session } or null.
async function resolveAuthenticatedUser(req) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) return null;

  const token = authHeader.split(' ')[1];
  let decoded;
  try {
    decoded = jwt.verify(token, config.JWT_SECRET);
  } catch (err) {
    return null; // invalid or expired access token
  }

  const userId = decoded.id;
  if (!userId || !mongoose.Types.ObjectId.isValid(String(userId))) return null;

  const user = await User.findById(userId).select('-password -twoFactorSecret -twoFactorBackupCodes -emailVerificationTokenHash');
  if (!user) return null;

  // Locked accounts are barred from all protected routes (#6)
  if (user.lockUntil && user.lockUntil > new Date()) {
    const err = new Error('Account temporarily locked due to too many failed attempts.');
    err.status = 423;
    err.code = 'ACCOUNT_LOCKED';
    throw err;
  }

  // Admin approval gate: denied or unapproved admins are barred (#4, #6).
  // Emails on the owner's approval-bypass list are always allowed through.
  if (user.role === 'admin' && !config.isAdminApprovalBypassed(user.email)) {
    if (user.adminBlocked) {
      const err = new Error('Your admin access has been denied by the owner.');
      err.status = 403;
      err.code = 'ADMIN_DENIED';
      throw err;
    }
    if (!user.adminApproved) {
      const err = new Error('Your admin account is awaiting owner approval.');
      err.status = 403;
      err.code = 'ADMIN_PENDING';
      throw err;
    }
  }

  // JWT issued before a password change → force re-login (#4, #15)
  if (decoded.iat && user.passwordChangedAt) {
    const changedSec = Math.floor(new Date(user.passwordChangedAt).getTime() / 1000);
    if (decoded.iat < changedSec) return null;
  }

  // Session check (only for tokens that carry a sid — old tokens still work)
  if (decoded.sid) {
    if (!mongoose.Types.ObjectId.isValid(String(decoded.sid))) return null;
    const session = await Session.findById(decoded.sid);
    if (!session || session.revokedAt) return null;
    if (session.expiresAt && session.expiresAt < new Date()) return null;
    if (session.userId.toString() !== user._id.toString()) return null;

    // Idle-expiry (#15)
    if (session.lastActiveAt && (Date.now() - new Date(session.lastActiveAt).getTime()) > IDLE_MS) return null;

    // Touch lastActiveAt (throttled to once per 2 minutes to limit writes)
    if (Date.now() - new Date(session.lastActiveAt).getTime() > 2 * 60 * 1000) {
      session.lastActiveAt = new Date();
      await session.save().catch(() => {});
    }
    req.session = session;
  }

  req.user = {
    id: user._id,
    role: user.role,
    email: user.email,
    name: user.name,
    emailVerified: !!user.emailVerified,
    twoFactorEnabled: !!user.twoFactorEnabled,
    sessionId: decoded.sid || null
  };
  return { user, session: req.session || null };
}

// "protect" — full authentication required
exports.protect = async (req, res, next) => {
  try {
    const ctx = await resolveAuthenticatedUser(req);
    if (!ctx) {
      return res.status(401).json({ message: 'Not authorized, please log in again.' });
    }
    next();
  } catch (err) {
    if (err.code === 'ACCOUNT_LOCKED') {
      return res.status(423).json({ message: err.message });
    }
    if (err.code === 'ADMIN_DENIED' || err.code === 'ADMIN_PENDING') {
      return res.status(403).json({ message: err.message, code: err.code });
    }
    return res.status(401).json({ message: 'Not authorized, please log in again.' });
  }
};

// "optionalProtect" — sets req.user if a valid token exists, else continues as guest
// (guest checkout). Also used for "am I logged in?" checks.
exports.optionalProtect = async (req, res, next) => {
  try {
    const ctx = await resolveAuthenticatedUser(req);
    if (ctx) {
      req.user = ctx.user;
      req.session = ctx.session;
    }
  } catch (err) {
    // Even on lockout, guest flow should continue (no token = guest).
    // If there WAS a token, resolveAuthenticatedUser already decided.
  }
  next();
};

// "isAdmin" — admin role gate
exports.isAdmin = (req, res, next) => {
  if (req.user && req.user.role === 'admin') {
    next();
  } else {
    res.status(403).json({ message: 'Admin access only' });
  }
};
