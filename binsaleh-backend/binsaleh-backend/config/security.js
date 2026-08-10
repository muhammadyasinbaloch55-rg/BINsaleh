// config/security.js
// Centralized security configuration for the BIN SALEH auth system.
// All secrets, expiry windows, rate limits and thresholds live here so the
// rest of the codebase never hardcodes values. Every value can be overridden
// via environment variables (production) with sensible dev fallbacks.

const crypto = require('crypto');

// ---------------- Admin approval bypass ----------------
// Emails in this list are trusted by the owner and skip the admin approval
// workflow entirely: registration is auto-approved, every device is treated
// as trusted, and the middleware gate never blocks them. Override/extend via
// the ADMIN_APPROVAL_BYPASS_EMAILS env var (comma-separated).
const ADMIN_APPROVAL_BYPASS_EMAILS = (process.env.ADMIN_APPROVAL_BYPASS_EMAILS || 'yasinsasoli186@gmail.com')
  .split(',')
  .map(e => e.trim().toLowerCase())
  .filter(Boolean);

if (ADMIN_APPROVAL_BYPASS_EMAILS.length) {
  console.warn(`🔓 Admin approval bypass is ACTIVE for: ${ADMIN_APPROVAL_BYPASS_EMAILS.join(', ')} — these admin accounts log in WITHOUT owner approval (including the deny/revoke flows). Remove them from ADMIN_APPROVAL_BYPASS_EMAILS to restore approval.`);
}

// SECURITY: never fall back to a hardcoded/committed secret. If JWT_SECRET is
// not configured, generate a strong random secret at boot. This prevents token
// forgery (a committed default would let anyone mint admin JWTs). The trade-off
// is that sessions reset on restart — set JWT_SECRET as an env var (Render
// dashboard) to keep sessions stable across restarts.
const _randomSecret = crypto.randomBytes(48).toString('hex');
const JWT_SECRET = process.env.JWT_SECRET || _randomSecret;
if (!process.env.JWT_SECRET) {
  console.warn('⚠️  JWT_SECRET is NOT set! Using a temporary random secret —');
  console.warn('    all sessions will be invalidated on the next server restart.');
  console.warn('    Set JWT_SECRET in your environment variables (Render dashboard) immediately.');
}

// Derived secrets — stable per-install, overridable per-environment.
// Derived values are deterministic so existing JWTs survive restarts.
function derive(seed, label) {
  return crypto.createHash('sha256').update(seed + ':' + label).digest('hex').slice(0, 64);
}

module.exports = {
  // ---------------- Secrets ----------------
  JWT_SECRET,
  JWT_REFRESH_SECRET: process.env.JWT_REFRESH_SECRET || derive(JWT_SECRET, 'refresh'),
  SECURITY_TOKEN_SECRET: process.env.SECURITY_TOKEN_SECRET || derive(JWT_SECRET, 'security'),

  // ---------------- Token lifetimes ----------------
  // Access token — the token the frontend stores & sends as Bearer.
  // Defaults to the legacy JWT_EXPIRES_IN (7d) for backward compatibility;
  // set JWT_ACCESS_EXPIRES_IN to tighten it once the frontend supports refresh.
  ACCESS_TOKEN_EXPIRES: process.env.JWT_ACCESS_EXPIRES_IN || process.env.JWT_EXPIRES_IN || '7d',

  // Refresh token — random opaque token, stored hashed in the Session model.
  REFRESH_TOKEN_EXPIRES_DAYS: parseInt(process.env.JWT_REFRESH_EXPIRES_DAYS || '30', 10),

  // ---------------- Session auto-expiry ----------------
  // Idle: session is killed after this many days without activity.
  SESSION_IDLE_DAYS: parseInt(process.env.SESSION_IDLE_DAYS || '14', 10),
  // Absolute: session cannot live longer than this, even with activity.
  SESSION_MAX_DAYS: parseInt(process.env.SESSION_MAX_DAYS || '30', 10),

  // ---------------- Brute force / lockout ----------------
  MAX_FAILED_ATTEMPTS: parseInt(process.env.MAX_FAILED_ATTEMPTS || '5', 10),
  // Base lockout in minutes; escalates: base, base*2, base*4, ... capped at 8h.
  LOCKOUT_BASE_MINUTES: parseInt(process.env.LOCKOUT_BASE_MINUTES || '15', 10),
  LOCKOUT_CAP_MINUTES: parseInt(process.env.LOCKOUT_CAP_MINUTES || String(8 * 60), 10),
  // Notify the user by email after this many consecutive failed attempts.
  FAILED_ATTEMPT_EMAIL_THRESHOLD: parseInt(process.env.FAILED_ATTEMPT_EMAIL_THRESHOLD || '3', 10),

  // ---------------- Rate limiting (login/register) ----------------
  AUTH_RATE_LIMIT_MAX: parseInt(process.env.AUTH_RATE_LIMIT_MAX || '15', 10),
  AUTH_RATE_LIMIT_WINDOW_MS: parseInt(process.env.AUTH_RATE_LIMIT_WINDOW_MS || String(15 * 60 * 1000), 10),

  // ---------------- App URLs ----------------
  CLIENT_URL: process.env.CLIENT_URL || 'http://localhost:3000',
  API_URL: process.env.API_URL || process.env.RENDER_EXTERNAL_URL || `http://localhost:${process.env.PORT || 5000}`,

  ADMIN_APPROVAL_BYPASS_EMAILS,

  // Returns true when the given email is on the admin approval bypass list.
  isAdminApprovalBypassed(email) {
    if (!email) return false;
    return ADMIN_APPROVAL_BYPASS_EMAILS.includes(String(email).toLowerCase().trim());
  },

  // ---------------- 2FA (TOTP) ----------------
  TOTP_ISSUER: process.env.TOTP_ISSUER || 'BIN SALEH Store',
  TOTP_EPOCH_TOLERANCE_SEC: parseInt(process.env.TOTP_EPOCH_TOLERANCE_SEC || '60', 10), // ±60s clock skew
  TWO_FACTOR_TEMP_EXPIRES: process.env.TWO_FACTOR_TEMP_EXPIRES_IN || '10m', // step-1 login token
  BACKUP_CODES_COUNT: parseInt(process.env.TOTP_BACKUP_CODES || '10', 10),

  // ---------------- Security alert / verification links ----------------
  SECURITY_TOKEN_EXPIRES: process.env.SECURITY_TOKEN_EXPIRES_IN || '48h', // Was-this-you? links
  EMAIL_VERIFY_EXPIRES_MS: parseInt(process.env.EMAIL_VERIFY_EXPIRES_MS || String(24 * 60 * 60 * 1000), 10),
  RESEND_VERIFY_COOLDOWN_MS: parseInt(process.env.RESEND_VERIFY_COOLDOWN_MS || String(2 * 60 * 1000), 10),

  // ---------------- Password policy ----------------
  PASSWORD_MIN_LENGTH: parseInt(process.env.PASSWORD_MIN_LENGTH || '8', 10),

  // Send an email on every successful login (requirement #1).
  SEND_LOGIN_NOTIFICATION: process.env.SEND_LOGIN_NOTIFICATION !== 'false'
};
