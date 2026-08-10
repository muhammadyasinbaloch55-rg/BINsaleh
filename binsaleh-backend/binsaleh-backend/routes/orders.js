// routes/orders.js

const express = require('express');
const router = express.Router();
const { protect, isAdmin, optionalProtect } = require('../middleware/auth');
const {
  createOrder,
  getOrders,
  getMyOrders,
  getOrderById,
  getStats,
  updateOrderStatus,
  confirmPayment,
  deleteOrder
} = require('../controllers/orderController');

// Order place karna — login zaroori nahi (guest checkout allowed),
// lekin agar logged-in hai to order user ke account se link ho jayega
router.post('/', optionalProtect, createOrder);

// Customer apni orders dekhe — login zaroori
router.get('/my', protect, getMyOrders);

// Admin: dashboard aggregate stats (before /:id so it isn't swallowed)
router.get('/stats', protect, isAdmin, getStats);

// Admin: sab orders dekhna
router.get('/', protect, isAdmin, getOrders);

// Ek specific order dekhna
router.get('/:id', protect, getOrderById);

// Admin: order status update karna
router.put('/:id/status', protect, isAdmin, updateOrderStatus);

// Admin: payment confirm karna
router.put('/:id/payment', protect, isAdmin, confirmPayment);

// Admin: order delete karna
router.delete('/:id', protect, isAdmin, deleteOrder);

module.exports = router;
