// api/index.js
// Vercel serverless entry point — all HTTP requests are routed here via
// vercel.json rewrites. server.js detects the VERCEL env var, skips the
// Socket.IO server + app.listen(), and exports the Express app as the
// function handler.
//
// Cold starts: Mongoose's default command buffer is 10s, which is shorter
// than the DB connect time on a cold function. So we await the (cached)
// connection BEFORE serving — the first request waits for Mongo instead of
// timing out. Warm instances reuse the global connection instantly.
const app = require('../server');
const connectDB = require('./../config/db');

// Cache the connection promise across warm invocations (config/db.js already
// caches globally, so this is just a per-handler guard).
let connecting = null;
function ensureDB() {
  if (!connecting) {
    connecting = connectDB().catch((err) => {
      // Allow a retry on the next request if the connection failed.
      connecting = null;
      throw err;
    });
  }
  return connecting;
}

module.exports = async (req, res) => {
  try {
    await ensureDB();
  } catch (err) {
    console.error('❌ MongoDB connection failed:', err.message);
    if (!res.headersSent) {
      res.status(503).json({ message: 'Database unavailable. Please try again.' });
      return;
    }
  }
  return app(req, res);
};
