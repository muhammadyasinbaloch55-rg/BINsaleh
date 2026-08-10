// controllers/contactController.js
// Handles contact form submissions and sends email notifications to the business

const sanitizeHtml = require('sanitize-html');
const { sendEmail, getBusinessEmail } = require('../services/emailService');

// Neutralize HTML/script + CRLF (email header injection) in user-submitted
// contact fields before they are interpolated into the notification email.
function cleanContact(value, maxLen = 2000) {
  if (typeof value !== 'string') return '';
  return sanitizeHtml(value, {
    allowedTags: [], allowedAttributes: {}, disallowedTagsMode: 'discard'
  }).replace(/\r|\n/g, ' ').replace(/\s+/g, ' ').trim().slice(0, maxLen);
}

// POST /api/contact
exports.submitContactForm = async (req, res) => {
  try {
    const { name, email, subject, message } = req.body;

    if (!name || !email || !message) {
      return res.status(400).json({ message: 'Please fill in name, email, and message.' });
    }

    const cleanName = cleanContact(name, 120);
    const cleanEmail = cleanContact(email, 120);
    const cleanSubject = cleanContact(subject, 150);
    const cleanMessage = cleanContact(message, 2000);

    const businessEmail = await getBusinessEmail();
    const emailSubject = cleanSubject
      ? `📩 Contact Form: ${cleanSubject} — from ${cleanName}`
      : `📩 New Contact Message from ${cleanName} <${cleanEmail}>`;

    const html = `
      <div style="font-family:'DM Sans',Arial,sans-serif;max-width:560px;margin:0 auto;padding:24px">
        <div style="background:#b8860b;color:#fff;padding:16px 24px;border-radius:10px;text-align:center">
          <h2 style="margin:0;font-family:'Bebas Neue';letter-spacing:2px">NEW CONTACT MESSAGE</h2>
        </div>
        <div style="padding:20px 0">
          <div style="background:#f9f9f9;border-radius:10px;padding:16px;margin:12px 0">
            <p><strong>Name:</strong> ${cleanName}</p>
            <p><strong>Email:</strong> ${cleanEmail}</p>
            ${cleanSubject ? `<p><strong>Subject:</strong> ${cleanSubject}</p>` : ''}
            <p><strong>Message:</strong></p>
            <p style="background:#fff;padding:12px;border-radius:6px;border:1px solid #eee;line-height:1.6">${cleanMessage}</p>
          </div>
        </div>
      </div>
    `;

    await sendEmail({
      to: businessEmail,
      subject: emailSubject,
      html
    });

    // Send acknowledgement to the person who submitted the form
    const ackHtml = `
      <div style="font-family:'DM Sans',Arial,sans-serif;max-width:560px;margin:0 auto;padding:24px">
        <div style="text-align:center;padding:20px 0;border-bottom:2px solid #b8860b">
          <h1 style="font-family:'Bebas Neue';letter-spacing:3px;color:#b8860b;margin:0">BIN SALEH STORE</h1>
        </div>
        <div style="padding:24px 0">
          <h2 style="color:#111">Thank you for reaching out, ${cleanName}!</h2>
          <p style="color:#555;line-height:1.6">We've received your message and will get back to you within 24 hours.</p>
          ${cleanSubject ? `<p style="color:#888;font-size:0.85rem"><strong>Subject:</strong> ${cleanSubject}</p>` : ''}
          <p style="color:#888;font-size:0.85rem">For urgent inquiries, contact us on WhatsApp at +9710566551046.</p>
        </div>
      </div>
    `;

    // Send acknowledgement asynchronously (use the cleaned address to avoid
    // header-injection through the recipient field)
    sendEmail({ to: cleanEmail, subject: '📨 We received your message — BIN SALEH Store', html: ackHtml }).catch(() => {});

    res.json({ message: 'Message sent successfully! We will get back to you soon.' });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};
