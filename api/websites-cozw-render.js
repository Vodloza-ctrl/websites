/**
 * websites.co.zw — Render Worker v9.2
 * Fixes applied vs v9.1:
 *   5. normalizeContent() — services items normalized so both .name/.title
 *      and .body/.description are always populated from whichever field
 *      exists (AI Worker outputs title+body, editor saves name+body).
 *      Fixes blank service cards on advisory-firm and all future templates.
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

  if (host === 'assets.websites.co.zw') {
    const key = url.pathname.replace(/^\/+/, '');
    if (!key) return new Response('Not found', { status: 404 });
    return serveAsset(request, env, key);
  }
  if (url.pathname.startsWith('/assets/')) {
    return serveAsset(request, env, url.pathname.replace('/assets/', ''));
  }

  const parts = host.split('.');
  if (parts.length >= 3 && parts[1] === 'websites' && parts[2] === 'co') {
    return handlePublic(request, env, parts[0]);
  }

  return handlePublic(request, env, null, host);
}

// ─── ASSET PROXY ──────────────────────────────────────────────────────────────

async function serveAsset(request, env, key) {
  const cached   = caches.default;
  const cacheKey = new Request(request.url, request);
  const hit      = await cached.match(cacheKey);
  if (hit) return hit;

  const obj = await env.ASSETS.get(key);
  if (!obj) return new Response('Not found', { status: 404 });

  const ext     = key.split('.').pop().toLowerCase();
  const mimeMap = {
    jpg:'image/jpeg',jpeg:'image/jpeg',png:'image/png',
    gif:'image/gif',webp:'image/webp',svg:'image/svg+xml',
    pdf:'application/pdf',woff2:'font/woff2',woff:'font/woff'
  };
  const ct = mimeMap[ext] || 'application/octet-stream';
  const response = new Response(obj.body, {
    headers:{'Content-Type':ct,'Cache-Control':'public, max-age=31536000, immutable'}
  });
  await cached.put(cacheKey, response.clone());
  return response;
}

// ─── TEMPLATE FETCHER ─────────────────────────────────────────────────────────

const TEMPLATE_CACHE = new Map();

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

  const [html, config] = await Promise.all([htmlRes.text(), configRes.json()]);
  const result = { html, config };
  TEMPLATE_CACHE.set(templateId, result);
  return result;
}

// ─── RENDER ENGINE ────────────────────────────────────────────────────────────

function renderEngine(templateHtml, site, config, extraTokens) {
  const c = site.content || {};

  const computed = buildComputedTokens(site, c, config);
  const tokens   = { ...computed, ...(extraTokens || {}) };

  let html = templateHtml;

  // 1. Process {{#each}} blocks defined in config.lists
  for (const def of (config.lists || [])) {
    html = processEach(html, def, c, tokens);
  }

  // 2. Inject pre-built _html tokens (replaces leftover {{#each}} blocks)
  for (const [key, val] of Object.entries(extraTokens || {})) {
    if (key.endsWith('_html') && val) {
      const eachKey = key.replace(/_html$/, '');
      const re = new RegExp(
        `\\{\\{#each ${eachKey}\\}\\}[\\s\\S]*?\\{\\{\\/each\\}\\}`, 'g'
      );
      html = html.replace(re, val);
    }
  }

  // 3. Process {{#if}} / {{else}} / {{/if}} blocks
  for (const def of (config.conditionals || [])) {
    html = processConditional(html, def, c, tokens, computed);
  }

  // 4. Replace scalar {{token}} placeholders
  for (const [key, val] of Object.entries(tokens)) {
    if (!key.endsWith('_html') || typeof val === 'string') {
      html = html.split(`{{${key}}}`).join(String(val ?? ''));
    }
  }

  // 5. Strip unreplaced placeholders
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
    `\\{\\{#each ${def.key}\\}\\}([\\s\\S]*?)\\{\\{\\/each\\}\\}`, 'g'
  );
  return html.replace(re, () => {
    const items = Array.isArray(c[def.key]) ? c[def.key] : [];
    if (!items.length) return def.emptyHtml || '';
    return items.map((item, i) => {
      let block = def.itemTemplate;
      block = block.replace(
        /\{\{#if item\.(\w+)\}\}([\s\S]*?)\{\{else\}\}([\s\S]*?)\{\{\/if\}\}/g,
        (_, field, t, f) => item[field] ? t : f
      );
      block = block.replace(
        /\{\{#if item\.(\w+)\}\}([\s\S]*?)\{\{\/if\}\}/g,
        (_, field, content) => item[field] ? content : ''
      );
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

  const reElse = new RegExp(
    `\\{\\{#if ${def.flag}\\}\\}([\\s\\S]*?)\\{\\{else\\}\\}([\\s\\S]*?)\\{\\{\\/if\\}\\}`, 'g'
  );
  html = html.replace(reElse, (_, t, f) =>
    def.ifTrue !== undefined || def.ifFalse !== undefined
      ? (condition ? (def.ifTrue ?? t) : (def.ifFalse ?? ''))
      : (condition ? t : f)
  );

  const reIf = new RegExp(
    `\\{\\{#if ${def.flag}\\}\\}([\\s\\S]*?)\\{\\{\\/if\\}\\}`, 'g'
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
  if (slug)              site = await getSiteBySlug(env.DB, slug);
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

function buildTemplateExtras(c, site, config) {
  const extras = {};

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

  const address = c.address || c.location || c.contact?.address || '';
  if (address) {
    extras.maps_href = `https://maps.google.com/?q=${encodeURIComponent(address)}`;
  }

  if (config.showOpenBadge && c.hours) {
    extras.open_badge_html = openClosedBadge(c.hours);
  }

  if (config.showHoursGrid && c.hours) {
    extras.hours_grid_html = buildHoursGridHtml(c.hours);
  }

  const services = Array.isArray(c.services) ? c.services : [];
  if (services.length) {
    extras.service_options_html = services
      .map(s => `<option value="${esc(s.name || s.title || '')}">${esc(s.name || s.title || '')}</option>`)
      .join('\n');
  }

  const team = Array.isArray(c.team) ? c.team : [];
  if (team[0]?.photo_url || team[0]?.photo) {
    extras.band_image_url = team[0].photo_url || team[0].photo || '';
  }

  const stats = Array.isArray(c.stats) ? c.stats : [];
  if (stats.length) {
    extras.stats_html = stats.map(s =>
      `<div><b>${esc(String(s.value || s.number || ''))}</b><span>${esc(s.label || '')}</span></div>`
    ).join('\n');
  }

  // Grill-house / restaurant menu extras
  const templateId = site.template_id;
  if (templateId === 'grill-house' || templateId === 'restaurant') {
    Object.assign(extras, buildGrillExtras(c, config));
  }

  return extras;
}

// ─── GRILL EXTRAS ─────────────────────────────────────────────────────────────

function buildGrillExtras(c, config) {
  const extras = {};
  const menu   = Array.isArray(c.menu) ? c.menu : [];

  const palette      = config.paletteTokens || {};
  extras.ember_color = palette.ember_color || '#D2541F';
  extras.amber_color = palette.amber_color || '#E0A12E';

  for (const [k, v] of Object.entries(config.extraTokens || {})) {
    extras[k] = v;
  }

  if (!menu.length) return extras;

  // Treat empty/missing category as 'Menu'
  const getcat = item =>
    (item.category && item.category.trim()) ? item.category.trim() : 'Menu';

  const categories = [...new Set(menu.map(getcat))];
  const ICONS      = ['🥩', '🍗', '🌽', '🍟', '🥤', '🥗'];

  extras.menu_categories_html = categories
    .map((cat, i) =>
      `<button class="cat-tab${i === 0 ? ' on' : ''}" data-cat="${esc(cat)}">${esc(cat)}</button>`
    ).join('');

  extras.menu_by_category_html = categories.map((catName, catIdx) => {
    const items     = menu.filter(item => getcat(item) === catName);
    const itemsHtml = items.map((item, i) => {
      const photo   = item.photo || item.image || item.photo_url || '';
      const tag     = item.tag   || item.badge || '';
      const tagHtml = tag
        ? `<span class="dish-tag">${esc(tag)}</span>`
        : `<span style="font-size:.84rem;color:var(--ink2)">${esc(item.serves || item.note || '')}</span>`;
      const itemData = JSON.stringify({ name: item.name || '', price: item.price || '' })
        .replace(/'/g, '&#39;');

      return `<div class="dish reveal">
  <div class="dish-photo">${photo
    ? `<img src="${esc(photo)}" alt="${esc(item.name || '')}" loading="lazy">`
    : `<div style="width:100%;height:100%;display:flex;align-items:center;justify-content:center;font-size:2.5rem">${ICONS[i % ICONS.length]}</div>`
  }</div>
  <div class="dish-body">
    <div class="dish-title-row">
      <span class="dish-name">${esc(item.name || '')}</span>
      ${item.price ? `<span class="dish-price">${esc(item.price)}</span>` : ''}
    </div>
    ${item.description ? `<p class="dish-desc">${esc(item.description)}</p>` : ''}
    <div class="dish-footer">${tagHtml}<button class="add-btn" onclick="ghAddToOrder(${itemData})">+ Add to order</button></div>
  </div>
</div>`;
    }).join('');

    return `<div class="menu-cat reveal" data-cat="${esc(catName)}"${catIdx > 0 ? ' style="display:none"' : ''}>
  <div class="menu-grid">${itemsHtml}</div>
</div>`;
  }).join('');

  return extras;
}

// ─── SHELL WRAPPER ────────────────────────────────────────────────────────────

function wrapWithShell(body, c, site, config, isPreview) {
  const phone  = c.phone || c.contact?.phone || '';
  const digits = phone.replace(/\D/g, '');
  const waNum  = digits.startsWith('263') ? digits : '263' + digits.replace(/^0/, '');
  const waHref = phone ? `https://wa.me/${waNum}?text=${encodeURIComponent('Hello!')}` : '#';

  const skipNav = !!config.selfContainedNav;

  const navLinks = (config.navLinks || ['#services:Services', '#contact:Contact'])
    .map(l => { const [href, label] = l.split(':'); return `<a href="${esc(href)}">${esc(label)}</a>`; })
    .join('');

  const nav = skipNav ? '' : `
<nav class="wcz-nav" id="wcz-nav" style="--nav-text:${esc(config.navTextColor || '#fff')}">
  <div class="wcz-nav-inner">
    <div class="wcz-nav-logo">${esc(c.business_name || c.name || '')}</div>
    <div class="wcz-nav-links">${navLinks}
      ${phone ? `<a href="${esc(waHref)}" class="wcz-nav-cta" target="_blank" rel="noopener">${config.navCtaLabel || 'WhatsApp Us'}</a>` : ''}
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
    ? `<div style="position:fixed;bottom:0;left:0;right:0;z-index:9999;background:linear-gradient(135deg,#1a1a2e,#e94560);color:#fff;text-align:center;padding:.75rem;font-size:.85rem;font-weight:600">Preview mode — <a href="https://app.websites.co.zw" style="color:#fff;text-decoration:underline">Go to dashboard</a> to publish</div>`
    : '';

  const shellJs = skipNav ? '' : `<script>
(function(){
  var nav=document.getElementById('wcz-nav');
  function s(){if(nav)nav.classList.toggle('scrolled',window.scrollY>60);}
  window.addEventListener('scroll',s,{passive:true});s();
  var btn=document.getElementById('wcz-hamburger'),menu=document.getElementById('wcz-mobile-menu'),close=document.getElementById('wcz-mobile-close');
  if(btn&&menu){btn.addEventListener('click',function(){menu.classList.add('open');});if(close)close.addEventListener('click',function(){menu.classList.remove('open');});menu.querySelectorAll('a').forEach(function(a){a.addEventListener('click',function(){menu.classList.remove('open');});});}
})();
</script>`;

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
${config.googleFonts ? `<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link href="${esc(config.googleFonts)}" rel="stylesheet">` : ''}
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
html{scroll-behavior:smooth;-webkit-font-smoothing:antialiased}
img{max-width:100%;height:auto;display:block}
a{color:inherit;text-decoration:none}
button{cursor:pointer;border:none;background:none;font:inherit}
ul{list-style:none}
</style>
</head>
<body class="${esc(config.bodyClass || '')}">
${previewBanner}
${nav}
${body}
${shellJs}
</body>
</html>`;
}

// ─── ICON SYSTEM ──────────────────────────────────────────────────────────────

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
  facebook:    `<path d="M18 2h-3a5 5 0 0 0-5 5v3H7v4h3v8h4v-8h3l1-4h-4V7a1 1 0 0 1 1-1h3z"/>`,
  instagram:   `<rect x="2" y="2" width="20" height="20" rx="5" ry="5"/><path d="M16 11.37A4 4 0 1 1 12.63 8 4 4 0 0 1 16 11.37z"/><line x1="17.5" y1="6.5" x2="17.51" y2="6.5"/>`,
  twitter:     `<path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/>`,
  whatsapp:    `<path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 0 1-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 0 1-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 0 1 2.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0 0 12.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 0 0 5.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 0 0-3.48-8.413Z"/>`,
  star:        `<polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>`,
  check:       `<polyline points="20 6 9 17 4 12"/>`,
  zap:         `<polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/>`,
  shoppingCart:`<circle cx="9" cy="21" r="1"/><circle cx="20" cy="21" r="1"/><path d="M1 1h4l2.68 13.39a2 2 0 0 0 2 1.61h9.72a2 2 0 0 0 2-1.61L23 6H6"/>`,
  utensils:    `<path d="M3 2v7c0 1.1.9 2 2 2h4a2 2 0 0 0 2-2V2"/><path d="M7 2v20"/><path d="M21 15V2a5 5 0 0 0-5 5v6c0 1.1.9 2 2 2h3Zm0 0v7"/>`,
};

const FILLED_ICONS = new Set(['facebook','instagram','twitter','whatsapp','star','zap']);

function icon(name, size = 20, color = 'currentColor') {
  const paths  = ICONS[name] || '';
  const filled = FILLED_ICONS.has(name);
  const attrs  = filled
    ? `fill="${color}" stroke="none"`
    : `fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"`;
  return `<svg viewBox="0 0 24 24" width="${size}" height="${size}" ${attrs} aria-hidden="true">${paths}</svg>`;
}

// ─── SHARED HELPERS ───────────────────────────────────────────────────────────

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

// ─── NORMALIZE SERVICES ───────────────────────────────────────────────────────
// AI Worker outputs { title, body }; editor saves { name, body }.
// Normalize so both .name/.title and .body/.description are always present,
// whichever source the data came from. Configs can safely use either field name.

function normalizeServices(arr) {
  if (!Array.isArray(arr)) return [];
  return arr.map(item => {
    if (!item || typeof item !== 'object') return item;
    const title       = item.title       || item.name        || '';
    const name        = item.name        || item.title       || '';
    const body        = item.body        || item.description || '';
    const description = item.description || item.body        || '';
    return { ...item, title, name, body, description };
  });
}

// ─── HOURS HELPERS ────────────────────────────────────────────────────────────

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
  const labels = {mon:'Monday',tue:'Tuesday',wed:'Wednesday',thu:'Thursday',fri:'Friday',sat:'Saturday',sun:'Sunday'};
  const today  = ['sun','mon','tue','wed','thu','fri','sat'][new Date().getDay()];
  return order.map(d => {
    const slot = h[d];
    if (!slot || typeof slot !== 'object') return null;
    const isToday  = d === today;
    const isClosed = slot.closed;
    const timeStr  = isClosed ? 'Closed' : `${slot.open||'?'} – ${slot.close||'?'}`;
    return `<div class="hours-row${isToday?' today':''}">
      <span class="day">${labels[d]}${isToday?'<span class="today-pill">Today</span>':''}</span>
      <span class="time">${esc(timeStr)}</span>
    </div>`;
  }).filter(Boolean).join('');
}

// ─── CONTENT NORMALIZATION ────────────────────────────────────────────────────

function normalizeContent(raw) {
  if (!raw) return {};

  const inner = (raw.content && typeof raw.content === 'object' && !Array.isArray(raw.content))
    ? raw.content
    : raw;
  const theme  = raw.theme || {};
  const images = inner.images || {};

  const gallery = Array.isArray(inner.gallery)
    ? inner.gallery
    : Array.isArray(images.gallery)
      ? images.gallery.map(u => (typeof u === 'string' ? { url: u, caption: '' } : u))
      : [];

  return {
    theme,
    business_name:  inner.business_name || inner.name || '',
    name:           inner.business_name || inner.name || '',
    tagline:        inner.tagline  || '',
    about:          inner.about    || '',
    phone:          inner.contact?.phone || inner.contact?.whatsapp
                    || inner.phone       || inner._brief?.phone || '',
    email:          inner.contact?.email  || inner.email  || inner._brief?.email || '',
    address:        inner.contact?.address || inner.address || inner.location || '',
    location:       inner.location || inner.contact?.address || '',
    hero_image:     images.hero    || inner.hero_image     || '',
    hero_image_url: images.hero    || inner.hero_image_url || inner.hero_image || '',
    logo_url:       images.logo    || inner.logo_url       || '',
    primary_color:  inner.primary_color || theme.accent || '',
    images,
    gallery,
    // ↓ v9.2: normalizeServices() ensures title/name and body/description
    //   are always both populated regardless of which source wrote the data.
    services:       normalizeServices(normalizeItemImages(inner.services)),
    services_intro: inner.services_intro || '',
    menu:           normalizeItemImages(inner.menu),
    products:       normalizeItemImages(inner.products),
    listings:       normalizeItemImages(inner.listings),
    team:           normalizeItemImages(inner.team),
    testimonials:   inner.testimonials || [],
    stats:          inner.stats        || [],
    events:         inner.events       || inner.schedule || [],
    hours:          normalizeHours(inner.hours) || null,
    socials:        inner.socials  || {},
    seo:            inner.seo      || {},
    contact:        inner.contact  || {},
    map_embed_url:  inner.map_embed_url || inner.contact?.map_embed_url || null,
    before_after:   inner.before_after  || [],
    credentials:    inner.credentials  || [],
    brands:         inner.brands       || [],
    clients:        inner.clients      || inner.partners || [],
    deal:           inner.deal         || null,
    badge:          inner.badge        || null,
    video_url:      inner.video        || inner.video_url || null,
  };
}

// ─── DB QUERIES ───────────────────────────────────────────────────────────────

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
