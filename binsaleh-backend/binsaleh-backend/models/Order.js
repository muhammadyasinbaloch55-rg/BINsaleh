// models/Order.js
// Ye fields addTocurt.html ke checkout modal (co-fname, co-address, etc.) se match karte hain

const mongoose = require('mongoose');

const orderItemSchema = new mongoose.Schema({
  // Accept both ObjectId (from MongoDB) and string (from frontend IDs)
  productId: { type: mongoose.Schema.Types.Mixed },
  name:      { type: String, required: true },
  price:     { type: Number, required: true },
  quantity:  { type: Number, required: true, default: 1 },
  color:     { type: String, default: '' },
  image:     { type: String, default: '' }
}, { _id: false });

const orderSchema = new mongoose.Schema({
  // Agar logged-in user ne order kiya to link ho jayega, warna guest checkout
  user:     { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },

  items:    [orderItemSchema],

  contact:  { type: String, required: true }, // co-contact: phone ya email

  shippingAddress: {
    country:  { type: String, default: 'Pakistan' },
    firstName:{ type: String, required: true },
    lastName: { type: String, default: '' },
    address:  { type: String, required: true },
    apartment:{ type: String, default: '' },
    city:     { type: String, required: true },
    postal:   { type: String, default: '' },
    phone:    { type: String, required: true }
  },

  shippingMethod: {
    type: String,
    enum: ['standard', 'express', 'free'],
    default: 'standard'
  },
  shippingCost: { type: Number, default: 0 },

  paymentMethod: {
    type: String,
    enum: ['cod', 'jazzcash', 'bank', 'easypaisa', 'hbl', 'meezan', 'paypal', 'zeina'],
    default: 'cod'
  },

  // COD advance payment (new requirement #2)
  advanceRequired:  { type: Number, default: 0 }, // advance due per COD settings
  advancePaid:      { type: Number, default: 0 }, // how much the customer actually paid
  remainingAmount:  { type: Number, default: 0 }, // order total - advance paid (due at delivery)

  // Coupon applied at checkout (#3)
  coupon: {
    code:        { type: String, default: '' },
    type:        { type: String, default: '' },   // percentage | flat
    discount:    { type: Number, default: 0 },    // raw discount value from coupon
    discountAmount: { type: Number, default: 0 }  // computed AED amount applied
  },

  // Order tracking (#13)
  trackingNumber: { type: String, default: '' },
  statusHistory: [
    {
      status:    { type: String },
      note:      { type: String, default: '' },
      changedAt: { type: Date, default: Date.now },
      by:        { type: String, default: '' }
    }
  ],

  // Payment details — populated when payment is confirmed
  paymentDetails: {
    transactionId: { type: String, default: '' },
    paidAmount:    { type: Number, default: 0 },
    paidAt:        { type: Date, default: null },
    confirmedBy:   { type: String, default: '' }, // admin email or customer info
    notes:         { type: String, default: '' }
  },

  // Overall payment status (separate from order status)
  paymentStatus: {
    type: String,
    enum: ['pending', 'paid', 'failed', 'refunded'],
    default: 'pending'
  },

  subtotal: { type: Number, required: true },
  total:    { type: Number, required: true },
  currency: { type: String, default: 'AED' },

  status: {
    type: String,
    enum: ['pending', 'confirmed', 'processing', 'packed', 'shipped', 'out_for_delivery', 'delivered', 'cancelled', 'refunded'],
    default: 'pending'
  }
}, {
  timestamps: true
});

// Ensure 'id' is included in JSON output alongside '_id'
orderSchema.set('toJSON', { virtuals: true });

module.exports = mongoose.model('Order', orderSchema);
