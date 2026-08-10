// middleware/security.js
// Global security middleware:
//  - NoSQL-injection sanitization (req.body/query/params) (#16)
//  - XSS-friendly input trimming (strip HTML-ish markup from common fields) (#16)
//  - Origin/CSRF check for state-changing requests (#16)
//  - Dedicated brute-force rate limiters for login & register (#7)

const rateLimit = require('express-rate-limit');
const config = require('../config/security');

/* ------------------------------------------------------------------
   NoSQL-INJECTION SANITIZATION
   Recursively strips keys starting with '$' (Mongo operators like $gt,
   $ne, $where) and dotted prototype-pollution keys from user input.
------------------------------------------------------------------ */
function sanitizeValue(value) {
  if (value === null || value === undefined) return value;
  if (typeof value !== 'object') {
    // XSS hardening on common string fields
    if (typeof value === 'string' && value.length > 0 && value.length < 2000) {
      // Neutralize obvious HTML injection on free-text fields.
      // (Strict content is enforced per-controller where needed.)
      return value.replace(/<script[\s\S]*?>[\s\S]*?<\/script>/gi, '');
    }
    return value;
  }
  if (Array.isArray(value)) return value.map(sanitizeValue);

  const cleaned = {};
  for (const key of Object.keys(value)) {
    if (key.startsWith('$') || key.includes('.')) continue; // drop $operators & __proto__.x
    cleaned[key] = sanitizeValue(value[key]);
  }
  return cleaned;
}

exports.sanitizeInput = (req, res, next) => {
  try {
    if (req.body && typeof req.body === 'object') req.body = sanitizeValue(req.body);
    if (req.query && typeof req.query === 'object') req.query = sanitizeValue(req.query);
    if (req.params && typeof req.params === 'object') req.params = sanitizeValue(req.params);
  } catch (e) {
    return res.status(400).json({ message: 'Invalid request payload.' });
  }
  next();
};

/* ------------------------------------------------------------------
   ORIGIN / CSRF CHECK
   The API authenticates via Bearer tokens (not cookies), so classic CSRF
   is largely mitigated. This extra layer rejects state-changing requests
   from unexpected browser origins when an explicit CLIENT_URL is set.
   It stays lenient when CLIENT_URL is not configured (dev / permissive
   CORS setups) so the live frontend is never blocked unexpectedly.
------------------------------------------------------------------ */
exports.originCheck = (req, res, next) => {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  const origin = req.headers.origin;
  if (!origin) return next(); // non-browser clients / curl

  // Only enforce when the deploy explicitly configured CLIENT_URL.
  if (!process.env.CLIENT_URL) return next();

  const allowed = [process.env.CLIENT_URL, process.env.API_URL].filter(Boolean);
  const allowedOrigins = allowed.map(u => {
    try { return new URL(u).origin; } catch (e) { return null; }
  }).filter(Boolean);

  if (allowedOrigins.length === 0) return next();
  try {
    const o = new URL(origin).origin;
    if (allowedOrigins.includes(o)) return next();
  } catch (e) { /* fall through */ }

  return res.status(403).json({ message: 'Cross-origin request blocked.' });
};

/* ------------------------------------------------------------------
   BRUTE-FORCE RATE LIMITERS (#7)
   Much stricter than the general API limiter — login & register.
------------------------------------------------------------------ */
exports.authLimiter = rateLimit({
  windowMs: config.AUTH_RATE_LIMIT_WINDOW_MS,
  max: config.AUTH_RATE_LIMIT_MAX,
  message: { message: 'Too many attempts. Please try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: false
});

// Separate, slightly more lenient limiter for refresh-token rotation.
exports.refreshLimiter = rateLimit({
  windowMs: config.AUTH_RATE_LIMIT_WINDOW_MS,
  max: config.AUTH_RATE_LIMIT_MAX * 4,
  message: { message: 'Too many refresh requests. Please try again later.' },
  standardHeaders: true,
  legacyHeaders: false
});
