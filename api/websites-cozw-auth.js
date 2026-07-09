/**
 * websites.co.zw — Auth + Dashboard API Worker  v5.6
 * Deploy as: websites-cozw-auth
 * Custom domain: app.websites.co.zw
 *
 * v5.6 CHANGE — DOMAIN SEARCH & REGISTRATION ENHANCEMENTS:
 *   Added domain search API for .com availability checking
 *   Enhanced domain wish system for both .com and .co.zw flows
 *   Integrated domain registration into payment flow
 *   Added automatic domain provisioning after payment confirmation
 *   Enhanced admin domain queue with .com registration management
 *
 * v5.5 CHANGE — FIXED SUBDOMAIN SLUG BUG:
 *   createSite() and saveSite() now correctly check for actual collisions
 *   before appending suffixes, so clean names stay clean when available.
 *
 * v5.4 CHANGE — REMOVED ONE-SITE-PER-ACCOUNT LIMIT:
 *   Accounts can now create unlimited sites.
 *
 * v5.3 CHANGE — PAYMENTS UNIFIED ONTO THE PAYMENTS WORKER:
 *   publishSite() and renewSite() now delegate to the payments Worker.
 *
 * Routes:
 *   POST /auth/request-otp
 *   POST /auth/verify-otp
 *   GET  /auth/me
 *   POST /auth/logout
 *   GET  /api/sites
 *   POST /api/sites
 *   GET  /api/sites/:id
 *   PUT  /api/sites/:id
 *   POST /api/sites/:id/generate
 *   DELETE /api/sites/:id
 *   POST /api/sites/:id/publish       (delegates to payments Worker)
 *   POST /api/sites/:id/renew         (delegates to payments Worker)
 *   GET  /api/sites/:id/preview-token
 *   POST /api/recommend-template      (AI Worker proxy)
 *   POST /api/ai/tune                 (AI Worker proxy)
 *   POST /api/sites/:id/upload-url
 *   PUT  /api/sites/:id/template
 *   POST /api/sites/:id/domain-wish   (Enhanced for .com and .co.zw)
 *   GET  /api/sites/:id/domain-wish
 *   GET  /api/sites/:id/email-routes
 *   POST /api/sites/:id/email-routes
 *   GET  /api/sites/:id/email-routes/status
 *   DELETE /api/sites/:id/email-routes/:rid
 *   GET  /api/payments/:ref           (thin proxy to payments Worker)
 *   GET  /api/admin/stats
 *   GET  /api/admin/sites
 *   PUT  /api/admin/sites/:id
 *   PUT  /api/admin/owners/:id
 *   GET  /api/admin/domain-queue      (Enhanced with .com registrations)
 *   PUT  /api/admin/domain-queue/:id  (Enhanced with .com registration)
 *   PUT  /api/admin/email-routes/:id/verify
 *   POST /api/domain/search           (NEW: Domain availability search)
 *
 * Bindings: DB (D1), ASSETS (R2 bucket: websites-cozw-assets),
 *           AI_WORKER (Service binding -> websites-cozw-ai),
 *           PAYMENTS_WORKER (Service binding -> websites-cozw-payments)
 * Secrets:  OTP_HMAC_SECRET, SESSION_SECRET,
 *           MANYCHAT_API_TOKEN, RESEND_API_KEY, AI_SERVICE_SECRET,
 *           R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY,
 *           ADMIN_SECRET, CF_API_TOKEN, CF_ZONE_ID
 * Vars:     APP_ORIGIN, PAGES_HOST, RESEND_FROM, DEV_MODE,
 *           AI_WORKER_URL, PAYMENTS_API_URL, ASSETS_PUBLIC_URL,
 *           CF_ACCOUNT_ID, DOMAIN_REGISTRAR_API_KEY (optional)
 */

// ── Constants ─────────────────────────────────────────────────────────────────
const OTP_TTL        = 10 * 60;
const SESSION_TTL    = 30 * 24 * 3600;
const PREVIEW_TTL    = 5 * 60;
const MAX_ATTEMPTS   = 5;
const RATE_LIMIT_WIN = 5 * 60;
const RATE_LIMIT_MAX = 3;
const GEN_CAP_STARTER = 5;

// Domain pricing
const DOMAIN_PRICES = {
  com: 12.00,  // USD per year
  cozw: 10.00, // USD per year (manual registration fee)
};

// These fields are always preserved from the existing site when AI regenerates.
const OWNER_ASSET_FIELDS = ["team", "gallery", "images", "testimonials", "products", "menu", "listings", "agents", "services"];

const PAGES_DASHBOARD = "https://www.websites.co.zw/dashboard";

// ── Entry point ───────────────────────────────────────────────────────────────
export default {
  async fetch(request, env) {
    const url    = new URL(request.url);
    const path   = url.pathname;
    const method = request.method;
    const origin = request.headers.get("Origin") || "";

    // ── CORS preflight ───────────────────────────────────────────────────────
    if (method === "OPTIONS") return cors(null, 204, origin);

    // ── Health check ─────────────────────────────────────────────────────────
    if (path === "/health")
      return respond({ ok: true, service: "websites-cozw-auth", version: "5.6" }, 200, origin);

    // ── Dashboard HTML → redirect to Pages ──────────────────────────────────
    if (path === "/dashboard" || path === "/dashboard/")
      return Response.redirect(PAGES_DASHBOARD + "/customer.html", 302);
    if (path === "/dashboard/customer" || path === "/dashboard/customer.html")
      return Response.redirect(PAGES_DASHBOARD + "/customer.html", 302);
    if (path === "/dashboard/admin" || path === "/dashboard/admin.html")
      return Response.redirect(PAGES_DASHBOARD + "/admin.html", 302);

    // ── Auth routes ───────────────────────────────────────────────────────────
    if (path === "/auth/request-otp" && method === "POST")
      return respond(await handleRequestOtp(request, env), 200, origin);
    if (path === "/auth/verify-otp" && method === "POST")
      return respond(await handleVerifyOtp(request, env), 200, origin);
    if (path === "/auth/me" && method === "GET")
      return respond(await handleMe(request, env), 200, origin);
    if (path === "/auth/logout" && method === "POST")
      return respond(await handleLogout(request, env), 200, origin);

    // ── Admin API routes ──────────────────────────────────────────────────────
    try {
      if (path === "/api/admin/stats" && method === "GET")
        return await adminStats(request, env, origin);
      if (path === "/api/admin/sites" && method === "GET")
        return await adminListSites(request, env, origin);
      const mAdminSite = path.match(/^\/api\/admin\/sites\/([^/]+)$/);
      if (mAdminSite && method === "PUT")
        return await adminUpdateSite(request, env, origin, mAdminSite[1]);
      const mOwner = path.match(/^\/api\/admin\/owners\/([^/]+)$/);
      if (mOwner && method === "PUT")
        return await adminUpdateOwner(request, env, origin, mOwner[1]);
      if (path === "/api/admin/domain-queue" && method === "GET")
        return await adminGetDomainQueue(request, env, origin);
      const mDQ = path.match(/^\/api\/admin\/domain-queue\/([^/]+)$/);
      if (mDQ && method === "PUT")
        return await adminUpdateDomainWish(request, env, origin, mDQ[1]);
      const mER = path.match(/^\/api\/admin\/email-routes\/([^/]+)\/verify$/);
      if (mER && method === "PUT")
        return await adminVerifyEmailRoute(request, env, origin, mER[1]);
    } catch (e) {
      return jsonResp({ error: "admin_error", detail: String(e?.message || e) }, 500, origin);
    }

    // ── Dashboard / payment API routes ────────────────────────────────────────
    try {
      // Domain Search - NEW
      if (path === "/api/domain/search" && method === "POST")
        return await domainSearch(request, env, origin);

      // Poll payment status — thin proxy to the payments Worker
      const mPayPoll = path.match(/^\/api\/payments\/([^/]+)$/);
      if (mPayPoll && method === "GET")
        return await pollPayment(request, env, origin, mPayPoll[1]);

      // Publish / renew — delegate to the payments Worker
      const mPublish = path.match(/^\/api\/sites\/([^/]+)\/publish$/);
      if (mPublish && method === "POST")
        return await publishSite(request, env, origin, mPublish[1]);
      const mRenew = path.match(/^\/api\/sites\/([^/]+)\/renew$/);
      if (mRenew && method === "POST")
        return await renewSite(request, env, origin, mRenew[1]);

      // Preview token
      const mPreviewTok = path.match(/^\/api\/sites\/([^/]+)\/preview-token$/);
      if (mPreviewTok && method === "GET")
        return await getPreviewToken(request, env, origin, mPreviewTok[1]);

      // AI template recommendation
      if (path === "/api/recommend-template" && method === "POST")
        return await recommendTemplate(request, env, origin);

      // AI copy tune-up
      if (path === "/api/ai/tune" && method === "POST")
        return await tuneTextProxy(request, env, origin);

      // Upload URL
      const mUpload = path.match(/^\/api\/sites\/([^/]+)\/upload-url$/);
      if (mUpload && method === "POST")
        return await getUploadUrl(request, env, origin, mUpload[1]);

      // Template switch
      const mTemplate = path.match(/^\/api\/sites\/([^/]+)\/template$/);
      if (mTemplate && method === "PUT")
        return await switchTemplate(request, env, origin, mTemplate[1]);

      // Custom hostname (Cloudflare for SaaS — Pro tier)
      const mCHCheck = path.match(/^\/api\/sites\/([^/]+)\/custom-hostname\/check$/);
      if (mCHCheck && method === "POST") return await checkCustomHostname(request, env, origin, mCHCheck[1]);
      const mCH = path.match(/^\/api\/sites\/([^/]+)\/custom-hostname$/);
      if (mCH && method === "POST") return await provisionCustomHostname(request, env, origin, mCH[1]);
      if (mCH && method === "GET")  return await getCustomHostname(request, env, origin, mCH[1]);

      // Domain wish - Enhanced
      const mDW = path.match(/^\/api\/sites\/([^/]+)\/domain-wish$/);
      if (mDW && method === "POST") return await submitDomainWish(request, env, origin, mDW[1]);
      if (mDW && method === "GET")  return await getDomainWish(request, env, origin, mDW[1]);

      // Email routes
      const mERList = path.match(/^\/api\/sites\/([^/]+)\/email-routes$/);
      if (mERList && method === "GET")  return await listEmailRoutes(request, env, origin, mERList[1]);
      if (mERList && method === "POST") return await createEmailRoute(request, env, origin, mERList[1]);
      const mERStatus = path.match(/^\/api\/sites\/([^/]+)\/email-routes\/status$/);
      if (mERStatus && method === "GET") return await pollEmailRouteStatus(request, env, origin, mERStatus[1]);
      const mERDel = path.match(/^\/api\/sites\/([^/]+)\/email-routes\/([^/]+)$/);
      if (mERDel && method === "DELETE") return await deleteEmailRoute(request, env, origin, mERDel[1], mERDel[2]);

      // Delete site
      const mDel = path.match(/^\/api\/sites\/([^/]+)$/);
      if (mDel && method === "DELETE") return await deleteSite(request, env, origin, mDel[1]);

      // Sites CRUD
      const m = path.match(/^\/api\/sites(?:\/([^/]+)(\/generate)?)?$/);
      if (m) {
        const id = m[1], isGenerate = !!m[2];
        if (!id && method === "GET")               return await listSites(request, env, origin);
        if (!id && method === "POST")              return await createSite(request, env, origin);
        if (id && isGenerate && method === "POST") return await generateContent(request, env, origin, id);
        if (id && method === "GET")                return await getSite(request, env, origin, id);
        if (id && method === "PUT")                return await saveSite(request, env, origin, id);
      }
    } catch (e) {
      return jsonResp({ error: "internal_error", detail: String(e?.message || e) }, 500, origin);
    }

    // ── Everything else → Pages marketing site ────────────────────────────────
    const pagesHost = env.PAGES_HOST || "websites-aon.pages.dev";
    const pagesUrl  = new URL(request.url);
    pagesUrl.hostname = pagesHost;
    return fetch(new Request(pagesUrl.toString(), request));
  },
};

// ═══════════════════════════════════════════════════════════════════════════════
// AUTH HANDLERS
// ═══════════════════════════════════════════════════════════════════════════════

async function handleRequestOtp(request, env) {
  let body;
  try { body = await request.json(); } catch { return { error: "bad_json", _status: 400 }; }

  const channel = body.channel === "email" ? "email" : "whatsapp";
  const phone   = normalizePhone(String(body.phone || "").trim());
  if (!phone) return { error: "invalid_phone", _status: 400 };

  const now    = nowSec();
  const recent = await env.DB
    .prepare("SELECT COUNT(*) AS n FROM otp_codes WHERE phone=?1 AND created_at > ?2")
    .bind(phone, now - RATE_LIMIT_WIN).first();
  if (recent && recent.n >= RATE_LIMIT_MAX) return { error: "too_many_requests", _status: 429 };

  const code     = String(Math.floor(100000 + crypto.getRandomValues(new Uint32Array(1))[0] % 900000));
  const codeHash = await hmac(env.OTP_HMAC_SECRET || "dev-secret", phone + ":" + code);
  const otpId    = "otp_" + uid();

  await env.DB.prepare(
    "INSERT INTO otp_codes (id,phone,code_hash,channel,expires_at,created_at) VALUES (?1,?2,?3,?4,?5,?6)"
  ).bind(otpId, phone, codeHash, channel, now + OTP_TTL, now).run();

  let sent = false;
  if (channel === "whatsapp") {
    sent = await sendWhatsApp(env, phone, code);
  } else {
    const email = String(body.email || "").trim();
    if (email) sent = await sendEmail(env, email, code);
  }

  const devCode = (!sent || env.DEV_MODE === "1") ? code : undefined;
  return { ok: true, channel, ...(devCode ? { dev_code: devCode } : {}) };
}

async function handleVerifyOtp(request, env) {
  let body;
  try { body = await request.json(); } catch { return { error: "bad_json", _status: 400 }; }

  const phone = normalizePhone(String(body.phone || "").trim());
  const code  = String(body.code || "").replace(/\D/g, "").slice(0, 6);
  if (!phone || code.length < 4) return { error: "invalid_input", _status: 400 };

  const now = nowSec();
  const otp = await env.DB.prepare(
    "SELECT id, code_hash, attempts FROM otp_codes " +
    "WHERE phone=?1 AND consumed_at IS NULL AND expires_at > ?2 ORDER BY created_at DESC LIMIT 1"
  ).bind(phone, now).first();

  if (!otp) return { error: "code_expired_or_missing", _status: 400 };
  if (otp.attempts >= MAX_ATTEMPTS) return { error: "too_many_attempts", _status: 400 };

  const expected = await hmac(env.OTP_HMAC_SECRET || "dev-secret", phone + ":" + code);
  const match    = timingSafe(expected, otp.code_hash);

  await env.DB.prepare("UPDATE otp_codes SET attempts=attempts+1 WHERE id=?1").bind(otp.id).run();
  if (!match) return { error: "invalid_code", _status: 400 };
  await env.DB.prepare("UPDATE otp_codes SET consumed_at=?2 WHERE id=?1").bind(otp.id, now).run();

  let owner = await env.DB.prepare(
    "SELECT id, phone, name, email FROM owners WHERE phone=?1"
  ).bind(phone).first();

  if (!owner) {
    const ownerId = "usr_" + uid();
    await env.DB.prepare("INSERT INTO owners (id, phone, created_at) VALUES (?1, ?2, ?3)")
      .bind(ownerId, phone, now).run();
    owner = { id: ownerId, phone, name: null, email: null };
  }

  const token     = uid(48);
  const expiresAt = now + SESSION_TTL;
  await env.DB.prepare(
    "INSERT INTO sessions (token, owner_id, expires_at, created_at) VALUES (?1, ?2, ?3, ?4)"
  ).bind(token, owner.id, expiresAt, now).run();

  const cookieOpts = `Path=/; HttpOnly; Secure; SameSite=None; Max-Age=${SESSION_TTL}`;

  return {
    _cookies: [
      `wcz_session=${token}; ${cookieOpts}`,
    ],
    ok: true, token,
    owner: { id: owner.id, phone: owner.phone, name: owner.name },
  };
}

async function handleMe(request, env) {
  const token = resolveToken(request);
  if (!token) return { authenticated: false };
  const row = await env.DB.prepare(
    "SELECT s.owner_id, o.phone, o.name, o.email FROM sessions s " +
    "JOIN owners o ON o.id = s.owner_id WHERE s.token=?1 AND s.expires_at > ?2"
  ).bind(token, nowSec()).first();
  if (!row) return { authenticated: false };
  return { authenticated: true, owner: { id: row.owner_id, phone: row.phone, name: row.name, email: row.email } };
}

async function handleLogout(request, env) {
  const token = parseCookie(request.headers.get("cookie") || "")["wcz_session"];
  if (token) await env.DB.prepare("DELETE FROM sessions WHERE token=?1").bind(token).run().catch(() => {});
  return {
    _cookies: [
      "wcz_session=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax",
    ],
    ok: true,
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// DASHBOARD API HANDLERS
// ═══════════════════════════════════════════════════════════════════════════════

async function listSites(request, env, origin) {
  const ownerId = await resolveOwner(request, env);
  if (!ownerId) return jsonResp({ error: "unauthorized" }, 401, origin);
  const res = await env.DB.prepare(
    "SELECT id, site_name, status, plan, draft_subdomain, custom_domain, custom_domain_status, " +
    "template_id, published_at, expires_at, COALESCE(ai_generations_used,0) AS ai_generations_used " +
    "FROM sites WHERE owner_id=?1 ORDER BY COALESCE(published_at,0) DESC, site_name ASC"
  ).bind(ownerId).all();
  return jsonResp({ sites: res?.results || [] }, 200, origin);
}

async function createSite(request, env, origin) {
  const ownerId = await resolveOwner(request, env);
  if (!ownerId) return jsonResp({ error: "unauthorized" }, 401, origin);

  const body       = await readJson(request);
  const siteName   = clamp(body.site_name, 120) || "Untitled site";
  const templateId = body.template_id || "bold-retail";
  const id         = "site_" + uid(8);
  const slug       = await uniqueSlug(env, slugify(siteName), null);
  const content    = JSON.stringify({
    theme:   { palette: paletteFor(templateId), font_pair: fontFor(templateId) },
    content: { business_name: siteName, tagline: "" }
  });
  await env.DB.prepare(
    "INSERT INTO sites (id,owner_id,site_name,status,draft_subdomain,template_id,plan,content,updated_at) " +
    "VALUES (?1,?2,?3,'draft',?4,?5,'starter',?6,unixepoch())"
  ).bind(id, ownerId, siteName, slug, templateId, content).run();
  return jsonResp({ site: await loadSite(env, id) }, 200, origin);
}

async function getSite(request, env, origin, id) {
  const ownerId = await resolveOwner(request, env);
  if (!ownerId) return jsonResp({ error: "unauthorized" }, 401, origin);
  const site = await loadSite(env, id);
  if (!site) return jsonResp({ error: "site_not_found" }, 404, origin);
  if (site.owner_id !== ownerId) return jsonResp({ error: "forbidden" }, 403, origin);
  return jsonResp({ site }, 200, origin);
}

async function saveSite(request, env, origin, id) {
  const ownerId = await resolveOwner(request, env);
  if (!ownerId) return jsonResp({ error: "unauthorized" }, 401, origin);
  const row = await env.DB.prepare("SELECT owner_id, status FROM sites WHERE id=?1").bind(id).first();
  if (!row) return jsonResp({ error: "site_not_found" }, 404, origin);
  if (row.owner_id !== ownerId) return jsonResp({ error: "forbidden" }, 403, origin);
  const body = await readJson(request);
  if (typeof body.content !== "object" || body.content === null)
    return jsonResp({ error: "invalid_content" }, 400, origin);
  const siteName   = clamp(body.site_name, 120);
  const contentStr = JSON.stringify(body.content);
  const templateId = clamp(body.template_id, 40);
  if (siteName && templateId) {
    await env.DB.prepare("UPDATE sites SET site_name=?2,content=?3,template_id=?4,updated_at=unixepoch() WHERE id=?1 AND owner_id=?5")
      .bind(id, siteName, contentStr, templateId, ownerId).run();
  } else if (siteName) {
    await env.DB.prepare("UPDATE sites SET site_name=?2,content=?3,updated_at=unixepoch() WHERE id=?1 AND owner_id=?4")
      .bind(id, siteName, contentStr, ownerId).run();
  } else {
    await env.DB.prepare("UPDATE sites SET content=?2,updated_at=unixepoch() WHERE id=?1 AND owner_id=?3")
      .bind(id, contentStr, ownerId).run();
  }
  if (siteName && row.status === "draft") {
    const newSlug = await uniqueSlug(env, slugify(siteName), id);
    await env.DB.prepare("UPDATE sites SET draft_subdomain=?2 WHERE id=?1 AND status='draft'")
      .bind(id, newSlug).run().catch(() => {});
  }
  return jsonResp({ ok: true, site: await loadSite(env, id) }, 200, origin);
}

async function generateContent(request, env, origin, id) {
  const ownerId = await resolveOwner(request, env);
  if (!ownerId) return jsonResp({ error: "unauthorized" }, 401, origin);
  const row = await env.DB.prepare(
    "SELECT owner_id, plan, content, template_id, COALESCE(ai_generations_used,0) AS ai_gen_used FROM sites WHERE id=?1"
  ).bind(id).first();
  if (!row) return jsonResp({ error: "site_not_found" }, 404, origin);
  if (row.owner_id !== ownerId) return jsonResp({ error: "forbidden" }, 403, origin);
  if (!env.AI_WORKER_URL || !env.AI_SERVICE_SECRET)
    return jsonResp({ error: "ai_not_configured" }, 503, origin);
  const genUsed = Number(row.ai_gen_used) || 0;
  if (genUsed >= GEN_CAP_STARTER)
    return jsonResp({ error: "gen_cap_reached", cap: GEN_CAP_STARTER, used: genUsed }, 429, origin);
  const brief = await readJson(request);
  let aiResult;
  try {
    const aiPayload = {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Bearer " + env.AI_SERVICE_SECRET,
        "X-Owner-Id": ownerId
      },
      body: JSON.stringify({ site_id: id, brief, template_id: row.template_id }),
    };
    const aiResp = env.AI_WORKER
      ? await env.AI_WORKER.fetch(new Request("https://internal/generate", aiPayload))
      : await fetch(env.AI_WORKER_URL.replace(/\/+$/, "") + "/generate", aiPayload);
    if (!aiResp.ok) {
      let aiErr = {}; try { aiErr = await aiResp.json(); } catch { aiErr = { error: "ai_worker_error" }; }
      if (aiResp.status === 429) return jsonResp({ error: aiErr.error || "gen_cap_reached", detail: aiErr.budget || null, message: "AI generation limit reached" }, 429, origin);
      return jsonResp({ error: "ai_worker_error", status: aiResp.status, detail: aiErr }, 502, origin);
    }
    aiResult = await aiResp.json().catch(() => null);
  } catch (err) {
    return jsonResp({ error: "ai_worker_unreachable", detail: String(err.message) }, 502, origin);
  }
  if (!aiResult || typeof aiResult !== "object") return jsonResp({ error: "ai_bad_response" }, 502, origin);
  if (aiResult.error) return jsonResp(aiResult, 502, origin);
  const hasWrapper = !!(aiResult.theme && aiResult.content);
  const hasFlat    = !!aiResult.business_name;
  if (!hasWrapper && !hasFlat) return jsonResp({ error: "ai_bad_response", detail: "missing content fields" }, 502, origin);
  let currentDoc = {}; try { currentDoc = JSON.parse(row.content || "{}"); } catch {}
  if (hasWrapper) aiResult.content._brief = brief; else aiResult._brief = brief;
  const merged = mergeContent(currentDoc, aiResult);
  await env.DB.prepare("UPDATE sites SET content=?2, updated_at=unixepoch() WHERE id=?1 AND owner_id=?3")
    .bind(id, JSON.stringify(merged), ownerId).run();
  const aiGenCount = (aiResult.budget && aiResult.budget.used) || (genUsed + 1);
  return jsonResp({ ok: true, gen_count: aiGenCount, cap: GEN_CAP_STARTER, theme: merged.theme || {}, content: merged.content || merged }, 200, origin);
}

async function deleteSite(request, env, origin, id) {
  const ownerId = await resolveOwner(request, env);
  if (!ownerId) return jsonResp({ error: "unauthorized" }, 401, origin);
  const site = await env.DB.prepare("SELECT owner_id, status FROM sites WHERE id=?1").bind(id).first();
  if (!site) return jsonResp({ error: "site_not_found" }, 404, origin);
  if (site.owner_id !== ownerId) return jsonResp({ error: "forbidden" }, 403, origin);
  if (site.status === "published" || site.status === "grace")
    return jsonResp({ error: "cannot_delete_live_site", message: "Suspend or let the subscription expire first." }, 400, origin);
  await env.DB.prepare("DELETE FROM sites WHERE id=?1 AND owner_id=?2").bind(id, ownerId).run();
  return jsonResp({ ok: true, deleted: id }, 200, origin);
}

// ═══════════════════════════════════════════════════════════════════════════════
// DOMAIN WISH SYSTEM - ENHANCED
// ═══════════════════════════════════════════════════════════════════════════════

async function submitDomainWish(request, env, origin, siteId) {
  const ownerId = await resolveOwner(request, env);
  if (!ownerId) return jsonResp({ error: "unauthorized" }, 401, origin);
  
  const site = await env.DB.prepare(
    "SELECT owner_id, plan, status FROM sites WHERE id=?1"
  ).bind(siteId).first();
  
  if (!site) return jsonResp({ error: "site_not_found" }, 404, origin);
  if (site.owner_id !== ownerId) return jsonResp({ error: "forbidden" }, 403, origin);
  
  const body = await readJson(request);
  const choice1 = sanitizeSlug(body.choice_1);
  const choice2 = sanitizeSlug(body.choice_2);
  const choice3 = sanitizeSlug(body.choice_3);
  
  if (!choice1) {
    return jsonResp({ 
      error: "choice_1_required", 
      message: "Enter at least one domain name preference." 
    }, 400, origin);
  }

  // Determine TLD based on plan or user selection
  const tld = body.tld || (site.plan === 'pro' ? '.com' : '.co.zw');
  const plan = site.plan || 'starter';
  const now = nowSec();
  
  const existing = await env.DB.prepare(
    "SELECT id FROM domain_wishes WHERE site_id=?1"
  ).bind(siteId).first();
  
  const wishId = existing?.id || "dwsh_" + uid(8);
  
  if (existing) {
    await env.DB.prepare(
      `UPDATE domain_wishes SET 
        choice_1=?2, choice_2=?3, choice_3=?4,
        tld=?5, plan=?6, status='pending', notes=NULL, updated_at=?7 
       WHERE id=?1`
    ).bind(wishId, choice1, choice2 || null, choice3 || null, tld, plan, now).run();
  } else {
    await env.DB.prepare(
      `INSERT INTO domain_wishes 
        (id, site_id, owner_id, plan, tld, choice_1, choice_2, choice_3, status, created_at, updated_at) 
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 'pending', ?9, ?9)`
    ).bind(wishId, siteId, ownerId, plan, tld, choice1, choice2 || null, choice3 || null, now).run();
  }

  // Build preview
  const preview = {
    choice_1: choice1 + tld,
    choice_2: choice2 ? choice2 + tld : null,
    choice_3: choice3 ? choice3 + tld : null,
  };

  // If this is .com, we can check availability now
  if (tld === '.com') {
    const domainCheck = await checkDomainAvailability(choice1 + '.com', env);
    if (domainCheck.available) {
      return jsonResp({
        ok: true,
        wish_id: wishId,
        preview,
        auto_register_available: true,
        domain: choice1 + '.com',
        price: DOMAIN_PRICES.com,
        currency: 'USD',
        message: `✅ ${choice1}.com is available! We'll register it automatically after payment.`,
        requires_payment: true
      }, 200, origin);
    } else {
      return jsonResp({
        ok: true,
        wish_id: wishId,
        preview,
        auto_register_available: false,
        message: `${choice1}.com is taken. Please check your other choices, or try a different name.`,
        requires_manual: true
      }, 200, origin);
    }
  }

  // For .co.zw - manual registration
  return jsonResp({
    ok: true,
    wish_id: wishId,
    preview,
    price: DOMAIN_PRICES.cozw,
    currency: 'USD',
    message: "Your domain preferences have been saved. We'll check availability and register your top available choice within 1-2 business days.",
    manual_registration: true
  }, 200, origin);
}

async function getDomainWish(request, env, origin, siteId) {
  const ownerId = await resolveOwner(request, env);
  if (!ownerId) return jsonResp({ error: "unauthorized" }, 401, origin);
  const wish = await env.DB.prepare(
    "SELECT * FROM domain_wishes WHERE site_id=?1 AND owner_id=?2"
  ).bind(siteId, ownerId).first();
  return jsonResp({ wish: wish || null }, 200, origin);
}

// ── Helper: Check domain availability ──────────────────────────────────────
async function checkDomainAvailability(domain, env) {
  if (!env.CF_API_TOKEN) {
    return { available: false, error: "CF_API_TOKEN not configured" };
  }
  try {
    const cfResp = await fetch(
      `https://api.cloudflare.com/client/v4/registrar/domains/check`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${env.CF_API_TOKEN}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ domain_name: domain })
      }
    );
    const data = await cfResp.json();
    return {
      available: data.success && data.result?.available || false,
      price: data.result?.price || DOMAIN_PRICES.com,
      currency: 'USD'
    };
  } catch (e) {
    return { available: false, error: String(e?.message || e) };
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// DOMAIN SEARCH API - .com domain availability checking
// ═══════════════════════════════════════════════════════════════════════════════

async function domainSearch(request, env, origin) {
  const ownerId = await resolveOwner(request, env);
  if (!ownerId) return jsonResp({ error: "unauthorized" }, 401, origin);

  const body = await readJson(request);
  const query = body.query?.toLowerCase().trim();
  const tld = body.tld || 'com';
  
  if (!query || query.length < 2) {
    return jsonResp({ error: "query_too_short", min: 2 }, 400, origin);
  }

  // Use Cloudflare Registrar API for .com
  if (tld === 'com') {
    try {
      const domainName = `${query}.${tld}`;
      
      // Check availability via Cloudflare API
      const cfResp = await fetch(
        `https://api.cloudflare.com/client/v4/registrar/domains/check`,
        {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${env.CF_API_TOKEN}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({ domain_name: domainName })
        }
      );
      
      const data = await cfResp.json();
      
      if (!cfResp.ok || !data.success) {
        return jsonResp({ 
          error: "cf_api_error", 
          detail: data.errors?.[0]?.message || "Cloudflare API error" 
        }, 502, origin);
      }

      // Generate suggestions
      const suggestions = [];
      
      // Add the exact match
      suggestions.push({
        domain: domainName,
        available: data.result?.available || false,
        price: data.result?.price || DOMAIN_PRICES.com,
        currency: 'USD'
      });

      // Generate alternative suggestions if not available
      if (!data.result?.available) {
        const prefixes = ['get', 'my', 'the', 'go', 'try'];
        const suffixes = ['hub', 'spot', 'place', 'zone', 'co'];
        
        for (const prefix of prefixes) {
          const alt = `${prefix}${query}`;
          if (alt.length > 3 && alt.length < 30) {
            const altDomain = `${alt}.${tld}`;
            try {
              const checkResp = await fetch(
                `https://api.cloudflare.com/client/v4/registrar/domains/check`,
                {
                  method: 'POST',
                  headers: {
                    'Authorization': `Bearer ${env.CF_API_TOKEN}`,
                    'Content-Type': 'application/json'
                  },
                  body: JSON.stringify({ domain_name: altDomain })
                }
              );
              const checkData = await checkResp.json();
              if (checkData.success && checkData.result?.available) {
                suggestions.push({
                  domain: altDomain,
                  available: true,
                  price: checkData.result?.price || DOMAIN_PRICES.com,
                  currency: 'USD',
                  alternative: true
                });
                if (suggestions.length >= 5) break;
              }
            } catch (e) { continue; }
          }
        }
      }

      return jsonResp({ 
        ok: true, 
        query, 
        tld,
        suggestions: suggestions.slice(0, 10)
      }, 200, origin);
      
    } catch (e) {
      return jsonResp({ 
        error: "search_failed", 
        detail: String(e?.message || e) 
      }, 500, origin);
    }
  }

  // For .co.zw, we don't have an automated search API
  // Return a message asking for 3 choices
  return jsonResp({
    ok: true,
    tld: 'co.zw',
    manual: true,
    message: 'Please provide 3 choices for manual registration',
    requires_choices: true
  }, 200, origin);
}

// ═══════════════════════════════════════════════════════════════════════════════
// EMAIL ROUTING
// ═══════════════════════════════════════════════════════════════════════════════

async function listEmailRoutes(request, env, origin, siteId) {
  const ownerId = await resolveOwner(request, env);
  if (!ownerId) return jsonResp({ error: "unauthorized" }, 401, origin);
  const site = await env.DB.prepare("SELECT owner_id FROM sites WHERE id=?1").bind(siteId).first();
  if (!site || site.owner_id !== ownerId) return jsonResp({ error: "forbidden" }, 403, origin);
  const routes = await env.DB.prepare(
    "SELECT id, local_part, destination, verified, status, created_at FROM email_routes WHERE site_id=?1 ORDER BY created_at ASC"
  ).bind(siteId).all();
  return jsonResp({ routes: routes?.results || [] }, 200, origin);
}

async function createEmailRoute(request, env, origin, siteId) {
  const ownerId = await resolveOwner(request, env);
  if (!ownerId) return jsonResp({ error: "unauthorized" }, 401, origin);
  const site = await env.DB.prepare("SELECT owner_id, draft_subdomain, custom_domain, status, plan FROM sites WHERE id=?1").bind(siteId).first();
  if (!site) return jsonResp({ error: "site_not_found" }, 404, origin);
  if (site.owner_id !== ownerId) return jsonResp({ error: "forbidden" }, 403, origin);
  const body      = await readJson(request);
  const localPart = String(body.local_part || "").toLowerCase().replace(/[^a-z0-9._+-]/g, "").slice(0, 64);
  const dest      = String(body.destination || "").trim().toLowerCase();
  if (!localPart) return jsonResp({ error: "local_part_required", message: "Enter the email prefix (e.g. 'info' for info@yoursite.co.zw)" }, 400, origin);
  if (!dest || !dest.includes("@")) return jsonResp({ error: "destination_required", message: "Enter a valid destination email address." }, 400, origin);
  const dup = await env.DB.prepare("SELECT id FROM email_routes WHERE owner_id=?1 AND local_part=?2").bind(ownerId, localPart).first();
  if (dup) return jsonResp({ error: "duplicate_route", message: `${localPart}@websites.co.zw is already set up.` }, 409, origin);
  const plan  = site.plan || "starter";
  const limit = plan === "pro" ? 10 : 3;
  const count = await env.DB.prepare("SELECT COUNT(*) AS n FROM email_routes WHERE site_id=?1").bind(siteId).first();
  if (count && count.n >= limit)
    return jsonResp({ error: "route_limit", message: `${plan} plan allows up to ${limit} email routes.` }, 429, origin);
  const routeId = "er_" + uid(8);
  const now     = nowSec();
  let cfAddressId = null, cfErr = null;
  if (env.CF_API_TOKEN && env.CF_ZONE_ID) {
    try {
      const cfResp = await fetch(
        `https://api.cloudflare.com/client/v4/zones/${env.CF_ZONE_ID}/email/routing/addresses`,
        { method: "POST", headers: { "Authorization": "Bearer " + env.CF_API_TOKEN, "Content-Type": "application/json" }, body: JSON.stringify({ email: dest }) }
      );
      const cfData = await cfResp.json().catch(() => ({}));
      if (cfData.success && cfData.result?.id) cfAddressId = cfData.result.id;
      else if (cfData.errors?.[0]?.code === 10028) cfAddressId = "already_registered";
      else cfErr = cfData.errors?.[0]?.message || "CF Email Routing unavailable";
    } catch (e) { cfErr = String(e.message); }
  }
  await env.DB.prepare(
    "INSERT INTO email_routes (id,owner_id,site_id,local_part,destination,cf_address_id,verified,status,created_at,updated_at) " +
    "VALUES (?1,?2,?3,?4,?5,?6,0,'pending',?7,?7)"
  ).bind(routeId, ownerId, siteId, localPart, dest, cfAddressId, now).run();
  if (env.CF_API_TOKEN && env.CF_ZONE_ID && cfAddressId && cfAddressId !== "already_registered") {
    try {
      await fetch(
        `https://api.cloudflare.com/client/v4/zones/${env.CF_ZONE_ID}/email/routing/rules`,
        { method: "POST", headers: { "Authorization": "Bearer " + env.CF_API_TOKEN, "Content-Type": "application/json" },
          body: JSON.stringify({ name: `${localPart} → ${dest}`, enabled: true, matchers: [{ type: "literal", field: "to", value: `${localPart}@websites.co.zw` }], actions: [{ type: "forward", value: [dest] }] }) }
      );
    } catch {}
  }
  return jsonResp({
    ok: true,
    route: { id: routeId, local_part: localPart, destination: dest, verified: 0, status: "pending" },
    message: cfErr
      ? `Route saved locally but Cloudflare Email Routing returned an error: ${cfErr}. Contact support.`
      : `We've sent a verification email to ${dest}. Click the link in that email to activate ${localPart}@websites.co.zw.`,
    address: `${localPart}@websites.co.zw`,
    needs_verification: true,
  }, 200, origin);
}

async function pollEmailRouteStatus(request, env, origin, siteId) {
  const ownerId = await resolveOwner(request, env);
  if (!ownerId) return jsonResp({ error: "unauthorized" }, 401, origin);
  const site = await env.DB.prepare("SELECT owner_id FROM sites WHERE id=?1").bind(siteId).first();
  if (!site || site.owner_id !== ownerId) return jsonResp({ error: "forbidden" }, 403, origin);
  const routes = await env.DB.prepare(
    "SELECT id, local_part, destination, cf_address_id, verified, status FROM email_routes WHERE site_id=?1"
  ).bind(siteId).all();
  const results = routes?.results || [];
  if (env.CF_API_TOKEN && env.CF_ZONE_ID) {
    for (const route of results) {
      if (route.verified || !route.cf_address_id || route.cf_address_id === "already_registered") continue;
      try {
        const cfResp = await fetch(
          `https://api.cloudflare.com/client/v4/zones/${env.CF_ZONE_ID}/email/routing/addresses/${route.cf_address_id}`,
          { headers: { "Authorization": "Bearer " + env.CF_API_TOKEN } }
        );
        const cfData = await cfResp.json().catch(() => ({}));
        if (cfData.success && cfData.result?.verified) {
          await env.DB.prepare("UPDATE email_routes SET verified=1,status='active',updated_at=unixepoch() WHERE id=?1").bind(route.id).run();
          route.verified = 1; route.status = "active";
        }
      } catch {}
    }
  }
  return jsonResp({ routes: results }, 200, origin);
}

async function deleteEmailRoute(request, env, origin, siteId, routeId) {
  const ownerId = await resolveOwner(request, env);
  if (!ownerId) return jsonResp({ error: "unauthorized" }, 401, origin);
  const route = await env.DB.prepare("SELECT owner_id FROM email_routes WHERE id=?1 AND site_id=?2").bind(routeId, siteId).first();
  if (!route) return jsonResp({ error: "not_found" }, 404, origin);
  if (route.owner_id !== ownerId) return jsonResp({ error: "forbidden" }, 403, origin);
  await env.DB.prepare("DELETE FROM email_routes WHERE id=?1").bind(routeId).run();
  return jsonResp({ ok: true, deleted: routeId }, 200, origin);
}

// ═══════════════════════════════════════════════════════════════════════════════
// ADMIN HANDLERS - ENHANCED
// ═══════════════════════════════════════════════════════════════════════════════

function resolveAdmin(request, env) {
  if (!env.ADMIN_SECRET) return false;
  const auth = request.headers.get("Authorization") || "";
  return auth.startsWith("Bearer ") && auth.slice(7) === env.ADMIN_SECRET;
}

async function adminStats(request, env, origin) {
  if (!resolveAdmin(request, env)) return jsonResp({ error: "unauthorized" }, 401, origin);
  const [sites, owners, payments] = await Promise.all([
    env.DB.prepare("SELECT status, COUNT(*) AS n FROM sites GROUP BY status").all(),
    env.DB.prepare("SELECT COUNT(*) AS n FROM owners").first(),
    env.DB.prepare("SELECT status, COUNT(*) AS n, SUM(amount) AS total FROM payments GROUP BY status").all().catch(() => ({ results: [] })),
  ]);
  const statusCounts = {};
  (sites?.results || []).forEach(r => { statusCounts[r.status] = r.n; });
  const totalSites = Object.values(statusCounts).reduce((a, b) => a + b, 0);
  const paidPayments = (payments?.results || []).find(r => r.status === "paid");
  const aiRow = await env.DB.prepare("SELECT SUM(ai_generations_used) AS total, SUM(ai_cost_usd) AS cost FROM sites").first().catch(() => null);
  return jsonResp({
    sites: { total: totalSites, published: (statusCounts["published"] || 0) + (statusCounts["active"] || 0), draft: statusCounts["draft"] || 0, grace: statusCounts["grace"] || 0, suspended: statusCounts["suspended"] || 0 },
    owners: { total: owners?.n || 0 },
    payments: { paid_count: paidPayments?.n || 0, revenue_usd: paidPayments?.total || 0 },
    ai: { total_generations: aiRow?.total || 0, total_cost_usd: aiRow?.cost || 0 },
    generated_at: nowSec(),
  }, 200, origin);
}

async function adminListSites(request, env, origin) {
  if (!resolveAdmin(request, env)) return jsonResp({ error: "unauthorized" }, 401, origin);
  const url    = new URL(request.url);
  const status = url.searchParams.get("status") || "";
  const limit  = Math.min(parseInt(url.searchParams.get("limit") || "200"), 500);
  const offset = parseInt(url.searchParams.get("offset") || "0");
  let query = "SELECT id, owner_id, site_name, status, plan, draft_subdomain, custom_domain, template_id, published_at, expires_at, COALESCE(ai_generations_used,0) AS ai_generations_used FROM sites";
  const bindings = [];
  if (status) { query += " WHERE status=?1"; bindings.push(status); }
  query += ` ORDER BY COALESCE(published_at,0) DESC, site_name ASC LIMIT ${limit} OFFSET ${offset}`;
  const res = await (bindings.length ? env.DB.prepare(query).bind(...bindings).all() : env.DB.prepare(query).all());
  return jsonResp({ sites: res?.results || [], limit, offset }, 200, origin);
}

async function adminUpdateSite(request, env, origin, id) {
  if (!resolveAdmin(request, env)) return jsonResp({ error: "unauthorized" }, 401, origin);
  const site = await env.DB.prepare("SELECT id FROM sites WHERE id=?1").bind(id).first();
  if (!site) return jsonResp({ error: "site_not_found" }, 404, origin);
  const body    = await readJson(request);
  const updates = [], values = [];
  let idx = 1;
  if (body.status !== undefined) {
    const VALID = ["draft","pending_payment","published","grace","suspended"];
    if (!VALID.includes(body.status)) return jsonResp({ error: "invalid_status", allowed: VALID }, 400, origin);
    updates.push(`status=?${idx++}`); values.push(body.status);
    if (body.status === "published" && body.published_at === undefined) updates.push("published_at=unixepoch()");
  }
  if (body.plan !== undefined) {
    if (!["starter","pro"].includes(body.plan)) return jsonResp({ error: "invalid_plan" }, 400, origin);
    updates.push(`plan=?${idx++}`); values.push(body.plan);
  }
  if (body.expires_at !== undefined && Number.isInteger(body.expires_at)) { updates.push(`expires_at=?${idx++}`); values.push(body.expires_at); }
  if (body.published_at !== undefined && Number.isInteger(body.published_at)) { updates.push(`published_at=?${idx++}`); values.push(body.published_at); }
  if (body.site_name !== undefined) { updates.push(`site_name=?${idx++}`); values.push(String(body.site_name).slice(0,120)); }
  if (body.draft_subdomain !== undefined) { updates.push(`draft_subdomain=?${idx++}`); values.push(String(body.draft_subdomain).slice(0,60)); }
  if (body.ai_generations_used !== undefined && Number.isInteger(body.ai_generations_used)) { updates.push(`ai_generations_used=?${idx++}`); values.push(body.ai_generations_used); }
  if (!updates.length) return jsonResp({ error: "nothing_to_update" }, 400, origin);
  updates.push("updated_at=unixepoch()"); values.push(id);
  await env.DB.prepare(`UPDATE sites SET ${updates.join(",")} WHERE id=?${idx}`).bind(...values).run();
  if (body.status === "published") await purgePublicCache(env, id);
  return jsonResp({ ok: true, site: await loadSite(env, id) }, 200, origin);
}

async function adminUpdateOwner(request, env, origin, id) {
  if (!resolveAdmin(request, env)) return jsonResp({ error: "unauthorized" }, 401, origin);
  const owner = await env.DB.prepare("SELECT id, phone FROM owners WHERE id=?1").bind(id).first();
  if (!owner) return jsonResp({ error: "owner_not_found" }, 404, origin);
  const body = await readJson(request);
  if (body.is_demo !== 0 && body.is_demo !== 1) return jsonResp({ error: "is_demo must be 0 or 1" }, 400, origin);
  await env.DB.prepare("UPDATE owners SET is_demo=?2 WHERE id=?1").bind(id, body.is_demo).run();
  return jsonResp({ ok: true, owner_id: id, phone: owner.phone, is_demo: body.is_demo }, 200, origin);
}

// ENHANCED: Admin domain queue - includes both .co.zw wishes and .com registrations
async function adminGetDomainQueue(request, env, origin) {
  if (!resolveAdmin(request, env)) return jsonResp({ error: "unauthorized" }, 401, origin);
  
  const url = new URL(request.url);
  const status = url.searchParams.get("status") || "pending";
  const limit = Math.min(parseInt(url.searchParams.get("limit") || "100"), 500);
  
  // Get domain wishes (both .com and .co.zw)
  let query = "SELECT dw.*, s.site_name, s.draft_subdomain, s.custom_domain FROM domain_wishes dw LEFT JOIN sites s ON s.id=dw.site_id";
  const binds = [];
  if (status !== "all") { query += " WHERE dw.status=?1"; binds.push(status); }
  query += ` ORDER BY dw.created_at DESC LIMIT ${limit}`;
  const wishes = await (binds.length ? env.DB.prepare(query).bind(...binds).all() : env.DB.prepare(query).all());
  
  // Get pending .com domain registrations from domains table
  const pendingDomains = await env.DB.prepare(
    `SELECT d.*, s.site_name, s.draft_subdomain 
     FROM domains d 
     LEFT JOIN sites s ON s.id = d.site_id 
     WHERE d.verified = 0 AND d.ssl_status = 'pending'
     ORDER BY d.created_at DESC`
  ).all();
  
  return jsonResp({
    wishes: wishes?.results || [],
    pending_domains: pendingDomains?.results || []
  }, 200, origin);
}

// ENHANCED: Admin update domain wish - now handles .com registration too
async function adminUpdateDomainWish(request, env, origin, wishId) {
  if (!resolveAdmin(request, env)) return jsonResp({ error: "unauthorized" }, 401, origin);
  
  const wish = await env.DB.prepare("SELECT * FROM domain_wishes WHERE id=?1").bind(wishId).first();
  if (!wish) return jsonResp({ error: "wish_not_found" }, 404, origin);
  
  const body = await readJson(request);
  const status = body.status || wish.status;
  const assigned = body.assigned || wish.assigned || null;
  const notes = body.notes || wish.notes || null;
  
  await env.DB.prepare(
    "UPDATE domain_wishes SET status=?2, assigned=?3, notes=?4, updated_at=unixepoch() WHERE id=?1"
  ).bind(wishId, status, assigned, notes).run();

  if (status === "active" && assigned) {
    // Update site's custom_domain field
    await env.DB.prepare(
      "UPDATE sites SET custom_domain=?2, custom_domain_status='pending', updated_at=unixepoch() WHERE id=?1"
    ).bind(wish.site_id, assigned).run();

    // Check if it's a .com domain - try to auto-provision
    const isCom = assigned.endsWith('.com') || assigned.endsWith('.dev') || assigned.endsWith('.app');
    let cfResult = null;
    
    if (isCom && env.CF_API_TOKEN) {
      // Try to register the domain via Cloudflare Registrar API
      cfResult = await registerDomainWithCloudflare(env, assigned, wish);
    } else {
      // For .co.zw or if CF not configured, provision as custom hostname
      cfResult = await cfProvisionHostname(env, assigned);
    }
    
    if (cfResult && cfResult.ok) {
      await env.DB.prepare(
        "UPDATE sites SET cf_hostname_id=?2, updated_at=unixepoch() WHERE id=?1"
      ).bind(wish.site_id, cfResult.hostname_id).run().catch(() => {});
    }

    // Notify owner via WhatsApp with DNS instructions
    const owner = await env.DB.prepare("SELECT phone FROM owners WHERE id=?1").bind(wish.owner_id).first();
    if (owner?.phone) {
      const isCom = assigned.endsWith('.com');
      const dnsMsg = cfResult && cfResult.ok
        ? `✅ Your domain ${assigned} ${isCom ? 'has been registered and' : 'has been'} configured! To connect it to your site, add this DNS record:\n\nCNAME: ${assigned} → websites.co.zw\n\nOnce added, your site will be live within a few hours.`
        : `✅ Your domain ${assigned} has been registered! Contact support to complete the setup.`;
      await sendWhatsApp(env, owner.phone, dnsMsg).catch(() => {});
    }
  }

  // If .com domain was successfully registered, also update the domains table
  if (status === "active" && assigned && assigned.endsWith('.com')) {
    try {
      const existing = await env.DB.prepare(
        "SELECT id FROM domains WHERE hostname = ?1"
      ).bind(assigned).first();
      
      if (!existing) {
        await env.DB.prepare(
          `INSERT INTO domains (id, site_id, hostname, verified, ssl_status, created_at) 
           VALUES (?1, ?2, ?3, 1, 'active', CURRENT_TIMESTAMP)`
        ).bind('dom_' + uid(8), wish.site_id, assigned).run();
      }
    } catch (e) {
      console.error('Failed to update domains table:', e);
    }
  }

  return jsonResp({
    ok: true,
    wish: await env.DB.prepare("SELECT * FROM domain_wishes WHERE id=?1").bind(wishId).first(),
  }, 200, origin);
}

// ── Helper: Register domain with Cloudflare Registrar API ──────────────────
async function registerDomainWithCloudflare(env, domainName, wish) {
  if (!env.CF_API_TOKEN) {
    return { ok: false, error: "CF_API_TOKEN not configured" };
  }
  
  try {
    // First check if domain is available
    const checkResp = await fetch(
      `https://api.cloudflare.com/client/v4/registrar/domains/check`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${env.CF_API_TOKEN}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ domain_name: domainName })
      }
    );
    const checkData = await checkResp.json();
    
    if (!checkData.success || !checkData.result?.available) {
      return { ok: false, error: "Domain not available for registration" };
    }
    
    // Get owner details for registrant contact
    const owner = await env.DB.prepare(
      "SELECT email, phone, name FROM owners WHERE id = ?1"
    ).bind(wish.owner_id).first();
    
    // Register the domain
    const registerResp = await fetch(
      `https://api.cloudflare.com/client/v4/registrar/domains`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${env.CF_API_TOKEN}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          domain_name: domainName,
          registrant_contact: {
            email: owner?.email || 'noreply@websites.co.zw',
            phone: owner?.phone || '+2630000000',
            name: owner?.name || 'Website Owner'
          },
          use_default_contact: true,
          privacy: true
        })
      }
    );
    
    const registerData = await registerResp.json();
    
    if (!registerResp.ok) {
      return { ok: false, error: registerData.errors?.[0]?.message || "Registration failed" };
    }
    
    return {
      ok: true,
      hostname_id: registerData.result?.id || 'registered',
      domain: domainName
    };
  } catch (e) {
    return { ok: false, error: String(e?.message || e) };
  }
}

async function adminVerifyEmailRoute(request, env, origin, routeId) {
  if (!resolveAdmin(request, env)) return jsonResp({ error: "unauthorized" }, 401, origin);
  const route = await env.DB.prepare("SELECT * FROM email_routes WHERE id=?1").bind(routeId).first();
  if (!route) return jsonResp({ error: "not_found" }, 404, origin);
  await env.DB.prepare("UPDATE email_routes SET verified=1,status='active',updated_at=unixepoch() WHERE id=?1").bind(routeId).run();
  return jsonResp({ ok: true, route_id: routeId, status: "active", verified: true }, 200, origin);
}

// ═══════════════════════════════════════════════════════════════════════════════
// PUBLISH / RENEW / PAYMENTS — ENHANCED with domain support
// ═══════════════════════════════════════════════════════════════════════════════

function paymentsApiBase(env) {
  return (env.PAYMENTS_API_URL || "https://api.websites.co.zw").replace(/\/+$/, "");
}

// ENHANCED: Delegate to payments worker with domain data
async function delegateToPaymentsWorker(env, origin, siteId, currency, purpose, email, domainData) {
  const payload = {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ 
      site_id: siteId, 
      currency, 
      purpose, 
      email,
      domain_data: domainData || null
    }),
  };
  let resp;
  try {
    resp = env.PAYMENTS_WORKER
      ? await env.PAYMENTS_WORKER.fetch(new Request("https://internal/pay", payload))
      : await fetch(paymentsApiBase(env) + "/pay", payload);
  } catch (e) {
    return jsonResp({ error: "payments_worker_unreachable", detail: String(e?.message) }, 502, origin);
  }
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) return jsonResp({ error: data.error || "payments_worker_error", detail: data }, resp.status, origin);
  return jsonResp({ ok: true, payment_url: data.redirect_url, poll_url: data.poll_url, reference: data.reference }, 200, origin);
}

// ENHANCED: Publish site with domain selection
async function publishSite(request, env, origin, id) {
  const ownerId = await resolveOwner(request, env);
  if (!ownerId) return jsonResp({ error: "unauthorized" }, 401, origin);
  
  const site = await loadSite(env, id);
  if (!site) return jsonResp({ error: "site_not_found" }, 404, origin);
  if (site.owner_id !== ownerId) return jsonResp({ error: "forbidden" }, 403, origin);
  if (site.status !== "draft" && site.status !== "pending_payment") {
    return jsonResp({ error: "already_published", status: site.status }, 400, origin);
  }

  const body = await readJson(request);
  const plan = (body.plan === "pro") ? "pro" : "starter";
  const currency = (body.currency === "ZIG" || body.currency === "zig") ? "ZIG" : "USD";

  // Persist the chosen plan
  await env.DB.prepare("UPDATE sites SET plan=?2, updated_at=unixepoch() WHERE id=?1")
    .bind(id, plan).run();

  // Handle domain selection from the request
  const domainData = body.domain_data;
  let domainCost = 0;
  
  if (domainData) {
    if (domainData.type === 'com' && domainData.name) {
      // .com domain - cost depends on registrar
      domainCost = DOMAIN_PRICES.com;
      
      // Save to domains table
      await env.DB.prepare(
        `INSERT INTO domains (id, site_id, hostname, verified, ssl_status, created_at) 
         VALUES (?1, ?2, ?3, 0, 'pending', CURRENT_TIMESTAMP)`
      ).bind('dom_' + uid(8), id, domainData.name).run();
      
      // Also save to domain_wishes for tracking
      await env.DB.prepare(
        `INSERT INTO domain_wishes 
          (id, site_id, owner_id, plan, tld, choice_1, status, created_at, updated_at) 
         VALUES (?1, ?2, ?3, ?4, '.com', ?5, 'pending_auto', unixepoch(), unixepoch())`
      ).bind('dwsh_' + uid(8), id, ownerId, plan, domainData.name).run();
      
    } else if (domainData.type === 'cozw' && domainData.choices) {
      // .co.zw - save to domain_wishes table
      const choices = domainData.choices;
      domainCost = DOMAIN_PRICES.cozw;
      
      await env.DB.prepare(
        `INSERT INTO domain_wishes 
          (id, site_id, owner_id, plan, tld, choice_1, choice_2, choice_3, status, created_at, updated_at) 
         VALUES (?1, ?2, ?3, ?4, '.co.zw', ?5, ?6, ?7, 'pending', unixepoch(), unixepoch())`
      ).bind(
        'dwsh_' + uid(8), 
        id, 
        ownerId, 
        plan, 
        choices[0] || '', 
        choices[1] || null, 
        choices[2] || null
      ).run();
      
      // Notify admin team about the .co.zw request
      await notifyAdminForDomainRegistration(env, id, choices);
    } else if (domainData.type === 'own' && domainData.name) {
      // User has their own domain - just save it
      await env.DB.prepare(
        "UPDATE sites SET custom_domain=?2, custom_domain_status='pending', updated_at=unixepoch() WHERE id=?1"
      ).bind(id, domainData.name).run();
      
      // Provision custom hostname via Cloudflare for SaaS
      const cfResult = await cfProvisionHostname(env, domainData.name);
      if (cfResult.ok) {
        await env.DB.prepare(
          "UPDATE sites SET cf_hostname_id=?2, updated_at=unixepoch() WHERE id=?1"
        ).bind(id, cfResult.hostname_id).run();
      }
    }
  }

  // Calculate total amount
  const baseAmount = plan === 'pro' ? 60 : 30;
  const totalAmount = baseAmount + domainCost;

  const owner = await env.DB.prepare("SELECT email FROM owners WHERE id=?1").bind(ownerId).first();
  
  // Build domain data for the payment worker
  const paymentDomainData = {
    name: domainData?.name || null,
    type: domainData?.type || null,
    cost: domainCost,
    choices: domainData?.choices || null
  };
  
  return delegateToPaymentsWorker(env, origin, id, currency, "publish", owner?.email || undefined, paymentDomainData);
}

async function renewSite(request, env, origin, id) {
  const ownerId = await resolveOwner(request, env);
  if (!ownerId) return jsonResp({ error: "unauthorized" }, 401, origin);
  const site = await loadSite(env, id);
  if (!site) return jsonResp({ error: "site_not_found" }, 404, origin);
  if (site.owner_id !== ownerId) return jsonResp({ error: "forbidden" }, 403, origin);

  const body     = await readJson(request);
  const currency = (body.currency === "ZIG" || body.currency === "zig") ? "ZIG" : "USD";

  const owner = await env.DB.prepare("SELECT email FROM owners WHERE id=?1").bind(ownerId).first();
  return delegateToPaymentsWorker(env, origin, id, currency, "renewal", owner?.email || undefined);
}

// ── Helper: Notify admin about .co.zw domain request ──────────────────────
async function notifyAdminForDomainRegistration(env, siteId, choices) {
  try {
    const site = await env.DB.prepare(
      "SELECT site_name, draft_subdomain FROM sites WHERE id=?1"
    ).bind(siteId).first();
    
    const message = `📧 New .co.zw domain request for site "${site?.site_name || siteId}"\n\nChoices:\n1. ${choices[0] || ''}.co.zw\n2. ${choices[1] || ''}.co.zw\n3. ${choices[2] || ''}.co.zw\n\nSite: https://${site?.draft_subdomain || ''}.websites.co.zw\n\nPlease register the domain and update the domain wish status.`;
    
    // You can send this to Slack, email, or your admin dashboard
    console.log('Domain registration request:', { siteId, choices, message });
    
    // If you have a Slack webhook, you can send it there
    if (env.SLACK_WEBHOOK) {
      await fetch(env.SLACK_WEBHOOK, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: message })
      });
    }
  } catch (e) {
    console.error('Failed to notify admin:', e);
  }
}

// GET /api/payments/:ref — thin proxy to the payments Worker
async function pollPayment(request, env, origin, ref) {
  const ownerId = await resolveOwner(request, env);
  if (!ownerId) return jsonResp({ error: "unauthorized" }, 401, origin);
  try {
    const resp = env.PAYMENTS_WORKER
      ? await env.PAYMENTS_WORKER.fetch(new Request("https://internal/pay/status?ref=" + encodeURIComponent(ref)))
      : await fetch(paymentsApiBase(env) + "/pay/status?ref=" + encodeURIComponent(ref));
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) return jsonResp(data, resp.status, origin);
    return jsonResp({ payment: data }, 200, origin);
  } catch (e) {
    return jsonResp({ error: "payments_worker_unreachable", detail: String(e?.message) }, 502, origin);
  }
}

// ── PREVIEW TOKEN ──────────────────────────────────────────────────────────────
async function getPreviewToken(request, env, origin, id) {
  const ownerId = await resolveOwner(request, env);
  if (!ownerId) return jsonResp({ error: "unauthorized" }, 401, origin);
  const site = await env.DB.prepare("SELECT owner_id, draft_subdomain FROM sites WHERE id=?1").bind(id).first();
  if (!site) return jsonResp({ error: "site_not_found" }, 404, origin);
  if (site.owner_id !== ownerId) return jsonResp({ error: "forbidden" }, 403, origin);
  if (!site.draft_subdomain) return jsonResp({ error: "no_subdomain" }, 400, origin);
  const token = await mintPreviewToken(env, ownerId, id);
  const previewUrl = `https://${site.draft_subdomain}.websites.co.zw/?preview_token=${token}`;
  return jsonResp({ token, preview_url: previewUrl, expires_in: PREVIEW_TTL }, 200, origin);
}

// ═══════════════════════════════════════════════════════════════════════════════
// AI WORKER PROXIES
// ═══════════════════════════════════════════════════════════════════════════════

async function recommendTemplate(request, env, origin) {
  const ownerId = await resolveOwner(request, env);
  if (!ownerId) return jsonResp({ error: "unauthorized" }, 401, origin);
  if (!env.AI_WORKER_URL && !env.AI_WORKER)
    return jsonResp({ error: "ai_not_configured" }, 503, origin);
  const body = await readJson(request);
  try {
    const payload = {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Bearer " + env.AI_SERVICE_SECRET,
        "X-Owner-Id": ownerId,
      },
      body: JSON.stringify({
        industry: body.industry,
        business_name: body.business_name,
        description: body.description,
      }),
    };
    const aiResp = env.AI_WORKER
      ? await env.AI_WORKER.fetch(new Request("https://internal/recommend-template", payload))
      : await fetch(env.AI_WORKER_URL.replace(/\/+$/, "") + "/recommend-template", payload);
    const data = await aiResp.json().catch(() => ({}));
    if (!aiResp.ok) return jsonResp({ error: "recommend_failed", detail: data }, 502, origin);
    return jsonResp(data, 200, origin);
  } catch (e) {
    return jsonResp({ error: "ai_worker_unreachable", detail: String(e?.message) }, 502, origin);
  }
}

async function tuneTextProxy(request, env, origin) {
  const ownerId = await resolveOwner(request, env);
  if (!ownerId) return jsonResp({ error: "unauthorized" }, 401, origin);
  if (!env.AI_WORKER_URL && !env.AI_WORKER)
    return jsonResp({ error: "ai_not_configured" }, 503, origin);
  const body = await readJson(request);
  if (body.site_id) {
    const site = await env.DB.prepare("SELECT owner_id FROM sites WHERE id=?1").bind(body.site_id).first();
    if (site && site.owner_id !== ownerId) return jsonResp({ error: "forbidden" }, 403, origin);
  }
  try {
    const payload = {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Bearer " + env.AI_SERVICE_SECRET,
        "X-Owner-Id": ownerId,
      },
      body: JSON.stringify(body),
    };
    const aiResp = env.AI_WORKER
      ? await env.AI_WORKER.fetch(new Request("https://internal/tune", payload))
      : await fetch(env.AI_WORKER_URL.replace(/\/+$/, "") + "/tune", payload);
    const data = await aiResp.json().catch(() => ({}));
    if (!aiResp.ok) return jsonResp(data, aiResp.status, origin);
    return jsonResp(data, 200, origin);
  } catch (e) {
    return jsonResp({ error: "ai_worker_unreachable", detail: String(e?.message) }, 502, origin);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// TEMPLATE SWITCH
// ═══════════════════════════════════════════════════════════════════════════════

async function switchTemplate(request, env, origin, id) {
  const ownerId = await resolveOwner(request, env);
  if (!ownerId) return jsonResp({ error: "unauthorized" }, 401, origin);
  const row = await env.DB.prepare("SELECT owner_id, status, content, template_id FROM sites WHERE id=?1").bind(id).first();
  if (!row) return jsonResp({ error: "site_not_found" }, 404, origin);
  if (row.owner_id !== ownerId) return jsonResp({ error: "forbidden" }, 403, origin);
  const body = await readJson(request);
  const newTemplateId = clamp(body.template_id, 40);
  if (!newTemplateId) return jsonResp({ error: "template_id_required" }, 400, origin);
  let currentDoc = {}; try { currentDoc = JSON.parse(row.content || "{}"); } catch {}
  const currentContent = currentDoc.content || currentDoc;
  const preserved = {
    business_name: currentContent.business_name || "", tagline: currentContent.tagline || "",
    about: currentContent.about || "", location: currentContent.location || "",
    contact: currentContent.contact || {}, socials: currentContent.socials || {},
    images: currentContent.images || {}, _brief: currentContent._brief || null,
  };
  const newTheme = { palette: paletteFor(newTemplateId), font_pair: fontFor(newTemplateId), variant: "hero-centered", sections: defaultSectionsFor(newTemplateId) };
  const newContent = JSON.stringify({ theme: newTheme, content: preserved });
  await env.DB.prepare("UPDATE sites SET template_id=?2, content=?3, updated_at=unixepoch() WHERE id=?1 AND owner_id=?4").bind(id, newTemplateId, newContent, ownerId).run();
  return jsonResp({ ok: true, site: await loadSite(env, id) }, 200, origin);
}

function defaultSectionsFor(t) {
  const d = {
    "bold-retail":         ["hero","about","services","gallery","contact"],
    "grill-house":         ["hero","menu","about","gallery","contact"],
    "beauty-salon":        ["hero","services","about","gallery","contact"],
    "school-institution":  ["hero","stats","about","services","gallery","contact"],
    "advisory-firm":       ["hero","services","about","team","contact"],
    "property-estate":     ["hero","services","about","gallery","contact"],
    "boutique-fashion":    ["hero","products","about","gallery","contact"],
    "grocery-fmcg":        ["hero","products","about","contact"],
    "hardware-store":      ["hero","products","services","about","contact"],
  };
  return d[t] || ["hero","about","services","contact"];
}

// ═══════════════════════════════════════════════════════════════════════════════
// UPLOAD
// ═══════════════════════════════════════════════════════════════════════════════

async function getUploadUrl(request, env, origin, id) {
  const ownerId = await resolveOwner(request, env);
  if (!ownerId) return jsonResp({ error: "unauthorized" }, 401, origin);
  const row = await env.DB.prepare("SELECT owner_id FROM sites WHERE id=?1").bind(id).first();
  if (!row) return jsonResp({ error: "site_not_found" }, 404, origin);
  if (row.owner_id !== ownerId) return jsonResp({ error: "forbidden" }, 403, origin);
  const body        = await readJson(request);
  const contentType = String(body.content_type || "").toLowerCase();
  const uploadType  = String(body.type || "gallery");
  const filename    = String(body.filename || "image").replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 80);
  const ALLOWED_TYPES = ["image/jpeg","image/png","image/webp","image/gif","image/svg+xml"];
  if (!ALLOWED_TYPES.includes(contentType)) return jsonResp({ error: "invalid_content_type", allowed: ALLOWED_TYPES }, 400, origin);
  if (!env.R2_ACCOUNT_ID || !env.R2_ACCESS_KEY_ID || !env.R2_SECRET_ACCESS_KEY) return jsonResp({ error: "storage_not_configured" }, 503, origin);
  const randHex = uid(6);
  const ext     = filename.includes(".") ? "" : (contentType === "image/png" ? ".png" : contentType === "image/svg+xml" ? ".svg" : ".jpg");
  const key     = `sites/${id}/${uploadType}/${randHex}_${filename}${ext}`;
  const bucket  = env.R2_BUCKET_NAME || "websites-cozw-assets";
  const host    = `${bucket}.${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`;
  const uploadUrl = await presignR2Put({ host, key, contentType, expires: 300, region: "auto", accessKeyId: env.R2_ACCESS_KEY_ID, secretAccessKey: env.R2_SECRET_ACCESS_KEY });
  const publicBase = (env.ASSETS_PUBLIC_URL || "https://assets.websites.co.zw").replace(/\/+$/, "");
  return jsonResp({ upload_url: uploadUrl, public_url: `${publicBase}/${key}`, key }, 200, origin);
}

async function presignR2Put({ host, key, contentType, expires, region, accessKeyId, secretAccessKey }) {
  const now = new Date();
  const dateStamp = now.toISOString().slice(0, 10).replace(/-/g, "");
  const timeStamp = now.toISOString().replace(/[-:]/g, "").slice(0, 15) + "Z";
  const service = "s3", scope = `${dateStamp}/${region}/${service}/aws4_request`;
  const credential = `${accessKeyId}/${scope}`;
  const encodedKey = key.split("/").map(encodeURIComponent).join("/");
  const queryParams = [["X-Amz-Algorithm","AWS4-HMAC-SHA256"],["X-Amz-Credential",credential],["X-Amz-Date",timeStamp],["X-Amz-Expires",String(expires)],["X-Amz-SignedHeaders","content-type;host"]].map(([k,v])=>`${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join("&");
  const canonicalRequest = ["PUT",`/${encodedKey}`,queryParams,`content-type:${contentType}\nhost:${host}\n`,"content-type;host","UNSIGNED-PAYLOAD"].join("\n");
  const enc = new TextEncoder();
  const hash = async (k, data) => { const key = typeof k==="string"?enc.encode(k):k; const ck=await crypto.subtle.importKey("raw",key,{name:"HMAC",hash:"SHA-256"},false,["sign"]); return new Uint8Array(await crypto.subtle.sign("HMAC",ck,enc.encode(data))); };
  const hexHash = async (data) => { const buf=await crypto.subtle.digest("SHA-256",enc.encode(data)); return [...new Uint8Array(buf)].map(b=>b.toString(16).padStart(2,"0")).join(""); };
  const canonicalHash = await hexHash(canonicalRequest);
  const stringToSign = `AWS4-HMAC-SHA256\n${timeStamp}\n${scope}\n${canonicalHash}`;
  let sigKey = await hash("AWS4"+secretAccessKey,dateStamp);
  sigKey = await hash(sigKey,region); sigKey = await hash(sigKey,service); sigKey = await hash(sigKey,"aws4_request");
  const sigBytes = await hash(sigKey, stringToSign);
  const signature = [...sigBytes].map(b=>b.toString(16).padStart(2,"0")).join("");
  return `https://${host}/${encodedKey}?${queryParams}&X-Amz-Signature=${signature}`;
}

// ═══════════════════════════════════════════════════════════════════════════════
// SHARED HELPERS
// ═══════════════════════════════════════════════════════════════════════════════

async function purgePublicCache(env, siteId) {
  try {
    const site = await env.DB.prepare(
      "SELECT draft_subdomain FROM sites WHERE id=?1"
    ).bind(siteId).first();
    if (!site?.draft_subdomain) return;
    const publicUrl = `https://${site.draft_subdomain}.websites.co.zw/`;
    await caches.default.delete(new Request(publicUrl));
  } catch (e) {
    console.error("Cache purge failed for site", siteId, e?.message);
  }
}

async function purgeCustomDomainCache(env, customDomain) {
  try {
    if (!customDomain) return;
    await caches.default.delete(new Request(`https://${customDomain}/`));
  } catch (e) {
    console.error("Custom domain cache purge failed", customDomain, e?.message);
  }
}

async function loadSite(env, id) {
  return env.DB.prepare(
    "SELECT id,owner_id,site_name,status,plan,draft_subdomain,custom_domain,custom_domain_status," +
    "template_id,content,published_at,expires_at,COALESCE(ai_generations_used,0) AS ai_generations_used " +
    "FROM sites WHERE id=?1"
  ).bind(id).first();
}

function mergeContent(current, incoming) {
  const isWrapped  = !!(incoming.theme && incoming.content);
  const inTheme    = isWrapped ? (incoming.theme   || {}) : {};
  const inContent  = isWrapped ? (incoming.content || {}) : incoming;
  const currentTheme   = current.theme   || {};
  const currentContent = current.content || current;
  const mergedTheme = {
    palette:  inTheme.palette  || currentTheme.palette  || "clean-white",
    font_pair: inTheme.font_pair || currentTheme.font_pair || "grotesk-serif",
    variant:  inTheme.variant  || currentTheme.variant  || "hero-centered",
    sections: (Array.isArray(inTheme.sections) && inTheme.sections.length) ? inTheme.sections
            : (Array.isArray(currentTheme.sections) && currentTheme.sections.length) ? currentTheme.sections
            : ["hero","about","services","contact"],
  };
  const mergedContent = Object.assign({}, inContent);
  for (const field of OWNER_ASSET_FIELDS) {
    const existing = currentContent[field];
    if (existing === undefined || existing === null) continue;
    const aiVal = mergedContent[field];
    if (aiVal === undefined || aiVal === null || (Array.isArray(aiVal) && aiVal.length === 0))
      mergedContent[field] = existing;
  }
  return { theme: mergedTheme, content: mergedContent };
}

async function resolveOwner(request, env) {
  const token = resolveToken(request);
  if (!token) return null;
  const row = await env.DB.prepare("SELECT owner_id FROM sessions WHERE token=?1 AND expires_at > unixepoch()").bind(token).first();
  return row?.owner_id || null;
}

function resolveToken(request) {
  const auth = request.headers.get("Authorization") || "";
  if (auth.startsWith("Bearer ")) return auth.slice(7);
  return parseCookie(request.headers.get("cookie") || "")["wcz_session"] || null;
}

async function readJson(request) { try { return await request.json(); } catch { return {}; } }
function clamp(v, max) { const s = String(v == null ? "" : v).trim(); return s.length > max ? s.slice(0, max) : s || null; }
function slugify(s) { return String(s || "").toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "site"; }
function sanitizeSlug(v) { if (!v) return null; return String(v).toLowerCase().trim().replace(/[^a-z0-9-]/g, "-").replace(/^-+|-+$/g, "").slice(0, 63) || null; }

async function uniqueSlug(env, base, excludeSiteId) {
  base = base || "site";
  let candidate = base;
  for (let attempt = 0; attempt < 5; attempt++) {
    const sql = excludeSiteId
      ? "SELECT id FROM sites WHERE draft_subdomain = ?1 AND id != ?2"
      : "SELECT id FROM sites WHERE draft_subdomain = ?1";
    const stmt = excludeSiteId
      ? env.DB.prepare(sql).bind(candidate, excludeSiteId)
      : env.DB.prepare(sql).bind(candidate);
    const existing = await stmt.first();
    if (!existing) return candidate;
    candidate = base + "-" + uid(2);
  }
  return base + "-" + uid(4);
}

function paletteFor(t) {
  const m = {
    "bold-retail":        "clean-white",
    "grill-house":        "ember-cream",
    "restaurant":         "ember-cream",
    "beauty-salon":       "blush-plum",
    "salon":              "blush-plum",
    "school-institution": "navy-gold",
    "school":             "navy-gold",
    "church":             "navy-gold",
    "advisory-firm":      "slate-gold",
    "consultant":         "slate-gold",
    "property-estate":    "forest-cream",
    "realestate":         "forest-cream",
    "boutique-fashion":   "rose-noir",
    "boutique":           "rose-noir",
    "fashion":            "rose-noir",
    "grocery-fmcg":       "market-fresh",
    "grocery":            "market-fresh",
    "spaza":              "market-fresh",
    "fmcg":               "market-fresh",
    "hardware-store":     "utility-slate",
    "hardware":           "utility-slate",
    "retail":             "utility-slate"
  };
  return m[t] || "clean-white";
}

function fontFor(t) {
  const m = {
    "bold-retail":        "clean-sans",
    "grill-house":        "playfair-jakarta",
    "restaurant":         "playfair-jakarta",
    "beauty-salon":       "garamond-jost",
    "salon":              "garamond-jost",
    "school-institution": "grotesk-serif",
    "school":             "grotesk-serif",
    "church":             "grotesk-serif",
    "advisory-firm":      "grotesk-serif",
    "consultant":         "grotesk-serif",
    "property-estate":    "grotesk-serif",
    "realestate":         "grotesk-serif",
    "boutique-fashion":   "garamond-jost",
    "boutique":           "garamond-jost",
    "fashion":            "garamond-jost",
    "grocery-fmcg":       "clean-sans",
    "grocery":            "clean-sans",
    "spaza":              "clean-sans",
    "fmcg":               "clean-sans",
    "hardware-store":     "display-mono",
    "hardware":           "display-mono",
    "retail":             "display-mono",
    "sports":             "sports-sans"
  };
  return m[t] || "grotesk-serif";
}

function parseQueryString(qs) { const out = {}; String(qs).split("&").forEach(pair => { const i = pair.indexOf("="); if (i > -1) out[decodeURIComponent(pair.slice(0, i))] = decodeURIComponent(pair.slice(i + 1)); }); return out; }

async function sendWhatsApp(env, phone, code) {
  if (!env.MANYCHAT_API_TOKEN) return false;
  try {
    const find = await fetch("https://api.manychat.com/fb/subscriber/findBySystemField?phone=" + encodeURIComponent(phone), { headers: { Authorization: "Bearer " + env.MANYCHAT_API_TOKEN } });
    const found = await find.json().catch(() => ({}));
    const subId = found?.data?.id;
    if (!subId) return false;
    const r = await fetch("https://api.manychat.com/fb/sending/sendContent", {
      method: "POST",
      headers: { Authorization: "Bearer " + env.MANYCHAT_API_TOKEN, "Content-Type": "application/json" },
      body: JSON.stringify({
        subscriber_id: subId,
        data: { version: "v2", content: { messages: [{ type: "text", text: typeof code === "string" && code.length === 6 && /^\d+$/.test(code) ? `Your websites.co.zw code is: *${code}*\n\nExpires in 10 minutes.` : code }] } }
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
        from: env.RESEND_FROM || "noreply@mail.websites.co.zw",
        to: [email],
        subject: `Your websites.co.zw code: ${code}`,
        html: `<div style="font-family:sans-serif;max-width:440px;margin:0 auto;padding:40px 24px"><h2 style="font-size:22px;margin:0 0 8px">Your sign-in code</h2><p style="color:#5a626e;margin:0 0 24px">Use this to sign in to websites.co.zw</p><div style="background:#f6f7f9;border-radius:12px;padding:24px;text-align:center;font-size:32px;font-weight:700;letter-spacing:.3em">${code}</div><p style="color:#9099a4;font-size:13px;margin:20px 0 0">Expires in 10 minutes. If you didn't request this, ignore it.</p></div>`
      })
    });
    return r.ok;
  } catch { return false; }
}

// ── PREVIEW TOKEN MINTING ────────────────────────────────────────────────────
async function mintPreviewToken(env, ownerId, siteId) {
  const token = "pvt_" + uid(24);
  const now   = nowSec();
  await env.DB.prepare(
    "INSERT INTO preview_tokens (token, site_id, owner_id, expires_at, created_at) VALUES (?1,?2,?3,?4,?5)"
  ).bind(token, siteId, ownerId, now + PREVIEW_TTL, now).run();
  return token;
}

// ═══════════════════════════════════════════════════════════════════════════════
// PHASE 4 — CLOUDFLARE FOR SAAS CUSTOM HOSTNAME PROVISIONING
// ═══════════════════════════════════════════════════════════════════════════════

async function cfProvisionHostname(env, hostname) {
  if (!env.CF_API_TOKEN || !env.CF_ZONE_ID) {
    return { ok: false, error: "CF_API_TOKEN or CF_ZONE_ID not configured" };
  }
  try {
    const resp = await fetch(
      `https://api.cloudflare.com/client/v4/zones/${env.CF_ZONE_ID}/custom_hostnames`,
      {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${env.CF_API_TOKEN}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          hostname,
          ssl: {
            method: "txt",
            type:   "dv",
            settings: {
              min_tls_version: "1.0",
              http2: "on",
            },
          },
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
      hostname_id:  data.result?.id,
      ssl_status:   data.result?.ssl?.status,
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
      hostname_id:    result.id,
      ssl_status:     result.ssl?.status,
      hostname_status: result.status,
      ownership_verification: result.ownership_verification || null,
    };
  } catch (e) {
    return { ok: false, error: String(e?.message) };
  }
}

async function cfGetHostnameById(env, hostnameId) {
  try {
    const resp = await fetch(
      `https://api.cloudflare.com/client/v4/zones/${env.CF_ZONE_ID}/custom_hostnames/${hostnameId}`,
      { headers: { "Authorization": `Bearer ${env.CF_API_TOKEN}` } }
    );
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok || !data.result) return { ok: false, error: "not_found" };
    return {
      ok: true,
      hostname_id:     data.result.id,
      hostname:        data.result.hostname,
      ssl_status:      data.result.ssl?.status,
      hostname_status: data.result.status,
      ssl_validation_records: data.result.ssl?.validation_records || [],
      ownership_verification:  data.result.ownership_verification || null,
    };
  } catch (e) {
    return { ok: false, error: String(e?.message) };
  }
}

async function cfDeleteHostname(env, hostnameId) {
  try {
    await fetch(
      `https://api.cloudflare.com/client/v4/zones/${env.CF_ZONE_ID}/custom_hostnames/${hostnameId}`,
      { method: "DELETE", headers: { "Authorization": `Bearer ${env.CF_API_TOKEN}` } }
    );
  } catch {}
}

// ── Customer-facing: POST /api/sites/:id/custom-hostname ─────────────────────
async function provisionCustomHostname(request, env, origin, siteId) {
  const ownerId = await resolveOwner(request, env);
  if (!ownerId) return jsonResp({ error: "unauthorized" }, 401, origin);

  const site = await loadSite(env, siteId);
  if (!site) return jsonResp({ error: "site_not_found" }, 404, origin);
  if (site.owner_id !== ownerId) return jsonResp({ error: "forbidden" }, 403, origin);
  if (site.plan !== "pro")
    return jsonResp({ error: "pro_required", message: "Custom domains require the Pro plan ($60/yr)." }, 403, origin);
  if (!site.custom_domain)
    return jsonResp({ error: "no_domain", message: "No domain assigned to this site yet." }, 400, origin);

  const hostname = site.custom_domain;

  const cf = await cfProvisionHostname(env, hostname);
  if (!cf.ok) {
    return jsonResp({ error: "cf_provision_failed", detail: cf.error }, 502, origin);
  }

  await env.DB.prepare(
    "UPDATE sites SET cf_hostname_id=?2, custom_domain_status='pending', updated_at=unixepoch() WHERE id=?1"
  ).bind(siteId, cf.hostname_id).run();

  return jsonResp({
    ok: true,
    hostname,
    hostname_id:  cf.hostname_id,
    ssl_status:   cf.ssl_status,
    dns_instructions: buildDnsInstructions(hostname, cf),
    message: "Custom hostname provisioned. Follow the DNS instructions to activate your domain.",
  }, 200, origin);
}

// ── Customer-facing: GET /api/sites/:id/custom-hostname ──────────────────────
async function getCustomHostname(request, env, origin, siteId) {
  const ownerId = await resolveOwner(request, env);
  if (!ownerId) return jsonResp({ error: "unauthorized" }, 401, origin);

  const site = await loadSite(env, siteId);
  if (!site) return jsonResp({ error: "site_not_found" }, 404, origin);
  if (site.owner_id !== ownerId) return jsonResp({ error: "forbidden" }, 403, origin);

  if (!site.custom_domain)
    return jsonResp({ hostname: null, status: "none" }, 200, origin);

  if (site.cf_hostname_id) {
    const cf = await cfGetHostnameById(env, site.cf_hostname_id);
    if (cf.ok) {
      return jsonResp({
        hostname:        site.custom_domain,
        hostname_id:     cf.hostname_id,
        ssl_status:      cf.ssl_status,
        hostname_status: cf.hostname_status,
        custom_domain_status: site.custom_domain_status,
        dns_instructions: buildDnsInstructions(site.custom_domain, cf),
        active: cf.ssl_status === "active" && cf.hostname_status === "active",
      }, 200, origin);
    }
  }

  return jsonResp({
    hostname:             site.custom_domain,
    custom_domain_status: site.custom_domain_status,
    dns_instructions:     buildDnsInstructions(site.custom_domain, null),
    active:               site.custom_domain_status === "active",
  }, 200, origin);
}

// ── Customer-facing: POST /api/sites/:id/custom-hostname/check ───────────────
async function checkCustomHostname(request, env, origin, siteId) {
  const ownerId = await resolveOwner(request, env);
  if (!ownerId) return jsonResp({ error: "unauthorized" }, 401, origin);

  const site = await loadSite(env, siteId);
  if (!site) return jsonResp({ error: "site_not_found" }, 404, origin);
  if (site.owner_id !== ownerId) return jsonResp({ error: "forbidden" }, 403, origin);
  if (!site.cf_hostname_id) return jsonResp({ error: "not_provisioned" }, 400, origin);

  const cf = await cfGetHostnameById(env, site.cf_hostname_id);
  if (!cf.ok) return jsonResp({ error: "cf_fetch_failed", detail: cf.error }, 502, origin);

  const isActive = cf.ssl_status === "active" && cf.hostname_status === "active";

  if (isActive && site.custom_domain_status !== "active") {
    await env.DB.prepare(
      "UPDATE sites SET custom_domain_status='active', updated_at=unixepoch() WHERE id=?1"
    ).bind(siteId).run();

    await purgeCustomDomainCache(env, site.custom_domain);

    const owner = await env.DB.prepare("SELECT phone FROM owners WHERE id=?1").bind(site.owner_id).first();
    if (owner?.phone) {
      await sendWhatsApp(env, owner.phone,
        `Great news! Your website is now live at https://${site.custom_domain} — your SSL certificate is active and your site is fully connected.`
      ).catch(() => {});
    }
  }

  return jsonResp({
    ok: true,
    hostname:        cf.hostname,
    ssl_status:      cf.ssl_status,
    hostname_status: cf.hostname_status,
    active:          isActive,
    custom_domain_status: isActive ? "active" : (site.custom_domain_status || "pending"),
    dns_instructions: buildDnsInstructions(site.custom_domain, cf),
  }, 200, origin);
}

// ── Build DNS instructions for the customer ───────────────────────────────────
function buildDnsInstructions(hostname, cf) {
  const instructions = {
    cname: {
      type:   "CNAME",
      name:   hostname,
      value:  "websites.co.zw",
      note:   "Add this to your domain registrar's DNS settings to point your domain at your site.",
    },
  };

  const valRecord = cf?.ssl_validation_records?.[0] || cf?.ownership_verification;
  if (valRecord) {
    instructions.txt_validation = {
      type:  valRecord.type  || "TXT",
      name:  valRecord.name  || `_cf-custom-hostname.${hostname}`,
      value: valRecord.value || valRecord.txt_value || "",
      note:  "Add this TXT record to validate your SSL certificate. Remove it once the certificate is active.",
    };
  }

  return instructions;
}

// ═══════════════════════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════════════════════

async function hmac(secret, data) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data));
  return hex(sig);
}

function timingSafe(a, b) { if (a.length !== b.length) return false; let diff = 0; for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i); return diff === 0; }

function hex(buf) { return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join(""); }

function uid(bytes) { bytes = bytes || 16; const b = new Uint8Array(bytes); crypto.getRandomValues(b); return [...b].map(x => x.toString(16).padStart(2, "0")).join(""); }

function nowSec() { return Math.floor(Date.now() / 1000); }

function normalizePhone(raw) { const p = String(raw || "").replace(/[^\d]/g, ""); if (!p || p.length < 7) return null; if (p.startsWith("263") && p.length >= 12) return p; if (p.startsWith("0") && p.length >= 10) return "263" + p.slice(1); if (p.length === 9 && (p.startsWith("7") || p.startsWith("8"))) return "263" + p; if (p.length >= 10) return p; return null; }

function parseCookie(h) { const out = {}; String(h).split(";").forEach(pair => { const i = pair.indexOf("="); if (i > -1) out[pair.slice(0, i).trim()] = decodeURIComponent(pair.slice(i + 1).trim()); }); return out; }

function respond(obj, defaultStatus, origin) {
  const cookies = obj._cookies || [];
  const status  = obj._status  || defaultStatus || 200;
  const body    = { ...obj }; delete obj._cookies; delete obj._status;
  const h = new Headers({ "Content-Type": "application/json; charset=utf-8" });
  applyCors(h, origin); cookies.forEach(c => h.append("Set-Cookie", c));
  return new Response(JSON.stringify(body), { status, headers: h });
}

function jsonResp(obj, status, origin) {
  const h = new Headers({ "Content-Type": "application/json; charset=utf-8" });
  applyCors(h, origin);
  return new Response(JSON.stringify(obj), { status: status || 200, headers: h });
}

function cors(resp, status, origin) {
  if (!resp) resp = new Response(null, { status: status || 204 });
  const h = new Headers(resp.headers); applyCors(h, origin);
  return new Response(resp.body, { status: resp.status, headers: h });
}

function applyCors(h, origin) {
  const allowed = [
    "https://app.websites.co.zw",
    "https://websites-aon.pages.dev",
    "https://www.websites.co.zw",
    "https://websites.co.zw",
    "https://websites-cozw-auth.yasibomedia.workers.dev",
  ];
  const useOrigin = (origin && allowed.includes(origin)) ? origin : allowed[0];
  h.set("Access-Control-Allow-Origin",      useOrigin);
  h.set("Access-Control-Allow-Methods",     "GET, POST, PUT, DELETE, OPTIONS");
  h.set("Access-Control-Allow-Headers",     "Content-Type, Authorization");
  h.set("Access-Control-Allow-Credentials", "true");
  h.set("Vary",                             "Origin");
}
