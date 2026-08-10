// routes/reviews.js
// Product review routes

const express = require('express');
const router = express.Router();
const { body } = require('express-validator');
const validate = require('../middleware/validate');
const { protect, isAdmin } = require('../middleware/auth');
const {
  getProductReviews,
  getAllReviews,
  createReview,
  updateReview,
  deleteReview
} = require('../controllers/reviewController');

// Public: get approved reviews for a product
router.get('/', getProductReviews);

// Admin: get all reviews (including pending/rejected)
router.get('/all', protect, isAdmin, getAllReviews);

// Public: submit a review
// Permissive guardrails (message matches the controller's existing text);
// rating is intentionally left to the controller, which clamps it safely.
const reviewMsg = 'Product ID, name, rating, and review text are required';
router.post('/',
  body('productId').isString().withMessage(reviewMsg).trim().isLength({ min: 1, max: 100 }).withMessage(reviewMsg),
  body('text').isString().withMessage(reviewMsg).isLength({ min: 1, max: 5000 }).withMessage(reviewMsg),
  validate,
  createReview
);

// Admin: update review status (approve/reject)
router.put('/:id', protect, isAdmin, updateReview);

// Admin: delete review
router.delete('/:id', protect, isAdmin, deleteReview);

module.exports = router;
