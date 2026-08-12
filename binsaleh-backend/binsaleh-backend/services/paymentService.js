// services/paymentService.js
// ============================================================================
// MODULAR UAE PAYMENT ARCHITECTURE
// ----------------------------------------------------------------------------
// The "Pay Online" section shows ONLY payment options that are officially
// supported by a configured payment provider. Each provider is an adapter
// with its own official API / payment link / hosted page:
//
//     PaymentService
//       ├── BankAppProvider      (ADIB bank-app / manual transfer — admin verifies)
//       ├── ZiinaProvider        (UAE payment app — payment_intent + hosted page)
//       ├── PayPalProvider       (PayPal orders API + hosted approval)
//       ├── MyFatoorahProvider   (UAE gateway — SendPayment/ExecutePayment links)
//       ├── PayTabsProvider      (UAE gateway — hosted payment page)
//       ├── MoyasarProvider      (hosted invoices + webhook)
//       └── CardPaymentProvider  (FUTURE: cards / Apple Pay / Google Pay)
//
// SECURITY PRINCIPLES
//   - Never ask for or store bank passwords, PINs, OTPs or card numbers.
//   - A payment is NEVER marked 'paid' from a customer click or a frontend
//     query string. Only server-side verification (provider API re-query or
//     webhook + re-query) or admin confirmation records a paid payment.
//   - No invented deep links: only official http(s) payment URLs returned by
//     the configured providers are used.
// ============================================================================

const Settings = require('../models/Settings');
const crypto = require('crypto');
const https = require('https');

// ---------- generic helpers ----------

async function getSettingValue(key, fallback) {
  try {
    const s = await Settings.findOne({ key });
    if (!s) return fallback;
    const v = typeof s.value === 'string' ? JSON.parse(s.value) : s.value;
    return (v === undefined || v === null) ? fallback : v;
  } catch (e) {
    return fallback;
  }
}

// payment_settings is the single source of truth for the provider list,
// global online toggle, seller display name and currency.
async function getPaymentSettings() {
  const v = await getSettingValue('payment_settings', null);
  const def = {
    onlineEnabled: false,
    sellerName: 'BIN SALEH Store',
    currency: 'AED',
    methods: []
  };
  if (v && typeof v === 'object') return { ...def, ...v };
  return def;
}

function findMethod(ps, id) {
  return (ps && Array.isArray(ps.methods) && ps.methods.find(m => m && m.id === id)) || null;
}

// Human-friendly payment reference: BS-PAY-XXXXXX-ABC
function generatePaymentReference(orderId) {
  const short = orderId ? String(orderId).slice(-6).toUpperCase() : 'ORDER';
  const rand = crypto.randomBytes(2).toString('hex').toUpperCase();
  return 'BS-PAY-' + short + '-' + rand;
}

// Only allow http(s) links — never invent app URL schemes like "bankapp://".
function sanitizePaymentLink(url) {
  if (!url) return '';
  const trimmed = String(url).trim();
  if (/^https?:\/\/.+/.test(trimmed)) return trimmed;
  return '';
}

// Minimal secure HTTPS JSON helper for provider API calls.
function httpsJson(host, path, method, headers, body, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const postData = body === undefined || body === null ? null : JSON.stringify(body);
    const options = {
      hostname: host,
      port: 443,
      path,
      method,
      headers: { Accept: 'application/json', ...(headers || {}) }
    };
    if (postData !== null) options.headers['Content-Type'] = 'application/json';
    if (postData !== null) options.headers['Content-Length'] = Buffer.byteLength(postData);
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        let parsed = {};
        try { parsed = data ? JSON.parse(data) : {}; } catch (e) { /* non-JSON */ }
        if (res.statusCode >= 200 && res.statusCode < 300) return resolve(parsed);
        reject(new Error(parsed.message || parsed.error_description || parsed.error || ('HTTP ' + res.statusCode + ' from ' + host)));
      });
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => { req.destroy(new Error('Provider request timed out')); });
    if (postData !== null) req.write(postData);
    req.end();
  });
}

/* ----------------------------------------------------------------------------
   SELLER BANK-APP (ADIB) SETTINGS — admin-controlled, never hard-coded
---------------------------------------------------------------------------- */
const DEFAULT_BANK_APP_SETTINGS = {
  enabled: false,
  bankName: 'ADIB',
  accountHolder: 'SELLER NAME',
  iban: '',
  accountNumber: '',
  currency: 'AED',
  instructions: 'Open your banking app and transfer the exact order amount to the account below. Use your payment reference so we can match your transfer.',
  // Optional: official payment request URL / deep link provided by the bank
  // or a supported payment provider. Left empty = fallback screen only.
  paymentLinkUrl: ''
};

async function getBankAppSettings() {
  const v = await getSettingValue('bank_app_settings', null);
  if (v && typeof v === 'object') return { ...DEFAULT_BANK_APP_SETTINGS, ...v };
  return { ...DEFAULT_BANK_APP_SETTINGS };
}

/* ----------------------------------------------------------------------------
   PROVIDERS
   Interface:
     id, name, icon, type ('manual'|'redirect'|'future'),
     description, isConfigured(ps), createPaymentRequest(order, urls),
     verifyPayment(order)  → { verified, status, transactionId?, reason? }
---------------------------------------------------------------------------- */

// ---- Bank App / Bank Transfer (manual — admin verifies the transfer) ----
const BankAppProvider = {
  id: 'bank_app',
  name: 'Bank App / Bank Transfer',
  icon: 'fas fa-mobile-screen-button',
  type: 'manual',
  description: 'Pay directly from your banking app to our ' + DEFAULT_BANK_APP_SETTINGS.bankName + ' account. We verify the transfer before confirming.',
  async isConfigured() {
    const s = await getBankAppSettings();
    return !!s.enabled && !!(s.iban || s.accountNumber);
  },
  async createPaymentRequest(order, opts) {
    const s = await getBankAppSettings();
    return {
      provider: 'bank_app',
      type: 'manual',
      reference: order.paymentReference || generatePaymentReference(order._id),
      amount: Number(order.total) || 0,
      currency: s.currency || order.currency || 'AED',
      bankDetails: {
        bankName: s.bankName,
        accountHolder: s.accountHolder,
        iban: s.iban,
        accountNumber: s.accountNumber,
        currency: s.currency || 'AED',
        instructions: s.instructions
      },
      paymentLinkUrl: sanitizePaymentLink(s.paymentLinkUrl),
      officialMechanism: !!sanitizePaymentLink(s.paymentLinkUrl)
    };
  },
  // No official verification API — the transfer is verified by the admin
  // (or a future bank webhook). A customer "I have paid" click is NOT proof.
  async verifyPayment(order) {
    if (!order) return { verified: false, status: 'pending', reason: 'order not found' };
    if (order.paymentStatus === 'paid') return { verified: true, status: 'paid', reason: 'payment confirmed by admin/provider' };
    if (order.paymentStatus === 'failed' || order.paymentStatus === 'cancelled' || order.paymentStatus === 'expired') {
      return { verified: false, status: order.paymentStatus, reason: 'payment ' + order.paymentStatus };
    }
    return { verified: false, status: 'pending', reason: 'awaiting transfer verification' };
  }
};

// ---- Ziina (UAE payment app) ----
const ZIINA_API_HOST = 'api.ziina.com';
const ZIINA_API_BASE = '/api/v2';

// NOTE: the method id stays 'zeina' for compatibility with existing orders,
// settings and the admin panel's Zeina card.
async function loadZiinaCredentials(ps) {
  const m = findMethod(ps || await getPaymentSettings(), 'zeina');
  if (m && m.config && m.config.accessToken) {
    return { accessToken: m.config.accessToken, mode: m.config.mode || 'test' };
  }
  return { accessToken: process.env.ZIINA_ACCESS_TOKEN || '', mode: process.env.ZIINA_MODE || 'test' };
}

function ziinaRequest(method, path, body, accessToken) {
  return httpsJson(ZIINA_API_HOST, ZIINA_API_BASE + path, method,
    { Authorization: 'Bearer ' + accessToken }, body);
}

const ZiinaProvider = {
  id: 'zeina',
  name: 'Ziina',
  icon: 'fas fa-credit-card',
  type: 'redirect',
  description: 'Pay with the Ziina app — cards, Apple Pay & Google Pay on Ziina\u2019s hosted page.',
  async isConfigured(ps) {
    const m = findMethod(ps, 'zeina');
    return !!(m && m.enabled && m.config && m.config.accessToken);
  },
  async createPaymentRequest(order, urls) {
    const creds = await loadZiinaCredentials();
    if (!creds.accessToken) throw new Error('Ziina is not configured. Set the access token in Admin Panel > Payments.');
    const amountFils = Math.round(Number(order.total) * 100);
    const body = {
      amount: amountFils,
      currency: order.currency || 'AED',
      success_url: urls.successUrl,
      cancel_url: urls.cancelUrl,
      test: creds.mode !== 'live'
    };
    if (order.paymentReference) body.metadata = { reference: order.paymentReference, order: String(order._id) };
    const intent = await ziinaRequest('POST', '/payment_intent', body, creds.accessToken);
    if (!intent.id || !intent.redirect_url) {
      throw new Error('Ziina did not return a payment link.');
    }
    return { provider: 'ziina', providerReference: intent.id, redirectUrl: intent.redirect_url, status: intent.status || 'pending' };
  },
  async verifyPayment(order) {
    const providerRef = order.providerReference || (order.paymentDetails && order.paymentDetails.providerReference);
    if (!providerRef) return { verified: false, status: 'pending', reason: 'missing payment intent' };
    try {
      const creds = await loadZiinaCredentials();
      const intent = await ziinaRequest('GET', '/payment_intent/' + encodeURIComponent(providerRef), null, creds.accessToken);
      const st = String(intent.status || '').toLowerCase();
      if (st === 'completed') return { verified: true, status: 'paid', transactionId: providerRef, paidAmount: intent.amount ? Number(intent.amount) / 100 : 0, currency: 'AED' };
      if (st === 'failed' || st === 'cancelled' || st === 'canceled') return { verified: false, status: st === 'canceled' ? 'cancelled' : st, reason: 'ziina status: ' + st };
      if (st === 'expired') return { verified: false, status: 'expired', reason: 'ziina status: expired' };
      return { verified: false, status: 'pending', reason: 'ziina status: ' + (st || 'unknown') };
    } catch (e) {
      return { verified: false, status: 'pending', reason: e.message };
    }
  }
};

// ---- PayPal ----
async function loadPayPalCredentials(ps) {
  const m = findMethod(ps || await getPaymentSettings(), 'paypal');
  if (m && m.config && m.config.clientId && m.config.clientSecret) {
    return { clientId: m.config.clientId, clientSecret: m.config.clientSecret, mode: m.config.mode || 'sandbox' };
  }
  return { clientId: process.env.PAYPAL_CLIENT_ID || '', clientSecret: process.env.PAYPAL_CLIENT_SECRET || '', mode: process.env.PAYPAL_MODE || 'sandbox' };
}

function payPalHost(creds) { return creds.mode !== 'live' ? 'api-m.sandbox.paypal.com' : 'api-m.paypal.com'; }

async function getPayPalAccessToken() {
  const creds = await loadPayPalCredentials();
  if (!creds.clientId || !creds.clientSecret) throw new Error('PayPal is not configured.');
  const basic = Buffer.from(creds.clientId + ':' + creds.clientSecret).toString('base64');
  const data = await httpsJson(payPalHost(creds), '/v1/oauth2/token', 'POST',
    { Authorization: 'Basic ' + basic, 'Content-Type': 'application/x-www-form-urlencoded' },
    'grant_type=client_credentials');
  if (!data.access_token) throw new Error(data.error_description || 'Failed to get PayPal token');
  return data.access_token;
}

async function payPalApi(method, path, body, accessToken) {
  return httpsJson(payPalHost(await loadPayPalCredentials()), '/v2' + path, method,
    { Authorization: 'Bearer ' + accessToken }, body);
}

const PayPalProvider = {
  id: 'paypal',
  name: 'PayPal',
  icon: 'fab fa-paypal',
  type: 'redirect',
  description: 'Pay securely with your PayPal account (hosted approval page).',
  async isConfigured(ps) {
    const m = findMethod(ps, 'paypal');
    return !!(m && m.enabled && m.config && m.config.clientId && m.config.clientSecret);
  },
  async createPaymentRequest(order, urls) {
    const token = await getPayPalAccessToken();
    const po = await payPalApi('POST', '/checkout/orders', {
      intent: 'CAPTURE',
      purchase_units: [{
        reference_id: order.paymentReference,
        amount: { currency_code: order.currency || 'AED', value: Number(order.total).toFixed(2) },
        description: 'BIN SALEH Store Order ' + order.paymentReference
      }],
      application_context: { return_url: urls.successUrl, cancel_url: urls.cancelUrl, user_action: 'PAY_NOW' }
    }, token);
    const approve = (po.links || []).find(l => l && l.rel === 'approve');
    return { provider: 'paypal', providerReference: po.id, redirectUrl: approve ? approve.href : '', status: po.status || 'CREATED' };
  },
  // Capture the approved PayPal order server-side, then verify the capture.
  async verifyPayment(order) {
    const providerRef = order.providerReference || (order.paymentDetails && order.paymentDetails.providerReference);
    if (!providerRef) return { verified: false, status: 'pending', reason: 'missing paypal order id' };
    try {
      const token = await getPayPalAccessToken();
      // 1) Try to capture (idempotent on APPROVED orders; fails if not approved yet)
      let capture = null;
      try {
        capture = await payPalApi('POST', '/checkout/orders/' + encodeURIComponent(providerRef) + '/capture', {}, token);
      } catch (e) {
        capture = null; // not captured/approved yet — fall through to status lookup
      }
      if (capture && capture.status === 'COMPLETED') {
        const cap = capture.purchase_units && capture.purchase_units[0] && capture.purchase_units[0].payments && capture.purchase_units[0].payments.captures && capture.purchase_units[0].payments.captures[0];
        return {
          verified: true, status: 'paid',
          transactionId: (cap && cap.id) || providerRef,
          paidAmount: cap ? parseFloat(cap.amount.value) : 0,
          currency: cap ? cap.amount.currency_code : 'AED'
        };
      }
      // 2) Status lookup for non-approved states
      const po = await payPalApi('GET', '/checkout/orders/' + encodeURIComponent(providerRef), null, token);
      const st = String(po.status || '');
      if (st === 'COMPLETED') return { verified: true, status: 'paid', transactionId: providerRef };
      if (st === 'APPROVED') return { verified: false, status: 'pending', reason: 'approved — awaiting capture' };
      if (st === 'CREATED') return { verified: false, status: 'pending', reason: 'paypal: payment not completed' };
      if (st === 'VOIDED') return { verified: false, status: 'cancelled', reason: 'paypal: order voided' };
      return { verified: false, status: 'pending', reason: 'paypal status: ' + (st || 'unknown') };
    } catch (e) {
      return { verified: false, status: 'pending', reason: e.message };
    }
  }
};

// ---- myFatoorah (UAE gateway) ----
async function loadMyFatoorahCredentials(ps) {
  const m = findMethod(ps || await getPaymentSettings(), 'myfatoorah');
  if (m && m.config && m.config.token) {
    return { token: m.config.token, mode: m.config.mode || 'live', username: m.config.username || '' };
  }
  return { token: process.env.MYFATOORAH_TOKEN || '', mode: process.env.MYFATOORAH_MODE || 'live' };
}

const MyFatoorahProvider = {
  id: 'myfatoorah',
  name: 'myFatoorah',
  icon: 'fas fa-building-columns',
  type: 'redirect',
  description: 'UAE online payments — cards, Apple Pay & Google Pay on myFatoorah\u2019s hosted page.',
  async isConfigured(ps) {
    const m = findMethod(ps, 'myfatoorah');
    return !!(m && m.enabled && m.config && m.config.token);
  },
  async createPaymentRequest(order, urls) {
    const creds = await loadMyFatoorahCredentials();
    if (!creds.token) throw new Error('myFatoorah is not configured.');
    const host = creds.mode === 'test' ? 'apitest.myfatoorah.com' : 'api.myfatoorah.com';
    const headers = {
      Authorization: 'Bearer ' + creds.token,
      ...(creds.username ? { username: creds.username } : {})
    };
    // SendPayment with NotificationOption 'LNK' returns a hosted invoice URL
    // the customer opens to choose their payment method and pay.
    const body = {
      NotificationOption: 'LNK',
      InvoiceValue: Number(order.total),
      DisplayCurrencyIso: order.currency || 'AED',
      CustomerName: order.customerName || 'BIN SALEH Customer',
      CustomerIdentifier: order.paymentReference,
      CallBackUrl: urls.successUrl,
      ErrorUrl: urls.cancelUrl,
      Language: 'en'
    };
    const data = await httpsJson(host, '/v2/SendPayment', 'POST', headers, body);
    if (!data.IsSuccess || !data.Data || !data.Data.InvoiceURL) {
      throw new Error(data.Message || 'myFatoorah did not return a payment link.');
    }
    return { provider: 'myfatoorah', providerReference: String(data.Data.InvoiceId), redirectUrl: data.Data.InvoiceURL, status: 'pending' };
  },
  async verifyPayment(order) {
    const providerRef = order.providerReference || (order.paymentDetails && order.paymentDetails.providerReference);
    if (!providerRef) return { verified: false, status: 'pending', reason: 'missing invoice id' };
    try {
      const creds = await loadMyFatoorahCredentials();
      const host = creds.mode === 'test' ? 'apitest.myfatoorah.com' : 'api.myfatoorah.com';
      const data = await httpsJson(host, '/v2/GetPaymentStatus', 'POST',
        { Authorization: 'Bearer ' + creds.token },
        { Key: providerRef, KeyType: 'InvoiceId' });
      if (!data.IsSuccess || !data.Data) return { verified: false, status: 'pending', reason: data.Message || 'myFatoorah status unavailable' };
      const st = String(data.Data.PaymentStatus || '').toLowerCase();
      const map = { paid: 'paid', pending: 'pending', failed: 'failed', cancelled: 'cancelled', expired: 'expired' };
      const status = map[st] || 'pending';
      return {
        verified: status === 'paid',
        status,
        reason: 'myfatoorah: ' + st,
        transactionId: status === 'paid' ? (String(data.Data.PaymentId || providerRef)) : '',
        paidAmount: status === 'paid' ? (Number(data.Data.PaidCurrencyValue) || Number(order.total)) : 0,
        currency: data.Data.Currency || order.currency || 'AED'
      };
    } catch (e) {
      return { verified: false, status: 'pending', reason: e.message };
    }
  }
};

// ---- PayTabs (UAE gateway) ----
async function loadPayTabsCredentials(ps) {
  const m = findMethod(ps || await getPaymentSettings(), 'paytabs');
  return {
    profileId: (m && m.config && m.config.profileId) || process.env.PAYTABS_PROFILE_ID || '',
    serverKey: (m && m.config && m.config.serverKey) || process.env.PAYTABS_SERVER_KEY || '',
    region: (m && m.config && m.config.region) || process.env.PAYTABS_REGION || 'ae'
  };
}

const PayTabsProvider = {
  id: 'paytabs',
  name: 'PayTabs',
  icon: 'fas fa-wallet',
  type: 'redirect',
  description: 'UAE online payments via the PayTabs hosted payment page.',
  async isConfigured(ps) {
    const m = findMethod(ps, 'paytabs');
    return !!(m && m.enabled && m.config && m.config.profileId && m.config.serverKey);
  },
  async createPaymentRequest(order, urls) {
    const creds = await loadPayTabsCredentials();
    if (!creds.profileId || !creds.serverKey) throw new Error('PayTabs is not configured.');
    const host = creds.region === 'sa' ? 'secure.paytabs.sa' : 'secure.paytabs.com';
    const body = {
      profile_id: creds.profileId,
      tran_type: 'sale',
      tran_class: 'ecom',
      cart_id: order.paymentReference,
      cart_currency: order.currency || 'AED',
      cart_amount: Number(order.total),
      cart_description: 'BIN SALEH Store Order ' + order.paymentReference,
      return: urls.successUrl,
      callback: urls.callbackUrl
    };
    const data = await httpsJson(host, '/payment/v2/create_payment_page', 'POST',
      { Authorization: creds.serverKey }, body);
    if (!data.tran_ref || !data.redirect_url) {
      throw new Error(data.message || 'PayTabs did not return a payment page.');
    }
    return { provider: 'paytabs', providerReference: data.tran_ref, redirectUrl: data.redirect_url, status: 'pending' };
  },
  async verifyPayment(order) {
    const providerRef = order.providerReference || (order.paymentDetails && order.paymentDetails.providerReference);
    if (!providerRef) return { verified: false, status: 'pending', reason: 'missing tran_ref' };
    try {
      const creds = await loadPayTabsCredentials();
      const host = creds.region === 'sa' ? 'secure.paytabs.sa' : 'secure.paytabs.com';
      const data = await httpsJson(host, '/payment/v2/query', 'POST',
        { Authorization: creds.serverKey },
        { profile_id: creds.profileId, tran_ref: providerRef });
      const result = (data && data.payment_result) || {};
      const st = String(result.response_status || '').toUpperCase();
      if (st === 'A') return { verified: true, status: 'paid', transactionId: providerRef, paidAmount: Number(data.cart_amount) || Number(order.total), currency: (data.cart_currency || order.currency || 'AED') };
      if (st === 'D') return { verified: false, status: 'failed', reason: 'paytabs: declined' };
      if (st === 'P' || st === 'H') return { verified: false, status: 'pending', reason: 'paytabs: ' + st };
      return { verified: false, status: 'pending', reason: 'paytabs response: ' + (st || 'unknown') };
    } catch (e) {
      return { verified: false, status: 'pending', reason: e.message };
    }
  }
};

// ---- Moyasar (hosted invoices; primarily KSA — admin decides if applicable) ----
async function loadMoyasarCredentials(ps) {
  const m = findMethod(ps || await getPaymentSettings(), 'moyasar');
  return { secretKey: (m && m.config && m.config.secretKey) || process.env.MOYASAR_SECRET_KEY || '' };
}

const MoyasarProvider = {
  id: 'moyasar',
  name: 'Moyasar',
  icon: 'fas fa-circle-nodes',
  type: 'redirect',
  description: 'Hosted payment page by Moyasar (cards & wallets). Confirm UAE availability with Moyasar before enabling.',
  async isConfigured(ps) {
    const m = findMethod(ps, 'moyasar');
    return !!(m && m.enabled && m.config && m.config.secretKey);
  },
  async createPaymentRequest(order, urls) {
    const creds = await loadMoyasarCredentials();
    if (!creds.secretKey) throw new Error('Moyasar is not configured.');
    const basic = 'Basic ' + Buffer.from(creds.secretKey + ':').toString('base64');
    const body = {
      amount: Math.round(Number(order.total) * 100),
      currency: order.currency || 'AED',
      description: 'BIN SALEH Store Order ' + order.paymentReference,
      success_url: urls.successUrl,
      back_url: urls.cancelUrl,
      metadata: { reference: order.paymentReference, order: String(order._id) }
    };
    const data = await httpsJson('api.moyasar.com', '/v1/invoices', 'POST', { Authorization: basic }, body);
    if (!data.id || !data.url) throw new Error('Moyasar did not return a hosted invoice.');
    return { provider: 'moyasar', providerReference: data.id, redirectUrl: data.url, status: data.status || 'pending' };
  },
  async verifyPayment(order) {
    const providerRef = order.providerReference || (order.paymentDetails && order.paymentDetails.providerReference);
    if (!providerRef) return { verified: false, status: 'pending', reason: 'missing invoice id' };
    try {
      const creds = await loadMoyasarCredentials();
      const basic = 'Basic ' + Buffer.from(creds.secretKey + ':').toString('base64');
      const data = await httpsJson('api.moyasar.com', '/v1/invoices/' + encodeURIComponent(providerRef), 'GET', { Authorization: basic }, null);
      const st = String(data.status || '').toLowerCase();
      const map = { paid: 'paid', pending: 'pending', failed: 'failed', cancelled: 'cancelled', expired: 'expired', voided: 'cancelled' };
      const status = map[st] || 'pending';
      return { verified: status === 'paid', status, reason: 'moyasar: ' + st, transactionId: status === 'paid' ? providerRef : '', paidAmount: status === 'paid' ? (Number(data.amount) || 0) / 100 : 0, currency: data.currency || order.currency || 'AED' };
    } catch (e) {
      return { verified: false, status: 'pending', reason: e.message };
    }
  }
};

// ---- FUTURE PROVIDER SLOT ----
const CardPaymentProvider = {
  id: 'card',
  name: 'Card / Apple Pay / Google Pay',
  icon: 'fas fa-credit-card',
  type: 'future',
  description: 'Not available yet — reserved for a future direct card integration.',
  async isConfigured() { return false; },
  async createPaymentRequest() { throw new Error('Card payments are not available yet.'); },
  async verifyPayment() { return { verified: false, status: 'pending', reason: 'not implemented' }; }
};

const PROVIDERS = {
  bank_app: BankAppProvider,
  zeina: ZiinaProvider,
  paypal: PayPalProvider,
  myfatoorah: MyFatoorahProvider,
  paytabs: PayTabsProvider,
  moyasar: MoyasarProvider,
  card: CardPaymentProvider
};

/* ----------------------------------------------------------------------------
   PaymentService facade
---------------------------------------------------------------------------- */
const PaymentService = {
  getProvider(id) { return PROVIDERS[id] || null; },

  getPaymentSettings,
  findMethod,

  // Online options shown on the "PAY ONLINE" screen — only enabled providers
  // with valid official credentials (and the manual ADIB bank-app fallback).
  async getAvailableOptions() {
    const ps = await getPaymentSettings();
    const bankApp = await getBankAppSettings();
    const options = [];
    if (bankApp.enabled && (bankApp.iban || bankApp.accountNumber)) {
      options.push({
        id: 'bank_app', name: BankAppProvider.name, icon: BankAppProvider.icon,
        type: BankAppProvider.type, description: BankAppProvider.description, sortOrder: 0
      });
    }
    for (const id of ['zeina', 'paypal', 'myfatoorah', 'paytabs', 'moyasar']) {
      const p = PROVIDERS[id];
      try {
        if (await p.isConfigured(ps)) {
          const m = findMethod(ps, id);
          options.push({
            id, name: m && m.name ? m.name : p.name, icon: p.icon, type: p.type,
            description: p.description, sortOrder: (m && m.sortOrder) || 50
          });
        }
      } catch (e) { /* skip unconfigured provider */ }
    }
    options.sort((a, b) => (a.sortOrder || 99) - (b.sortOrder || 99));
    return options;
  },

  async createPaymentRequest(method, order, urls) {
    const provider = PROVIDERS[method];
    if (!provider) throw new Error('Unsupported payment method: ' + method);
    return provider.createPaymentRequest(order, urls);
  },

  async verifyPayment(method, order) {
    const provider = PROVIDERS[method] || BankAppProvider;
    return provider.verifyPayment(order);
  },

  getBankAppSettings,
  generatePaymentReference,
  sanitizePaymentLink
};

module.exports = PaymentService;
