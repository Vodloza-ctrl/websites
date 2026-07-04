/**
 * wcz-checkout.js — shared EcoCash-push checkout module for websites.co.zw
 * ---------------------------------------------------------------------------
 * Extracted from the Bookings addon purchase flow (websites-bookings-worker.js
 * v1.11 + payments-worker.js v1.4's EcoCash push / Paynow Mobile-Remote-
 * Transaction integration -- the flow proven to actually move money on this
 * account, unlike the unproven Express Checkout / browser-redirect flow
 * still used by site publish/renewal today).
 *
 * WHY THIS EXISTS: "use checkout for everything" doesn't mean one URL
 * everyone gets redirected to -- EcoCash push has no browserurl, nothing to
 * redirect to. It means one consistent, trustworthy way money gets
 * collected: same required fields (phone + a REAL validated email, never a
 * placeholder), same card layout, same poll/timeout/error behaviour, no
 * matter which feature is selling something. This file IS that consistency,
 * as actual reusable code rather than a pattern someone has to remember to
 * copy correctly each time.
 *
 * WHAT THIS FILE DOES NOT DO (by design, not oversight):
 *   - No cart, no multi-item checkout, no bundling. One addon/tier purchase
 *     per call. Nothing currently sold combines into one transaction: see
 *     the Bookings addon session notes for why that's deliberately deferred
 *     until a real bundling need exists, rather than built speculatively.
 *   - No gateway abstraction (Stripe/PayPal etc.) -- this talks to whatever
 *     purchase/status functions the caller supplies; if a second gateway is
 *     ever added, it happens behind THOSE functions, not in this file.
 *   - No page navigation of any kind. Everything renders and resolves in
 *     place, in whatever container the caller points it at.
 *
 * DEPENDENCIES: none (no imports, no build step) -- but the rendered markup
 * uses this platform's existing CSS variables/classes (--green, --pro,
 * --pro-bg, --green-bg, .panel, .panel-body, .fld-group, .fld-label,
 * .fld-input, .btn, .btn-green, .btn-pro, .toast-wrap) already defined in
 * every dashboard/editor page. Include this script on any page that already
 * has that stylesheet; it does not bring its own styles.
 *
 * USAGE (see the Bookings integration in editor-index.html for a full
 * worked example):
 *
 *   WczCheckout.renderPricingSection({
 *     namespace: "bookings",              // unique per addon on the page --
 *                                         // prevents element-id collisions
 *                                         // if two pricing sections ever
 *                                         // render on the same page.
 *     containerId: "bookingsPricingSection",
 *     currentTier: bookingsState.tier,    // null | tier key the site already has
 *     tiers: [
 *       { key: "basic", label: "Bookings Basic", price: 12,
 *         features: ["Calendar widget", "WhatsApp handoff", ...] },
 *       { key: "pro", label: "Bookings Pro", price: 25, isTopTier: true,
 *         features: ["Everything in Basic", "Manual entry", ...] },
 *     ],
 *     prefillEmail: savedContactEmail,    // optional, or null
 *     purchase: async function(tier, phone, email) {
 *       // caller owns auth/routing -- return the same shape purchaseBookingsAddon() does
 *       return await bookingsApi("/bookings/purchase", { method: "POST",
 *         body: JSON.stringify({ site_id: siteId, tier: tier, phone: phone, email: email }) });
 *     },
 *     pollStatus: async function(reference) {
 *       return await bookingsApi("/bookings/purchase/status?site_id=" + encodeURIComponent(siteId) + "&ref=" + encodeURIComponent(reference));
 *     },
 *     onActivated: async function(tier) {
 *       // caller re-fetches its own tier state and re-renders -- this
 *       // module doesn't own that state, it only reports the outcome.
 *       await fetchBookingsTier();
 *     },
 *     toast: function(msg, type) { toast(msg, type); }, // caller's existing toast fn
 *   });
 *
 * `purchase` and `pollStatus` are the ONLY integration points -- this module
 * never talks to a specific worker URL itself, so it works identically
 * whether the caller's backend is bookings-worker, a future whatsapp-store
 * billing route, or anything else that speaks the same
 * { ok, data: { reference } } / { ok, data: { status } } shape already
 * established by payments-worker.js's GET /pay/status.
 */
(function (global) {
  "use strict";

  var EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  var POLL_INTERVAL_MS = 5000;
  var POLL_MAX_ATTEMPTS = 24; // ~2 minutes -- EcoCash approval can take a moment

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c];
    });
  }

  function defaultToast(msg) {
    // Fallback if the caller doesn't supply their own toast function --
    // extremely minimal, just enough to not silently swallow messages.
    if (typeof console !== "undefined") console.log("[wcz-checkout]", msg);
  }

  /**
   * Renders a set of pricing cards into containerId, one per tier at or
   * above the site's currentTier (tiers already owned/below are hidden --
   * mirrors the Bookings behaviour: no addon shows every tier, only Basic
   * shows both, Basic-tier sites only see the Pro upgrade card, top-tier
   * sites see nothing at all).
   */
  function renderPricingSection(config) {
    var container = document.getElementById(config.containerId);
    if (!container) return;

    var ns = config.namespace || "wcz";
    var toastFn = typeof config.toast === "function" ? config.toast : defaultToast;
    var currentTier = config.currentTier || null;
    var tiers = config.tiers || [];

    var currentIndex = currentTier ? tiers.findIndex(function (t) { return t.key === currentTier; }) : -1;
    var visibleTiers = tiers.filter(function (t, i) { return i > currentIndex; });

    if (!visibleTiers.length) {
      // Already on the top tier (or a tier list with nothing higher) --
      // nothing left to sell, nothing to show.
      container.style.display = "none";
      container.innerHTML = "";
      return;
    }

    container.style.display = "block";
    var cardsHtml = visibleTiers.map(function (tier) {
      return buildCardHtml(ns, tier, currentTier);
    }).join("");
    container.innerHTML = '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:12px">' + cardsHtml + "</div>";

    visibleTiers.forEach(function (tier) {
      var btn = document.getElementById(ns + "-buy-" + tier.key);
      if (btn) {
        btn.addEventListener("click", function () {
          handlePurchaseClick(ns, tier, config, toastFn);
        });
      }
      if (config.prefillEmail) {
        var emailEl = document.getElementById(ns + "-email-" + tier.key);
        if (emailEl && !emailEl.value) emailEl.value = config.prefillEmail;
      }
    });
  }

  function buildCardHtml(ns, tier, currentTier) {
    var isTop = !!tier.isTopTier;
    var accent = isTop ? "var(--pro)" : "var(--green)";
    var btnClass = isTop ? "btn-pro" : "btn-green";
    var btnLabel = currentTier && !isTop ? "Subscribe" : (currentTier ? "Upgrade to " + esc(tier.label) : "Subscribe");
    var featuresHtml = (tier.features || []).map(function (f) {
      return '<div style="font-size:12.5px;color:var(--ink2);display:flex;gap:6px"><span style="color:' + accent + '">\u2713</span>' + f + "</div>";
    }).join("");

    return '<div class="panel" style="border:2px solid ' + accent + ';box-shadow:none;margin-bottom:0">'
      + '<div class="panel-body">'
      + '<div style="font-size:11px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:' + accent + ';margin-bottom:6px">' + esc(tier.label) + (isTop ? " \u2b50" : "") + "</div>"
      + '<div style="font-family:var(--font-head);font-size:24px;font-weight:800;line-height:1;margin-bottom:10px">$' + tier.price + '<span style="font-size:13px;font-weight:500;color:var(--ink3)">/mo</span></div>'
      + '<div style="display:flex;flex-direction:column;gap:5px;margin-bottom:12px">' + featuresHtml + "</div>"
      + '<div class="fld-group" style="margin-bottom:8px"><label class="fld-label">EcoCash number</label><input class="fld-input" id="' + ns + "-phone-" + tier.key + '" placeholder="0772 000 000" style="font-size:13px"></div>'
      + '<div class="fld-group" style="margin-bottom:8px"><label class="fld-label">Email <span class="fld-hint">\u2014 for your payment receipt</span></label><input class="fld-input" id="' + ns + "-email-" + tier.key + '" type="email" placeholder="you@email.com" style="font-size:13px"></div>'
      + '<div id="' + ns + "-status-" + tier.key + '" style="font-size:12px;color:var(--ink3);margin-bottom:6px;display:none"></div>'
      + '<button type="button" class="btn ' + btnClass + '" style="width:100%" id="' + ns + "-buy-" + tier.key + '">' + btnLabel + " \u2014 $" + tier.price + "/mo</button>"
      + "</div></div>";
  }

  async function handlePurchaseClick(ns, tier, config, toastFn) {
    var phoneEl = document.getElementById(ns + "-phone-" + tier.key);
    var emailEl = document.getElementById(ns + "-email-" + tier.key);
    var btn = document.getElementById(ns + "-buy-" + tier.key);
    var statusEl = document.getElementById(ns + "-status-" + tier.key);

    var phone = phoneEl ? phoneEl.value.trim() : "";
    var email = emailEl ? emailEl.value.trim() : "";

    if (!phone || phone.replace(/\D/g, "").length < 9) {
      toastFn("Enter a valid EcoCash number to push the payment to", "err");
      return;
    }
    if (!email || !EMAIL_RE.test(email)) {
      toastFn("Enter a valid email \u2014 Paynow sends your receipt there", "err");
      return;
    }

    setBusy(btn, phoneEl, emailEl, true, "Sending payment prompt\u2026");

    var result;
    try {
      result = await config.purchase(tier.key, phone, email);
    } catch (e) {
      result = { ok: false, data: { error: "Network error \u2014 try again" } };
    }

    if (!result || !result.ok || !result.data || !result.data.reference) {
      toastFn((result && result.data && result.data.error) || "Couldn't start payment \u2014 try again", "err");
      setBusy(btn, phoneEl, emailEl, false, buyLabel(tier, config.currentTier));
      return;
    }

    if (statusEl) { statusEl.style.display = "block"; statusEl.textContent = "Check your phone for an EcoCash prompt and approve it\u2026"; }
    if (btn) btn.textContent = "Waiting for approval\u2026";

    await pollPurchase(ns, tier, result.data.reference, config, toastFn, btn, statusEl, phoneEl, emailEl);
  }

  async function pollPurchase(ns, tier, reference, config, toastFn, btn, statusEl, phoneEl, emailEl) {
    var attempts = 0;
    while (attempts < POLL_MAX_ATTEMPTS) {
      await new Promise(function (resolve) { setTimeout(resolve, POLL_INTERVAL_MS); });

      var result;
      try {
        result = await config.pollStatus(reference);
      } catch (e) {
        result = { ok: false, data: {} };
      }
      var status = result && result.ok && result.data ? result.data.status : null;

      if (status === "paid") {
        if (statusEl) statusEl.textContent = "Payment confirmed \u2713";
        toastFn((tier.label || "Addon") + " activated \u2713", "ok");
        if (typeof config.onActivated === "function") await config.onActivated(tier.key);
        return;
      }
      if (status === "cancelled" || status === "failed") {
        toastFn("Payment " + status + " \u2014 you can try again", "err");
        setBusy(btn, phoneEl, emailEl, false, buyLabel(tier, config.currentTier));
        if (statusEl) statusEl.style.display = "none";
        return;
      }
      attempts++;
    }
    toastFn("Still waiting on approval \u2014 check your phone, or try again", "err");
    setBusy(btn, phoneEl, emailEl, false, buyLabel(tier, config.currentTier));
  }

  function buyLabel(tier, currentTier) {
    var isTop = !!tier.isTopTier;
    var label = currentTier && !isTop ? "Subscribe" : (currentTier ? "Upgrade to " + tier.label : "Subscribe");
    return label + " \u2014 $" + tier.price + "/mo";
  }

  function setBusy(btn, phoneEl, emailEl, busy, idleLabel) {
    if (btn) { btn.disabled = busy; btn.textContent = busy ? btn.textContent : idleLabel; }
    if (phoneEl) phoneEl.disabled = busy;
    if (emailEl) emailEl.disabled = busy;
  }

  global.WczCheckout = { renderPricingSection: renderPricingSection };
})(typeof window !== "undefined" ? window : this);
