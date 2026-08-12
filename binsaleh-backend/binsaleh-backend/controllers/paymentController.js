// controllers/paymentController.js
// PayPal Payment Gateway Integration
// Uses the PayPal REST API v2 (no SDK needed — uses native Node.js https)
// PayPal client ID and secret can be configured via:
//   - Admin Panel > Payments > PayPal (stored in DB payment_settings)
//   - Environment variables: PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET, PAYPAL_MODE

const https = require('https');
const Settings = require('../models/Settings');
const Order = require('../models/Order');
const Notification = require('../models/Notification');
const PaymentService = require('../services/paymentService');
const { sendOrderConfirmation, sendAdminNewOrderNotification } = require('../services/emailService');
const { decrementStockForOrder, validateStockForOrder, restoreStockForOrder } = require('../services/stockService');
const { emit } = require('../services/realtime');
const { log } = require('../services/auditService');

// Load PayPal credentials — try DB settings first, fall back to env vars
async function loadPayPalCredentials() {
  try {
    const setting = await Settings.findOne({ key: 'payment_settings' });
    if (setting && setting.value) {
      const ps = typeof setting.value === 'string' ? JSON.parse(setting.value) : setting.value;
      const paypal = (ps.methods || []).find(m => m.id === 'paypal');
      if (paypal && paypal.config && paypal.config.clientId && paypal.config.clientSecret) {
        return {
          clientId: paypal.config.clientId,
          clientSecret: paypal.config.clientSecret,
          mode: paypal.config.mode || 'sandbox'
        };
      }
    }
  } catch (e) {
    // DB not available — fall through to env vars
  }
  return {
    clientId: process.env.PAYPAL_CLIENT_ID || '',
    clientSecret: process.env.PAYPAL_CLIENT_SECRET || '',
    mode: process.env.PAYPAL_MODE || 'sandbox'
  };
}

// Get PayPal access token using client credentials
async function getPayPalAccessToken() {
  const creds = await loadPayPalCredentials();

  if (!creds.clientId || !creds.clientSecret) {
    throw new Error('PayPal credentials not configured. Set them in Admin Panel > Payments > PayPal or via PAYPAL_CLIENT_ID/PAYPAL_CLIENT_SECRET env vars.');
  }

  const base64Auth = Buffer.from(creds.clientId + ':' + creds.clientSecret).toString('base64');
  const isSandbox = creds.mode !== 'live';
  const apiHost = isSandbox ? 'api-m.sandbox.paypal.com' : 'api-m.paypal.com';

  return new Promise((resolve, reject) => {
    const postData = 'grant_type=client_credentials';
    const options = {
      hostname: apiHost,
      port: 443,
      path: '/v1/oauth2/token',
      method: 'POST',
      headers: {
        'Authorization': 'Basic ' + base64Auth,
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(postData)
      }
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.access_token) {
            resolve(parsed.access_token);
          } else {
            reject(new Error(parsed.error_description || 'Failed to get PayPal token'));
          }
        } catch (e) {
          reject(new Error('Failed to parse PayPal token response'));
        }
      });
    });

    req.on('error', reject);
    req.write(postData);
    req.end();
  });
}

// Make a PayPal REST API request
async function payPalRequest(method, path, body = null, accessToken) {
  const creds = await loadPayPalCredentials();
  const isSandbox = creds.mode !== 'live';
  const apiHost = isSandbox ? 'api-m.sandbox.paypal.com' : 'api-m.paypal.com';

  return new Promise((resolve, reject) => {
    const postData = body ? JSON.stringify(body) : null;
    const options = {
      hostname: apiHost,
      port: 443,
      path: '/v2' + path,
      method: method,
      headers: {
        'Authorization': 'Bearer ' + accessToken,
        'Content-Type': 'application/json'
      }
    };
    if (postData) {
      options.headers['Content-Length'] = Buffer.byteLength(postData);
    }

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve(parsed);
          } else {
            reject(new Error(parsed.message || parsed.error_description || 'PayPal API error: ' + res.statusCode));
          }
        } catch (e) {
          reject(new Error('Failed to parse PayPal response'));
        }
      });
    });

    req.on('error', reject);
    if (postData) req.write(postData);
    req.end();
  });
}

// POST /api/payments/create-paypal-order
// Creates a PayPal order with the given amount
exports.createPayPalOrder = async (req, res) => {
  try {
    const { amount, currency, description } = req.body;

    if (!amount || amount <= 0) {
      return res.status(400).json({ message: 'Invalid payment amount' });
    }

    const accessToken = await getPayPalAccessToken();

    const orderData = {
      intent: 'CAPTURE',
      purchase_units: [{
        amount: {
          currency_code: currency || 'PKR',
          value: amount.toFixed(2)
        },
        description: description || 'BIN SALEH Store Order'
      }]
    };

    const order = await payPalRequest('POST', '/checkout/orders', orderData, accessToken);

    res.json({
      orderId: order.id,
      status: order.status
    });
  } catch (err) {
    console.error('PayPal create order error:', err.message);
    res.status(400).json({ message: err.message || 'Failed to create PayPal order' });
  }
};

// POST /api/payments/capture-paypal-order
// Captures a PayPal order after buyer approval
exports.capturePayPalOrder = async (req, res) => {
  try {
    const { orderId } = req.body;

    if (!orderId) {
      return res.status(400).json({ message: 'Missing PayPal order ID' });
    }

    const accessToken = await getPayPalAccessToken();
    const capture = await payPalRequest('POST', '/checkout/orders/' + orderId + '/capture', {}, accessToken);

    // Check if capture was successful
    if (capture.status === 'COMPLETED') {
      const captureDetails = capture.purchase_units[0].payments.captures[0];
      res.json({
        status: 'COMPLETED',
        transactionId: captureDetails.id,
        paidAmount: parseFloat(captureDetails.amount.value),
        currency: captureDetails.amount.currency_code,
        paidAt: captureDetails.create_time,
        payerEmail: capture.payer?.email_address || '',
        payerName: capture.payer?.name?.given_name + ' ' + capture.payer?.name?.surname || ''
      });
    } else {
      res.json({
        status: capture.status,
        transactionId: capture.id || '',
        message: 'Payment ' + capture.status
      });
    }
  } catch (err) {
    console.error('PayPal capture error:', err.message);
    res.status(400).json({ message: err.message || 'Failed to capture PayPal order' });
  }
};

// GET /api/payments/config
// Returns payment gateway config for the frontend SDK
// Loads PayPal client ID from DB settings (with env var fallback)
exports.getConfig = async (req, res) => {
  try {
    const creds = await loadPayPalCredentials();
    const zeina = await loadZeinaCredentials();
    res.json({
      paypalClientId: creds.clientId,
      paypalMode: creds.mode,
      zeinaConfigured: !!zeina.accessToken
    });
  } catch (err) {
    res.json({
      paypalClientId: process.env.PAYPAL_CLIENT_ID || '',
      paypalMode: process.env.PAYPAL_MODE || 'sandbox',
      zeinaConfigured: !!(process.env.ZIINA_ACCESS_TOKEN)
    });
  }
};

/* =====================================================================
   ZEINA (Ziina) PAYMENT GATEWAY
   ---------------------------------------------------------------------
   Ziina is a UAE payment gateway (docs.ziina.com).
   Flow:
     1. Frontend calls POST /api/payments/create-zeina-payment
     2. Backend creates a Payment Intent -> returns { id, redirect_url }
     3. Frontend redirects the customer to redirect_url (Ziina hosted page)
     4. Ziina redirects back to success_url/cancel_url with {PAYMENT_INTENT_ID}
     5. Frontend calls GET /api/payments/zeina-payment/:id to check status
     6. Only if status === 'completed' is the order created (#3)
   Credentials: configured via payment_settings.zeina.config.accessToken
   or env ZIINA_ACCESS_TOKEN / ZIINA_MODE (test | live).
===================================================================== */

const ZIINA_API_HOST = 'api.ziina.com';
const ZIINA_API_BASE = '/api/v2';

// Load Zeina credentials — DB settings first, then env fallback
async function loadZeinaCredentials() {
  try {
    const setting = await Settings.findOne({ key: 'payment_settings' });
    if (setting && setting.value) {
      const ps = typeof setting.value === 'string' ? JSON.parse(setting.value) : setting.value;
      const zeina = (ps.methods || []).find(m => m.id === 'zeina');
      if (zeina && zeina.config && zeina.config.accessToken) {
        return {
          accessToken: zeina.config.accessToken,
          mode: zeina.config.mode || 'test'
        };
      }
    }
  } catch (e) {
    // DB not available — fall through to env vars
  }
  return {
    accessToken: process.env.ZIINA_ACCESS_TOKEN || '',
    mode: process.env.ZIINA_MODE || 'test'
  };
}

// Generic Ziina API request
function zeinaRequest(method, path, body = null, accessToken) {
  return new Promise((resolve, reject) => {
    const postData = body ? JSON.stringify(body) : null;
    const options = {
      hostname: ZIINA_API_HOST,
      port: 443,
      path: ZIINA_API_BASE + path,
      method: method,
      headers: {
        'Authorization': 'Bearer ' + accessToken,
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      }
    };
    if (postData) {
      options.headers['Content-Length'] = Buffer.byteLength(postData);
    }

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        let parsed;
        try {
          parsed = data ? JSON.parse(data) : {};
        } catch (e) {
          return reject(new Error('Failed to parse Zeina response'));
        }
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve(parsed);
        } else {
          reject(new Error(parsed.error || parsed.message || 'Zeina API error: ' + res.statusCode));
        }
      });
    });

    req.on('error', reject);
    if (postData) req.write(postData);
    req.end();
  });
}

// POST /api/payments/create-zeina-payment
// Creates a Ziina Payment Intent. Amount is in AED (major units) — converted to fils.
exports.createZeinaPayment = async (req, res) => {
  try {
    const { amount, description, successUrl, cancelUrl, metadata } = req.body;

    if (!amount || amount <= 0) {
      return res.status(400).json({ message: 'Invalid payment amount' });
    }

    const creds = await loadZeinaCredentials();
    if (!creds.accessToken) {
      return res.status(400).json({ message: 'Zeina is not configured. Set the access token in Admin Panel > Payments > Zeina.' });
    }

    // Amount must be in fils (1 AED = 100 fils)
    const amountFils = Math.round(Number(amount) * 100);

    const body = {
      amount: amountFils,
      currency: 'AED',
      success_url: successUrl || 'https://example.com/success?payment_intent={PAYMENT_INTENT_ID}',
      cancel_url: cancelUrl || 'https://example.com/cancel?payment_intent={PAYMENT_INTENT_ID}',
      test: creds.mode !== 'live'
    };
    if (description) body.description = String(description).slice(0, 120);
    if (metadata && typeof metadata === 'object') body.metadata = metadata;

    const intent = await zeinaRequest('POST', '/payment_intent', body, creds.accessToken);

    if (!intent.id || !intent.redirect_url) {
      return res.status(400).json({ message: 'Zeina did not return a payment link. Response: ' + JSON.stringify(intent).slice(0, 300) });
    }

    res.json({
      id: intent.id,
      redirectUrl: intent.redirect_url,
      status: intent.status || 'requires_payment_instrument'
    });
  } catch (err) {
    console.error('Zeina create payment error:', err.message);
    res.status(400).json({ message: err.message || 'Failed to create Zeina payment' });
  }
};

/* ------------------------------------------------------------------
   SERVER-SIDE PAYMENT VERIFICATION (#1)
   When the frontend claims an order was paid via a gateway, the backend
   re-verifies with the gateway's API before recording paymentStatus='paid'.
   This prevents a malicious client from POSTing paymentStatus='paid' with
   fake details (payment bypass).
------------------------------------------------------------------ */
exports.verifyGatewayPayment = async (method, transactionId) => {
  if (!transactionId) return { verified: false, reason: 'missing transaction id' };

  if (method === 'zeina') {
    const creds = await loadZeinaCredentials();
    if (!creds.accessToken) return { verified: false, reason: 'zeina not configured' };
    const intent = await zeinaRequest('GET', '/payment_intent/' + encodeURIComponent(transactionId), null, creds.accessToken);
    const completed = intent.status === 'completed';
    return {
      verified: completed,
      reason: completed ? 'ok' : ('zeina status: ' + (intent.status || 'unknown')),
      paidAmount: completed && intent.amount ? Number(intent.amount) / 100 : 0,
      currency: 'AED',
      transactionId
    };
  }

  if (method === 'paypal') {
    const accessToken = await getPayPalAccessToken();
    // The frontend posts the CAPTURE id returned by capturePayPalOrder
    // (captureDetails.id), so verify against the captures endpoint first.
    // Fall back to the checkout order endpoint for order ids.
    let order = null;
    try {
      order = await payPalRequest('GET', '/payments/captures/' + encodeURIComponent(transactionId), null, accessToken);
    } catch (e) {
      try {
        order = await payPalRequest('GET', '/checkout/orders/' + encodeURIComponent(transactionId), null, accessToken);
      } catch (e2) {
        return { verified: false, reason: 'paypal lookup failed for ' + transactionId };
      }
    }
    const completed = order.status === 'COMPLETED';
    let paidAmount = 0;
    let currency = 'USD';
    if (completed) {
      if (order.amount) { // captures endpoint shape
        paidAmount = parseFloat(order.amount.value) || 0;
        currency = order.amount.currency_code || 'USD';
      } else if (order.purchase_units && order.purchase_units[0]) { // order endpoint shape
        const captures = order.purchase_units[0].payments && order.purchase_units[0].payments.captures;
        if (captures && captures.length) {
          paidAmount = parseFloat(captures[0].amount.value) || 0;
          currency = captures[0].amount.currency_code || 'USD';
        }
      }
    }
    return {
      verified: completed,
      reason: completed ? 'ok' : ('paypal status: ' + (order.status || 'unknown')),
      paidAmount,
      currency,
      transactionId
    };
  }

  return { verified: false, reason: 'unsupported method' };
};

// GET /api/payments/zeina-payment/:id
// Fetches a Payment Intent's status so the frontend can confirm before creating the order
exports.getZeinaPayment = async (req, res) => {
  try {
    const { id } = req.params;
    if (!id) {
      return res.status(400).json({ message: 'Missing Zeina payment intent ID' });
    }

    const creds = await loadZeinaCredentials();
    if (!creds.accessToken) {
      return res.status(400).json({ message: 'Zeina is not configured.' });
    }

    const intent = await zeinaRequest('GET', '/payment_intent/' + encodeURIComponent(id), null, creds.accessToken);

    const completed = intent.status === 'completed';
    res.json({
      status: intent.status || 'unknown',
      completed: completed,
      failed: intent.status === 'failed',
      cancelled: intent.status === 'cancelled' || intent.status === 'canceled',
      latestError: intent.latest_error || null,
      // Standardized capture info for order creation
      paymentDetails: completed ? {
        transactionId: intent.id || id,
        paidAmount: intent.amount ? Number(intent.amount) / 100 : 0,
        currency: 'AED',
        paidAt: intent.updated_at || new Date().toISOString()
      } : null
    });
  } catch (err) {
    console.error('Zeina status error:', err.message);
    res.status(400).json({ message: err.message || 'Failed to fetch Zeina payment status' });
  }
};

/* =====================================================================
   BANK-APP / BANK-TRANSFER PAYMENT (temporary payment system)
   ---------------------------------------------------------------------
   Flow:
     1. Customer reviews the order and clicks "Pay Online".
     2. POST /api/payments/bank-app/initiate — the backend computes the
        AUTHORITATIVE total (items × price + shipping − coupon) server-side,
        creates the order with paymentStatus='pending' and a payment
        reference, then returns the seller's bank details + exact amount.
     3. Customer pays from their banking app (official payment link when the
        admin configured one, otherwise the fallback instructions screen).
     4. GET /api/payments/bank-app/:orderId — status check on return.
     5. POST /api/payments/bank-app/confirm — "I have completed payment".
        The backend NEVER marks a manual transfer 'paid' from this click;
        paymentStatus stays PENDING until the admin verifies the transfer.
===================================================================== */

/* =====================================================================
   UAE ONLINE PAYMENTS (multi-provider)
   ---------------------------------------------------------------------
   "Pay Online" is driven entirely by the backend: GET /api/payments/options
   lists only the enabled providers with valid official credentials. Amounts
   are ALWAYS computed server-side (DB prices x qty + shipping - coupon).
   Payment is only recorded PAID after server-side verification with the
   provider's official API (or admin confirmation for manual transfers).
===================================================================== */

// ---------- shared helpers ----------

// Validate the checkout payload, compute AUTHORITATIVE totals and create the
// order with paymentStatus='pending'. Returns { orderData, rawSubtotal, total,
// shippingCost, couponInfo, fname, contact, phone, recent }. Throws
// { statusCode, message } on invalid input — a client can never influence
// the amount or the payment status.
async function preparePendingOrder(body, method, reqUser) {
  const items = Array.isArray(body.items) ? body.items : [];
  const contact = String(body.contact || '').trim();
  const shippingAddress = body.shippingAddress || {};

  if (!items.length) throw Object.assign(new Error('Order must have at least one item'), { statusCode: 400 });
  if (!contact) throw Object.assign(new Error('Please provide a contact number or email'), { statusCode: 400 });
  const fname = String(shippingAddress.firstName || '').trim();
  const address = String(shippingAddress.address || '').trim();
  const city = String(shippingAddress.city || '').trim();
  const phone = String(shippingAddress.phone || '').trim();
  if (!fname || !address || !city || !phone) {
    throw Object.assign(new Error('Please fill in your full delivery address'), { statusCode: 400 });
  }

  // Authoritative item prices from the catalog where available (fall back to
  // the submitted price only for products that don't exist in the DB yet).
  const Product = require('../models/Product');
  const authoritativeItems = [];
  for (const it of items) {
    let price = Number(it.price) || 0;
    if (it.productId) {
      try {
        const dbProd = await Product.findById(it.productId).lean().select('price');
        if (dbProd && dbProd.price !== undefined && dbProd.price !== null) price = Number(dbProd.price) || 0;
      } catch (e) { /* fall back to submitted price */ }
    }
    authoritativeItems.push({
      productId: it.productId || null,
      name: String(it.name || 'Product'),
      price,
      quantity: Math.max(1, Number(it.quantity) || 1),
      color: it.color || '',
      image: it.image || ''
    });
  }
  const rawSubtotal = authoritativeItems.reduce((s, it) => s + it.price * it.quantity, 0);

  // Shipping fee from settings — never from the client.
  const shipSettingDoc = await Settings.findOne({ key: 'shipping_settings' });
  let shippingSettings = { standardFee: 200, expressFee: 400, freeThreshold: 10000 };
  if (shipSettingDoc && shipSettingDoc.value) {
    const sv = typeof shipSettingDoc.value === 'string' ? JSON.parse(shipSettingDoc.value) : shipSettingDoc.value;
    shippingSettings = { ...shippingSettings, ...(sv || {}) };
  }
  const shippingMethod = ['free', 'express'].includes(body.shippingMethod) ? body.shippingMethod : 'standard';
  const shippingCost = shippingMethod === 'free' ? 0
    : shippingMethod === 'express' ? (Number(shippingSettings.expressFee) || 0)
    : (Number(shippingSettings.standardFee) || 0);

  // Coupon — validated server-side, discount applied to the total.
  let couponInfo = null;
  if (body.coupon && body.coupon.code) {
    try {
      const { validateCoupon } = require('./couponController');
      let vResult = null;
      await validateCoupon(
        { body: { code: body.coupon.code, subtotal: rawSubtotal, customerEmail: contact.includes('@') ? contact : null } },
        { json: (d) => { vResult = d; }, status: () => ({ json: (d) => { vResult = d; } }) }
      );
      if (vResult && vResult.valid) {
        couponInfo = { code: vResult.code, type: vResult.type, discount: vResult.discount, discountAmount: vResult.discountAmount };
      }
    } catch (e) {
      console.warn('⚠️ Coupon validate failed:', e.message);
    }
  }
  const couponDiscount = couponInfo ? (Number(couponInfo.discountAmount) || 0) : 0;
  const total = Math.max(0, rawSubtotal + shippingCost - couponDiscount);

  // Stock availability check — reject BEFORE creating the order.
  const stockCheck = await validateStockForOrder(authoritativeItems);
  if (!stockCheck.ok) {
    throw Object.assign(new Error('Some items are out of stock or exceed available quantity: ' + stockCheck.shortages.join(', ')), { statusCode: 400 });
  }

  // Idempotency: resume a recent pending order for the same contact+phone+method.
  const recent = await Order.findOne({
    paymentMethod: method,
    contact,
    'shippingAddress.phone': phone,
    paymentStatus: 'pending',
    createdAt: { $gte: new Date(Date.now() - 15 * 60 * 1000) }
  }).sort({ createdAt: -1 });

  const ps = await PaymentService.getPaymentSettings();
  const orderData = {
    user: reqUser ? reqUser.id : null,
    items: authoritativeItems,
    contact,
    shippingAddress: {
      country: shippingAddress.country || 'Pakistan',
      firstName: fname,
      lastName: String(shippingAddress.lastName || '').trim(),
      address,
      apartment: String(shippingAddress.apartment || '').trim(),
      city,
      postal: String(shippingAddress.postal || '').trim(),
      phone
    },
    shippingMethod,
    shippingCost,
    paymentMethod: method,
    paymentStatus: 'pending',
    subtotal: rawSubtotal,
    total,
    currency: body.currency || ps.currency || 'AED',
    advanceRequired: 0,
    advancePaid: 0,
    remainingAmount: total,
    awaitingVerification: false
  };
  if (couponInfo) orderData.coupon = couponInfo;

  // Resume only if the pending request matches the current total exactly —
  // a changed cart must never reuse a stale amount.
  const reusable = recent && Number(recent.total) === Number(total) ? recent : null;
  return { orderData, rawSubtotal, total, shippingCost, couponInfo, fname, contact, phone, recent: reusable };
}

// Side effects shared by every online order: reference, coupon consumption,
// stock, notifications, real-time events and emails.
async function finalizePendingOrder(order, opts) {
  const { contact, fname, couponInfo, rawSubtotal, notes } = opts;
  order.paymentReference = order.paymentReference || PaymentService.generatePaymentReference(order._id);
  order.paymentDetails = order.paymentDetails || {};
  order.paymentDetails.transactionId = order.paymentDetails.transactionId || '';
  order.paymentDetails.paidAmount = 0;
  order.paymentDetails.paidAt = null;
  order.paymentDetails.confirmedBy = contact;
  order.paymentDetails.notes = notes || 'Payment initiated — awaiting provider verification';
  await order.save();

  if (couponInfo) {
    try {
      const { applyCoupon } = require('./couponController');
      await applyCoupon(
        { body: { code: couponInfo.code, subtotal: rawSubtotal, customerEmail: contact.includes('@') ? contact : null } },
        { json: () => {}, status: () => ({ json: () => {} }) }
      );
      await log({
        category: 'coupon',
        action: 'Coupon applied to order',
        details: { orderId: String(order._id), code: couponInfo.code, discountAmount: couponInfo.discountAmount },
        actor: contact || 'guest'
      });
    } catch (e) {
      console.warn('⚠️ Coupon consumption failed:', e.message);
    }
  }

  decrementStockForOrder(order.items).then(r => {
    if (r && !r.ok) console.warn('⚠️ Some items were out of stock:', r.shortages);
  }).catch(e => console.warn('⚠️ Stock decrement failed:', e.message));

  const shortId = String(order._id).slice(-6).toUpperCase();
  Notification.create({
    type: 'new_order',
    title: '🆕 New Order #' + shortId,
    message: (fname || 'Customer') + ' — ' + (order.currency || 'AED') + ' ' + (order.total || 0).toLocaleString(),
    refType: 'order',
    refId: String(order._id)
  }).catch(() => {});
  emit('new_order', { orderId: String(order._id), total: order.total, shortId });
  emit('notification', { type: 'new_order' });
  emit('revenue_change', { total: order.total });
  if (order.user) emit('new_customer', { userId: String(order.user) });

  const customerEmail = contact && contact.includes('@') ? contact : null;
  if (customerEmail) {
    sendOrderConfirmation({
      customerEmail, customerName: fname, orderId: order._id.toString(), items: order.items,
      total: order.total, paymentMethod: order.paymentMethod, currency: order.currency || 'AED'
    }).catch(() => {});
  }
  sendAdminNewOrderNotification({
    orderId: order._id.toString(), customerName: fname, customerContact: contact,
    total: order.total, paymentMethod: order.paymentMethod
  }).catch(() => {});
}

// Build provider success/cancel/callback URLs. Redirect targets are the
// customer's own page (http(s) only); the webhook URL points back at us.
function buildPaymentUrls(req, orderId) {
  const clientBase = String((req.body && req.body.returnUrl) || '').trim();
  const safeBase = PaymentService.sanitizePaymentLink(clientBase) || ('https://' + (req.get('host') || 'binsaleh.com'));
  const sep = safeBase.indexOf('?') > -1 ? '&' : '?';
  const apiBase = ((req.protocol || 'https') + '://' + (req.get('host') || 'api'));
  const method = String((req.body && req.body.method) || '').trim();
  return {
    successUrl: safeBase + sep + 'bs_pay_ref=' + orderId,
    cancelUrl: safeBase + sep + 'bs_pay_cancel=1',
    callbackUrl: apiBase + '/api/payments/webhook/' + encodeURIComponent(method)
  };
}

// GET /api/payments/providers/status
// Admin-only: status of every registered provider (enabled, configured,
// official URL, webhook support) so the admin can see at a glance which
// payment methods are genuinely live and which need merchant credentials.
exports.getProvidersStatus = async (req, res) => {
  try {
    const ps = await PaymentService.getPaymentSettings();
    const bankApp = await PaymentService.getBankAppSettings();
    const providers = [];

    // Bank App / Bank Transfer (manual ADIB fallback)
    const bankAppReady = !!bankApp.enabled && !!(bankApp.iban || bankApp.accountNumber);
    providers.push({
      id: 'bank_app',
      name: 'Bank App / Bank Transfer (ADIB)',
      type: 'manual',
      enabled: bankAppReady,
      apiConfigured: !!(bankApp.iban || bankApp.accountNumber),
      officialUrl: bankApp.paymentLinkUrl || '',
      webhookSupported: false,
      reason: bankAppReady ? '' : (bankApp.enabled ? 'IBAN/account number not set' : 'Disabled — enable in Payments → Bank App Payment')
    });

    const meta = {
      zeina:      { name: 'Ziina',        webhookSupported: false, note: 'Requires a Ziina access token (docs.ziina.com).' },
      paypal:     { name: 'PayPal',       webhookSupported: false, note: 'Requires PayPal REST client id + secret (business account).' },
      myfatoorah: { name: 'myFatoorah',   webhookSupported: true,  note: 'Requires a myFatoorah API token (merchant account).' },
      paytabs:    { name: 'PayTabs',      webhookSupported: true,  note: 'Requires PayTabs profile id + server key (merchant account).' },
      moyasar:    { name: 'Moyasar',      webhookSupported: true,  note: 'Requires a Moyasar secret key (merchant account).' }
    };
    for (const [id, m] of Object.entries(meta)) {
      const provider = PaymentService.getProvider(id);
      let configured = false;
      try { configured = await provider.isConfigured(ps); } catch (e) { /* not configured */ }
      providers.push({
        id,
        name: m.name,
        type: 'gateway',
        enabled: configured,
        apiConfigured: configured,
        officialUrl: '',
        webhookSupported: m.webhookSupported,
        reason: configured ? '' : 'Disabled — ' + m.note
      });
    }

    // Future slot — cards / Apple Pay / Google Pay
    providers.push({
      id: 'card',
      name: 'Card / Apple Pay / Google Pay',
      type: 'future',
      enabled: false,
      apiConfigured: false,
      officialUrl: '',
      webhookSupported: true,
      reason: 'Not available yet — reserved for a future card integration.'
    });

    res.json({
      onlineEnabled: !!ps.onlineEnabled,
      sellerName: ps.sellerName || 'BIN SALEH Store',
      currency: ps.currency || 'AED',
      providers
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// GET /api/payments/options
// Public: the "PAY ONLINE" screen is generated from this — only enabled
// providers with valid official credentials are listed.
exports.getPaymentOptions = async (req, res) => {
  try {
    const ps = await PaymentService.getPaymentSettings();
    const options = await PaymentService.getAvailableOptions();
    res.json({
      onlineEnabled: !!ps.onlineEnabled,
      sellerName: ps.sellerName || 'BIN SALEH Store',
      currency: ps.currency || 'AED',
      options
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// POST /api/payments/initiate
// Unified: create order (PENDING) + official payment request for the chosen
// provider. Never trusts client amounts or client payment status.
exports.initiatePayment = async (req, res) => {
  try {
    const body = req.body || {};
    const method = String(body.method || '').trim();
    const provider = PaymentService.getProvider(method);
    if (!provider || provider.type === 'future') {
      return res.status(400).json({ message: 'Unsupported payment method' });
    }
    const ps = await PaymentService.getPaymentSettings();
    if (!ps.onlineEnabled) {
      return res.status(400).json({ message: 'Online payment is currently disabled. Please contact the store.' });
    }
    if (method === 'bank_app') {
      const bankAppSettings = await PaymentService.getBankAppSettings();
      if (!bankAppSettings.enabled || (!bankAppSettings.iban && !bankAppSettings.accountNumber)) {
        return res.status(400).json({ message: 'Bank App payment is currently disabled or not configured.' });
      }
    } else if (!(await provider.isConfigured(ps))) {
      return res.status(400).json({ message: 'This payment method is not configured yet. Please choose another option.' });
    }

    const prepared = await preparePendingOrder(body, method, req.user);

    // Resume an existing recent pending payment instead of duplicating it.
    if (prepared.recent) {
      const req2 = await PaymentService.createPaymentRequest(method, prepared.recent, buildPaymentUrls(req, prepared.recent._id));
      if (req2.providerReference) {
        prepared.recent.providerReference = req2.providerReference;
        await prepared.recent.save();
      }
      return res.status(200).json({
        orderId: prepared.recent._id,
        orderNumber: String(prepared.recent._id).slice(-6).toUpperCase(),
        paymentReference: prepared.recent.paymentReference || req2.reference,
        amount: prepared.recent.total || 0,
        currency: prepared.recent.currency || 'AED',
        status: 'pending',
        verified: false,
        reused: true,
        ...(method === 'bank_app' ? { bankDetails: req2.bankDetails, paymentLinkUrl: req2.paymentLinkUrl, officialMechanism: req2.officialMechanism }
          : (req2.redirectUrl ? { redirectUrl: req2.redirectUrl }
            : (req2.paymentLinkUrl ? { paymentLinkUrl: req2.paymentLinkUrl, officialMechanism: req2.officialMechanism } : {}))),
        message: 'Payment request already exists — resume your payment.'
      });
    }

    const order = await Order.create(prepared.orderData);
    await finalizePendingOrder(order, {
      contact: prepared.contact, fname: prepared.fname, couponInfo: prepared.couponInfo,
      rawSubtotal: prepared.rawSubtotal, notes: 'Payment initiated via ' + provider.name + ' — awaiting provider verification'
    });

    const paymentRequest = await PaymentService.createPaymentRequest(method, order, buildPaymentUrls(req, order._id));
    if (paymentRequest.providerReference) {
      order.providerReference = paymentRequest.providerReference;
      await order.save();
    }

    const shortId = String(order._id).slice(-6).toUpperCase();
    const resp = {
      orderId: order._id,
      orderNumber: shortId,
      paymentReference: order.paymentReference,
      amount: order.total,
      currency: order.currency || 'AED',
      sellerName: ps.sellerName || 'BIN SALEH Store',
      status: 'pending',
      verified: false,
      provider: method,
      providerName: provider.name,
      type: provider.type
    };
    if (method === 'bank_app') {
      resp.bankDetails = paymentRequest.bankDetails;
      resp.paymentLinkUrl = paymentRequest.paymentLinkUrl;
      resp.officialMechanism = paymentRequest.officialMechanism;
      resp.message = 'Payment request created. Complete the transfer from your banking app.';
    } else if (paymentRequest.redirectUrl) {
      resp.redirectUrl = paymentRequest.redirectUrl;
      resp.message = 'Payment request created. You will be redirected to the payment provider.';
    } else if (paymentRequest.paymentLinkUrl) {
      // Some providers return a hosted link instead of a redirect.
      resp.paymentLinkUrl = paymentRequest.paymentLinkUrl;
      resp.officialMechanism = paymentRequest.officialMechanism;
      resp.message = 'Payment request created. Open the official payment link to complete payment.';
    } else {
      resp.message = 'Payment request created.';
    }
    res.status(201).json(resp);
  } catch (err) {
    const status = err.statusCode || 400;
    console.error('Payment initiate error (' + ((req.body && req.body.method) || '?') + '):', err.message);
    res.status(status).json({ message: err.message || 'Failed to create payment request' });
  }
};

// GET /api/payments/status/:orderId
// Authoritative status check when the customer returns. Never trusts
// frontend query parameters like ?payment=success.
exports.getPaymentStatus = async (req, res) => {
  try {
    const order = await Order.findById(req.params.orderId);
    if (!order || order.paymentMethod === 'cod') {
      return res.status(404).json({ message: 'Payment not found' });
    }

    // Age-based expiry: abandoned payment requests older than 48h transition
    // to 'expired' (requirement: PENDING / PAID / FAILED / CANCELLED / EXPIRED).
    let status = order.paymentStatus;
    if (status === 'pending') {
      const ageHrs = (Date.now() - new Date(order.createdAt).getTime()) / 3600000;
      if (ageHrs > 48) {
        await Order.findByIdAndUpdate(order._id, {
          $set: {
            paymentStatus: 'expired',
            awaitingVerification: false,
            'paymentDetails.notes': ((order.paymentDetails && order.paymentDetails.notes) ? order.paymentDetails.notes + ' | ' : '') + 'Payment request expired (48h without verification)'
          }
        });
        status = 'expired';
      }
    }

    // Only query the provider API while the payment is still pending —
    // confirmed or terminal states never re-trigger server-to-provider lookups.
    let verification = { verified: false, status, reason: '' };
    if (status === 'pending') {
      verification = await PaymentService.verifyPayment(order.paymentMethod, order);
      status = verification.status || status;
    }

    // Persist meaningful transitions (never downgrade a confirmed 'paid').
    const updates = {};
    if (order.paymentStatus !== 'paid' && ['paid', 'failed', 'cancelled', 'expired'].includes(status)) {
      updates.paymentStatus = status;
      if (status === 'paid') {
        updates.awaitingVerification = false;
        updates.advancePaid = order.total || 0;
        updates.remainingAmount = 0;
        updates['paymentDetails.paidAt'] = new Date();
        updates['paymentDetails.paidAmount'] = verification.paidAmount || order.total || 0;
        updates['paymentDetails.transactionId'] = verification.transactionId || order.providerReference || '';
        updates['paymentDetails.notes'] = 'Payment verified via ' + (order.paymentMethod || 'provider');
      }
    }
    if (verification.transactionId && !updates['paymentDetails.transactionId']) {
      updates['paymentDetails.transactionId'] = verification.transactionId;
    }

    let transitionedToPaid = false;
    if (Object.keys(updates).length) {
      const updated = await Order.findByIdAndUpdate(order._id, { $set: updates }, { new: true });
      transitionedToPaid = !!updated && updates.paymentStatus === 'paid' && order.paymentStatus !== 'paid';
      if (transitionedToPaid) {
        const shortId = String(updated._id).slice(-6).toUpperCase();
        Notification.create({
          type: 'payment_success', title: '✅ Payment Confirmed #' + shortId,
          message: (updated.currency || 'AED') + ' ' + (updated.total || 0).toLocaleString() + ' paid',
          refType: 'order', refId: String(updated._id)
        }).catch(() => {});
        emit('payment_success', { orderId: String(updated._id), amount: updated.total, shortId });
        emit('notification', { type: 'payment_success' });
        const customerEmail = updated.contact && updated.contact.includes('@') ? updated.contact : null;
        if (customerEmail) {
          sendOrderConfirmation({
            customerEmail, customerName: (updated.shippingAddress && updated.shippingAddress.firstName) || 'Valued Customer',
            orderId: String(updated._id), items: updated.items, total: updated.total,
            paymentMethod: updated.paymentMethod, currency: updated.currency || 'AED'
          }).catch(() => {});
        }
      }
    }

    res.json({
      orderId: order._id,
      orderNumber: String(order._id).slice(-6).toUpperCase(),
      paymentReference: order.paymentReference || '',
      status,
      verified: status === 'paid',
      reason: verification.reason || '',
      amount: order.total || 0,
      currency: order.currency || 'AED',
      transactionId: verification.transactionId || (order.paymentDetails && order.paymentDetails.transactionId) || '',
      paymentMethod: order.paymentMethod,
      awaitingVerification: !!order.awaitingVerification
    });
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
};

// POST /api/payments/webhook/:provider
// Provider callbacks/webhooks. The webhook payload is NEVER trusted on its
// own — the transaction is re-verified server-to-server with the provider's
// official API (and the amount is checked against the stored order) before
// any status change. Responds 2xx immediately to stop provider retries.
exports.handleWebhook = async (req, res) => {
  const provider = String(req.params.provider || '').trim();
  const providerImpl = PaymentService.getProvider(provider);
  if (!providerImpl || providerImpl.type === 'future') {
    return res.status(404).json({ received: false, message: 'Unknown provider' });
  }
  res.status(200).json({ received: true });
  try {
    const body = req.body || {};
    const orderRef = String(
      body.cart_id || (body.Data && body.Data.CustomerIdentifier) ||
      (body.metadata && body.metadata.reference) || body.reference || body.OrderReference || ''
    );
    const providerRef = String(
      body.tran_ref || (body.Data && (body.Data.InvoiceId || body.Data.PaymentId)) ||
      (body.data && (body.data.id || body.data.payment_id || body.data.tran_ref)) ||
      (body.payment && body.payment.id) || body.id || ''
    );

    let order = null;
    if (orderRef) {
      const isObjectId = /^[0-9a-fA-F]{24}$/.test(orderRef);
      order = await Order.findOne(isObjectId ? { _id: orderRef } : { paymentReference: orderRef });
    }
    if (!order && providerRef) order = await Order.findOne({ providerReference: providerRef });
    if (!order || order.paymentMethod !== provider) return;
    if (order.paymentStatus === 'paid') return; // already confirmed

    // Server-side re-verification — the authoritative source of truth.
    const verification = await PaymentService.verifyPayment(provider, order);
    const status = verification.status || 'pending';
    if (['paid', 'failed', 'cancelled', 'expired'].includes(status) && status !== order.paymentStatus) {
      const updates = { paymentStatus: status };
      if (status === 'paid') {
        updates.awaitingVerification = false;
        updates.advancePaid = order.total || 0;
        updates.remainingAmount = 0;
        updates['paymentDetails.paidAt'] = new Date();
        updates['paymentDetails.paidAmount'] = verification.paidAmount || order.total || 0;
        updates['paymentDetails.transactionId'] = verification.transactionId || order.providerReference || providerRef;
        updates['paymentDetails.notes'] = 'Payment verified via ' + provider + ' webhook';
      }
      await Order.findByIdAndUpdate(order._id, { $set: updates });
      const shortId = String(order._id).slice(-6).toUpperCase();
      const isPaid = status === 'paid';
      Notification.create({
        type: isPaid ? 'payment_success' : 'order_status',
        title: (isPaid ? '✅ Payment Confirmed #' : '💳 Payment ' + status.toUpperCase() + ' #') + shortId,
        message: (order.currency || 'AED') + ' ' + (order.total || 0).toLocaleString(),
        refType: 'order', refId: String(order._id)
      }).catch(() => {});
      emit(isPaid ? 'payment_success' : 'order_status', { orderId: String(order._id), amount: order.total, shortId });
      emit('notification', { type: isPaid ? 'payment_success' : 'order_status' });
      if (isPaid) {
        const customerEmail = order.contact && order.contact.includes('@') ? order.contact : null;
        if (customerEmail) {
          sendOrderConfirmation({
            customerEmail, customerName: (order.shippingAddress && order.shippingAddress.firstName) || 'Valued Customer',
            orderId: String(order._id), items: order.items, total: order.total,
            paymentMethod: order.paymentMethod, currency: order.currency || 'AED'
          }).catch(() => {});
        }
      }
    }
  } catch (e) {
    console.warn('⚠️ Webhook processing error (' + provider + '):', e.message);
  }
};

// POST /api/payments/bank-app/initiate
exports.initiateBankAppPayment = async (req, res) => {
  try {
    const body = req.body || {};
    body.method = 'bank_app';
    // Keep legacy behaviour identical by delegating to the unified endpoint.
    return exports.initiatePayment(req, res);
  } catch (err) {
    res.status(400).json({ message: err.message || 'Failed to create payment request' });
  }
};
// GET /api/payments/bank-app/:orderId
// Status check when the customer returns to the website.
exports.getBankAppPaymentStatus = async (req, res) => {
  try {
    const { orderId } = req.params;
    const order = await Order.findById(orderId);
    if (!order || order.paymentMethod !== 'bank_app') {
      return res.status(404).json({ message: 'Bank-app payment not found' });
    }
    const verification = await PaymentService.verifyPayment('bank_app', order);
    res.json({
      orderId: order._id,
      orderNumber: String(order._id).slice(-6).toUpperCase(),
      paymentReference: order.paymentReference || '',
      status: verification.status,
      verified: verification.verified,
      reason: verification.reason || '',
      amount: order.total || 0,
      currency: order.currency || 'AED',
      transactionId: (order.paymentDetails && order.paymentDetails.transactionId) || '',
      awaitingVerification: !!order.awaitingVerification
    });
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
};

// POST /api/payments/bank-app/confirm
// "I have completed payment" — NEVER auto-verifies a manual transfer.
exports.confirmBankAppPayment = async (req, res) => {
  try {
    const { orderId, transactionId } = req.body || {};
    if (!orderId) return res.status(400).json({ message: 'Missing order id' });

    const order = await Order.findById(orderId);
    if (!order || order.paymentMethod !== 'bank_app') {
      return res.status(404).json({ message: 'Bank-app payment not found' });
    }

    // Abandoned requests expire — a transfer claim after 48h is rejected so
    // the customer starts a fresh payment request instead.
    if (order.paymentStatus === 'pending' && (Date.now() - new Date(order.createdAt).getTime()) > 48 * 3600000) {
      order.paymentStatus = 'expired';
      await order.save();
      return res.status(400).json({
        verified: false,
        status: 'expired',
        message: 'This payment request has expired. Please start a new payment.',
        paymentReference: order.paymentReference || ''
      });
    }

    // 1. If a legitimate verification already happened (admin/gateway), report
    //    it as verified — we never downgrade a confirmed payment.
    const verification = await PaymentService.verifyPayment('bank_app', order);
    if (verification.verified) {
      return res.json({
        verified: true,
        status: 'paid',
        paymentReference: order.paymentReference || '',
        transactionId: (order.paymentDetails && order.paymentDetails.transactionId) || '',
        amount: order.total || 0,
        currency: order.currency || 'AED',
        message: 'Payment verified.'
      });
    }

    // 2. Customer claims they completed the transfer. Store their reference
    //    but KEEP the payment PENDING — a click is never proof of payment.
    //    paidAt is deliberately NOT set here: it is only stamped once the
    //    admin/provider legitimately verifies the transfer.
    if (transactionId && String(transactionId).trim()) {
      order.paymentDetails = order.paymentDetails || {};
      order.paymentDetails.transactionId = String(transactionId).trim();
      order.paymentDetails.notes = 'Customer submitted transfer reference — awaiting admin verification';
    }
    order.awaitingVerification = true;
    await order.save();

    res.json({
      verified: false,
      status: 'pending',
      paymentReference: order.paymentReference || '',
      amount: order.total || 0,
      currency: order.currency || 'AED',
      message: 'Your payment has not been verified yet. Please wait while we confirm your payment.'
    });
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
};

// POST /api/payments/bank-app/cancel
// Customer abandons the bank-app payment → the order is marked CANCELLED and
// stock is restored, so abandoned payment requests never linger as pending.
exports.cancelBankAppPayment = async (req, res) => {
  try {
    const { orderId } = req.body || {};
    if (!orderId) return res.status(400).json({ message: 'Missing order id' });

    const order = await Order.findById(orderId);
    if (!order || order.paymentMethod !== 'bank_app') {
      return res.status(404).json({ message: 'Bank-app payment not found' });
    }
    if (order.paymentStatus === 'paid') {
      return res.status(400).json({ message: 'Cannot cancel an already-paid order.' });
    }

    order.paymentStatus = 'cancelled';
    order.status = 'cancelled';
    order.awaitingVerification = false;
    order.stockRestored = true;
    order.paymentDetails = order.paymentDetails || {};
    order.paymentDetails.notes = 'Payment request cancelled by customer';
    await order.save();

    // Give the stock back — the order will never be fulfilled.
    restoreStockForOrder(order.items).catch(e => console.warn('⚠️ Stock restore failed on bank-app cancel:', e.message));

    const shortId = String(order._id).slice(-6).toUpperCase();
    Notification.create({
      type: 'order_status',
      title: '❌ Payment cancelled #' + shortId,
      message: 'Bank-app payment request cancelled',
      refType: 'order',
      refId: String(order._id)
    }).catch(() => {});
    emit('order_status', { orderId: String(order._id), status: 'cancelled', shortId });

    res.json({
      cancelled: true,
      status: 'cancelled',
      orderId: order._id,
      message: 'Payment request cancelled. No order will be processed.'
    });
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
};
