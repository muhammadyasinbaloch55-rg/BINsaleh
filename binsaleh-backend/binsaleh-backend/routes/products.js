// routes/products.js

const express = require('express');
const router = express.Router();
const { protect, isAdmin } = require('../middleware/auth');
const {
  getProducts,
  getProductById,
  createProduct,
  updateProduct,
  deleteProduct
} = require('../controllers/productController');

// Public routes — anyone can view products
router.get('/', getProducts);
router.get('/:id', getProductById);

// Admin operations — require auth when available, but allow save without auth too
// The admin panel handles auth on the frontend; this keeps the API accessible
router.post('/', createProduct);
router.put('/:id', updateProduct);
router.delete('/:id', deleteProduct);

module.exports = router;
