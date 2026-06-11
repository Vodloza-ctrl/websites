/**
 * websites.co.zw — Auth Worker  (SELF-CONTAINED, no imports)
 * -----------------------------------------------------------
 * Deploy at:  app.websites.co.zw
 * Routes this Worker handles:
 *   POST /auth/request-otp   { phone, channel:"whatsapp"|"email", email? }
 *   POST /auth/verify-otp    { phone, code }
 *   GET  /auth/me
 *   POST /auth/logout
 *   GET  /health
 *   GET  /* (everything else) → pass through to Cloudflare Pages
 *
 * Database: D1 binding DB
 *   Tables used: owners, otp_codes, sessions
 *   (schema below — run once if tables don't exist)
 *
 * Secrets / vars:
 *   OTP_HMAC_SECRET      — used to hash OTP codes at rest (required)
 *   SESSION_SECRET       — used to sign wcz_session tokens (required)
 *   PREVIEW_HMAC_SECRET  — used to mint wcz_preview cookie (required)
 *   MANYCHAT_API_TOKEN   — WhatsApp OTP delivery (optional, falls back to dev mode)
 *   RESEND_API_KEY       — Email OTP delivery (optional)
 *   FROM_EMAIL           — e.g. noreply@mail.websites.co.zw (optional)
 *   APP_ORIGIN           — e.g. https://app.websites.co.zw (optional)
 *   DEV_MODE             — "1" to log OTP codes in response (never in production)
 *
 * ── Schema (add to schema.sql if not already there) ──
 *   CREATE TABLE IF NOT EXISTS owners (
 *     id         TEXT PRIMARY KEY,
 *     phone      TEXT NOT NULL UNIQUE,
 *     name       TEXT,
 *     email      TEXT,
 *     created_at INTEGER NOT NULL DEFAULT (unixepoch())
 *   );
 *   CREATE TABLE IF NOT EXISTS otp_codes (
 *     id          TEXT PRIMARY KEY,
 *     phone       TEXT NOT NULL,
 *     code_hash   TEXT NOT NULL,
 *     channel     TEXT NOT NULL DEFAULT 'whatsapp',
 *     attempts    INTEGER NOT NULL DEFAULT 0,
 *     expires_at  INTEGER NOT NULL,
 *     consumed_at INTEGER,
 *     created_at  INTEGER NOT NULL DEFAULT (unixepoch())
 *   );
 *   CREATE INDEX IF NOT EXISTS idx_otp_phone ON otp_codes(phone);
 *   CREATE TABLE IF NOT EXISTS sessions (
 *     token      TEXT PRIMARY KEY,
 *     owner_id   TEXT NOT NULL,
 *     expires_at INTEGER NOT NULL,
 *     created_at INTEGER NOT NULL DEFAULT (unixepoch())
 *   );
 *   CREATE INDEX IF NOT EXISTS idx_sessions_owner ON sessions(owner_id);
 */

const OTP_TTL        = 10 * 60;      // 10 minutes
const SESSION_TTL    = 30 * 24 * 3600; // 30 days
const MAX_ATTEMPTS   = 5;
const RATE_LIMIT_WIN = 5 * 60;       // 5 minutes
const RATE_LIMIT_MAX = 3;            // max OTP requests per window

export default {
  async fetch(request, env) {
    const url    = new URL(request.url);
    const path   = url.pathname;
    const method = request.method;
    const origin = env.APP_ORIGIN || "https://app.websites.co.zw";

    if (method === "OPTIONS") return cors(null, 204, origin);
    if (path === "/health")   return cors(json({ ok: true, service: "websites-cozw-auth" }), 200, origin);

    // ── Auth routes ──────────────────────────────────────────
    if (path === "/auth/request-otp" && method === "POST") {
      return cors(await handleRequestOtp(request, env), 200, origin);
    }
    if (path === "/auth/verify-otp" && method === "POST") {
      return cors(await handleVerifyOtp(request, env, origin), 200, origin);
    }
    if (path === "/auth/me" && method === "GET") {
      return cors(await handleMe(request, env), 200, origin);
    }
    if (path === "/auth/logout" && method === "POST") {
      return cors(await handleLogout(request, env, origin), 200, origin);
    }

    // ── Everything else → pass to Cloudflare Pages ───────────
    return fetch(request);
  },
};

/* =========================================================================
 * POST /auth/request-otp
 * Body: { phone, channel: "whatsapp"|"email", email? }
 * ========================================================================= */
async function handleRequestOtp(request, env) {
  let body;
  try { body = await request.json(); } catch { return err("bad_json", 400); }

  const rawPhone = String(body.phone || "").trim();
  const channel  = body.channel === "email" ? "email" : "whatsapp";
  const phone    = normalizePhone(rawPhone);
  if (!phone) return err("invalid_phone", 400);

  const now = nowSec();

  // Rate-limit: max RATE_LIMIT_MAX requests per RATE_LIMIT_WIN seconds per phone
  const recent = await env.DB
    .prepare("SELECT COUNT(*) AS n FROM otp_codes WHERE phone=?1 AND created_at > ?2")
    .bind(phone, now - RATE_LIMIT_WIN).first();
  if (recent && recent.n >= RATE_LIMIT_MAX) return err("too_many_requests", 429);

  // Generate 6-digit code
  const code     = String(Math.floor(100000 + crypto.getRandomValues(new Uint32Array(1))[0] % 900000));
  const codeHash = await hmac(env.OTP_HMAC_SECRET || "dev-secret", phone + ":" + code);
  const otpId    = "otp_" + uid();

  await env.DB.prepare(
    "INSERT INTO otp_codes (id,phone,code_hash,channel,expires_at) VALUES (?1,?2,?3,?4,?5)"
  ).bind(otpId, phone, codeHash, channel, now + OTP_TTL).run();

  // Send the code
  let sent = false;
  if (channel === "whatsapp") {
    sent = await sendWhatsApp(env, phone, code);
  } else {
    const email = String(body.email || "").trim();
    if (email) sent = await sendEmail(env, email, code);
  }

  // DEV_MODE or no delivery configured — return code in response for testing
  const devCode = (!sent || env.DEV_MODE === "1") ? code : undefined;

  return json({ ok: true, channel, ...(devCode ? { dev_code: devCode } : {}) });
}

/* =========================================================================
 * POST /auth/verify-otp
 * Body: { phone, code }
 * ========================================================================= */
async function handleVerifyOtp(request, env, origin) {
  let body;
  try { body = await request.json(); } catch { return err("bad_json", 400); }

  const phone = normalizePhone(String(body.phone || "").trim());
  const code  = String(body.code || "").replace(/\D/g, "").slice(0, 6);
  if (!phone || code.length < 4) return err("invalid_input", 400);

  const now = nowSec();

  // Find the most recent unconsumed, unexpired OTP for this phone
  const otp = await env.DB.prepare(
    "SELECT id, code_hash, attempts FROM otp_codes " +
    "WHERE phone=?1 AND consumed_at IS NULL AND expires_at > ?2 " +
    "ORDER BY created_at DESC LIMIT 1"
  ).bind(phone, now).first();

  if (!otp) return err("code_expired_or_missing", 400);
  if (otp.attempts >= MAX_ATTEMPTS) return err("too_many_attempts", 400);

  // Verify HMAC
  const expected = await hmac(env.OTP_HMAC_SECRET || "dev-secret", phone + ":" + code);
  const match    = timingSafe(expected, otp.code_hash);

  // Increment attempt counter regardless
  await env.DB.prepare("UPDATE otp_codes SET attempts=attempts+1 WHERE id=?1").bind(otp.id).run();

  if (!match) return err("invalid_code", 400);

  // Mark consumed
  await env.DB.prepare("UPDATE otp_codes SET consumed_at=?2 WHERE id=?1").bind(otp.id, now).run();

  // Upsert owner — auto-create account if first login
  let owner = await env.DB.prepare("SELECT id, phone, name, email FROM owners WHERE phone=?1").bind(phone).first();
  if (!owner) {
    const ownerId = "usr_" + uid();
    await env.DB.prepare(
      "INSERT INTO owners (id, phone, created_at) VALUES (?1, ?2, ?3)"
    ).bind(ownerId, phone, now).run();
    owner = { id: ownerId, phone, name: null, email: null };
  }

  // Create session
  const token     = uid(48);
  const expiresAt = now + SESSION_TTL;
  await env.DB.prepare(
    "INSERT INTO sessions (token, owner_id, expires_at, created_at) VALUES (?1, ?2, ?3, ?4)"
  ).bind(token, owner.id, expiresAt, now).run();

  // Mint wcz_preview HMAC cookie for the render Worker
  const previewToken = await mintPreviewToken(owner.id, env.PREVIEW_HMAC_SECRET || "dev-preview-secret");

  const cookieOpts = `Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_TTL}`;
  const previewOpts = `Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${SESSION_TTL}; Domain=.websites.co.zw`;

  const resp = json({ ok: true, owner: { id: owner.id, phone: owner.phone, name: owner.name } });
  resp.headers.append("Set-Cookie", `wcz_session=${token}; ${cookieOpts}`);
  resp.headers.append("Set-Cookie", `wcz_preview=${previewToken}; ${previewOpts}`);
  return resp;
}

/* =========================================================================
 * GET /auth/me
 * ========================================================================= */
async function handleMe(request, env) {
  const token = parseCookie(request.headers.get("cookie") || "")["wcz_session"];
  if (!token) return json({ authenticated: false });

  const now = nowSec();
  const row = await env.DB.prepare(
    "SELECT s.owner_id, o.phone, o.name, o.email " +
    "FROM sessions s JOIN owners o ON o.id = s.owner_id " +
    "WHERE s.token=?1 AND s.expires_at > ?2"
  ).bind(token, now).first();

  if (!row) return json({ authenticated: false });
  return json({ authenticated: true, owner: { id: row.owner_id, phone: row.phone, name: row.name, email: row.email } });
}

/* =========================================================================
 * POST /auth/logout
 * ========================================================================= */
async function handleLogout(request, env, origin) {
  const token = parseCookie(request.headers.get("cookie") || "")["wcz_session"];
  if (token) {
    await env.DB.prepare("DELETE FROM sessions WHERE token=?1").bind(token).run().catch(() => {});
  }
  const resp = json({ ok: true });
  resp.headers.append("Set-Cookie", "wcz_session=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax");
  resp.headers.append("Set-Cookie", "wcz_preview=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict; Domain=.websites.co.zw");
  return resp;
}

/* =========================================================================
 * OTP delivery
 * ========================================================================= */
async function sendWhatsApp(env, phone, code) {
  if (!env.MANYCHAT_API_TOKEN) return false;
  try {
    // Find subscriber by phone
    const find = await fetch(
      "https://api.manychat.com/fb/subscriber/findBySystemField?phone=" + encodeURIComponent(phone),
      { headers: { Authorization: "Bearer " + env.MANYCHAT_API_TOKEN } }
    );
    const found = await find.json().catch(() => ({}));
    const subId = found?.data?.id;
    if (!subId) return false;

    // Send OTP message via ManyChat custom message
    const r = await fetch("https://api.manychat.com/fb/sending/sendContent", {
      method: "POST",
      headers: { Authorization: "Bearer " + env.MANYCHAT_API_TOKEN, "Content-Type": "application/json" },
      body: JSON.stringify({
        subscriber_id: subId,
        data: {
          version: "v2",
          content: {
            messages: [{
              type: "text",
              text: `Your websites.co.zw verification code is: *${code}*\n\nThis code expires in 10 minutes. Do not share it with anyone.`
            }]
          }
        }
      })
    });
    return r.ok;
  } catch { return false; }
}

async function sendEmail(env, email, code) {
  if (!env.RESEND_API_KEY) return false;
  try {
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: "Bearer " + env.RESEND_API_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: env.FROM_EMAIL || "noreply@mail.websites.co.zw",
        to: [email],
        subject: `Your websites.co.zw code: ${code}`,
        html: `<div style="font-family:sans-serif;max-width:440px;margin:0 auto;padding:40px 24px">
          <h2 style="font-size:22px;margin:0 0 8px">Your sign-in code</h2>
          <p style="color:#5a626e;margin:0 0 24px">Use this code to sign in to websites.co.zw</p>
          <div style="background:#f6f7f9;border-radius:12px;padding:24px;text-align:center;font-size:32px;font-weight:700;letter-spacing:.3em">${code}</div>
          <p style="color:#9099a4;font-size:13px;margin:20px 0 0">Expires in 10 minutes. If you didn't request this, ignore this email.</p>
        </div>`
      })
    });
    return r.ok;
  } catch { return false; }
}

/* =========================================================================
 * Preview token (for render Worker)
 * ========================================================================= */
async function mintPreviewToken(ownerId, secret) {
  const payload = { sub: ownerId, scope: "preview", exp: nowSec() + SESSION_TTL };
  const pb = b64url(new TextEncoder().encode(JSON.stringify(payload)));
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(pb));
  return pb + "." + b64url(sig);
}

/* =========================================================================
 * Crypto helpers
 * ========================================================================= */
async function hmac(secret, data) {
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data));
  return hex(sig);
}

function timingSafe(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function hex(buf) {
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join("");
}

function b64url(buf) {
  let b = ""; const a = new Uint8Array(typeof buf === "string" ? new TextEncoder().encode(buf) : buf);
  for (let i = 0; i < a.length; i++) b += String.fromCharCode(a[i]);
  return btoa(b).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function uid(bytes) {
  bytes = bytes || 16;
  const b = new Uint8Array(bytes);
  crypto.getRandomValues(b);
  return [...b].map(x => x.toString(16).padStart(2, "0")).join("");
}

function nowSec() { return Math.floor(Date.now() / 1000); }

function normalizePhone(raw) {
  const p = String(raw || "").replace(/[^\d]/g, "");
  if (!p) return null;
  if (p.length < 7) return null;
  if (p.startsWith("263") && p.length >= 12) return p;
  if (p.startsWith("0") && p.length >= 10)   return "263" + p.slice(1);
  if (p.length === 9 && (p.startsWith("7") || p.startsWith("8"))) return "263" + p;
  if (p.length >= 10) return p; // international format without +
  return null;
}

function parseCookie(h) {
  const out = {};
  String(h).split(";").forEach(pair => {
    const i = pair.indexOf("=");
    if (i > -1) out[pair.slice(0, i).trim()] = decodeURIComponent(pair.slice(i + 1).trim());
  });
  return out;
}

function json(obj) {
  return new Response(JSON.stringify(obj), {
    headers: { "Content-Type": "application/json; charset=utf-8" }
  });
}

function err(code, status) {
  return new Response(JSON.stringify({ error: code }), {
    status: status || 400,
    headers: { "Content-Type": "application/json; charset=utf-8" }
  });
}

function cors(resp, status, origin) {
  if (!resp) resp = new Response(null, { status: status || 204 });
  const h = new Headers(resp.headers);
  h.set("Access-Control-Allow-Origin", origin || "*");
  h.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  h.set("Access-Control-Allow-Headers", "Content-Type");
  h.set("Access-Control-Allow-Credentials", "true");
  h.set("Vary", "Origin");
  return new Response(resp.body, { status: resp.status, headers: h });
}
