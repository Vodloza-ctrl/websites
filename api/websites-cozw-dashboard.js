/**
 * websites.co.zw — Dashboard API Worker (SELF-CONTAINED, no imports)
 * ---------------------------------------------------------------------------
 *   GET /api/sites   -> the logged-in owner's sites
 *   GET /health
 *
 * Auth: the wcz_session cookie -> sessions -> owner_id (same contract as the
 * auth and AI Workers). Intended to be routed under app.websites.co.zw/api/*
 * so the session cookie is first-party.
 *
 * Bindings: DB (D1). Vars: APP_ORIGIN.
 */

const DEFAULT_APP_ORIGIN = "https://app.websites.co.zw";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = env.APP_ORIGIN || DEFAULT_APP_ORIGIN;

    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors(origin) });
    if (url.pathname === "/health") return json({ ok: true, service: "websites-cozw-dashboard" }, 200, origin);

    try {
      if (request.method === "GET" && url.pathname === "/api/sites") return await listSites(request, env, origin);
    } catch (err) {
      return json({ error: "internal_error", detail: String(err && err.message || err) }, 500, origin);
    }
    return json({ error: "not_found" }, 404, origin);
  },
};

async function listSites(request, env, origin) {
  const ownerId = await resolveOwnerId(request, env);
  if (!ownerId) return json({ error: "unauthorized" }, 401, origin);

  const res = await env.DB.prepare(
    "SELECT id, site_name, status, plan, draft_subdomain, custom_domain, custom_domain_status, " +
    "published_at, expires_at, COALESCE(ai_generations_used, 0) AS ai_generations_used " +
    "FROM sites WHERE owner_id = ?1 ORDER BY COALESCE(published_at, 0) DESC, site_name ASC"
  ).bind(ownerId).all();

  return json({ sites: (res && res.results) || [] }, 200, origin);
}

async function resolveOwnerId(request, env) {
  const token = parseCookie(request.headers.get("cookie") || "")["wcz_session"];
  if (!token) return null;
  const row = await env.DB
    .prepare("SELECT owner_id FROM sessions WHERE token = ?1 AND expires_at > unixepoch('now')")
    .bind(token).first();
  return row && row.owner_id ? row.owner_id : null;
}

function parseCookie(header) {
  const out = {};
  String(header).split(";").forEach((pair) => {
    const i = pair.indexOf("=");
    if (i > -1) out[pair.slice(0, i).trim()] = decodeURIComponent(pair.slice(i + 1).trim());
  });
  return out;
}
function cors(origin) {
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Credentials": "true",
    "Vary": "Origin",
  };
}
function json(obj, status, origin) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: Object.assign({ "Content-Type": "application/json; charset=utf-8" }, origin ? cors(origin) : {}),
  });
}
