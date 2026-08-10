// routes/coupons.js
// Coupon & discount endpoints (#3)

const express = require('express');
const router = express.Router();
const { protect, isAdmin } = require('../middleware/auth');
const {
  validateCoupon,
  applyCoupon,
  listCoupons,
  saveCoupon,
  deleteCoupon,
  getSaleInfo
} = require('../controllers/couponController');

// Public: validate a coupon at checkout
router.post('/validate', validateCoupon);

// Public-ish: consume a coupon use at order creation
router.post('/apply', applyCoupon);

// Public: sale banner data for the storefront homepage (derived from active coupons)
router.get('/sale', getSaleInfo);

// Admin CRUD
router.get('/', protect, isAdmin, listCoupons);
router.put('/:code', protect, isAdmin, saveCoupon);
router.delete('/:code', protect, isAdmin, deleteCoupon);

module.exports = router;
