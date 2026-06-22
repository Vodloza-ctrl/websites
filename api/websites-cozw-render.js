/**
 * websites.co.zw — Render Worker v9.0
 * Cloudflare Worker · Config-driven template engine
 *
 * What changed from v8.x:
 *   - Per-template render functions (renderGrillHouse, renderAdvisory, etc.)
 *     are REMOVED from this file. Each template is now two files on Pages:
 *       /templates/{id}/index.html   — slot-based HTML
 *       /templates/{id}/config.json  — slot mapping rules
 *   - renderEngine() is the universal resolver (~200 lines, never changes)
 *   - All shared infrastructure unchanged: htmlShell, buildNav, buildFooter,
 *     buildContactSection, buildHoursSection, normalizeContent, icon system,
 *     ICONS, esc(), wa(), getImage() etc.
 *   - ASSETS binding still points to R2 (images). No binding changes needed.
 *   - Templates fetched from Pages via URL (PAGES_ORIGIN env var or constant).
 *
 * To add a new template: drop index.html + config.json in /templates/{id}/
 * on Pages. Zero Worker changes. Zero Worker redeploys.
 *
 * Bindings (unchanged from v8):
 *   DB      — D1 database
 *   ASSETS  — R2 bucket (images)
 *
 * New env var (set in wrangler.toml [vars]):
 *   PAGES_ORIGIN — your Pages domain e.g. "https://www.websites.co.zw"
 */

export default {
  async fetch(request, env) {
    try {
      return await handleRequest(request, env);
    } catch (err) {
      console.error('Render error:', err);
      return new Response('Internal error', { status: 500 });
    }
  }
};

// ─── ROUTING ──────────────────────────────────────────────────────────────────

async function handleRequest(request, env) {
  const url  = new URL(request.url);
  const host = url.hostname;

  // R2 asset serving (unchanged)
  if (host === 'assets.websites.co.zw') {
    const key = url.pathname.replace(/^\/+/, '');
    if (!key) return new Response('Not found', { status: 404 });
    return serveAsset(request, env, key);
  }
  if (url.pathname.startsWith('/assets/')) {
    return serveAsset(request, env, url.pathname.replace('/assets/', ''));
  }

  // Subdomain routing
  const parts = host.split('.');
  if (parts.length >= 3 && parts[1] === 'websites' && parts[2] === 'co') {
    return handlePublic(request, env, parts[0]);
  }

  return handlePublic(request, env, null, host);
}

// ─── ASSET PROXY (R2 — unchanged) ─────────────────────────────────────────────

async function serveAsset(request, env, key) {
  const cached   = caches.default;
  const cacheKey = new Request(request.url, request);
  const hit      = await cached.match(cacheKey);
  if (hit) return hit;

  const obj = await env.ASSETS.get(key);
  if (!obj) return new Response('Not found', { status: 404 });

  const ext     = key.split('.').pop().toLowerCase();
  const mimeMap = {
    jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png',
    gif: 'image/gif',  webp: 'image/webp', svg: 'image/svg+xml',
    pdf: 'application/pdf', woff2: 'font/woff2', woff: 'font/woff'
  };
  const ct = mimeMap[ext] || 'application/octet-stream';

  const response = new Response(obj.body, {
    headers: { 'Content-Type': ct, 'Cache-Control': 'public, max-age=31536000, immutable' }
  });
  await cached.put(cacheKey, response.clone());
  return response;
}

// ─── TEMPLATE FETCHER ─────────────────────────────────────────────────────────

const TEMPLATE_CACHE = new Map(); // in-memory cache per Worker instance

async function getTemplate(templateId, env) {
  if (TEMPLATE_CACHE.has(templateId)) return TEMPLATE_CACHE.get(templateId);

  const origin = (env.PAGES_ORIGIN || 'https://www.websites.co.zw').replace(/\/$/, '');
  const base   = `${origin}/templates/${templateId}`;

  const [htmlRes, configRes] = await Promise.all([
    fetch(`${base}/index.html`),
    fetch(`${base}/config.json`),
  ]);

  if (!htmlRes.ok)   throw new Error(`Template HTML not found: ${templateId}`);
  if (!configRes.ok) throw new Error(`Template config not found: ${templateId}`);

  const [html, config] = await Promise.all([
    htmlRes.text(),
    configRes.json(),
  ]);

  const result = { html, config };
  TEMPLATE_CACHE.set(templateId, result); // cache for Worker lifetime (~few minutes)
  return result;
}

// ─── RENDER ENGINE ────────────────────────────────────────────────────────────
// Resolves {{tokens}}, {{#if}}/{{#each}} blocks using config rules.
// The config declares what to do; the engine does the mechanical work.

function renderEngine(templateHtml, site, config, extraTokens) {
  const c = site.content || {};

  // 1. Build computed tokens (platform-level, same for every template)
  const computed = buildComputedTokens(site, c, config);
  const tokens   = { ...computed, ...(extraTokens || {}) };

  let html = templateHtml;

  // 2. Process {{#each}} blocks
  for (const def of (config.lists || [])) {
    html = processEach(html, def, c, tokens);
  }

  // 3. Process {{#if}} / {{#if}}...{{else}} blocks
  for (const def of (config.conditionals || [])) {
    html = processConditional(html, def, c, tokens, computed);
  }

  // 4. Replace scalar {{token}} placeholders
  for (const [key, val] of Object.entries(tokens)) {
    html = html.split(`{{${key}}}`).join(esc(String(val ?? '')));
  }

  // 5. Strip any unreplaced placeholders (missing optional fields)
  html = html.replace(/\{\{[^}]+\}\}/g, '');

  return html;
}

function buildComputedTokens(site, c, config) {
  const businessName  = c.business_name || c.name || '';
  const primaryColor  = c.primary_color || site.primary_color || config.defaultPrimaryColor || '#1a3a5c';
  const phone         = c.phone || c.contact?.phone || '';
  const whatsapp      = c.whatsapp || c.contact?.whatsapp || phone;
  const location      = c.location || c.address || c.contact?.address || '';
  const about         = c.about || '';

  const nameParts         = businessName.trim().split(/\s+/);
  const businessNameFirst = nameParts[0] || businessName;
  const businessNameRest  = nameParts.slice(1).join(' ') || '';

  // Zimbabwe number normalisation
  const whatsappDigits = whatsapp.replace(/\D/g, '');
  const whatsappClean  = whatsappDigits.startsWith('263')
    ? whatsappDigits
    : '263' + whatsappDigits.replace(/^0/, '');

  const seoTitle = c.seo?.meta_title       || `${businessName}${location ? ' — ' + location : ''}`;
  const seoDesc  = c.seo?.meta_description || about.slice(0, 155);

  const typeLabel = (config.typeLabels || {})[site.template_id]
    || c.business_type_label
    || config.defaultTypeLabel
    || '';

  return {
    site_id:             site.id            || '',
    business_name:       businessName,
    business_name_first: businessNameFirst,
    business_name_rest:  businessNameRest,
    primary_color:       primaryColor,
    accent_color:        primaryColor,
    tagline:             c.tagline          || '',
    about:               about,
    phone:               phone,
    email:               c.email || c.contact?.email || '',
    whatsapp:            whatsapp,
    whatsapp_clean:      whatsappClean,
    whatsapp_wa_link:    `https://wa.me/${whatsappClean}`,
    location:            location,
    logo_url:            c.logo_url         || site.logo_url         || '',
    hero_image_url:      c.hero_image_url   || c.hero_image          || site.hero_image_url || '',
    seo_title:           seoTitle,
    seo_description:     seoDesc,
    business_type_label: typeLabel,
    current_year:        String(new Date().getFullYear()),
  };
}

function processEach(html, def, c, tokens) {
  const re = new RegExp(
    `\\{\\{#each ${def.key}\\}\\}([\\s\\S]*?)\\{\\{/each\\}\\}`, 'g'
  );
  return html.replace(re, () => {
    const items = Array.isArray(c[def.key]) ? c[def.key] : [];
    if (!items.length) return def.emptyHtml || '';
    return items.map((item, i) => {
      let block = def.itemTemplate;
      // Inner {{#if item.field}}...{{else}}...{{/if}}
      block = block.replace(
        /\{\{#if item\.(\w+)\}\}([\s\S]*?)\{\{else\}\}([\s\S]*?)\{\{\/if\}\}/g,
        (_, field, t, f) => item[field] ? t : f
      );
      // Inner {{#if item.field}}...{{/if}}
      block = block.replace(
        /\{\{#if item\.(\w+)\}\}([\s\S]*?)\{\{\/if\}\}/g,
        (_, field, content) => item[field] ? content : ''
      );
      // {{item.field}} with fallback icon support
      block = block.replace(/\{\{item\.(\w+)\}\}/g, (_, field) => {
        if (field === 'icon' && !item[field] && def.fallbackIcons) {
          return esc(def.fallbackIcons[i % def.fallbackIcons.length]);
        }
        return esc(String(item[field] ?? ''));
      });
      block = block.replace(/\{\{item_index\}\}/g, String(i + 1));
      return block;
    }).join('\n');
  });
}

function processConditional(html, def, c, tokens, computed) {
  const condition = evaluateCondition(def, c, tokens, computed);

  // {{#if flag}}...{{else}}...{{/if}}
  const reElse = new RegExp(
    `\\{\\{#if ${def.flag}\\}\\}([\\s\\S]*?)\\{\\{else\\}\\}([\\s\\S]*?)\\{\\{/if\\}\\}`, 'g'
  );
  html = html.replace(reElse, (_, t, f) =>
    def.ifTrue !== undefined || def.ifFalse !== undefined
      ? (condition ? (def.ifTrue ?? t) : (def.ifFalse ?? ''))
      : (condition ? t : f)
  );

  // {{#if flag}}...{{/if}}
  const reIf = new RegExp(
    `\\{\\{#if ${def.flag}\\}\\}([\\s\\S]*?)\\{\\{/if\\}\\}`, 'g'
  );
  html = html.replace(reIf, (_, content) =>
    condition ? (def.ifTrue ?? content) : ''
  );

  return html;
}

function evaluateCondition(def, c, tokens, computed) {
  switch (def.type) {
    case 'field_present':   return !!(deepGet(c, def.field));
    case 'list_present':    return Array.isArray(c[def.field]) && c[def.field].length > 0;
    case 'nested_field':    return !!(c[def.field]?.[def.subfield]);
    case 'computed':        return !!(computed[def.token] || tokens[def.token]);
    case 'config_value':    return !!def.value;
    case 'content_flag':    return deepGet(c, def.field) !== false && (deepGet(c, def.field) ?? def.default ?? true);
    default:                return false;
  }
}

function deepGet(obj, path) {
  if (!path) return undefined;
  return path.split('.').reduce((o, k) => o?.[k], obj);
}

// ─── PUBLIC RENDER ────────────────────────────────────────────────────────────

async function handlePublic(request, env, slug, customDomain) {
  let site;
  if (slug)          site = await getSiteBySlug(env.DB, slug);
  else if (customDomain) site = await getSiteByDomain(env.DB, customDomain);
  if (!site) return render404();

  const isLive = ['published', 'grace'].includes(site.status);
  let isPreview = false;
  if (!isLive) {
    const previewToken = new URL(request.url).searchParams.get('preview_token');
    if (previewToken) {
      const valid = await checkPreviewToken(env.DB, previewToken, site.id);
      if (!valid) return render404();
      isPreview = true;
    } else {
      return render404();
    }
  }

  const raw     = typeof site.content === 'string' ? JSON.parse(site.content) : site.content;
  const content = normalizeContent(raw);

  const templateId = site.template_id || content.template || 'bold-retail';

  let html;
  try {
    const { html: templateHtml, config } = await getTemplate(templateId, env);
    // Build extra tokens the template needs that aren't in computedTokens
    const extraTokens = buildTemplateExtras(content, site, config);
    const resolved    = renderEngine(templateHtml, { ...site, content }, config, extraTokens);
    html = wrapWithShell(resolved, content, site, config, isPreview);
  } catch (err) {
    console.error('Template error:', err);
    return new Response(`Template error: ${err.message}`, { status: 500 });
  }

  return new Response(html, {
    headers: {
      'Content-Type': 'text/html;charset=UTF-8',
      'Cache-Control': isPreview ? 'no-store'
        : site.status === 'grace' ? 'no-store'
        : 'public, max-age=300, stale-while-revalidate=3600',
    }
  });
}

// ─── TEMPLATE EXTRAS ─────────────────────────────────────────────────────────
// Tokens that require logic beyond simple field lookup.
// Config declares which extras to enable; engine calls this once.

function buildTemplateExtras(c, site, config) {
  const extras = {};

  // WhatsApp link (pre-built href)
  const phone = c.phone || c.contact?.phone || '';
  if (phone) {
    const digits = phone.replace(/\D/g, '');
    const num    = digits.startsWith('263') ? digits : '263' + digits.replace(/^0/, '');
    extras.wa_href_general  = `https://wa.me/${num}?text=${encodeURIComponent('Hello, I found you on websites.co.zw!')}`;
    extras.wa_href_consult  = `https://wa.me/${num}?text=${encodeURIComponent('Hello, I would like to book a consultation.')}`;
    extras.wa_href_order    = `https://wa.me/${num}?text=${encodeURIComponent('Hello, I would like to place an order.')}`;
    extras.wa_href_enquiry  = `https://wa.me/${num}?text=${encodeURIComponent('Hello, I would like to make an enquiry.')}`;
    extras.wa_href_booking  = `https://wa.me/${num}?text=${encodeURIComponent('Hello, I would like to book an appointment.')}`;
  }

  // Google Maps link
  const address = c.address || c.location || c.contact?.address || '';
  if (address) {
    extras.maps_href = `https://maps.google.com/?q=${encodeURIComponent(address)}`;
  }

  // Open/closed badge HTML
  if (config.showOpenBadge && c.hours) {
    extras.open_badge_html = openClosedBadge(c.hours);
  }

  // Hours grid HTML
  if (config.showHoursGrid && c.hours) {
    extras.hours_grid_html = buildHoursGridHtml(c.hours);
  }

  // Services as select options (for quote forms)
  const services = Array.isArray(c.services) ? c.services : [];
  if (services.length) {
    extras.service_options_html = services
      .map(s => `<option value="${esc(s.name || '')}">${esc(s.name || '')}</option>`)
      .join('\n');
  }

  // First team member photo (for band image)
  const team = Array.isArray(c.team) ? c.team : [];
  if (team[0]?.photo_url || team[0]?.photo) {
    extras.band_image_url = team[0].photo_url || team[0].photo || '';
  }

  // Stats HTML (pre-rendered for simpler templates)
  const stats = Array.isArray(c.stats) ? c.stats : [];
  if (stats.length) {
    extras.stats_html = stats.map(s =>
      `<div><b>${esc(String(s.value || s.number || ''))}</b><span>${esc(s.label || '')}</span></div>`
    ).join('\n');
  }

  return extras;
}

// ─── SHELL WRAPPER ────────────────────────────────────────────────────────────
// Injects the rendered template body into the full HTML shell.
// The shell provides: nav, FAB, lightbox, shared JS, preview banner.
// Templates declare what nav links they need via config.navLinks.

function wrapWithShell(body, c, site, config, isPreview) {
  const phone      = c.phone || c.contact?.phone || '';
  const digits     = phone.replace(/\D/g, '');
  const waNum      = digits.startsWith('263') ? digits : '263' + digits.replace(/^0/, '');
  const waHref     = phone ? `https://wa.me/${waNum}?text=${encodeURIComponent('Hello!')}` : '#';

  const navLinks   = (config.navLinks || ['#services:Services', '#contact:Contact'])
    .map(l => { const [href, label] = l.split(':'); return `<a href="${esc(href)}">${esc(label)}</a>`; })
    .join('');

  const ctaLabel   = config.navCtaLabel || 'WhatsApp Us';
  const ctaHref    = phone ? waHref : '#contact';

  const nav = `
<nav class="wcz-nav" id="wcz-nav" style="--nav-text:${esc(config.navTextColor || '#fff')}">
  <div class="wcz-nav-inner">
    <div class="wcz-nav-logo">${esc(c.business_name || c.name || '')}</div>
    <div class="wcz-nav-links">${navLinks}
      ${phone ? `<a href="${esc(ctaHref)}" class="wcz-nav-cta" ${phone ? `target="_blank" rel="noopener"` : ''}>${ctaLabel}</a>` : ''}
    </div>
    <div class="wcz-hamburger" id="wcz-hamburger"><span></span><span></span><span></span></div>
  </div>
</nav>
<div class="wcz-mobile-menu" id="wcz-mobile-menu">
  <span class="wcz-mobile-close" id="wcz-mobile-close">✕</span>
  ${navLinks}
  ${phone ? `<a href="${esc(waHref)}" target="_blank" rel="noopener" style="background:#25d366;color:#fff;padding:.75rem 2rem;border-radius:999px;font-weight:700">WhatsApp</a>` : ''}
</div>`;

  const previewBanner = isPreview
    ? `<div class="wcz-preview-banner">Preview mode — <a href="https://app.websites.co.zw">Go to dashboard</a> to publish</div>`
    : '';

  const fab = phone
    ? `<a class="wcz-fab" id="wcz-fab" href="${esc(waHref)}" aria-label="Chat on WhatsApp" target="_blank" rel="noopener">
        <div class="wcz-fab-pulse"></div>
        ${icon('whatsapp', 30, '#fff')}
      </a>`
    : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(c.seo?.meta_title || c.business_name || c.name || '')}</title>
<meta name="description" content="${esc(c.seo?.meta_description || c.about || '')}">
<meta property="og:title" content="${esc(c.business_name || c.name || '')}">
<meta property="og:description" content="${esc(c.about || '')}">
${c.hero_image_url || c.hero_image ? `<meta property="og:image" content="${esc(c.hero_image_url || c.hero_image)}">` : ''}
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
${config.googleFonts ? `<link href="${esc(config.googleFonts)}" rel="stylesheet">` : ''}
<style>${SHARED_CSS}${config.templateCSS || ''}</style>
</head>
<body class="${esc(config.bodyClass || '')}">
${previewBanner}
${nav}
<main>
${body}
</main>
${fab}
${SHARED_JS}
</body>
</html>`;
}

// ─── SHARED CSS (injected into every template) ────────────────────────────────

const SHARED_CSS = `
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
html{scroll-behavior:smooth;-webkit-font-smoothing:antialiased}
img{max-width:100%;height:auto;display:block}
a{color:inherit;text-decoration:none}
button{cursor:pointer;border:none;background:none;font:inherit}
ul{list-style:none}
:root{--shadow-sm:0 2px 12px rgba(0,0,0,.06);--shadow-md:0 8px 32px rgba(0,0,0,.12);--radius-card:12px;--radius-pill:999px}
.wcz-nav{position:fixed;top:0;left:0;right:0;z-index:1000;transition:background .3s,box-shadow .3s;padding:0 1.5rem}
.wcz-nav.scrolled{background:rgba(var(--nav-bg-rgb,255,255,255),.92);backdrop-filter:blur(12px);box-shadow:0 1px 16px rgba(0,0,0,.12)}
.wcz-nav-inner{display:flex;align-items:center;justify-content:space-between;max-width:1200px;margin:0 auto;height:64px}
.wcz-nav-logo{font-size:1.25rem;font-weight:800;color:var(--accent,#000)}
.wcz-nav-links{display:flex;gap:1.5rem;align-items:center}
.wcz-nav-links a{font-size:.9rem;font-weight:500;color:var(--nav-text,#fff);opacity:.85;transition:opacity .2s}
.wcz-nav-links a:hover{opacity:1}
.wcz-nav-cta{background:var(--accent);color:#fff!important;padding:.45rem 1.1rem;border-radius:var(--radius-pill);font-weight:700;opacity:1!important}
.wcz-hamburger{display:none;flex-direction:column;gap:5px;padding:8px;cursor:pointer}
.wcz-hamburger span{width:24px;height:2px;background:var(--nav-text,#fff);display:block;transition:.3s}
.wcz-mobile-menu{display:none;position:fixed;inset:0;z-index:999;background:#fff;flex-direction:column;align-items:center;justify-content:center;gap:2rem}
.wcz-mobile-menu.open{display:flex}
.wcz-mobile-menu a{font-size:1.3rem;font-weight:700;color:#1a1a2e}
.wcz-mobile-close{position:absolute;top:1.5rem;right:1.5rem;cursor:pointer;font-size:1.5rem}
@media(max-width:768px){.wcz-nav-links{display:none}.wcz-hamburger{display:flex}}
.wcz-fab{position:fixed;bottom:1.5rem;right:1.5rem;z-index:900;width:56px;height:56px;border-radius:50%;background:#25d366;display:flex;align-items:center;justify-content:center;box-shadow:0 4px 20px rgba(37,211,102,.45);opacity:0;transform:scale(.8);transition:opacity .3s,transform .3s;pointer-events:none}
.wcz-fab.visible{opacity:1;transform:scale(1);pointer-events:auto}
.wcz-fab-pulse{position:absolute;inset:0;border-radius:50%;border:2px solid #25d366;animation:fabpulse 2s infinite}
@keyframes fabpulse{0%{transform:scale(1);opacity:.8}100%{transform:scale(1.8);opacity:0}}
.wcz-reveal{opacity:0;transform:translateY(24px);transition:opacity .55s ease,transform .55s ease}
.wcz-reveal.revealed{opacity:1;transform:none}
.wcz-preview-banner{position:fixed;bottom:0;left:0;right:0;z-index:9999;background:linear-gradient(135deg,#1a1a2e,#e94560);color:#fff;text-align:center;padding:.75rem;font-size:.85rem;font-weight:600}
.wcz-preview-banner a{color:#fff;text-decoration:underline}
.badge-open,.badge-closed{display:inline-flex;align-items:center;gap:6px;font-size:.8rem;font-weight:600;padding:.25rem .8rem;border-radius:var(--radius-pill)}
.badge-open{background:#d1fae5;color:#065f46}
.badge-closed{background:#fee2e2;color:#991b1b}
.badge-dot{width:7px;height:7px;border-radius:50%;background:currentColor;flex-shrink:0}
.badge-open .badge-dot{animation:pulse-dot 2s infinite}
@keyframes pulse-dot{0%,100%{opacity:1}50%{opacity:.4}}
.form-msg{display:none;padding:12px 16px;border-radius:8px;font-size:.92rem;margin-bottom:12px}
.form-msg.success{background:#d4edda;color:#155724;display:block}
.form-msg.error{background:#f8d7da;color:#721c24;display:block}
`;

// ─── SHARED JS (injected into every template) ─────────────────────────────────

const SHARED_JS = `<script>
(function(){
  var nav=document.getElementById('wcz-nav');
  var fab=document.getElementById('wcz-fab');
  function s(){ var y=window.scrollY; if(nav) nav.classList.toggle('scrolled',y>60); if(fab) fab.classList.toggle('visible',y>300); }
  window.addEventListener('scroll',s,{passive:true}); s();
})();
(function(){
  var btn=document.getElementById('wcz-hamburger');
  var menu=document.getElementById('wcz-mobile-menu');
  var close=document.getElementById('wcz-mobile-close');
  if(!btn||!menu) return;
  btn.addEventListener('click',function(){menu.classList.add('open');});
  if(close) close.addEventListener('click',function(){menu.classList.remove('open');});
  menu.querySelectorAll('a').forEach(function(a){a.addEventListener('click',function(){menu.classList.remove('open');});});
})();
(function(){
  var items=document.querySelectorAll('.wcz-reveal');
  if(!items.length) return;
  var obs=new IntersectionObserver(function(entries){entries.forEach(function(e){if(e.isIntersecting){e.target.classList.add('revealed');obs.unobserve(e.target);}});},{threshold:.1});
  items.forEach(function(el){obs.observe(el);});
})();
(function(){
  var counters=document.querySelectorAll('.wcz-stat-num[data-target]');
  if(!counters.length) return;
  var obs=new IntersectionObserver(function(entries){entries.forEach(function(e){
    if(!e.isIntersecting) return;
    var el=e.target; var target=parseInt(el.dataset.target,10); var suffix=el.dataset.suffix||'';
    var start=0; var dur=1800; var step=16; var inc=target/(dur/step);
    var timer=setInterval(function(){start=Math.min(start+inc,target);el.textContent=Math.floor(start).toLocaleString()+suffix;if(start>=target)clearInterval(timer);},step);
    obs.unobserve(el);
  });},{threshold:.5});
  counters.forEach(function(el){obs.observe(el);});
})();
(function(){
  document.querySelectorAll('.wcz-accordion-trigger').forEach(function(t){
    t.addEventListener('click',function(){t.closest('.wcz-accordion-item').classList.toggle('open');});
  });
})();
// Quote form submit (used by advisory, etc.)
window.wczSubmitQuote = async function(siteId) {
  var msg=document.getElementById('wcz-form-msg');
  if(msg){msg.className='form-msg';}
  var name=(document.getElementById('wcz-f-name')||{}).value||'';
  var phone=(document.getElementById('wcz-f-phone')||{}).value||'';
  var service=(document.getElementById('wcz-f-service')||{}).value||'';
  var message=(document.getElementById('wcz-f-message')||{}).value||'';
  if(!name||!phone){if(msg){msg.className='form-msg error';msg.textContent='Please enter your name and contact details.';}return;}
  try{
    var res=await fetch('/forms/quote',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({site_id:siteId,name,phone,service,message})});
    if(res.ok){if(msg){msg.className='form-msg success';msg.textContent='Thanks — we\u2019ll be in touch within one business day.';}['wcz-f-name','wcz-f-phone','wcz-f-message'].forEach(function(id){var el=document.getElementById(id);if(el)el.value='';});var sel=document.getElementById('wcz-f-service');if(sel)sel.value='';}
    else throw new Error();
  }catch(e){if(msg){msg.className='form-msg error';msg.textContent='Something went wrong. Please WhatsApp or call us directly.';}}
};
</script>`;

// ─── ICON SYSTEM (unchanged from v8) ─────────────────────────────────────────

const ICONS = {
  menu:        `<line x1="4" y1="6" x2="20" y2="6"/><line x1="4" y1="12" x2="20" y2="12"/><line x1="4" y1="18" x2="20" y2="18"/>`,
  x:           `<path d="M18 6 6 18"/><path d="m6 6 12 12"/>`,
  chevronLeft: `<path d="m15 18-6-6 6-6"/>`,
  chevronRight:`<path d="m9 18 6-6-6-6"/>`,
  chevronDown: `<path d="m6 9 6 6 6-6"/>`,
  phone:       `<path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07A19.5 19.5 0 0 1 4.69 12a19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 3.6 1.27h3a2 2 0 0 1 2 1.72c.127.96.361 1.903.7 2.81a2 2 0 0 1-.45 2.11L7.91 8.91a16 16 0 0 0 6.18 6.18l.91-.91a2 2 0 0 1 2.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0 1 22 16.92z"/>`,
  mail:        `<rect width="20" height="16" x="2" y="4" rx="2"/><path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7"/>`,
  mapPin:      `<path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0z"/><circle cx="12" cy="10" r="3"/>`,
  clock:       `<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>`,
  bed:         `<path d="M2 4v16"/><path d="M2 8h18a2 2 0 0 1 2 2v10"/><path d="M2 17h20"/><path d="M6 8v9"/>`,
  bath:        `<path d="M9 6 6.5 3.5a1.5 1.5 0 0 0-1-.5C4.683 3 4 3.683 4 4.5V17a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-5"/><line x1="10" y1="5" x2="8" y2="7"/><line x1="2" y1="12" x2="22" y2="12"/>`,
  ruler:       `<path d="M21.3 8.7 8.7 21.3c-1 1-2.5 1-3.4 0l-2.6-2.6c-1-1-1-2.5 0-3.4L15.3 2.7c1-1 2.5-1 3.4 0l2.6 2.6c1 1 1 2.5 0 3.4z"/><path d="m7.5 10.5 2 2"/><path d="m10.5 7.5 2 2"/><path d="m13.5 4.5 2 2"/><path d="m4.5 13.5 2 2"/>`,
  facebook:    `<path d="M18 2h-3a5 5 0 0 0-5 5v3H7v4h3v8h4v-8h3l1-4h-4V7a1 1 0 0 1 1-1h3z"/>`,
  instagram:   `<rect x="2" y="2" width="20" height="20" rx="5" ry="5"/><path d="M16 11.37A4 4 0 1 1 12.63 8 4 4 0 0 1 16 11.37z"/><line x1="17.5" y1="6.5" x2="17.51" y2="6.5"/>`,
  twitter:     `<path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/>`,
  tiktok:      `<path d="M19.59 6.69a4.83 4.83 0 0 1-3.77-4.25V2h-3.45v13.67a2.89 2.89 0 0 1-2.88 2.5 2.89 2.89 0 0 1-2.89-2.89 2.89 2.89 0 0 1 2.89-2.89c.28 0 .54.04.79.1V9.01a6.27 6.27 0 0 0-.79-.05 6.34 6.34 0 0 0-6.34 6.34 6.34 6.34 0 0 0 6.34 6.34 6.34 6.34 0 0 0 6.33-6.34V8.69a8.18 8.18 0 0 0 4.78 1.52V6.76a4.85 4.85 0 0 1-1.01-.07z"/>`,
  linkedin:    `<path d="M16 8a6 6 0 0 1 6 6v7h-4v-7a2 2 0 0 0-2-2 2 2 0 0 0-2 2v7h-4v-7a6 6 0 0 1 6-6zM2 9h4v12H2z"/><circle cx="4" cy="4" r="2"/>`,
  whatsapp:    `<path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 0 1-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 0 1-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 0 1 2.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0 0 12.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 0 0 5.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 0 0-3.48-8.413Z"/>`,
  star:        `<polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>`,
  check:       `<polyline points="20 6 9 17 4 12"/>`,
  zap:         `<polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/>`,
  navigation:  `<polygon points="3 11 22 2 13 21 11 13 3 11"/>`,
  shoppingCart:`<circle cx="9" cy="21" r="1"/><circle cx="20" cy="21" r="1"/><path d="M1 1h4l2.68 13.39a2 2 0 0 0 2 1.61h9.72a2 2 0 0 0 2-1.61L23 6H6"/>`,
  clipboard:   `<path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><rect x="8" y="2" width="8" height="4" rx="1" ry="1"/>`,
  externalLink:`<path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/>`,
  utensils:    `<path d="M3 2v7c0 1.1.9 2 2 2h4a2 2 0 0 0 2-2V2"/><path d="M7 2v20"/><path d="M21 15V2a5 5 0 0 0-5 5v6c0 1.1.9 2 2 2h3Zm0 0v7"/>`,
};

const FILLED_ICONS = new Set(['facebook','instagram','twitter','tiktok','linkedin','whatsapp','star','zap']);

function icon(name, size = 20, color = 'currentColor') {
  const paths  = ICONS[name] || '';
  const filled = FILLED_ICONS.has(name);
  const attrs  = filled
    ? `fill="${color}" stroke="none"`
    : `fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"`;
  return `<svg viewBox="0 0 24 24" width="${size}" height="${size}" ${attrs} aria-hidden="true">${paths}</svg>`;
}

// ─── SHARED HELPERS (unchanged from v8) ───────────────────────────────────────

function esc(s) {
  if (!s) return '';
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function wa(phone, msg) {
  const p = String(phone || '').replace(/\D/g, '');
  const m = encodeURIComponent(msg || 'Hello, I found you on websites.co.zw');
  return `https://wa.me/${p}?text=${m}`;
}

function getImage(obj, ...extraFields) {
  if (!obj || typeof obj !== 'object') return '';
  const fields = ['photo','image','image_url','photo_url','img','picture','thumbnail',...extraFields];
  for (const key of fields) { if (obj[key]) return obj[key]; }
  return '';
}

function normalizeItemImages(arr) {
  if (!Array.isArray(arr)) return [];
  return arr.map(item => {
    if (!item || typeof item !== 'object') return item;
    const resolved = getImage(item);
    if (!resolved) return item;
    return { ...item, photo: item.photo || resolved, image: item.image || resolved };
  });
}

// ─── HOURS HELPERS (unchanged from v8) ────────────────────────────────────────

function normalizeHours(hours) {
  if (!hours) return null;
  if (typeof hours === 'string') return hours.trim();
  if (typeof hours !== 'object' || Array.isArray(hours)) return null;
  const DAY_KEYS = new Set(['mon','tue','wed','thu','fri','sat','sun']);
  const hasDay = Object.keys(hours).some(k => DAY_KEYS.has(k));
  let h = hours;
  if (!hasDay) {
    let found = null;
    for (const v of Object.values(hours)) {
      if (v && typeof v === 'object' && !Array.isArray(v)) {
        if (Object.keys(v).some(k => DAY_KEYS.has(k))) { found = v; break; }
      }
    }
    if (!found) return null;
    h = found;
  }
  function slotToStr(val) {
    if (!val) return null;
    if (typeof val === 'string') return val.trim();
    if (typeof val === 'number') return String(val).padStart(2,'0') + ':00';
    if (typeof val === 'object') {
      const hr  = String(val.hour ?? val.h ?? val.hours ?? 0).padStart(2,'0');
      const min = String(val.minute ?? val.m ?? val.minutes ?? 0).padStart(2,'0');
      return `${hr}:${min}`;
    }
    return null;
  }
  const normalized = {};
  for (const d of DAY_KEYS) {
    const slot = h[d];
    if (!slot || typeof slot !== 'object') continue;
    if (slot.closed) { normalized[d] = { closed: true }; continue; }
    const open  = slotToStr(slot.open ?? slot.opens ?? slot.from ?? slot.start);
    const close = slotToStr(slot.close ?? slot.closes ?? slot.to ?? slot.end);
    if (open || close) normalized[d] = { open: open || '?', close: close || '?' };
  }
  return Object.keys(normalized).length ? normalized : null;
}

function isOpenNow(hours) {
  const h = normalizeHours(hours);
  if (!h || typeof h === 'string') return null;
  const days = ['sun','mon','tue','wed','thu','fri','sat'];
  const day  = days[new Date().getDay()];
  const slot = h[day];
  if (!slot || typeof slot !== 'object' || slot.closed) return false;
  const [oh, om] = (slot.open  || '00:00').split(':').map(Number);
  const [ch, cm] = (slot.close || '00:00').split(':').map(Number);
  const mins = new Date().getHours() * 60 + new Date().getMinutes();
  return mins >= oh * 60 + om && mins < ch * 60 + cm;
}

function openClosedBadge(hours) {
  const open = isOpenNow(hours);
  if (open === null) return '';
  return open
    ? `<span class="badge-open"><span class="badge-dot"></span>Open Now</span>`
    : `<span class="badge-closed"><span class="badge-dot"></span>Closed</span>`;
}

function buildHoursGridHtml(hours) {
  const h = normalizeHours(hours);
  if (!h || typeof h === 'string') return '';
  const order  = ['mon','tue','wed','thu','fri','sat','sun'];
  const labels = { mon:'Monday',tue:'Tuesday',wed:'Wednesday',thu:'Thursday',fri:'Friday',sat:'Saturday',sun:'Sunday' };
  const today  = ['sun','mon','tue','wed','thu','fri','sat'][new Date().getDay()];
  return order.map(d => {
    const slot = h[d];
    if (!slot || typeof slot !== 'object') return null;
    const isToday  = d === today;
    const isClosed = slot.closed;
    const timeStr  = isClosed ? 'Closed' : `${slot.open||'?'} – ${slot.close||'?'}`;
    return `<div style="display:flex;justify-content:space-between;padding:.65rem .9rem;border-radius:8px;background:${isToday?'rgba(255,255,255,.12)':'transparent'}">
      <span style="font-weight:${isToday?'700':'400'};opacity:${isToday?'1':'.7'}">${labels[d]}${isToday?' <span style="font-size:.72rem;background:var(--accent);color:#fff;padding:.1rem .45rem;border-radius:999px;margin-left:.3rem">Today</span>':''}</span>
      <span style="font-weight:${isToday?'700':'400'};opacity:${isClosed?'.4':isToday?'1':'.7'}">${esc(timeStr)}</span>
    </div>`;
  }).filter(Boolean).join('');
}

// ─── CONTENT NORMALIZATION (unchanged from v8) ────────────────────────────────

function normalizeContent(raw) {
  if (!raw) return {};
  if (!raw.content || typeof raw.content !== 'object' || Array.isArray(raw.content)) return raw;
  const inner = raw.content;
  const theme = raw.theme || {};
  return {
    theme,
    business_name: inner.business_name || inner.name || '',
    name:          inner.business_name || inner.name || '',
    tagline:       inner.tagline || '',
    about:         inner.about || '',
    phone:         inner.contact?.phone || inner.contact?.whatsapp || inner.phone || '',
    email:         inner.contact?.email || inner.email || '',
    address:       inner.contact?.address || inner.address || inner.location || '',
    location:      inner.location || inner.contact?.address || '',
    hero_image:    inner.images?.hero || inner.hero_image || '',
    hero_image_url:inner.hero_image_url || inner.images?.hero || inner.hero_image || '',
    logo_url:      inner.logo_url || '',
    primary_color: inner.primary_color || '',
    images:        inner.images || {},
    gallery:       Array.isArray(inner.gallery) ? inner.gallery : (Array.isArray(inner.images?.gallery) ? inner.images.gallery : []),
    services:      normalizeItemImages(inner.services),
    services_intro:inner.services_intro || '',
    menu:          normalizeItemImages(inner.menu),
    products:      normalizeItemImages(inner.products),
    listings:      normalizeItemImages(inner.listings),
    team:          normalizeItemImages(inner.team),
    testimonials:  inner.testimonials || [],
    stats:         inner.stats || [],
    events:        inner.events || inner.schedule || [],
    hours:         normalizeHours(inner.hours) || null,
    socials:       inner.socials || {},
    seo:           inner.seo || {},
    contact:       inner.contact || {},
    map_embed_url: inner.map_embed_url || inner.contact?.map_embed_url || null,
    before_after:  inner.before_after || [],
    credentials:   inner.credentials || [],
    brands:        inner.brands || [],
    clients:       inner.clients || inner.partners || [],
    deal:          inner.deal || null,
    badge:         inner.badge || null,
    video_url:     inner.video || inner.video_url || null,
  };
}

// ─── DB QUERIES (unchanged from v8) ───────────────────────────────────────────

async function getSiteBySlug(db, slug) {
  const r = await db.prepare('SELECT * FROM sites WHERE draft_subdomain = ? LIMIT 1').bind(slug).first();
  return r || null;
}

async function getSiteByDomain(db, domain) {
  const r = await db.prepare("SELECT * FROM sites WHERE custom_domain = ? AND custom_domain_status = 'active' LIMIT 1").bind(domain).first();
  return r || null;
}

async function checkPreviewToken(db, token, siteId) {
  const row = await db.prepare('SELECT site_id, expires_at FROM preview_tokens WHERE token = ?1 LIMIT 1').bind(token).first();
  if (!row) return false;
  if (row.site_id !== siteId) return false;
  if (row.expires_at < Math.floor(Date.now() / 1000)) return false;
  return true;
}

function render404() {
  return new Response(`<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><title>Not Found · websites.co.zw</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>body{margin:0;font-family:system-ui,sans-serif;display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:100vh;background:#f5f5f5}
h1{font-size:4rem;margin:0;color:#1a1a2e}p{color:#666;margin:.5rem 0}a{color:#e94560;font-weight:600}</style>
</head><body><h1>404</h1><p>This site isn't available.</p><a href="https://websites.co.zw">Get your own site →</a></body></html>`,
  { status: 404, headers: { 'Content-Type': 'text/html;charset=UTF-8' } });
}
