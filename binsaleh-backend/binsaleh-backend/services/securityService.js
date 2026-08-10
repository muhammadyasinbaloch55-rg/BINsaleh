// services/securityService.js
// Core security primitives used across auth, middleware and email:
//  - User-Agent parsing → browser / OS / device name
//  - Device fingerprinting (stable per browser+language)
//  - IP geolocation (free ipapi.co, graceful fallback)
//  - Password strength validation (#17)
//  - Token helpers (access JWT, refresh token hash)
//  - TOTP helpers (otplib v13 async API)

const crypto = require('crypto');
const axios = require('axios');
const config = require('../config/security');
// otplib v12 (synchronous, CommonJS). v13 depends on ESM-only packages
// (@scure/base) which crash Vercel's serverless CJS bundling with
// ERR_REQUIRE_ESM — v12 keeps 2FA working everywhere.
const { authenticator } = require('otplib');

/* ------------------------------------------------------------------
   HASHING
------------------------------------------------------------------ */
function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

/* ------------------------------------------------------------------
   USER-AGENT PARSING (no external deps — small, targeted regexes)
------------------------------------------------------------------ */
function parseUserAgent(ua = '') {
  const result = { browser: 'Unknown', os: 'Unknown', deviceType: 'desktop', name: 'Unknown device' };
  const u = ua.toLowerCase();

  // Browser
  if (/edg\//.test(u)) result.browser = 'Microsoft Edge';
  else if (/opr\/|opera/.test(u)) result.browser = 'Opera';
  else if (/chrome\//.test(u)) result.browser = 'Chrome';
  else if (/firefox\//.test(u)) result.browser = 'Firefox';
  else if (/safari\//.test(u)) result.browser = 'Safari';
  else if (/msie|trident/.test(u)) result.browser = 'Internet Explorer';

  // OS
  if (/windows nt 10/.test(u)) result.os = 'Windows 11';
  else if (/windows nt 6\.1/.test(u)) result.os = 'Windows 7';
  else if (/windows nt 6\.3/.test(u)) result.os = 'Windows 8.1';
  else if (/windows/.test(u)) result.os = 'Windows';
  else if (/android/.test(u)) result.os = 'Android';
  else if (/iphone|ipad|ipod/.test(u)) result.os = 'iOS';
  else if (/mac os x/.test(u)) result.os = 'macOS';
  else if (/linux/.test(u)) result.os = 'Linux';

  // Device type
  if (/iphone/.test(u)) result.deviceType = 'mobile';
  else if (/ipad/.test(u)) result.deviceType = 'tablet';
  else if (/android/.test(u)) result.deviceType = /mobile/.test(u) ? 'mobile' : 'tablet';
  else if (/mobile|mobi/i.test(u)) result.deviceType = 'mobile';

  // Friendly device name
  if (result.deviceType !== 'desktop') {
    result.name = `${result.os} ${result.browser}`;
  } else {
    result.name = `${result.browser} on ${result.os}`;
  }
  return result;
}

/* ------------------------------------------------------------------
   DEVICE FINGERPRINT
   Stable fingerprint for the "known devices" check. Combines UA +
   accept-language. IP is deliberately NOT included (it changes often
   and would cause false "new device" alerts).
------------------------------------------------------------------ */
function deviceFingerprint(req) {
  const ua = req.headers['user-agent'] || '';
  const lang = req.headers['accept-language'] || '';
  return sha256(ua + '|' + lang);
}

/* ------------------------------------------------------------------
   IP ADDRESS (handles proxies)
------------------------------------------------------------------ */
function getClientIp(req) {
  const xff = req.headers['x-forwarded-for'];
  if (xff) {
    const first = String(xff).split(',')[0].trim();
    if (first && first !== 'unknown') return first;
  }
  const cf = req.headers['cf-connecting-ip'];
  if (cf) return cf;
  return (req.socket && req.socket.remoteAddress) || req.ip || '0.0.0.0';
}

/* ------------------------------------------------------------------
   IP GEOLOCATION (ipapi.co free tier, graceful fallback)
------------------------------------------------------------------ */
const geoCache = new Map(); // ip -> { country, city }
async function getIpLocation(ip) {
  if (!ip || ip === '0.0.0.0' || ip.startsWith('::1') || ip.startsWith('127.')) {
    return { country: '', city: '' };
  }
  if (geoCache.has(ip)) return geoCache.get(ip);

  const result = { country: '', city: '' };
  try {
    const { data } = await axios.get(`https://ipapi.co/${ip}/json/`, { timeout: 3500 });
    if (data && !data.error) {
      result.country = data.country_name || data.country || '';
      result.city = data.city || '';
    }
  } catch (e) {
    // Fallback: ip-api.com
    try {
      const { data } = await axios.get(`http://ip-api.com/json/${ip}?fields=status,country,city`, { timeout: 3500 });
      if (data && data.status === 'success') {
        result.country = data.country || '';
        result.city = data.city || '';
      }
    } catch (e2) {
      // No geolocation available — leave blank
    }
  }
  geoCache.set(ip, result);
  return result;
}

/* ------------------------------------------------------------------
   PASSWORD STRENGTH (#17)
   min 8 chars + upper + lower + number + special
------------------------------------------------------------------ */
function validatePasswordStrength(password) {
  const errors = [];
  if (!password) {
    errors.push('Password is required.');
    return { valid: false, errors };
  }
  if (password.length < config.PASSWORD_MIN_LENGTH) {
    errors.push(`Password must be at least ${config.PASSWORD_MIN_LENGTH} characters.`);
  }
  if (!/[A-Z]/.test(password)) errors.push('Must include an uppercase letter.');
  if (!/[a-z]/.test(password)) errors.push('Must include a lowercase letter.');
  if (!/[0-9]/.test(password)) errors.push('Must include a number.');
  if (!/[^A-Za-z0-9]/.test(password)) errors.push('Must include a special character.');
  return { valid: errors.length === 0, errors };
}

/* ------------------------------------------------------------------
   TOKENS
------------------------------------------------------------------ */
function signAccessToken(user, sessionId) {
  return require('jsonwebtoken').sign(
    { id: user._id, role: user.role, sid: sessionId },
    config.JWT_SECRET,
    { expiresIn: config.ACCESS_TOKEN_EXPIRES }
  );
}

function generateRefreshToken() {
  return crypto.randomBytes(48).toString('hex'); // 96 hex chars, unguessable
}

function hashRefreshToken(token) {
  return sha256('refresh:' + token);
}

function signSecurityToken(payload, expiresIn = config.SECURITY_TOKEN_EXPIRES) {
  return require('jsonwebtoken').sign(payload, config.SECURITY_TOKEN_SECRET, { expiresIn });
}

function verifySecurityToken(token) {
  try {
    return require('jsonwebtoken').verify(token, config.SECURITY_TOKEN_SECRET);
  } catch (e) {
    return null;
  }
}

/* ------------------------------------------------------------------
   TOTP (otplib v12 synchronous API)
   Keep functions async-compatible: callers use `await`, which works fine
   with plain (non-promise) return values.
------------------------------------------------------------------ */
function generateTotpSecret() {
  return authenticator.generateSecret();
}

async function generateTotpCode(secret) {
  return String(authenticator.generate(secret));
}

async function verifyTotp({ token, secret, toleranceSec = config.TOTP_EPOCH_TOLERANCE_SEC }) {
  if (!token || !secret) return false;
  try {
    // otplib v12 uses a `window` of 30-second steps. Convert our epoch
    // tolerance (in seconds, default 60) to the matching step window.
    const window = Math.max(1, Math.ceil(toleranceSec / 30));
    authenticator.options = { window };
    return authenticator.check(String(token).trim(), secret);
  } catch (e) {
    return false;
  }
}

function generateTotpUri({ secret, email }) {
  try {
    return authenticator.keyuri(email, config.TOTP_ISSUER, secret);
  } catch (e) {
    return '';
  }
}

function generateBackupCodes(count = config.BACKUP_CODES_COUNT) {
  const codes = [];
  for (let i = 0; i < count; i++) {
    codes.push(crypto.randomBytes(5).toString('hex').toUpperCase()); // 10-char hex codes
  }
  return codes;
}

/* ------------------------------------------------------------------
   SANITIZE USER OBJECT for API responses (never leak hashes/secrets)
------------------------------------------------------------------ */
function sanitizeUser(user) {
  if (!user) return null;
  return {
    id: user._id,
    name: user.name,
    email: user.email,
    role: user.role,
    newsletter: user.newsletter,
    emailVerified: !!user.emailVerified,
    twoFactorEnabled: !!user.twoFactorEnabled,
    mustChangePassword: !!user.mustChangePassword,
    createdAt: user.createdAt
  };
}

module.exports = {
  sha256,
  parseUserAgent,
  deviceFingerprint,
  getClientIp,
  getIpLocation,
  validatePasswordStrength,
  signAccessToken,
  generateRefreshToken,
  hashRefreshToken,
  signSecurityToken,
  verifySecurityToken,
  generateTotpSecret,
  generateTotpCode,
  verifyTotp,
  generateTotpUri,
  generateBackupCodes,
  sanitizeUser
};
