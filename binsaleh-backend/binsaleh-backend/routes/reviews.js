// routes/reviews.js
// Product review routes

const express = require('express');
const router = express.Router();
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
router.post('/', createReview);

// Admin: update review status (approve/reject)
router.put('/:id', protect, isAdmin, updateReview);

// Admin: delete review
router.delete('/:id', protect, isAdmin, deleteReview);

module.exports = router;
