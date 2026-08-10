// controllers/reviewController.js
// MongoDB-backed product reviews — Admin can approve/reject/delete

const Review = require('../models/Review');
const Product = require('../models/Product');
const sanitizeHtml = require('sanitize-html');
const { log } = require('../services/auditService');

// Strip all HTML/script from user-generated review fields (stored-XSS defense).
// Reviews are rendered via innerHTML on the storefront, so any markup a
// customer submits must be neutralized before it is persisted.
function cleanUserText(value, maxLen = 2000) {
  if (typeof value !== 'string') return '';
  return sanitizeHtml(value, {
    allowedTags: [],                // no HTML allowed in reviews
    allowedAttributes: {},
    disallowedTagsMode: 'discard',
    textFilter: (text) => text
  }).replace(/\s+/g, ' ').trim().slice(0, maxLen);
}

// GET /api/reviews?product=<id> — public, get reviews for a product
exports.getProductReviews = async (req, res) => {
  try {
    const filter = { status: 'approved' };
    if (req.query.product) filter.product = req.query.product;
    const reviews = await Review.find(filter).sort({ createdAt: -1 });
    res.json(reviews);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// GET /api/reviews/all — admin only, get ALL reviews (including pending/rejected)
exports.getAllReviews = async (req, res) => {
  try {
    const reviews = await Review.find()
      .populate('product', 'name')
      .sort({ createdAt: -1 });
    res.json(reviews);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// POST /api/reviews — public, submit a review
exports.createReview = async (req, res) => {
  try {
    const { productId, name, email, rating, text } = req.body;
    if (!productId || !name || !rating || !text) {
      return res.status(400).json({ message: 'Product ID, name, rating, and review text are required' });
    }

    // Sanitize all user-supplied fields before persisting (stored-XSS defense)
    const cleanName = cleanUserText(name, 80);
    const cleanText = cleanUserText(text, 2000);
    const cleanEmail = cleanUserText(email, 120).toLowerCase();
    if (!cleanName || !cleanText) {
      return res.status(400).json({ message: 'Name and review text cannot be empty after sanitization.' });
    }

    const review = await Review.create({
      product: productId,
      name: cleanName,
      email: cleanEmail,
      rating: Math.min(5, Math.max(1, Number(rating))),
      text: cleanText,
      status: 'pending', // moderation required — admin approves from the Reviews page (#4)
      verified: false
    });

    // ---- Review notification (#10) ----
    // Notify the admin panel + owner email when a new review arrives.
    try {
      const Notification = require('../models/Notification');
      const { sendReviewNotification } = require('../services/emailService');
      const { emit } = require('../services/realtime');
      const product = await Product.findById(productId).lean().select('name');
      const productName = product ? product.name : 'Product';

      await Notification.create({
        type: 'new_review',
        title: '⭐ New Review: ' + productName,
        message: (name || 'Anonymous') + ' rated ' + (Number(rating) || 0) + '/5',
        refType: 'review',
        refId: String(review._id)
      });
      emit('new_review', { reviewId: String(review._id), productName, rating: Number(rating) || 0 });
      emit('notification', { type: 'new_review' });

      sendReviewNotification({ productName, reviewerName: name, rating, text }).catch(() => {});
    } catch (e) {
      console.warn('⚠️ Review notification failed:', e.message);
    }

    res.status(201).json(review);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// PUT /api/reviews/:id — admin only, update review status (approve/reject) and/or reply (#4)
exports.updateReview = async (req, res) => {
  try {
    const { status, reply } = req.body;
    const update = {};
    if (status !== undefined) {
      if (!['pending', 'approved', 'rejected'].includes(status)) {
        return res.status(400).json({ message: 'Invalid status. Use: pending, approved, or rejected' });
      }
      update.status = status;
    }
    if (reply !== undefined) {
      update.reply = cleanUserText(reply, 1000);
      update.replyAt = update.reply ? new Date() : null;
    }
    const review = await Review.findByIdAndUpdate(
      req.params.id,
      update,
      { new: true, runValidators: true }
    );
    if (!review) return res.status(404).json({ message: 'Review not found' });

    // Audit review moderation (#14)
    await log({
      category: 'review',
      action: 'Review updated',
      details: { reviewId: String(review._id), product: String(review.product || ''), status: review.status || '', hasReply: !!review.reply },
      actor: req.user ? req.user.email || 'admin' : 'admin',
      ip: req.ip || ''
    });

    res.json(review);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// DELETE /api/reviews/:id — admin only
exports.deleteReview = async (req, res) => {
  try {
    const review = await Review.findByIdAndDelete(req.params.id);
    if (!review) return res.status(404).json({ message: 'Review not found' });

    // Audit review moderation (#14)
    await log({
      category: 'review',
      action: 'Review deleted',
      details: { reviewId: String(review._id), product: String(review.product || ''), rating: review.rating },
      actor: req.user ? req.user.email || 'admin' : 'admin',
      ip: req.ip || ''
    });

    res.json({ message: 'Review deleted successfully' });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};
