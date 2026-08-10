/* =========================================================================
   api.js — BIN SALEH Store Frontend <-> Backend Bridge
   -------------------------------------------------------------------------
   Include this script first on every HTML page (before tracking.js), so
   that API_BASE and the helper functions are available:

     <script src="./js/api.js"></script>

   API_BASE auto-detects: localhost for local development, otherwise the
   production Render backend. Override with window.BACKEND_URL if needed.
   ========================================================================= */

/* -----------------------------------------------------------------
   API BASE URL
   - Local: http://localhost:5000/api  (Express dev server)
   - Production: your Render backend URL
   Override by setting:  window.BACKEND_URL = "https://your-api.com/api";
   before this script loads.
------------------------------------------------------------------ */
const API_BASE = (function() {
  // Allow manual override via window variable
  if (window.BACKEND_URL) return window.BACKEND_URL;

  var host = window.location.hostname;
  var protocol = window.location.protocol;

  // RENDER BACKEND — production Express + MongoDB API
  // Get the actual URL from your Render dashboard after deployment.
  var RENDER_API = 'https://binsaleh-api.onrender.com/api';

  // Local development (localhost, 127.0.0.1, or file:// protocol)
  if (host === 'localhost' || host === '127.0.0.1' || protocol === 'file:') {
    return 'http://localhost:5000/api';
  }

  // Production (any host, custom domain, etc.) — use the Render backend
  return RENDER_API;
})();

/* -----------------------------------------------------------------
   TOKEN HELPERS
   JWT token is stored in localStorage only — user data lives in the DB.
------------------------------------------------------------------ */
function getToken() {
  return localStorage.getItem('bs_token');
}
function setToken(token) {
  localStorage.setItem('bs_token', token);
}
function clearToken() {
  localStorage.removeItem('bs_token');
}

/* -----------------------------------------------------------------
   GENERIC API CALLER
   All fetch() calls go through this function — it attaches the auth
   header automatically and normalizes error handling.
------------------------------------------------------------------ */
async function apiRequest(endpoint, options = {}) {
  const headers = {
    'Content-Type': 'application/json',
    ...(options.headers || {})
  };

  const token = getToken();
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  const res = await fetch(`${API_BASE}${endpoint}`, {
    ...options,
    headers
  });

  const data = await res.json().catch(() => ({}));

  if (!res.ok) {
    throw new Error(data.message || `Request failed (${res.status})`);
  }

  return data;
}

/* -----------------------------------------------------------------
   SHORTHAND METHODS
------------------------------------------------------------------ */
const api = {
  get: (endpoint) => apiRequest(endpoint, { method: 'GET' }),
  post: (endpoint, body) => apiRequest(endpoint, { method: 'POST', body: JSON.stringify(body) }),
  put: (endpoint, body) => apiRequest(endpoint, { method: 'PUT', body: JSON.stringify(body) }),
  del: (endpoint) => apiRequest(endpoint, { method: 'DELETE' }),
  // Upload a file (multipart/form-data) — returns { url, public_id }
  uploadFile: async (file) => {
    const token = getToken();
    const formData = new FormData();
    formData.append('image', file);
    const res = await fetch(API_BASE + '/upload', {
      method: 'POST',
      headers: token ? { 'Authorization': 'Bearer ' + token } : {},
      body: formData
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.message || 'Upload failed');
    return data;
  },
  // Upload an image from URL
  uploadFromUrl: async (url) => {
    return api.post('/upload/url', { url });
  }
};
