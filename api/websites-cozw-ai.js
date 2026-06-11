/**
 * websites.co.zw — AI Content Generation Worker
 * ----------------------------------------------
 * Single-file Worker (no imports). Generates site COPY from a structured
 * business brief for the Starter/Premium AI-assisted site feature, with
 * bounded regenerations, per-site cost tracking, and a full generation ledger.
 *
 *   POST /generate   { site_id, brief:{...} }  -> { content, usage, budget }
 *   GET  /health
 *
 * CORE PRINCIPLE
 *   The AI writes MARKETING COPY ONLY (hero / about / services + SEO).
 *   It never invents FACTS: contact details, social links, team members,
 *   testimonials, or gallery images are owner-supplied and passed through
 *   verbatim. This prevents fabricated phone numbers, fake endorsements, etc.
 *
 * SAFETY OF TESTING
 *   Returns generated content; does NOT write sites.content. The dashboard
 *   persists the owner's chosen result. Only the cost/usage counters and the
 *   ledger are written. A failed generation never consumes budget.
 *
 * ── ENV / SECRETS ──
 *   ANTHROPIC_API_KEY     required (secret)
 *   MODEL                 optional — default "claude-sonnet-4-6"
 *   AI_GENERATION_LIMIT   optional — default 3 regenerations per PAID site
 *   AI_TRIAL_LIMIT        optional — default 1 generation per UNPAID (trial) site
 *   APP_ORIGIN            optional — default "https://app.websites.co.zw" (CORS)
 *   AI_SERVICE_SECRET     trusted-caller secret. The dashboard API sends this
 *                         (Bearer) plus X-Owner-Id to generate on a user's behalf;
 *                         also usable for manual curl tests. Must match the
 *                         dashboard Worker's AI_SERVICE_SECRET.
 *   GATEWAY_URL           optional — Cloudflare AI Gateway provider base, e.g.
 *                         https://gateway.ai.cloudflare.com/v1/<account>/<gw>/anthropic
 *                         If unset, calls api.anthropic.com directly.
 *
 * ── MIGRATION (see 002_ai_tracking.sql) ──
 *   ai_generations_used (from the earlier migration) + three cost columns on
 *   sites, and the ai_generations ledger table.
 */

const ANTHROPIC_VERSION = "2023-06-01";
const DEFAULT_MODEL = "claude-sonnet-4-6";
const DEFAULT_LIMIT = 3;       // paid sites: full regen allotment
const DEFAULT_TRIAL_LIMIT = 1; // unpaid (trial) sites: a taste before publishing
const DEFAULT_APP_ORIGIN = "https://app.websites.co.zw";

// Sections the AI is allowed to WRITE (copy only). Confirm against render tokens.
const AI_COPY_SECTIONS = ["hero", "about", "services"];
// Theme tokens — must match the render Worker's template vocabulary. CONFIRM.
const ALLOWED_PALETTES = ["black-white-gold", "elite-sports", "ocean-clean", "warm-earth", "mono-slate"];
const ALLOWED_FONT_PAIRS = ["grotesk-serif", "sports-sans", "humanist-mono", "editorial-sans"];

// Per-million-token prices (USD). Source of truth is the stored token counts;
// cost is derived, so update here when prices change.
const MODEL_PRICES = {
  "claude-sonnet-4-6": { in: 3.0, out: 15.0 },
  "claude-haiku-4-5-20251001": { in: 0.25, out: 1.25 },
  "claude-opus-4-8": { in: 5.0, out: 25.0 },
};

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const origin = env.APP_ORIGIN || DEFAULT_APP_ORIGIN;

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }
    if (url.pathname === "/health") {
      return json({ ok: true, service: "websites-cozw-ai" }, 200, origin);
    }
    if (url.pathname === "/generate" && request.method === "POST") {
      return handleGenerate(request, env, origin);
    }
    return json({ error: "not_found" }, 404, origin);
  },
};

async function handleGenerate(request, env, origin) {
  // 1) Authenticate the owner.
  const ownerId = await resolveOwnerId(request, env);
  if (!ownerId) return json({ error: "unauthorized" }, 401, origin);

  // 2) Parse body.
  let body;
  try {
    body = await request.json();
  } catch (_) {
    return json({ error: "invalid_json_body" }, 400, origin);
  }
  const siteId = body && body.site_id;
  const brief = (body && body.brief) || {};
  if (!siteId) return json({ error: "missing_site_id" }, 400, origin);
  if (!env.ANTHROPIC_API_KEY) return json({ error: "ai_not_configured" }, 503, origin);

  // 3) Load site, enforce tenant isolation, read regen budget.
  let site;
  try {
    site = await env.DB
      .prepare("SELECT id, owner_id, plan, published_at, COALESCE(ai_generations_used, 0) AS used FROM sites WHERE id = ?")
      .bind(siteId)
      .first();
  } catch (err) {
    return json({ error: "db_error", detail: String(err && err.message) }, 500, origin);
  }
  if (!site) return json({ error: "site_not_found" }, 404, origin);
  if (site.owner_id !== ownerId) return json({ error: "forbidden" }, 403, origin);

  // Trial vs paid: a site is "trial" until it has been paid for (ever published).
  // Trial sites get a small taste; paid sites get the full plan allotment.
  const hasPaid = site.published_at != null;
  const tier = hasPaid ? "paid" : "trial";
  const paidLimit = clampInt(env.AI_GENERATION_LIMIT, DEFAULT_LIMIT, 1, 1000);
  const trialLimit = clampInt(env.AI_TRIAL_LIMIT, DEFAULT_TRIAL_LIMIT, 0, 1000);
  const limit = hasPaid ? paidLimit : trialLimit;
  const used = Number(site.used) || 0;
  if (used >= limit) {
    return json(
      { error: "generation_limit_reached", budget: { used, limit, remaining: 0, tier } },
      429,
      origin
    );
  }

  // 4) Generate (copy + SEO). Failure here returns an error WITHOUT spending budget.
  let gen;
  try {
    gen = await generateContent(env, brief);
  } catch (err) {
    return json({ error: "generation_failed", detail: String(err && err.message) }, 502, origin);
  }

  const model = gen.model;
  const inTok = gen.usage.input_tokens || 0;
  const outTok = gen.usage.output_tokens || 0;
  const cost = computeCost(model, inTok, outTok);

  // 5) Consume budget + record usage + write the ledger, atomically in one batch.
  let nowUsed = used + 1;
  try {
    const genId = crypto.randomUUID();
    const now = Math.floor(Date.now() / 1000);
    const results = await env.DB.batch([
      env.DB
        .prepare(
          "UPDATE sites SET " +
          "ai_generations_used = COALESCE(ai_generations_used,0) + 1, " +
          "ai_input_tokens = COALESCE(ai_input_tokens,0) + ?, " +
          "ai_output_tokens = COALESCE(ai_output_tokens,0) + ?, " +
          "ai_cost_usd = COALESCE(ai_cost_usd,0) + ? " +
          "WHERE id = ? AND owner_id = ? AND COALESCE(ai_generations_used,0) < ?"
        )
        .bind(inTok, outTok, cost, siteId, ownerId, limit),
      env.DB
        .prepare(
          "INSERT INTO ai_generations " +
          "(id, site_id, owner_id, created_at, model, prompt_json, output_json, input_tokens, output_tokens, cost_usd) " +
          "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
        )
        .bind(genId, siteId, ownerId, now, model, JSON.stringify(brief), JSON.stringify(gen.content), inTok, outTok, cost),
    ]);
    // If the guarded UPDATE matched no row (raced past the cap), the content is
    // still returned to the user — in their favour — but the counter holds at limit.
    const updated = results && results[0] && results[0].meta && results[0].meta.changes;
    if (updated === 0) nowUsed = limit;
  } catch (err) {
    console.error("ledger/counter write failed (content still returned)", err && err.message);
  }

  return json(
    {
      content: gen.content,
      usage: { input_tokens: inTok, output_tokens: outTok, cost_usd: round6(cost), model },
      budget: { used: nowUsed, limit, remaining: Math.max(0, limit - nowUsed), tier },
    },
    200,
    origin
  );
}

/**
 * Calls the Anthropic Messages API and returns { content, usage, model }.
 * Retries once if the model returns unparseable JSON.
 */
async function generateContent(env, brief) {
  const requested = sanitizeCopySections(brief.sections);
  const systemPrompt = buildSystemPrompt(requested);
  const userPrompt = buildUserPrompt(brief, requested);
  const model = env.MODEL || DEFAULT_MODEL;

  const base = (env.GATEWAY_URL || "https://api.anthropic.com").replace(/\/+$/, "");
  const endpoint = base + "/v1/messages";

  let lastErr;
  let lastUsage = { input_tokens: 0, output_tokens: 0 };
  for (let attempt = 0; attempt < 2; attempt++) {
    const messages =
      attempt === 0
        ? [{ role: "user", content: userPrompt }]
        : [
            { role: "user", content: userPrompt },
            { role: "assistant", content: "{" }, // force JSON continuation on retry
          ];

    const res = await fetch(endpoint, {
      method: "POST",
      headers: {
        "x-api-key": env.ANTHROPIC_API_KEY,
        "anthropic-version": ANTHROPIC_VERSION,
        "content-type": "application/json",
      },
      body: JSON.stringify({ model, max_tokens: 2000, temperature: 0.7, system: systemPrompt, messages }),
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      throw new Error("anthropic_api_" + res.status + (errText ? ": " + errText.slice(0, 200) : ""));
    }

    const data = await res.json();
    if (data && data.usage) lastUsage = data.usage;
    let text = (data.content || []).filter((b) => b.type === "text").map((b) => b.text).join("");
    if (attempt === 1) text = "{" + text;

    try {
      const content = validateContent(extractJson(text), requested, brief);
      return { content, usage: lastUsage, model };
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr || new Error("could_not_parse_model_output");
}

function buildSystemPrompt(sections) {
  return [
    "You are a copywriter for websites.co.zw, a website builder for small businesses and organisations in Zimbabwe.",
    "Write clear, warm, locally-grounded marketing copy. No clichés, no filler, no emoji.",
    "Output ONLY a single JSON object — no markdown, no code fences, no commentary.",
    "",
    "Shape:",
    "{",
    '  "theme": { "palette": one of ' + JSON.stringify(ALLOWED_PALETTES) + ', "font_pair": one of ' + JSON.stringify(ALLOWED_FONT_PAIRS) + " },",
    '  "content": {',
    '    "business_name": string,',
    '    "tagline": short string (max ~10 words),',
    sections.includes("hero") ? '    "hero": { "headline": string, "subheadline": string, "cta_label": short string },' : "",
    sections.includes("about") ? '    "about": { "heading": string, "body": 2-4 sentence string },' : "",
    sections.includes("services") ? '    "services": [ { "title": string, "description": 1-2 sentence string } ],' : "",
    '    "seo": { "title": string (<=60 chars), "description": string (<=155 chars) }',
    "  }",
    "}",
    "",
    "IMPORTANT: Do NOT invent or include any of the following — they are supplied separately by the owner:",
    "contact details (phone, email, address), social media links, customer testimonials or quotes, named team members, or image galleries.",
    "Write copy only. Never fabricate facts, names, numbers, or endorsements.",
  ]
    .filter(Boolean)
    .join("\n");
}

function buildUserPrompt(brief, sections) {
  const lines = [
    "Generate website copy for this business/organisation:",
    "",
    "Business name: " + str(brief.business_name, "(invent a sensible placeholder)"),
    "Industry / category: " + str(brief.industry || brief.business_type, "(not given)"),
    "City: " + str(brief.city || brief.location, "Bulawayo, Zimbabwe"),
    "What they do: " + str(brief.description, "(not given)"),
    "Target customers: " + str(brief.target_customers, "(not given)"),
    "Years operating: " + str(brief.years_operating, "(not given)"),
    "Unique selling point: " + str(brief.unique_selling_point, "(not given)"),
    "Tone: " + str(brief.tone, "professional and welcoming"),
  ];
  const services = Array.isArray(brief.services) ? brief.services.filter(Boolean) : [];
  if (services.length) lines.push("Key services/offerings: " + services.map(String).join(", "));
  lines.push("", "Copy sections to produce: " + sections.join(", "));
  return lines.join("\n");
}

/* ── validation + fact pass-through ──────────────────────────────────────── */

function validateContent(obj, requestedSections, brief) {
  if (!obj || typeof obj !== "object") throw new Error("output_not_object");
  const theme = obj.theme && typeof obj.theme === "object" ? obj.theme : {};
  const content = obj.content && typeof obj.content === "object" ? obj.content : {};

  const palette = ALLOWED_PALETTES.includes(theme.palette) ? theme.palette : ALLOWED_PALETTES[0];
  const fontPair = ALLOWED_FONT_PAIRS.includes(theme.font_pair) ? theme.font_pair : ALLOWED_FONT_PAIRS[0];

  const out = {
    theme: { palette, font_pair: fontPair, sections: [] },
    content: {
      business_name: clampStr(content.business_name, 120),
      tagline: clampStr(content.tagline, 140),
      seo: {
        title: clampStr(content.seo && content.seo.title, 60),
        description: clampStr(content.seo && content.seo.description, 155),
      },
    },
  };

  const present = [];
  if (requestedSections.includes("hero") && content.hero) {
    out.content.hero = {
      headline: clampStr(content.hero.headline, 120),
      subheadline: clampStr(content.hero.subheadline, 240),
      cta_label: clampStr(content.hero.cta_label, 40),
    };
    present.push("hero");
  }
  if (requestedSections.includes("about") && content.about) {
    out.content.about = {
      heading: clampStr(content.about.heading, 120),
      body: clampStr(content.about.body, 1200),
    };
    present.push("about");
  }
  if (requestedSections.includes("services") && Array.isArray(content.services)) {
    out.content.services = content.services.slice(0, 12).map((s) => ({
      title: clampStr(s && s.title, 120),
      description: clampStr(s && s.description, 400),
    }));
    present.push("services");
  }

  // Owner-supplied FACTS — injected verbatim, never AI-generated.
  const contact = assembleContact(brief);
  if (contact) {
    out.content.contact = contact;
    present.push("contact");
  }
  const social = assembleSocial(brief);
  if (social) out.content.social = social; // rendered in footer, not a page section

  out.theme.sections = present;
  return out;
}

function assembleContact(brief) {
  const src = (brief && brief.contact && typeof brief.contact === "object" ? brief.contact : brief) || {};
  const contact = {
    phone: clampStr(src.phone, 40),
    email: clampStr(src.email, 120),
    address: clampStr(src.address, 240),
    whatsapp: clampStr(src.whatsapp, 40),
  };
  const any = contact.phone || contact.email || contact.address || contact.whatsapp;
  return any ? contact : null;
}

function assembleSocial(brief) {
  const src = brief && brief.social && typeof brief.social === "object" ? brief.social : null;
  if (!src) return null;
  const social = {
    facebook: clampStr(src.facebook, 200),
    instagram: clampStr(src.instagram, 200),
    linkedin: clampStr(src.linkedin, 200),
    youtube: clampStr(src.youtube, 200),
  };
  const any = social.facebook || social.instagram || social.linkedin || social.youtube;
  return any ? social : null;
}

/* ── auth ─────────────────────────────────────────────────────────────────── */

async function resolveOwnerId(request, env) {
  // Trusted caller: Bearer AI_SERVICE_SECRET + X-Owner-Id header.
  // Used by the dashboard API's server-to-server generate proxy, and for curl tests.
  if (env.AI_SERVICE_SECRET) {
    const token = (request.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
    if (token && token === env.AI_SERVICE_SECRET) {
      const ownerId = request.headers.get("x-owner-id");
      if (ownerId) return ownerId;
    }
  }
  // Production path: session cookie -> sessions table. CONFIRM cookie name + schema.
  try {
    const cookie = parseCookie(request.headers.get("cookie") || "");
    const sessionToken = cookie["wcz_session"];
    if (!sessionToken) return null;
    const row = await env.DB
      .prepare("SELECT owner_id FROM sessions WHERE token = ? AND expires_at > unixepoch('now')")
      .bind(sessionToken)
      .first();
    return row && row.owner_id ? row.owner_id : null;
  } catch (_) {
    return null;
  }
}

/* ── helpers ──────────────────────────────────────────────────────────────── */

function sanitizeCopySections(requested) {
  let secs = Array.isArray(requested) ? requested.filter((s) => AI_COPY_SECTIONS.includes(s)) : [];
  if (!secs.length) secs = AI_COPY_SECTIONS.slice(); // hero + about + services
  return secs.filter((s, i) => secs.indexOf(s) === i);
}

function computeCost(model, inTok, outTok) {
  const p = MODEL_PRICES[model] || MODEL_PRICES[DEFAULT_MODEL];
  return (inTok / 1e6) * p.in + (outTok / 1e6) * p.out;
}

function extractJson(text) {
  let t = String(text || "").trim().replace(/^```(?:json)?/i, "").replace(/```$/i, "").trim();
  const start = t.indexOf("{");
  const end = t.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) throw new Error("no_json_found");
  return JSON.parse(t.slice(start, end + 1));
}

function clampStr(v, max) {
  const s = String(v == null ? "" : v).trim();
  return s.length > max ? s.slice(0, max) : s;
}
function str(v, fallback) {
  const s = v == null ? "" : String(v).trim();
  return s || fallback;
}
function clampInt(v, dflt, min, max) {
  const n = parseInt(v, 10);
  if (Number.isNaN(n)) return dflt;
  return Math.min(max, Math.max(min, n));
}
function round6(n) {
  return Math.round(n * 1e6) / 1e6;
}
function parseCookie(header) {
  const out = {};
  String(header).split(";").forEach((pair) => {
    const i = pair.indexOf("=");
    if (i > -1) out[pair.slice(0, i).trim()] = decodeURIComponent(pair.slice(i + 1).trim());
  });
  return out;
}
function corsHeaders(origin) {
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Owner-Id",
    "Access-Control-Allow-Credentials": "true",
    "Vary": "Origin",
  };
}
function json(obj, status, origin) {
  return new Response(JSON.stringify(obj, null, 2), {
    status: status || 200,
    headers: Object.assign({ "Content-Type": "application/json" }, origin ? corsHeaders(origin) : {}),
  });
}