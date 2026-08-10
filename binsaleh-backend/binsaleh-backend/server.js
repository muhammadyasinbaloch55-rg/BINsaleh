// server.js
// BIN SALEH Store — Backend Entry Point

require('dotenv').config();
// Production logging policy — silence verbose console.log/info, keep warn/error.
require('./config/logger');
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const connectDB = require('./config/db');
const { sanitizeInput, originCheck } = require('./middleware/security');
const config = require('./config/security');

const http = require('http');
const hpp = require('hpp');
const { Server } = require('socket.io');

const app = express();

// Vercel serverless functions have no persistent server, so Socket.IO (which
// needs long-lived connections) cannot run there. On Vercel this module is
// loaded by api/index.js and the Express app is exported as the function
// handler instead of calling listen(). Every realtime emit() already no-ops
// safely when no io instance is attached (services/realtime.js), so the REST
// API stays fully functional — only live push updates to the admin dashboard
// are unavailable on Vercel (the admin panel can poll instead).
const IS_VERCEL = !!(process.env.VERCEL || process.env.VERCEL_ENV);

let server = null;
let io = null;
if (!IS_VERCEL) {
  server = http.createServer(app);

  // Real-time dashboard (#11) — Socket.IO shared hub.
  // Admin panel connects to /socket.io/socket.io.js from the same origin.
  io = new Server(server, {
    cors: {
      origin: (origin, cb) => {
        if (isAllowedOrigin(origin)) return cb(null, true);
        return cb(new Error('Origin not allowed by CORS'));
      },
      credentials: true
    },
    // Keep polling as an automatic fallback if websockets are blocked.
    transports: ['websocket', 'polling']
  });
  const { attachIO } = require('./services/realtime');
  attachIO(io);
  const jwt = require('jsonwebtoken');
  io.use((socket, next) => {
    // Authenticate every socket: the admin panel sends the JWT in the handshake.
    // Reject unauthenticated clients so they can never join the 'admins' room.
    try {
      const token = socket.handshake.auth && socket.handshake.auth.token;
      if (!token) return next(new Error('unauthorized'));
      const decoded = jwt.verify(token, config.JWT_SECRET); // never the hardcoded fallback
      if (!decoded || decoded.role !== 'admin') return next(new Error('forbidden'));
      socket.user = { id: decoded.sub, role: decoded.role };
      next();
    } catch (e) {
      next(new Error('unauthorized'));
    }
  });
  io.on('connection', (socket) => {
    socket.join('admins');
    socket.on('subscribe_admin', () => socket.join('admins'));
    socket.on('disconnect', () => {});
  });
}

// Compute the allowed browser origins from env vars (CLIENT_URL / API_URL).
// When none are configured (local dev) we stay permissive; in production the
// frontend origin is locked down for both CORS and the origin/CSRF check.
function allowedOrigins() {
  return [process.env.CLIENT_URL, process.env.API_URL, process.env.RENDER_EXTERNAL_URL]
    .filter(Boolean);
}
function isAllowedOrigin(origin) {
  if (!origin) return true; // non-browser clients / curl
  const allowed = allowedOrigins();
  if (!allowed.length) return true; // dev fallback — no explicit config
  try {
    const o = new URL(origin).origin;
    return allowed.some(a => {
      try { return new URL(a).origin === o; } catch (e) { return a === o; }
    });
  } catch (e) {
    return false;
  }
}

// Trust the first proxy hop so req.ip / rate limiting work behind Render's proxy.
app.set('trust proxy', 1);

// ---------- Security Middleware ----------
// Helmet: set security headers (X-Frame-Options, X-Content-Type-Options, etc.)
app.use(helmet({
  crossOriginResourcePolicy: { policy: 'cross-origin' },
  contentSecurityPolicy: false
}));

// Rate limiting: protect API from abuse
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 300, // 300 requests per 15 minutes (~20 req/min) for general API
  message: { message: 'Too many requests, please try again later.' },
  standardHeaders: true,
  legacyHeaders: false
});
app.use('/api/', apiLimiter);

// Stricter limit for write operations (orders, auth, etc.)
const writeLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 60,
  message: { message: 'Too many write requests, please slow down.' }
});
app.use('/api/orders', writeLimiter);
app.use('/api/auth', writeLimiter);

// Payment gateway endpoints (create/capture — they move real money) — tighter.
const paymentLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 30,
  message: { message: 'Too many payment requests, please slow down.' },
  standardHeaders: true,
  legacyHeaders: false
});
app.use('/api/payments', paymentLimiter);

// Contact form — prevent inbox flooding / email bombing.
const contactLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 10,
  message: { message: 'Too many messages sent. Please try again later.' },
  standardHeaders: true,
  legacyHeaders: false
});
app.use('/api/contact', contactLimiter);

// Newsletter subscribe — prevent signup spam / DB pollution.
const newsletterLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 10,
  message: { message: 'Too many subscribe attempts. Please try again later.' },
  standardHeaders: true,
  legacyHeaders: false
});
app.use('/api/newsletter', newsletterLimiter);

// CORS — locked to the configured frontend origin(s); permissive only in dev.
app.use(cors({
  origin: (origin, cb) => {
    if (isAllowedOrigin(origin)) return cb(null, true);
    return cb(new Error('Not allowed by CORS'));
  },
  credentials: true
}));

// HTTP Parameter Pollution protection
app.use(hpp());

// NoSQL-injection sanitization + XSS hardening for all input (#16)
app.use(sanitizeInput);

// Origin/CSRF check for state-changing browser requests (#16)
app.use(originCheck);

// Body parsers with size limits (2MB JSON is plenty; images go via Cloudinary/multipart)
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true, limit: '2mb' }));

// Static files
app.use('/uploads', express.static('uploads'));

// ---------- Test Route ----------
app.get('/', (req, res) => {
  res.json({ message: 'BIN SALEH Store API is running 🚀' });
});

// ---------- Routes ----------
app.use('/api/products', require('./routes/products'));
app.use('/api/auth', require('./routes/auth'));
app.use('/api/orders', require('./routes/orders'));
app.use('/api/settings', require('./routes/settings'));
app.use('/api/upload', require('./routes/upload'));
app.use('/api/reviews', require('./routes/reviews'));
app.use('/api/admin/notifications', require('./routes/notifications'));
app.use('/api/admin/audit', require('./routes/audit'));
app.use('/api/payments', require('./routes/payments'));
app.use('/api/contact', require('./routes/contact'));
app.use('/api/coupons', require('./routes/coupons'));
app.use('/api/wishlist', require('./routes/wishlist'));
app.use('/api/invoice', require('./routes/invoice'));
app.use('/api/export', require('./routes/export'));

// Newsletter endpoint — dedicated route so frontend can POST to /api/newsletter/subscribe
app.post('/api/newsletter/subscribe',
  require('express-validator').body('email')
    .isString().withMessage('Please provide a valid email address.')
    .trim()
    .toLowerCase()
    .matches(/^[^\s@]+@[^\s@]+\.[^\s@]+$/).withMessage('Please provide a valid email address.'),
  require('./middleware/validate'),
  async (req, res) => {
    // Forward to auth controller's subscribeNewsletter
    const { subscribeNewsletter } = require('./controllers/authController');
    return subscribeNewsletter(req, res);
  }
);

// ---------- 404 Handler ----------
app.use((req, res) => {
  res.status(404).json({ message: 'Route not found' });
});

// ---------- Global Error Handler ----------
// Never leak internal error details to clients in production.
app.use((err, req, res, next) => {
  console.error(err.stack);
  const status = err.status || 500;
  if (process.env.NODE_ENV === 'production' && status >= 500) {
    return res.status(status).json({ message: 'Server error' });
  }
  res.status(status).json({ message: err.message || 'Server error' });
});

// ===== Seed default settings on startup =====
async function seedDefaults() {
  try {
    const Settings = require('./models/Settings');
    const DEFAULT_SETTINGS = {
      announcement_text: '🚚  Free Shipping on Orders Above AED 300  |  💰  COD Available Nationwide  |  🔄  Easy Exchange Policy  |  ✅  AED 50 Advance Required to Confirm Order  |  ⭐  Summer Élite \'26 Collection is Live!',
      hero_slides: [
        { title:'Summer<br/><span>Élite</span><br/>\'26', tag:'New Arrival', sub:'Elevate your style with our latest premium collection.', link:'view-all.html', cta:'Shop Now', img:'' },
        { title:'Fresh<br/><span>Tops</span><br/>Collection', tag:'Premium Tops', sub:'From box-fit to oversized, our tops redefine casual streetwear.', link:'tops.html', cta:'Explore Tops', img:'' },
        { title:'Match the<br/><span>Vibe</span>', tag:'Co-Ord Sets', sub:'Complete co-ord sets and tracksuits for that perfectly curated look.', link:'tracksuits.html', cta:'Shop Sets', img:'' },
        { title:'Scent That<br/><span>Speaks</span>', tag:'Fragrances', sub:'Exclusive fragrances that leave a lasting impression.', link:'fragrances.html', cta:'Discover Now', img:'' },
        { title:'Step In<br/><span>Style</span>', tag:'Footwear', sub:'Premium footwear collection — from Adidas Samba to exclusive sneakers.', link:'footwear.html', cta:'View Shoes', img:'' }
      ],
      bank_settings: { advanceAmount:250, whatsapp:'9710566551046', bankName:'Emirates NBD', accountTitle:'BIN SALEH LLC', accountNumber:'0123456789', iban:'AE070331234567890123456', branchName:'Dubai Main Branch', paymentInstructions:'Please transfer the advance amount to the account above and send the receipt on WhatsApp.', deposit:[{ label:'Emirates NBD (AED): 0123456789', value:'emirates_nbd' },{ label:'ADCB (AED): 9876543210', value:'adcb' },{ label:'FAB Bank Transfer: A/C 1234567890', value:'fab' },{ label:'Mashreq Bank Transfer: A/C 0987654321', value:'mashreq' }] },
      business_email: 'binsalehllc946@gmail.com',
      smtp_settings: {
        host: 'smtp.gmail.com',
        port: 587,
        secure: false,
        user: '',
        pass: ''
      },
      shipping_settings: { standardFee:25, expressFee:50, urgentFee:80, sameDayFee:120, freeThreshold:300 },
      cod_settings: { enabled:true, advanceType:'fixed', fixedAmount:50, percentage:30 },
      pixel_settings: { fb:{ enabled:false, pixelId:'' }, tiktok:{ enabled:false, pixelId:'' }, ga:{ enabled:false, trackingId:'' } },
      payment_settings: {
        methods: [
          { id:'cod', name:'Cash on Delivery', icon:'fas fa-money-bill-wave', enabled:true, type:'cod', sortOrder:0 },
          { id:'zeina', name:'Zeina (Card / Apple Pay)', icon:'fas fa-credit-card', enabled:true, type:'gateway', sortOrder:1, config:{ accessToken:'', mode:'test' } },
          { id:'paypal', name:'PayPal / Credit / Debit Card', icon:'fab fa-paypal', enabled:true, type:'gateway', sortOrder:2, config:{ clientId:'', clientSecret:'', mode:'sandbox' } }
        ]
      },
      categories: [
        { name:'Tops', slug:'tops', desc:'Box-fit, Oversized & More', img:'', active:true },
        { name:'Bottoms', slug:'bottoms', desc:'Korean Pants, Cargos & More', img:'', active:true },
        { name:'Tracksuits', slug:'tracksuits', desc:'Co-Ord Sets & Matching Suits', img:'', active:true },
        { name:'Footwear', slug:'footwear', desc:'Sneakers, Trainers & More', img:'', active:true },
        { name:'Fragrances', slug:'fragrances', desc:'Exclusive Signature Scents', img:'', active:true },
        { name:'Accessories', slug:'accessories', desc:'Watches, Sunglasses, Bracelets', img:'', active:true },
        { name:'Home & Kitchen', slug:'home-kitchen', desc:'Cookware, Decor & More', img:'', active:true }
      ],
      coupons: [
        { code:'SUMMER26', type:'percentage', discount:20, minOrder:2000, maxUses:100, used:0, expiry:'2026-06-30', active:true },
        { code:'BS250', type:'flat', discount:250, minOrder:1500, maxUses:500, used:0, expiry:'2026-07-15', active:true },
        { code:'ELITE10', type:'percentage', discount:10, minOrder:5000, maxUses:50, used:0, expiry:'2026-06-20', active:true }
      ],
      collections: [
        { slug:'tops', name:'Tops', desc:'Box-fit, Oversized & More', link:'tops.html', img:'' },
        { slug:'bottoms', name:'Bottoms', desc:'Korean Pants, Cargos & More', link:'bottoms.html', img:'' },
        { slug:'tracksuits', name:'Tracksuits', desc:'Co-Ord Sets & Matching Suits', link:'tracksuits.html', img:'' },
        { slug:'footwear', name:'Footwear', desc:'Sneakers, Trainers & More', link:'footwear.html', img:'' },
        { slug:'fragrances', name:'Fragrances', desc:'Exclusive Signature Scents', link:'fragrances.html', img:'' },
        { slug:'accessories', name:'Accessories', desc:'Watches, Sunglasses, Bracelets', link:'accessories.html', img:'' },
        { slug:'home-kitchen', name:'Home & Kitchen', desc:'Cookware, Decor & More', link:'home-kitchen.html', img:'' }
      ]
    };

    for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
      const existing = await Settings.findOne({ key });
      if (!existing) {
        await Settings.create({ key, value });
        console.log(`✅ Default setting created: ${key}`);
      }
    }

    // Migration: append the new "Home & Kitchen" category/collection to any
    // ALREADY-STORED settings so existing deployments pick it up automatically
    // (fresh installs get it from DEFAULT_SETTINGS above).
    const HK_CATEGORY = { name: 'Home & Kitchen', slug: 'home-kitchen', desc: 'Cookware, Decor & More', img: '', active: true };
    const HK_COLLECTION = { slug: 'home-kitchen', name: 'Home & Kitchen', desc: 'Cookware, Decor & More', link: 'home-kitchen.html', img: '' };
    const HK_SETTINGS = { categories: HK_CATEGORY, collections: HK_COLLECTION };
    for (const [key, entry] of Object.entries(HK_SETTINGS)) {
      try {
        const existing = await Settings.findOne({ key });
        if (!existing) continue;
        let list = Array.isArray(existing.value) ? existing.value : null;
        if (!list && typeof existing.value === 'string') {
          try { list = JSON.parse(existing.value); } catch (e) { list = null; }
        }
        if (!Array.isArray(list)) continue;
        if (list.some(c => String(c && c.slug || '').toLowerCase() === 'home-kitchen')) continue;
        list.push(entry);
        await Settings.updateOne({ key }, { value: list });
        console.log(`✅ Added Home & Kitchen to existing ${key} setting`);
      } catch (e) {
        console.warn(`⚠️ Could not migrate ${key} setting:`, e.message);
      }
    }
    console.log('✅ All default settings seeded');
  } catch (err) {
    console.warn('⚠️ Could not seed default settings:', err.message);
  }
}

// ===== Enterprise security startup tasks =====
async function securityStartupTasks() {
  const User = require('./models/User');
  const Session = require('./models/Session');

  try {
    // #10 — Grandfather existing accounts: mark users created before this
    // feature as email-verified so the live store isn't locked out. New
    // registrations go through the verification flow normally.
    const result = await User.updateMany(
      { emailVerified: { $exists: false } },
      { $set: { emailVerified: true, emailVerifiedAt: new Date() } }
    );
    console.log(`🔐 Grandfathered ${result.modifiedCount || result.nModified || 0} existing accounts (email verified).`);

    // #6 — Grandfather EXISTING admins as approved so the owner isn't locked
    // out after this update. Only NEW admin registrations require approval.
    const adminResult = await User.updateMany(
      { role: 'admin', adminApproved: { $exists: false } },
      { $set: { adminApproved: true, adminBlocked: false } }
    );
    console.log(`🔐 Grandfathered ${adminResult.modifiedCount || adminResult.nModified || 0} existing admin accounts (approved).`);

    // Owner's approval-bypass list: force-approve those admin accounts in the
    // DB so the stored record matches the runtime bypass (see config/security.js).
    if (config.ADMIN_APPROVAL_BYPASS_EMAILS && config.ADMIN_APPROVAL_BYPASS_EMAILS.length) {
      const bypassResult = await User.updateMany(
        { role: 'admin', email: { $in: config.ADMIN_APPROVAL_BYPASS_EMAILS } },
        { $set: { adminApproved: true, adminBlocked: false } }
      );
      const bypassCount = bypassResult.modifiedCount || bypassResult.nModified || 0;
      if (bypassCount) {
        console.log(`✅ Auto-approved ${bypassCount} approval-bypass admin account(s).`);
      }
    }

    // Order tracking: backfill the removed legacy 'paid' status → 'confirmed'
    // (the new 9-status enum no longer includes 'paid' as an order status).
    try {
      const Order = require('./models/Order');
      const orderBackfill = await Order.updateMany(
        { status: 'paid' },
        { $set: { status: 'confirmed' }, $push: { statusHistory: { status: 'confirmed', note: 'Auto-migrated from legacy paid status', changedAt: new Date(), by: 'system' } } }
      );
      if (orderBackfill.modifiedCount || orderBackfill.nModified) {
        console.log(`📦 Migrated ${orderBackfill.modifiedCount || orderBackfill.nModified || 0} legacy orders to 'confirmed' status.`);
      }
    } catch (e) {
      console.warn('⚠️ Order status backfill skipped:', e.message);
    }
  } catch (err) {
    console.warn('⚠️ Could not backfill existing users:', err.message);
  }

  // #15 — Periodic cleanup of expired/revoked sessions.
  const cleanupSessions = async () => {
    try {
      const now = new Date();
      const res = await Session.deleteMany({
        $or: [
          { expiresAt: { $lt: now } },
          { revokedAt: { $lt: new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000) } } // keep revoked records 7 days
        ]
      });
      if (res.deletedCount) console.log(`🧹 Cleaned ${res.deletedCount} stale sessions.`);
    } catch (err) {
      console.warn('⚠️ Session cleanup failed:', err.message);
    }
  };
  await cleanupSessions();
  setInterval(cleanupSessions, 6 * 60 * 60 * 1000).unref(); // every 6 hours
}

// ---------- Start Server ----------
const PORT = process.env.PORT || 5000;

// Server ko hamesha start karo, chahe DB connect ho ya na ho
connectDB()
  .then(async () => {
    console.log('✅ MongoDB connected — all features available');
    await seedDefaults();
    await securityStartupTasks();
  })
  .catch(err => {
    console.warn('⚠️ Server started without MongoDB. Some features may not work.');
  })
  .finally(() => {
    // Vercel: no long-running listener — the app is the serverless handler.
    if (IS_VERCEL) return;
    server.listen(PORT, () => {
      console.log(`🟢 Server running on http://localhost:${PORT}`);
    });
  });

// Vercel serverless: export the Express app as the function handler.
// api/index.js simply re-exports this module.
if (IS_VERCEL) {
  module.exports = app;
}
