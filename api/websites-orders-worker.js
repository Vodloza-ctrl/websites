/**
 * websites-orders-worker.js  v1.1
 * websites.co.zw — WhatsApp Store order capture + status API
 *
 * Service name: websites-orders-worker
 * Bound into render-worker as env.ORDERS_WORKER (service binding)
 *
 * Routes:
 *   POST   /api/orders                 (public, site-scoped) — capture order pre-WhatsApp-redirect
 *   GET    /api/orders?site_id=xxx     (owner auth)          — list orders for dashboard
 *   PATCH  /api/orders/:id             (owner auth)          — update status
 *   GET    /addon-check?site_id=xxx&type=xxx (internal, service-binding only) — gating check for render worker
 *
 * v1.1 CHANGE — REAL OWNER AUTH (was a placeholder HMAC-cookie guess in v1.0):
 *   verifyOwner() now matches auth-worker.js v5.3's actual session system:
 *   a session token (D1 `sessions` table: token, owner_id, expires_at),
 *   presented either as an `Authorization: Bearer <token>` header or a
 *   `wcz_session` cookie. resolveToken()/parseCookie() below are copied
 *   verbatim from auth-worker.js so both workers agree on the exact same
 *   token resolution -- this worker has no shared-module import path to
 *   auth-worker.js, so duplication here is deliberate, not drift; if
 *   auth-worker.js's session lookup ever changes, mirror the change here
 *   too. No secret is needed for this -- it's a straight D1 lookup against
 *   the same `sessions` table auth-worker.js already writes to.
 *
 * Bindings expected: env.DB (D1 — same database as auth-worker.js /
 * render-worker.js, so `sessions`, `sites`, `addons`, `orders` all live
 * in one D1 instance)
 */

function nowIso() {
  return new Date().toISOString();
}

function nowEpoch() {
  return Math.floor(Date.now() / 1000);
}

function genId(prefix) {
  const rand = crypto.getRandomValues(new Uint8Array(9));
  const b64 = btoa(String.fromCharCode(...rand)).replace(/[+/=]/g, '').slice(0, 12);
  return `${prefix}_${b64}`;
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'access-control-allow-origin': '*' },
  });
}

// ---------------------------------------------------------------
// Addon gating — the piece that makes non-payment enforceable.
// Call this from render-worker before emitting the WA cart/order UI.
// ---------------------------------------------------------------
async function isAddonActive(env, siteId, addonType) {
  const row = await env.DB.prepare(
    `SELECT status, expires_at, grace_until FROM addons WHERE site_id = ? AND addon_type = ?`
  ).bind(siteId, addonType).first();

  if (!row) return false; // never subscribed — no free ride
  if (row.status === 'active') return true;
  if (row.status === 'grace') {
    // still rendering during grace window, cron will suspend after grace_until
    return true;
  }
  return false; // pending_payment | suspended | cancelled
}

// ---------------------------------------------------------------
// Owner auth — matches auth-worker.js v5.3's session system exactly.
// Token resolution is copied verbatim from auth-worker.js's
// resolveToken()/parseCookie() so both workers land on the identical
// token for the identical request. The session lookup itself
// (`sessions` table, same expiry check) is the same query auth-worker.js
// runs in its own resolveOwner().
// ---------------------------------------------------------------
function parseCookie(h) {
  const out = {};
  String(h).split(';').forEach(pair => {
    const i = pair.indexOf('=');
    if (i > -1) out[pair.slice(0, i).trim()] = decodeURIComponent(pair.slice(i + 1).trim());
  });
  return out;
}

function resolveToken(request) {
  const auth = request.headers.get('Authorization') || '';
  if (auth.startsWith('Bearer ')) return auth.slice(7);
  return parseCookie(request.headers.get('cookie') || '')['wcz_session'] || null;
}

async function resolveOwnerId(request, env) {
  const token = resolveToken(request);
  if (!token) return null;
  const row = await env.DB.prepare(
    `SELECT owner_id FROM sessions WHERE token = ? AND expires_at > unixepoch()`
  ).bind(token).first();
  return row?.owner_id || null;
}

async function verifyOwner(request, env, siteId) {
  const ownerId = await resolveOwnerId(request, env);
  if (!ownerId) return false;

  const site = await env.DB.prepare(`SELECT owner_id FROM sites WHERE id = ?`).bind(siteId).first();
  if (!site) return false;

  return site.owner_id === ownerId;
}

// ---------------------------------------------------------------
// POST /api/orders — public, called by commerce-sdk-worker's
// order script immediately before window.location = waHref
// ---------------------------------------------------------------
async function handleCreateOrder(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: 'invalid_json' }, 400);
  }

  const { site_id, items, total_usd, wa_message, customer_name, customer_phone } = body;

  if (!site_id || !Array.isArray(items) || items.length === 0 || !wa_message) {
    return jsonResponse({ error: 'missing_fields' }, 400);
  }

  // Gate: only record (and by extension only the storefront should have
  // rendered the button at all) if whatsapp_store addon is active.
  const active = await isAddonActive(env, site_id, 'whatsapp_store');
  if (!active) {
    return jsonResponse({ error: 'addon_inactive' }, 402);
  }

  const id = genId('ord');
  const ts = nowIso();

  await env.DB.prepare(
    `INSERT INTO orders (id, site_id, status, customer_name, customer_phone, items_json, total_usd, wa_message, created_at, updated_at, created_epoch)
     VALUES (?, ?, 'new', ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    id, site_id, customer_name || null, customer_phone || null,
    JSON.stringify(items), total_usd || null, wa_message, ts, ts, nowEpoch()
  ).run();

  return jsonResponse({ id, status: 'new' }, 201);
}

// ---------------------------------------------------------------
// GET /api/orders?site_id=xxx&status=xxx — owner dashboard list
// ---------------------------------------------------------------
async function handleListOrders(request, env) {
  const url = new URL(request.url);
  const siteId = url.searchParams.get('site_id');
  const status = url.searchParams.get('status');

  if (!siteId) return jsonResponse({ error: 'missing_site_id' }, 400);
  if (!(await verifyOwner(request, env, siteId))) return jsonResponse({ error: 'unauthorized' }, 401);

  let query = `SELECT * FROM orders WHERE site_id = ?`;
  const binds = [siteId];
  if (status) {
    query += ` AND status = ?`;
    binds.push(status);
  }
  query += ` ORDER BY created_epoch DESC LIMIT 200`;

  const { results } = await env.DB.prepare(query).bind(...binds).all();
  const orders = results.map(r => ({ ...r, items: JSON.parse(r.items_json) }));

  return jsonResponse({ orders });
}

// ---------------------------------------------------------------
// PATCH /api/orders/:id — owner updates status
// ---------------------------------------------------------------
const VALID_TRANSITIONS = {
  new: ['confirmed', 'cancelled'],
  confirmed: ['paid', 'cancelled'],
  paid: ['delivered'],
  delivered: [],
  cancelled: [],
};

async function handleUpdateOrder(request, env, orderId) {
  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: 'invalid_json' }, 400);
  }

  const { status: nextStatus } = body;
  if (!nextStatus) return jsonResponse({ error: 'missing_status' }, 400);

  const order = await env.DB.prepare(`SELECT * FROM orders WHERE id = ?`).bind(orderId).first();
  if (!order) return jsonResponse({ error: 'not_found' }, 404);

  if (!(await verifyOwner(request, env, order.site_id))) return jsonResponse({ error: 'unauthorized' }, 401);

  const allowed = VALID_TRANSITIONS[order.status] || [];
  if (!allowed.includes(nextStatus)) {
    return jsonResponse({ error: 'invalid_transition', from: order.status, to: nextStatus }, 409);
  }

  await env.DB.prepare(
    `UPDATE orders SET status = ?, updated_at = ? WHERE id = ?`
  ).bind(nextStatus, nowIso(), orderId).run();

  return jsonResponse({ id: orderId, status: nextStatus });
}

// ---------------------------------------------------------------
// Router
// ---------------------------------------------------------------
export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'access-control-allow-origin': '*',
          'access-control-allow-methods': 'GET,POST,PATCH,OPTIONS',
          'access-control-allow-headers': 'content-type',
        },
      });
    }

    if (url.pathname === '/addon-check' && request.method === 'GET') {
      const siteId = url.searchParams.get('site_id');
      const addonType = url.searchParams.get('type');
      if (!siteId || !addonType) return jsonResponse({ error: 'missing_params' }, 400);
      const active = await isAddonActive(env, siteId, addonType);
      // 200 = active, 402 = not active — lets the caller do `r.ok` for a one-line check
      return active ? jsonResponse({ active: true }, 200) : jsonResponse({ active: false }, 402);
    }

    if (url.pathname === '/api/orders' && request.method === 'POST') {
      return handleCreateOrder(request, env);
    }
    if (url.pathname === '/api/orders' && request.method === 'GET') {
      return handleListOrders(request, env);
    }
    const patchMatch = url.pathname.match(/^\/api\/orders\/([\w_]+)$/);
    if (patchMatch && request.method === 'PATCH') {
      return handleUpdateOrder(request, env, patchMatch[1]);
    }

    return jsonResponse({ error: 'not_found' }, 404);
  },
};

export { isAddonActive };