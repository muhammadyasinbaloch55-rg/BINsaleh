// routes/export.js
// Exports + production reports (#8, #12)

const express = require('express');
const router = express.Router();
const { protect, isAdmin } = require('../middleware/auth');
const { exportOrders, generateReport } = require('../controllers/exportController');

// GET /api/export/orders?format=csv|xlsx|pdf&from=&to=&status=&paymentMethod=&customer=
router.get('/orders', protect, isAdmin, exportOrders);

// GET /api/export/reports/:type?format=csv|xlsx|pdf&from=&to=
// types: sales | revenue | profit | best_sellers | low_stock | customers | payments
router.get('/reports/:type', protect, isAdmin, generateReport);

module.exports = router;
