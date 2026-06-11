/**
 * websites.co.zw — Dashboard API Worker  (SELF-CONTAINED, no imports)
 * ---------------------------------------------------------------------
 * Deploy at: app.websites.co.zw  (same host as auth Worker — route via wrangler.toml)
 *
 * Routes:
 *   GET  /api/sites              list owner's sites
 *   POST /api/sites              create a new draft site
 *   GET  /api/sites/:id          single site (includes content JSON)
 *   PUT  /api/sites/:id          save content / site_name
 *   POST /api/sites/:id/generate AI copy generation (proxied to AI Worker)
 *   GET  /health
 *
 * Auth: wcz_session cookie → sessions → owner_id.
 * Every site op verifies site.owner_id === session owner (tenant isolation).
 *
 * Bindings: DB (D1)
 * Vars: APP_ORIGIN, AI_WORKER_URL, AI_SERVICE_SECRET
 */

const DEFAULT_ORIGIN = "https://app.websites.co.zw";

export default {
  async fetch(request, env) {
    const url    = new URL(request.url);
    const origin = env.APP_ORIGIN || DEFAULT_ORIGIN;

    if (request.method === "OPTIONS") return cors(null, 204, origin);
    if (url.pathname === "/health")   return corsJson({ ok: true, service: "websites-cozw-dashboard" }, 200, origin);

    try {
      // Route matching
      const m = url.pathname.match(/^\/api\/sites(?:\/([^/]+)(\/generate)?)?$/);
      if (m) {
        const id         = m[1];
        const isGenerate = !!m[2];

        if (!id && request.method === "GET")  return await listSites(request, env, origin);
        if (!id && request.method === "POST") return await createSite(request, env, origin);
        if (id && isGenerate && request.method === "POST") return await generateContent(request, env, origin, id);
        if (id && request.method === "GET")   return await getSite(request, env, origin, id);
        if (id && request.method === "PUT")   return await saveSite(request, env, origin, id);
      }
    } catch (e) {
      return corsJson({ error: "internal_error", detail: String(e?.message || e) }, 500, origin);
    }

    return corsJson({ error: "not_found" }, 404, origin);
  },
};

/* ── List sites ─────────────────────────────────────────────── */
async function listSites(request, env, origin) {
  const ownerId = await resolveOwner(request, env);
  if (!ownerId) return corsJson({ error: "unauthorized" }, 401, origin);

  const res = await env.DB.prepare(
    "SELECT id, site_name, status, plan, draft_subdomain, custom_domain, custom_domain_status, " +
    "template_id, published_at, expires_at, COALESCE(ai_generations_used,0) AS ai_generations_used " +
    "FROM sites WHERE owner_id=?1 ORDER BY COALESCE(published_at,0) DESC, site_name ASC"
  ).bind(ownerId).all();

  return corsJson({ sites: res?.results || [] }, 200, origin);
}

/* ── Create site ────────────────────────────────────────────── */
async function createSite(request, env, origin) {
  const ownerId = await resolveOwner(request, env);
  if (!ownerId) return corsJson({ error: "unauthorized" }, 401, origin);

  const body     = await readJson(request);
  const siteName = clamp(body.site_name, 120) || "Untitled site";
  const templateId = body.template_id || "bold-retail";

  const id   = "site_" + uid(8);
  const slug = slugify(siteName) + "-" + uid(2);

  // Seed minimal content so the preview renders immediately
  const content = JSON.stringify({
    theme:   { palette: paletteFor(templateId), font_pair: fontFor(templateId) },
    content: { business_name: siteName, tagline: "" }
  });

  await env.DB.prepare(
    "INSERT INTO sites (id,owner_id,site_name,status,draft_subdomain,template_id,plan,content,updated_at) " +
    "VALUES (?1,?2,?3,'draft',?4,?5,'starter',?6,unixepoch())"
  ).bind(id, ownerId, siteName, slug, templateId, content).run();

  return corsJson({ site: await loadSite(env, id) }, 200, origin);
}

/* ── Get one site ───────────────────────────────────────────── */
async function getSite(request, env, origin, id) {
  const ownerId = await resolveOwner(request, env);
  if (!ownerId) return corsJson({ error: "unauthorized" }, 401, origin);
  const site = await loadSite(env, id);
  if (!site) return corsJson({ error: "site_not_found" }, 404, origin);
  if (site.owner_id !== ownerId) return corsJson({ error: "forbidden" }, 403, origin);
  return corsJson({ site }, 200, origin);
}

/* ── Save site ──────────────────────────────────────────────── */
async function saveSite(request, env, origin, id) {
  const ownerId = await resolveOwner(request, env);
  if (!ownerId) return corsJson({ error: "unauthorized" }, 401, origin);

  const row = await env.DB.prepare("SELECT owner_id FROM sites WHERE id=?1").bind(id).first();
  if (!row) return corsJson({ error: "site_not_found" }, 404, origin);
  if (row.owner_id !== ownerId) return corsJson({ error: "forbidden" }, 403, origin);

  const body = await readJson(request);
  if (typeof body.content !== "object" || body.content === null)
    return corsJson({ error: "invalid_content" }, 400, origin);

  const siteName   = clamp(body.site_name, 120);
  const contentStr = JSON.stringify(body.content);
  const templateId = clamp(body.template_id, 40);

  if (siteName && templateId) {
    await env.DB.prepare(
      "UPDATE sites SET site_name=?2,content=?3,template_id=?4,updated_at=unixepoch() WHERE id=?1 AND owner_id=?5"
    ).bind(id, siteName, contentStr, templateId, ownerId).run();
  } else if (siteName) {
    await env.DB.prepare(
      "UPDATE sites SET site_name=?2,content=?3,updated_at=unixepoch() WHERE id=?1 AND owner_id=?4"
    ).bind(id, siteName, contentStr, ownerId).run();
  } else {
    await env.DB.prepare(
      "UPDATE sites SET content=?2,updated_at=unixepoch() WHERE id=?1 AND owner_id=?3"
    ).bind(id, contentStr, ownerId).run();
  }

  return corsJson({ ok: true, site: await loadSite(env, id) }, 200, origin);
}

/* ── AI content generation (proxied to AI Worker) ─────────── */
async function generateContent(request, env, origin, id) {
  const ownerId = await resolveOwner(request, env);
  if (!ownerId) return corsJson({ error: "unauthorized" }, 401, origin);

  const row = await env.DB.prepare("SELECT owner_id FROM sites WHERE id=?1").bind(id).first();
  if (!row) return corsJson({ error: "site_not_found" }, 404, origin);
  if (row.owner_id !== ownerId) return corsJson({ error: "forbidden" }, 403, origin);

  if (!env.AI_WORKER_URL || !env.AI_SERVICE_SECRET)
    return corsJson({ error: "ai_not_configured" }, 503, origin);

  const body = await readJson(request);
  const r = await fetch(env.AI_WORKER_URL.replace(/\/+$/, "") + "/generate", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": "Bearer " + env.AI_SERVICE_SECRET,
      "X-Owner-Id": ownerId,
    },
    body: JSON.stringify({ site_id: id, brief: body.brief || {} }),
  });
  const data = await r.json().catch(() => ({ error: "ai_bad_response" }));
  return corsJson(data, r.status, origin);
}

/* ── Helpers ────────────────────────────────────────────────── */
async function loadSite(env, id) {
  return env.DB.prepare(
    "SELECT id,owner_id,site_name,status,plan,draft_subdomain,custom_domain,custom_domain_status," +
    "template_id,content,published_at,expires_at,COALESCE(ai_generations_used,0) AS ai_generations_used " +
    "FROM sites WHERE id=?1"
  ).bind(id).first();
}

async function resolveOwner(request, env) {
  const token = parseCookie(request.headers.get("cookie") || "")["wcz_session"];
  if (!token) return null;
  const row = await env.DB
    .prepare("SELECT owner_id FROM sessions WHERE token=?1 AND expires_at > unixepoch()")
    .bind(token).first();
  return row?.owner_id || null;
}

async function readJson(request) {
  try { return await request.json(); } catch { return {}; }
}

function clamp(v, max) {
  const s = String(v == null ? "" : v).trim();
  return s.length > max ? s.slice(0, max) : s || null;
}

function slugify(s) {
  return String(s || "").toLowerCase().trim()
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "site";
}

function uid(bytes) {
  bytes = bytes || 16;
  const b = new Uint8Array(bytes);
  crypto.getRandomValues(b);
  return [...b].map(x => x.toString(16).padStart(2, "0")).join("");
}

function parseCookie(h) {
  const out = {};
  String(h).split(";").forEach(pair => {
    const i = pair.indexOf("=");
    if (i > -1) out[pair.slice(0, i).trim()] = decodeURIComponent(pair.slice(i + 1).trim());
  });
  return out;
}

// Sensible palette defaults per template
function paletteFor(t) {
  const m = { "grill-house":"ember-cream","restaurant":"ember-cream","beauty-salon":"blush-plum","salon":"blush-plum",
    "school-institution":"navy-gold","school":"navy-gold","church":"navy-gold","advisory-firm":"slate-gold","consultant":"slate-gold",
    "property-estate":"forest-cream","realestate":"forest-cream" };
  return m[t] || "clean-white";
}
function fontFor(t) {
  const m = { "grill-house":"playfair-jakarta","restaurant":"playfair-jakarta","beauty-salon":"garamond-jost","salon":"garamond-jost",
    "sports":"sports-sans" };
  return m[t] || "grotesk-serif";
}

function cors(resp, status, origin) {
  if (!resp) resp = new Response(null, { status: status || 204 });
  const h = new Headers(resp.headers);
  h.set("Access-Control-Allow-Origin", origin || "*");
  h.set("Access-Control-Allow-Methods", "GET, POST, PUT, OPTIONS");
  h.set("Access-Control-Allow-Headers", "Content-Type");
  h.set("Access-Control-Allow-Credentials", "true");
  h.set("Vary", "Origin");
  return new Response(resp.body, { status: resp.status, headers: h });
}

function corsJson(obj, status, origin) {
  const resp = new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: { "Content-Type": "application/json; charset=utf-8" }
  });
  return cors(resp, status, origin);
}
