/**
 * store.js – BIN SALEH Store
 * Shared cart, announcement bar, slider, and collections helpers.
 * Include on EVERY page:  <script src="./js/store.js"></script>
 * Must be loaded AFTER api.js on pages that use api.get().
 */

// ======================== CART (localStorage) ========================
const CART_KEY = 'bs_cart_items';

/** Load cart from localStorage */
function loadCart() {
  try {
    return JSON.parse(localStorage.getItem(CART_KEY)) || [];
  } catch(e) { return []; }
}

/** Save cart to localStorage */
function saveCart(cart) {
  localStorage.setItem(CART_KEY, JSON.stringify(cart));
}

/** Add item to the shared cart — deduplicates by id+color, increments qty */
function cartAddItem(item) {
  const cart = loadCart();
  // item must have: id, name, price, img, currency
  // Always keep a valid image on the cart item so the drawer never renders blank.
  if (!item.img || !isValidImageUrl(item.img)) item.img = PLACEHOLDER_IMG;
  const idx = cart.findIndex(x => String(x.id) === String(item.id) && x.color === (item.color || ''));
  if (idx > -1) {
    cart[idx].qty = (cart[idx].qty || 1) + (item.qty || 1);
  } else {
    cart.push({ ...item, qty: item.qty || 1 });
  }
  saveCart(cart);
  cartUpdateBadge();
  return cart;
}

/** Remove item from cart */
function cartRemoveItem(id, color) {
  let cart = loadCart();
  cart = cart.filter(x => !(String(x.id) === String(id) && (x.color || '') === (color || '')));
  saveCart(cart);
  cartUpdateBadge();
  return cart;
}

/** Increase item quantity by 1 */
function cartIncreaseQty(id, color) {
  const cart = loadCart();
  const idx = cart.findIndex(x => String(x.id) === String(id) && (x.color || '') === (color || ''));
  if (idx > -1) {
    cart[idx].qty = (cart[idx].qty || 1) + 1;
    saveCart(cart);
    cartUpdateBadge();
  }
  return cart;
}

/** Decrease item quantity by 1 (removes if 0) */
function cartDecreaseQty(id, color) {
  const cart = loadCart();
  const idx = cart.findIndex(x => String(x.id) === String(id) && (x.color || '') === (color || ''));
  if (idx > -1) {
    const newQty = (cart[idx].qty || 1) - 1;
    if (newQty <= 0) return cartRemoveItem(id, color);
    cart[idx].qty = newQty;
    saveCart(cart);
    cartUpdateBadge();
  }
  return cart;
}

/** Update quantity */
function cartSetQty(id, qty, color) {
  const cart = loadCart();
  const idx = cart.findIndex(x => String(x.id) === String(id) && (x.color || '') === (color || ''));
  if (idx > -1) {
    if (qty <= 0) return cartRemoveItem(id, color);
    cart[idx].qty = qty;
    saveCart(cart);
    cartUpdateBadge();
  }
  return cart;
}

/** Get cart count (total quantity of all items) */
function cartCount() {
  return loadCart().reduce((s, x) => s + (x.qty || 1), 0);
}

/** Get cart subtotal (sum of price * qty for each item) */
function cartSubtotal() {
  return loadCart().reduce((s, x) => s + (x.price || 0) * (x.qty || 1), 0);
}

/** Alias for backward compatibility */
function cartTotal() {
  return cartSubtotal();
}

/** Update the cart badge in the navbar */
function cartUpdateBadge() {
  const badges = document.querySelectorAll('.cart-badge, #cart-count');
  const count = cartCount();
  badges.forEach(el => { if (el) el.textContent = count; });
}

/** Render cart drawer on any page that has the cart drawer HTML */
function cartRenderDrawer() {
  const body = document.getElementById('cart-body');
  const totalEl = document.getElementById('cart-total');
  const emptyEl = document.getElementById('cart-empty');
  if (!body) return;

  const cart = loadCart();
  if (!cart.length) {
    if (emptyEl) { emptyEl.style.display = 'block'; body.innerHTML = ''; body.appendChild(emptyEl); }
    if (totalEl) totalEl.textContent = 'AED 0';
    return;
  }
  if (emptyEl) emptyEl.style.display = 'none';
  const subtotal = cartSubtotal();
  if (totalEl) totalEl.textContent = 'AED ' + subtotal.toLocaleString();

  body.innerHTML = cart.map((x, i) => {
    const itemTotal = (x.price || 0) * (x.qty || 1);
    const sym = x.currency || 'AED';
    return `
    <div class="cart-item">
      <img src="${getProductImage(x)}" alt="${x.name}" onerror="this.onerror=null;this.src=(window.PLACEHOLDER_IMG||PLACEHOLDER_IMG)"/>
      <div class="cart-item-info">
        <div class="cart-item-name">${x.name}${x.color ? ' (' + x.color + ')' : ''}</div>
        <div class="cart-item-price">${sym} ${Number(x.price || 0).toLocaleString()} × ${x.qty || 1} = ${sym} ${itemTotal.toLocaleString()}</div>
        <div class="cart-item-qty">
          <button class="qty-btn-sm" onclick="cartDecreaseQty('${x.id}','${x.color || ''}');cartRenderDrawer();event.stopPropagation()">−</button>
          <span class="qty-num">${x.qty || 1}</span>
          <button class="qty-btn-sm" onclick="cartIncreaseQty('${x.id}','${x.color || ''}');cartRenderDrawer();event.stopPropagation()">+</button>
        </div>
      </div>
      <button class="cart-item-remove" onclick="cartRemoveItem('${x.id}','${x.color || ''}');cartRenderDrawer();event.stopPropagation()"><i class="fas fa-times"></i></button>
    </div>`;
  }).join('');
}

// ======================== ANNOUNCEMENT BAR ========================
const ANN_KEY = 'bs_announcement_text';

async function fetchAnnouncementFromAPI() {
  // Try to load the announcement text from the backend Settings API
  if (typeof api === 'undefined') return;
  try {
    const result = await api.get('/settings/announcement_text');
    if (result && result.value) {
      localStorage.setItem(ANN_KEY, result.value);
    }
  } catch(e) {
    // API not available — use localStorage
  }
}

// ======================== SALE PERCENTAGE IN ANNOUNCEMENT BAR ========================
// Pulls the active-coupon sale info from the public /coupons/sale endpoint so
// the announcement bar's "UP TO X% OFF" text stays in sync with admin coupons.
const SALE_ANN_KEY = 'bs_sale_announcement';

async function fetchSaleAnnouncementFromAPI() {
  if (typeof api === 'undefined') return;
  try {
    const sale = await api.get('/coupons/sale');
    let snippet = '';
    if (sale && sale.saleActive) {
      if (sale.maxDiscount > 0) {
        snippet = '🔥 &nbsp; UP TO ' + sale.maxDiscount + '% OFF';
      } else if (sale.bestFlat > 0) {
        snippet = '🔥 &nbsp; UP TO ' + (sale.currency || 'AED') + ' ' + Number(sale.bestFlat).toLocaleString() + ' OFF';
      }
      if (snippet && sale.codes && sale.codes.length) {
        snippet += ' &nbsp;|&nbsp; USE CODE ' + sale.codes.slice(0, 3).join(' / ');
      }
    }
    try { localStorage.setItem(SALE_ANN_KEY, snippet); } catch(e) {}
  } catch(e) {
    // API not available — keep the cached value
  }
}

function getSaleAnnouncementSnippet() {
  try { return localStorage.getItem(SALE_ANN_KEY) || ''; } catch(e) { return ''; }
}

function getAnnouncementText() {
  try {
    const saved = localStorage.getItem(ANN_KEY);
    if (saved && saved.trim()) return saved;
  } catch(e) {}
  // default fallback
  return '🚚 &nbsp; Free Shipping on Orders Above AED 300 &nbsp;&nbsp;|&nbsp;&nbsp; 💰 &nbsp; COD Available Nationwide &nbsp;&nbsp;|&nbsp;&nbsp; 🔄 &nbsp; Easy Exchange Policy &nbsp;&nbsp;|&nbsp;&nbsp; ✅ &nbsp; AED 50 Advance Required to Confirm Order &nbsp;&nbsp;|&nbsp;&nbsp; ⭐ &nbsp; Summer Élite \'26 Collection is Live!';
}

function applyAnnouncement() {
  const text = getAnnouncementText();
  const sale = getSaleAnnouncementSnippet();
  // Prepend the live sale percentage (e.g. "🔥 UP TO 40% OFF | ...") when a sale is active.
  const finalText = sale ? sale + ' &nbsp;&nbsp;|&nbsp;&nbsp; ' + text : text;
  document.querySelectorAll('.announce-scroll, .announce-text, [id="announce-text"]').forEach(el => {
    el.innerHTML = finalText;
  });
}

// ======================== HERO SLIDER (localStorage + DB) ========================
const SLIDER_KEY = 'bs_hero_slides';

const PLACEHOLDER_IMG = 'data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20width%3D%22200%22%20height%3D%22250%22%3E%3Crect%20fill%3D%22%23e8e0d0%22%20width%3D%22200%22%20height%3D%22250%22%2F%3E%3Ctext%20x%3D%22100%22%20y%3D%22125%22%20text-anchor%3D%22middle%22%20font-family%3D%22sans-serif%22%20font-size%3D%2236%22%20fill%3D%22%23b8860b%22%3E%F0%9F%93%B7%3C%2Ftext%3E%3Ctext%20x%3D%22100%22%20y%3D%22155%22%20text-anchor%3D%22middle%22%20font-family%3D%22sans-serif%22%20font-size%3D%2213%22%20fill%3D%22%23887755%22%3ENO%20IMAGE%3C%2Ftext%3E%3C%2Fsvg%3E';
// Export on window so other pages/scopes can reference it reliably
if (typeof window !== 'undefined') { window.PLACEHOLDER_IMG = PLACEHOLDER_IMG; }

const DEFAULT_SLIDES = [
  { title: 'Summer<br/><span>Élite</span><br/>\'26', tag: 'New Arrival', sub: 'Elevate your style with our latest premium collection.', link: 'view-all.html', cta: 'Shop Now', img: PLACEHOLDER_IMG },
  { title: 'Fresh<br/><span>Tops</span><br/>Collection', tag: 'Premium Tops', sub: 'From box-fit to oversized, our tops redefine casual streetwear.', link: 'tops.html', cta: 'Explore Tops', img: PLACEHOLDER_IMG },
  { title: 'Match the<br/><span>Vibe</span>', tag: 'Co-Ord Sets', sub: 'Complete co-ord sets and tracksuits for that perfectly curated look.', link: 'tracksuits.html', cta: 'Shop Sets', img: PLACEHOLDER_IMG },
  { title: 'Scent That<br/><span>Speaks</span>', tag: 'Fragrances', sub: 'Exclusive fragrances that leave a lasting impression.', link: 'fragrances.html', cta: 'Discover Now', img: PLACEHOLDER_IMG },
  { title: 'Step In<br/><span>Style</span>', tag: 'Footwear', sub: 'Premium footwear collection — from Adidas Samba to exclusive sneakers.', link: 'footwear.html', cta: 'View Shoes', img: PLACEHOLDER_IMG }
];

async function fetchSliderFromAPI() {
  // Try to load the slider slides from the backend Settings API
  if (typeof api === 'undefined') return;
  try {
    const result = await api.get('/settings/hero_slides');
    if (result && result.value) {
      const parsed = typeof result.value === 'string' ? JSON.parse(result.value) : result.value;
      if (Array.isArray(parsed) && parsed.length) {
        localStorage.setItem(SLIDER_KEY, JSON.stringify(parsed));
      }
    }
  } catch(e) {
    // API not available — use localStorage
  }
}

function getSliderSlides() {
  try {
    const saved = localStorage.getItem(SLIDER_KEY);
    if (saved) {
      const parsed = JSON.parse(saved);
      if (Array.isArray(parsed) && parsed.length) return parsed;
    }
  } catch(e) {}
  return DEFAULT_SLIDES;
}

function saveSliderSlides(slides) {
  localStorage.setItem(SLIDER_KEY, JSON.stringify(slides));
}

// ======================== COLLECTIONS / SHOWCASE (localStorage) ========================
const COLLECTIONS_KEY = 'bs_collections';

const DEFAULT_COLLECTIONS = [
  { slug: 'tops', name: 'Tops', desc: 'Box-fit, Oversized & More', link: 'tops.html', img: PLACEHOLDER_IMG },
  { slug: 'bottoms', name: 'Bottoms', desc: 'Korean Pants, Cargos & More', link: 'bottoms.html', img: PLACEHOLDER_IMG },
  { slug: 'tracksuits', name: 'Tracksuits', desc: 'Co-Ord Sets & Matching Suits', link: 'tracksuits.html', img: PLACEHOLDER_IMG },
  { slug: 'footwear', name: 'Footwear', desc: 'Sneakers, Trainers & More', link: 'footwear.html', img: PLACEHOLDER_IMG },
  { slug: 'fragrances', name: 'Fragrances', desc: 'Exclusive Signature Scents', link: 'fragrances.html', img: PLACEHOLDER_IMG },
  { slug: 'accessories', name: 'Accessories', desc: 'Watches, Sunglasses, Bracelets', link: 'accessories.html', img: PLACEHOLDER_IMG },
  { slug: 'home-kitchen', name: 'Home & Kitchen', desc: 'Cookware, Decor & More', link: 'home-kitchen.html', img: PLACEHOLDER_IMG }
];

function getCollections() {
  try {
    const saved = localStorage.getItem(COLLECTIONS_KEY);
    if (saved) {
      const parsed = JSON.parse(saved);
      if (Array.isArray(parsed) && parsed.length) return parsed;
    }
  } catch(e) {}
  return DEFAULT_COLLECTIONS;
}

function saveCollections(collections) {
  localStorage.setItem(COLLECTIONS_KEY, JSON.stringify(collections));
}

// ======================== CHECKOUT NAVIGATION ========================
/** Redirect to addTocurt.html with the first cart item */
function checkoutFromCart() {
  const cart = loadCart();
  if (!cart.length) {
    if(typeof showToast === 'function') showToast('<i class="fas fa-exclamation-circle"></i> Cart is empty!');
    return;
  }
  // Redirect to the first cart item's product page for checkout — ?co=1 makes
  // the checkout page open the Secure Checkout modal immediately.
  const firstId = cart[0].id;
  window.location.href = 'addTocurt.html?id=' + encodeURIComponent(firstId) + '&co=1';
}

// ======================== UTILITY HELPERS ========================
function safeVal(v, fallback) { return (v !== null && v !== undefined && v !== '') ? v : fallback; }
function safeNum(v, fallback) { const n = Number(v); return isNaN(n) ? fallback : n; }

/**
 * Get the best available image URL from a product object.
 * Checks, in order: images[0], img, imageUrl, thumbnail, image — then falls back to PLACEHOLDER_IMG.
 * If images is a string (not array), returns it directly.
 * Filters out falsy, undefined, null string values.
 * Never returns null/undefined/empty/falsy values.
 */
/* Helper: check if a string looks like a valid image URL */
function isValidImageUrl(str) {
  if (!str || typeof str !== 'string') return false;
  str = str.trim();
  if (!str) return false;
  // Must start with http://, https://, data:, or // (protocol-relative)
  return str.startsWith('http://') || str.startsWith('https://') || str.startsWith('data:') || str.startsWith('//');
}

/**
 * Get the best available image URL from a product object.
 * Checks, in order: images[0], img, imageUrl, thumbnail, image — then falls back to PLACEHOLDER_IMG.
 * If images is a string (not array), returns it directly.
 * Filters out falsy, undefined, null string values.
 * Validates that the URL looks like a real image URL (http://, https://, data:, //).
 * Never returns null/undefined/empty/falsy values.
 */
function getProductImage(p) {
  if (!p) return PLACEHOLDER_IMG;
  var candidates = [];
  // If images is a plain string, use it as candidate
  if (typeof p.images === 'string') {
    candidates.push(p.images);
  }
  // images is an array — collect all valid items
  if (Array.isArray(p.images) && p.images.length) {
    for (var i = 0; i < p.images.length; i++) {
      if (p.images[i] && typeof p.images[i] === 'string') {
        candidates.push(p.images[i].trim());
      }
    }
  }
  // Add other common field names
  if (p.img && typeof p.img === 'string') candidates.push(p.img.trim());
  if (p.imageUrl && typeof p.imageUrl === 'string') candidates.push(p.imageUrl.trim());
  if (p.thumbnail && typeof p.thumbnail === 'string') candidates.push(p.thumbnail.trim());
  if (p.image && typeof p.image === 'string') candidates.push(p.image.trim());
  
  // Return the first candidate that looks like a valid image URL
  for (var j = 0; j < candidates.length; j++) {
    if (isValidImageUrl(candidates[j])) {
      return candidates[j];
    }
  }
  return PLACEHOLDER_IMG;
}

// Export to window for cross-page access
if (typeof window !== 'undefined') { window.getProductImage = getProductImage; }

// ======================== WISHLIST (localStorage + server sync) ========================
const WISHLIST_KEY = 'dn_wishlist';

function getWishlistList() {
  try { return JSON.parse(localStorage.getItem(WISHLIST_KEY)) || []; } catch(e) { return []; }
}

function setWishlistList(list) {
  localStorage.setItem(WISHLIST_KEY, JSON.stringify(list));
}

function isInWishlistList(id) {
  return getWishlistList().some(function(w){ return String(w.id) === String(id); });
}

/** Toggle a product in the wishlist. Syncs to the server when logged in. */
async function toggleWishlistCard(id, name, price, currency, img, btn) {
  const list = getWishlistList();
  const exists = isInWishlistList(id);
  if (exists) {
    setWishlistList(list.filter(function(w){ return String(w.id) !== String(id); }));
    if (btn) btn.classList.remove('liked');
  } else {
    setWishlistList(list.concat([{ id: id, name: name || 'Product', price: price || 0, currency: currency || 'AED', img: img || '', addedAt: new Date().toISOString() }]));
    if (btn) btn.classList.add('liked');
  }
  if (typeof getToken === 'function' && getToken()) {
    try { await api.post('/wishlist/sync', { productIds: getWishlistList().map(function(w){ return w.id; }) }); } catch(e) {}
  }
  if (typeof showToast === 'function') {
    showToast(exists ? '<i class="fas fa-heart-broken"></i> Removed from wishlist' : '<i class="fas fa-heart"></i> Added to wishlist!');
  }
  return !exists;
}

/** Mark heart buttons that are already in the wishlist on page load. */
function renderWishlistHearts() {
  const ids = getWishlistList().map(function(w){ return String(w.id); });
  document.querySelectorAll('.prod-wishlist').forEach(function(btn) {
    const pid = btn.getAttribute('data-pid') || btn.dataset.pid;
    if (pid && ids.indexOf(String(pid)) !== -1) btn.classList.add('liked');
  });
}

/** Toggle wishlist from a heart button (data-pid) on any product card.
 *  Product details are parsed from the card DOM so pages need no extra wiring. */
async function toggleWishlistCardFromBtn(btn) {
  if (!btn) return;
  const id = btn.dataset.pid || btn.getAttribute('data-pid');
  if (!id) return;
  const card = btn.closest('.prod-card') || btn.parentElement;
  let name = btn.dataset.name || '';
  let price = Number(btn.dataset.price) || 0;
  let currency = btn.dataset.currency || 'AED';
  let img = btn.dataset.img || '';
  if (card) {
    const nameEl = card.querySelector('.prod-name');
    if (!name && nameEl) name = nameEl.textContent.trim();
    const priceEl = card.querySelector('.prod-price');
    if (!price && priceEl) price = Number(String(priceEl.textContent).replace(/[^\d.]/g, '')) || 0;
    const imgEl = card.querySelector('img');
    if (!img && imgEl) img = imgEl.src || '';
  }
  return toggleWishlistCard(id, name, price, currency, img, btn);
}

// ======================== OFFLINE PRODUCT LOADER ========================
function getProductsFromLocalStorage(category) {
  try {
    const stored = JSON.parse(localStorage.getItem('dn_products') || '[]');
    if (category) return stored.filter(function(p) {
      return (p.category||'').toLowerCase() === category.toLowerCase();
    });
    return stored;
  } catch(e) { return []; }
}

// ======================== PIXEL SETTINGS SYNC ========================
// Fetch pixel settings from backend DB and cache in localStorage
// so all frontend pages can read them for FB/TikTok pixel initialization
async function fetchPixelSettingsFromAPI() {
  if (typeof api === 'undefined') return;
  try {
    const result = await api.get('/settings/pixel_settings');
    if (result && result.value) {
      const parsed = typeof result.value === 'string' ? JSON.parse(result.value) : result.value;
      if (parsed && parsed.tiktok && parsed.fb) {
        localStorage.setItem('dn_pixel_settings', JSON.stringify(parsed));
        // Also expose to window for pages that read from __META_PIXEL_ID / __TIKTOK_PIXEL_ID
        if (typeof window !== 'undefined') {
          window.__META_PIXEL_ID = (parsed.fb && parsed.fb.enabled && parsed.fb.pixelId) ? parsed.fb.pixelId : '';
          window.__TIKTOK_PIXEL_ID = (parsed.tiktok && parsed.tiktok.enabled && parsed.tiktok.pixelId) ? parsed.tiktok.pixelId : '';
        }
      }
    }
  } catch(e) {
    // API not available - use localStorage
  }
}

// ======================== PAYMENT METHODS SYNC ========================
// Fetch enabled payment methods from backend and cache in localStorage
// so the checkout page dynamically shows available payment options
async function fetchPaymentMethodsFromAPI() {
  if (typeof api === 'undefined') return;
  try {
    const result = await api.get('/settings/public/payment-methods');
    if (result && result.methods && result.methods.length) {
      localStorage.setItem('bs_payment_methods', JSON.stringify(result.methods));
      return result.methods;
    }
  } catch(e) {
    // API not available - use existing localStorage
  }
  return null;
}

// ======================== AUTO-INIT ON PAGE LOAD ========================
document.addEventListener('DOMContentLoaded', function() {
  // Fetch CMS data from database in the background
  // applyAnnouncement runs after API fetch so the freshest data is displayed
  fetchAnnouncementFromAPI().then(applyAnnouncement);
  // Sale percentage for the announcement bar — updates whenever coupons change.
  fetchSaleAnnouncementFromAPI().then(applyAnnouncement);
  fetchSliderFromAPI();
  // Sync pixel and payment settings from DB (silent, don't block)
  fetchPixelSettingsFromAPI().catch(function(){});
  fetchPaymentMethodsFromAPI().catch(function(){});
  // Also apply immediately from localStorage cache for instant display
  applyAnnouncement();
  cartUpdateBadge();
  cartRenderDrawer();
  renderWishlistHearts();

  // Product cards are rendered asynchronously after fetch — refresh heart states
  // whenever new cards appear in the DOM (debounced for performance).
  var heartTimer = null;
  var heartObserver = new MutationObserver(function() {
    if (heartTimer) return;
    heartTimer = setTimeout(function() { heartTimer = null; renderWishlistHearts(); }, 300);
  });
  heartObserver.observe(document.body, { childList: true, subtree: true });
});
