// routes/payments.js
// PayPal Payment Routes

const express = require('express');
const router = express.Router();
const { 
  createPayPalOrder, 
  capturePayPalOrder, 
  getConfig,
  createZeinaPayment,
  getZeinaPayment
} = require('../controllers/paymentController');

// POST /api/payments/create-paypal-order — Create a PayPal order
router.post('/create-paypal-order', createPayPalOrder);

// POST /api/payments/capture-paypal-order — Capture a PayPal order after approval
router.post('/capture-paypal-order', capturePayPalOrder);

// POST /api/payments/create-zeina-payment — Create a Zeina (Ziina) payment intent
router.post('/create-zeina-payment', createZeinaPayment);

// GET /api/payments/zeina-payment/:id — Check a Zeina payment intent status
router.get('/zeina-payment/:id', getZeinaPayment);

// GET /api/payments/config — Get gateway config for frontend SDK
router.get('/config', getConfig);

module.exports = router;
