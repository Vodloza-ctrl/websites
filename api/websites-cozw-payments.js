/**
 * websites.co.zw — payments Worker (SELF-CONTAINED, no imports)
 * ---------------------------------------------------------------------------
 * Routes (on api.websites.co.zw):
 *   POST /pay            initiate a publish/renewal payment via Paynow
 *   POST /paynow/result  Paynow's server webhook (resulturl)
 *   GET  /pay/status     manual poll fallback for the dashboard
 *   OPTIONS *            CORS preflight
 *
 * Currency split: USD -> PAYNOW_USD_* , ZIG -> PAYNOW_ZIG_* . Two separate
 * Paynow integrations; we never auto-convert. A missing key for a currency
 * makes that currency unavailable rather than misrouting.
 *
 * Idempotency: the unique `reference` is the key. The webhook AND the poll can
 * both confirm the same transaction; the conditional UPDATE on status='pending'
 * means whichever fires first wins and the other is a no-op. Both re-poll
 * Paynow for the authoritative status rather than trusting a posted body.
 *
 * Bindings: DB (D1). Vars: ALLOWED_ORIGIN, RESULT_URL, RETURN_URL.
 * Secrets: PAYNOW_USD_ID, PAYNOW_USD_KEY, PAYNOW_ZIG_ID, PAYNOW_ZIG_KEY.
 */

const PAYNOW_INITIATE_URL = "https://www.paynow.co.zw/interface/initiatetransaction";
const YEAR_SECONDS = 365 * 24 * 60 * 60;

// Paynow status strings that mean the money is in.
const PAID_STATUSES = new Set(["paid", "awaiting delivery", "delivered"]);
const DEAD_STATUSES = new Set(["cancelled", "failed", "disputed", "refunded"]);

// USD price list. ZiG amount is passed by the dashboard (computed at the live
// RBZ rate at checkout), since the rate moves.
const USD_PRICE = { starter: 30, pro: 60 };

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const { pathname } = url;

    if (request.method === "OPTIONS") return preflight(env);

    try {
      if (request.method === "POST" && pathname === "/pay") return await handlePay(request, env);
      if (request.method === "POST" && pathname === "/paynow/result") return await handleWebhook(request, env);
      if (request.method === "GET" && pathname === "/pay/status") return await handleStatus(url, env);
    } catch (err) {
      return json({ error: "internal_error", detail: String(err && err.message || err) }, 500, env);
    }
    return json({ error: "not_found" }, 404, env);
  },
};

/* ========================================================================= *
 * POST /pay  — initiate
 * body: { site_id, currency: "USD"|"ZIG", purpose?: "publish"|"renewal",
 *         amount?: number (required for ZIG), email? }
 * ========================================================================= */
async function handlePay(request, env) {
  let body;
  try { body = await request.json(); } catch { return json({ error: "bad_json" }, 400, env); }

  const siteId = body.site_id;
  const currency = String(body.currency || "").toUpperCase();
  const purpose = body.purpose === "renewal" ? "renewal" : "publish";
  if (!siteId) return json({ error: "missing_site_id" }, 400, env);
  if (currency !== "USD" && currency !== "ZIG") return json({ error: "bad_currency" }, 400, env);

  const creds = integrationFor(currency, env);
  if (!creds) return json({ error: "currency_unavailable", currency }, 400, env);

  const site = await env.DB
    .prepare("SELECT id, owner_id, status, plan FROM sites WHERE id = ?1")
    .bind(siteId).first();
  if (!site) return json({ error: "site_not_found" }, 404, env);

  // Amount: USD from the price list; ZiG must be supplied by the dashboard.
  let amount;
  if (currency === "USD") {
    amount = USD_PRICE[site.plan] ?? USD_PRICE.starter;
  } else {
    amount = Number(body.amount);
    if (!(amount > 0)) return json({ error: "missing_zig_amount" }, 400, env);
  }

  const reference = `WCZ-${crypto.randomUUID().replace(/-/g, "")}`;
  const email = typeof body.email === "string" ? body.email : "noreply@websites.co.zw";

  // Create the pending payment row up front so we always have a record.
  await env.DB.prepare(
    `INSERT INTO payments (id, site_id, reference, integration, currency, amount, purpose, status, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'pending', unixepoch())`
  ).bind(crypto.randomUUID(), siteId, reference, creds.kind, currency, amount, purpose).run();

  // For a first publish, move the site into pending_payment (only from draft).
  if (purpose === "publish") {
    await env.DB.prepare(
      "UPDATE sites SET status='pending_payment', updated_at=unixepoch() WHERE id=?1 AND status='draft'"
    ).bind(siteId).run();
  }

  // Build + sign the Paynow initiate request (field order matters for the hash).
  const fields = [
    ["id", creds.id],
    ["reference", reference],
    ["amount", amount.toFixed(2)],
    ["additionalinfo", `websites.co.zw ${purpose} (${currency})`],
    ["returnurl", `${env.RETURN_URL}?ref=${encodeURIComponent(reference)}`],
    ["resulturl", env.RESULT_URL],
    ["authemail", email],
    ["status", "Message"],
  ];
  const hash = await sha512Upper(concatValues(fields) + creds.key);
  const reqBody = new URLSearchParams([...fields, ["hash", hash]]);

  const pnResp = await fetch(PAYNOW_INITIATE_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: reqBody.toString(),
  });
  const parsed = parseForm(await pnResp.text());

  if ((parsed.get("status") || "").toLowerCase() !== "ok") {
    await markPayment(env, reference, "failed");
    if (purpose === "publish") await revertToDraft(env, siteId);
    return json({ error: "paynow_error", detail: parsed.get("error") || "initiate failed" }, 502, env);
  }

  const browserUrl = parsed.get("browserurl");
  const pollUrl = parsed.get("pollurl");
  await env.DB.prepare("UPDATE payments SET poll_url=?2 WHERE reference=?1")
    .bind(reference, pollUrl).run();

  return json({ reference, redirect_url: browserUrl, poll_url: pollUrl }, 200, env);
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

  await pollAndConfirm(env, payment); // authoritative status comes from the poll
  // Paynow only needs a 200 acknowledgement.
  return new Response("ok", { status: 200 });
}

/* ========================================================================= *
 * GET /pay/status?ref=...  — dashboard poll fallback
 * ========================================================================= */
async function handleStatus(url, env) {
  const reference = url.searchParams.get("ref");
  if (!reference) return json({ error: "missing_ref" }, 400, env);

  const payment = await loadPayment(env, reference);
  if (!payment) return json({ error: "unknown_reference" }, 404, env);

  // If already settled in our DB, answer without hitting Paynow again.
  if (payment.status !== "pending") {
    return json({ reference, status: payment.status }, 200, env);
  }
  const result = await pollAndConfirm(env, payment);
  return json({ reference, status: result }, 200, env);
}

/* ========================================================================= *
 * Core: poll Paynow, verify, and idempotently confirm.
 * ========================================================================= */
async function pollAndConfirm(env, payment) {
  if (!payment.poll_url) return "pending";

  const creds = integrationByKind(payment.integration, env);
  if (!creds) return "pending";

  const resp = await fetch(payment.poll_url, { method: "POST" });
  const fields = parseForm(await resp.text());

  // Verify the poll response hash with this transaction's integration key.
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

/**
 * Idempotent confirm. The conditional UPDATE is the guard: only the first call
 * that flips the row from 'pending' applies the site transition.
 */
async function confirmPaid(env, payment) {
  const res = await env.DB.prepare(
    "UPDATE payments SET status='paid', confirmed_at=unixepoch() WHERE reference=?1 AND status='pending'"
  ).bind(payment.reference).run();

  // changes === 0 means someone already confirmed it -> do nothing.
  if (!res.meta || res.meta.changes !== 1) return;

  // Publish (or renew). published_at is set once; expires_at extends from the
  // later of "now" and the current expiry, then +1 year.
  //
  // FIRST publish only (published_at was NULL before this confirm): reset the AI
  // regen counter to 0 so the paid allotment is fresh and the trial generation
  // isn't charged against it. Renewals (published_at already set) keep their
  // count. In a SQLite UPDATE the RHS reads the OLD row values, so this CASE
  // tests the pre-confirm state correctly.
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
}

/* ========================================================================= *
 * Small DB helpers
 * ========================================================================= */
function loadPayment(env, reference) {
  return env.DB.prepare(
    "SELECT id, site_id, reference, poll_url, integration, currency, amount, purpose, status FROM payments WHERE reference = ?1"
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

// Paynow hash = SHA512( concat(all field values in order) + integrationKey ), uppercase hex.
function concatValues(orderedPairs) {
  return orderedPairs.map(([, v]) => String(v)).join("");
}
async function sha512Upper(str) {
  const buf = await crypto.subtle.digest("SHA-512", new TextEncoder().encode(str));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("").toUpperCase();
}
// Verify a Paynow response: concat all returned values except `hash`, in order.
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
  return {
    "access-control-allow-origin": env.ALLOWED_ORIGIN || "*",
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": "content-type",
    "access-control-max-age": "86400",
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
// URLSearchParams preserves order, which the hash verification relies on.
function parseForm(text) {
  return new URLSearchParams(text);
}