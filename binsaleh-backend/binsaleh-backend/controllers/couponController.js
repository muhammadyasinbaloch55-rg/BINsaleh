// controllers/couponController.js
// Complete coupon & discount system (#3).
// Coupons live in the Settings store under key "coupons" (array).
// All validation is server-side: expiry, usage limit, min order, one-time per customer.

const Settings = require('../models/Settings');
const { log } = require('../services/auditService');
const { emit } = require('../services/realtime');

async function getCoupons() {
  const s = await Settings.findOne({ key: 'coupons' });
  if (!s) return [];
  return Array.isArray(s.value) ? s.value : [];
}

async function saveCoupons(coupons) {
  await Settings.findOneAndUpdate(
    { key: 'coupons' },
    { $set: { value: coupons } },
    { upsert: true }
  );
}

function isCouponActive(coupon) {
  if (!coupon || coupon.active === false) return false;
  // Not valid yet — start date is in the future
  if (coupon.startDate) {
    const start = new Date(coupon.startDate);
    if (!isNaN(start) && start > new Date()) return false;
  }
  if (coupon.expiry) {
    const exp = new Date(coupon.expiry);
    if (!isNaN(exp) && exp < new Date()) return false;
  }
  return true;
}

// POST /api/coupons/validate
// Body: { code, subtotal, customerEmail }
// Returns: { valid, code, type, discount, discountAmount, newSubtotal, message }
exports.validateCoupon = async (req, res) => {
  try {
    const { code, subtotal, customerEmail } = req.body || {};
    const couponCode = String(code || '').trim().toUpperCase();
    if (!couponCode) return res.status(400).json({ valid: false, message: 'Please enter a coupon code.' });

    const coupons = await getCoupons();
    const coupon = coupons.find(c => String(c.code || '').toUpperCase() === couponCode);
    if (!coupon) return res.json({ valid: false, message: 'Invalid coupon code.' });
    // Scheduled coupon: start date is still in the future
    if (coupon.startDate && new Date(coupon.startDate) > new Date()) {
      return res.json({ valid: false, message: 'This coupon is not active yet.' });
    }
    if (!isCouponActive(coupon)) return res.json({ valid: false, message: 'This coupon has expired.' });

    const subtotalNum = Number(subtotal) || 0;
    if (subtotalNum < (Number(coupon.minOrder) || 0)) {
      return res.json({ valid: false, message: `Minimum order of ${Number(coupon.minOrder).toLocaleString()} required for this coupon.` });
    }

    // Usage limit
    const maxUses = Number(coupon.maxUses) || Infinity;
    if ((Number(coupon.used) || 0) >= maxUses) {
      return res.json({ valid: false, message: 'This coupon has reached its usage limit.' });
    }

    // One-time per customer
    const usedBy = Array.isArray(coupon.usedBy) ? coupon.usedBy : [];
    if (customerEmail && usedBy.some(e => String(e).toLowerCase() === String(customerEmail).toLowerCase())) {
      return res.json({ valid: false, message: 'This coupon has already been used for this email.' });
    }

    // Compute discount
    const type = coupon.type === 'flat' ? 'flat' : 'percentage';
    let discountAmount = 0;
    if (type === 'percentage') {
      discountAmount = Math.round((subtotalNum * Number(coupon.discount)) / 100);
    } else {
      discountAmount = Number(coupon.discount) || 0;
    }
    if (discountAmount > subtotalNum) discountAmount = subtotalNum;

    return res.json({
      valid: true,
      code: couponCode,
      type,
      discount: Number(coupon.discount),
      discountAmount,
      newSubtotal: subtotalNum - discountAmount,
      message: `Coupon ${couponCode} applied — you save ${discountAmount.toLocaleString()}!`
    });
  } catch (err) {
    res.status(500).json({ valid: false, message: err.message });
  }
};

// POST /api/coupons/apply
// Called at order creation — atomically consumes one use.
// Body: { code, subtotal, customerEmail }
exports.applyCoupon = async (req, res) => {
  try {
    const { code, subtotal, customerEmail } = req.body || {};
    const couponCode = String(code || '').trim().toUpperCase();
    const coupons = await getCoupons();
    const idx = coupons.findIndex(c => String(c.code || '').toUpperCase() === couponCode);
    if (idx === -1) return res.status(400).json({ valid: false, message: 'Invalid coupon code.' });
    const coupon = coupons[idx];

    if (!isCouponActive(coupon)) return res.status(400).json({ valid: false, message: 'This coupon has expired.' });
    const subtotalNum = Number(subtotal) || 0;
    if (subtotalNum < (Number(coupon.minOrder) || 0)) return res.status(400).json({ valid: false, message: 'Minimum order not met.' });
    const maxUses = Number(coupon.maxUses) || Infinity;
    if ((Number(coupon.used) || 0) >= maxUses) return res.status(400).json({ valid: false, message: 'Usage limit reached.' });

    const usedBy = Array.isArray(coupon.usedBy) ? coupon.usedBy : [];
    if (customerEmail && usedBy.some(e => String(e).toLowerCase() === String(customerEmail).toLowerCase())) {
      return res.status(400).json({ valid: false, message: 'Already used for this email.' });
    }

    // Consume one use + record email
    coupons[idx] = {
      ...coupon,
      used: (Number(coupon.used) || 0) + 1,
      usedBy: customerEmail ? [...usedBy, customerEmail] : usedBy
    };
    await saveCoupons(coupons);

    let discountAmount = 0;
    if (coupon.type === 'percentage') {
      discountAmount = Math.round((subtotalNum * Number(coupon.discount)) / 100);
    } else {
      discountAmount = Number(coupon.discount) || 0;
    }
    if (discountAmount > subtotalNum) discountAmount = subtotalNum;

    await log({
      category: 'coupon',
      action: 'Coupon applied',
      details: { code: couponCode, email: customerEmail || '', discountAmount },
      actor: customerEmail || 'guest'
    });
    emit('coupon_used', { code: couponCode });

    res.json({ valid: true, code: couponCode, type: coupon.type, discount: Number(coupon.discount), discountAmount, newSubtotal: subtotalNum - discountAmount });
  } catch (err) {
    res.status(500).json({ valid: false, message: err.message });
  }
};

// GET /api/coupons — admin: list coupons (from DB settings)
exports.listCoupons = async (req, res) => {
  try {
    const coupons = await getCoupons();
    res.json(coupons);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// GET /api/coupons/sale — public: sale banner data for the storefront homepage.
// Derives the banner's percentage, flat discount, active codes, and countdown
// end time from the currently active coupons, so editing coupons in the admin
// panel instantly updates the homepage timer / text / percentages.
exports.getSaleInfo = async (req, res) => {
  try {
    const coupons = await getCoupons();
    const now = new Date();
    const active = coupons.filter(c => isCouponActive(c));
    if (!active.length) return res.json({ saleActive: false });

    let maxDiscount = 0;
    let bestFlat = 0;
    let endDates = [];
    const codes = [];
    active.forEach(c => {
      if (c.code) codes.push(String(c.code));
      const d = Number(c.discount) || 0;
      if (c.type === 'flat') bestFlat = Math.max(bestFlat, d);
      else maxDiscount = Math.max(maxDiscount, d);
      if (c.expiry) {
        const e = new Date(c.expiry);
        if (!isNaN(e.getTime()) && e > now) endDates.push(e.getTime());
      }
    });
    // The sale ends when the first active coupon expires.
    let saleEnd = endDates.length ? new Date(Math.min(...endDates)) : null;
    if (!saleEnd) saleEnd = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000); // fallback: 7 days

    res.json({
      saleActive: true,
      maxDiscount,
      bestFlat,
      currency: 'AED',
      saleEnd: saleEnd.toISOString(),
      codes,
      count: active.length
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// PUT /api/coupons/:code — admin: create/update
exports.saveCoupon = async (req, res) => {
  try {
    const code = String(req.params.code || '').trim().toUpperCase();
    if (!code) return res.status(400).json({ message: 'Code required' });
    const body = req.body || {};
    const coupons = await getCoupons();
    const idx = coupons.findIndex(c => String(c.code || '').toUpperCase() === code);
    const coupon = {
      code,
      type: body.type === 'flat' ? 'flat' : 'percentage',
      discount: Number(body.discount) || 0,
      minOrder: Number(body.minOrder) || 0,
      maxUses: Number(body.maxUses) || 100,
      used: idx > -1 ? (Number(coupons[idx].used) || 0) : 0,
      usedBy: idx > -1 ? (coupons[idx].usedBy || []) : [],
      startDate: body.startDate || '',
      expiry: body.expiry || '',
      active: body.active !== false
    };
    if (idx > -1) coupons[idx] = coupon; else coupons.push(coupon);
    await saveCoupons(coupons);
    await log({ category: 'coupon', action: idx > -1 ? 'Coupon updated' : 'Coupon created', details: { code }, actor: req.user?.email || 'admin' });
    res.json(coupon);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
};

// DELETE /api/coupons/:code
exports.deleteCoupon = async (req, res) => {
  try {
    const code = String(req.params.code || '').trim().toUpperCase();
    const coupons = await getCoupons();
    const filtered = coupons.filter(c => String(c.code || '').toUpperCase() !== code);
    if (filtered.length === coupons.length) return res.status(404).json({ message: 'Coupon not found' });
    await saveCoupons(filtered);
    await log({ category: 'coupon', action: 'Coupon deleted', details: { code }, actor: req.user?.email || 'admin' });
    res.json({ message: 'Coupon deleted' });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};
