// config/logger.js
// Production logging policy.
// ------------------------------------------------------------------
// Informational console.log / console.info output is suppressed when
// NODE_ENV === 'production' so no verbose debug chatter leaks into
// Vercel/Render logs. console.warn and console.error are intentionally
// KEPT — they carry operational alerts (DB failures, security warnings,
// request errors) that must never be hidden.
//
// Load this module FIRST (right after dotenv) so every module loaded
// afterwards inherits the policy. Development mode is completely
// unaffected — all logs stay visible.
// ------------------------------------------------------------------
if (process.env.NODE_ENV === 'production') {
  /* eslint-disable no-console */
  console.log = function productionNoop() {};
  console.info = function productionNoop() {};
  /* eslint-enable no-console */
}

module.exports = console;
