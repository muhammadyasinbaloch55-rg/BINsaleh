// controllers/authController.js
// Enterprise-grade authentication controller.
//
// Implements the full security spec:
//  #1  Email on login / register / password change / email change / 2FA toggle / new device/browser/location
//  #2  Unknown-device security alert (time, IP, browser, OS, location, device name)
//  #3  "Was this you?" Yes/No buttons in the alert email
//  #4  "No" → terminate all sessions, invalidate refresh tokens, force password reset, notify admin, require re-login
//  #5/#6  Brute-force detection + temporary account lockout
//  #7  Rate limiting (see middleware/security.js authLimiter)
//  #8  Every login attempt logged to LoginHistory
//  #9  Email notification after repeated failed attempts
//  #10 Email verification required before login
//  #11 Duplicate registration prevented (unique email + explicit check)
//  #12/#13 bcrypt hashing — never plaintext
//  #14 Access + refresh tokens (Session model, hashed refresh tokens)
//  #15 Sessions auto-expire (idle + absolute)
//  #17 Strong password complexity
//  #18 Optional TOTP 2FA

const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const User = require('../models/User');
const Session = require('../models/Session');
const LoginHistory = require('../models/LoginHistory');
const AdminApproval = require('../models/AdminApproval');
const config = require('../config/security');
const security = require('../services/securityService');
const emailService = require('../services/emailService');

// SECURITY: never use a committed default setup key — if ADMIN_SETUP_KEY is not
// configured, generate a strong random one at boot so nobody can register an
// admin with a known key. Set ADMIN_SETUP_KEY as an env var (Render dashboard)
// to provision admins; until then admin registration is effectively disabled.
const ADMIN_SETUP_KEY = process.env.ADMIN_SETUP_KEY || crypto.randomBytes(24).toString('hex');
if (!process.env.ADMIN_SETUP_KEY) {
  console.warn('⚠️  ADMIN_SETUP_KEY is NOT set! Generated a temporary random key —');
  console.warn('    admin registration is disabled until you set ADMIN_SETUP_KEY in env vars.');
}

// Precomputed bcrypt hash used to equalize response timing when a user is not found
// (prevents user-enumeration via timing side-channels).
const DUMMY_PASSWORD_HASH = bcrypt.hashSync('dummy-password-for-timing', 10);

/* ------------------------------------------------------------------
   Helpers
------------------------------------------------------------------ */
function safeUser(user) {
  return security.sanitizeUser(user);
}

function buildDeviceInfo(req) {
  const ua = security.parseUserAgent(req.headers['user-agent'] || '');
  return {
    fingerprint: security.deviceFingerprint(req),
    name: ua.name,
    browser: ua.browser,
    os: ua.os,
    deviceType: ua.deviceType,
    userAgent: (req.headers['user-agent'] || '').slice(0, 300)
  };
}

function getClientIp(req) {
  return security.getClientIp(req);
}

// Log a login attempt (fire & forget — never blocks the response).
function logAttempt({ userId, email, success, reason, req, durationMs }) {
  const ip = getClientIp(req);
  const device = buildDeviceInfo(req);
  const entry = {
    userId: userId || null,
    email: email || '',
    success: !!success,
    reason: reason || '',
    ip,
    userAgent: device.userAgent,
    browser: device.browser,
    os: device.os,
    deviceType: device.deviceType,
    deviceName: device.name,
    durationMs
  };
  // Geolocation is best-effort; log entry is written regardless.
  security.getIpLocation(ip).then(loc => {
    if (loc && loc.country) { entry.country = loc.country; entry.city = loc.city; }
    return LoginHistory.create(entry).catch(() => {});
  }).catch(() => {
    return LoginHistory.create(entry).catch(() => {});
  });
}

// Create a Session doc and return access + refresh tokens.
async function createSessionAndTokens(user, req) {
  const refreshToken = security.generateRefreshToken();
  const session = await Session.create({
    userId: user._id,
    refreshTokenHash: security.hashRefreshToken(refreshToken),
    ip: getClientIp(req),
    userAgent: (req.headers['user-agent'] || '').slice(0, 300),
    device: buildDeviceInfo(req),
    expiresAt: new Date(Date.now() + config.REFRESH_TOKEN_EXPIRES_DAYS * 24 * 60 * 60 * 1000)
  });
  const accessToken = security.signAccessToken(user, session._id);
  return { accessToken, refreshToken, session };
}

// Build "Was this you?" URLs for a user + device fingerprint.
function buildConfirmDenyUrls(userId, fingerprint) {
  const confirmToken = security.signSecurityToken({ sub: userId, purpose: 'device-confirm', device: fingerprint });
  const denyToken = security.signSecurityToken({ sub: userId, purpose: 'device-deny', device: fingerprint });
  return {
    confirmUrl: `${config.API_URL}/api/auth/security/device-confirm?token=${confirmToken}`,
    denyUrl: `${config.API_URL}/api/auth/security/device-deny?token=${denyToken}`
  };
}

// Determine new device / new country and update knownDevices.
async function evaluateDeviceContext(user, req) {
  const fp = security.deviceFingerprint(req);
  const device = buildDeviceInfo(req);
  const location = await security.getIpLocation(getClientIp(req));

  const known = user.knownDevices || [];
  const existingDevice = known.find(d => d.fingerprint === fp);
  const isNewDevice = !existingDevice;
  const isNewCountry = !!user.lastLoginCountry && !!location.country && user.lastLoginCountry !== location.country;

  if (existingDevice) {
    existingDevice.lastSeen = new Date();
    existingDevice.ip = getClientIp(req);
    existingDevice.country = location.country || existingDevice.country;
    existingDevice.city = location.city || existingDevice.city;
    existingDevice.verified = true; // logging in again from this device confirms it
  } else {
    known.push({
      fingerprint: fp,
      name: device.name,
      browser: device.browser,
      os: device.os,
      deviceType: device.deviceType,
      ip: getClientIp(req),
      country: location.country,
      city: location.city,
      firstSeen: new Date(),
      lastSeen: new Date(),
      verified: false // becomes true when the user clicks "Yes, it was me"
    });
  }
  return { fingerprint: fp, device, location, isNewDevice, isNewCountry, existingDevice };
}

// Send login notification email ("Was this you?" when new device/country).
async function notifyLogin(user, req, ctx) {
  if (!config.SEND_LOGIN_NOTIFICATION) return;
  const locationStr = [ctx.location.city, ctx.location.country].filter(Boolean).join(', ');
  const details = {
    time: new Date().toLocaleString(),
    ip: getClientIp(req),
    browser: ctx.device.browser,
    os: ctx.device.os,
    deviceName: ctx.device.name,
    location: locationStr || 'Unknown',
    isNewDevice: ctx.isNewDevice,
    isNewCountry: ctx.isNewCountry,
    // Admins' new devices are vetted via the owner-approval workflow, so the
    // customer-flow "Was this you?" buttons are suppressed for admin accounts.
    isAdmin: user.role === 'admin'
  };
  const { confirmUrl, denyUrl } = buildConfirmDenyUrls(user._id, ctx.fingerprint);
  await emailService.sendLoginNotification({ email: user.email, name: user.name, details, confirmUrl, denyUrl });
}

// Handle a failed login: atomically increment the counter (avoids race conditions
// between parallel attempts), lock when the threshold is hit, then email.
async function handleFailedLogin(user, req, reason = 'invalid_credentials') {
  const ip = getClientIp(req);
  const now = new Date();

  // Atomic $inc so concurrent failed logins can't double-count or skip the lock.
  const updated = await User.findByIdAndUpdate(
    user._id,
    { $inc: { failedLoginAttempts: 1 }, $set: { lastFailedAt: now, lastFailedIp: ip } },
    { new: true }
  );
  const attempts = (updated && updated.failedLoginAttempts) || (user.failedLoginAttempts || 0) + 1;

  let lockMinutes = 0;
  let locked = false;
  if (attempts >= config.MAX_FAILED_ATTEMPTS) {
    const base = config.LOCKOUT_BASE_MINUTES;
    const strikes = (updated && updated.lockStrikes) || user.lockStrikes || 0;
    const multiplier = Math.pow(2, Math.min(strikes, 5)); // escalates: 15m, 30m, 1h...
    lockMinutes = Math.min(base * multiplier, config.LOCKOUT_CAP_MINUTES);
    const lockUntil = new Date(now.getTime() + lockMinutes * 60 * 1000);
    await User.updateOne(
      { _id: user._id },
      { $set: { lockUntil, failedLoginAttempts: 0 }, $inc: { lockStrikes: 1 } }
    );
    locked = true;
  }

  // Emails (#9 + admin alert)
  if (locked) {
    emailService.sendAccountLocked({ email: user.email, name: user.name, lockMinutes }).catch(() => {});
    emailService.sendAdminSecurityAlert({
      type: 'locked', user,
      details: `Account locked for ${lockMinutes} minutes after ${attempts} consecutive failed attempts (IP ${ip}).`
    }).catch(() => {});
  } else if (attempts >= config.FAILED_ATTEMPT_EMAIL_THRESHOLD && attempts % config.FAILED_ATTEMPT_EMAIL_THRESHOLD === 0) {
    emailService.sendFailedLoginAlert({
      email: user.email, name: user.name, attempts,
      details: { ip, deviceName: buildDeviceInfo(req).name, time: new Date().toLocaleString() }
    }).catch(() => {});
    emailService.sendAdminSecurityAlert({
      type: 'failed', user,
      details: `${attempts} consecutive failed login attempts from IP ${ip}.`
    }).catch(() => {});
  }
  return { locked, lockMinutes };
}

/* ------------------------------------------------------------------
   ADMIN APPROVAL WORKFLOW (#3, #4, #5, #6)
   Every admin login/registration request becomes a PENDING approval that
   is emailed to the owner with Allow/Deny links. Access is only granted
   after the owner clicks Allow.
------------------------------------------------------------------ */
async function buildRequestContext(req) {
  const ip = getClientIp(req);
  const device = buildDeviceInfo(req);
  const location = await security.getIpLocation(ip);
  return {
    ip,
    country: location.country,
    city: location.city,
    browser: device.browser,
    os: device.os,
    deviceType: device.deviceType,
    deviceName: device.name,
    userAgent: device.userAgent,
    fingerprint: device.fingerprint, // sha256(UA + accept-language) — used to mark device trusted on Allow
    time: new Date().toLocaleString()
  };
}

// Create a pending approval + email the owner with Allow/Deny links.
async function createAdminApprovalRequest(kind, user, req) {
  const ctx = await buildRequestContext(req);

  const approval = await AdminApproval.create({
    kind, // 'login' | 'register'
    userId: user._id,
    email: user.email,
    name: user.name,
    ip: ctx.ip,
    country: ctx.country,
    city: ctx.city,
    browser: ctx.browser,
    os: ctx.os,
    deviceType: ctx.deviceType,
    deviceName: ctx.deviceName,
    userAgent: ctx.userAgent,
    deviceFingerprint: ctx.fingerprint
  });

  const allowToken = security.signSecurityToken({ sub: approval._id, action: 'allow', kind }, '48h');
  const denyToken = security.signSecurityToken({ sub: approval._id, action: 'deny', kind }, '48h');

  const allowUrl = `${config.API_URL}/api/auth/approval/allow?token=${allowToken}`;
  const denyUrl = `${config.API_URL}/api/auth/approval/deny?token=${denyToken}`;

  // Bootstrap fallback: if SMTP is not configured, sendEmail silently fails —
  // log the links ONLY then, so the owner can still approve from server logs
  // without logging sensitive links on every successful send.
  const emailResult = await emailService.sendAdminApprovalEmail({
    kind,
    user: { name: user.name, email: user.email },
    details: ctx,
    allowUrl,
    denyUrl
  });
  if (emailResult && emailResult.success === false) {
    console.warn(`⚠️ Approval email could not be sent to the owner (SMTP). Manual fallback links for ${kind} request by ${user.email}:\n  Allow: ${allowUrl}\n  Deny:  ${denyUrl}`);
  }

  // ---- Admin login request notification (#9) ----
  // Push a notification to the admin dashboard's bell + a real-time event.
  try {
    const Notification = require('../models/Notification');
    const { emit } = require('../services/realtime');
    await Notification.create({
      type: 'admin_login_request',
      title: `${kind === 'register' ? '👤 New Admin Registration' : '🛡️ Admin Login Request'} — ${user.email}`,
      message: `${ctx.deviceName || 'Unknown device'} · ${[ctx.city, ctx.country].filter(Boolean).join(', ') || 'Unknown location'}`,
      refType: 'approval',
      refId: String(approval._id)
    });
    emit('admin_login_request', { email: user.email, kind });
    emit('notification', { type: 'admin_login_request' });
  } catch (e) {
    console.warn('⚠️ Approval notification create failed:', e.message);
  }
  return approval;
}

// Shared resolver for Allow/Deny links opened from the owner's email.
async function resolveApprovalAction(req, res, action) {
  const { token } = req.query;
  const payload = token ? security.verifySecurityToken(token) : null;
  if (!payload || !payload.sub || payload.action !== action) {
    return htmlResponse(res, 400, 'Invalid Link', 'This approval link is invalid or has expired.');
  }
  const approval = await AdminApproval.findById(payload.sub);
  if (!approval || approval.status !== 'pending') {
    return htmlResponse(res, 400, 'Already Decided', 'This request has already been processed.');
  }
  if (approval.expiresAt && approval.expiresAt < new Date()) {
    approval.status = 'expired';
    await approval.save();
    return htmlResponse(res, 400, 'Link Expired', 'This approval link has expired.');
  }

  if (action === 'allow') {
    approval.status = 'approved';
    if (approval.userId) {
      await User.updateOne({ _id: approval.userId }, { $set: { adminApproved: true, adminBlocked: false } });
      // #4 — mark the requesting device as trusted/known so future logins from
      // it only need password + 2FA (no approval email), unless revoked.
      if (approval.deviceFingerprint) {
        const target = await User.findById(approval.userId).select('knownDevices');
        if (target) {
          const known = target.knownDevices || [];
          const existing = known.find(d => d.fingerprint === approval.deviceFingerprint);
          if (existing) {
            existing.trusted = true;
            existing.verified = true;
            existing.lastSeen = new Date();
          } else {
            known.push({
              fingerprint: approval.deviceFingerprint,
              name: approval.deviceName || 'Approved device',
              browser: approval.browser || 'Unknown',
              os: approval.os || 'Unknown',
              deviceType: approval.deviceType || 'desktop',
              ip: approval.ip,
              country: approval.country,
              city: approval.city,
              firstSeen: approval.createdAt || new Date(),
              lastSeen: new Date(),
              verified: true,
              trusted: true
            });
          }
          target.knownDevices = known;
          await target.save().catch(() => {});
        }
      }
    }
    await approval.save();
    return htmlResponse(
      res, 200,
      approval.kind === 'register' ? 'Registration Approved' : 'Device Approved',
      `${approval.name || approval.email} has been approved. The device is now trusted — ${approval.kind === 'register' ? 'they can log in from this device' : 'this device can log in'} with password and 2FA only.`
    );
  }

  // deny
  approval.status = 'denied';
  if (approval.userId) {
    if (approval.kind === 'register') {
      await User.updateOne({ _id: approval.userId }, { $set: { adminApproved: false, adminBlocked: true } });
    }
    // #5 — revoke this device's trust so it can never silently log in again.
    if (approval.deviceFingerprint) {
      await User.updateOne(
        { _id: approval.userId, 'knownDevices.fingerprint': approval.deviceFingerprint },
        { $set: { 'knownDevices.$.trusted': false, 'knownDevices.$.verified': false } }
      ).catch(() => {});
    }
  }
  await approval.save();
  return htmlResponse(
    res, 200,
    approval.kind === 'register' ? 'Registration Denied' : 'Device Denied',
    `The ${approval.kind} request from ${approval.name || approval.email} has been denied and their access blocked.`
  );
}

// GET /api/auth/approval/allow?token=...
exports.approveAdminRequest = async (req, res) => {
  try {
    return await resolveApprovalAction(req, res, 'allow');
  } catch (err) {
    return htmlResponse(res, 400, 'Invalid Link', 'This approval link is invalid or has expired.');
  }
};

// GET /api/auth/approval/deny?token=...
exports.denyAdminRequest = async (req, res) => {
  try {
    return await resolveApprovalAction(req, res, 'deny');
  } catch (err) {
    return htmlResponse(res, 400, 'Invalid Link', 'This approval link is invalid or has expired.');
  }
};

// GET /api/auth/approvals — admin-only list of pending requests
// (optional convenience for the owner in the admin panel)
exports.getAdminApprovals = async (req, res) => {
  try {
    const approvals = await AdminApproval.find({ status: 'pending' })
      .sort({ createdAt: -1 })
      .limit(50);
    res.json(approvals.map(a => ({
      id: a._id,
      kind: a.kind,
      email: a.email,
      name: a.name,
      ip: a.ip,
      country: a.country,
      city: a.city,
      browser: a.browser,
      os: a.os,
      deviceName: a.deviceName,
      deviceFingerprint: a.deviceFingerprint,
      createdAt: a.createdAt,
      expiresAt: a.expiresAt
    })));
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// Mark a device as trusted/known for an admin account (requirement #4).
// - Consumes the matching approved login approval (scoped to this device).
// - Marks the fingerprint as trusted in the user's knownDevices so future
//   logins from this device only need password + 2FA (no approval email).
async function markDeviceTrusted(user, req) {
  const fp = security.deviceFingerprint(req);
  try {
    await AdminApproval.updateMany(
      { userId: user._id, kind: 'login', status: 'approved', consumedAt: null, deviceFingerprint: fp, expiresAt: { $gt: new Date() } },
      { $set: { consumedAt: new Date() } }
    );
  } catch (e) { /* non-fatal */ }

  const device = buildDeviceInfo(req);
  const known = user.knownDevices || [];
  const existing = known.find(d => d.fingerprint === fp);
  if (existing) {
    existing.trusted = true;
    existing.verified = true;
    existing.lastSeen = new Date();
    existing.ip = getClientIp(req);
  } else {
    known.push({
      fingerprint: fp,
      name: device.name,
      browser: device.browser,
      os: device.os,
      deviceType: device.deviceType,
      ip: getClientIp(req),
      firstSeen: new Date(),
      lastSeen: new Date(),
      verified: true,
      trusted: true
    });
  }
  user.knownDevices = known;
  await user.save();
}

// Send an email verification link (with cooldown protection).
async function sendVerificationEmail(user) {
  const now = Date.now();
  // Cooldown: don't re-send more than once per RESEND_VERIFY_COOLDOWN_MS
  if (user.emailVerificationExpires) {
    const sentAt = new Date(user.emailVerificationExpires).getTime() - config.EMAIL_VERIFY_EXPIRES_MS;
    if (sentAt > 0 && now - sentAt < config.RESEND_VERIFY_COOLDOWN_MS) return false;
  }
  const token = crypto.randomBytes(32).toString('hex');
  user.emailVerificationTokenHash = security.sha256(token);
  user.emailVerificationExpires = new Date(now + config.EMAIL_VERIFY_EXPIRES_MS);
  await user.save();
  const verificationUrl = `${config.API_URL}/api/auth/verify-email?token=${token}`;
  await emailService.sendEmailVerification({ email: user.email, name: user.name, verificationUrl });
  return true;
}

/* ------------------------------------------------------------------
   REGISTER (#10, #11, #17)
------------------------------------------------------------------ */
exports.register = async (req, res) => {
  const start = Date.now();
  try {
    const { name, email, password, newsletter } = req.body;

    if (!name || !email || !password) {
      return res.status(400).json({ message: 'Please fill in all fields.' });
    }

    const strength = security.validatePasswordStrength(password);
    if (!strength.valid) {
      return res.status(400).json({ message: 'Password too weak. ' + strength.errors.join(' ') });
    }

    const normalizedEmail = String(email).toLowerCase().trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)) {
      return res.status(400).json({ message: 'Please provide a valid email address.' });
    }

    // #11 — prevent duplicate registration
    const existing = await User.findOne({ email: normalizedEmail });
    if (existing) {
      logAttempt({ email: normalizedEmail, success: false, reason: 'duplicate_registration', req, durationMs: Date.now() - start });
      return res.status(400).json({ message: 'An account with this email already exists.' });
    }

    // #12/#13 — bcrypt hash, never plaintext
    const hashedPassword = await bcrypt.hash(password, 10);

    const user = await User.create({
      name: String(name).slice(0, 100),
      email: normalizedEmail,
      password: hashedPassword,
      newsletter: !!newsletter,
      emailVerified: false // #10 — must verify before logging in
    });

    // Send verification email (#10) + welcome + admin alert
    sendVerificationEmail(user).catch(() => {});
    emailService.sendWelcomeEmail({ email: user.email, name: user.name }).catch(() => {});
    emailService.sendAdminSecurityAlert({ type: 'register', user }).catch(() => {});

    res.status(201).json({
      message: 'Account created! Please verify your email address to log in.',
      requiresEmailVerification: true,
      user: safeUser(user)
    });
  } catch (err) {
    if (err.code === 11000) {
      return res.status(400).json({ message: 'An account with this email already exists.' });
    }
    res.status(500).json({ message: err.message });
  }
};

/* ------------------------------------------------------------------
   LOGIN (#1, #2, #3, #5, #6, #8, #9, #10, #18)
------------------------------------------------------------------ */
exports.login = async (req, res) => {
  const start = Date.now();
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ message: 'Please fill in all fields.' });
    }

    const normalizedEmail = String(email).toLowerCase().trim();
    const user = await User.findOne({ email: normalizedEmail });

    if (!user) {
      // Equalize timing to prevent user enumeration
      await bcrypt.compare(password, DUMMY_PASSWORD_HASH);
      logAttempt({ email: normalizedEmail, success: false, reason: 'user_not_found', req, durationMs: Date.now() - start });
      return res.status(400).json({ message: 'Invalid email or password.' });
    }

    // #6 — account temporarily locked?
    if (user.lockUntil && user.lockUntil > new Date()) {
      const retryAfter = Math.ceil((new Date(user.lockUntil).getTime() - Date.now()) / 1000);
      logAttempt({ userId: user._id, email: user.email, success: false, reason: 'locked', req, durationMs: Date.now() - start });
      return res.status(423).json({
        message: 'Too many failed attempts. Your account is temporarily locked.',
        retryAfterSeconds: retryAfter
      });
    }

    // #10 — email verification required
    if (!user.emailVerified) {
      sendVerificationEmail(user).catch(() => {});
      logAttempt({ userId: user._id, email: user.email, success: false, reason: 'email_unverified', req, durationMs: Date.now() - start });
      return res.status(403).json({
        message: 'Please verify your email address before logging in. A new verification link has been sent.',
        requiresEmailVerification: true,
        email: user.email
      });
    }

    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) {
      const { locked, lockMinutes } = await handleFailedLogin(user, req);
      logAttempt({ userId: user._id, email: user.email, success: false, reason: locked ? 'locked' : 'invalid_credentials', req, durationMs: Date.now() - start });
      if (locked) {
        return res.status(423).json({ message: `Too many failed attempts. Account locked for ${lockMinutes} minutes.` });
      }
      return res.status(400).json({ message: 'Invalid email or password.' });
    }

    // === ADMIN PANEL APPROVAL WORKFLOW (#3, #4, #5) ===
    // Emails on the owner's bypass list skip approval entirely — they are
    // treated as approved with every device trusted (see config/security.js).
    const adminApprovalBypassed = user.role === 'admin' && config.isAdminApprovalBypassed(user.email);
    if (user.role === 'admin' && !adminApprovalBypassed) {
      // Owner has denied this admin → hard block
      if (user.adminBlocked) {
        logAttempt({ userId: user._id, email: user.email, success: false, reason: 'admin_denied', req, durationMs: Date.now() - start });
        return res.status(403).json({ message: 'Your admin access was denied by the owner.', pending: false });
      }
      // Registration not yet approved → stay pending
      if (!user.adminApproved) {
        logAttempt({ userId: user._id, email: user.email, success: false, reason: 'admin_pending_registration', req, durationMs: Date.now() - start });
        return res.status(202).json({
          pending: true,
          message: 'Your admin account is awaiting owner approval. You will be able to log in once the owner approves your registration.'
        });
      }

      // ---------- TRUSTED-DEVICE WORKFLOW ----------
      // #1 Known/trusted device → allow access immediately (password + 2FA only).
      // #2 New/unrecognized device → pending approval request + owner email.
      const fp = security.deviceFingerprint(req);
      const knownDevices = user.knownDevices || [];
      const deviceRecord = knownDevices.find(d => d.fingerprint === fp);
      const isTrustedDevice = !!(deviceRecord && deviceRecord.trusted);

      if (isTrustedDevice) {
        // Trusted device: no approval email needed — straight through.
        logAttempt({ userId: user._id, email: user.email, success: true, reason: 'admin_trusted_device', req, durationMs: Date.now() - start });
      } else {
        // New/unrecognized device — requires owner approval (#2, #5).
        // Is there an already-approved (unconsumed) login request for THIS device?
        const approvedLogin = await AdminApproval.findOne({
          userId: user._id, kind: 'login', status: 'approved', consumedAt: null, deviceFingerprint: fp,
          expiresAt: { $gt: new Date() }
        });
        if (approvedLogin) {
          // Approved for this device → proceed; markDeviceTrusted runs after full auth (incl. 2FA).
          logAttempt({ userId: user._id, email: user.email, success: true, reason: 'admin_approved_login', req, durationMs: Date.now() - start });
        } else {
          // Avoid spamming the owner: if a login approval for this device is already pending, don't create another.
          const existingPending = await AdminApproval.findOne({
            userId: user._id, kind: 'login', status: 'pending', deviceFingerprint: fp, expiresAt: { $gt: new Date() }
          });
          if (existingPending) {
            logAttempt({ userId: user._id, email: user.email, success: false, reason: 'admin_pending_login', req, durationMs: Date.now() - start });
            return res.status(202).json({
              pending: true,
              message: 'A login approval request for this device is already pending. Please wait for the owner to approve it.'
            });
          }
          await createAdminApprovalRequest('login', user, req);
          logAttempt({ userId: user._id, email: user.email, success: false, reason: 'admin_pending_login', req, durationMs: Date.now() - start });
          return res.status(202).json({
            pending: true,
            message: 'This device is not recognized. A login approval request was sent to the owner. You will be able to log in once it is approved.'
          });
        }
      }
    }

    // SUCCESS — reset lockout counters
    user.failedLoginAttempts = 0;
    user.lockUntil = null;
    user.lastLoginAt = new Date();
    user.lastLoginIp = getClientIp(req);
    await user.save();

    // #18 — 2FA step 1: issue short-lived temp token
    if (user.twoFactorEnabled) {
      logAttempt({ userId: user._id, email: user.email, success: true, reason: '2fa_required', req, durationMs: Date.now() - start });
      const tempToken = jwt.sign(
        { sub: user._id, purpose: '2fa', role: user.role },
        config.JWT_SECRET,
        { expiresIn: config.TWO_FACTOR_TEMP_EXPIRES }
      );
      return res.json({
        twoFactorRequired: true,
        tempToken,
        user: safeUser(user)
      });
    }

    // Full login: session + tokens + device context + notification
    const ctx = await evaluateDeviceContext(user, req);
    user.lastLoginCountry = ctx.location.country || user.lastLoginCountry;
    await user.save();

    const { accessToken, refreshToken } = await createSessionAndTokens(user, req);

    // #4 — mark this device trusted (only for new/approved device logins).
    if (user.role === 'admin') await markDeviceTrusted(user, req);

    logAttempt({ userId: user._id, email: user.email, success: true, reason: adminApprovalBypassed ? 'admin_bypass_login' : 'success', req, durationMs: Date.now() - start });

    // #1/#2/#3 — login notification ("Was this you?" buttons are rendered inside
    // notifyLogin whenever ctx.isNewDevice or ctx.isNewCountry is true).
    notifyLogin(user, req, ctx).catch(() => {});

    res.json({
      token: accessToken,
      refreshToken,
      user: safeUser(user),
      newDevice: !!ctx.isNewDevice,
      newCountry: !!ctx.isNewCountry
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

/* ------------------------------------------------------------------
   2FA step 2 — verify TOTP/backup code and complete login (#18)
------------------------------------------------------------------ */
exports.verify2FA = async (req, res) => {
  const start = Date.now();
  try {
    const { tempToken, code } = req.body;
    if (!tempToken || !code) {
      return res.status(400).json({ message: 'Missing 2FA token or code.' });
    }

    let payload;
    try {
      payload = jwt.verify(tempToken, config.JWT_SECRET);
    } catch (e) {
      return res.status(401).json({ message: 'Login session expired. Please log in again.' });
    }
    if (payload.purpose !== '2fa') {
      return res.status(401).json({ message: 'Invalid login session.' });
    }

    const user = await User.findById(payload.sub);
    if (!user || !user.twoFactorEnabled) {
      return res.status(401).json({ message: 'Invalid login session.' });
    }

    // Check TOTP or a backup code
    const totpOk = await security.verifyTotp({ token: String(code).trim(), secret: user.twoFactorSecret });
    let backupOk = false;
    if (!totpOk && Array.isArray(user.twoFactorBackupCodes) && user.twoFactorBackupCodes.length) {
      const hash = security.sha256(String(code).trim().toUpperCase());
      const idx = user.twoFactorBackupCodes.indexOf(hash);
      if (idx !== -1) {
        user.twoFactorBackupCodes.splice(idx, 1); // backup codes are single-use
        backupOk = true;
      }
    }

    if (!totpOk && !backupOk) {
      logAttempt({ userId: user._id, email: user.email, success: false, reason: '2fa_failed', req, durationMs: Date.now() - start });
      return res.status(401).json({ message: 'Invalid 2FA code.' });
    }

    await user.save();

    // Complete login (same path as non-2FA)
    const ctx = await evaluateDeviceContext(user, req);
    user.lastLoginAt = new Date();
    user.lastLoginIp = getClientIp(req);
    user.lastLoginCountry = ctx.location.country || user.lastLoginCountry;
    user.failedLoginAttempts = 0;
    user.lockUntil = null;
    await user.save();

    const { accessToken, refreshToken } = await createSessionAndTokens(user, req);

    // #4 — 2FA succeeded: mark this device trusted.
    if (user.role === 'admin') await markDeviceTrusted(user, req);

    logAttempt({ userId: user._id, email: user.email, success: true, reason: 'success_2fa', req, durationMs: Date.now() - start });

    notifyLogin(user, req, ctx).catch(() => {});

    res.json({ token: accessToken, refreshToken, user: safeUser(user) });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

/* ------------------------------------------------------------------
   EMAIL VERIFICATION (#10)
------------------------------------------------------------------ */
exports.verifyEmail = async (req, res) => {
  try {
    const { token } = req.query;
    if (!token) {
      return htmlResponse(res, 400, 'Invalid Link', 'Verification token is required.');
    }

    const hash = security.sha256(token);
    const user = await User.findOne({ emailVerificationTokenHash: hash });
    if (!user) {
      return htmlResponse(res, 400, 'Invalid Link', 'This verification link is invalid or has expired.');
    }
    if (user.emailVerificationExpires && user.emailVerificationExpires < new Date()) {
      return htmlResponse(res, 400, 'Link Expired', 'This verification link has expired. Please request a new one.');
    }

    user.emailVerified = true;
    user.emailVerificationTokenHash = null;
    user.emailVerificationExpires = null;
    user.emailVerifiedAt = new Date();
    await user.save();

    return htmlResponse(res, 200, 'Email Verified', 'Your email address has been verified successfully. You can now log in to your account.');
  } catch (err) {
    return htmlResponse(res, 400, 'Verification Failed', 'Something went wrong. Please try again.');
  }
};

exports.resendVerification = async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ message: 'Email is required.' });

    const user = await User.findOne({ email: String(email).toLowerCase().trim() });
    if (!user) {
      // Don't reveal whether the account exists
      return res.json({ message: 'If an account exists, a verification link has been sent.' });
    }
    if (user.emailVerified) {
      return res.json({ message: 'This email is already verified. You can log in.' });
    }
    const sent = await sendVerificationEmail(user);
    if (!sent) {
      return res.status(429).json({ message: 'Please wait a moment before requesting another link.' });
    }
    res.json({ message: 'Verification link sent! Check your inbox.' });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

/* ------------------------------------------------------------------
   REFRESH TOKEN ROTATION (#14, #15)
------------------------------------------------------------------ */
exports.refresh = async (req, res) => {
  try {
    const { refreshToken } = req.body;
    if (!refreshToken) {
      return res.status(401).json({ message: 'Refresh token required.' });
    }

    const hash = security.hashRefreshToken(refreshToken);
    const session = await Session.findOne({ refreshTokenHash: hash });

    // Reject unknown, revoked, or expired sessions (#4, #15)
    if (!session || session.revokedAt) {
      return res.status(401).json({ message: 'Invalid session. Please log in again.' });
    }
    if (session.expiresAt && session.expiresAt < new Date()) {
      await Session.findByIdAndUpdate(session._id, { revokedAt: new Date(), revokedReason: 'expired' });
      return res.status(401).json({ message: 'Session expired. Please log in again.' });
    }

    const user = await User.findById(session.userId);
    if (!user) {
      return res.status(401).json({ message: 'Account not found. Please log in again.' });
    }
    if (user.lockUntil && user.lockUntil > new Date()) {
      return res.status(423).json({ message: 'Account temporarily locked.' });
    }
    if (user.mustChangePassword) {
      return res.status(403).json({ message: 'Password reset required. Please set a new password.', code: 'PASSWORD_RESET_REQUIRED' });
    }

    // Rotate: revoke old session, mint a fresh one (#14)
    session.revokedAt = new Date();
    session.revokedReason = 'rotated';
    await session.save();

    const { accessToken, refreshToken: newRefreshToken } = await createSessionAndTokens(user, req);
    res.json({ token: accessToken, refreshToken: newRefreshToken, user: safeUser(user) });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

/* ------------------------------------------------------------------
   LOGOUT (#4 — terminate sessions)
------------------------------------------------------------------ */
exports.logout = async (req, res) => {
  try {
    if (req.session && req.session._id) {
      req.session.revokedAt = new Date();
      req.session.revokedReason = 'logout';
      await req.session.save();
    }
    res.json({ message: 'Logged out successfully.' });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

exports.logoutAll = async (req, res) => {
  try {
    await Session.updateMany(
      { userId: req.user.id, revokedAt: null },
      { $set: { revokedAt: new Date(), revokedReason: 'logout_all' } }
    );
    res.json({ message: 'Signed out from all devices.' });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

/* ------------------------------------------------------------------
   SESSIONS (list / revoke) (#15)
------------------------------------------------------------------ */
exports.getSessions = async (req, res) => {
  try {
    const sessions = await Session.find({ userId: req.user.id, revokedAt: null })
      .sort({ lastActiveAt: -1 })
      .limit(20)
      .select('ip country city device lastActiveAt expiresAt createdAt');
    res.json(sessions);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

exports.revokeSession = async (req, res) => {
  try {
    await Session.updateOne(
      { _id: req.params.id, userId: req.user.id },
      { $set: { revokedAt: new Date(), revokedReason: 'user_revoked' } }
    );
    res.json({ message: 'Session terminated.' });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

/* ------------------------------------------------------------------
   GET ME
------------------------------------------------------------------ */
exports.getMe = async (req, res) => {
  try {
    const user = await User.findById(req.user.id).select('-password -twoFactorSecret -twoFactorBackupCodes -emailVerificationTokenHash');
    if (!user) return res.status(404).json({ message: 'User not found' });
    res.json(safeUser(user));
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

/* ------------------------------------------------------------------
   CHANGE PASSWORD (#1, #4, #17)
------------------------------------------------------------------ */
exports.changePassword = async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;
    if (!currentPassword || !newPassword) {
      return res.status(400).json({ message: 'Please enter current and new password.' });
    }

    const strength = security.validatePasswordStrength(newPassword);
    if (!strength.valid) {
      return res.status(400).json({ message: 'Password too weak. ' + strength.errors.join(' ') });
    }
    if (currentPassword === newPassword) {
      return res.status(400).json({ message: 'New password must be different from the current password.' });
    }

    const user = await User.findById(req.user.id);
    if (!user) return res.status(404).json({ message: 'User not found.' });

    const isMatch = await bcrypt.compare(currentPassword, user.password);
    if (!isMatch) return res.status(400).json({ message: 'Current password is incorrect.' });

    user.password = await bcrypt.hash(newPassword, 10);
    user.passwordChangedAt = new Date(); // invalidates all JWTs issued before now (#15)
    user.mustChangePassword = false;
    await user.save();

    // Terminate all OTHER sessions (keep the current one) (#4)
    const revokeFilter = { userId: user._id, revokedAt: null };
    if (req.session && req.session._id) revokeFilter._id = { $ne: req.session._id };
    await Session.updateMany(revokeFilter, { $set: { revokedAt: new Date(), revokedReason: 'password_changed' } });

    emailService.sendPasswordChanged({ email: user.email, name: user.name }).catch(() => {});
    emailService.sendAdminSecurityAlert({ type: 'password', user }).catch(() => {});

    res.json({ message: 'Password changed successfully. All other sessions were terminated.' });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

/* ------------------------------------------------------------------
   CHANGE EMAIL (#1)
------------------------------------------------------------------ */
exports.changeEmail = async (req, res) => {
  try {
    const { password, newEmail } = req.body;
    if (!password || !newEmail) {
      return res.status(400).json({ message: 'Please enter your password and new email.' });
    }
    const normalizedEmail = String(newEmail).toLowerCase().trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)) {
      return res.status(400).json({ message: 'Please provide a valid email address.' });
    }

    const user = await User.findById(req.user.id);
    if (!user) return res.status(404).json({ message: 'User not found.' });

    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) return res.status(400).json({ message: 'Password is incorrect.' });

    if (normalizedEmail === user.email) {
      return res.status(400).json({ message: 'New email is the same as the current email.' });
    }
    const clash = await User.findOne({ email: normalizedEmail, _id: { $ne: user._id } });
    if (clash) return res.status(400).json({ message: 'That email is already in use.' });

    const oldEmail = user.email;
    user.email = normalizedEmail;
    user.emailVerified = false; // must re-verify the new address (#10)
    await user.save();

    // Terminate all sessions — email change is a sensitive event (#4)
    await Session.updateMany(
      { userId: user._id, revokedAt: null },
      { $set: { revokedAt: new Date(), revokedReason: 'email_changed' } }
    );

    sendVerificationEmail(user).catch(() => {});
    emailService.sendEmailChanged({ email: oldEmail, name: user.name, newEmail: normalizedEmail }).catch(() => {});
    emailService.sendAdminSecurityAlert({ type: 'email', user, details: `${oldEmail} → ${normalizedEmail}` }).catch(() => {});

    res.json({ message: 'Email updated. Please verify your new email address and log in again.', email: normalizedEmail });
  } catch (err) {
    if (err.code === 11000) {
      return res.status(400).json({ message: 'That email is already in use.' });
    }
    res.status(500).json({ message: err.message });
  }
};

/* ------------------------------------------------------------------
   2FA (#18)
------------------------------------------------------------------ */
// Step 1: generate secret + otpauth URL (client renders QR)
exports.setup2FA = async (req, res) => {
  try {
    const user = await User.findById(req.user.id);
    if (!user) return res.status(404).json({ message: 'User not found.' });
    if (user.twoFactorEnabled) {
      return res.status(400).json({ message: 'Two-factor authentication is already enabled.' });
    }
    const secret = security.generateTotpSecret();
    const otpauthUrl = security.generateTotpUri({ secret, email: user.email });
    res.json({ secret, otpauthUrl });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// Step 2: verify a code against the secret, then enable
exports.enable2FA = async (req, res) => {
  try {
    const { secret, code } = req.body;
    if (!secret || !code) {
      return res.status(400).json({ message: 'Secret and verification code are required.' });
    }
    const ok = await security.verifyTotp({ token: String(code).trim(), secret });
    if (!ok) {
      return res.status(400).json({ message: 'Invalid verification code. Please try again.' });
    }

    const user = await User.findById(req.user.id);
    if (!user) return res.status(404).json({ message: 'User not found.' });

    user.twoFactorSecret = secret;
    user.twoFactorEnabled = true;
    // Generate single-use backup codes (stored hashed)
    const backupCodes = security.generateBackupCodes(config.BACKUP_CODES_COUNT);
    user.twoFactorBackupCodes = backupCodes.map(c => security.sha256(c.toUpperCase()));
    await user.save();

    emailService.send2FAStatus({ email: user.email, name: user.name, enabled: true }).catch(() => {});
    emailService.sendAdminSecurityAlert({ type: 'twofa', user, details: 'Two-factor authentication enabled.' }).catch(() => {});

    res.json({ message: 'Two-factor authentication enabled.', backupCodes });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// Disable 2FA (requires password + current code)
exports.disable2FA = async (req, res) => {
  try {
    const { password, code } = req.body;
    const user = await User.findById(req.user.id);
    if (!user) return res.status(404).json({ message: 'User not found.' });
    if (!user.twoFactorEnabled) {
      return res.status(400).json({ message: 'Two-factor authentication is not enabled.' });
    }
    if (!password || !code) {
      return res.status(400).json({ message: 'Password and 2FA code are required.' });
    }
    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) return res.status(400).json({ message: 'Password is incorrect.' });

    const ok = await security.verifyTotp({ token: String(code).trim(), secret: user.twoFactorSecret });
    if (!ok) return res.status(400).json({ message: 'Invalid 2FA code.' });

    user.twoFactorEnabled = false;
    user.twoFactorSecret = null;
    user.twoFactorBackupCodes = [];
    await user.save();

    emailService.send2FAStatus({ email: user.email, name: user.name, enabled: false }).catch(() => {});
    emailService.sendAdminSecurityAlert({ type: 'twofa', user, details: 'Two-factor authentication disabled.' }).catch(() => {});

    res.json({ message: 'Two-factor authentication disabled.' });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

/* ------------------------------------------------------------------
   "WAS THIS YOU?" — device confirm / deny (#3, #4)
   These are unauthenticated GET endpoints opened from the email.
------------------------------------------------------------------ */
function htmlResponse(res, status, title, body) {
  return res.status(status).send(`
    <!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
    <title>${title} — BIN SALEH Store</title>
    <style>
      body{font-family:'DM Sans',Arial,sans-serif;background:#f7f5f0;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}
      .card{background:#fff;border-radius:16px;padding:40px;max-width:460px;text-align:center;box-shadow:0 10px 30px rgba(0,0,0,.08)}
      h1{font-family:'Bebas Neue';letter-spacing:3px;color:#b8860b;margin:0 0 16px}
      h2{color:#111;margin:0 0 12px}.p{color:#555;line-height:1.6;margin:0 0 20px}
      a.btn{display:inline-block;background:#b8860b;color:#fff;padding:12px 28px;border-radius:8px;text-decoration:none;font-weight:600}
      .ok{color:#2e7d32;font-size:48px}.warn{color:#c62828;font-size:48px}
    </style></head><body>
    <div class="card"><div class="${status === 200 ? 'ok' : 'warn'}">${status === 200 ? '✓' : '!'}</div>
    <h1>BIN SALEH STORE</h1><h2>${title}</h2><p class="p">${body}</p>
    <a class="btn" href="${config.CLIENT_URL}/profile.html">Go to my account</a></div></body></html>
  `);
}

exports.confirmDevice = async (req, res) => {
  try {
    const { token } = req.query;
    const payload = security.verifySecurityToken(token);
    if (!payload || payload.purpose !== 'device-confirm' || !payload.sub) {
      return htmlResponse(res, 400, 'Invalid Link', 'This security link is invalid or has expired.');
    }
    const user = await User.findById(payload.sub);
    if (!user) {
      return htmlResponse(res, 400, 'Invalid Link', 'This security link is invalid or has expired.');
    }
    const device = (user.knownDevices || []).find(d => d.fingerprint === payload.device);
    if (device) {
      device.verified = true;
      device.lastSeen = new Date();
    } else {
      user.knownDevices.push({ fingerprint: payload.device, verified: true, firstSeen: new Date(), lastSeen: new Date() });
    }
    await user.save();
    return htmlResponse(res, 200, 'Device Confirmed', 'Thanks for confirming. This device is now trusted for future sign-ins.');
  } catch (err) {
    return htmlResponse(res, 400, 'Invalid Link', 'This security link is invalid or has expired.');
  }
};

exports.denyDevice = async (req, res) => {
  try {
    const { token } = req.query;
    const payload = security.verifySecurityToken(token);
    if (!payload || payload.purpose !== 'device-deny' || !payload.sub) {
      return htmlResponse(res, 400, 'Invalid Link', 'This security link is invalid or has expired.');
    }
    const user = await User.findById(payload.sub);
    if (!user) {
      return htmlResponse(res, 400, 'Invalid Link', 'This security link is invalid or has expired.');
    }

    // #4 — terminate ALL active sessions + invalidate refresh tokens
    await Session.updateMany(
      { userId: user._id, revokedAt: null },
      { $set: { revokedAt: new Date(), revokedReason: 'account_secured' } }
    );

    // #4 — force password reset
    user.mustChangePassword = true;
    await user.save();

    emailService.sendAccountSecured({ email: user.email, name: user.name }).catch(() => {});
    emailService.sendAdminSecurityAlert({
      type: 'secured', user,
      details: 'User clicked "No, secure my account" on a new-device sign-in alert. All sessions terminated and password reset forced.'
    }).catch(() => {});

    return htmlResponse(
      res, 200, 'Account Secured',
      'All sessions were signed out, refresh tokens were invalidated, and a password reset is now required for your security. We have notified our team.'
    );
  } catch (err) {
    return htmlResponse(res, 400, 'Invalid Link', 'This security link is invalid or has expired.');
  }
};

// GET /api/auth/admin-devices — list trusted devices for the current admin
// (owner convenience: see which devices can log in without approval).
exports.getAdminDevices = async (req, res) => {
  try {
    const user = await User.findById(req.user.id).select('knownDevices');
    if (!user) return res.status(404).json({ message: 'User not found' });
    const devices = (user.knownDevices || [])
      .filter(d => d.trusted)
      .map(d => ({
        fingerprint: d.fingerprint,
        name: d.name,
        browser: d.browser,
        os: d.os,
        deviceType: d.deviceType,
        ip: d.ip,
        country: d.country,
        city: d.city,
        firstSeen: d.firstSeen,
        lastSeen: d.lastSeen
      }));
    res.json(devices);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// POST /api/auth/admin-devices/revoke — revoke a trusted device (#5)
// After revocation the device is treated as new → requires owner approval again.
exports.revokeAdminDevice = async (req, res) => {
  try {
    const { fingerprint } = req.body;
    if (!fingerprint) {
      return res.status(400).json({ message: 'Device fingerprint is required.' });
    }
    const result = await User.updateOne(
      { _id: req.user.id, 'knownDevices.fingerprint': fingerprint },
      { $set: { 'knownDevices.$.trusted': false, 'knownDevices.$.verified': false } }
    );
    if (!result.matchedCount) {
      return res.status(404).json({ message: 'Device not found.' });
    }
    // Also expire any pending/approved login approvals tied to this device so
    // the device cannot sneak through on a pre-granted approval.
    await AdminApproval.updateMany(
      { userId: req.user.id, deviceFingerprint: fingerprint, consumedAt: null },
      { $set: { status: 'expired', decidedAt: new Date() } }
    ).catch(() => {});
    // Terminate any active sessions from this device so revocation is immediate.
    await Session.updateMany(
      { userId: req.user.id, revokedAt: null, 'device.fingerprint': fingerprint },
      { $set: { revokedAt: new Date(), revokedReason: 'device_revoked' } }
    ).catch(() => {});
    res.json({ message: 'Device revoked. Future logins from this device will require owner approval again, and its active sessions were terminated.' });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

/* ------------------------------------------------------------------
   NEWSLETTER
------------------------------------------------------------------ */
exports.subscribeNewsletter = async (req, res) => {
  try {
    const { email } = req.body;

    if (!email) {
      return res.status(400).json({ message: 'Email is required.' });
    }

    // Check if user already exists with this email
    const existing = await User.findOne({ email: email.toLowerCase() });
    if (existing) {
      if (existing.newsletter) {
        return res.json({ message: 'Already subscribed! Thank you.' });
      }
      existing.newsletter = true;
      await existing.save();
      return res.json({ message: 'Subscribed successfully!' });
    }

    // Create a minimal user entry for newsletter only
    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(email + config.JWT_SECRET, salt);

    await User.create({
      name: email.split('@')[0],
      email: email.toLowerCase(),
      password: hashedPassword,
      newsletter: true,
      role: 'customer'
    });

    emailService.sendNewsletterConfirmation({ email }).catch(() => {});

    res.status(201).json({ message: 'Subscribed successfully! Welcome to BIN SALEH 🎉' });
  } catch (err) {
    if (err.code === 11000) {
      return res.json({ message: 'Already subscribed! Thank you.' });
    }
    res.status(500).json({ message: err.message });
  }
};

/* ------------------------------------------------------------------
   ADMIN
------------------------------------------------------------------ */
exports.getSubscribers = async (req, res) => {
  try {
    const subscribers = await User.find({ newsletter: true }).select('name email createdAt').sort({ createdAt: -1 });
    res.json(subscribers);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

exports.getUsers = async (req, res) => {
  try {
    const users = await User.find()
      .select('-password -twoFactorSecret -twoFactorBackupCodes -emailVerificationTokenHash')
      .sort({ createdAt: -1 });
    res.json(users);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

exports.registerAdmin = async (req, res) => {
  try {
    const { name, email, password, setupKey } = req.body;

    // Check for overridden setup key in database
    let effectiveKey = ADMIN_SETUP_KEY;
    try {
      const Settings = require('../models/Settings');
      const dbKey = await Settings.findOne({ key: 'admin_setup_key' });
      if (dbKey && dbKey.value && dbKey.value.trim()) {
        effectiveKey = dbKey.value;
      }
    } catch (e) { /* DB not available, use env/default */ }

    if (!setupKey || setupKey !== effectiveKey) {
      return res.status(403).json({ message: 'Invalid admin setup key.' });
    }

    if (!name || !email || !password) {
      return res.status(400).json({ message: 'Please fill in all fields.' });
    }

    const strength = security.validatePasswordStrength(password);
    if (!strength.valid) {
      return res.status(400).json({ message: 'Password too weak. ' + strength.errors.join(' ') });
    }

    const existing = await User.findOne({ email: email.toLowerCase() });
    if (existing) {
      return res.status(400).json({ message: 'An account with this email already exists.' });
    }

    const hashedPassword = await bcrypt.hash(password, 10);

    // Emails on the owner's approval-bypass list are auto-approved and skip the
    // pending-approval request entirely (see config/security.js).
    const bypassApproval = config.isAdminApprovalBypassed(email);

    const user = await User.create({
      name,
      email: email.toLowerCase(),
      password: hashedPassword,
      role: 'admin', // 👈 admin role set
      newsletter: false,
      emailVerified: true, // admins are provisioned via setup key
      adminApproved: bypassApproval, // bypass-listed admins are approved instantly
      adminBlocked: false
    });

    if (bypassApproval) {
      // Trusted admin — no approval needed. Create a session so the admin panel
      // (which expects a token when pending is false) logs straight in.
      const { accessToken, refreshToken } = await createSessionAndTokens(user, req);
      logAttempt({ userId: user._id, email: user.email, success: true, reason: 'admin_bypass_register', req });
      return res.status(201).json({
        pending: false,
        message: 'Admin account created. You can log in immediately.',
        token: accessToken,
        refreshToken,
        user: safeUser(user)
      });
    }

    // #3/#5/#6 — every other admin registration is a PENDING request that the
    // owner must approve via the emailed Allow/Deny links.
    const approval = await createAdminApprovalRequest('register', user, req);

    res.status(201).json({
      pending: true,
      message: 'Admin registration submitted. The owner has been notified and must approve your account before you can log in.',
      approvalId: approval._id
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

/* ------------------------------------------------------------------
   LOGIN HISTORY (admin) — requirement #8 visibility
------------------------------------------------------------------ */
exports.getLoginHistory = async (req, res) => {
  try {
    const history = await LoginHistory.find()
      .sort({ createdAt: -1 })
      .limit(parseInt(req.query.limit, 10) || 100);
    res.json(history);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};
