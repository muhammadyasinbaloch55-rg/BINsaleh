// api/index.js
// Vercel serverless entry point — all HTTP requests are routed here via
// vercel.json rewrites. server.js detects the VERCEL env var, skips the
// Socket.IO server + app.listen(), and exports the Express app as the
// function handler. This file simply forwards that export.
module.exports = require('../server');
