// routes/payments.js
// PayPal Payment Routes

const express = require('express');
const router = express.Router();
const { protect, isAdmin } = require('../middleware/auth');
const { 
  createPayPalOrder, 
  capturePayPalOrder, 
  getConfig,
  createZeinaPayment,
  getZeinaPayment,
  initiateBankAppPayment,
  getBankAppPaymentStatus,
  confirmBankAppPayment,
  cancelBankAppPayment,
  getPaymentOptions,
  getProvidersStatus,
  initiatePayment,
  getPaymentStatus,
  handleWebhook
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

// ---- UAE Online Payments (multi-provider) ----

// GET /api/payments/options — enabled & configured payment options for "Pay Online"
router.get('/options', getPaymentOptions);

// GET /api/payments/providers/status — admin: status of all providers
router.get('/providers/status', protect, isAdmin, getProvidersStatus);

// POST /api/payments/initiate — create order (PENDING) + official payment request
router.post('/initiate', initiatePayment);

// GET /api/payments/status/:orderId — authoritative verification on return
router.get('/status/:orderId', getPaymentStatus);

// POST /api/payments/webhook/:provider — provider callbacks (re-verified server-side)
router.post('/webhook/:provider', handleWebhook);

// ---- Bank-App / Bank-Transfer payment (manual fallback) ----

// POST /api/payments/bank-app/initiate — create order + payment request
router.post('/bank-app/initiate', initiateBankAppPayment);

// GET /api/payments/bank-app/:orderId — verify payment status on return
router.get('/bank-app/:orderId', getBankAppPaymentStatus);

// POST /api/payments/bank-app/confirm — customer says "I have completed payment"
router.post('/bank-app/confirm', confirmBankAppPayment);

// POST /api/payments/bank-app/cancel — customer abandons the payment request
router.post('/bank-app/cancel', cancelBankAppPayment);

module.exports = router;
