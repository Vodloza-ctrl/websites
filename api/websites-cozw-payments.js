/**
 * websites.co.zw — payments Worker (SELF-CONTAINED, no imports)  v1.15
 * ---------------------------------------------------------------------------
 * v1.15 — two more one-time $15 template SKUs: 'template:grill-noir' and
 * 'template:grill-market'. Same 'unlock' tier / one_time billing path as
 * every other template SKU below -- zero new logic needed.
 * v1.14 — two more one-time $15 template SKUs: 'template:beauty-atelier'
 * and 'template:beauty-maison'. Same 'unlock' tier / one_time billing path
 * as the hospitality-sands/wild SKUs below -- zero new logic needed.
 * v1.13 — added GET /addon-status?site_id=&addon_type= : a generic,
 * read-only, browser-reachable check for whether an addon is currently
 * owned. Needed because orders-worker's /addon-check is service-binding
 * only (worker-to-worker, unreachable from client JS) and bookings-worker's
 * /bookings/tier is bookings-specific. Built for the editor's template
 * picker to show locked/unlocked state, but works for any addon_type.
 * v1.12 — one-time billing for template unlocks. Two new $15 SKUs
 * ('template:hospitality-sands', 'template:hospitality-wild'), tier fixed
 * to 'unlock' so handlePayAddon()'s existing validation needed zero changes.
 * confirmPaidAddon() now branches: template:* addon_types get
 * billing_cycle='one_time' and expires_at=NULL (permanent, per this
 * platform's convention -- renewal-cron's addons sweep already treats NULL
 * as never-touch). Recurring addons (bookings) unaffected.
 * v1.11 — confirmPaidAddon() now writes activated_at/expires_at as unixepoch()
 * integers instead of date() TEXT, so renewal-cron's addons sweep can actually
 * compare against them. Existing rows need migration-addons-expiry-normalize.sql
 * run once first. See confirmPaidAddon() below for the full explanation.
 * ---------------------------------------------------------------------------
 * SINGLE SOURCE OF TRUTH for Paynow. The auth Worker (app.websites.co.zw)
 * no longer talks to Paynow directly — /api/sites/:id/publish and
 * /api/sites/:id/renew delegate here via POST /pay.
 *
 * v1.10 CHANGE — ZiG DISCOUNT PRICING FOR STORE PAYMENTS: Store Payments
 * checkout previously charged the same numeric amount regardless of
 * currency — a product priced at $20 charged literally "20" even when the
 * owner's connected Paynow account is ZiG, with no conversion or discount
 * at all. Products are always entered in USD in the editor (there's no
 * ZiG price field anywhere in editor.html — "Price (USD)" is the only
 * input), so ZiG customers now get the live env.ZIG_RATE-converted price
 * with a genuine discount applied (ZIG_STORE_DISCOUNT_PCT, currently 12%)
 * — computed server-side per line item at checkout time, never trusted
 * from the client, same principle env.ZIG_RATE-based pricing already
 * follows platform-wide (see zigAmountFor() for site-plan pricing). See
 * computeZigStorePrice() and its call site inside handleStoreCheckout's
 * line-item loop.
 *
 * v1.9 CHANGE — REAL authemail FOR MERCHANT VERIFICATION: Paynow rejects a
 * test-mode transaction unless `authemail` matches one of the merchant
 * account's actual login addresses (see Paynow's own Test Mode docs). This
 * worker's verification transaction was previously hardcoded to a
 * placeholder address (verify@websites.co.zw), which meant EVERY connect
 * attempt would fail verification regardless of whether the Integration
 * ID/Key were correct. POST /merchant-credentials/connect now requires an
 * `email` field (the owner's own Paynow login email), validates it,
 * stores it on the merchant_credentials row, and uses it as authemail on
 * every verification attempt. Also returned by GET /merchant-credentials/
 * status so the editor can display/reuse it. REQUIRES a migration:
 *   ALTER TABLE merchant_credentials ADD COLUMN email TEXT;
 *
 * v1.8 CHANGE — ZiG SUPPORT FOR OWNER DEPOSITS: merchant_credentials gains a
 * `currency` column ('USD' | 'ZIG', default 'USD'). Paynow doesn't accept
 * currency as a per-transaction field on a single integration — the
 * integration ID/key pair itself is currency-locked on Paynow's side (same
 * reason this worker's own platform-level flow needs two separate
 * PAYNOW_USD_ID/PAYNOW_ZIG_ID integrations). So the owner now picks which
 * currency their connected account is in at connect time
 * (POST /merchant-credentials/connect { ..., currency }), and that value
 * flows through: stored on the credentials row, returned by
 * GET /merchant-credentials/status, recorded correctly on the `payments`
 * row instead of a hardcoded 'USD', returned in the POST /deposit/charge
 * response so bookings-worker/the customer widget can display it, and
 * forwarded to bookings-worker's POST /deposit-confirmed instead of that
 * side assuming USD too. REQUIRES a migration:
 *   ALTER TABLE merchant_credentials ADD COLUMN currency TEXT NOT NULL DEFAULT 'USD';
 *
 * v1.7 CHANGE — WIRE-UP FIX: confirmDepositPaid()'s call to
 * bookings-worker's POST /deposit-confirmed now actually sends the shared
 * secret header (X-Internal-Secret) that bookings-worker v1.17 requires —
 * the v1.6 version of this call was a stub that would have silently 401'd
 * against the real route once bookings-worker was deployed. Requires a NEW
 * service binding, BOOKINGS_WORKER (Settings -> Bindings -> Service binding
 * -> websites-bookings-worker), and the SAME INTERNAL_SHARED_SECRET secret
 * value already set on bookings-worker.
 *
 * v1.6 CHANGE — OWNER PAYNOW CREDENTIALS + BOOKING DEPOSITS:
 *   - New table `merchant_credentials` (see migration file) stores each
 *     owner's OWN Paynow integration id/key, AES-256-GCM encrypted at rest.
 *     This worker is the ONLY place that ever holds the encryption master
 *     key (env.MERCHANT_CREDENTIALS_MASTER_KEY) or decrypts these values.
 *   - New routes: POST /merchant-credentials/connect, GET .../status,
 *     POST .../disconnect — used by the editor's "Connect Paynow" panel.
 *   - New internal route POST /deposit/charge — called by bookings-worker
 *     over a service binding when a Pro-tier booking with a deposit/full
 *     commitment level needs to charge the CUSTOMER, with the money going
 *     straight to the OWNER's own Paynow account (direct-collection model,
 *     not the platform's USD/ZiG integrations used for publish/renew/addons).
 *   - REQUIRES a companion migration adding a `booking_id` column to the
 *     existing `payments` table (see note above confirmDepositPaid below) —
 *     not included in this file since it touches a table this worker
 *     already owns; run it once alongside merchant-credentials-migration.sql.
 *
 * v1.5 CHANGE — DOMAIN REGISTRATION & NOTIFY WORKER INTEGRATION:
 *   - Added domain registration handling after successful payment
 *   - .com domains: Automatically registered via Cloudflare Registrar API
 *   - .co.zw domains: Admin notification for manual registration
 *   - Integrated with websites-notify-worker for WhatsApp notifications
 *   - Domain data passed from auth-worker on /pay requests
 *
 * v1.3/v1.4 CHANGE — addon purchases. Adds a second payment "kind" alongside
 * the existing site_plan flow (publish/renewal), for monthly addon
 * subscriptions (currently: Bookings Basic $12/mo, Bookings Pro $25/mo).
 *
 * Routes (on api.websites.co.zw):
 *   POST /pay                          initiate a publish/renewal OR addon payment via Paynow
 *   POST /paynow/result                Paynow's server webhook (resulturl)
 *   GET  /pay/status                   manual poll fallback
 *   GET  /pricing                      public pricing (USD + ZiG)
 *   POST /merchant-credentials/connect owner connects their own Paynow account
 *   GET  /merchant-credentials/status  connection status only, never secrets
 *   POST /merchant-credentials/disconnect  revoke a connected account
 *   POST /deposit/charge               INTERNAL — bookings-worker calls this via
 *                                       service binding to charge a customer deposit
 *                                       against the owner's own Paynow account
 *   OPTIONS *                          CORS preflight
 *
 * Bindings: DB (D1), NOTIFY_WORKER (Service binding -> websites-notify-worker)
 * Vars:     ALLOWED_ORIGIN, RESULT_URL, RETURN_URL, CF_ZONE_ID, CF_ACCOUNT_ID, ZIG_RATE
 * Secrets:  PAYNOW_USD_ID, PAYNOW_USD_KEY, PAYNOW_ZIG_ID, PAYNOW_ZIG_KEY,
 *           CF_API_TOKEN, MANYCHAT_API_TOKEN (fallback),
 *           MERCHANT_CREDENTIALS_MASTER_KEY (v1.6 — AES-256-GCM key, base64,
 *           generated once via generateMasterKey() below and added as a
 *           Cloudflare "Encrypt" secret — never a plain var, never logged)
 */

const PAYNOW_INITIATE_URL = "https://www.paynow.co.zw/interface/initiatetransaction";
const PAYNOW_REMOTE_URL = "https://www.paynow.co.zw/interface/remotetransaction";
const YEAR_SECONDS = 365 * 24 * 60 * 60;

// Plan pricing — the ONLY prices ever charged. Domains are bundled into
// these totals and are NEVER charged as a separate line item: Starter
// includes one free .co.zw domain, Pro includes a free .com AND .co.zw.
// Must stay in sync with PLAN_PRICES in auth-worker.js / customer.html.
const USD_PRICE = { starter: 30, pro: 50 };

// ZiG pricing for site plans (publish/renew). env.ZIG_RATE is set manually
// by an admin (e.g. weekly, off the RBZ rate) — NOT fetched live on every
// request, since a rate that moves between "customer sees price" and
// "payment settles" creates disputes and doesn't match how people actually
// think about round prices. ZIG_BUFFER_PCT is applied ON TOP of whatever
// rate is configured, to absorb normal slippage — this is a buffer, not a
// discount, and is intentionally separate from ZIG_STORE_DISCOUNT_PCT
// below, which serves the opposite purpose for a different product.
const ZIG_BUFFER_PCT = 0.06; // 6% buffer over the configured rate

// ZiG pricing for Store Payments checkout (products). Unlike site-plan
// pricing above, this is a genuine DISCOUNT off the live converted price,
// not a buffer on top of it — paying in ZiG is meant to be cheaper for the
// customer, not more expensive. Products are always entered in USD in the
// editor (there is no ZiG price field anywhere in editor.html), so every
// ZiG store purchase is converted here, per line item, at checkout time.
// See computeZigStorePrice() and its call site inside handleStoreCheckout.
const ZIG_STORE_DISCOUNT_PCT = 0.12; // 12% — middle of the agreed 10-15% range

// Paynow status strings that mean the money is in.
const PAID_STATUSES = new Set(["paid", "awaiting delivery", "delivered"]);
const DEAD_STATUSES = new Set(["cancelled", "failed", "disputed", "refunded"]);

// USD addon price list, by addon_type then tier.
// Template unlocks use a fixed tier of 'unlock' (not basic/pro) so they reuse
// handlePayAddon()'s existing tier-lookup validation unchanged -- only
// confirmPaidAddon() needs to treat 'template:*' addon_types differently
// (one-time / permanent instead of monthly).
const ADDON_USD_PRICE = {
  bookings: { basic: 12, pro: 25 },
  'template:hospitality-sands': { unlock: 15 },
  'template:hospitality-wild': { unlock: 15 },
  'template:beauty-atelier': { unlock: 15 },
  'template:beauty-maison': { unlock: 15 },
  'template:grill-noir': { unlock: 15 },
  'template:grill-market': { unlock: 15 },
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const { pathname } = url;

    if (request.method === "OPTIONS") return preflight(env);

    try {
      if (request.method === "POST" && pathname === "/pay") return await handlePay(request, env);
      if (request.method === "POST" && pathname === "/paynow/result") return await handleWebhook(request, env);
      if (request.method === "GET" && pathname === "/pay/status") return await handleStatus(url, env);
      if (request.method === "GET" && pathname === "/pricing") return await handlePricing(env);
      // Generic, read-only, browser-reachable addon status check. Distinct
      // from orders-worker's /addon-check (service-binding only, worker-to-
      // worker, unreachable from client JS) and from bookings-worker's own
      // /bookings/tier (bookings-specific). Any addon_type can use this --
      // added for template unlocks, but not template-specific.
      if (request.method === "GET" && pathname === "/addon-status") return await handleAddonStatus(url, env);

      // v1.6 — owner Paynow credential management + deposit charging
      if (request.method === "POST" && pathname === "/merchant-credentials/connect") return await handleConnectMerchant(request, env);
      // Store Payments billing — the $20/mo subscription gate in front of
      // connecting Paynow at all. Reuses the existing generic
      // GET /pay/status?ref= for polling (no separate status route needed).
      if (request.method === "POST" && pathname === "/store-payments/purchase") return await handleStorePaymentsPurchase(request, env);
      if (request.method === "GET" && pathname === "/merchant-credentials/status") return await handleMerchantStatus(url, env);
      if (request.method === "POST" && pathname === "/merchant-credentials/disconnect") return await handleDisconnectMerchant(request, env);
      if (request.method === "POST" && pathname === "/deposit/charge") return await handleDepositCharge(request, env);
      // Store Payments — customer-facing "Pay online" checkout, called
      // directly from the storefront's browser (Commerce SDK), not from
      // another worker. See handleStoreCheckout for why amounts are always
      // recomputed server-side rather than trusted from the request body.
      if (request.method === "POST" && pathname === "/store/checkout") return await handleStoreCheckout(request, env);
      // Digital delivery — capability-link download. The token IS the
      // access control (no login, no site session needed): if you have the
      // URL, you paid for it. Only ever reachable after a real payment
      // confirms (token is null until confirmStorePurchasePaid sets it).
      if (request.method === "GET" && pathname.startsWith("/store/download/")) return await handleStoreDownload(request, env, pathname);
    } catch (err) {
      return json({ error: "internal_error", detail: String(err && err.message || err) }, 500, env);
    }
    return json({ error: "not_found" }, 404, env);
  },
};

/* ========================================================================= *
 * POST /pay  — initiate
 * site_plan body: { site_id, currency: "USD"|"ZIG", purpose?: "publish"|"renewal", email?, domain_data? }
 * domain_data: { name, type: "com"|"cozw"|"own", choices? }
 *
 * NOTE: ZiG amount is now derived server-side from env.ZIG_RATE — the
 * client no longer sends (or can influence) the ZiG amount. See
 * zigAmountFor() below.
 * ========================================================================= */
async function handlePay(request, env) {
  let body;
  try { body = await request.json(); } catch { return json({ error: "bad_json" }, 400, env); }

  const kind = body.kind === "addon" ? "addon" : "site_plan";
  return kind === "addon" ? await handlePayAddon(body, env) : await handlePaySitePlan(body, env);
}

// Derive the ZiG amount for a plan from the admin-configured rate, rounded
// to a clean whole number and buffered against rate movement. Returns null
// if no rate is configured yet, so callers can fail closed instead of
// falling back to something arbitrary.
function zigAmountFor(plan, env) {
  const rate = Number(env.ZIG_RATE);
  if (!rate || rate <= 0) return null;
  const usd = USD_PRICE[plan] ?? USD_PRICE.starter;
  return Math.ceil(usd * rate * (1 + ZIG_BUFFER_PCT));
}

// v1.10 — Derive the ZiG price for ONE Store Payments line item from the
// admin-configured rate, with a genuine discount applied (not a buffer —
// see the ZIG_STORE_DISCOUNT_PCT comment above). usdAmount is the item's
// already-resolved USD unit price (base_price + variant price_delta, from
// handleStoreCheckout's own re-pricing against the products/product_variants
// tables — never anything from the request body). Returns null if no rate
// is configured, so the caller can fail closed (503) rather than silently
// charging a USD number to a ZiG account.
function computeZigStorePrice(usdAmount, env) {
  const rate = Number(env.ZIG_RATE);
  if (!rate || rate <= 0) return null;
  const raw = usdAmount * rate * (1 - ZIG_STORE_DISCOUNT_PCT);
  return Math.round(raw * 100) / 100;
}

// site_plan flow — rewritten to match the ZVAKHO EcoCash phone-push pattern
// (POST /interface/remotetransaction with phone + method:"ecocash") instead
// of the old hosted-redirect flow (POST /interface/initiatetransaction).
// The old flow also had no fallback for env.RESULT_URL / env.RETURN_URL —
// if either var wasn't actually set on this Worker, it silently became the
// literal string "undefined" inside the Paynow request, which Paynow
// rejects outright as a malformed URL. That's the most likely explanation
// for the paynow_error you were seeing. Both now fall back to a sane
// default so a missing var degrades instead of breaking checkout.
async function handlePaySitePlan(body, env) {
  const siteId = body.site_id;
  const currency = String(body.currency || "").toUpperCase();
  const purpose = body.purpose === "renewal" ? "renewal" : "publish";
  const domainData = body.domain_data || null;
  const phone = formatZimPhone(body.phone);
  // Paynow's Express Checkout / EcoCash push requires a real customer
  // email — the old silent fallback to noreply@websites.co.zw would
  // either get rejected by Paynow outright or produce a receipt nobody
  // can actually read. Sign-in here is phone/WhatsApp-based, so an owner
  // frequently has no email on file at all; it must be collected at
  // checkout instead, same as phone already is.
  const email = typeof body.email === "string" ? body.email.trim() : "";

  if (!siteId) return json({ error: "missing_site_id" }, 400, env);
  if (currency !== "USD" && currency !== "ZIG") return json({ error: "bad_currency" }, 400, env);
  if (!phone) return json({ error: "missing_phone", message: "Enter the phone number you'll approve the EcoCash prompt on." }, 400, env);
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json({ error: "missing_or_invalid_email", message: "Enter a valid email for your Paynow receipt." }, 400, env);

  const creds = integrationFor(currency, env);
  if (!creds) return json({ error: "currency_unavailable", currency }, 400, env);

  const site = await env.DB
    .prepare("SELECT id, owner_id, status, plan FROM sites WHERE id = ?1")
    .bind(siteId).first();
  if (!site) return json({ error: "site_not_found" }, 404, env);

  // Amount: USD from the price list. ZiG is derived server-side from
  // env.ZIG_RATE — we NEVER trust a client-supplied amount for money owed.
  let amount;
  if (currency === "USD") {
    amount = USD_PRICE[site.plan] ?? USD_PRICE.starter;
  } else {
    amount = zigAmountFor(site.plan, env);
    if (amount == null) return json({ error: "zig_rate_not_configured" }, 503, env);
  }

  const reference = `WCZ-${crypto.randomUUID().replace(/-/g, "")}`;

  // Create the pending payment row with domain data
  await env.DB.prepare(
    `INSERT INTO payments (id, site_id, reference, integration, currency, amount, purpose, status, kind, 
                           domain_name, domain_type, domain_cost, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'pending', 'site_plan', ?8, ?9, ?10, unixepoch())`
  ).bind(
    crypto.randomUUID(), 
    siteId, 
    reference, 
    creds.kind, 
    currency, 
    amount, 
    purpose,
    domainData?.name || null,
    domainData?.type || null,
    domainData?.cost || null
  ).run();

  // For a first publish, move the site into pending_payment (only from draft).
  if (purpose === "publish") {
    await env.DB.prepare(
      "UPDATE sites SET status='pending_payment', updated_at=unixepoch() WHERE id=?1 AND status='draft'"
    ).bind(siteId).run();
  }

  // resulturl is the only one Paynow actually calls back on for this flow
  // (there's no browser redirect with remotetransaction — the customer
  // approves a push notification on their phone). Both get a safe default
  // so a missing dashboard var can't silently corrupt the request.
  const resultUrl = env.RESULT_URL || "https://api.websites.co.zw/paynow/result";
  const returnUrl = env.RETURN_URL || "https://www.websites.co.zw/checkout/";

  const fields = {
    resulturl: resultUrl,
    returnurl: `${returnUrl}?site=${encodeURIComponent(siteId)}&purpose=${encodeURIComponent(purpose)}&ref=${encodeURIComponent(reference)}`,
    reference,
    amount: amount.toFixed(2),
    id: creds.id,
    additionalinfo: `websites.co.zw ${purpose} (${currency})`,
    authemail: email,
    phone,
    method: "ecocash",
    status: "Message",
  };
  const hash = await generateFieldsHash(fields, creds.key);

  const pnResp = await fetch(PAYNOW_REMOTE_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ ...fields, hash }).toString(),
  });
  const parsed = parseForm(await pnResp.text());

  if ((parsed.get("status") || "").toLowerCase() !== "ok") {
    await markPayment(env, reference, "failed");
    if (purpose === "publish") await revertToDraft(env, siteId);
    return json({ error: "paynow_error", detail: parsed.get("error") || "initiate failed" }, 502, env);
  }

  const pollUrl = parsed.get("pollurl");
  if (!pollUrl) {
    await markPayment(env, reference, "failed");
    if (purpose === "publish") await revertToDraft(env, siteId);
    return json({ error: "paynow_error", detail: "Paynow did not return a poll_url" }, 502, env);
  }
  await env.DB.prepare("UPDATE payments SET poll_url=?2 WHERE reference=?1")
    .bind(reference, pollUrl).run();

  // No redirect_url anymore — this is a phone push, not a hosted page.
  // The frontend shows "check your phone" and polls poll_url until paid.
  return json({ reference, poll_url: pollUrl, status: "pending" }, 200, env);
}

// v1.4 addon flow -- unchanged. Addons stay USD-only for now.
async function handlePayAddon(body, env) {
  const siteId = body.site_id;
  const addonType = body.addon_type;
  const tier = body.tier;
  const phone = formatZimPhone(body.phone);
  const email = typeof body.email === "string" ? body.email.trim() : "";
  if (!siteId) return json({ error: "missing_site_id" }, 400, env);
  if (!phone) return json({ error: "missing_phone" }, 400, env);
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json({ error: "missing_or_invalid_email" }, 400, env);
  if (!addonType || !ADDON_USD_PRICE[addonType]) return json({ error: "bad_addon_type" }, 400, env);
  if (!tier || !ADDON_USD_PRICE[addonType][tier]) return json({ error: "bad_tier" }, 400, env);

  const currency = "USD";
  const creds = integrationFor(currency, env);
  if (!creds) return json({ error: "currency_unavailable", currency }, 400, env);

  const site = await env.DB.prepare("SELECT id FROM sites WHERE id = ?1").bind(siteId).first();
  if (!site) return json({ error: "site_not_found" }, 404, env);

  const amount = ADDON_USD_PRICE[addonType][tier];
  const reference = `WCZ-ADDON-${crypto.randomUUID().replace(/-/g, "")}`;

  await env.DB.prepare(
    `INSERT INTO payments (id, site_id, reference, integration, currency, amount, purpose, status, kind, addon_type, addon_tier, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'addon_purchase', 'pending', 'addon', ?7, ?8, unixepoch())`
  ).bind(crypto.randomUUID(), siteId, reference, creds.kind, currency, amount, addonType, tier).run();

  const fields = {
    resulturl: env.RESULT_URL,
    returnurl: env.RESULT_URL,
    reference: reference,
    amount: amount.toFixed(2),
    id: creds.id,
    additionalinfo: `websites.co.zw ${addonType} ${tier} addon (${currency})`,
    authemail: email,
    phone: phone,
    method: "ecocash",
    status: "Message",
  };
  const hash = await generateFieldsHash(fields, creds.key);

  const pnResp = await fetch(PAYNOW_REMOTE_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ ...fields, hash }).toString(),
  });
  const parsed = parseForm(await pnResp.text());

  if ((parsed.get("status") || "").toLowerCase() !== "ok") {
    await markPayment(env, reference, "failed");
    return json({ error: "paynow_error", detail: parsed.get("error") || "initiate failed" }, 502, env);
  }

  const pollUrl = parsed.get("pollurl");
  if (!pollUrl) {
    await markPayment(env, reference, "failed");
    return json({ error: "paynow_error", detail: "Paynow did not return a poll_url" }, 502, env);
  }
  await env.DB.prepare("UPDATE payments SET poll_url=?2 WHERE reference=?1")
    .bind(reference, pollUrl).run();

  return json({ reference: reference, poll_url: pollUrl, status: "pending" }, 200, env);
}

function formatZimPhone(phone) {
  if (!phone) return "";
  let cleaned = String(phone).replace(/\D/g, "");
  if (cleaned.startsWith("263")) cleaned = "0" + cleaned.slice(3);
  return cleaned;
}

async function generateFieldsHash(fields, key) {
  let str = "";
  for (const k of Object.keys(fields)) {
    if (k !== "hash") str += fields[k];
  }
  str += key;
  return sha512Upper(str);
}

// GET /pricing — public, unauthenticated. Lets the frontend show live USD +
// ZiG totals without ever touching a Worker secret. ZiG is null (not 0)
// when env.ZIG_RATE isn't configured, so the frontend can tell "not set up
// yet" apart from "free" and keep the ZiG option disabled correctly.
async function handlePricing(env) {
  var rate = Number(env.ZIG_RATE) || null;
  return json({
    ok: true,
    usd: USD_PRICE,
    zig: rate ? { starter: zigAmountFor("starter", env), pro: zigAmountFor("pro", env) } : null,
    zig_rate: rate,
    zig_buffer_pct: ZIG_BUFFER_PCT,
  }, 200, env);
}

/* ========================================================================= *
 * v1.6 — OWNER PAYNOW CREDENTIALS (direct-collection deposit model)
 *
 * Owners connect their OWN Paynow merchant account so that booking deposits
 * land directly in their pocket, not the platform's. Credentials are
 * AES-256-GCM encrypted at rest — see encryptSecret/decryptSecret below.
 * This worker is the only one bound to MERCHANT_CREDENTIALS_MASTER_KEY.
 *
 * Requires merchant-credentials-migration.sql to have been run against
 * this worker's D1 database first.
 * ========================================================================= */

// POST /merchant-credentials/connect
// body: { site_id, integration_id, integration_key, phone }
// `phone` is the OWNER's own EcoCash number — used to push a $0.01 test
// transaction so a typo'd key is caught immediately instead of on a real
// customer's deposit. Auth: caller must already be verified as this site's
// owner upstream (reuse the existing auth-worker session check) before
// this route is ever reached — do not trust site_id alone.
async function handleConnectMerchant(request, env) {
  if (!env.MERCHANT_CREDENTIALS_MASTER_KEY) {
    return json({ error: "master_key_not_configured" }, 503, env);
  }

  let body;
  try { body = await request.json(); } catch { return json({ error: "bad_json" }, 400, env); }

  const { site_id, integration_id, integration_key } = body;

  // Store Payments billing gate — must be exempt or have an active
  // subscription before connecting Paynow at all. Checked here, not just
  // in the editor UI, since this route is reachable directly.
  const subActive = await isStorePaymentsActive(env, site_id);
  if (!subActive) {
    return json({ error: "subscription_required", message: "Store Payments requires an active subscription before you can connect Paynow." }, 402, env);
  }

  const phone = formatZimPhone(body.phone);
  // v1.9 — the owner's own Paynow login email. Required because Paynow
  // rejects a test-mode transaction unless `authemail` matches one of the
  // merchant account's actual login addresses (see Paynow's Test Mode
  // docs). Previously this was hardcoded to a placeholder address, which
  // meant EVERY connection attempt failed verification regardless of
  // whether the Integration ID/Key were correct. Stored alongside the
  // credentials so future re-verification doesn't need to ask again.
  const email = typeof body.email === "string" ? body.email.trim() : "";
  // v1.8 — which currency this Paynow account is registered for. Paynow
  // (like the platform's own PAYNOW_USD_ID/PAYNOW_ZIG_ID split) doesn't take
  // currency as a per-transaction field on a single integration — the
  // integration ID/key pair itself IS currency-locked on Paynow's side. So
  // this is the owner telling us which one they connected, not something we
  // can detect. Defaults to USD since that's what most SME EcoCash merchant
  // accounts in this market are set up as today.
  const currency = body.currency === "ZIG" ? "ZIG" : "USD";

  if (!site_id || !integration_id || !integration_key) {
    return json({ error: "missing_fields", message: "site_id, integration_id, and integration_key are required" }, 400, env);
  }
  if (!phone) {
    return json({ error: "missing_phone", message: "Enter the EcoCash number to send a test transaction to." }, 400, env);
  }
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return json({ error: "missing_or_invalid_email", message: "Enter the email address you log into your Paynow account with — Paynow requires this to match for test transactions." }, 400, env);
  }

  const site = await env.DB.prepare("SELECT id FROM sites WHERE id = ?1").bind(site_id).first();
  if (!site) return json({ error: "site_not_found" }, 404, env);

  const idEnc = await encryptSecret(integration_id, env.MERCHANT_CREDENTIALS_MASTER_KEY);
  const keyEnc = await encryptSecret(integration_key, env.MERCHANT_CREDENTIALS_MASTER_KEY);
  const now = new Date().toISOString();

  await env.DB.prepare(`
    INSERT INTO merchant_credentials
      (id, site_id, integration_id_ciphertext, integration_id_iv,
       integration_key_ciphertext, integration_key_iv,
       key_version, status, currency, email, created_at, updated_at)
    VALUES (?1, ?2, ?3, ?4, ?5, ?6, 1, 'pending', ?7, ?8, ?9, ?9)
    ON CONFLICT(site_id) DO UPDATE SET
      integration_id_ciphertext = excluded.integration_id_ciphertext,
      integration_id_iv = excluded.integration_id_iv,
      integration_key_ciphertext = excluded.integration_key_ciphertext,
      integration_key_iv = excluded.integration_key_iv,
      currency = excluded.currency,
      email = excluded.email,
      status = 'pending',
      updated_at = excluded.updated_at
  `).bind(
    crypto.randomUUID(), site_id,
    idEnc.ciphertext, idEnc.iv,
    keyEnc.ciphertext, keyEnc.iv,
    currency, email, now
  ).run();

  const verified = await verifyMerchantCredentials(site_id, phone, email, env);

  return json({
    connected: true,
    verified: verified.ok,
    message: verified.ok
      ? "Paynow account connected. Approve the small test prompt on your phone to finish verifying."
      : `Connected, but verification failed: ${verified.reason}`,
  }, 200, env);
}

/* ========================================================================= *
 * Store Payments billing helpers.
 *
 * billing_exempt is a manual, no-UI escape hatch (set directly via SQL) —
 * used for demo sites that should never be gated, and for deliberately
 * testing the real charge flow on your own sites before any real customer
 * hits it. Nothing in the app ever sets this flag; it's owner-operator only.
 * ========================================================================= */
async function isStorePaymentsActive(env, siteId) {
  if (!siteId || !env.DB) return false;
  const row = await env.DB.prepare(
    "SELECT status, billing_exempt, current_period_end FROM store_payments_subscriptions WHERE site_id = ?1"
  ).bind(siteId).first();
  if (!row) return false;
  if (row.billing_exempt) return true;
  if (row.status !== "active") return false;
  if (!row.current_period_end) return false;
  return Number(row.current_period_end) > Math.floor(Date.now() / 1000);
}

async function getStorePaymentsSubscriptionSummary(env, siteId) {
  if (!siteId || !env.DB) return { active: false, exempt: false, status: "inactive", current_period_end: null };
  const row = await env.DB.prepare(
    "SELECT status, billing_exempt, current_period_end FROM store_payments_subscriptions WHERE site_id = ?1"
  ).bind(siteId).first();
  if (!row) return { active: false, exempt: false, status: "inactive", current_period_end: null };
  const exempt = !!row.billing_exempt;
  const active = exempt || (row.status === "active" && !!row.current_period_end && Number(row.current_period_end) > Math.floor(Date.now() / 1000));
  return { active, exempt, status: row.status, current_period_end: row.current_period_end };
}

/* ========================================================================= *
 * POST /store-payments/purchase — the $20/mo Store Payments subscription
 * charge itself. This is a PLATFORM charge (Ya-Sibo Media collects it),
 * not owner_direct — the opposite trust model from booking deposits and
 * store checkout, which pay the site owner directly. Uses the same
 * env.PAYNOW_USD_ID/KEY platform credentials as regular site plan
 * payments (see integrationByKind).
 * ========================================================================= */
async function handleStorePaymentsPurchase(request, env) {
  let body;
  try { body = await request.json(); } catch { return json({ error: "bad_json" }, 400, env); }

  const { site_id } = body;
  if (!site_id) return json({ error: "missing_site_id" }, 400, env);

  const phone = formatZimPhone(body.phone);
  if (!phone) return json({ error: "missing_phone" }, 400, env);
  const email = typeof body.email === "string" && body.email.trim() ? body.email.trim() : "receipt@websites.co.zw";

  const creds = integrationByKind("usd", env);
  if (!creds) return json({ error: "platform_integration_not_configured" }, 503, env);

  const amount = 20;
  const currency = "USD";
  const reference = `WCZ-STOREPAY-${crypto.randomUUID().replace(/-/g, "")}`;
  const resultUrl = env.RESULT_URL || "https://api.websites.co.zw/paynow/result";
  const paymentId = crypto.randomUUID();

  await env.DB.prepare(
    `INSERT INTO payments (id, site_id, reference, integration, currency, amount, purpose, status, kind, created_at)
     VALUES (?1, ?2, ?3, 'usd', ?4, ?5, 'store_payments_subscription', 'pending', 'store_payments_subscription', unixepoch())`
  ).bind(paymentId, site_id, reference, currency, amount).run();

  await env.DB.prepare(
    `INSERT INTO store_payments_subscriptions (site_id, status, updated_at)
     VALUES (?1, 'pending', unixepoch())
     ON CONFLICT(site_id) DO UPDATE SET status='pending', updated_at=unixepoch()`
  ).bind(site_id).run();

  const fields = {
    resulturl: resultUrl,
    returnurl: resultUrl,
    reference,
    amount: amount.toFixed(2),
    id: creds.id,
    additionalinfo: "websites.co.zw Store Payments — monthly subscription",
    authemail: email,
    phone,
    method: "ecocash",
    status: "Message",
  };
  const hash = await generateFieldsHash(fields, creds.key);

  const pnResp = await fetch(PAYNOW_REMOTE_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ ...fields, hash }).toString(),
  });
  const parsed = parseForm(await pnResp.text());

  if ((parsed.get("status") || "").toLowerCase() !== "ok") {
    await markPayment(env, reference, "failed");
    return json({ error: "paynow_error", detail: parsed.get("error") || "initiate failed" }, 502, env);
  }
  const pollUrl = parsed.get("pollurl");
  if (!pollUrl) {
    await markPayment(env, reference, "failed");
    return json({ error: "paynow_error", detail: "Paynow did not return a poll_url" }, 502, env);
  }
  await env.DB.prepare("UPDATE payments SET poll_url=?2 WHERE reference=?1").bind(reference, pollUrl).run();

  return json({ reference, poll_url: pollUrl, status: "pending", currency, amount }, 200, env);
}

// GET /merchant-credentials/status?site_id=...
// Returns connection status only — NEVER the credentials themselves.
// Also returns subscription state, so the editor can decide in one call
// whether to show the paywall, the connect form, or the connected view.
async function handleMerchantStatus(url, env) {
  const site_id = url.searchParams.get("site_id");
  if (!site_id) return json({ error: "missing_site_id" }, 400, env);

  const subscription = await getStorePaymentsSubscriptionSummary(env, site_id);

  const row = await env.DB.prepare(
    "SELECT status, currency, email, last_verified_at, updated_at FROM merchant_credentials WHERE site_id = ?1"
  ).bind(site_id).first();

  if (!row) return json({ connected: false, subscription }, 200, env);

  return json({
    connected: true,
    status: row.status,
    currency: row.currency || "USD",
    email: row.email || null,
    last_verified_at: row.last_verified_at,
    updated_at: row.updated_at,
    subscription,
  }, 200, env);
}

// POST /merchant-credentials/disconnect  body: { site_id }
// Marks as revoked rather than deleting — keeps an audit trail.
async function handleDisconnectMerchant(request, env) {
  let body;
  try { body = await request.json(); } catch { return json({ error: "bad_json" }, 400, env); }
  const { site_id } = body;
  if (!site_id) return json({ error: "missing_site_id" }, 400, env);

  await env.DB.prepare(
    "UPDATE merchant_credentials SET status='revoked', updated_at=?2 WHERE site_id=?1"
  ).bind(site_id, new Date().toISOString()).run();

  return json({ disconnected: true }, 200, env);
}

// Fires a nominal ($0.01) EcoCash push to the OWNER's own phone using
// THEIR OWN decrypted credentials — reuses the exact same
// generateFieldsHash/PAYNOW_REMOTE_URL pattern as the platform's own
// site_plan/addon flows above, just parameterized per-owner. If the
// integration id/key pair is wrong, Paynow's hash check fails and the
// initiate call comes back with status != "ok", which is enough to mark
// the credentials 'failed' without needing to wait for a completed charge.
async function verifyMerchantCredentials(site_id, ownerPhone, ownerEmail, env) {
  const row = await env.DB.prepare(
    `SELECT integration_id_ciphertext, integration_id_iv,
            integration_key_ciphertext, integration_key_iv
     FROM merchant_credentials WHERE site_id = ?1`
  ).bind(site_id).first();
  if (!row) return { ok: false, reason: "no credentials on file" };

  const integrationId = await decryptSecret(row.integration_id_ciphertext, row.integration_id_iv, env.MERCHANT_CREDENTIALS_MASTER_KEY);
  const integrationKey = await decryptSecret(row.integration_key_ciphertext, row.integration_key_iv, env.MERCHANT_CREDENTIALS_MASTER_KEY);

  const resultUrl = env.RESULT_URL || "https://api.websites.co.zw/paynow/result";
  const testReference = `WCZ-VERIFY-${crypto.randomUUID().replace(/-/g, "")}`;

  const fields = {
    resulturl: resultUrl,
    returnurl: resultUrl,
    reference: testReference,
    amount: "0.01",
    id: integrationId,
    additionalinfo: "websites.co.zw Paynow connection test",
    // v1.9 — the owner's own Paynow login email, not a hardcoded
    // placeholder. Paynow's test-mode transactions are rejected unless
    // authemail matches one of the merchant account's actual login
    // addresses, so this field being wrong silently failed every
    // verification attempt regardless of whether the ID/Key were correct.
    authemail: ownerEmail,
    phone: ownerPhone,
    method: "ecocash",
    status: "Message",
  };

  let status = "failed";
  let reason = "unknown error";

  try {
    const hash = await generateFieldsHash(fields, integrationKey);
    const pnResp = await fetch(PAYNOW_REMOTE_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ ...fields, hash }).toString(),
    });
    const parsed = parseForm(await pnResp.text());
    if ((parsed.get("status") || "").toLowerCase() === "ok" && parsed.get("pollurl")) {
      status = "verified";
      reason = null;
    } else {
      reason = parsed.get("error") || "Paynow rejected the credentials";
    }
  } catch (err) {
    reason = String(err && err.message || err);
  }

  const now = new Date().toISOString();
  await env.DB.prepare(
    "UPDATE merchant_credentials SET status=?2, last_verified_at=?3, updated_at=?3 WHERE site_id=?1"
  ).bind(site_id, status, now).run();

  return status === "verified" ? { ok: true } : { ok: false, reason };
}

/* ========================================================================= *
 * v1.6 — POST /deposit/charge  (INTERNAL — service binding from bookings-worker)
 * body: { site_id, booking_id, amount, customer_phone, customer_email? }
 *
 * amount is trusted here because the caller is bookings-worker over a
 * service binding, not a public client — bookings-worker is responsible
 * for computing it server-side from the service's deposit_amount /
 * deposit_percent, never from anything the customer sent.
 *
 * NOTE: this INSERTs into the existing `payments` table with kind='deposit'
 * and a booking_id column. That column doesn't exist yet on `payments` —
 * run this migration once before deploying v1.6:
 *   ALTER TABLE payments ADD COLUMN booking_id TEXT;
 * ========================================================================= */
async function handleDepositCharge(request, env) {
  let body;
  try { body = await request.json(); } catch { return json({ error: "bad_json" }, 400, env); }

  const { site_id, booking_id, amount, customer_phone, customer_email } = body;
  const phone = formatZimPhone(customer_phone);
  const email = typeof customer_email === "string" && customer_email.trim()
    ? customer_email.trim()
    : "receipt@websites.co.zw";

  if (!site_id || !booking_id) return json({ error: "missing_site_id_or_booking_id" }, 400, env);
  if (!phone) return json({ error: "missing_customer_phone" }, 400, env);
  const parsedAmount = Number(amount);
  if (!parsedAmount || parsedAmount <= 0) return json({ error: "bad_amount" }, 400, env);

  const credRow = await env.DB.prepare(
    `SELECT integration_id_ciphertext, integration_id_iv,
            integration_key_ciphertext, integration_key_iv, status, currency
     FROM merchant_credentials WHERE site_id = ?1`
  ).bind(site_id).first();

  if (!credRow || credRow.status !== "verified") {
    return json({ error: "owner_not_connected", message: "Owner has not connected a verified Paynow account for deposits." }, 409, env);
  }

  const currency = credRow.currency === "ZIG" ? "ZIG" : "USD";
  const integrationId = await decryptSecret(credRow.integration_id_ciphertext, credRow.integration_id_iv, env.MERCHANT_CREDENTIALS_MASTER_KEY);
  const integrationKey = await decryptSecret(credRow.integration_key_ciphertext, credRow.integration_key_iv, env.MERCHANT_CREDENTIALS_MASTER_KEY);

  const reference = `WCZ-DEP-${crypto.randomUUID().replace(/-/g, "")}`;
  const resultUrl = env.RESULT_URL || "https://api.websites.co.zw/paynow/result";

  await env.DB.prepare(
    `INSERT INTO payments (id, site_id, booking_id, reference, integration, currency, amount, purpose, status, kind, created_at)
     VALUES (?1, ?2, ?3, ?4, 'owner_direct', ?5, ?6, 'booking_deposit', 'pending', 'deposit', unixepoch())`
  ).bind(crypto.randomUUID(), site_id, booking_id, reference, currency, parsedAmount).run();

  const fields = {
    resulturl: resultUrl,
    returnurl: resultUrl,
    reference,
    amount: parsedAmount.toFixed(2),
    id: integrationId,
    additionalinfo: `websites.co.zw booking deposit (${booking_id})`,
    authemail: email,
    phone,
    method: "ecocash",
    status: "Message",
  };
  const hash = await generateFieldsHash(fields, integrationKey);

  const pnResp = await fetch(PAYNOW_REMOTE_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ ...fields, hash }).toString(),
  });
  const parsed = parseForm(await pnResp.text());

  if ((parsed.get("status") || "").toLowerCase() !== "ok") {
    await markPayment(env, reference, "failed");
    return json({ error: "paynow_error", detail: parsed.get("error") || "initiate failed" }, 502, env);
  }

  const pollUrl = parsed.get("pollurl");
  if (!pollUrl) {
    await markPayment(env, reference, "failed");
    return json({ error: "paynow_error", detail: "Paynow did not return a poll_url" }, 502, env);
  }
  await env.DB.prepare("UPDATE payments SET poll_url=?2 WHERE reference=?1").bind(reference, pollUrl).run();

  // bookings-worker polls this same /pay/status?ref=... endpoint you already
  // have, or you can add a dedicated /deposit/status alias later if you'd
  // rather keep booking-specific polling separate from site_plan/addon polling.
  return json({ reference, poll_url: pollUrl, status: "pending", currency }, 200, env);
}

/* ========================================================================= *
 * POST /store/checkout — Store Payments "Pay online" checkout.
 *
 * Called DIRECTLY from the storefront's browser (Commerce SDK's cart), not
 * from another worker — this is the first owner_direct route reachable by
 * an anonymous customer rather than an authenticated dashboard/worker call.
 * That changes the trust model versus /deposit/charge in one critical way:
 * the request body is customer-controlled, so price/stock are NEVER taken
 * from it. Every line item is re-priced and re-checked against the real
 * `products` / `product_variants` rows before a single cent moves — the
 * client only gets to say WHICH product/variant and HOW MANY, never HOW
 * MUCH. This is the same trust boundary Zig-amount derivation already
 * follows platform-wide (env.ZIG_RATE computed server-side, never client-
 * supplied) — same principle, new surface.
 *
 * Body: { site_id, items:[{product_id, variant_id?, qty}], customer_name,
 *         customer_phone, customer_email?, shipping_address? }
 *
 * shipping_address is required if ANY item in the cart is product_type
 * 'physical'. Digital-only carts don't need it. Mixed carts require it
 * (the physical item still needs to reach someone).
 *
 * v1.10 — line items are priced in USD first (from products/product_variants,
 * exactly as before), then converted to ZiG per item via
 * computeZigStorePrice() when the owner's connected account is ZiG — see
 * that function and the ZIG_STORE_DISCOUNT_PCT comment above. Conversion
 * happens AFTER re-pricing/stock checks, so the stock/availability logic
 * below is entirely unaffected — only the final unit_price/total numbers
 * differ by currency.
 *
 * NOTE: this INSERTs into `orders` with a `payment_id` column and into
 * `payments` with purpose='store_purchase' — both already added by the
 * Phase 1 migrations. No new schema needed here.
 * ========================================================================= */
async function handleStoreCheckout(request, env) {
  let body;
  try { body = await request.json(); } catch { return json({ error: "bad_json" }, 400, env); }

  const { site_id, items, customer_name, customer_phone, customer_email, shipping_address } = body;

  if (!site_id) return json({ error: "missing_site_id" }, 400, env);
  if (!Array.isArray(items) || !items.length) return json({ error: "empty_cart" }, 400, env);

  const phone = formatZimPhone(customer_phone);
  if (!phone) return json({ error: "missing_customer_phone" }, 400, env);

  const email = typeof customer_email === "string" && customer_email.trim()
    ? customer_email.trim()
    : "receipt@websites.co.zw";
  const name = typeof customer_name === "string" && customer_name.trim() ? customer_name.trim() : "Customer";

  // 1. Owner must have a verified Paynow connection for this site — same
  //    gate as booking deposits, same table, same "not connected" shape.
  const credRow = await env.DB.prepare(
    `SELECT integration_id_ciphertext, integration_id_iv,
            integration_key_ciphertext, integration_key_iv, status, currency, email
     FROM merchant_credentials WHERE site_id = ?1`
  ).bind(site_id).first();

  if (!credRow || credRow.status !== "verified") {
    return json({ error: "owner_not_connected", message: "This store has not connected online payments yet." }, 409, env);
  }
  const currency = credRow.currency === "ZIG" ? "ZIG" : "USD";

  // 2. Re-price and re-check stock for every line item server-side. Cap
  //    cart size defensively — a real storefront cart is never 200 lines.
  if (items.length > 50) return json({ error: "cart_too_large" }, 400, env);

  const lineItems = [];
  let total = 0;
  let hasPhysical = false;
  let hasDigital = false;

  for (const raw of items) {
    const productId = raw && raw.product_id;
    const variantId = raw && raw.variant_id ? String(raw.variant_id) : null;
    const qty = Number(raw && raw.qty);
    if (!productId || !qty || qty <= 0 || qty > 999) {
      return json({ error: "bad_line_item", detail: "each item needs a product_id and a positive qty" }, 400, env);
    }

    const product = await env.DB.prepare(
      `SELECT id, site_id, name, product_type, base_price, has_variants, stock, status
       FROM products WHERE id = ?1 AND site_id = ?2`
    ).bind(productId, site_id).first();

    if (!product || product.status !== "active") {
      return json({ error: "product_unavailable", product_id: productId }, 409, env);
    }

    let unitPrice = product.base_price;
    let variantSku = null;

    if (product.has_variants) {
      if (!variantId) {
        return json({ error: "variant_required", product_id: productId }, 400, env);
      }
      const variant = await env.DB.prepare(
        `SELECT id, product_id, sku, option_values, price_delta, stock, status
         FROM product_variants WHERE id = ?1 AND product_id = ?2`
      ).bind(variantId, productId).first();

      if (!variant || variant.status !== "active") {
        return json({ error: "variant_unavailable", product_id: productId, variant_id: variantId }, 409, env);
      }
      if ((variant.stock || 0) < qty) {
        return json({ error: "insufficient_stock", product_id: productId, variant_id: variantId, available: variant.stock || 0 }, 409, env);
      }
      unitPrice = product.base_price + (variant.price_delta || 0);
      variantSku = variant.sku || null;
    } else {
      // No variants — stock may be untracked (NULL means "don't gate on it",
      // matching the adapter's own convention from render-worker).
      if (product.stock !== null && product.stock !== undefined && product.stock < qty) {
        return json({ error: "insufficient_stock", product_id: productId, available: product.stock }, 409, env);
      }
    }

    // v1.10 — unitPrice above is always the product's real USD price (base_
    // price + variant price_delta, both stored in USD — there is no ZiG
    // price field anywhere in the data model or the editor). Convert to ZiG
    // HERE, after stock/availability checks and before it's used for the
    // order total, so a ZiG-connected store charges the discounted
    // converted price instead of the raw USD number. USD stores are
    // completely unaffected — this block is a no-op for them.
    if (currency === "ZIG") {
      const converted = computeZigStorePrice(unitPrice, env);
      if (converted == null) {
        return json({ error: "zig_rate_not_configured", message: "Online payment in ZiG isn't available right now — please try again shortly." }, 503, env);
      }
      unitPrice = converted;
    }

    if (product.product_type === "digital") hasDigital = true;
    else hasPhysical = true;

    total += unitPrice * qty;
    lineItems.push({
      product_id: productId,
      variant_id: variantId,
      sku: variantSku,
      name: product.name,
      unit_price: Math.round(unitPrice * 100) / 100,
      qty,
      product_type: product.product_type,
    });
  }

  // Mixed carts (digital + physical in one order) are deliberately not
  // supported: a digital item delivers instantly via link, a physical one
  // doesn't, so bundling them either delays the digital link or the two
  // still end up handled separately anyway — no real benefit, only
  // confusion in the owner's order list. Customer checks these out as two
  // separate carts.
  if (hasPhysical && hasDigital) {
    return json({ error: "mixed_cart_not_supported", message: "Please check out digital and physical items separately." }, 400, env);
  }

  if (!total || total <= 0) return json({ error: "empty_total" }, 400, env);

  // Digital delivery is only ever allowed behind a real payment — that's
  // already guaranteed here since this whole route requires a verified
  // owner_direct connection. Physical items need somewhere to go.
  const shipAddr = typeof shipping_address === "string" ? shipping_address.trim() : "";
  if (hasPhysical && !shipAddr) {
    return json({ error: "missing_shipping_address" }, 400, env);
  }
  const fulfillmentType = hasPhysical ? "physical" : "digital";

  // Idempotency guard — no client-side dedupe key needed. If the same
  // phone number submits the exact same cart within a short window (a
  // double-tap, a slow network retry, a re-submitted form), return the
  // ALREADY-PENDING payment instead of firing a second EcoCash push.
  // Zimbabwean EcoCash charges aren't easily reversible, so preventing the
  // second push from ever going out is the right call here — cheaper and
  // safer than allowing a duplicate charge and then refunding it.
  const itemsJsonForDedupe = JSON.stringify(lineItems);
  const dupe = await env.DB.prepare(
    `SELECT p.reference, p.poll_url, p.currency, p.amount, o.id AS order_id
     FROM orders o JOIN payments p ON p.id = o.payment_id
     WHERE o.site_id = ?1 AND o.customer_phone = ?2 AND o.items_json = ?3
       AND p.status = 'pending' AND p.created_at > (unixepoch() - 180)
     ORDER BY p.created_at DESC LIMIT 1`
  ).bind(site_id, phone, itemsJsonForDedupe).first();

  if (dupe && dupe.poll_url) {
    return json({
      reference: dupe.reference, order_id: dupe.order_id, poll_url: dupe.poll_url,
      status: "pending", currency: dupe.currency, total: dupe.amount, deduped: true,
    }, 200, env);
  }

  const integrationId = await decryptSecret(credRow.integration_id_ciphertext, credRow.integration_id_iv, env.MERCHANT_CREDENTIALS_MASTER_KEY);
  const integrationKey = await decryptSecret(credRow.integration_key_ciphertext, credRow.integration_key_iv, env.MERCHANT_CREDENTIALS_MASTER_KEY);

  const reference = `WCZ-STORE-${crypto.randomUUID().replace(/-/g, "")}`;
  const resultUrl = env.RESULT_URL || "https://api.websites.co.zw/paynow/result";
  const paymentId = crypto.randomUUID();
  const orderId = "order_" + crypto.randomUUID().replace(/-/g, "");
  const nowIso = new Date().toISOString();

  await env.DB.prepare(
    `INSERT INTO payments (id, site_id, reference, integration, currency, amount, purpose, status, kind, created_at)
     VALUES (?1, ?2, ?3, 'owner_direct', ?4, ?5, 'store_purchase', 'pending', 'store_purchase', unixepoch())`
  ).bind(paymentId, site_id, reference, currency, total).run();

  await env.DB.prepare(
    `INSERT INTO orders (id, site_id, status, customer_name, customer_phone, items_json, total_usd, wa_message,
                          created_at, updated_at, created_epoch, payment_id, fulfillment_type, shipping_address)
     VALUES (?1, ?2, 'pending_payment', ?3, ?4, ?5, ?6, ?7, ?8, ?8, unixepoch(), ?9, ?10, ?11)`
  ).bind(
    orderId, site_id, name, phone, JSON.stringify(lineItems), total,
    `Online payment order — ${reference}`, nowIso, paymentId, fulfillmentType, shipAddr || null
  ).run();

  const fields = {
    resulturl: resultUrl,
    returnurl: resultUrl,
    reference,
    amount: total.toFixed(2),
    id: integrationId,
    additionalinfo: `websites.co.zw store order (${orderId})`,
    authemail: credRow.email || email,
    phone,
    method: "ecocash",
    status: "Message",
  };
  const hash = await generateFieldsHash(fields, integrationKey);

  const pnResp = await fetch(PAYNOW_REMOTE_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ ...fields, hash }).toString(),
  });
  const parsed = parseForm(await pnResp.text());

  if ((parsed.get("status") || "").toLowerCase() !== "ok") {
    await markPayment(env, reference, "failed");
    await env.DB.prepare("UPDATE orders SET status='payment_failed', updated_at=?2 WHERE id=?1").bind(orderId, new Date().toISOString()).run();
    return json({ error: "paynow_error", detail: parsed.get("error") || "initiate failed" }, 502, env);
  }

  const pollUrl = parsed.get("pollurl");
  if (!pollUrl) {
    await markPayment(env, reference, "failed");
    await env.DB.prepare("UPDATE orders SET status='payment_failed', updated_at=?2 WHERE id=?1").bind(orderId, new Date().toISOString()).run();
    return json({ error: "paynow_error", detail: "Paynow did not return a poll_url" }, 502, env);
  }
  await env.DB.prepare("UPDATE payments SET poll_url=?2 WHERE reference=?1").bind(reference, pollUrl).run();

  return json({ reference, order_id: orderId, poll_url: pollUrl, status: "pending", currency, total }, 200, env);
}

/* ========================================================================= *
 * GET /store/download/:token[?item=product_id]
 *
 * Serves the purchased digital file straight from R2. The token is the
 * entire access control — it's a long random UUID generated only after
 * confirmStorePurchasePaid sees a real 'paid' order, so possession of the
 * link IS proof of purchase (same model as most one-off digital-goods
 * checkouts — no login required, don't index/cache this URL).
 *
 * A digital order can have more than one distinct product (e.g. 2 different
 * ebooks bought together — still a single-fulfillment-type "digital" cart,
 * just multiple SKUs). If the order has exactly one digital line item, the
 * file streams immediately. If it has more than one, ?item=product_id picks
 * which one; omitting it returns a simple picker page listing each file.
 *
 * Requires an R2 bucket bound as env.DIGITAL_ASSETS — separate from
 * whatever bucket serves public product photos, since these must never be
 * publicly listable/guessable the way product images are.
 * ========================================================================= */
async function handleStoreDownload(request, env, pathname) {
  const token = pathname.replace('/store/download/', '').split('/')[0];
  if (!token) return new Response('Not found', { status: 404 });

  const order = await env.DB.prepare(
    "SELECT id, site_id, items_json, status FROM orders WHERE digital_download_token = ?1"
  ).bind(token).first();

  // Deliberately vague on failure — don't distinguish "no such token" from
  // "order not paid yet" to anyone probing URLs.
  if (!order || order.status !== 'paid') {
    return new Response('This download link is not valid.', { status: 404 });
  }

  let lineItems = [];
  try { lineItems = JSON.parse(order.items_json || '[]'); } catch { lineItems = []; }
  const digitalItems = lineItems.filter(i => i.product_type === 'digital');
  if (!digitalItems.length) return new Response('No digital items on this order.', { status: 404 });

  const url = new URL(request.url);
  const requestedItem = url.searchParams.get('item');
  const target = requestedItem
    ? digitalItems.find(i => i.product_id === requestedItem)
    : (digitalItems.length === 1 ? digitalItems[0] : null);

  if (!target) {
    // Multiple items, none specified — show a simple picker instead of
    // guessing. Plain HTML, no styling framework needed for a one-off page.
    const links = digitalItems.map(i =>
      `<li><a href="/store/download/${token}?item=${encodeURIComponent(i.product_id)}">${escapeHtml(i.name)}</a></li>`
    ).join('');
    return new Response(
      `<!doctype html><html><head><meta charset="utf-8"><title>Your downloads</title></head>
       <body style="font-family:sans-serif;max-width:480px;margin:60px auto;padding:0 20px">
       <h2>Your downloads</h2><ul>${links}</ul></body></html>`,
      { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } }
    );
  }

  if (!env.DIGITAL_ASSETS) {
    console.error('handleStoreDownload: DIGITAL_ASSETS R2 binding not configured');
    return new Response('Download temporarily unavailable — please contact the seller.', { status: 503 });
  }

  const product = await env.DB.prepare(
    "SELECT digital_asset_key, name FROM products WHERE id = ?1 AND site_id = ?2"
  ).bind(target.product_id, order.site_id).first();

  if (!product || !product.digital_asset_key) {
    return new Response('This file is no longer available — please contact the seller.', { status: 404 });
  }

  const object = await env.DIGITAL_ASSETS.get(product.digital_asset_key);
  if (!object) {
    console.error('handleStoreDownload: R2 object missing for key', product.digital_asset_key);
    return new Response('This file is no longer available — please contact the seller.', { status: 404 });
  }

  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set('content-disposition', `attachment; filename="${(product.name || 'download').replace(/[^\w.\- ]/g, '')}"`);
  headers.set('cache-control', 'private, no-store');
  return new Response(object.body, { status: 200, headers });
}

function escapeHtml(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/* ========================================================================= *
 * v1.6 — AES-256-GCM envelope encryption helpers
 *
 * Master key lives ONLY as env.MERCHANT_CREDENTIALS_MASTER_KEY (a Cloudflare
 * "Encrypt" secret on THIS worker). Never logged, never returned in any
 * response, never passed to another worker or the editor.
 * ========================================================================= */
async function importMasterKey(base64Key) {
  const raw = Uint8Array.from(atob(base64Key), (c) => c.charCodeAt(0));
  return crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

async function encryptSecret(plaintext, base64MasterKey) {
  const key = await importMasterKey(base64MasterKey);
  const iv = crypto.getRandomValues(new Uint8Array(12)); // 96-bit IV, unique per encryption
  const encoded = new TextEncoder().encode(plaintext);
  const ciphertextBuf = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, encoded);
  return { ciphertext: bufToBase64(ciphertextBuf), iv: bufToBase64(iv.buffer) };
}

async function decryptSecret(ciphertextBase64, ivBase64, base64MasterKey) {
  const key = await importMasterKey(base64MasterKey);
  const iv = base64ToBuf(ivBase64);
  const ciphertext = base64ToBuf(ciphertextBase64);
  const plainBuf = await crypto.subtle.decrypt({ name: "AES-GCM", iv: new Uint8Array(iv) }, key, ciphertext);
  return new TextDecoder().decode(plainBuf);
}

function bufToBase64(buf) {
  return btoa(String.fromCharCode(...new Uint8Array(buf)));
}
function base64ToBuf(base64) {
  return Uint8Array.from(atob(base64), (c) => c.charCodeAt(0)).buffer;
}

// ONE-TIME SETUP ONLY — do not leave a route exposing this. Run it once
// (paste into a scratch Worker, hit it once, copy the output into
// MERCHANT_CREDENTIALS_MASTER_KEY as a Cloudflare "Encrypt" secret on
// payments-worker, then delete the scratch worker). Never commit the
// generated key anywhere.
async function generateMasterKey() {
  const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"]);
  const raw = await crypto.subtle.exportKey("raw", key);
  return bufToBase64(raw);
}

/* ========================================================================= *
 * POST /paynow/result  — webhook. Don't trust the posted status; re-poll.
 * ========================================================================= */
async function handleWebhook(request, env) {
  const form = parseForm(await request.text());
  const reference = form.get("reference");
  if (!reference) return new Response("missing reference", { status: 400 });

  const payment = await loadPayment(env, reference);
  if (!payment) return new Response("unknown reference", { status: 404 });

  await pollAndConfirm(env, payment);
  return new Response("ok", { status: 200 });
}

/* ========================================================================= *
 * GET /pay/status?ref=...  — poll fallback
 * ========================================================================= */
async function handleStatus(url, env) {
  const reference = url.searchParams.get("ref");
  if (!reference) return json({ error: "missing_ref" }, 400, env);

  const payment = await loadPayment(env, reference);
  if (!payment) return json({ error: "unknown_reference" }, 404, env);

  if (payment.status !== "pending") {
    return json({ reference, status: payment.status, site_id: payment.site_id, purpose: payment.purpose }, 200, env);
  }
  const result = await pollAndConfirm(env, payment);
  return json({ reference, status: result, site_id: payment.site_id, purpose: payment.purpose }, 200, env);
}

/* ========================================================================= *
 * Core: poll Paynow, verify, and idempotently confirm.
 *
 * v1.6: deposit payments (kind='deposit') were initiated with the OWNER's
 * own credentials, not the platform's — so polling/hash verification for
 * those must use the same owner credentials, not integrationByKind().
 * ========================================================================= */
async function pollAndConfirm(env, payment) {
  if (!payment.poll_url) return "pending";

  let creds;
  if (payment.kind === "deposit" || payment.kind === "store_purchase") {
    creds = await ownerCredsForSite(payment.site_id, env);
  } else {
    creds = integrationByKind(payment.integration, env);
  }
  if (!creds) return "pending";

  const resp = await fetch(payment.poll_url, { method: "POST" });
  const fields = parseForm(await resp.text());

  if (!(await verifyPaynowHash(fields, creds.key))) return "pending";

  const status = (fields.get("status") || "").toLowerCase();

  if (PAID_STATUSES.has(status)) {
    await confirmPaid(env, payment);
    return "paid";
  }
  if (DEAD_STATUSES.has(status)) {
    await markPayment(env, payment.reference, "cancelled");
    if (payment.purpose === "publish") await revertToDraft(env, payment.site_id);
    return "cancelled";
  }
  return "pending";
}

// Decrypts an owner's stored Paynow key, for verifying poll responses on
// deposit payments (see pollAndConfirm above).
async function ownerCredsForSite(site_id, env) {
  const row = await env.DB.prepare(
    `SELECT integration_id_ciphertext, integration_id_iv,
            integration_key_ciphertext, integration_key_iv
     FROM merchant_credentials WHERE site_id = ?1`
  ).bind(site_id).first();
  if (!row) return null;
  const key = await decryptSecret(row.integration_key_ciphertext, row.integration_key_iv, env.MERCHANT_CREDENTIALS_MASTER_KEY);
  return { key };
}

/**
 * Idempotent confirm. The conditional UPDATE is the guard: only the first call
 * that flips the row from 'pending' applies the downstream transition.
 * 
 * v1.6: deposit payments confirm into `bookings.payment_status` rather than
 * touching `sites` or `addons` — see confirmDepositPaid below. Wire the
 * booking-side commitment_level -> notify-worker owner ping there once
 * bookings-worker's schema for this lands.
 * v1.5: Added domain registration handling after successful payment.
 */
async function confirmPaid(env, payment) {
  const res = await env.DB.prepare(
    "UPDATE payments SET status='paid', confirmed_at=unixepoch() WHERE reference=?1 AND status='pending'"
  ).bind(payment.reference).run();

  // changes === 0 means someone already confirmed it -> do nothing.
  if (!res.meta || res.meta.changes !== 1) return;

  if (payment.kind === "addon") {
    await confirmPaidAddon(env, payment);
    return;
  }
  if (payment.kind === "deposit") {
    await confirmDepositPaid(env, payment);
    return;
  }
  if (payment.kind === "store_purchase") {
    await confirmStorePurchasePaid(env, payment);
    return;
  }
  if (payment.kind === "store_payments_subscription") {
    await confirmStorePaymentsSubscriptionPaid(env, payment);
    return;
  }

  // Publish (or renew). published_at is set once; expires_at extends from the
  // later of "now" and the current expiry, then +1 year.
  await env.DB.prepare(
    `UPDATE sites SET
       status = 'published',
       published_at = COALESCE(published_at, unixepoch()),
       expires_at = (CASE WHEN expires_at IS NOT NULL AND expires_at > unixepoch()
                          THEN expires_at ELSE unixepoch() END) + ?2,
       ai_generations_used = CASE WHEN published_at IS NULL THEN 0 ELSE ai_generations_used END,
       updated_at = unixepoch()
     WHERE id = ?1`
  ).bind(payment.site_id, YEAR_SECONDS).run();

  // ── DOMAIN REGISTRATION: auto-register a pending .com domain ──────────
  // payment.domain_name / payment.domain_type are NOT reliable — the
  // checkout page currently only ever posts { plan, currency } to /pay, so
  // domain_data never actually reaches this table in the wired-up flow.
  // The real source of truth is the domain_wishes row auth-worker's
  // submitDomainWish() already created when the customer typed their
  // name into the publish modal (tld='.com', status='pending_auto' for
  // anything still awaiting auto-registration). Look that up directly
  // instead of trusting the payments row.
  //
  // The claim UPDATE below is the idempotency guard — if two triggers
  // race (e.g. this webhook and the checkout page's own status poll both
  // fire close together), only one of them successfully flips the wish to
  // 'registering' and proceeds; the other sees changes===0 and backs off.
  try {
    const claim = await env.DB.prepare(
      "UPDATE domain_wishes SET status='registering', updated_at=unixepoch() WHERE site_id=?1 AND tld='.com' AND status='pending_auto'"
    ).bind(payment.site_id).run();

    if (claim.meta && claim.meta.changes === 1) {
      const wish = await env.DB.prepare(
        "SELECT * FROM domain_wishes WHERE site_id=?1 AND tld='.com' AND status='registering' ORDER BY updated_at DESC LIMIT 1"
      ).bind(payment.site_id).first();

      if (wish && wish.choice_1) {
        const domainName = wish.choice_1 + '.com';
        const result = await registerDomainWithCloudflare(env, { site_id: payment.site_id, domain_name: domainName, reference: payment.reference });

        if (result.success) {
          await env.DB.prepare(
            "UPDATE domain_wishes SET status='active', assigned=?2, updated_at=unixepoch() WHERE id=?1"
          ).bind(wish.id, domainName).run();
          await env.DB.prepare(
            "UPDATE payments SET domain_name=?2, domain_type='com', domain_status='registered' WHERE reference=?1"
          ).bind(payment.reference, domainName).run();
        } else {
          await env.DB.prepare(
            "UPDATE domain_wishes SET status='failed', notes=?2, updated_at=unixepoch() WHERE id=?1"
          ).bind(wish.id, result.error || 'auto-registration failed').run();
          await notifyAdminForDomainFailure(env, { site_id: payment.site_id, domain_name: domainName, reference: payment.reference }, result.error);
        }
      }
    }
  } catch (err) {
    console.error('Domain handling error:', err);
    // Log error but don't fail the payment confirmation
  }

  // ── OWN DOMAIN: connect a domain the customer already owns ────────────
  // Same pattern as the .com block above — source of truth is a
  // domain_wishes row with tld='own', status='pending_auto', created by
  // auth-worker's submitOwnDomain() when the customer typed their
  // existing domain into the checkout modal. Nothing is registered here
  // (it's already theirs) — we just provision it as a Cloudflare for SaaS
  // custom hostname and send DNS instructions.
  try {
    const ownClaim = await env.DB.prepare(
      "UPDATE domain_wishes SET status='registering', updated_at=unixepoch() WHERE site_id=?1 AND tld='own' AND status='pending_auto'"
    ).bind(payment.site_id).run();

    if (ownClaim.meta && ownClaim.meta.changes === 1) {
      const ownWish = await env.DB.prepare(
        "SELECT * FROM domain_wishes WHERE site_id=?1 AND tld='own' AND status='registering' ORDER BY updated_at DESC LIMIT 1"
      ).bind(payment.site_id).first();

      if (ownWish && ownWish.choice_1) {
        const ownResult = await provisionCustomHostname(env, { site_id: payment.site_id, domain_name: ownWish.choice_1 });

        if (ownResult.ok) {
          await env.DB.prepare(
            "UPDATE domain_wishes SET status='active', assigned=?2, updated_at=unixepoch() WHERE id=?1"
          ).bind(ownWish.id, ownWish.choice_1).run();
        } else {
          await env.DB.prepare(
            "UPDATE domain_wishes SET status='failed', notes=?2, updated_at=unixepoch() WHERE id=?1"
          ).bind(ownWish.id, ownResult.error || 'connection failed').run();
          await notifyAdminForDomainFailure(env, { site_id: payment.site_id, domain_name: ownWish.choice_1, reference: payment.reference }, ownResult.error);
        }
      }
    }
  } catch (err) {
    console.error('Own-domain handling error:', err);
  }

  // Cache purge so the public site reflects "published" immediately.
  try {
    const site = await env.DB.prepare("SELECT draft_subdomain, custom_domain, custom_domain_status FROM sites WHERE id=?1").bind(payment.site_id).first();
    if (site?.draft_subdomain) await caches.default.delete(new Request(`https://${site.draft_subdomain}.websites.co.zw/`));
    if (site?.custom_domain && site.custom_domain_status === "active") await caches.default.delete(new Request(`https://${site.custom_domain}/`));
  } catch { /* non-fatal */ }
}

// v1.6 — deposit payment confirmed. Marks the payments row (already done in
// confirmPaid above) and pings the owner via notify-worker.
async function confirmDepositPaid(env, payment) {
  const currency = payment.currency === "ZIG" ? "ZIG" : "USD";
  const amountLabel = currency === "ZIG" ? `ZiG ${Number(payment.amount).toFixed(2)}` : `$${Number(payment.amount).toFixed(2)}`;
  try {
    const site = await env.DB.prepare("SELECT owner_id FROM sites WHERE id=?1").bind(payment.site_id).first();
    const owner = site ? await env.DB.prepare("SELECT phone FROM owners WHERE id=?1").bind(site.owner_id).first() : null;
    if (owner?.phone) {
      const message = `💰 Deposit received!\n\nA customer just paid a ${amountLabel} deposit for booking ${payment.booking_id}. Check your Bookings tab to confirm.`;
      await sendWhatsApp(env, owner.phone, message);
    }
  } catch (err) {
    console.error('Deposit confirmation notify error:', err);
  }

  if (env.BOOKINGS_WORKER) {
    try {
      await env.BOOKINGS_WORKER.fetch('https://internal/deposit-confirmed', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Internal-Secret': env.INTERNAL_SHARED_SECRET || '',
        },
        body: JSON.stringify({ booking_id: payment.booking_id, reference: payment.reference, amount: payment.amount, currency }),
      });
    } catch (err) {
      console.warn('bookings-worker deposit-confirmed call failed:', err.message);
    }
  } else {
    console.warn('BOOKINGS_WORKER binding not configured -- deposit confirmed but owner will not be notified');
  }
}

// Store Payments — order confirmed paid. Two jobs: (1) decrement stock for
// exactly what was bought, atomically and guarded against oversell, and
// (2) flip the order to 'paid' and notify the owner.
async function confirmStorePurchasePaid(env, payment) {
  const order = await env.DB.prepare(
    "SELECT id, site_id, items_json, fulfillment_type, customer_phone FROM orders WHERE payment_id = ?1"
  ).bind(payment.id).first();

  if (!order) {
    console.error('confirmStorePurchasePaid: no order found for payment_id', payment.id);
    return;
  }

  let lineItems = [];
  try { lineItems = JSON.parse(order.items_json || '[]'); } catch { lineItems = []; }

  for (const item of lineItems) {
    try {
      if (item.variant_id) {
        const res = await env.DB.prepare(
          "UPDATE product_variants SET stock = stock - ?2 WHERE id = ?1 AND stock >= ?2"
        ).bind(item.variant_id, item.qty).run();
        if (!res.meta || res.meta.changes !== 1) {
          console.warn('Stock guard missed on variant', item.variant_id, '- oversold or race, needs manual review. Order:', order.id);
        }
      } else {
        await env.DB.prepare(
          "UPDATE products SET stock = stock - ?2 WHERE id = ?1 AND stock IS NOT NULL AND stock >= ?2"
        ).bind(item.product_id, item.qty).run();
      }
    } catch (err) {
      console.error('Stock decrement failed for item', item, err);
    }
  }

  const hasDigital = lineItems.some(i => i.product_type === 'digital');
  const downloadToken = hasDigital ? crypto.randomUUID() : null;

  await env.DB.prepare(
    "UPDATE orders SET status='paid', digital_download_token=?2, updated_at=?3 WHERE id=?1"
  ).bind(order.id, downloadToken, new Date().toISOString()).run();

  try {
    const currency = payment.currency === "ZIG" ? "ZIG" : "USD";
    const amountLabel = currency === "ZIG" ? `ZiG ${Number(payment.amount).toFixed(2)}` : `$${Number(payment.amount).toFixed(2)}`;
    const site = await env.DB.prepare("SELECT owner_id FROM sites WHERE id=?1").bind(order.site_id).first();
    const owner = site ? await env.DB.prepare("SELECT phone FROM owners WHERE id=?1").bind(site.owner_id).first() : null;
    if (owner?.phone) {
      const itemLines = lineItems.map(i => `• ${i.qty}× ${i.name}${i.sku ? ' (' + i.sku + ')' : ''}`).join('\n');
      const message = `💳 Online payment received!\n\n${itemLines}\n\nTotal: ${amountLabel}\n\nCheck your Store orders to fulfil.`;
      await sendWhatsApp(env, owner.phone, message);
    }
  } catch (err) {
    console.error('Store purchase confirmation notify error:', err);
  }

  if (hasDigital && downloadToken && order.customer_phone) {
    try {
      const base = env.STORE_DOWNLOAD_BASE_URL || "https://api.websites.co.zw";
      const downloadUrl = `${base}/store/download/${downloadToken}`;
      const itemNames = lineItems.map(i => i.name).join(', ');
      const message = `✅ Payment received — thank you!\n\nYour download is ready:\n${itemNames}\n\n${downloadUrl}\n\nThis link is yours — please don't share it.`;
      await sendWhatsApp(env, order.customer_phone, message);
    } catch (err) {
      console.error('Digital delivery WhatsApp send failed:', err);
    }
  }
}

// Store Payments subscription confirmed paid — activate for 30 days.
async function confirmStorePaymentsSubscriptionPaid(env, payment) {
  const periodEnd = Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60;
  await env.DB.prepare(
    `INSERT INTO store_payments_subscriptions (site_id, status, current_period_end, updated_at)
     VALUES (?1, 'active', ?2, unixepoch())
     ON CONFLICT(site_id) DO UPDATE SET status='active', current_period_end=?2, updated_at=unixepoch()`
  ).bind(payment.site_id, periodEnd).run();

  try {
    const site = await env.DB.prepare("SELECT owner_id, site_name FROM sites WHERE id=?1").bind(payment.site_id).first();
    const owner = site ? await env.DB.prepare("SELECT phone FROM owners WHERE id=?1").bind(site.owner_id).first() : null;
    if (owner?.phone) {
      await sendWhatsApp(env, owner.phone, `✅ Store Payments activated for ${site.site_name || 'your site'}!\n\nYou can now connect your Paynow account and start accepting payments online. Your subscription renews in 30 days.`);
    }
  } catch (err) {
    console.error('Store Payments subscription confirmation notify error:', err);
  }
}

async function sendWhatsApp(env, phone, message) {
  const normalizedPhone = normalizePhone(phone);
  if (!normalizedPhone) return false;

  if (env.NOTIFY_WORKER) {
    try {
      const response = await env.NOTIFY_WORKER.fetch('https://internal/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone: normalizedPhone, message })
      });
      if (response.ok) {
        const data = await response.json();
        if (data.ok) return true;
      }
    } catch (e) {
      console.warn('Notify worker unavailable:', e.message);
    }
  }

  if (!env.MANYCHAT_API_TOKEN) return false;
  try {
    const find = await fetch(
      "https://api.manychat.com/fb/subscriber/findBySystemField?phone=" + encodeURIComponent(normalizedPhone),
      { headers: { Authorization: "Bearer " + env.MANYCHAT_API_TOKEN } }
    );
    const found = await find.json().catch(() => ({}));
    const subId = found?.data?.id;
    if (!subId) return false;
    const r = await fetch("https://api.manychat.com/fb/sending/sendContent", {
      method: "POST",
      headers: { Authorization: "Bearer " + env.MANYCHAT_API_TOKEN, "Content-Type": "application/json" },
      body: JSON.stringify({
        subscriber_id: subId,
        data: { version: "v2", content: { messages: [{ type: "text", text: message }] } },
      }),
    });
    return r.ok;
  } catch (e) {
    return false;
  }
}

function normalizePhone(raw) {
  const p = String(raw || "").replace(/[^\d]/g, "");
  if (!p || p.length < 7) return null;
  if (p.startsWith("263") && p.length >= 12) return p;
  if (p.startsWith("0") && p.length >= 10) return "263" + p.slice(1);
  if (p.length === 9 && (p.startsWith("7") || p.startsWith("8"))) return "263" + p;
  if (p.length >= 10) return p;
  return null;
}

// ── DOMAIN REGISTRATION FUNCTIONS ──────────────────────────────────────

async function registerDomainWithCloudflare(env, payment) {
  if (!env.CF_API_TOKEN) return { success: false, error: "CF_API_TOKEN not configured" };
  if (!env.CF_ACCOUNT_ID) return { success: false, error: "CF_ACCOUNT_ID not configured" };

  try {
    const domainName = payment.domain_name;
    const accountBase = `https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/registrar`;

    const checkResp = await fetch(
      `${accountBase}/domain-check`,
      {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${env.CF_API_TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ domains: [domainName] })
      }
    );
    const checkData = await checkResp.json();
    const checkResult = (checkData.result?.domains || [])[0];

    if (!checkResp.ok || !checkData.success || !checkResult?.registrable) {
      return { success: false, error: checkResult?.reason || "Domain not available" };
    }

    const site = await env.DB.prepare("SELECT owner_id FROM sites WHERE id = ?1").bind(payment.site_id).first();
    if (!site) return { success: false, error: "Site not found" };

    const owner = await env.DB.prepare("SELECT email, phone, name FROM owners WHERE id = ?1").bind(site.owner_id).first();

    const registerResp = await fetch(
      `${accountBase}/registrations`,
      {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${env.CF_API_TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ domain_name: domainName })
      }
    );
    const registerData = await registerResp.json();

    if (!registerResp.ok || !registerData.success) {
      return { success: false, error: registerData.errors?.[0]?.message || registerData.result?.error?.message || "Registration failed" };
    }
    const regState = registerData.result?.state;
    if (regState === "failed" || regState === "blocked") {
      return { success: false, error: registerData.result?.error?.message || `Registration ${regState}` };
    }

    await env.DB.prepare(
      "UPDATE sites SET custom_domain=?2, custom_domain_status='pending', updated_at=unixepoch() WHERE id=?1"
    ).bind(payment.site_id, domainName).run();

    const cfResult = await cfProvisionHostname(env, domainName);
    if (cfResult.ok) {
      await env.DB.prepare(
        "UPDATE sites SET cf_hostname_id=?2, updated_at=unixepoch() WHERE id=?1"
      ).bind(payment.site_id, cfResult.hostname_id).run();
    }

    await env.DB.prepare(
      `INSERT INTO domains (id, site_id, hostname, verified, ssl_status, created_at) 
       VALUES (?1, ?2, ?3, 1, 'pending', CURRENT_TIMESTAMP)`
    ).bind('dom_' + crypto.randomUUID().replace(/-/g, "").slice(0, 12), payment.site_id, domainName).run();

    if (owner?.phone) {
      const message = `✅ Great news! Your domain ${domainName} has been registered successfully!\n\n` +
        `Your SSL certificate is being provisioned. Your site will be live at https://${domainName} within 24-48 hours.`;
      await sendWhatsApp(env, owner.phone, message);
    }

    return { success: true, domain: domainName, message: `Domain ${domainName} registered successfully` };
  } catch (e) {
    return { success: false, error: String(e?.message || e) };
  }
}

async function provisionCustomHostname(env, payment) {
  try {
    const domainName = payment.domain_name;
    const cfResult = await cfProvisionHostname(env, domainName);

    if (!cfResult.ok) {
      return { ok: false, error: cfResult.error || "Cloudflare hostname provisioning failed" };
    }

    await env.DB.prepare(
      "UPDATE sites SET custom_domain=?2, cf_hostname_id=?3, custom_domain_status='pending', updated_at=unixepoch() WHERE id=?1"
    ).bind(payment.site_id, domainName, cfResult.hostname_id).run();

    const site = await env.DB.prepare("SELECT owner_id FROM sites WHERE id = ?1").bind(payment.site_id).first();

    if (site) {
      const owner = await env.DB.prepare("SELECT phone FROM owners WHERE id = ?1").bind(site.owner_id).first();

      if (owner?.phone) {
        const instructions = buildDnsInstructions(domainName, cfResult);
        let message = `🔗 We've started connecting ${domainName} to your site!\n\n` +
          `Add this DNS record at wherever you manage ${domainName}'s DNS:\n\n` +
          `CNAME: ${domainName} → websites.co.zw\n\n`;

        if (instructions.txt_validation) {
          message += `Also add this TXT record for SSL validation:\n` +
            `TXT: ${instructions.txt_validation.name} → ${instructions.txt_validation.value}\n\n`;
        }

        message += `Once added, your site will be live at https://${domainName} within a few hours.`;
        await sendWhatsApp(env, owner.phone, message);
      }
    }

    return { ok: true, domain: domainName };
  } catch (e) {
    console.error('Custom domain provisioning failed:', e);
    return { ok: false, error: String(e?.message || e) };
  }
}

async function notifyAdminForCozwRegistration(env, payment) {
  try {
    const site = await env.DB.prepare("SELECT site_name, draft_subdomain FROM sites WHERE id=?1").bind(payment.site_id).first();

    const message = `📧 New .co.zw domain registration request after payment\n\n` +
      `Site: ${site?.site_name || payment.site_id}\n` +
      `Domain: ${payment.domain_name}\n` +
      `Payment Reference: ${payment.reference}\n` +
      `Site URL: https://${site?.draft_subdomain || ''}.websites.co.zw\n\n` +
      `Please register this domain manually and update the site's custom_domain field.`;

    console.log('COZW Registration Request:', { site_id: payment.site_id, domain: payment.domain_name, ref: payment.reference });

    if (env.SLACK_WEBHOOK) {
      await fetch(env.SLACK_WEBHOOK, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: message })
      });
    }

    await env.DB.prepare("UPDATE payments SET domain_status='admin_notified' WHERE reference=?1").bind(payment.reference).run();
  } catch (e) {
    console.error('Failed to notify admin for .co.zw registration:', e);
  }
}

async function notifyAdminForDomainFailure(env, payment, error) {
  try {
    const message = `❌ Domain registration FAILED\n\n` +
      `Domain: ${payment.domain_name}\n` +
      `Payment Reference: ${payment.reference}\n` +
      `Site ID: ${payment.site_id}\n` +
      `Error: ${error}\n\n` +
      `Please investigate and register this domain manually.`;

    console.error('Domain registration failed:', { domain: payment.domain_name, ref: payment.reference, error });

    if (env.SLACK_WEBHOOK) {
      await fetch(env.SLACK_WEBHOOK, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: message })
      });
    }

    await env.DB.prepare("UPDATE payments SET domain_status='failed', domain_error=?2 WHERE reference=?1").bind(payment.reference, error).run();
  } catch (e) {
    console.error('Failed to notify admin about domain failure:', e);
  }
}

async function cfProvisionHostname(env, hostname) {
  if (!env.CF_API_TOKEN || !env.CF_ZONE_ID) {
    return { ok: false, error: "CF_API_TOKEN or CF_ZONE_ID not configured" };
  }
  try {
    const resp = await fetch(
      `https://api.cloudflare.com/client/v4/zones/${env.CF_ZONE_ID}/custom_hostnames`,
      {
        method: "POST",
        headers: { "Authorization": `Bearer ${env.CF_API_TOKEN}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          hostname,
          ssl: { method: "txt", type: "dv", settings: { min_tls_version: "1.0", http2: "on" } },
        }),
      }
    );
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      if (data.errors?.[0]?.code === 1406) {
        const existing = await cfGetHostname(env, hostname);
        return existing.ok
          ? { ok: true, hostname_id: existing.hostname_id, already_existed: true }
          : { ok: false, error: "hostname exists but could not fetch ID" };
      }
      return { ok: false, error: data.errors?.[0]?.message || `CF API ${resp.status}` };
    }
    return {
      ok: true,
      hostname_id: data.result?.id,
      ssl_status: data.result?.ssl?.status,
      ownership_verification: data.result?.ownership_verification || null,
    };
  } catch (e) {
    return { ok: false, error: String(e?.message) };
  }
}

async function cfGetHostname(env, hostname) {
  try {
    const resp = await fetch(
      `https://api.cloudflare.com/client/v4/zones/${env.CF_ZONE_ID}/custom_hostnames?hostname=${encodeURIComponent(hostname)}`,
      { headers: { "Authorization": `Bearer ${env.CF_API_TOKEN}` } }
    );
    const data = await resp.json().catch(() => ({}));
    const result = data.result?.[0];
    if (!result) return { ok: false, error: "not_found" };
    return {
      ok: true,
      hostname_id: result.id,
      ssl_status: result.ssl?.status,
      hostname_status: result.status,
      ownership_verification: result.ownership_verification || null,
    };
  } catch (e) {
    return { ok: false, error: String(e?.message) };
  }
}

function buildDnsInstructions(hostname, cf) {
  const instructions = {
    cname: {
      type: "CNAME",
      name: hostname,
      value: "websites.co.zw",
      note: "Add this to your domain registrar's DNS settings to point your domain at your site.",
    },
  };

  const valRecord = cf?.ssl_validation_records?.[0] || cf?.ownership_verification;
  if (valRecord) {
    instructions.txt_validation = {
      type: valRecord.type || "TXT",
      name: valRecord.name || `_cf-custom-hostname.${hostname}`,
      value: valRecord.value || valRecord.txt_value || "",
      note: "Add this TXT record to validate your SSL certificate. Remove it once the certificate is active.",
    };
  }

  return instructions;
}

// v1.3 addon activation
// v1.11 PATCH — was writing expires_at/activated_at as SQLite date() TEXT
// ('2026-09-06'), which silently breaks any epoch-integer comparison: SQLite's
// type-affinity rule sorts TEXT as always-greater-than INTEGER, so a cron
// sweep comparing "expires_at <= ?1" against an epoch ?1 would never match a
// TEXT row -- it would just run forever finding nothing, no error, no log.
// Now writes unixepoch() integers, matching sites.expires_at / sessions.expires_at
// everywhere else on this platform. Existing rows written the old way needed the
// one-time migration (migration-addons-expiry-normalize.sql), already run.
//
// v1.12 PATCH — added one-time billing for template unlocks ($15,
// addon_type prefixed 'template:'). expires_at=NULL is this platform's
// permanent-grant convention (see renewal-cron-v2.1.js's addons sweep,
// which already treats NULL as "never touch this row"), so a one-time
// purchase needs zero cron changes to actually behave as permanent --
// it's simply invisible to the sweep from the moment it's written.
// Recurring addon types (bookings) are completely unaffected -- same
// 30-day unixepoch()+2592000 path as before.
async function confirmPaidAddon(env, payment) {
  const price = ADDON_USD_PRICE[payment.addon_type]?.[payment.addon_tier];
  const isOneTime = payment.addon_type.startsWith("template:");

  if (isOneTime) {
    await env.DB.prepare(
      `INSERT INTO addons (id, site_id, addon_type, tier, status, price_usd, billing_cycle,
                            activated_at, expires_at, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, 'active', ?5, 'one_time',
               unixepoch(), NULL, unixepoch(), unixepoch())
       ON CONFLICT(site_id, addon_type) DO UPDATE SET
         tier = excluded.tier,
         status = 'active',
         price_usd = excluded.price_usd,
         billing_cycle = 'one_time',
         activated_at = unixepoch(),
         expires_at = NULL,
         updated_at = unixepoch()`
    ).bind(
      `addon_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`,
      payment.site_id, payment.addon_type, payment.addon_tier, price
    ).run();
    return;
  }

  await env.DB.prepare(
    `INSERT INTO addons (id, site_id, addon_type, tier, status, price_usd, billing_cycle,
                          activated_at, expires_at, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, 'active', ?5, 'monthly',
             unixepoch(), unixepoch() + 2592000, unixepoch(), unixepoch())
     ON CONFLICT(site_id, addon_type) DO UPDATE SET
       tier = excluded.tier,
       status = 'active',
       price_usd = excluded.price_usd,
       billing_cycle = 'monthly',
       activated_at = unixepoch(),
       expires_at = unixepoch() + 2592000,
       updated_at = unixepoch()`
  ).bind(
    `addon_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`,
    payment.site_id, payment.addon_type, payment.addon_tier, price
  ).run();
}
// 2592000 = 30 days in seconds, computed entirely in SQL as an INTEGER --
// no TEXT round-trip via date('now','+30 days') anymore.

async function handleAddonStatus(url, env) {
  const site_id = url.searchParams.get("site_id");
  const addon_type = url.searchParams.get("addon_type");
  if (!site_id || !addon_type) return json({ error: "missing_params" }, 400, env);

  const row = await env.DB.prepare(
    "SELECT status, tier, price_usd, billing_cycle, expires_at FROM addons WHERE site_id = ?1 AND addon_type = ?2"
  ).bind(site_id, addon_type).first();

  if (!row) return json({ owned: false }, 200, env);

  const now = Math.floor(Date.now() / 1000);
  // NULL expires_at = permanent (matches the platform-wide convention used by
  // renewal-cron's addons sweep). A non-NULL expires_at that's already passed
  // means the row is stale and the cron hasn't swept it to grace/suspended
  // yet -- don't report it as owned just because status still says active.
  const notExpired = row.expires_at === null || row.expires_at > now;
  const owned = (row.status === "active" || row.status === "grace") && notExpired;

  return json({
    owned,
    status: row.status,
    tier: row.tier,
    price_usd: row.price_usd,
    billing_cycle: row.billing_cycle,
    permanent: row.expires_at === null,
  }, 200, env);
}

/* ========================================================================= *
 * Small DB helpers
 * ========================================================================= */
function loadPayment(env, reference) {
  return env.DB.prepare(
    `SELECT id, site_id, booking_id, reference, poll_url, integration, currency, amount, purpose, status,
            kind, addon_type, addon_tier, domain_name, domain_type, domain_cost, domain_status
       FROM payments WHERE reference = ?1`
  ).bind(reference).first();
}

function markPayment(env, reference, status) {
  return env.DB.prepare(
    "UPDATE payments SET status=?2 WHERE reference=?1 AND status='pending'"
  ).bind(reference, status).run();
}

function revertToDraft(env, siteId) {
  return env.DB.prepare(
    "UPDATE sites SET status='draft', updated_at=unixepoch() WHERE id=?1 AND status='pending_payment'"
  ).bind(siteId).run();
}

/* ========================================================================= *
 * Paynow credentials + hashing
 * ========================================================================= */
function integrationFor(currency, env) {
  if (currency === "USD") return integrationByKind("usd", env);
  if (currency === "ZIG") return integrationByKind("zig", env);
  return null;
}

function integrationByKind(kind, env) {
  if (kind === "usd" && env.PAYNOW_USD_ID && env.PAYNOW_USD_KEY) {
    return { kind: "usd", id: env.PAYNOW_USD_ID, key: env.PAYNOW_USD_KEY };
  }
  if (kind === "zig" && env.PAYNOW_ZIG_ID && env.PAYNOW_ZIG_KEY) {
    return { kind: "zig", id: env.PAYNOW_ZIG_ID, key: env.PAYNOW_ZIG_KEY };
  }
  return null;
}

function concatValues(orderedPairs) {
  return orderedPairs.map(([, v]) => String(v)).join("");
}

async function sha512Upper(str) {
  const buf = await crypto.subtle.digest("SHA-512", new TextEncoder().encode(str));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("").toUpperCase();
}

async function verifyPaynowHash(fields, key) {
  const provided = fields.get("hash");
  if (!provided) return false;
  const pairs = [];
  for (const [k, v] of fields.entries()) {
    if (k.toLowerCase() === "hash") continue;
    pairs.push([k, v]);
  }
  const expected = await sha512Upper(concatValues(pairs) + key);
  return expected === provided.toUpperCase();
}

/* ========================================================================= *
 * HTTP helpers (CORS + form/JSON)
 * ========================================================================= */
function corsHeaders(env) {
  // Deliberately always "*", not env.ALLOWED_ORIGIN — this worker's public
  // routes (/store/checkout, /pay, /pay/status, etc.) must be callable from
  // every tenant storefront, on every subdomain and custom domain, not one
  // fixed origin. Restricting this to a single origin would silently break
  // every storefront's checkout while adding no real protection anyway:
  // none of these routes check auth server-side, so CORS was never a real
  // security boundary here — it only ever blocked *browser* requests,
  // never a direct server-to-server call. If admin-only routes need real
  // protection later, that has to be a server-side auth check, not CORS.
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": "content-type, authorization",
    "access-control-max-age": "600",
    "vary": "Origin",
  };
}

function preflight(env) {
  return new Response(null, { status: 204, headers: corsHeaders(env) });
}

function json(obj, status, env) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...corsHeaders(env) },
  });
}

function parseForm(text) {
  return new URLSearchParams(text);
}

