// services/emailService.js
// Email notification service
// Reads business email from DB settings (configurable via Admin Panel)
// Falls back to env var BUSINESS_EMAIL or default binsalehllc946@gmail.com
// Uses Gmail SMTP for sending emails (App Password required)
//
// Includes enterprise security templates:
//  - Email verification (#10)
//  - Login notifications & "Was this you?" alerts (#1, #2, #3)
//  - Password changed / email changed / 2FA toggles (#1)
//  - Failed-login & account-lockout alerts (#5, #6, #9)
//  - Account secured (after clicking "No") + admin alerts (#4)

const nodemailer = require('nodemailer');

// Default business email (used if nothing configured)
const DEFAULT_BUSINESS_EMAIL = 'binsalehllc946@gmail.com';

// Human-friendly payment method label used in email templates
function paymentMethodLabel(m) {
  const map = { cod: 'Cash on Delivery', bank_app: 'Bank App', zeina: 'Ziina', paypal: 'PayPal', myfatoorah: 'myFatoorah', paytabs: 'PayTabs', moyasar: 'Moyasar', bank: 'Bank Transfer', jazzcash: 'JazzCash', easypaisa: 'EasyPaisa', hbl: 'HBL', meezan: 'Meezan' };
  return map[m] || (m ? String(m).toUpperCase() : 'COD');
}

// Configurable store name for the sender (requirement #9)
async function getStoreName() {
  try {
    const Settings = require('../models/Settings');
    const setting = await Settings.findOne({ key: 'store_name' });
    if (setting && setting.value && String(setting.value).trim()) {
      return String(setting.value).trim();
    }
  } catch (e) {
    // fall through to default
  }
  return process.env.STORE_NAME || 'BIN SALEH Store';
}

// Load business email from DB settings
async function getBusinessEmail() {
  try {
    const Settings = require('../models/Settings');
    const setting = await Settings.findOne({ key: 'business_email' });
    if (setting && setting.value && setting.value.trim()) {
      return setting.value.trim();
    }
  } catch (e) {
    // DB not available — use env var or default
  }
  return process.env.BUSINESS_EMAIL || DEFAULT_BUSINESS_EMAIL;
}

// Create a reusable transporter using Gmail SMTP
// Requires an App Password (not regular password) for security
// Admin can configure SMTP settings via Admin Panel > Settings > Email
async function createTransporter() {
  try {
    const Settings = require('../models/Settings');
    const setting = await Settings.findOne({ key: 'smtp_settings' });
    if (setting && setting.value) {
      const smtp = typeof setting.value === 'string' ? JSON.parse(setting.value) : setting.value;
      if (smtp.host && smtp.user && smtp.pass) {
        return nodemailer.createTransport({
          host: smtp.host,
          port: smtp.port || 587,
          secure: smtp.secure || false,
          auth: { user: smtp.user, pass: smtp.pass }
        });
      }
    }
  } catch (e) {
    // Use default Gmail SMTP
  }

  // Default: Gmail SMTP with App Password
  return nodemailer.createTransport({
    service: 'gmail',
    auth: {
      user: process.env.SMTP_EMAIL || DEFAULT_BUSINESS_EMAIL,
      pass: process.env.SMTP_PASSWORD || ''
    }
  });
}

// Send an email
async function sendEmail({ to, subject, html, from }) {
  try {
    const transporter = await createTransporter();
    const businessEmail = from || await getBusinessEmail();

    const storeName = await getStoreName();
    const mailOptions = {
      from: `"${storeName}" <${businessEmail}>`,
      to,
      subject,
      html
    };

    const info = await transporter.sendMail(mailOptions);
    console.log(`📧 Email sent to ${to}: ${info.messageId}`);
    return { success: true, messageId: info.messageId };
  } catch (err) {
    console.error('📧 Email send failed:', err.message);
    // Don't throw — email failure should not break the main flow
    return { success: false, error: err.message };
  }
}

/* ------------------------------------------------------------------
   Shared HTML shell (branding)
------------------------------------------------------------------ */
function emailShell(body) {
  return `
    <div style="font-family:'DM Sans',Arial,sans-serif;max-width:560px;margin:0 auto;padding:24px">
      <div style="text-align:center;padding:20px 0;border-bottom:2px solid #b8860b">
        <h1 style="font-family:'Bebas Neue';letter-spacing:3px;color:#b8860b;margin:0">BIN SALEH STORE</h1>
      </div>
      ${body}
      <div style="border-top:1px solid #eee;padding:16px 0;text-align:center;font-size:0.78rem;color:#999">
        <p>BIN SALEH Store — UAE's Premium Fashion Destination</p>
        <p><a href="mailto:binsalehllc946@gmail.com" style="color:#b8860b">binsalehllc946@gmail.com</a> | <a href="https://wa.me/9710566551046" style="color:#b8860b">WhatsApp</a></p>
        <p>If this wasn't you, please secure your account immediately.</p>
      </div>
    </div>
  `;
}

/* ======================================================================
   SECURITY EMAILS
====================================================================== */

// 1) Email verification (requirement #10)
async function sendEmailVerification({ email, name, verificationUrl }) {
  const subject = '🔐 Verify Your Email — BIN SALEH Store';
  const body = `
    <div style="padding:24px 0">
      <h2 style="color:#111;margin:0 0 8px">Hi ${name || 'there'}, please verify your email</h2>
      <p style="color:#555;line-height:1.6">To keep your account secure, we need you to confirm this email address before you can log in. This link expires in 24 hours.</p>
      <div style="text-align:center;margin:24px 0">
        <a href="${verificationUrl}" style="display:inline-block;background:#b8860b;color:#fff;padding:12px 28px;border-radius:8px;text-decoration:none;font-weight:600">Verify My Email</a>
      </div>
      <p style="color:#888;font-size:0.85rem">Or copy this link: <br><span style="word-break:break-all">${verificationUrl}</span></p>
      <p style="color:#888;font-size:0.85rem">If you didn't create this account, you can safely ignore this email.</p>
    </div>
  `;
  return sendEmail({ to: email, subject, html: emailShell(body) });
}

// 2) Login notification — "Was this you?" with Yes/No buttons (#1, #2, #3)
async function sendLoginNotification({ email, name, details, confirmUrl, denyUrl }) {
  // Admin accounts vet new devices through the owner-approval workflow, so
  // they never get the customer-flow "Was this you?" buttons.
  const adminAccount = !!details.isAdmin;
  const newDevice = !adminAccount && (details.isNewDevice || details.isNewCountry);
  const subject = newDevice
    ? '🚨 New Sign-In Detected — BIN SALEH Store'
    : '🔔 New Sign-In — BIN SALEH Store';

  const detailRow = (label, value) => `
    <tr><td style="padding:6px 12px;border-bottom:1px solid #f0f0f0;color:#888;font-size:0.85rem">${label}</td>
    <td style="padding:6px 12px;border-bottom:1px solid #f0f0f0;color:#111;font-weight:500">${value || 'Unknown'}</td></tr>
  `;

  const buttons = newDevice
    ? `
      <div style="text-align:center;margin:24px 0">
        <a href="${confirmUrl}" style="display:inline-block;background:#2e7d32;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:600;margin:0 6px">✅ Yes, it was me</a>
        <a href="${denyUrl}" style="display:inline-block;background:#c62828;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:600;margin:0 6px">❌ No, secure my account</a>
      </div>
      <p style="color:#888;font-size:0.85rem;text-align:center">If you don't recognize this sign-in, click <strong>"No, secure my account"</strong> — we'll sign out all sessions, block new sign-ins, and force a password reset.</p>
    `
    : '';

  const heading = newDevice
    ? `<h2 style="color:#111;margin:0 0 8px">We noticed a new sign-in to your account</h2>`
    : `<h2 style="color:#111;margin:0 0 8px">A new sign-in to your account just happened</h2>`;

  const body = `
    <div style="padding:24px 0">
      ${heading}
      <p style="color:#555;line-height:1.6">Was this you? Here are the details:</p>
      <table style="width:100%;border-collapse:collapse;background:#f9f9f9;border-radius:10px;margin:16px 0">
        <tbody>
          ${detailRow('Time', details.time)}
          ${detailRow('IP Address', details.ip)}
          ${detailRow('Browser', details.browser)}
          ${detailRow('Operating System', details.os)}
          ${detailRow('Device', details.deviceName)}
          ${detailRow('Approximate Location', details.location)}
        </tbody>
      </table>
      ${buttons}
    </div>
  `;
  return sendEmail({ to: email, subject, html: emailShell(body) });
}

// 3) Password changed (#1)
async function sendPasswordChanged({ email, name }) {
  const subject = '🔒 Password Changed — BIN SALEH Store';
  const body = `
    <div style="padding:24px 0">
      <h2 style="color:#111;margin:0 0 8px">Your password was changed</h2>
      <p style="color:#555;line-height:1.6">The password for <strong>${email}</strong> was just changed${name ? ` for <strong>${name}</strong>` : ''}.</p>
      <p style="color:#888;font-size:0.85rem">If this was you, no action is needed. If you didn't make this change, contact support immediately.</p>
    </div>
  `;
  return sendEmail({ to: email, subject, html: emailShell(body) });
}

// 4) Email changed (#1)
async function sendEmailChanged({ email, name, newEmail }) {
  const subject = '✉️ Email Address Changed — BIN SALEH Store';
  const body = `
    <div style="padding:24px 0">
      <h2 style="color:#111;margin:0 0 8px">Your email address was changed</h2>
      <p style="color:#555;line-height:1.6">Your BIN SALEH account email was changed to <strong>${newEmail}</strong>.</p>
      <p style="color:#888;font-size:0.85rem">If this was you, no action is needed. If you didn't make this change, contact support immediately.</p>
    </div>
  `;
  return sendEmail({ to: email, subject, html: emailShell(body) });
}

// 5) 2FA enabled/disabled (#1)
async function send2FAStatus({ email, name, enabled }) {
  const subject = enabled ? '🔐 Two-Factor Authentication Enabled' : '🔓 Two-Factor Authentication Disabled';
  const body = `
    <div style="padding:24px 0">
      <h2 style="color:#111;margin:0 0 8px">Two-Factor Authentication ${enabled ? 'Enabled' : 'Disabled'}</h2>
      <p style="color:#555;line-height:1.6">Two-factor authentication on your BIN SALEH account has been <strong>${enabled ? 'turned ON' : 'turned OFF'}</strong>.</p>
      <p style="color:#888;font-size:0.85rem">If this wasn't you, contact support immediately.</p>
    </div>
  `;
  return sendEmail({ to: email, subject, html: emailShell(body) });
}

// 6) Failed login alert after multiple attempts (#9)
async function sendFailedLoginAlert({ email, name, attempts, details }) {
  const subject = '⚠️ Multiple Failed Login Attempts — BIN SALEH Store';
  const body = `
    <div style="padding:24px 0">
      <h2 style="color:#111;margin:0 0 8px">Someone tried to log in to your account ${attempts} times</h2>
      <p style="color:#555;line-height:1.6">There were ${attempts} failed login attempts on <strong>${email}</strong>.</p>
      <table style="width:100%;border-collapse:collapse;background:#f9f9f9;border-radius:10px;margin:16px 0">
        <tbody>
          <tr><td style="padding:6px 12px;color:#888;font-size:0.85rem">IP</td><td style="padding:6px 12px;color:#111">${details?.ip || 'Unknown'}</td></tr>
          <tr><td style="padding:6px 12px;color:#888;font-size:0.85rem">Device</td><td style="padding:6px 12px;color:#111">${details?.deviceName || 'Unknown'}</td></tr>
          <tr><td style="padding:6px 12px;color:#888;font-size:0.85rem">Time</td><td style="padding:6px 12px;color:#111">${details?.time || new Date().toLocaleString()}</td></tr>
        </tbody>
      </table>
      <p style="color:#888;font-size:0.85rem">If this wasn't you, consider changing your password.</p>
    </div>
  `;
  return sendEmail({ to: email, subject, html: emailShell(body) });
}

// 7) Account temporarily locked (#6)
async function sendAccountLocked({ email, name, lockMinutes }) {
  const subject = '🔒 Account Temporarily Locked — BIN SALEH Store';
  const body = `
    <div style="padding:24px 0">
      <h2 style="color:#111;margin:0 0 8px">Your account is temporarily locked</h2>
      <p style="color:#555;line-height:1.6">Too many failed login attempts were detected. Your account has been locked for <strong>${lockMinutes} minutes</strong> to protect it from unauthorized access.</p>
      <p style="color:#888;font-size:0.85rem">You'll be able to try again after the lock expires. If this wasn't you, contact support.</p>
    </div>
  `;
  return sendEmail({ to: email, subject, html: emailShell(body) });
}

// 8) Account secured (after clicking "No") (#4)
async function sendAccountSecured({ email, name }) {
  const subject = '🛡️ Your Account Has Been Secured — BIN SALEH Store';
  const body = `
    <div style="padding:24px 0">
      <h2 style="color:#111;margin:0 0 8px">Your account is now secure</h2>
      <p style="color:#555;line-height:1.6">We've taken the following actions:</p>
      <ul style="color:#555;line-height:2">
        <li>✅ All active sessions were terminated</li>
        <li>✅ All refresh tokens were invalidated</li>
        <li>🔒 A password reset has been required</li>
        <li>📣 Our security team has been notified</li>
      </ul>
      <p style="color:#888;font-size:0.85rem">You'll need to set a new password the next time you log in.</p>
    </div>
  `;
  return sendEmail({ to: email, subject, html: emailShell(body) });
}

// 9) Admin notification (#4 — notify administrator when account secured; also on lockouts)
async function sendAdminSecurityAlert({ type, user, details }) {
  const businessEmail = await getBusinessEmail();
  const typeMap = {
    secured: { emoji: '🛡️', title: 'ACCOUNT SECURED' },
    locked: { emoji: '🔒', title: 'ACCOUNT LOCKED' },
    register: { emoji: '👤', title: 'NEW ACCOUNT REGISTERED' },
    failed: { emoji: '⚠️', title: 'REPEATED FAILED LOGINS' },
    password: { emoji: '🔑', title: 'PASSWORD CHANGED' },
    email: { emoji: '✉️', title: 'EMAIL CHANGED' },
    twofa: { emoji: '🔐', title: '2FA TOGGLED' }
  };
  const t = typeMap[type] || { emoji: '⚠️', title: 'SECURITY EVENT' };
  const subject = `${t.emoji} ${t.title} — ${user?.email || 'Unknown'}`;

  const body = `
    <div style="padding:20px 0">
      <div style="background:#b8860b;color:#fff;padding:16px 24px;border-radius:10px;text-align:center">
        <h2 style="margin:0;font-family:'Bebas Neue';letter-spacing:2px">${t.title}</h2>
      </div>
      <div style="background:#f9f9f9;border-radius:10px;padding:16px;margin:12px 0">
        <p><strong>User:</strong> ${user?.name || 'N/A'} (${user?.email || 'N/A'})</p>
        ${details ? `<p><strong>Details:</strong> ${details}</p>` : ''}
        <p><strong>Time:</strong> ${new Date().toLocaleString()}</p>
      </div>
    </div>
  `;
  return sendEmail({ to: businessEmail, subject, html: emailShell(body) });
}

// 10) Admin login/registration approval notification to owner (#3, #5)
async function sendAdminApprovalEmail({ kind, user, details, allowUrl, denyUrl }) {
  const businessEmail = await getBusinessEmail();
  const isLogin = kind === 'login';
  const subject = isLogin
    ? '🛡️ Admin Login Request — Needs Approval'
    : '🛡️ New Admin Registration — Needs Approval';

  const detailRow = (label, value) => `
    <tr><td style="padding:6px 12px;border-bottom:1px solid #f0f0f0;color:#888;font-size:0.85rem">${label}</td>
    <td style="padding:6px 12px;border-bottom:1px solid #f0f0f0;color:#111;font-weight:500">${value || 'Unknown'}</td></tr>
  `;

  const body = `
    <div style="padding:24px 0">
      <div style="background:#b8860b;color:#fff;padding:16px 24px;border-radius:10px;text-align:center;margin-bottom:20px">
        <h2 style="margin:0;font-family:'Bebas Neue';letter-spacing:2px">${isLogin ? 'ADMIN LOGIN REQUEST' : 'ADMIN REGISTRATION REQUEST'}</h2>
      </div>
      <h2 style="color:#111;margin:0 0 8px">Action required — approve or deny this request</h2>
      <p style="color:#555;line-height:1.6">A ${isLogin ? 'login attempt' : 'new admin registration'} was made for the Admin Panel:</p>
      <table style="width:100%;border-collapse:collapse;background:#f9f9f9;border-radius:10px;margin:16px 0">
        <tbody>
          ${detailRow('Request type', isLogin ? 'Login' : 'Registration')}
          ${detailRow('Name', user?.name)}
          ${detailRow('Email', user?.email)}
          ${detailRow('Date & Time', details?.time || new Date().toLocaleString())}
          ${detailRow('IP Address', details?.ip)}
          ${detailRow('Location', [details?.city, details?.country].filter(Boolean).join(', '))}
          ${detailRow('Browser', details?.browser)}
          ${detailRow('Operating System', details?.os)}
          ${detailRow('Device', details?.deviceName)}
          ${detailRow('Device Fingerprint', details?.fingerprint ? String(details.fingerprint).slice(0, 24) + '…' : 'Unknown')}
        </tbody>
      </table>
      <p style="color:#555;line-height:1.6"><strong>Allow</strong> approves this request so the user can ${isLogin ? 'log in to the Admin Panel' : 'activate their admin account'}. <strong>Deny</strong> rejects it and blocks access.</p>
      <div style="text-align:center;margin:24px 0">
        <a href="${allowUrl}" style="display:inline-block;background:#2e7d32;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:600;margin:0 6px">✅ Allow</a>
        <a href="${denyUrl}" style="display:inline-block;background:#c62828;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:600;margin:0 6px">❌ Deny</a>
      </div>
      <p style="color:#888;font-size:0.85rem">These links expire in 48 hours.</p>
    </div>
  `;
  return sendEmail({ to: businessEmail, subject, html: emailShell(body) });
}

/* ======================================================================
   ORDER EMAILS (existing, unchanged behavior)
====================================================================== */

// Send order confirmation to customer
async function sendOrderConfirmation({ customerEmail, customerName, orderId, items, total, paymentMethod, currency }) {
  const cur = (currency === 'AED' || !currency) ? 'AED' : (currency || 'AED');
  const shortId = (orderId && orderId.slice) ? orderId.slice(-6).toUpperCase() : '';
  const subject = `✅ Order Confirmed — BIN SALEH Store #${shortId || ''}`;
  const itemsHtml = (items || []).map(item =>
    `<tr><td style="padding:8px;border-bottom:1px solid #eee">${item.name || 'Product'} x${item.quantity || 1}</td><td style="padding:8px;border-bottom:1px solid #eee;text-align:right">${cur} ${((item.price || 0) * (item.quantity || 1)).toLocaleString()}</td></tr>`
  ).join('');

  const body = `
    <div style="padding:24px 0">
      <h2 style="color:#111;margin:0 0 8px">Thank you for your order, ${customerName || 'Valued Customer'}!</h2>
      <p style="color:#555;line-height:1.6">Your order <strong>#${shortId}</strong> has been placed successfully and is now being processed.</p>
      <div style="background:#f9f9f9;border-radius:10px;padding:16px;margin:16px 0">
        <table style="width:100%;border-collapse:collapse">
          <thead><tr><th style="text-align:left;padding:8px;border-bottom:2px solid #b8860b;color:#b8860b">Item</th><th style="text-align:right;padding:8px;border-bottom:2px solid #b8860b;color:#b8860b">Total</th></tr></thead>
          <tbody>${itemsHtml}</tbody>
          <tfoot>
            <tr><td style="padding:10px 8px;border-top:2px solid #111;font-weight:700">Total</td><td style="padding:10px 8px;border-top:2px solid #111;font-weight:700;text-align:right">${cur} ${(total || 0).toLocaleString()}</td></tr>
          </tfoot>
        </table>
        <p style="margin:12px 0 0;color:#666;font-size:0.85rem"><strong>Payment:</strong> ${paymentMethodLabel(paymentMethod)}</p>
      </div>
      <p style="color:#888;font-size:0.85rem;line-height:1.6">We'll notify you when your order ships. For any questions, reply to this email or contact us on WhatsApp at +9710566551046.</p>
    </div>
  `;

  return sendEmail({ to: customerEmail, subject, html: emailShell(body) });
}

// Send admin notification about new order
async function sendAdminNewOrderNotification({ orderId, customerName, customerContact, total, paymentMethod }) {
  const businessEmail = await getBusinessEmail();
  const shortId = (orderId && orderId.slice) ? orderId.slice(-6).toUpperCase() : '';
  const subject = `🆕 New Order #${shortId || ''} — BIN SALEH Store`;

  const body = `
    <div style="padding:20px 0">
      <div style="background:#b8860b;color:#fff;padding:16px 24px;border-radius:10px;text-align:center">
        <h2 style="margin:0;font-family:'Bebas Neue';letter-spacing:2px">NEW ORDER RECEIVED</h2>
      </div>
      <div style="padding:20px 0">
        <p style="color:#111;font-size:1.1rem;font-weight:600">Order #${shortId}</p>
        <div style="background:#f9f9f9;border-radius:10px;padding:16px;margin:12px 0">
          <p><strong>Customer:</strong> ${customerName || 'N/A'}</p>
          <p><strong>Contact:</strong> ${customerContact || 'N/A'}</p>
          <p><strong>Total:</strong> AED ${(total || 0).toLocaleString()}</p>
          <p><strong>Payment:</strong> ${paymentMethodLabel(paymentMethod)}</p>
        </div>
        <p style="color:#888;font-size:0.85rem">Login to the Admin Panel to view and process this order.</p>
      </div>
    </div>
  `;

  return sendEmail({ to: businessEmail, subject, html: emailShell(body) });
}

/* ======================================================================
   INVENTORY / ORDER TRACKING / INVOICE / REVIEW EMAILS
====================================================================== */

// Low-stock alert to the store owner (#2)
async function sendLowStockAlert({ productName, productId, stock, threshold }) {
  const businessEmail = await getBusinessEmail();
  const subject = `⚠️ LOW STOCK — ${productName || 'Product'} (${stock} left)`;
  const body = `
    <div style="padding:24px 0">
      <div style="background:#c62828;color:#fff;padding:16px 24px;border-radius:10px;text-align:center;margin-bottom:20px">
        <h2 style="margin:0;font-family:'Bebas Neue';letter-spacing:2px">LOW STOCK ALERT</h2>
      </div>
      <p style="color:#555;line-height:1.6">A product has reached its low-stock threshold:</p>
      <table style="width:100%;border-collapse:collapse;background:#f9f9f9;border-radius:10px;margin:16px 0">
        <tbody>
          <tr><td style="padding:8px 12px;color:#888">Product Name</td><td style="padding:8px 12px;font-weight:600">${productName || 'N/A'}</td></tr>
          <tr><td style="padding:8px 12px;color:#888">Product ID</td><td style="padding:8px 12px">${productId || 'N/A'}</td></tr>
          <tr><td style="padding:8px 12px;color:#888">Current Stock</td><td style="padding:8px 12px;color:#c62828;font-weight:700">${stock}</td></tr>
          <tr><td style="padding:8px 12px;color:#888">Threshold</td><td style="padding:8px 12px">${threshold}</td></tr>
          <tr><td style="padding:8px 12px;color:#888">Date & Time</td><td style="padding:8px 12px">${new Date().toLocaleString()}</td></tr>
        </tbody>
      </table>
      <p style="color:#888;font-size:0.85rem">Login to the Admin Panel → Products to restock this item.</p>
    </div>
  `;
  return sendEmail({ to: businessEmail, subject, html: emailShell(body) });
}

// Order tracking status-change email (#13)
async function sendOrderStatusEmail({ customerEmail, customerName, orderId, status, trackingNumber, extra }) {
  const statusLabel = (s) => ({
    pending: 'Pending', confirmed: 'Confirmed', processing: 'Processing', packed: 'Packed',
    shipped: 'Shipped', out_for_delivery: 'Out for Delivery', delivered: 'Delivered',
    cancelled: 'Cancelled', refunded: 'Refunded'
  }[s] || s || '');
  const shortId = (orderId && orderId.slice) ? orderId.slice(-6).toUpperCase() : '';
  const subject = `📦 Order #${shortId} ${statusLabel(status)} — BIN SALEH Store`;
  const body = `
    <div style="padding:24px 0">
      <h2 style="color:#111;margin:0 0 8px">Your order is ${statusLabel(status).toLowerCase()}</h2>
      <p style="color:#555;line-height:1.6">Hi ${customerName || 'Valued Customer'}, your order <strong>#${shortId}</strong> status has been updated to <strong>${statusLabel(status)}</strong>.</p>
      <div style="background:#f9f9f9;border-radius:10px;padding:16px;margin:16px 0">
        ${trackingNumber ? `<p style="margin:4px 0"><strong>Tracking Number:</strong> ${trackingNumber}</p>` : ''}
        ${extra ? `<p style="margin:4px 0">${extra}</p>` : ''}
        <p style="margin:4px 0;color:#888;font-size:0.85rem">Updated: ${new Date().toLocaleString()}</p>
      </div>
      <p style="color:#888;font-size:0.85rem">You can track your order anytime in your account. Thank you for shopping with BIN SALEH!</p>
    </div>
  `;
  return sendEmail({ to: customerEmail, subject, html: emailShell(body) });
}

// Invoice email with a PDF attachment (#7)
async function sendInvoiceEmail({ customerEmail, customerName, subject, html, attachment }) {
  try {
    const transporter = await createTransporter();
    const businessEmail = await getBusinessEmail();
    const storeName = await getStoreName();
    const mailOptions = {
      from: `"${storeName}" <${businessEmail}>`,
      to: customerEmail,
      subject: subject || `🧾 Invoice — BIN SALEH Store`,
      html: html || emailShell('<p>Your invoice is attached.</p>')
    };
    if (attachment) mailOptions.attachments = [attachment];
    const info = await transporter.sendMail(mailOptions);
    console.log(`📧 Invoice email sent to ${customerEmail}: ${info.messageId}`);
    return { success: true, messageId: info.messageId };
  } catch (err) {
    console.error('📧 Invoice email send failed:', err.message);
    return { success: false, error: err.message };
  }
}

// Admin notification when a new review arrives (#10)
async function sendReviewNotification({ productName, reviewerName, rating, text }) {
  const businessEmail = await getBusinessEmail();
  const subject = `⭐ New Review (${rating}/5) — ${productName || 'Product'}`;
  const body = `
    <div style="padding:24px 0">
      <div style="background:#b8860b;color:#fff;padding:16px 24px;border-radius:10px;text-align:center;margin-bottom:20px">
        <h2 style="margin:0;font-family:'Bebas Neue';letter-spacing:2px">NEW REVIEW RECEIVED</h2>
      </div>
      <div style="background:#f9f9f9;border-radius:10px;padding:16px;margin:12px 0">
        <p><strong>Product:</strong> ${productName || 'N/A'}</p>
        <p><strong>Reviewer:</strong> ${reviewerName || 'Anonymous'}</p>
        <p><strong>Rating:</strong> {'★'.repeat(Math.max(0, Number(rating) || 0)) + '☆'.repeat(Math.max(0, 5 - (Number(rating) || 0)))}</p>
        <p style="color:#555;font-style:italic">"${text || ''}"</p>
      </div>
      <p style="color:#888;font-size:0.85rem">Login to the Admin Panel → Reviews to approve or reject this review.</p>
    </div>
  `;
  return sendEmail({ to: businessEmail, subject, html: emailShell(body) });
}

// Send welcome email on registration
async function sendWelcomeEmail({ email, name }) {
  const subject = '🎉 Welcome to BIN SALEH Store!';
  const body = `
    <div style="padding:24px 0">
      <h2 style="color:#111">Welcome, ${name || 'Valued Customer'}! 🎉</h2>
      <p style="color:#555;line-height:1.6">Thank you for creating an account with BIN SALEH Store. You now have access to:</p>
      <ul style="color:#555;line-height:2">
        <li>🌟 Easy order tracking</li>
        <li>💳 Faster checkout</li>
        <li>🎁 Exclusive offers and updates</li>
      </ul>
      <p style="color:#888;font-size:0.85rem">Start exploring our latest collection!</p>
      <div style="text-align:center;margin:20px 0">
        <a href="https://binsalehstore.com/viewall.html" style="display:inline-block;background:#b8860b;color:#fff;padding:12px 28px;border-radius:8px;text-decoration:none;font-weight:600">Shop Now</a>
      </div>
    </div>
  `;

  return sendEmail({ to: email, subject, html: emailShell(body) });
}

// Send newsletter subscription confirmation
async function sendNewsletterConfirmation({ email }) {
  const subject = '✅ Subscribed — BIN SALEH Store Newsletter';
  const body = `
    <div style="padding:24px 0">
      <h2 style="color:#111">You're subscribed! 📬</h2>
      <p style="color:#555;line-height:1.6">You've been successfully subscribed to the BIN SALEH Store newsletter. We'll send you updates on new arrivals, exclusive offers, and more.</p>
      <p style="color:#888;font-size:0.85rem">Stay tuned for exciting updates!</p>
    </div>
  `;

  return sendEmail({ to: email, subject, html: emailShell(body) });
}

module.exports = {
  sendEmail,
  sendOrderConfirmation,
  sendAdminNewOrderNotification,
  sendWelcomeEmail,
  sendNewsletterConfirmation,
  getBusinessEmail,
  // Security emails
  sendEmailVerification,
  sendLoginNotification,
  sendPasswordChanged,
  sendEmailChanged,
  send2FAStatus,
  sendFailedLoginAlert,
  sendAccountLocked,
  sendAccountSecured,
  sendAdminSecurityAlert,
  sendAdminApprovalEmail,
  // Inventory / tracking / invoice / review emails
  sendLowStockAlert,
  sendOrderStatusEmail,
  sendInvoiceEmail,
  sendReviewNotification
};
