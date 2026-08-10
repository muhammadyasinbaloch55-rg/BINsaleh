// controllers/paymentController.js
// PayPal Payment Gateway Integration
// Uses the PayPal REST API v2 (no SDK needed — uses native Node.js https)
// PayPal client ID and secret can be configured via:
//   - Admin Panel > Payments > PayPal (stored in DB payment_settings)
//   - Environment variables: PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET, PAYPAL_MODE

const https = require('https');
const Settings = require('../models/Settings');

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
