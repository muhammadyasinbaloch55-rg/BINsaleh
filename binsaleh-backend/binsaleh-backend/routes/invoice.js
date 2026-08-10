// routes/invoice.js
// Invoice generation + delivery (#5, #6, #7)

const express = require('express');
const router = express.Router();
const { protect, isAdmin, optionalProtect } = require('../middleware/auth');
const Order = require('../models/Order');
const { generateInvoicePDF, invoiceEmailHtml } = require('../services/invoiceService');
const { sendInvoiceEmail } = require('../services/emailService');
const { log } = require('../services/auditService');

// GET /api/invoice/:orderId/pdf — download a real PDF invoice
router.get('/:orderId/pdf', optionalProtect, async (req, res) => {
  try {
    const order = await Order.findById(req.params.orderId);
    if (!order) return res.status(404).json({ message: 'Order not found' });

    // Customer can only fetch their own invoice unless admin. Guest (ownerless)
    // orders are admin-only — same IDOR protection as GET /api/orders/:id.
    if (!req.user) return res.status(401).json({ message: 'Authentication required' });
    if (req.user.role !== 'admin' && (!order.user || String(order.user) !== String(req.user.id))) {
      return res.status(403).json({ message: 'Access denied' });
    }

    const buffer = await generateInvoicePDF(order);
    const shortId = String(order._id).slice(-6).toUpperCase();

    await log({
      category: 'invoice',
      action: 'Invoice PDF downloaded',
      details: { orderId: String(order._id), shortId },
      actor: req.user ? req.user.email || 'admin' : 'customer'
    });

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="bin-saleh-invoice-${shortId}.pdf"`);
    res.send(buffer);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// POST /api/invoice/:orderId/email — send the invoice PDF to the customer email
router.post('/:orderId/email', protect, isAdmin, async (req, res) => {
  try {
    const order = await Order.findById(req.params.orderId);
    if (!order) return res.status(404).json({ message: 'Order not found' });

    const customerEmail = req.body.email || (order.contact && order.contact.includes('@') ? order.contact : null);
    if (!customerEmail) {
      return res.status(400).json({ message: 'No customer email available for this order' });
    }

    const buffer = await generateInvoicePDF(order);
    const shortId = String(order._id).slice(-6).toUpperCase();

    const result = await sendInvoiceEmail({
      customerEmail,
      customerName: (order.shippingAddress && order.shippingAddress.firstName) || 'Valued Customer',
      subject: `🧾 Invoice #${shortId} — BIN SALEH Store`,
      html: invoiceEmailHtml(order),
      attachment: {
        filename: `bin-saleh-invoice-${shortId}.pdf`,
        content: buffer,
        contentType: 'application/pdf'
      }
    });

    if (result && result.success === false) {
      return res.status(500).json({ message: 'Invoice email failed: ' + (result.error || 'SMTP not configured') });
    }

    await log({
      category: 'invoice',
      action: 'Invoice emailed',
      details: { orderId: String(order._id), to: customerEmail },
      actor: req.user ? req.user.email || 'admin' : 'admin'
    });

    res.json({ message: 'Invoice sent to ' + customerEmail });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

module.exports = router;
