/**
 * websites.co.zw — AI Content Generation Worker  v2.1
 * Changes from v2.0: Added person_bio to TUNE_ALLOWED_FIELDS
 * v2.2: Fixed template ID from "retail-hardware" to "hardware-store"
 */

const ANTHROPIC_VERSION   = "2023-06-01";
const DEFAULT_MODEL       = "claude-sonnet-4-6";
const DEFAULT_LIMIT       = 10;
const DEFAULT_TRIAL_LIMIT = 10;
const DEFAULT_TUNE_LIMIT  = 30;
const DEFAULT_VARIANT     = "hero-centered";
const DEFAULT_APP_ORIGIN  = "https://app.websites.co.zw";

const AI_COPY_SECTIONS = ["about", "services"];

const ALLOWED_PALETTES = [
  "black-white-gold", "clean-white", "sky-blue", "elite-sports",
  "ember-cream", "blush-plum", "navy-gold", "slate-gold", "forest-cream",
];
const ALLOWED_FONT_PAIRS = [
  "grotesk-serif", "clean-sans", "sports-sans",
  "playfair-jakarta", "garamond-jost",
];

const TEMPLATE_PALETTE = {
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
  "sports":             "elite-sports",
};
const TEMPLATE_FONT = {
  "grill-house":        "playfair-jakarta",
  "restaurant":         "playfair-jakarta",
  "beauty-salon":       "garamond-jost",
  "salon":              "garamond-jost",
  "school-institution": "grotesk-serif",
  "advisory-firm":      "grotesk-serif",
  "sports":             "sports-sans",
};

const MODEL_PRICES = {
  "claude-sonnet-4-6":         { in: 3.0,  out: 15.0 },
  "claude-haiku-4-5-20251001": { in: 0.25, out: 1.25 },
  "claude-opus-4-8":           { in: 5.0,  out: 25.0 },
};

const TEMPLATE_CATALOGUE = [
  { id: "grill-house",        name: "Grill House",         desc: "Full-bleed hero, menu tabs, live opening hours — for restaurants, cafés, takeaways, grills." },
  { id: "beauty-salon",       name: "Beauty Salon",        desc: "Price list, before/after slider — for salons, spas, barbers, beauty clinics." },
  { id: "school-institution", name: "School & Academy",    desc: "Stats bar, programmes, term dates, leadership team — for schools, churches, NGOs, academies." },
  { id: "advisory-firm",      name: "Advisory Firm",       desc: "Minimal hero, accordion services, credentials — for consultants, lawyers, accountants." },
  { id: "property-estate",    name: "Property Estate",     desc: "Listings-first hero, agent cards — for real estate agencies and property managers." },
  { id: "boutique-fashion",   name: "Boutique Fashion",    desc: "Dark editorial layout, masonry product grid — for fashion, cosmetics, jewellery boutiques." },
  { id: "grocery-fmcg",       name: "Grocery & Spaza",     desc: "Category navigation, stock badges — for grocers, spaza shops, FMCG retailers." },
  { id: "hardware-store",     name: "Hardware & Retail",   desc: "Dense catalogue, quote-builder feel — for hardware stores, electronics, general retail." },
  { id: "bold-retail",        name: "General Business",    desc: "Split hero, service cards, team section — safe general-purpose default for any SME that doesn't fit a narrower template." },
];

// ── v2.1: Added person_bio ────────────────────────────────────────────────────
const TUNE_ALLOWED_FIELDS = {
  product_description:   { label: "product description",        maxLen: 400,  styleHint: "a short, appealing product description for an online catalogue, 1-2 sentences" },
  product_name:          { label: "product name",               maxLen: 80,   styleHint: "a short, punchy product name, no more than a few words" },
  service_body:          { label: "service description",        maxLen: 400,  styleHint: "a brief explanation of a business service, 1-2 sentences" },
  service_title:         { label: "service title",              maxLen: 80,   styleHint: "a short service name, a few words" },
  about:                 { label: "about section",              maxLen: 1200, styleHint: "a warm 2-4 sentence business description for a website's about section" },
  tagline:               { label: "tagline",                    maxLen: 160,  styleHint: "a short tagline or slogan, max 12 words" },
  menu_item_description: { label: "menu item description",      maxLen: 300,  styleHint: "an appetising 1-sentence description of a food/drink menu item" },
  listing_description:   { label: "property listing blurb",     maxLen: 400,  styleHint: "a short, appealing property listing description, 1-2 sentences" },
  event_description:     { label: "event description",          maxLen: 300,  styleHint: "a brief description of a business event or announcement, 1-2 sentences" },
  stat_label:            { label: "stat label",                 maxLen: 60,   styleHint: "a short label for a statistic shown on the site, a few words" },
  // NEW v2.1: bio for team members, agents, staff
  person_bio:            { label: "person bio",                 maxLen: 300,  styleHint: "a warm, professional 2-3 sentence bio for a staff member, agent or team member on a business website. Write in third person." },
};
// EXPLICITLY EXCLUDED: testimonials, addresses, phone, email, contact fields,
// social links — facts the AI must never originate or rephrase.

export default {
  async fetch(request, env) {
    const url    = new URL(request.url);
    const origin = env.APP_ORIGIN || DEFAULT_APP_ORIGIN;

    if (request.method === "OPTIONS")
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    if (url.pathname === "/health")
      return json({ ok: true, service: "websites-cozw-ai", version: "2.2" }, 200, origin);
    if (url.pathname === "/generate" && request.method === "POST")
      return handleGenerate(request, env, origin);
    if (url.pathname === "/recommend-template" && request.method === "POST")
      return handleRecommendTemplate(request, env, origin);
    if (url.pathname === "/tune" && request.method === "POST")
      return handleTune(request, env, origin);

    return json({ error: "not_found" }, 404, origin);
  },
};

async function handleGenerate(request, env, origin) {
  const ownerId = await resolveOwnerId(request, env);
  if (!ownerId) return json({ error: "unauthorized" }, 401, origin);
  let body;
  try { body = await request.json(); } catch { return json({ error: "invalid_json_body" }, 400, origin); }
  const siteId = body && body.site_id;
  const brief  = (body && body.brief) || {};
  if (!siteId) return json({ error: "missing_site_id" }, 400, origin);
  if (!env.ANTHROPIC_API_KEY) return json({ error: "ai_not_configured" }, 503, origin);
  let site;
  try {
    site = await env.DB.prepare("SELECT id, owner_id, plan, published_at, template_id, COALESCE(ai_generations_used,0) AS used FROM sites WHERE id=?").bind(siteId).first();
  } catch (e) { return json({ error: "db_error", detail: String(e?.message) }, 500, origin); }
  if (!site) return json({ error: "site_not_found" }, 404, origin);
  if (site.owner_id !== ownerId) return json({ error: "forbidden" }, 403, origin);
  const hasPaid = site.published_at != null;
  const tier    = hasPaid ? "paid" : "trial";
  const limit   = hasPaid ? clampInt(env.AI_GENERATION_LIMIT, DEFAULT_LIMIT, 1, 10000) : clampInt(env.AI_TRIAL_LIMIT, DEFAULT_TRIAL_LIMIT, 0, 10000);
  const used    = Number(site.used) || 0;
  if (used >= limit) return json({ error: "generation_limit_reached", budget: { used, limit, remaining: 0, tier } }, 429, origin);
  const templateId = body.template_id || site.template_id || "bold-retail";
  let gen;
  try { gen = await generateCopy(env, brief, templateId); } catch (e) { return json({ error: "generation_failed", detail: String(e?.message) }, 502, origin); }
  const { model, usage, theme, content } = gen;
  const inTok  = usage.input_tokens  || 0;
  const outTok = usage.output_tokens || 0;
  const cost   = computeCost(model, inTok, outTok);
  let nowUsed = used + 1;
  try {
    const genId = crypto.randomUUID();
    const now   = Math.floor(Date.now() / 1000);
    const res   = await env.DB.batch([
      env.DB.prepare("UPDATE sites SET ai_generations_used=COALESCE(ai_generations_used,0)+1,ai_input_tokens=COALESCE(ai_input_tokens,0)+?,ai_output_tokens=COALESCE(ai_output_tokens,0)+?,ai_cost_usd=COALESCE(ai_cost_usd,0)+? WHERE id=? AND owner_id=? AND COALESCE(ai_generations_used,0)<?").bind(inTok, outTok, cost, siteId, ownerId, limit),
      env.DB.prepare("INSERT INTO ai_generations (id,site_id,owner_id,created_at,model,prompt_json,output_json,input_tokens,output_tokens,cost_usd) VALUES (?,?,?,?,?,?,?,?,?,?)").bind(genId, siteId, ownerId, now, model, JSON.stringify(brief), JSON.stringify(content), inTok, outTok, cost),
    ]);
    if (res?.[0]?.meta?.changes === 0) nowUsed = limit;
  } catch (e) { console.error("ledger write failed:", e?.message); }
  return json({ theme, content, usage: { input_tokens: inTok, output_tokens: outTok, cost_usd: round6(cost), model }, budget: { used: nowUsed, limit, remaining: Math.max(0, limit - nowUsed), tier } }, 200, origin);
}

async function handleRecommendTemplate(request, env, origin) {
  const ownerId = await resolveOwnerId(request, env);
  if (!ownerId) return json({ error: "unauthorized" }, 401, origin);
  let body;
  try { body = await request.json(); } catch { return json({ error: "invalid_json_body" }, 400, origin); }
  const industry     = clampStr(body.industry, 80);
  const businessName = clampStr(body.business_name, 120);
  const description  = clampStr(body.description, 300);
  if (!industry) return json({ error: "missing_industry" }, 400, origin);
  if (!env.ANTHROPIC_API_KEY) return json({ error: "ai_not_configured" }, 503, origin);
  const catalogueText = TEMPLATE_CATALOGUE.map(t => `- ${t.id}: ${t.desc}`).join("\n");
  const sys = ["You pick the single best website template ID for a Zimbabwean small business.","Output ONLY a JSON object, no markdown, no commentary:",'{ "template_id": string (must be one of the listed IDs), "confidence": number 0-1, "reason": string (max 12 words) }',"","Available templates:",catalogueText].join("\n");
  const userLines = ["Industry: " + industry];
  if (businessName) userLines.push("Business name: " + businessName);
  if (description)  userLines.push("What they do: " + description);
  const model = env.MODEL || DEFAULT_MODEL;
  const base  = (env.GATEWAY_URL || "https://api.anthropic.com").replace(/\/+$/, "");
  let data;
  try {
    const res = await fetch(base+"/v1/messages", { method:"POST", headers:{"x-api-key":env.ANTHROPIC_API_KEY,"anthropic-version":ANTHROPIC_VERSION,"content-type":"application/json"}, body:JSON.stringify({model,max_tokens:200,temperature:0.3,system:sys,messages:[{role:"user",content:userLines.join("\n")}]}) });
    if (!res.ok) { const t=await res.text().catch(()=>""); throw new Error("anthropic_"+res.status+(t?": "+t.slice(0,150):"")); }
    data = await res.json();
  } catch (e) { return json({ error:"recommend_failed", detail:String(e?.message) }, 502, origin); }
  const text = (data.content||[]).filter(b=>b.type==="text").map(b=>b.text).join("");
  let parsed;
  try { parsed = extractJson(text); } catch { return json({ error:"bad_model_output" }, 502, origin); }
  const validIds = new Set(TEMPLATE_CATALOGUE.map(t=>t.id));
  const templateId = validIds.has(parsed.template_id) ? parsed.template_id : "bold-retail";
  const confidence  = (typeof parsed.confidence==="number"&&parsed.confidence>=0&&parsed.confidence<=1) ? parsed.confidence : 0.5;
  return json({ template_id:templateId, confidence, reason:clampStr(parsed.reason,120) }, 200, origin);
}

async function handleTune(request, env, origin) {
  const ownerId = await resolveOwnerId(request, env);
  if (!ownerId) return json({ error: "unauthorized" }, 401, origin);
  let body;
  try { body = await request.json(); } catch { return json({ error: "invalid_json_body" }, 400, origin); }
  const fieldType    = String(body.field_type || "");
  const currentText  = String(body.current_text || "").trim();
  const businessName = clampStr(body.business_name, 120);
  const industry     = clampStr(body.industry, 80);
  const siteId       = body.site_id;
  const fieldCfg = TUNE_ALLOWED_FIELDS[fieldType];
  if (!fieldCfg) return json({ error:"invalid_field_type", message:"This field can't be AI-tuned.", allowed:Object.keys(TUNE_ALLOWED_FIELDS) }, 400, origin);
  if (!currentText) return json({ error:"missing_current_text" }, 400, origin);
  if (currentText.length > 2000) return json({ error:"text_too_long", max:2000 }, 400, origin);
  if (!env.ANTHROPIC_API_KEY) return json({ error:"ai_not_configured" }, 503, origin);
  if (siteId) {
    let site;
    try { site = await env.DB.prepare("SELECT owner_id, COALESCE(ai_tune_used,0) AS used FROM sites WHERE id=?").bind(siteId).first(); } catch { site=null; }
    if (site) {
      if (site.owner_id !== ownerId) return json({ error:"forbidden" }, 403, origin);
      const tuneLimit = clampInt(env.AI_TUNE_LIMIT, DEFAULT_TUNE_LIMIT, 1, 10000);
      if (Number(site.used) >= tuneLimit) return json({ error:"tune_limit_reached", limit:tuneLimit }, 429, origin);
    }
  }
  const sys = ["You rewrite a single short piece of website marketing copy for a Zimbabwean small business.","Improve clarity, warmth and flow. Keep it "+fieldCfg.styleHint+".","Maximum length: "+fieldCfg.maxLen+" characters.","Do not invent new facts, prices, numbers, claims, or details not implied by the original text.","Output ONLY the rewritten text itself — no quotes, no markdown, no commentary, no preamble."].join(" ");
  const userLines = ["Field: "+fieldCfg.label,"Current text: "+currentText];
  if (businessName) userLines.push("Business name (context only): "+businessName);
  if (industry)     userLines.push("Industry (context only): "+industry);
  const model = env.MODEL || DEFAULT_MODEL;
  const base  = (env.GATEWAY_URL || "https://api.anthropic.com").replace(/\/+$/, "");
  let data;
  try {
    const res = await fetch(base+"/v1/messages", { method:"POST", headers:{"x-api-key":env.ANTHROPIC_API_KEY,"anthropic-version":ANTHROPIC_VERSION,"content-type":"application/json"}, body:JSON.stringify({model,max_tokens:400,temperature:0.6,system:sys,messages:[{role:"user",content:userLines.join("\n")}]}) });
    if (!res.ok) { const t=await res.text().catch(()=>""); throw new Error("anthropic_"+res.status+(t?": "+t.slice(0,150):"")); }
    data = await res.json();
  } catch (e) { return json({ error:"tune_failed", detail:String(e?.message) }, 502, origin); }
  let text = (data.content||[]).filter(b=>b.type==="text").map(b=>b.text).join("").trim();
  text = text.replace(/^["']|["']$/g,"").trim();
  if (text.length > fieldCfg.maxLen) text = text.slice(0, fieldCfg.maxLen).trim();
  if (!text) return json({ error:"empty_result" }, 502, origin);
  if (siteId) {
    try { await env.DB.prepare("UPDATE sites SET ai_tune_used=COALESCE(ai_tune_used,0)+1 WHERE id=? AND owner_id=?").bind(siteId, ownerId).run(); }
    catch (e) { console.error("tune ledger write failed:", e?.message); }
  }
  return json({ text }, 200, origin);
}

async function generateCopy(env, brief, templateId) {
  const model    = env.MODEL || DEFAULT_MODEL;
  const sections = sanitiseSections(brief.sections);
  const base     = (env.GATEWAY_URL || "https://api.anthropic.com").replace(/\/+$/, "");
  let lastErr, lastUsage = { input_tokens:0, output_tokens:0 };
  for (let attempt = 0; attempt < 2; attempt++) {
    const messages = attempt === 0 ? [{role:"user",content:buildUserPrompt(brief,sections)}] : [{role:"user",content:buildUserPrompt(brief,sections)},{role:"assistant",content:"{"}];
    const res = await fetch(base+"/v1/messages", { method:"POST", headers:{"x-api-key":env.ANTHROPIC_API_KEY,"anthropic-version":ANTHROPIC_VERSION,"content-type":"application/json"}, body:JSON.stringify({model,max_tokens:2048,temperature:0.7,system:buildSystemPrompt(sections,templateId),messages}) });
    if (!res.ok) { const t=await res.text().catch(()=>""); throw new Error("anthropic_"+res.status+(t?": "+t.slice(0,200):"")); }
    const data = await res.json();
    if (data?.usage) lastUsage = data.usage;
    let text = (data.content||[]).filter(b=>b.type==="text").map(b=>b.text).join("");
    if (attempt===1) text = "{"+text;
    try { const assembled=validateAndAssemble(extractJson(text),sections,brief,templateId); return { theme:assembled.theme, content:assembled.content, usage:lastUsage, model }; }
    catch(e) { lastErr=e; }
  }
  throw lastErr || new Error("could_not_parse_output");
}

function buildSystemPrompt(sections, templateId) {
  const suggestedPalette = TEMPLATE_PALETTE[templateId] || "clean-white";
  const suggestedFont    = TEMPLATE_FONT[templateId]    || "grotesk-serif";
  return ["You are a copywriter for websites.co.zw, a website builder for Zimbabwean small businesses.","Write clear, warm, locally-grounded marketing copy. No clichés, no filler, no emoji.","Output ONLY a single valid JSON object — no markdown, no code fences, no commentary.","","Required shape:","{",`  "theme": {`,`    "palette": one of ${JSON.stringify(ALLOWED_PALETTES)} — suggest "${suggestedPalette}" for this template,`,`    "font_pair": one of ${JSON.stringify(ALLOWED_FONT_PAIRS)} — suggest "${suggestedFont}" for this template`,`  },`,`  "content": {`,`    "business_name": string,`,`    "tagline": string (max 12 words),`,sections.includes("about")?`    "about": string (2-4 sentences of plain marketing copy — NOT an object, just a string),`:"",sections.includes("services")?`    "services": [ { "title": string, "body": string (1-2 sentences) } ]  (3-6 items),`:"",'  }',"}","","CRITICAL RULES:",'— "about" must be a plain string, NOT { heading, body }','— services items must use "body", NOT "description"',"— Do NOT include: contact details, phone numbers, email, social links, team names, testimonials, addresses, or any invented facts. Copy only."].filter(Boolean).join("\n");
}

function buildUserPrompt(brief, sections) {
  const lines = ["Generate website copy for this business:","","Business name: "+str(brief.business_name,"(create a placeholder)"),"Industry: "+str(brief.industry||brief.business_type,"(not given)"),"City/Location: "+str(brief.city||brief.location,"Bulawayo, Zimbabwe"),"What they do: "+str(brief.description,"(not given)"),"Target customers: "+str(brief.target_customers,"(not given)"),"Years operating: "+str(brief.years_operating,"(not given)"),"What makes them different: "+str(brief.unique_selling_point,"(not given)")];
  const svcs = Array.isArray(brief.services) ? brief.services.filter(Boolean) : [];
  if (svcs.length) { const svcList=svcs.map(s=>typeof s==="string"?s:(s.title||"")).filter(Boolean); if(svcList.length) lines.push("Offerings: "+svcList.join(", ")); }
  lines.push("","Sections to write: "+sections.join(", "));
  return lines.join("\n");
}

function validateAndAssemble(obj, sections, brief, templateId) {
  if (!obj||typeof obj!=="object") throw new Error("output_not_object");
  const theme   = typeof obj.theme==="object"?obj.theme:{};
  const content = typeof obj.content==="object"?obj.content:{};
  const palette  = ALLOWED_PALETTES.includes(theme.palette)?theme.palette:(TEMPLATE_PALETTE[templateId]||ALLOWED_PALETTES[0]);
  const fontPair = ALLOWED_FONT_PAIRS.includes(theme.font_pair)?theme.font_pair:(TEMPLATE_FONT[templateId]||ALLOWED_FONT_PAIRS[0]);
  const outTheme   = { palette, font_pair:fontPair, variant:DEFAULT_VARIANT, sections:[] };
  const outContent = { business_name:clampStr(content.business_name||brief.business_name,120), tagline:clampStr(content.tagline,160) };
  const present = ["hero"];
  if (sections.includes("about")) { let a=""; if(typeof content.about==="string")a=content.about; else if(content.about&&typeof content.about==="object")a=clampStr(content.about.body||content.about.heading,1200); if(a){outContent.about=clampStr(a,1200);present.push("about");} }
  if (sections.includes("services")&&Array.isArray(content.services)) { outContent.services=content.services.slice(0,12).map(s=>({title:clampStr(s?.title,120),body:clampStr(s?.body||s?.description,400)})).filter(s=>s.title); if(outContent.services.length)present.push("services"); }
  const contact=assembleContact(brief); if(contact){outContent.contact=contact;present.push("contact");}
  const socials=assembleSocials(brief); if(socials)outContent.socials=socials;
  outTheme.sections=present;
  return { theme:outTheme, content:outContent };
}

function assembleContact(brief) {
  const src=(brief?.contact&&typeof brief.contact==="object")?brief.contact:brief||{};
  const c={phone:clampStr(src.phone,40),email:clampStr(src.email,120),address:clampStr(src.address,240)};
  return (c.phone||c.email||c.address)?c:null;
}

function assembleSocials(brief) {
  const src=(brief?.social&&typeof brief.social==="object")?brief.social:(brief?.socials&&typeof brief.socials==="object")?brief.socials:null;
  if(!src)return null;
  const whatsapp=clampStr(src.whatsapp||brief?.contact?.whatsapp,60);
  const s={whatsapp,facebook:clampStr(src.facebook,200),instagram:clampStr(src.instagram,200),tiktok:clampStr(src.tiktok,200),twitter:clampStr(src.twitter,200),linkedin:clampStr(src.linkedin,200)};
  return (s.whatsapp||s.facebook||s.instagram||s.tiktok||s.twitter||s.linkedin)?s:null;
}

async function resolveOwnerId(request, env) {
  if (env.AI_SERVICE_SECRET) { const token=(request.headers.get("authorization")||"").replace(/^Bearer\s+/i,""); if(token&&token===env.AI_SERVICE_SECRET){const ownerId=request.headers.get("x-owner-id");if(ownerId)return ownerId;} }
  try { const cookie=parseCookie(request.headers.get("cookie")||""); const sessionToken=cookie["wcz_session"]; if(!sessionToken)return null; const row=await env.DB.prepare("SELECT owner_id FROM sessions WHERE token=? AND expires_at > unixepoch('now')").bind(sessionToken).first(); return row?.owner_id||null; } catch { return null; }
}

function sanitiseSections(requested) { let s=Array.isArray(requested)?requested.filter(x=>AI_COPY_SECTIONS.includes(x)):[]; if(!s.length)s=AI_COPY_SECTIONS.slice(); return[...new Set(s)]; }
function computeCost(model,inTok,outTok){const p=MODEL_PRICES[model]||MODEL_PRICES[DEFAULT_MODEL];return(inTok/1e6)*p.in+(outTok/1e6)*p.out;}
function extractJson(text){const t=String(text||"").trim().replace(/^```(?:json)?/i,"").replace(/```$/i,"").trim();const start=t.indexOf("{");const end=t.lastIndexOf("}");if(start===-1||end<=start)throw new Error("no_json_found");return JSON.parse(t.slice(start,end+1));}
function clampStr(v,max){const s=String(v==null?"":v).trim();return s.length>max?s.slice(0,max):s;}
function str(v,fallback){const s=v==null?"":String(v).trim();return s||fallback;}
function clampInt(v,dflt,min,max){const n=parseInt(v,10);return Number.isNaN(n)?dflt:Math.min(max,Math.max(min,n));}
function round6(n){return Math.round(n*1e6)/1e6;}
function parseCookie(h){const out={};String(h).split(";").forEach(pair=>{const i=pair.indexOf("=");if(i>-1)out[pair.slice(0,i).trim()]=decodeURIComponent(pair.slice(i+1).trim());});return out;}
function corsHeaders(origin){return{"Access-Control-Allow-Origin":origin,"Access-Control-Allow-Methods":"POST, GET, OPTIONS","Access-Control-Allow-Headers":"Content-Type, Authorization, X-Owner-Id","Access-Control-Allow-Credentials":"true","Vary":"Origin"};}
function json(obj,status,origin){return new Response(JSON.stringify(obj,null,2),{status:status||200,headers:Object.assign({"Content-Type":"application/json"},origin?corsHeaders(origin):{})});}
