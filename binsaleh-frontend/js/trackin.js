/* =========================================================================
   BIN SALEH STORE — TRACKING LAYER (tracking.js)
   ---------------------------------------------------------------------
   Frontend-only tracking utilities for Meta Pixel (Facebook/Instagram)
   and TikTok Pixel.

   ⚠️ Assumes the base Meta Pixel (fbq) and TikTok Pixel (ttq) snippets
      are ALREADY placed in the <head> of every page.

   ⚠️ No backend logic here. All product/cart/order data is expected to
      be injected by the backend (or a template engine) into the global
      window.TRACKING_DATA object BEFORE this script runs.

   Include order on every page:
     1. Meta Pixel base code (in <head>)
     2. TikTok Pixel base code (in <head>)
     3. <script> that sets window.TRACKING_DATA = {...} (backend output)
     4. <script src="tracking.js"></script>  (this file, at end of body)
   ========================================================================= */

(function (window, document) {
  "use strict";

  /* -----------------------------------------------------------------
     1. GLOBAL TRACKING DATA OBJECT
     -----------------------------------------------------------------
     Backend should overwrite / merge into this object before
     tracking.js runs. If backend doesn't provide it, we create a
     safe empty default so nothing throws errors.
  ------------------------------------------------------------------ */
  window.TRACKING_DATA = window.TRACKING_DATA || {
    product: {
      id: "",
      name: "",
      price: 0,
      currency: "PKR",
      category: ""
    },
    cart: {
      total: 0,
      currency: "PKR",
      items: [] // [{ id, name, price, quantity, category }]
    },
    order: {
      id: "",
      total: 0,
      currency: "PKR",
      status: "" // e.g. "pending" | "paid" | "failed"
    }
  };

  const TD = window.TRACKING_DATA;


  /* -----------------------------------------------------------------
     2. PIXEL SAFETY HELPERS
     -----------------------------------------------------------------
     Always check that fbq/ttq exist before calling them.
     If pixels are blocked (ad-blockers, privacy extensions, etc.)
     these helpers fail silently — no errors thrown.
  ------------------------------------------------------------------ */

  // Returns true if Meta Pixel (fbq) is available
  function hasMeta() {
    return typeof window.fbq === "function";
  }

  // Returns true if TikTok Pixel (ttq) is available
  function hasTikTok() {
    return typeof window.ttq === "object" && typeof window.ttq.track === "function";
  }

  // Safe wrapper for Meta Pixel events
  function fireMeta(eventName, payload) {
    try {
      if (hasMeta()) {
        window.fbq("track", eventName, payload || {});
      }
    } catch (err) {
      // Fail silently — do not break the page if pixel is blocked
      console.warn("[tracking] Meta pixel event failed:", eventName, err);
    }
  }

  // Safe wrapper for TikTok Pixel events
  function fireTikTok(eventName, payload) {
    try {
      if (hasTikTok()) {
        window.ttq.track(eventName, payload || {});
      }
    } catch (err) {
      console.warn("[tracking] TikTok pixel event failed:", eventName, err);
    }
  }


  /* -----------------------------------------------------------------
     3. PAGEVIEW EVENT
     -----------------------------------------------------------------
     Fires automatically on every page load.
     Meta: PageView
     TikTok: PageView
  ------------------------------------------------------------------ */
  function trackPageView() {
    fireMeta("PageView");
    fireTikTok("PageView");
  }


  /* -----------------------------------------------------------------
     4. VIEW CONTENT EVENT (Product Page)
     -----------------------------------------------------------------
     Fires automatically if TRACKING_DATA.product has a valid id.
     Meta: ViewContent
     TikTok: ViewContent
  ------------------------------------------------------------------ */
  function trackViewContent() {
    const product = TD.product;

    // Only fire if backend actually populated product data
    if (!product || !product.id) return;

    const payload = {
      content_ids: [String(product.id)],
      content_name: product.name || "",
      content_type: "product",
      content_category: product.category || "",
      currency: product.currency || "PKR",
      value: Number(product.price) || 0
    };

    fireMeta("ViewContent", payload);

    // TikTok uses a slightly different field naming convention
    fireTikTok("ViewContent", {
      content_id: String(product.id),
      content_name: product.name || "",
      content_category: product.category || "",
      currency: product.currency || "PKR",
      value: Number(product.price) || 0
    });
  }


  /* -----------------------------------------------------------------
     5. ADD TO CART EVENT
     -----------------------------------------------------------------
     Reusable function — call this from your "Add to Cart" button
     handler (attached via addEventListener, NOT inline onclick).

     Usage:
       trackAddToCart({
         id: "12345",
         name: "Linen Co-ord Set",
         price: 5450,
         currency: "PKR",
         category: "tracksuits",
         quantity: 1
       });

     If no argument is passed, falls back to TRACKING_DATA.product.
  ------------------------------------------------------------------ */
  function trackAddToCart(product) {
    // Fall back to global product data if nothing passed in
    const item = product || TD.product || {};

    if (!item.id) {
      console.warn("[tracking] trackAddToCart called without product id");
      return;
    }

    const quantity = Number(item.quantity) || 1;
    const price = Number(item.price) || 0;
    const currency = item.currency || "PKR";

    // Meta AddToCart
    fireMeta("AddToCart", {
      content_ids: [String(item.id)],
      content_name: item.name || "",
      content_type: "product",
      content_category: item.category || "",
      currency: currency,
      value: price * quantity
    });

    // TikTok AddToCart
    fireTikTok("AddToCart", {
      content_id: String(item.id),
      content_name: item.name || "",
      content_category: item.category || "",
      quantity: quantity,
      currency: currency,
      value: price * quantity
    });
  }


  /* -----------------------------------------------------------------
     6. INITIATE CHECKOUT EVENT
     -----------------------------------------------------------------
     Fires automatically on the checkout page using TRACKING_DATA.cart.
     Meta: InitiateCheckout
     TikTok: InitiateCheckout
  ------------------------------------------------------------------ */
  function trackInitiateCheckout() {
    const cart = TD.cart;

    // Only fire if cart has items / total
    if (!cart || !cart.items || cart.items.length === 0) return;

    const contentIds = cart.items.map(function (i) { return String(i.id); });
    const numItems = cart.items.reduce(function (sum, i) {
      return sum + (Number(i.quantity) || 1);
    }, 0);

    fireMeta("InitiateCheckout", {
      content_ids: contentIds,
      contents: cart.items.map(function (i) {
        return { id: String(i.id), quantity: Number(i.quantity) || 1 };
      }),
      num_items: numItems,
      currency: cart.currency || "PKR",
      value: Number(cart.total) || 0
    });

    fireTikTok("InitiateCheckout", {
      contents: cart.items.map(function (i) {
        return {
          content_id: String(i.id),
          content_name: i.name || "",
          quantity: Number(i.quantity) || 1,
          price: Number(i.price) || 0
        };
      }),
      currency: cart.currency || "PKR",
      value: Number(cart.total) || 0
    });
  }


  /* -----------------------------------------------------------------
     7. PURCHASE EVENT (Thank You Page Only)
     -----------------------------------------------------------------
     Call trackPurchase(order) ONLY on the thank-you / order
     confirmation page, after the backend confirms payment.

     Rules:
       - Fires ONLY when order.status === "paid"
       - Meta: Purchase
       - TikTok: CompletePayment
       - Prevented from firing twice using localStorage flag
         (handles page refresh on thank-you page)

     Usage:
       trackPurchase({
         id: "ORD-12345",
         total: 5450,
         currency: "PKR",
         status: "paid"
       });

     If no argument passed, falls back to TRACKING_DATA.order.
  ------------------------------------------------------------------ */
  function trackPurchase(order) {
    const o = order || TD.order || {};

    // Only fire for confirmed/paid orders
    if (!o || o.status !== "paid" || !o.id) return;

    // Duplicate-fire protection (per order id, persisted across reloads)
    const storageKey = "dn_purchase_tracked_" + o.id;
    if (localStorage.getItem(storageKey) === "1") {
      // Already tracked this order — do not fire again
      return;
    }

    const currency = o.currency || "PKR";
    const value = Number(o.total) || 0;

    // Meta Purchase
    fireMeta("Purchase", {
      content_ids: o.items ? o.items.map(function (i) { return String(i.id); }) : [],
      currency: currency,
      value: value,
      order_id: String(o.id)
    });

    // TikTok CompletePayment
    fireTikTok("CompletePayment", {
      content_id: String(o.id),
      currency: currency,
      value: value,
      contents: o.items ? o.items.map(function (i) {
        return {
          content_id: String(i.id),
          content_name: i.name || "",
          quantity: Number(i.quantity) || 1,
          price: Number(i.price) || 0
        };
      }) : []
    });

    // Mark this order as tracked so refreshing thank-you page
    // doesn't fire Purchase/CompletePayment again
    try {
      localStorage.setItem(storageKey, "1");
    } catch (err) {
      // localStorage might be unavailable (private mode) — ignore
    }
  }


  /* -----------------------------------------------------------------
     8. EXPOSE PUBLIC API
     -----------------------------------------------------------------
     Expose only what other scripts/buttons need to call manually.
     PageView, ViewContent, InitiateCheckout fire automatically below.
  ------------------------------------------------------------------ */
  window.DNTracking = {
    trackPageView: trackPageView,
    trackViewContent: trackViewContent,
    trackAddToCart: trackAddToCart,
    trackInitiateCheckout: trackInitiateCheckout,
    trackPurchase: trackPurchase
  };

  // Keep trackAddToCart / trackPurchase also available globally
  // for convenience when wiring up event listeners.
  window.trackAddToCart = trackAddToCart;
  window.trackPurchase = trackPurchase;


  /* -----------------------------------------------------------------
     9. AUTO-FIRE EVENTS ON PAGE LOAD
     -----------------------------------------------------------------
     - PageView: always
     - ViewContent: only if product data exists (product pages)
     - InitiateCheckout: only if cart data exists (checkout page)

     Purchase is NEVER auto-fired — it must be explicitly called
     on the thank-you page after backend confirms payment.
  ------------------------------------------------------------------ */
  document.addEventListener("DOMContentLoaded", function () {
    trackPageView();
    trackViewContent();
    trackInitiateCheckout();
  });

})(window, document);