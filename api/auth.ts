// auth.ts — session auth + tenant isolation for Cloudflare Workers + D1
//
// Hono-flavoured, but the pattern is framework-agnostic. This is a SKELETON:
// before production add OTP send rate-limiting (per phone + per IP), session
// rotation on privilege change, CSRF protection on state-changing routes, and
// use a vetted hashing lib if you add passwords. Secrets live in Worker secrets.

import { Hono } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';

type Env = { DB: D1Database; OTP_SECRET: string };
type User = { id: string; phone: string | null; role: 'owner' | 'admin' | 'support' };

const SESSION_TTL = 60 * 60 * 24 * 30; // 30 days
const enc = new TextEncoder();

// ── crypto helpers (Web Crypto — available in the Workers runtime) ──────────
function randomId(prefix = ''): string {
  const b = new Uint8Array(20);
  crypto.getRandomValues(b);
  return prefix + [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
}

async function hmac(secret: string, msg: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(msg));
  return [...new Uint8Array(sig)].map((x) => x.toString(16).padStart(2, '0')).join('');
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let out = 0;
  for (let i = 0; i < a.length; i++) out |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return out === 0;
}

// ── phone-OTP login (Zimbabwe is phone-first; reuse your WhatsApp channel) ──
export async function requestOtp(env: Env, phone: string): Promise<void> {
  const code = String(Math.floor(100000 + Math.random() * 900000)); // 6 digits
  const codeHash = await hmac(env.OTP_SECRET, `${phone}:${code}`);
  await env.DB.prepare(
    `INSERT INTO otp_codes (id, phone, code_hash, expires_at)
     VALUES (?, ?, ?, unixepoch() + 600)`, // 10-minute expiry
  ).bind(randomId('otp_'), phone, codeHash).run();
  await sendOtp(phone, code); // your ManyChat / SMS gateway
}

export async function verifyOtp(env: Env, phone: string, code: string): Promise<string | null> {
  const row = await env.DB.prepare(
    `SELECT id, code_hash, attempts FROM otp_codes
     WHERE phone = ? AND consumed_at IS NULL AND expires_at > unixepoch()
     ORDER BY created_at DESC LIMIT 1`,
  ).bind(phone).first<{ id: string; code_hash: string; attempts: number }>();
  if (!row || row.attempts >= 5) return null;

  const expected = await hmac(env.OTP_SECRET, `${phone}:${code}`);
  if (!timingSafeEqual(expected, row.code_hash)) {
    await env.DB.prepare(`UPDATE otp_codes SET attempts = attempts + 1 WHERE id = ?`).bind(row.id).run();
    return null;
  }
  await env.DB.prepare(`UPDATE otp_codes SET consumed_at = unixepoch() WHERE id = ?`).bind(row.id).run();

  // find-or-create the user, then open a session
  let user = await env.DB.prepare(`SELECT id FROM users WHERE phone = ?`).bind(phone).first<{ id: string }>();
  if (!user) {
    const id = randomId('usr_');
    await env.DB.prepare(`INSERT INTO users (id, phone) VALUES (?, ?)`).bind(id, phone).run();
    user = { id };
  }
  return createSession(env, user.id);
}

export async function createSession(env: Env, userId: string): Promise<string> {
  const id = randomId('ses_');
  await env.DB.prepare(
    `INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, unixepoch() + ?)`,
  ).bind(id, userId, SESSION_TTL).run();
  return id;
}

// ── ENFORCEMENT POINT 1 ─────────────────────────────────────────────────────
// Identity is resolved once, server-side, from the session cookie. The user id
// it returns is the ONLY trusted source of "who is this tenant". Nothing from
// the request body or query string is ever trusted for identity.
export const requireAuth = async (c: any, next: any) => {
  const token = getCookie(c, 'sid');
  if (!token) return c.json({ error: 'unauthorized' }, 401);
  const user = await c.env.DB.prepare(
    `SELECT u.id, u.phone, u.role
     FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.id = ? AND s.expires_at > unixepoch() AND u.status = 'active'`,
  ).bind(token).first<User>();
  if (!user) { deleteCookie(c, 'sid'); return c.json({ error: 'unauthorized' }, 401); }
  c.set('user', user);
  await next();
};

export const requireAdmin = async (c: any, next: any) => {
  if ((c.get('user') as User).role !== 'admin') return c.json({ error: 'forbidden' }, 403);
  await next();
};

// ── ENFORCEMENT POINT 2 ─────────────────────────────────────────────────────
// The tenant-scoped data layer. owner_id ALWAYS comes from the session-derived
// id passed to the constructor — never from the caller. Every read/write pins
// owner_id, so a forged or guessed row id simply returns nothing.
export class Tenant {
  constructor(private db: D1Database, private ownerId: string) {}

  listSites() {
    return this.db.prepare(`SELECT * FROM sites WHERE owner_id = ?`).bind(this.ownerId).all();
  }
  getSite(siteId: string) {
    return this.db.prepare(`SELECT * FROM sites WHERE id = ? AND owner_id = ?`) // ← the lock
      .bind(siteId, this.ownerId).first();
  }
  updateConfig(siteId: string, config: string) {
    return this.db.prepare(
      `UPDATE sites SET config_json = ?, updated_at = unixepoch()
       WHERE id = ? AND owner_id = ?`, // scoped write — cross-tenant write is impossible
    ).bind(config, siteId, this.ownerId).run();
  }
  listSubscriptions() {
    return this.db.prepare(`SELECT * FROM subscriptions WHERE owner_id = ?`).bind(this.ownerId).all();
  }
}

// ── routes ──────────────────────────────────────────────────────────────────
const app = new Hono<{ Bindings: Env; Variables: { user: User } }>();

app.post('/auth/request-otp', async (c) => {
  const { phone } = await c.req.json();
  await requestOtp(c.env, phone);
  return c.json({ ok: true });
});

app.post('/auth/verify-otp', async (c) => {
  const { phone, code } = await c.req.json();
  const sid = await verifyOtp(c.env, phone, code);
  if (!sid) return c.json({ error: 'invalid_code' }, 401);
  setCookie(c, 'sid', sid, { httpOnly: true, secure: true, sameSite: 'Lax', path: '/', maxAge: SESSION_TTL });
  return c.json({ ok: true });
});

// Every tenant route sits behind requireAuth and goes through the scoped Tenant.
app.get('/api/sites', requireAuth, async (c) => {
  const t = new Tenant(c.env.DB, c.get('user').id); // ownerId from session, not client
  return c.json((await t.listSites()).results);
});

app.put('/api/sites/:id/config', requireAuth, async (c) => {
  const t = new Tenant(c.env.DB, c.get('user').id);
  await t.updateConfig(c.req.param('id'), await c.req.text());
  return c.json({ ok: true });
});

// ── ENFORCEMENT POINT 3 ─────────────────────────────────────────────────────
// Admin is the ONLY place isolation is intentionally bypassed (cross-tenant
// reads), and it is gated behind a role check — and ideally audit-logged.
app.get('/admin/domain-queue', requireAuth, requireAdmin, async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT * FROM domain_orders
     WHERE state IN ('submitted', 'pending_zispa') ORDER BY created_at`,
  ).all();
  return c.json(results);
});

export default app;

// Swap this for your SMS / WhatsApp (ManyChat) sender.
declare function sendOtp(phone: string, code: string): Promise<void>;
