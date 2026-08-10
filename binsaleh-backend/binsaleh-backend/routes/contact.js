// routes/contact.js
// Contact form submission and campaign sending routes

const express = require('express');
const router = express.Router();
const { submitContactForm } = require('../controllers/contactController');
const { protect, isAdmin } = require('../middleware/auth');
const { sendEmail, getBusinessEmail } = require('../services/emailService');

// POST /api/contact — Submit contact form
router.post('/', submitContactForm);

// POST /api/contact/send-campaign — Admin: send marketing campaign to subscribers
router.post('/send-campaign', protect, isAdmin, async (req, res) => {
  try {
    const { subject, body, audience, emails } = req.body;
    
    if (!subject || !body) {
      return res.status(400).json({ message: 'Subject and body are required' });
    }

    // If specific email list provided, use that; otherwise fetch from DB based on audience
    let recipientEmails = emails;
    if (!recipientEmails || !recipientEmails.length) {
      const User = require('../models/User');
      let query = { newsletter: true };
      if (audience === 'customers') query.role = 'customer';
      
      const subscribers = await User.find(query).select('email').lean();
      recipientEmails = subscribers.map(s => s.email).filter(Boolean);
    }

    if (!recipientEmails || !recipientEmails.length) {
      return res.status(400).json({ message: 'No recipients found for this audience' });
    }

    // Remove duplicates
    recipientEmails = [...new Set(recipientEmails)];

    const businessEmail = await getBusinessEmail();
    
    const html = `
      <div style="font-family:'DM Sans',Arial,sans-serif;max-width:560px;margin:0 auto;padding:24px">
        <div style="text-align:center;padding:20px 0;border-bottom:2px solid #b8860b">
          <h1 style="font-family:'Bebas Neue';letter-spacing:3px;color:#b8860b;margin:0">BIN SALEH STORE</h1>
        </div>
        <div style="padding:24px 0">
          ${body.replace(/\n/g, '<br/>')}
        </div>
        <div style="border-top:1px solid #eee;padding:16px 0;text-align:center;font-size:0.78rem;color:#999">
          <p>BIN SALEH Store — UAE's Premium Fashion Destination</p>
          <p><a href="mailto:${businessEmail}" style="color:#b8860b">${businessEmail}</a></p>
          <p style="font-size:0.7rem;margin-top:12px">
            You received this email because you subscribed to the BIN SALEH Store newsletter.<br/>
            To unsubscribe, reply to this email with "Unsubscribe" in the subject line.
          </p>
        </div>
      </div>
    `;

    // Send to each recipient individually
    let sent = 0;
    let failed = 0;
    
    for (const email of recipientEmails) {
      try {
        await sendEmail({ to: email, subject: subject.trim(), html, from: businessEmail });
        sent++;
      } catch (e) {
        failed++;
        console.warn('Campaign send failed for', email, ':', e.message);
      }
    }

    res.json({
      message: 'Campaign sent to ' + sent + ' recipient(s)' + (failed ? ' (' + failed + ' failed)' : ''),
      sent,
      failed,
      total: recipientEmails.length
    });
  } catch (err) {
    console.error('Campaign send error:', err);
    res.status(500).json({ message: err.message });
  }
});

module.exports = router;
