/**
 * websites.co.zw -- Render Worker v10.30 + Church Template Support
 *
 * v10.30:
 *   - Added full church template support with dedicated handler
 *   - Church features: service times, ministries, events, giving, pastor bio
 *   - Added church to TEMPLATE_VAR_MAP, paletteFor, fontFor
 *   - Added church to STORE_TEMPLATE_IDS for product support
 *
 * v10.29:
 *   - Added buildSlotBookingWidgetAssets() for service/slot-based bookings (beauty-salon)
 *   - Wired into handlePublic() for SALON_TEMPLATE_IDS
 *   - Uses bookings.websites.co.zw public endpoints
 *
 * v10.28:
 *   - Hospitality-inn: room cards emit data-resource-id attribute
 *
 * v10.27:
 *   - WHATSAPP STORE ADDON GATING: WA ordering gated behind whatsapp_store addon
 *   - See checkAddonActive() for fail-open behaviour
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

// --- ROUTING ------------------------------------------------------------------

async function handleRequest(request, env) {
  const url = new URL(request.url);
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

// --- ASSET PROXY --------------------------------------------------------------

async function serveAsset(request, env, key) {
  const cached = caches.default;
  const cacheKey = new Request(request.url, request);
  const hit = await cached.match(cacheKey);
  if (hit) return hit;

  const obj = await env.ASSETS.get(key);
  if (!obj) return new Response('Not found', { status: 404 });

  const ext = key.split('.').pop().toLowerCase();
  const mimeMap = {
    jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png',
    gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml',
    pdf: 'application/pdf', woff2: 'font/woff2', woff: 'font/woff'
  };
  const ct = mimeMap[ext] || 'application/octet-stream';
  const response = new Response(obj.body, {
    headers: { 'Content-Type': ct, 'Cache-Control': 'public, max-age=31536000, immutable' }
  });
  await cached.put(cacheKey, response.clone());
  return response;
}

// --- TEMPLATE FETCHER ---------------------------------------------------------

async function getTemplate(templateId, env) {
  const origin = (env.PAGES_ORIGIN || 'https://www.websites.co.zw').replace(/\/$/, '');
  const base = `${origin}/templates/${templateId}`;

  const [htmlRes, configRes] = await Promise.all([
    fetch(`${base}/index.html?v=3`),
    fetch(`${base}/config.json?v=3`),
  ]);

  if (!htmlRes.ok) throw new Error(`Template HTML not found: ${templateId}`);
  if (!configRes.ok) throw new Error(`Template config not found: ${templateId}`);

  const [html, config] = await Promise.all([htmlRes.text(), configRes.json()]);
  return { html, config };
}

// --- RENDER ENGINE ------------------------------------------------------------

function renderEngine(templateHtml, site, config, extraTokens) {
  const c = site.content || {};

  const computed = buildComputedTokens(site, c, config);
  const tokens = { ...computed, ...(extraTokens || {}) };

  let html = templateHtml;

  for (const def of (config.lists || [])) {
    html = processEach(html, def, c, tokens);
  }

  for (const [key, val] of Object.entries(extraTokens || {})) {
    if (key.endsWith('_html') && val) {
      const eachKey = key.replace(/_html$/, '');
      const re = new RegExp(
        `\\{\\{#each ${eachKey}\\}\\}[\\s\\S]*?\\{\\{\\/each\\}\\}`, 'g'
      );
      html = html.replace(re, val);
    }
  }

  for (const def of (config.conditionals || [])) {
    html = processConditional(html, def, c, tokens, computed);
  }

  for (const [key, val] of Object.entries(tokens)) {
    if (!key.endsWith('_html') || typeof val === 'string') {
      html = html.split(`{{${key}}}`).join(String(val ?? ''));
    }
  }

  html = html.replace(/\{\{[^}]+\}\}/g, '');

  html = html.replace(
    /<!--WCZ:(\w+)-->([\s\S]*?)<!--WCZ:\/\1-->/g,
    (_, flag, inner) => tokens[flag] ? inner : ''
  );

  html = html.replace(/<!--WCZ:(\w+)-->/g, (_, key) => {
    const val = tokens[key];
    return val !== undefined ? String(val) : '';
  });

  return html;
}

function buildComputedTokens(site, c, config) {
  const businessName = c.business_name || c.name || '';
  const theme = c.theme || (site.content && site.content.theme) || {};
  const paletteKey = theme.palette || '';
  const customAccent = theme.custom_accent || '';
  const paletteColors = resolvePalette(paletteKey || config.defaultPalette || 'ember-cream', customAccent);
  const primaryColor = customAccent || (paletteKey ? paletteColors.primary : null) ||
    c.primary_color || site.primary_color ||
    config.defaultPrimaryColor || '#1a3a5c';
  const phone = c.phone || c.contact?.phone || '';
  const whatsapp = c.whatsapp || c.contact?.whatsapp || phone;
  const location = c.location || c.address || c.contact?.address || '';
  const about = c.about || '';

  const nameParts = businessName.trim().split(/\s+/);
  const businessNameFirst = nameParts[0] || businessName;
  const businessNameRest = nameParts.slice(1).join(' ') || '';

  const whatsappDigits = whatsapp.replace(/\D/g, '');
  const whatsappClean = whatsappDigits.startsWith('263') ?
    whatsappDigits :
    '263' + whatsappDigits.replace(/^0/, '');

  const seoTitle = c.seo?.meta_title || `${businessName}${location ? ' -- ' + location : ''}`;
  const seoDesc = c.seo?.meta_description || about.slice(0, 155);

  const typeLabel = (config.typeLabels || {})[site.template_id] ||
    c.business_type_label ||
    config.defaultTypeLabel ||
    '';

  return {
    site_id: site.id || '',
    business_name: businessName,
    business_name_first: businessNameFirst,
    business_name_rest: businessNameRest,
    primary_color: primaryColor,
    accent_color: primaryColor,
    tagline: c.tagline || '',
    about: about,
    about_text: about,
    phone: phone,
    email: c.email || c.contact?.email || '',
    whatsapp: whatsapp,
    whatsapp_clean: whatsappClean,
    whatsapp_wa_link: `https://wa.me/${whatsappClean}`,
    location: location,
    address: location,
    logo_url: c.logo_url || c.images?.logo || site.logo_url || '',
    hero_image_url: c.hero_image_url || c.hero_image || c.images?.hero || site.hero_image_url || '',
    seo_title: seoTitle,
    seo_description: seoDesc,
    business_type_label: typeLabel,
    current_year: String(new Date().getFullYear()),
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

      block = block.replace(/\{\{\{item\.(\w+)\}\}\}/g, (_, field) => {
        if (field === 'icon' && !item[field] && def.fallbackIcons) {
          return def.fallbackIcons[i % def.fallbackIcons.length];
        }
        return String(item[field] ?? '');
      });

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
        if (field.endsWith('_html') || field.endsWith('_link') || field.endsWith('_class')) {
          return String(item[field] ?? '');
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
    def.ifTrue !== undefined || def.ifFalse !== undefined ?
    (condition ? (def.ifTrue ?? t) : (def.ifFalse ?? '')) :
    (condition ? t : f)
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
    case 'field_present':
      return !!(deepGet(c, def.field));
    case 'list_present':
      return Array.isArray(c[def.field]) && c[def.field].length > 0;
    case 'nested_field':
      return !!(c[def.field]?.[def.subfield]);
    case 'computed':
      return !!(computed[def.token] || tokens[def.token]);
    case 'config_value':
      return !!def.value;
    case 'content_flag':
      return deepGet(c, def.field) !== false && (deepGet(c, def.field) ?? def.default ?? true);
    default:
      return false;
  }
}

function deepGet(obj, path) {
  if (!path) return undefined;
  return path.split('.').reduce((o, k) => o?.[k], obj);
}

// --- PUBLIC RENDER ------------------------------------------------------------

async function handlePublic(request, env, slug, customDomain) {
  let site;
  if (slug) site = await getSiteBySlug(env.DB, slug);
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

  const raw = typeof site.content === 'string' ? JSON.parse(site.content) : site.content;
  const content = normalizeContent(raw, site.template_id);

  const templateId = site.template_id || content.template || 'bold-retail';

  let html;
  try {
    const { html: templateHtml, config } = await getTemplate(templateId, env);
    const extraTokens = await buildTemplateExtras(content, site, config, env);
    const resolved = renderEngine(templateHtml, { ...site, content }, config, extraTokens);

    const _docHead = resolved.replace(/^\s*(?:<!--[\s\S]*?-->\s*)*/, '').toLowerCase();
    const isSelfContained = _docHead.startsWith('<!doctype') ||
      _docHead.startsWith('<html');

    const rawTheme = content.theme || {};
    const paletteBlock = buildPaletteOverride(
      templateId,
      rawTheme.palette || '',
      rawTheme.custom_accent || ''
    );

    const { styleBlock: fontBlock, fontsUrl } = buildFontOverride(rawTheme.font_pair || '');

    if (isSelfContained) {
      let out = resolved;
      if (fontsUrl) {
        out = out.replace(
          /https:\/\/fonts\.googleapis\.com\/css2\?[^"]+/,
          fontsUrl
        );
      }
      const headInsert = (paletteBlock || '') + (fontBlock || '');
      if (headInsert) {
        out = out.replace('</head>', headInsert + '</head>');
      }
      if (HOSP_TEMPLATE_IDS.has(templateId)) {
        const hospAssets = buildHospAssets();
        if (hospAssets.css) out = out.replace('</head>', hospAssets.css + '</head>');
        if (hospAssets.js) out = out.replace('</body>', hospAssets.js + '</body>');
        const bookingAssets = buildBookingWidgetAssets(site);
        if (bookingAssets.css) out = out.replace('</head>', bookingAssets.css + '</head>');
        if (bookingAssets.js) out = out.replace('</body>', bookingAssets.js + '</body>');
      }
      if (SALON_TEMPLATE_IDS.has(templateId)) {
        const slotAssets = buildSlotBookingWidgetAssets(site, { accentColor: '#C96A7E', resourceLabel: 'stylist' });
        if (slotAssets.css) out = out.replace('</head>', slotAssets.css + '</head>');
        if (slotAssets.js) out = out.replace('</body>', slotAssets.js + '</body>');
      }
      if (isPreview) {
        const banner = `<div style="position:fixed;bottom:0;left:0;right:0;z-index:9999;background:linear-gradient(135deg,#1a1a2e,#e94560);color:#fff;text-align:center;padding:.75rem;font-size:.85rem;font-weight:600">Preview mode -- <a href="https://app.websites.co.zw" style="color:#fff;text-decoration:underline">Go to dashboard</a> to publish</div>`;
        html = out.replace('</body>', banner + '</body>');
      } else {
        html = out;
      }
    } else {
      let shellOut = wrapWithShell(resolved, content, site, config, isPreview);
      if (fontsUrl) {
        shellOut = shellOut.replace(
          /https:\/\/fonts\.googleapis\.com\/css2\?[^"]+/,
          fontsUrl
        );
      }
      if (fontBlock) {
        shellOut = shellOut.replace('</head>', fontBlock + '</head>');
      }
      html = shellOut;
    }
  } catch (err) {
    console.error('Template error:', err);
    return new Response(`Template error: ${err.message}`, { status: 500 });
  }

  return new Response(html, {
    headers: {
      'Content-Type': 'text/html;charset=UTF-8',
      'Cache-Control': isPreview ? 'no-store' :
        site.status === 'grace' ? 'no-store' :
        'public, max-age=300, stale-while-revalidate=3600',
    }
  });
}

// --- SHARED FEATURED ITEM HELPER ---------------------------------------------

function extractFeatured(items) {
  if (!Array.isArray(items) || !items.length) {
    return { sorted: items || [], hasFeatured: false, featuredTag: '' };
  }
  const idx = items.findIndex(item => (item.tag || item.badge || '').trim());
  if (idx < 0) return { sorted: items, hasFeatured: false, featuredTag: '' };
  const featuredTag = (items[idx].tag || items[idx].badge || '').trim();
  const sorted = [items[idx], ...items.filter((_, i) => i !== idx)];
  return { sorted, hasFeatured: true, featuredTag };
}

const FEAT_STAR_SVG = `<svg viewBox="0 0 24 24" width="10" height="10" fill="currentColor" stroke="none" aria-hidden="true"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>`;

function featBadgeHtml(tag) {
  return `<span class="feat-badge">${FEAT_STAR_SVG}${esc(tag)}</span>`;
}

// --- SERVICE BINDING HELPERS ------------------------------------------------

async function callCommerceSDK(env, products, templateId, contentTheme, ctx) {
  const resp = await env.COMMERCE_SDK.fetch('https://internal/commerce', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ products, templateId, contentTheme, ctx }),
  });
  if (!resp.ok) throw new Error('commerce-sdk-worker /commerce returned ' + resp.status);
  return resp.json();
}

async function callCommerceCSS(env) {
  const resp = await env.COMMERCE_SDK.fetch('https://internal/css', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  });
  if (!resp.ok) throw new Error('commerce-sdk-worker /css returned ' + resp.status);
  const { css } = await resp.json();
  return css;
}

// --- ADDON GATING (WhatsApp Store) -------------------------------------------

async function checkAddonActive(env, siteId, addonType) {
  if (!env.ORDERS_WORKER) return true;
  try {
    const resp = await env.ORDERS_WORKER.fetch(
      `https://internal/addon-check?site_id=${encodeURIComponent(siteId)}&type=${encodeURIComponent(addonType)}`
    );
    return resp.ok;
  } catch (err) {
    console.error('Addon check failed, failing open:', err);
    return true;
  }
}

// =============================================================================
// UNIVERSAL COMMERCE SDK
// =============================================================================

const RENDERERS = {

  fashion: {
    gridCols: { mobile: 2, tablet: 3, desktop: 3 },
    cardAspect: '3/4',
    cardShowPrice: 'below',
    cardShowSpecs: false,
    cardShowStock: false,
    cardHoverEffect: 'quickview',
    drawerImageLayout: 'stack',
    drawerShowDetails: true,
    drawerShowSpecs: false,
    drawerShowRelated: true,
    drawerPricePos: 'below-name',
    variantLabel: 'Size',
    variantStyle: 'pill',
    colorLabel: 'Colour',
    colorStyle: 'swatch',
    showColorName: true,
    showQuantity: false,
    showIngredients: false,
    showWarranty: false,
    waTemplate: 'Hi {biz}, I would like to order:\n\u2022 {name}\n  Colour: {color}\n  Size: {variant}\n  Price: {price}\n\nPlease confirm availability.',
    waTemplateNoVar: 'Hi {biz}, I would like to order:\n\u2022 {name}\n  Price: {price}\n\nPlease confirm availability.',
    badges: {
      new: { label: 'New', bg: '#0e0e0e', color: '#fff' },
      sale: { label: 'Sale', bg: '#b8956a', color: '#fff' },
      out: { label: 'Sold out', bg: '#b8b0a8', color: '#fff' },
    },
    specsLabel: 'Details',
  },

  hardware: {
    gridCols: { mobile: 2, tablet: 3, desktop: 4 },
    cardAspect: '1/1',
    cardShowPrice: 'overlay',
    cardShowSpecs: true,
    cardShowStock: true,
    cardHoverEffect: 'zoom',
    drawerImageLayout: 'thumbs',
    drawerShowDetails: false,
    drawerShowSpecs: true,
    drawerShowRelated: true,
    drawerPricePos: 'top',
    variantLabel: 'Size / Dimension',
    variantStyle: 'pill',
    colorLabel: 'Finish',
    colorStyle: 'text-pill',
    showColorName: false,
    showQuantity: true,
    showIngredients: false,
    showWarranty: false,
    waTemplate: 'Hi {biz}, I would like to order:\n\u2022 {name}\n  Finish: {color}\n  Size: {variant}\n  Qty: {qty}\n  Price: {price}\n\nPlease confirm stock and delivery.',
    waTemplateNoVar: 'Hi {biz}, I would like to order:\n\u2022 {name}\n  Qty: {qty}\n  Price: {price}\n\nPlease confirm stock and delivery.',
    badges: {
      new: { label: 'New', bg: '#1a56db', color: '#fff' },
      sale: { label: 'Special', bg: '#ea580c', color: '#fff' },
      out: { label: 'Out of Stock', bg: '#6b7280', color: '#fff' },
    },
    specsLabel: 'Specifications',
  },

  grocery: {
    gridCols: { mobile: 2, tablet: 3, desktop: 4 },
    cardAspect: '1/1',
    cardShowPrice: 'prominent',
    cardShowSpecs: false,
    cardShowStock: true,
    cardHoverEffect: 'addbutton',
    drawerImageLayout: 'single',
    drawerShowDetails: true,
    drawerShowSpecs: false,
    drawerShowRelated: true,
    drawerPricePos: 'top',
    variantLabel: 'Pack size',
    variantStyle: 'pill',
    colorLabel: '',
    colorStyle: 'none',
    showColorName: false,
    showQuantity: true,
    showIngredients: true,
    showWarranty: false,
    waTemplate: 'Hi {biz}, I would like to order:\n\u2022 {name} ({variant})\n  Qty: {qty}\n  Price: {price} each\n\nPlease confirm availability.',
    waTemplateNoVar: 'Hi {biz}, I would like to order:\n\u2022 {name}\n  Qty: {qty}\n  Price: {price} each\n\nPlease confirm availability.',
    badges: {
      new: { label: 'New', bg: '#16a34a', color: '#fff' },
      sale: { label: 'Special', bg: '#ea580c', color: '#fff' },
      out: { label: 'Unavailable', bg: '#6b7280', color: '#fff' },
      fresh: { label: 'Fresh Today', bg: '#16a34a', color: '#fff' },
    },
    specsLabel: 'Nutritional Info',
  },

  beauty: {
    gridCols: { mobile: 2, tablet: 3, desktop: 3 },
    cardAspect: '3/4',
    cardShowPrice: 'below',
    cardShowSpecs: false,
    cardShowStock: false,
    cardHoverEffect: 'quickview',
    drawerImageLayout: 'stack',
    drawerShowDetails: true,
    drawerShowSpecs: false,
    drawerShowRelated: true,
    drawerPricePos: 'below-name',
    variantLabel: 'Size',
    variantStyle: 'pill',
    colorLabel: 'Shade',
    colorStyle: 'swatch',
    showColorName: true,
    showQuantity: false,
    showIngredients: true,
    showWarranty: false,
    waTemplate: 'Hi {biz}, I would like to order:\n\u2022 {name}\n  Shade: {color}\n  Size: {variant}\n  Price: {price}\n\nPlease confirm availability.',
    waTemplateNoVar: 'Hi {biz}, I would like to order:\n\u2022 {name}\n  Price: {price}\n\nPlease confirm availability.',
    badges: {
      new: { label: 'New', bg: '#0e0e0e', color: '#fff' },
      sale: { label: 'On Sale', bg: '#c96a7e', color: '#fff' },
      out: { label: 'Sold out', bg: '#b8b0a8', color: '#fff' },
      bestseller: { label: 'Best Seller', bg: '#b8956a', color: '#fff' },
    },
    specsLabel: 'Ingredients',
  },

  electronics: {
    gridCols: { mobile: 1, tablet: 2, desktop: 3 },
    cardAspect: '4/3',
    cardShowPrice: 'prominent',
    cardShowSpecs: true,
    cardShowStock: true,
    cardHoverEffect: 'zoom',
    drawerImageLayout: 'thumbs',
    drawerShowDetails: false,
    drawerShowSpecs: true,
    drawerShowRelated: true,
    drawerPricePos: 'top',
    variantLabel: 'Configuration',
    variantStyle: 'pill',
    colorLabel: 'Colour',
    colorStyle: 'text-pill',
    showColorName: false,
    showQuantity: false,
    showIngredients: false,
    showWarranty: true,
    waTemplate: 'Hi {biz}, I would like to enquire about:\n\u2022 {name}\n  Config: {variant}\n  Colour: {color}\n  Price: {price}\n\nPlease confirm availability and warranty.',
    waTemplateNoVar: 'Hi {biz}, I would like to enquire about:\n\u2022 {name}\n  Price: {price}\n\nPlease confirm availability and warranty.',
    badges: {
      new: { label: 'New', bg: '#1a56db', color: '#fff' },
      sale: { label: 'Deal', bg: '#ea580c', color: '#fff' },
      out: { label: 'Sold Out', bg: '#6b7280', color: '#fff' },
      warranty: { label: '1yr Warranty', bg: '#16a34a', color: '#fff' },
    },
    specsLabel: 'Specifications',
  },
};

const TEMPLATE_RENDERER_MAP = {
  'fashion-retail': 'fashion',
  'boutique-fashion': 'fashion',
  'boutique': 'fashion',
  'grocery-fmcg': 'grocery',
  'grocery': 'grocery',
  'hardware-store': 'hardware',
  'hardware': 'hardware',
  'beauty-salon': 'beauty',
  'electronics': 'electronics',
};

function resolveRenderer(templateId, contentTheme) {
  if (contentTheme && contentTheme.shop_renderer && RENDERERS[contentTheme.shop_renderer]) {
    return RENDERERS[contentTheme.shop_renderer];
  }
  const key = TEMPLATE_RENDERER_MAP[templateId];
  if (key && RENDERERS[key]) return RENDERERS[key];
  return RENDERERS.fashion;
}

function _esc(s) {
  if (!s) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function buildBadgeHtml(product, renderer) {
  const isOut = (product.stock || '').toLowerCase() === 'out';
  const badgeKey = (product.badge || product.tag || '').toLowerCase();
  if (isOut) {
    const b = renderer.badges.out;
    return `<div class="wcz-prod-badge" style="background:${b.bg};color:${b.color}">${_esc(b.label)}</div>`;
  }
  if (badgeKey && renderer.badges[badgeKey]) {
    const b = renderer.badges[badgeKey];
    return `<div class="wcz-prod-badge wcz-prod-badge-${badgeKey}" style="background:${b.bg};color:${b.color}">${_esc(b.label)}</div>`;
  }
  if (product.price_was && renderer.badges.sale) {
    const b = renderer.badges.sale;
    return `<div class="wcz-prod-badge wcz-prod-badge-sale" style="background:${b.bg};color:${b.color}">${_esc(b.label)}</div>`;
  }
  return '';
}

function buildCardSwatchesHtml(colors, renderer) {
  if (!Array.isArray(colors) || !colors.length) return '';
  if (renderer.colorStyle === 'none') return '';
  const swatches = colors.slice(0, 5).map(col => {
    if (renderer.colorStyle === 'swatch') {
      return `<span class="wcz-prod-swatch" style="background:${_esc(col.hex || col.color || '#ccc')}" title="${_esc(col.name || '')}"></span>`;
    }
    return `<span class="wcz-prod-swatch wcz-prod-swatch-text" title="${_esc(col.name || '')}">${_esc((col.name || '').substring(0, 1))}</span>`;
  }).join('');
  return `<div class="wcz-prod-swatches">${swatches}</div>`;
}

function buildCardSpecsHtml(product) {
  const specs = product.specs;
  if (!specs || typeof specs !== 'object') return '';
  const entries = Object.entries(specs).slice(0, 2);
  if (!entries.length) return '';
  return `<div class="wcz-prod-card-specs">${entries.map(([k, v]) =>
    `<span class="wcz-prod-spec-chip">${_esc(String(v))}</span>`
  ).join('')}</div>`;
}

function buildCardStockHtml(product) {
  const isOut = (product.stock || '').toLowerCase() === 'out';
  if (isOut) return `<div class="wcz-prod-stock wcz-prod-stock-out">Out of stock</div>`;
  return `<div class="wcz-prod-stock wcz-prod-stock-in">In stock</div>`;
}

function buildProductCard(product, renderer, ctx, addonActive) {
  const isOut = (product.stock || '').toLowerCase() === 'out';
  const name = product.name || product.title || '';
  const price = product.price || '';
  const priceWas = product.price_was || '';
  const cat = (product.category || '').trim();
  const primaryImg = product.image || product.photo || '';
  const allImgs = Array.isArray(product.images) && product.images.length ?
    product.images : primaryImg ? [primaryImg] : [];

  const photoEl = primaryImg ?
    `<img src="${_esc(primaryImg)}" alt="${_esc(name)}" loading="lazy">` :
    `<div class="wcz-prod-photo-ph"><svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="m3 9 3-3 4 4 4-4 4 4"/><circle cx="7.5" cy="7.5" r="1"/></svg></div>`;

  const stockOverlay = isOut ?
    `<div class="wcz-prod-stock-overlay">${_esc(renderer.badges.out?.label || 'Out of stock')}</div>` :
    '';

  const badgeHtml = buildBadgeHtml(product, renderer);

  let priceHtml = '';
  if (renderer.cardShowPrice === 'overlay') {
    priceHtml = price ? `<div class="wcz-prod-price-overlay">${_esc(price)}</div>` : '';
  } else if (renderer.cardShowPrice === 'prominent') {
    priceHtml = price ?
      `<div class="wcz-prod-price wcz-prod-price-prominent">${_esc(price)}${priceWas ? `<span class="wcz-prod-price-old">${_esc(priceWas)}</span>` : ''}</div>` :
      '';
  } else {
    priceHtml = price ?
      `<div class="wcz-prod-price">${_esc(price)}${priceWas ? `<span class="wcz-prod-price-old">${_esc(priceWas)}</span>` : ''}</div>` :
      '';
  }

  const cardSpecsHtml = renderer.cardShowSpecs ? buildCardSpecsHtml(product) : '';
  const swatchHtml = buildCardSwatchesHtml(product.colors || [], renderer);

  const qvPayload = {
    id: product.id || '', name, price, price_was: priceWas, category: cat,
    description: product.description || product.body || '',
    details: Array.isArray(product.details) ? product.details : [],
    specs: (typeof product.specs === 'object' && product.specs) ? product.specs : {},
    images: allImgs,
    colors: Array.isArray(product.colors) ? product.colors : [],
    variants: Array.isArray(product.variants) ? product.variants : [],
    stock: product.stock || 'in', badge: product.badge || product.tag || '',
    warranty: product.warranty || '',
  };

  const sn = name.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
  const sp = price.replace(/\\/g, '\\\\').replace(/'/g, "\\'");

  let addBtn = '';
  if (addonActive !== false) {
    addBtn = isOut ?
      `<button class="wcz-add-btn" disabled>Sold out</button>` :
      `<button class="wcz-add-btn" onclick="wczAddToOrder({name:'${sn}',price:'${sp}'},this)">+ Add to cart</button>`;
  }

  return `<div class="wcz-prod-card" data-cat="${_esc(cat)}" data-id="${_esc(product.id || '')}" data-qv="${_esc(JSON.stringify(qvPayload))}" onclick="wczOpenProduct(this)">
  <div class="wcz-prod-photo" style="aspect-ratio:${renderer.cardAspect}">
    ${photoEl}
    ${badgeHtml}
    ${stockOverlay}
    ${renderer.cardShowPrice === 'overlay' ? priceHtml : ''}
  </div>
  <div class="wcz-prod-info">
    <div class="wcz-prod-name">${_esc(name)}</div>
    ${renderer.cardShowPrice !== 'overlay' ? priceHtml : ''}
    ${cardSpecsHtml}
    ${swatchHtml ? `<div class="wcz-prod-swatches" onclick="event.stopPropagation()">${swatchHtml}</div>` : ''}
    ${addBtn ? `<div onclick="event.stopPropagation()">${addBtn}</div>` : ''}
  </div>
</div>`;
}

function buildGridHtml(products, renderer, ctx, addonActive) {
  if (!products.length) {
    return `<div class="wcz-prod-empty"><p>No products yet -- check back soon.</p></div>`;
  }
  const cards = products.map(p => buildProductCard(p, renderer, ctx, addonActive)).join('\n');
  return `<div class="wcz-prod-grid">${cards}</div>`;
}

function buildFilterHtml(products) {
  const cats = [...new Set(
    products.map(p => (p.category || '').trim()).filter(Boolean)
  )];
  return cats.map(cat =>
    `<button class="fr-cat" data-cat="${_esc(cat)}">${_esc(cat)}</button>`
  ).join('');
}

function buildDrawerImagesHtml(renderer) {
  if (renderer.drawerImageLayout === 'thumbs') {
    return `<div class="wcz-qv-imgs wcz-qv-imgs-thumbs">
  <div class="wcz-qv-main-img" id="wcz-qv-main">
    <div class="wcz-qv-img active" id="wcz-qv-img-0"></div>
    <button class="wcz-qv-arr wcz-qv-arr-prev" id="wcz-qv-prev" aria-label="Previous">&#8249;</button>
    <button class="wcz-qv-arr wcz-qv-arr-next" id="wcz-qv-next" aria-label="Next">&#8250;</button>
  </div>
  <div class="wcz-qv-thumbstrip" id="wcz-qv-thumbs"></div>
</div>`;
  }
  if (renderer.drawerImageLayout === 'single') {
    return `<div class="wcz-qv-imgs wcz-qv-imgs-single">
  <div class="wcz-qv-img active" id="wcz-qv-img-0"></div>
</div>`;
  }
  return `<div class="wcz-qv-imgs wcz-qv-imgs-stack">
  <div class="wcz-qv-img active" id="wcz-qv-img-0"></div>
  <button class="wcz-qv-arr wcz-qv-arr-prev" id="wcz-qv-prev" aria-label="Previous">&#8249;</button>
  <button class="wcz-qv-arr wcz-qv-arr-next" id="wcz-qv-next" aria-label="Next">&#8250;</button>
  <div class="wcz-qv-dots" id="wcz-qv-dots"></div>
</div>`;
}

function buildDrawerHtml(renderer, addonActive) {
  const hasQty = renderer.showQuantity;
  const hasSpecs = renderer.drawerShowSpecs;
  const hasDetail = renderer.drawerShowDetails;
  const priceTop = renderer.drawerPricePos === 'top';

  const actionsHtml = addonActive === false ?
    `<p class="wcz-qv-note">Contact us directly to enquire about this item.</p>` :
    `<div class="wcz-qv-actions">
    <button class="wcz-qv-btn-cart" id="wcz-qv-add-cart">
      <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="9" cy="21" r="1"/><circle cx="20" cy="21" r="1"/><path d="M1 1h4l2.68 13.39a2 2 0 0 0 2 1.61h9.72a2 2 0 0 0 2-1.61L23 6H6"/></svg>
      Add to cart
    </button>
    <a class="wcz-qv-btn-buynow" id="wcz-qv-wa" href="#" target="_blank" rel="noopener">
      <svg viewBox="0 0 24 24" width="15" height="15" fill="#fff" stroke="none"><path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 0 1-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 0 1-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 0 1 2.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0 0 12.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 0 0 5.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 0 0-3.48-8.413Z"/></svg>
      Buy now
    </a>
  </div>
  <p class="wcz-qv-note">We confirm availability and arrange delivery via WhatsApp.</p>`;

  return `<button class="wcz-qv-close" id="wcz-qv-close" aria-label="Close">&#x2715;</button>

${buildDrawerImagesHtml(renderer)}

<div class="wcz-qv-body">
  <div class="wcz-qv-cat" id="wcz-qv-cat"></div>
  <h2 class="wcz-qv-name" id="wcz-qv-name"></h2>

  ${priceTop ? `<div class="wcz-qv-price-row" id="wcz-qv-price-row">
    <span class="wcz-qv-price" id="wcz-qv-price"></span>
    <span class="wcz-qv-price-was" id="wcz-qv-was"></span>
  </div>` : ''}

  <p class="wcz-qv-desc" id="wcz-qv-desc"></p>

  ${!priceTop ? `<div class="wcz-qv-price-row" id="wcz-qv-price-row">
    <span class="wcz-qv-price" id="wcz-qv-price"></span>
    <span class="wcz-qv-price-was" id="wcz-qv-was"></span>
  </div>` : ''}

  <div id="wcz-qv-colors-wrap" style="display:none">
    <div class="wcz-qv-label">${_esc(renderer.colorLabel || 'Colour')}<span class="wcz-qv-color-name" id="wcz-qv-color-name"></span></div>
    <div class="wcz-qv-colors" id="wcz-qv-colors"></div>
  </div>

  <div id="wcz-qv-variants-wrap" style="display:none">
    <div class="wcz-qv-label">${_esc(renderer.variantLabel || 'Size')}</div>
    <div class="wcz-qv-sizes" id="wcz-qv-sizes"></div>
  </div>

  ${hasQty ? `<div class="wcz-qv-qty-wrap" id="wcz-qv-qty-wrap" style="display:none">
    <div class="wcz-qv-label">Quantity</div>
    <div class="wcz-qv-qty-row">
      <button class="wcz-qv-qty-btn" id="wcz-qty-minus" aria-label="Decrease">&#8722;</button>
      <span class="wcz-qv-qty-val" id="wcz-qty-val">1</span>
      <button class="wcz-qv-qty-btn" id="wcz-qty-plus" aria-label="Increase">&#43;</button>
    </div>
  </div>` : ''}

  ${hasDetail ? `<div id="wcz-qv-details-wrap" style="display:none">
    <div class="wcz-qv-label">${_esc(renderer.specsLabel || 'Details')}</div>
    <ul class="wcz-qv-details" id="wcz-qv-details"></ul>
  </div>` : ''}

  ${hasSpecs ? `<div id="wcz-qv-specs-wrap" style="display:none">
    <div class="wcz-qv-label">${_esc(renderer.specsLabel || 'Specifications')}</div>
    <table class="wcz-qv-specs-table" id="wcz-qv-specs"></table>
  </div>` : ''}

  ${renderer.showWarranty ? `<div id="wcz-qv-warranty-wrap" style="display:none">
    <div class="wcz-qv-label">Warranty</div>
    <div class="wcz-qv-warranty" id="wcz-qv-warranty"></div>
  </div>` : ''}

  <div id="wcz-qv-related-wrap" style="display:none">
    <div class="wcz-qv-label">You might also like</div>
    <div class="wcz-qv-related" id="wcz-qv-related"></div>
  </div>

  ${actionsHtml}
</div>`;
}

function buildLightboxHtml() {
  return `<div id="wcz-lb" role="dialog" aria-modal="true" aria-label="Image viewer">
  <button class="wcz-lb-close" id="wcz-lb-close" aria-label="Close">&#x2715;</button>
  <button class="wcz-lb-arr wcz-lb-prev" id="wcz-lb-prev" aria-label="Previous">&#8249;</button>
  <div class="wcz-lb-stage" id="wcz-lb-stage">
    <img id="wcz-lb-img" src="" alt="">
  </div>
  <button class="wcz-lb-arr wcz-lb-next" id="wcz-lb-next" aria-label="Next">&#8250;</button>
  <div class="wcz-lb-footer">
    <div class="wcz-lb-thumbs" id="wcz-lb-thumbs"></div>
    <div class="wcz-lb-count" id="wcz-lb-count"></div>
  </div>
</div>
<div id="wcz-lb-overlay"></div>`;
}

function buildCartBarHtml() {
  return `<button class="wcz-order-fab" id="wcz-order-fab" onclick="wczCartToggle()">
  <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="9" cy="21" r="1"/><circle cx="20" cy="21" r="1"/><path d="M1 1h4l2.68 13.39a2 2 0 0 0 2 1.61h9.72a2 2 0 0 0 2-1.61L23 6H6"/></svg>
  My order <span class="wcz-order-count" id="wcz-order-count">0</span>
</button>
<div class="wcz-order-panel" id="wcz-order-panel">
  <div class="wcz-order-hdr">
    <span>Your order</span>
    <button class="wcz-order-hdr-close" onclick="wczCartToggle()">&#x2715;</button>
  </div>
  <div class="wcz-order-items" id="wcz-order-items">
    <div class="wcz-order-empty">Your order is empty.<br>Add items to get started.</div>
  </div>
  <div class="wcz-order-total" id="wcz-order-total" style="display:none"></div>
  <div class="wcz-order-actions">
    <button class="wcz-order-clear" onclick="wczCartClear()">Clear</button>
    <a class="wcz-order-send" id="wcz-order-send" href="#" target="_blank" rel="noopener">Send on WhatsApp &#x1F4AC;</a>
  </div>
</div>`;
}

function buildWaFabHtml(ctx) {
  if (!ctx.waNum) return '';
  const msg = encodeURIComponent(`Hello ${ctx.bizName || ''}, I have an enquiry.`);
  return `<a class="wcz-wa-fab" id="wcz-wa-fab" href="https://wa.me/${_esc(ctx.waNum)}?text=${msg}" target="_blank" rel="noopener" aria-label="WhatsApp enquiry">
  <div class="wcz-wa-fab-pulse"></div>
  <svg viewBox="0 0 24 24" width="26" height="26" fill="#fff" stroke="none"><path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 0 1-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 0 1-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 0 1 2.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0 0 12.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 0 0 5.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 0 0-3.48-8.413Z"/></svg>
</a>`;
}

function buildProductScript(products, renderer, ctx, addonActive) {
  const productsJson = JSON.stringify(products);
  const rendererJson = JSON.stringify({
    colorStyle: renderer.colorStyle,
    showColorName: renderer.showColorName,
    colorLabel: renderer.colorLabel,
    variantLabel: renderer.variantLabel,
    showQuantity: renderer.showQuantity,
    drawerShowSpecs: renderer.drawerShowSpecs,
    drawerShowDetails: renderer.drawerShowDetails,
    drawerShowRelated: renderer.drawerShowRelated,
    showWarranty: renderer.showWarranty,
    drawerImageLayout: renderer.drawerImageLayout,
    waTemplate: renderer.waTemplate,
    waTemplateNoVar: renderer.waTemplateNoVar,
  });

  const waNum = (ctx.waNum || '').replace(/'/g, "\\'");
  const bizName = (ctx.bizName || '').replace(/'/g, "\\'");

  const cartBarHtml = addonActive === false ? '' :
    `<button class="wcz-order-fab" id="wcz-order-fab" onclick="wczCartToggle()"><svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="9" cy="21" r="1"/><circle cx="20" cy="21" r="1"/><path d="M1 1h4l2.68 13.39a2 2 0 0 0 2 1.61h9.72a2 2 0 0 0 2-1.61L23 6H6"/></svg> My order <span class="wcz-order-count" id="wcz-order-count">0</span></button><div class="wcz-order-panel" id="wcz-order-panel"><div class="wcz-order-hdr"><span>Your order</span><button class="wcz-order-hdr-close" onclick="wczCartToggle()">&#x2715;</button></div><div class="wcz-order-items" id="wcz-order-items"><div class="wcz-order-empty">Your order is empty.<br>Add items to get started.</div></div><div class="wcz-order-total" id="wcz-order-total" style="display:none"></div><div class="wcz-order-actions"><button class="wcz-order-clear" onclick="wczCartClear()">Clear</button><a class="wcz-order-send" id="wcz-order-send" href="#" target="_blank" rel="noopener">Send on WhatsApp &#x1F4AC;</a></div></div>`;

  const waFabHtml = (addonActive !== false && waNum) ?
    `<a class="wcz-wa-fab" id="wcz-wa-fab" href="https://wa.me/${waNum}?text=${encodeURIComponent('Hello ' + bizName + ', I have an enquiry.')}" target="_blank" rel="noopener" aria-label="WhatsApp enquiry"><div class="wcz-wa-fab-pulse"></div><svg viewBox="0 0 24 24" width="26" height="26" fill="#fff" stroke="none"><path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 0 1-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 0 1-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 0 1 2.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0 0 12.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 0 0 5.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 0 0-3.48-8.413Z"/></svg></a>` :
    '';

  return `<script>
(function(){
'use strict';

var WCZ_PRODUCTS = ${productsJson};
var WCZ_R        = ${rendererJson};
var WCZ_WA       = '${waNum}';
var WCZ_BIZ      = '${bizName}';
var WCZ_ADDON_ACTIVE = ${addonActive === false ? 'false' : 'true'};

(function injectUI(){
  if (${JSON.stringify(cartBarHtml)} && !document.getElementById('wcz-order-fab')) {
    var wrap = document.createElement('div');
    wrap.innerHTML = ${JSON.stringify(cartBarHtml)};
    while (wrap.firstChild) document.body.appendChild(wrap.firstChild);
  }
  if (${JSON.stringify(waFabHtml)} && !document.getElementById('wcz-wa-fab')) {
    var wafWrap = document.createElement('div');
    wafWrap.innerHTML = ${JSON.stringify(waFabHtml)};
    while (wafWrap.firstChild) document.body.appendChild(wafWrap.firstChild);
  }
})();

var _cart = [];

function cartParsePrice(p) {
  if (!p) return null;
  var m = String(p).match(/[\\d.,]+/);
  return m ? parseFloat(m[0].replace(/,/g, '')) : null;
}
function cartCurrencySymbol(p) {
  var m = String(p || '').match(/^[^\\d\\s]+/);
  return m ? m[0] : '$';
}

function cartBuildWaMsg() {
  if (!_cart.length || !WCZ_WA) return '#';
  var lines = _cart.map(function(item) {
    var line = '\\u2022 ' + item.qty + '\\xd7 ' + item.name;
    if (item.color)   line += ' \\u2014 ' + item.color;
    if (item.variant) line += ' / ' + item.variant;
    if (item.price)   line += ' (' + item.price + ')';
    return line;
  });
  var msg = 'Hello ' + WCZ_BIZ + ', I would like to order:\\n' + lines.join('\\n');
  var allNum = _cart.every(function(i) { return cartParsePrice(i.price) !== null; });
  if (allNum && _cart[0].price) {
    var sym = cartCurrencySymbol(_cart[0].price);
    var tot = _cart.reduce(function(a, i) { return a + (cartParsePrice(i.price) * i.qty); }, 0);
    msg += '\\n\\nTotal: ' + sym + tot.toFixed(2);
  }
  msg += '\\n\\nPlease confirm availability and payment details.';
  return 'https://wa.me/' + WCZ_WA + '?text=' + encodeURIComponent(msg);
}

function cartRender() {
  var cnt = _cart.reduce(function(a, b) { return a + b.qty; }, 0);

  var fab      = document.getElementById('wcz-order-fab');
  var fabCount = document.getElementById('wcz-order-count');
  if (fab) fab.style.display = cnt > 0 ? 'flex' : 'none';
  if (fabCount) fabCount.textContent = cnt;

  var navBtn   = document.getElementById('wcz-nav-cart');
  var navLabel = document.getElementById('wcz-nav-cart-label');
  var navBadge = document.getElementById('wcz-nav-cart-count');
  if (navBtn) {
    navBtn.classList.toggle('wcz-nav-cart-active', cnt > 0);
    if (navLabel) navLabel.textContent = cnt > 0 ? 'My order' : 'Order online';
    if (navBadge) { navBadge.textContent = cnt; navBadge.style.display = cnt > 0 ? 'inline-flex' : 'none'; }
  }

  var itemsEl = document.getElementById('wcz-order-items');
  var totalEl = document.getElementById('wcz-order-total');
  var sendEl  = document.getElementById('wcz-order-send');

  if (!itemsEl) return;
  if (!_cart.length) {
    itemsEl.innerHTML = '<div class="wcz-order-empty">Your order is empty.<br>Add items to get started.</div>';
    if (totalEl) totalEl.style.display = 'none';
    if (sendEl)  sendEl.href = '#';
    return;
  }

  itemsEl.innerHTML = _cart.map(function(item, idx) {
    var meta = '';
    if (item.color)   meta += '<span class="wcz-order-meta">' + item.color + '</span>';
    if (item.variant) meta += '<span class="wcz-order-meta">' + item.variant + '</span>';
    return '<div class="wcz-order-row">'
      + '<div class="wcz-order-row-info">'
      +   '<span class="wcz-order-row-name">' + item.name + '</span>'
      +   (meta ? '<div class="wcz-order-row-meta">' + meta + '</div>' : '')
      +   (item.price ? '<span class="wcz-order-row-price">' + item.price + '</span>' : '')
      + '</div>'
      + '<div class="wcz-order-qty">'
      +   '<button onclick="wczCartQ(' + idx + ',-1)" aria-label="Decrease">\\u2212</button>'
      +   '<span>' + item.qty + '</span>'
      +   '<button onclick="wczCartQ(' + idx + ',1)" aria-label="Increase">+</button>'
      + '</div>'
      + '</div>';
  }).join('');

  var allNum = _cart.every(function(i) { return cartParsePrice(i.price) !== null; });
  if (allNum && totalEl && _cart[0].price) {
    var sym = cartCurrencySymbol(_cart[0].price);
    var tot = _cart.reduce(function(a, i) { return a + (cartParsePrice(i.price) * i.qty); }, 0);
    totalEl.style.display = 'flex';
    totalEl.innerHTML = '<span>Total</span><span>' + sym + tot.toFixed(2) + '</span>';
  } else if (totalEl) {
    totalEl.style.display = 'none';
  }
  if (sendEl) sendEl.href = cartBuildWaMsg();
}

window.wczCartAdd = function(name, price, color, variant, qty) {
  if (!WCZ_ADDON_ACTIVE) return;
  var key = name + '|' + (color || '') + '|' + (variant || '');
  var ex  = _cart.find(function(i) { return (i.name + '|' + (i.color||'') + '|' + (i.variant||'')) === key; });
  if (ex) { ex.qty += (qty || 1); }
  else    { _cart.push({ name:name, price:price, color:color||'', variant:variant||'', qty:qty||1 }); }
  cartRender();
};
window.wczCartToggle = function() {
  var p = document.getElementById('wcz-order-panel');
  if (p) p.classList.toggle('open');
};
window.wczCartClear = function() {
  _cart = [];
  cartRender();
  var p = document.getElementById('wcz-order-panel');
  if (p) p.classList.remove('open');
};
window.wczCartQ = function(idx, delta) {
  if (!_cart[idx]) return;
  _cart[idx].qty += delta;
  if (_cart[idx].qty <= 0) _cart.splice(idx, 1);
  cartRender();
};
window.wczNavCta = function() {
  if (_cart.length > 0) { wczCartToggle(); }
  else {
    var el = document.getElementById('wcz-products') || document.querySelector('.wcz-prod-grid');
    if (el) el.scrollIntoView({ behavior: 'smooth' });
  }
};

window.addEventListener('scroll', function() {
  var f = document.getElementById('wcz-wa-fab');
  if (f) f.classList.toggle('wcz-wa-fab-visible', window.scrollY > 300);
}, { passive:true });

var state = { product:null, imgIdx:0, imgs:[], color:'', variant:'', qty:1, lbImgs:[], lbIdx:0 };

function $(id){ return document.getElementById(id); }
function show(id){ var el=$(id); if(el) el.style.display=''; }
function hide(id){ var el=$(id); if(el) el.style.display='none'; }
function setText(id,v){ var el=$(id); if(el) el.textContent=v; }
function setHref(id,v){ var el=$(id); if(el) el.href=v; }

function buildBuyNowMsg() {
  var p = state.product;
  if (!p || !WCZ_WA) return '#';
  var qty = WCZ_R.showQuantity ? String(state.qty) : '';
  var hasVariant = state.variant || state.color;
  var tpl = (hasVariant || !WCZ_R.waTemplateNoVar) ? WCZ_R.waTemplate : WCZ_R.waTemplateNoVar;
  var msg = tpl
    .replace('{biz}',     WCZ_BIZ)
    .replace('{name}',    p.name    || '')
    .replace('{color}',   state.color   || (WCZ_R.colorLabel   ? 'Not selected' : ''))
    .replace('{variant}', state.variant || (WCZ_R.variantLabel ? 'Not selected' : ''))
    .replace('{qty}',     qty || '1')
    .replace('{price}',   p.price   || '');
  return WCZ_WA ? 'https://wa.me/' + WCZ_WA + '?text=' + encodeURIComponent(msg) : '#';
}
function refreshDrawerActions() { setHref('wcz-qv-wa', buildBuyNowMsg()); }

document.addEventListener('click', function(e) {
  if (!WCZ_ADDON_ACTIVE) return;
  var btn = e.target.closest('#wcz-qv-add-cart');
  if (!btn) return;
  var p = state.product;
  if (!p) return;
  var qty = WCZ_R.showQuantity ? state.qty : 1;
  wczCartAdd(p.name, p.price, state.color, state.variant, qty);
  closeDrawer();
  var fab = document.getElementById('wcz-order-fab');
  if (fab) { fab.style.background = '#1fb357'; setTimeout(function(){ fab.style.background = ''; }, 900); }
});

function drawerGoTo(idx) {
  var imgs = state.imgs;
  if (!imgs.length) return;
  state.imgIdx = ((idx % imgs.length) + imgs.length) % imgs.length;
  var mainEl = $('wcz-qv-img-0');
  if (mainEl) {
    mainEl.innerHTML = imgs[state.imgIdx]
      ? '<img src="' + imgs[state.imgIdx] + '" alt="" style="width:100%;height:100%;object-fit:cover;cursor:zoom-in" onclick="wczOpenLightbox(' + state.imgIdx + ')">'
      : '<div class="wcz-qv-img-ph"></div>';
  }
  var thumbs = $('wcz-qv-thumbs');
  if (thumbs) thumbs.querySelectorAll('.wcz-qv-thumb').forEach(function(t,i){ t.classList.toggle('active', i===state.imgIdx); });
  var dots = $('wcz-qv-dots');
  if (dots) dots.querySelectorAll('.wcz-qv-dot').forEach(function(d,i){ d.classList.toggle('active', i===state.imgIdx); });
}

function buildDrawerImages(imgs) {
  state.imgs = imgs; state.imgIdx = 0;
  var mainEl = $('wcz-qv-img-0');
  if (mainEl && imgs.length) {
    mainEl.innerHTML = '<img src="' + imgs[0] + '" alt="" style="width:100%;height:100%;object-fit:cover;cursor:zoom-in" onclick="wczOpenLightbox(0)">';
  }
  var thumbs = $('wcz-qv-thumbs');
  if (thumbs && imgs.length > 1) {
    thumbs.innerHTML = imgs.map(function(src,i){
      return '<div class="wcz-qv-thumb' + (i===0?' active':'') + '" onclick="drawerGoTo(' + i + ')"><img src="' + src + '" alt="" loading="lazy"></div>';
    }).join('');
  }
  var dots = $('wcz-qv-dots');
  if (dots && imgs.length > 1) {
    dots.innerHTML = imgs.map(function(src,i){
      return '<span class="wcz-qv-dot' + (i===0?' active':'') + '" onclick="drawerGoTo(' + i + ')"></span>';
    }).join('');
  }
  var prev = $('wcz-qv-prev'), next = $('wcz-qv-next');
  if (prev) prev.style.display = imgs.length > 1 ? '' : 'none';
  if (next) next.style.display = imgs.length > 1 ? '' : 'none';
}

function buildColorPicker(colors) {
  var el = $('wcz-qv-colors');
  if (!el) return;
  if (!colors || !colors.length || WCZ_R.colorStyle === 'none') { hide('wcz-qv-colors-wrap'); return; }
  show('wcz-qv-colors-wrap');
  state.color = colors[0].name || '';
  if (WCZ_R.showColorName) setText('wcz-qv-color-name', ' \\u2014 ' + state.color);
  el.innerHTML = colors.map(function(col, i){
    var isActive = i === 0;
    if (WCZ_R.colorStyle === 'swatch') {
      return '<button class="wcz-qv-color' + (isActive?' active':'') + '" style="background:' + (col.hex||col.color||'#ccc') + '" title="' + (col.name||'') + '" data-name="' + (col.name||'') + '" data-img="' + (col.image||'') + '" aria-label="' + (col.name||'') + '"></button>';
    }
    return '<button class="wcz-qv-size' + (isActive?' active':'') + '" data-name="' + (col.name||'') + '">' + (col.name||'') + '</button>';
  }).join('');
  el.querySelectorAll('button').forEach(function(btn){
    btn.addEventListener('click', function(){
      el.querySelectorAll('button').forEach(function(b){ b.classList.remove('active'); });
      btn.classList.add('active');
      state.color = btn.dataset.name || '';
      if (WCZ_R.showColorName) setText('wcz-qv-color-name', state.color ? ' \\u2014 ' + state.color : '');
      refreshDrawerActions();
    });
  });
}

function buildVariantPicker(variants) {
  var el = $('wcz-qv-sizes');
  if (!el) return;
  if (!variants || !variants.length) { hide('wcz-qv-variants-wrap'); state.variant = ''; return; }
  show('wcz-qv-variants-wrap');
  state.variant = '';
  el.innerHTML = variants.map(function(v){
    var label = typeof v === 'string' ? v : (v.label || v.name || String(v));
    var avail = typeof v === 'object' ? v.available !== false : true;
    return '<button class="wcz-qv-size' + (!avail?' out':'') + '" data-val="' + label + '" ' + (avail?'':'disabled ') + 'aria-label="' + label + '">' + label + '</button>';
  }).join('');
  el.querySelectorAll('button:not([disabled])').forEach(function(btn){
    btn.addEventListener('click', function(){
      el.querySelectorAll('button').forEach(function(b){ b.classList.remove('active'); });
      btn.classList.add('active');
      state.variant = btn.dataset.val || '';
      refreshDrawerActions();
    });
  });
}

function initQty() {
  if (!WCZ_R.showQuantity) return;
  state.qty = 1; setText('wcz-qty-val', '1');
  var minus = $('wcz-qty-minus'), plus = $('wcz-qty-plus');
  if (minus) minus.onclick = function(){ if(state.qty>1){ state.qty--; setText('wcz-qty-val',String(state.qty)); } };
  if (plus)  plus.onclick  = function(){ state.qty++; setText('wcz-qty-val',String(state.qty)); };
}

function buildDetails(details) {
  var el = $('wcz-qv-details');
  if (!el) return;
  if (!WCZ_R.drawerShowDetails || !details || !details.length) { hide('wcz-qv-details-wrap'); return; }
  show('wcz-qv-details-wrap');
  el.innerHTML = details.map(function(d){ return '<li class="wcz-qv-detail-item">' + String(d).replace(/&/g,'&amp;').replace(/</g,'&lt;') + '</li>'; }).join('');
}

function buildSpecs(specs) {
  var el = $('wcz-qv-specs');
  if (!el) return;
  if (!WCZ_R.drawerShowSpecs || !specs || !Object.keys(specs).length) { hide('wcz-qv-specs-wrap'); return; }
  show('wcz-qv-specs-wrap');
  el.innerHTML = Object.entries(specs).map(function(entry){
    return '<tr><th class="wcz-spec-key">' + String(entry[0]).replace(/</g,'&lt;') + '</th><td class="wcz-spec-val">' + String(entry[1]).replace(/</g,'&lt;') + '</td></tr>';
  }).join('');
}

function buildWarranty(warranty) {
  var el = $('wcz-qv-warranty');
  if (!el) return;
  if (!WCZ_R.showWarranty || !warranty) { hide('wcz-qv-warranty-wrap'); return; }
  show('wcz-qv-warranty-wrap');
  el.textContent = warranty;
}

function buildRelated(currentId, category) {
  var el = $('wcz-qv-related');
  if (!el) return;
  if (!WCZ_R.drawerShowRelated) { hide('wcz-qv-related-wrap'); return; }
  var related = WCZ_PRODUCTS.filter(function(p){ return p.id !== currentId && (p.category||'') === category; }).slice(0,4);
  if (!related.length) { hide('wcz-qv-related-wrap'); return; }
  show('wcz-qv-related-wrap');
  el.innerHTML = related.map(function(p){
    var img = p.image || p.photo || '';
    return '<div class="wcz-related-card" data-pid="' + p.id + '" onclick="wczOpenProductById(this.dataset.pid)">'
      + (img ? '<img src="' + img + '" alt="' + (p.name||'') + '" loading="lazy">' : '<div class="wcz-related-ph"></div>')
      + '<div class="wcz-related-name">' + (p.name||'') + '</div>'
      + (p.price ? '<div class="wcz-related-price">' + p.price + '</div>' : '')
      + '</div>';
  }).join('');
}

function openDrawer(product) {
  state.product = product; state.qty = 1; state.color = ''; state.variant = '';
  setText('wcz-qv-cat',   product.category || '');
  setText('wcz-qv-name',  product.name     || '');
  setText('wcz-qv-price', product.price    || '');
  var wasEl = $('wcz-qv-was');
  if (wasEl) { wasEl.textContent = product.price_was || ''; wasEl.style.display = product.price_was ? '' : 'none'; }
  setText('wcz-qv-desc', product.description || '');
  var imgs = Array.isArray(product.images) && product.images.length ? product.images : (product.image||product.photo) ? [product.image||product.photo] : [];
  state.lbImgs = imgs;
  buildDrawerImages(imgs);
  buildColorPicker(product.colors   || []);
  buildVariantPicker(product.variants || []);
  if (WCZ_R.showQuantity) { initQty(); show('wcz-qv-qty-wrap'); } else { hide('wcz-qv-qty-wrap'); }
  buildDetails(product.details  || []);
  buildSpecs(product.specs      || {});
  buildWarranty(product.warranty || '');
  buildRelated(product.id || '', product.category || '');
  refreshDrawerActions();
  var overlay = $('wcz-qv-overlay'), drawer = $('wcz-qv-drawer');
  if (overlay) overlay.classList.add('open');
  if (drawer)  drawer.classList.add('open');
  document.body.style.overflow = 'hidden';
}

function closeDrawer() {
  var overlay = $('wcz-qv-overlay'), drawer = $('wcz-qv-drawer');
  if (overlay) overlay.classList.remove('open');
  if (drawer)  drawer.classList.remove('open');
  document.body.style.overflow = '';
}

function openLightbox(startIdx) {
  var imgs = state.lbImgs;
  if (!imgs.length) return;
  state.lbIdx = ((startIdx||0) % imgs.length);
  var lb = $('wcz-lb'), lbOv = $('wcz-lb-overlay');
  if (!lb) return;
  lbGoTo(state.lbIdx);
  lb.classList.add('open');
  if (lbOv) lbOv.classList.add('open');
}

function closeLightbox() {
  var lb = $('wcz-lb'), lbOv = $('wcz-lb-overlay');
  if (lb)   lb.classList.remove('open');
  if (lbOv) lbOv.classList.remove('open');
}

function lbGoTo(idx) {
  var imgs = state.lbImgs;
  state.lbIdx = ((idx % imgs.length) + imgs.length) % imgs.length;
  var img = $('wcz-lb-img'), cnt = $('wcz-lb-count');
  if (img) { img.src = imgs[state.lbIdx]; img.alt = state.product ? state.product.name : ''; }
  if (cnt) cnt.textContent = (state.lbIdx + 1) + ' / ' + imgs.length;
  var thumbs = $('wcz-lb-thumbs');
  if (thumbs) {
    if (!thumbs.children.length) {
      thumbs.innerHTML = imgs.map(function(src,i){ return '<img class="wcz-lb-thumb' + (i===0?' active':'') + '" src="' + src + '" alt="" loading="lazy" onclick="lbGoTo(' + i + ')">'; }).join('');
    }
    thumbs.querySelectorAll('.wcz-lb-thumb').forEach(function(t,i){ t.classList.toggle('active', i===state.lbIdx); });
  }
}

document.addEventListener('click', function(e) {
  if (e.target.closest('#wcz-qv-prev')) { drawerGoTo(state.imgIdx - 1); return; }
  if (e.target.closest('#wcz-qv-next')) { drawerGoTo(state.imgIdx + 1); return; }
  if (e.target.closest('#wcz-qv-close')) { closeDrawer(); return; }
  if (e.target.id === 'wcz-qv-overlay') { closeDrawer(); return; }
  if (e.target.closest('#wcz-lb-close')) { closeLightbox(); return; }
  if (e.target.closest('#wcz-lb-prev'))  { lbGoTo(state.lbIdx - 1); return; }
  if (e.target.closest('#wcz-lb-next'))  { lbGoTo(state.lbIdx + 1); return; }
  if (e.target.id === 'wcz-lb-overlay')  { closeLightbox(); return; }
});

document.addEventListener('keydown', function(e){
  var lbOpen = $('wcz-lb') && $('wcz-lb').classList.contains('open');
  var dvOpen = $('wcz-qv-drawer') && $('wcz-qv-drawer').classList.contains('open');
  if (e.key==='Escape') { if(lbOpen){closeLightbox();return;} if(dvOpen){closeDrawer();return;} }
  if (lbOpen) { if(e.key==='ArrowLeft') lbGoTo(state.lbIdx-1); if(e.key==='ArrowRight') lbGoTo(state.lbIdx+1); }
  if (dvOpen && !lbOpen) { if(e.key==='ArrowLeft') drawerGoTo(state.imgIdx-1); if(e.key==='ArrowRight') drawerGoTo(state.imgIdx+1); }
});

var tsX = null;
document.addEventListener('touchstart', function(e){
  if (e.target.closest('.wcz-qv-imgs')) tsX = e.touches[0].clientX;
}, {passive:true});
document.addEventListener('touchend', function(e){
  if (tsX === null) return;
  if (!e.target.closest('.wcz-qv-imgs')) { tsX = null; return; }
  var dx = e.changedTouches[0].clientX - tsX; tsX = null;
  if (Math.abs(dx) > 40) drawerGoTo(state.imgIdx + (dx < 0 ? 1 : -1));
}, {passive:true});

var lsX = null;
document.addEventListener('touchstart', function(e){
  if (e.target.closest('#wcz-lb-stage')) lsX = e.touches[0].clientX;
}, {passive:true});
document.addEventListener('touchend', function(e){
  if (lsX === null) return;
  if (!e.target.closest('#wcz-lb-stage')) { lsX = null; return; }
  var dx = e.changedTouches[0].clientX - lsX; lsX = null;
  if (Math.abs(dx) > 40) lbGoTo(state.lbIdx + (dx < 0 ? 1 : -1));
}, {passive:true});

window.wczOpenProduct = function(cardEl) {
  try { openDrawer(JSON.parse(cardEl.dataset.qv)); } catch(e){ console.error('WCZ qv parse error',e); }
};
window.wczOpenProductById = function(id) {
  var p = WCZ_PRODUCTS.find(function(x){ return x.id===id; });
  if (p) openDrawer(p);
};
window.wczOpenLightbox = function(idx){ openLightbox(idx); };
window.drawerGoTo = drawerGoTo;
window.lbGoTo     = lbGoTo;

window.wczCardAdd = function(btn, name, price) {
  if (!WCZ_ADDON_ACTIVE) return;
  wczCartAdd(name, price, '', '', 1);
  var orig = btn.textContent;
  btn.textContent = 'Added \u2713';
  btn.disabled = true;
  setTimeout(function(){ btn.textContent = orig; btn.disabled = false; }, 1400);
};

window.wczAddToOrder = function(item, btnEl) {
  if (!WCZ_ADDON_ACTIVE) return;
  wczCartAdd(item.name || '', item.price || '', '', '', 1);
  if (btnEl) {
    var orig = btnEl.textContent;
    btnEl.textContent = 'Added \u2713';
    btnEl.disabled = true;
    setTimeout(function(){ btnEl.textContent = orig; btnEl.disabled = false; }, 1400);
  }
  var fab = document.getElementById('wcz-order-fab');
  if (fab) { fab.style.background = '#1fb357'; setTimeout(function(){ fab.style.background = ''; }, 900); }
};

cartRender();

})();
<\/script>`;
}

function buildCommerceModule(products, templateId, contentTheme, ctx) {
  const renderer = resolveRenderer(templateId, contentTheme);
  const addonActive = (ctx && ctx.addonActive === false) ? false : true;
  return {
    gridHtml: buildGridHtml(products, renderer, ctx, addonActive),
    filterHtml: buildFilterHtml(products),
    drawerHtml: buildDrawerHtml(renderer, addonActive),
    lbHtml: buildLightboxHtml(),
    scriptHtml: buildProductScript(products, renderer, ctx, addonActive),
  };
}

function buildCommerceCSS() {
  return `<style>
.wcz-prod-grid{display:grid;grid-template-columns:repeat(2,1fr);gap:20px}
@media(min-width:640px){.wcz-prod-grid{grid-template-columns:repeat(3,1fr)}}
.wcz-prod-card{cursor:pointer;background:var(--ink2,#1a1a1a);border-radius:6px;overflow:hidden;transition:transform .2s}
.wcz-prod-card:hover{transform:translateY(-4px)}
.wcz-prod-photo{position:relative;overflow:hidden;background:var(--ink3,#2a2a2a)}
.wcz-prod-photo img{width:100%;height:100%;object-fit:cover;transition:transform .4s;display:block}
.wcz-prod-card:hover .wcz-prod-photo img{transform:scale(1.04)}
.wcz-prod-photo-ph{width:100%;height:100%;display:flex;align-items:center;justify-content:center;opacity:.2}
.wcz-prod-badge{position:absolute;top:10px;left:10px;font-size:.6rem;font-weight:600;letter-spacing:.08em;text-transform:uppercase;padding:4px 9px;border-radius:2px;z-index:1}
.wcz-prod-stock-overlay{position:absolute;inset:0;background:rgba(12,12,12,.65);display:flex;align-items:center;justify-content:center;font-size:.7rem;letter-spacing:.14em;text-transform:uppercase;color:#fff}
.wcz-prod-quick{position:absolute;bottom:0;left:0;right:0;background:rgba(12,12,12,.8);color:#fff;font-size:.65rem;letter-spacing:.1em;text-transform:uppercase;text-align:center;padding:10px;opacity:0;transition:opacity .2s}
.wcz-prod-card:hover .wcz-prod-quick{opacity:1}
.wcz-prod-info{padding:14px 16px 18px}
.wcz-prod-name{font-family:var(--mono,"DM Mono",monospace);font-size:.9rem;font-weight:500;line-height:1.3;margin-bottom:6px}
.wcz-prod-price{font-family:var(--mono,"DM Mono",monospace);font-size:1rem;color:var(--gold,#c8a24a);font-weight:500;margin-top:4px}
.wcz-prod-price-old{font-size:.8rem;opacity:.45;text-decoration:line-through;margin-left:8px;color:inherit}
.wcz-prod-swatches{display:flex;gap:5px;margin-top:8px;flex-wrap:wrap}
.wcz-prod-swatch{display:inline-block;width:14px;height:14px;border-radius:50%;border:1.5px solid rgba(255,255,255,.18)}
.wcz-prod-meta-row{display:flex;align-items:center;justify-content:space-between;margin-top:8px}
.wcz-prod-empty{padding:60px 0;text-align:center;opacity:.45;font-size:.95rem}
.fr-cat{font-family:var(--mono,"DM Mono",monospace);font-size:.65rem;letter-spacing:.08em;text-transform:uppercase;padding:7px 16px;border:1px solid rgba(255,255,255,.15);border-radius:2px;color:inherit;cursor:pointer;transition:border-color .15s,background .15s,color .15s;background:transparent}
.fr-cat:hover{border-color:rgba(255,255,255,.4)}
.fr-cat.active{border-color:var(--gold,#c8a24a);color:var(--gold,#c8a24a);background:rgba(200,162,74,.08)}
#wcz-qv-overlay{display:none;position:fixed;inset:0;z-index:190;background:rgba(0,0,0,.7);backdrop-filter:blur(4px)}
#wcz-qv-overlay.open{display:block}
#wcz-qv-drawer{position:fixed;top:0;right:0;bottom:0;z-index:195;width:min(480px,100vw);background:var(--ink2,#1a1a1a);overflow-y:auto;overflow-x:hidden;transform:translateX(100%);transition:transform .32s cubic-bezier(.4,0,.2,1);display:flex;flex-direction:column}
#wcz-qv-drawer.open{transform:translateX(0)}
.wcz-qv-close{position:sticky;top:0;z-index:2;align-self:flex-end;margin:16px 16px 0 0;width:34px;height:34px;border-radius:50%;background:rgba(255,255,255,.08);font-size:1.1rem;display:flex;align-items:center;justify-content:center;cursor:pointer;transition:background .2s}
.wcz-qv-close:hover{background:rgba(255,255,255,.18)}
.wcz-qv-imgs{position:relative;background:var(--ink3,#2a2a2a);flex-shrink:0}
.wcz-qv-imgs-stack,.wcz-qv-imgs-thumbs,.wcz-qv-imgs-single{aspect-ratio:3/4}
.wcz-qv-img{width:100%;height:100%;overflow:hidden}
.wcz-qv-img img{width:100%;height:100%;object-fit:cover}
.wcz-qv-img-ph{width:100%;height:100%;display:flex;align-items:center;justify-content:center;opacity:.2}
.wcz-qv-arr{position:absolute;top:50%;transform:translateY(-50%);background:rgba(0,0,0,.5);border-radius:50%;width:36px;height:36px;display:flex;align-items:center;justify-content:center;font-size:1.3rem;color:#fff;cursor:pointer;transition:background .2s;z-index:1}
.wcz-qv-arr-prev{left:10px}.wcz-qv-arr-next{right:10px}
.wcz-qv-arr:hover{background:rgba(0,0,0,.8)}
.wcz-qv-dots{position:absolute;bottom:12px;left:50%;transform:translateX(-50%);display:flex;gap:5px}
.wcz-qv-dot{width:6px;height:6px;border-radius:50%;background:rgba(255,255,255,.4);cursor:pointer;transition:background .2s}
.wcz-qv-dot.active{background:#fff}
.wcz-qv-thumbstrip{display:flex;gap:6px;padding:8px;overflow-x:auto;background:var(--ink2,#1a1a1a)}
.wcz-qv-thumb{width:56px;height:56px;flex-shrink:0;overflow:hidden;border-radius:2px;cursor:pointer;border:1.5px solid transparent;transition:border-color .15s}
.wcz-qv-thumb img{width:100%;height:100%;object-fit:cover}
.wcz-qv-thumb.active{border-color:var(--gold,#c8a24a)}
.wcz-qv-body{padding:24px 24px 40px;flex:1;display:flex;flex-direction:column;gap:0}
.wcz-qv-cat{font-family:var(--mono,"DM Mono",monospace);font-size:.6rem;letter-spacing:.14em;text-transform:uppercase;color:var(--gold,#c8a24a);margin-bottom:8px}
.wcz-qv-name{font-family:var(--mono,"DM Mono",monospace);font-size:1.25rem;font-weight:500;line-height:1.2;margin-bottom:0}
.wcz-qv-price-row{display:flex;align-items:baseline;gap:10px;margin:12px 0}
.wcz-qv-price{font-family:var(--mono,"DM Mono",monospace);font-size:1.2rem;color:var(--gold,#c8a24a);font-weight:500}
.wcz-qv-price-was{font-size:.9rem;opacity:.4;text-decoration:line-through}
.wcz-qv-desc{font-size:.9rem;opacity:.65;line-height:1.75;margin-bottom:20px}
.wcz-qv-label{font-family:var(--mono,"DM Mono",monospace);font-size:.65rem;letter-spacing:.1em;text-transform:uppercase;opacity:.5;margin:16px 0 8px;display:flex;align-items:center;gap:6px}
.wcz-qv-color-name{opacity:1;color:var(--gold,#c8a24a)}
.wcz-qv-colors{display:flex;gap:7px;flex-wrap:wrap}
.wcz-qv-color{width:22px;height:22px;border-radius:50%;border:2px solid transparent;cursor:pointer;transition:box-shadow .15s,border-color .15s}
.wcz-qv-color.active{border-color:#fff;box-shadow:0 0 0 2px rgba(255,255,255,.35)}
.wcz-qv-sizes{display:flex;flex-wrap:wrap;gap:6px}
.wcz-qv-size{font-family:var(--mono,"DM Mono",monospace);font-size:.65rem;letter-spacing:.06em;padding:6px 14px;border:1px solid rgba(255,255,255,.2);border-radius:2px;cursor:pointer;transition:border-color .15s,background .15s,color .15s}
.wcz-qv-size:hover{border-color:rgba(255,255,255,.5)}
.wcz-qv-size.active{border-color:var(--gold,#c8a24a);color:var(--gold,#c8a24a);background:rgba(200,162,74,.08)}
.wcz-qv-size.out{opacity:.35;cursor:not-allowed;text-decoration:line-through}
.wcz-qv-qty-row{display:flex;align-items:center;gap:12px}
.wcz-qv-qty-btn{width:32px;height:32px;border:1px solid rgba(255,255,255,.2);border-radius:2px;font-size:1.1rem;display:flex;align-items:center;justify-content:center;transition:background .15s}
.wcz-qv-qty-btn:hover{background:rgba(255,255,255,.1)}
.wcz-qv-qty-val{font-family:var(--mono,"DM Mono",monospace);font-size:1rem;min-width:24px;text-align:center}
.wcz-qv-details{display:flex;flex-direction:column;gap:4px;list-style:none;padding:0;margin:0}
.wcz-qv-detail-item{font-size:.88rem;opacity:.7;line-height:1.6;padding-left:14px;position:relative}
.wcz-qv-detail-item::before{content:'--';position:absolute;left:0;opacity:.4}
.wcz-qv-specs-table{width:100%;border-collapse:collapse}
.wcz-spec-key{font-family:var(--mono,"DM Mono",monospace);font-size:.7rem;letter-spacing:.06em;text-transform:uppercase;opacity:.45;padding:6px 12px 6px 0;white-space:nowrap;vertical-align:top;width:40%}
.wcz-spec-val{font-size:.88rem;opacity:.75;padding:6px 0;line-height:1.5}
.wcz-qv-related{display:grid;grid-template-columns:repeat(3,1fr);gap:8px}
.wcz-related-card{cursor:pointer;border-radius:4px;overflow:hidden;background:var(--ink3,#2a2a2a);transition:opacity .2s}
.wcz-related-card:hover{opacity:.85}
.wcz-related-card img{width:100%;aspect-ratio:3/4;object-fit:cover;display:block}
.wcz-related-ph{width:100%;aspect-ratio:3/4;background:var(--ink3,#2a2a2a)}
.wcz-related-name{font-size:.7rem;padding:5px 7px 2px;opacity:.75;line-height:1.3;font-family:var(--mono,"DM Mono",monospace)}
.wcz-related-price{font-size:.68rem;padding:0 7px 7px;opacity:.5;font-family:var(--mono,"DM Mono",monospace)}
.wcz-qv-warranty{font-size:.88rem;opacity:.65;line-height:1.6;padding:6px 10px;background:rgba(255,255,255,.05);border-radius:4px}
.wcz-qv-actions{display:flex;flex-direction:column;gap:10px;margin-top:auto;padding-top:24px}
.wcz-qv-btn-cart{display:flex;align-items:center;justify-content:center;gap:10px;padding:14px 20px;background:var(--ink,#0c0c0c);color:#fff;border-radius:2px;font-family:var(--mono,"DM Mono",monospace);font-size:.72rem;letter-spacing:.1em;text-transform:uppercase;font-weight:600;transition:background .2s;border:none;cursor:pointer;width:100%}
.wcz-qv-btn-cart:hover{background:var(--gold,#c8a24a);color:var(--ink,#0c0c0c)}
.wcz-qv-btn-buynow{display:flex;align-items:center;justify-content:center;gap:8px;padding:11px 20px;background:#25D366;color:#fff;border-radius:2px;font-family:var(--mono,"DM Mono",monospace);font-size:.7rem;letter-spacing:.08em;text-transform:uppercase;font-weight:600;transition:background .2s}
.wcz-qv-btn-buynow:hover{background:#1fb357}
.wcz-qv-note{font-size:.72rem;opacity:.35;text-align:center;margin-top:12px;line-height:1.5}
#wcz-lb{display:none;position:fixed;inset:0;z-index:210;background:rgba(0,0,0,.96);flex-direction:column;align-items:center;justify-content:center}
#wcz-lb.open{display:flex}
.wcz-lb-close{position:absolute;top:18px;right:22px;font-size:1.6rem;opacity:.5;cursor:pointer;transition:opacity .2s;background:none;border:none;color:#fff;font-family:inherit}
.wcz-lb-close:hover{opacity:1}
.wcz-lb-arr{position:absolute;top:50%;transform:translateY(-50%);font-size:2.2rem;opacity:.4;cursor:pointer;padding:16px;background:none;border:none;color:#fff;transition:opacity .2s}
.wcz-lb-arr:hover{opacity:1}
.wcz-lb-prev{left:8px}.wcz-lb-next{right:8px}
.wcz-lb-stage{max-height:82vh;max-width:88vw;display:flex;align-items:center;justify-content:center}
.wcz-lb-stage img{max-height:82vh;max-width:88vw;object-fit:contain;border-radius:2px}
.wcz-lb-footer{display:flex;flex-direction:column;align-items:center;gap:10px;margin-top:14px}
.wcz-lb-thumbs{display:flex;gap:6px;flex-wrap:wrap;justify-content:center;max-width:480px}
.wcz-lb-thumb{width:48px;height:48px;object-fit:cover;border-radius:2px;cursor:pointer;opacity:.5;border:1.5px solid transparent;transition:opacity .15s,border-color .15s}
.wcz-lb-thumb.active,.wcz-lb-thumb:hover{opacity:1;border-color:var(--gold,#c8a24a)}
.wcz-lb-count{font-family:var(--mono,"DM Mono",monospace);font-size:.62rem;letter-spacing:.1em;opacity:.4}
#wcz-lb-overlay{display:none;position:fixed;inset:0;z-index:209;background:transparent}
#wcz-lb-overlay.open{display:block}
.wcz-order-fab{position:fixed;bottom:1.5rem;left:1.5rem;z-index:950;display:none;align-items:center;gap:.5rem;background:var(--ink,#0c0c0c);color:#fff;border-radius:999px;padding:.68rem 1.2rem;font-weight:700;font-size:.83rem;box-shadow:0 8px 24px rgba(0,0,0,.4);cursor:pointer;transition:transform .2s,background .2s;border:none;font-family:inherit}
.wcz-order-fab:hover{transform:translateY(-2px)}
.wcz-order-count{background:var(--gold,#c8a24a);color:var(--ink,#0c0c0c);border-radius:50%;width:20px;height:20px;display:inline-flex;align-items:center;justify-content:center;font-size:.7rem;font-weight:800}
.wcz-order-panel{position:fixed;bottom:0;right:0;z-index:1100;width:min(400px,100%);max-height:85vh;background:#fff;color:#111;border-radius:12px 0 0 0;box-shadow:0 -8px 40px rgba(0,0,0,.2);transform:translateY(110%);transition:transform .35s ease;display:flex;flex-direction:column}
.wcz-order-panel.open{transform:translateY(0)}
.wcz-order-hdr{background:var(--ink,#0c0c0c);color:#fff;padding:.9rem 1.2rem;display:flex;justify-content:space-between;align-items:center;font-weight:700;font-size:.95rem;border-radius:12px 0 0 0;flex-shrink:0}
.wcz-order-hdr-close{color:#fff;background:rgba(255,255,255,.15);width:28px;height:28px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:.85rem;border:none;cursor:pointer}
.wcz-order-items{padding:.88rem 1.2rem;overflow-y:auto;flex:1}
.wcz-order-row{display:flex;justify-content:space-between;align-items:center;gap:.7rem;padding:.5rem 0;border-bottom:1px solid rgba(0,0,0,.07)}
.wcz-order-row:last-child{border-bottom:none}
.wcz-order-row-info{flex:1;min-width:0}
.wcz-order-row-name{font-weight:600;font-size:.85rem;display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.wcz-order-row-meta{display:flex;gap:6px;margin-top:2px;flex-wrap:wrap}
.wcz-order-meta{font-size:.72rem;background:rgba(0,0,0,.06);padding:2px 7px;border-radius:4px;color:rgba(0,0,0,.6)}
.wcz-order-row-price{font-size:.8rem;color:rgba(0,0,0,.45);display:block;margin-top:2px}
.wcz-order-qty{display:flex;align-items:center;gap:.35rem;flex-shrink:0}
.wcz-order-qty button{width:24px;height:24px;border-radius:50%;border:1px solid rgba(0,0,0,.15);font-weight:700;font-size:.8rem;cursor:pointer;background:#fff;display:flex;align-items:center;justify-content:center}
.wcz-order-qty span{font-size:.85rem;font-weight:600;min-width:18px;text-align:center}
.wcz-order-empty{text-align:center;opacity:.35;padding:2.5rem 0;font-size:.85rem;line-height:1.6}
.wcz-order-total{padding:.75rem 1.2rem;font-weight:800;border-top:2px solid var(--gold,#c8a24a);display:flex;justify-content:space-between;font-size:.95rem;background:rgba(200,162,74,.06);flex-shrink:0}
.wcz-order-actions{padding:.8rem 1.2rem 1.2rem;display:flex;gap:.5rem;flex-shrink:0}
.wcz-order-clear{flex-shrink:0;font-size:.75rem;opacity:.55;background:rgba(0,0,0,.06);border-radius:999px;padding:.42rem .9rem;border:none;cursor:pointer;font-family:inherit}
.wcz-order-clear:hover{opacity:.9}
.wcz-order-send{flex:1;text-align:center;background:#25D366;color:#fff;border-radius:999px;padding:.65rem 1rem;font-weight:700;font-size:.83rem;text-decoration:none;display:block;transition:background .2s}
.wcz-order-send:hover{background:#1fb357}
.wcz-nav-cart-active{background:var(--gold,#c8a24a)!important;color:var(--ink,#0c0c0c)!important;border-color:var(--gold,#c8a24a)!important}
.wcz-nav-cart-count{background:rgba(0,0,0,.2);border-radius:50%;width:18px;height:18px;display:inline-flex;align-items:center;justify-content:center;font-size:.68rem;font-weight:800;margin-left:4px;vertical-align:middle}
.wcz-wa-fab{position:fixed;bottom:1.5rem;right:1.5rem;z-index:900;width:54px;height:54px;border-radius:50%;background:#25D366;display:flex;align-items:center;justify-content:center;box-shadow:0 4px 20px rgba(37,211,102,.4);opacity:0;transform:scale(.85);transition:opacity .3s,transform .3s;pointer-events:none}
.wcz-wa-fab.wcz-wa-fab-visible{opacity:1;transform:scale(1);pointer-events:auto}
.wcz-wa-fab:hover{transform:scale(1.08)!important;box-shadow:0 6px 28px rgba(37,211,102,.55)}
.wcz-wa-fab-pulse{position:absolute;inset:0;border-radius:50%;border:2px solid #25D366;animation:wcz-fabpulse 2s infinite}
@keyframes wcz-fabpulse{0%{transform:scale(1);opacity:.8}100%{transform:scale(1.8);opacity:0}}
.wcz-add-btn{width:100%;margin-top:10px;padding:8px 12px;font-size:.72rem;font-weight:700;letter-spacing:.06em;text-transform:uppercase;border-radius:2px;cursor:pointer;transition:background .2s,transform .15s;border:none;font-family:inherit;background:var(--gold,#c8a24a);color:var(--ink,#0c0c0c)}
.wcz-add-btn:hover{background:var(--gold2,#a87030);transform:translateY(-1px)}
.wcz-add-btn:disabled{background:var(--ink3,#2a2a2a);color:rgba(255,255,255,.3);cursor:not-allowed;transform:none}
.wcz-order-panel .wcz-order-hdr button{color:#fff;background:rgba(255,255,255,.15);width:28px;height:28px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:.85rem;border:none;cursor:pointer}
</style>`;
}

// =============================================================================
// END UNIVERSAL COMMERCE SDK
// =============================================================================

// --- TEMPLATE EXTRAS ---------------------------------------------------------

// Template IDs that render products via the Universal Commerce SDK
const STORE_TEMPLATE_IDS = new Set([
  'beauty-salon',
  'school-institution', 'school', 'church', 'sports',
  'boutique-fashion', 'boutique', 'fashion',
  'fashion-retail',
  'grocery-fmcg', 'grocery',
  'hardware-store', 'hardware', 'retail-hardware',
]);

async function buildTemplateExtras(c, site, config, env) {
  const extras = {};

  const templateId = site.template_id;

  // Single addon check per render
  const whatsappStoreActive = STORE_TEMPLATE_IDS.has(templateId) ?
    await checkAddonActive(env, site.id, 'whatsapp_store') :
    true;

  const phone = c.phone || c.contact?.phone || '';
  if (phone) {
    const digits = phone.replace(/\D/g, '');
    const num = digits.startsWith('263') ? digits : '263' + digits.replace(/^0/, '');
    extras.wa_href_general = `https://wa.me/${num}?text=${encodeURIComponent('Hello, I found you on websites.co.zw!')}`;
    extras.wa_href_consult = `https://wa.me/${num}?text=${encodeURIComponent('Hello, I would like to book a consultation.')}`;
    extras.wa_href_order = `https://wa.me/${num}?text=${encodeURIComponent('Hello, I would like to place an order.')}`;
    extras.wa_href_enquiry = `https://wa.me/${num}?text=${encodeURIComponent('Hello, I would like to make an enquiry.')}`;
    extras.wa_href_booking = `https://wa.me/${num}?text=${encodeURIComponent('Hello, I would like to book an appointment.')}`;
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

  // -- ADVISORY-FIRM ----------------------------------------------------------
  if (templateId === 'advisory-firm' || templateId === 'consultant') {
    const rawSvcs = Array.isArray(c.services) ? c.services : [];
    const { sorted: sortedSvcs, hasFeatured: hasFeatSvc } = extractFeatured(rawSvcs);

    c.services = sortedSvcs;
    extras.has_featured_service = hasFeatSvc ? 'true' : '';

    const svcTitles = sortedSvcs.slice(0, 4).map(s => s.title || s.name || '').filter(Boolean);
    const points = svcTitles.length >= 2 ? svcTitles : [
      'Partner-led -- you work directly with experienced advisors',
      'Practical advice grounded in local law and regulation',
      'Reachable on WhatsApp -- we respond same business day',
      'Fixed, transparent fees with no hidden charges',
    ];
    extras.service_points_html = points
      .map(p => `<div class="band-point"><div class="band-point-icon"><svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg></div><span>${esc(p)}</span></div>`)
      .join('');

    if (sortedSvcs.length) {
      const DEFAULT_ICONS = [
        `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>`,
        `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 8v4l3 3"/></svg>`,
        `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/></svg>`,
        `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>`,
        `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></svg>`,
        `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>`,
      ];
      extras.services_html = sortedSvcs.map((s, i) => {
        const isFeat = hasFeatSvc && i === 0;
        const tag = (s.tag || s.badge || '').trim();
        const name = esc(s.name || s.title || '');
        const body = esc(s.body || s.description || '');
        const iconRaw = s.icon_html || s.icon || '';
        const iconEl = iconRaw || DEFAULT_ICONS[i % DEFAULT_ICONS.length];
        const badge = isFeat ? featBadgeHtml(tag) : '';
        const hlClass = isFeat ? ' highlighted' : '';
        return `<div class="service-card${hlClass}" style="position:relative">${badge}<div class="service-icon">${iconEl}</div><h3>${name}</h3><p>${body}</p></div>`;
      }).join('');
    }

    // Advisory firm page copy fields
    extras.services_eyebrow = c.services_eyebrow || 'What we do';
    extras.services_heading = c.services_heading || 'Our services';
    extras.services_intro = c.services_intro || 'Clear guidance and dependable expertise, tailored to what you need.';
    extras.team_subtext = c.team_subtext || "You work directly with our team — never passed to someone unfamiliar with your case.";
    extras.why_heading = c.why_heading || 'Here to help, every step of the way.';
    extras.contact_heading = c.contact_heading || "Let's talk about what you need.";
    extras.contact_intro = c.contact_intro || 'Book a free initial consultation. Tell us where you are and what you need.';

    // Bookable services
    const bookableServices = Array.isArray(c.booking_services) ? c.booking_services : [];
    const syncedBookableServices = bookableServices.filter(s => s && s.service_id);

    extras.bookable_services_html = syncedBookableServices.map(s => {
      const svcName = esc(s.name || '');
      const svcPrice = s.price ? esc(String(s.price)) : '';
      const svcDuration = parseInt(s.duration_min, 10) || 30;
      const staffMode = s.staff_mode === 'any' ? 'any' : 'choose';
      return `<div class="service-card">
        <div class="service-icon">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>
        </div>
        <h3>${svcName}</h3>
        <p>${svcDuration} min${svcPrice ? ` &middot; ${svcPrice}` : ''}</p>
        <button type="button" class="btn-outline wcz-slot-book-trigger" style="margin-top:14px;width:100%;justify-content:center" data-service-id="${esc(s.service_id)}" data-service-name="${svcName}" data-duration-min="${svcDuration}" data-price="${svcPrice}" data-staff-mode="${staffMode}">Book</button>
      </div>`;
    }).join('');

    extras.has_bookable_services = syncedBookableServices.length > 0 ? 'true' : '';
  }

  // -- PROPERTY-ESTATE --------------------------------------------------------
  if (templateId === 'property-estate' || templateId === 'realestate') {
    const rawListings = Array.isArray(c.listings) ? c.listings : [];
    const { sorted: sortedListings, hasFeatured: hasFeatListing } = extractFeatured(rawListings);

    extras.sell_heading = c.sell_heading || "Selling or renting out? Let's list it.";
    extras.sell_body = c.sell_body || c.tagline || 'Professional photos, local reach and honest valuations -- your property in front of serious buyers.';
    extras.has_featured_listing = hasFeatListing ? 'true' : '';

    if (sortedListings.length) {
      const WA_SVG = `<svg viewBox="0 0 24 24" width="16" height="16" fill="#fff" stroke="none"><path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 0 1-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 0 1-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 0 1 2.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0 0 12.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 0 0 5.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 0 0-3.48-8.413Z"/></svg>`;
      const SVG_BED = `<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M2 4v16"/><path d="M2 8h18a2 2 0 0 1 2 2v10"/><path d="M2 17h20"/><path d="M6 8v9"/></svg>`;
      const SVG_BATH = `<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6 6.5 3.5a1.5 1.5 0 0 0-1-.5C4.683 3 4 3.683 4 4.5V17a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-5"/><line x1="3" y1="13" x2="21" y2="13"/></svg>`;
      const SVG_SIZE = `<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21.3 15.3a2.4 2.4 0 0 1 0 3.4l-2.6 2.6a2.4 2.4 0 0 1-3.4 0L2.7 8.7a2.4 2.4 0 0 1 0-3.4l2.6-2.6a2.4 2.4 0 0 1 3.4 0Z"/><path d="m14.5 12.5 2-2"/><path d="m11.5 9.5 2-2"/><path d="m8.5 6.5 2-2"/><path d="m17.5 15.5 2-2"/></svg>`;

      extras.listings_html = sortedListings.map((l, li) => {
        const isFeat = hasFeatListing && li === 0;
        const featTag = (l.tag || l.badge || '').trim();
        const type = (l.type || 'For Sale').toLowerCase();
        const badgeClass = type.includes('rent') || type.includes('let') ? 'badge-rent' :
          type.includes('sold') ? 'badge-sold' : 'badge-sale';
        const typeLabel = l.type || 'For Sale';
        const hlClass = isFeat ? ' highlighted' : '';
        const featBadge = isFeat && featTag ? featBadgeHtml(featTag) : '';

        const rawPhone = (l.agent_phone || l.phone || c.phone || '').replace(/\D/g, '');
        const waPhone = rawPhone.startsWith('263') ? rawPhone : rawPhone ? '263' + rawPhone.replace(/^0/, '') : '';
        const propMsg = encodeURIComponent(`Hello, I'm interested in: ${l.name || l.title || 'the property'} - ${l.price || ''}. Please send more details.`);
        const waLink = waPhone ? `https://wa.me/${waPhone}?text=${propMsg}` : '#';

        const features = [];
        if (l.beds) features.push(`<span>${SVG_BED}${l.beds} bed${l.beds == 1 ? '' : 's'}</span>`);
        if (l.bathrooms) features.push(`<span>${SVG_BATH}${l.bathrooms} bath${l.bathrooms == 1 ? '' : 's'}</span>`);
        if (l.size) features.push(`<span>${SVG_SIZE}${esc(String(l.size))}</span>`);
        const featuresHtml = features.join('');

        const photos = Array.isArray(l.photos) && l.photos.length ? l.photos : l.photo ? [l.photo] : [];
        let photoHtml = '';
        if (photos.length === 0) {
          photoHtml = `<div class="prop-photo-ph"><svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="m3 9 3-3 4 4 4-4 4 4"/><circle cx="7.5" cy="7.5" r="1"/></svg></div>`;
        } else if (photos.length === 1) {
          photoHtml = `<img src="${esc(photos[0])}" alt="${esc(l.name || 'Property')}" loading="lazy">`;
        } else {
          const sid = `slider-${li}`;
          const imgs = photos.map((u, pi) => `<img class="pslide" src="${esc(u)}" alt="${esc((l.name || 'Property') + ' photo ' + (pi + 1))}" loading="lazy" style="${pi === 0 ? '' : 'display:none'}">`).join('');
          photoHtml = `<div class="prop-slider" id="${sid}" data-idx="0">${imgs}<button class="ps-btn ps-prev" onclick="propSlide('${sid}',-1)" aria-label="Previous">&lsaquo;</button><button class="ps-btn ps-next" onclick="propSlide('${sid}',1)" aria-label="Next">&rsaquo;</button><div class="ps-dots">${photos.map((_, pi) => `<span class="ps-dot${pi === 0 ? ' active' : ''}" onclick="propSlideTo('${sid}',${pi})"></span>`).join('')}</div></div>`;
        }

        const addr = esc(l.address || l.location || l.name || '');
        const desc = esc(l.description || l.body || '');
        const price = esc(l.price || '');
        const name = esc(l.name || l.title || '');

        return `<div class="prop-card${hlClass}">
  <div class="prop-photo" style="position:relative">
    ${photoHtml}
    <span class="prop-badge ${badgeClass}">${esc(typeLabel)}</span>
    ${featBadge}
  </div>
  <div class="prop-body">
    ${price ? `<div class="prop-price">${price}</div>` : ''}
    ${name ? `<div class="prop-name">${name}</div>` : ''}
    ${addr ? `<div class="prop-loc">${addr}</div>` : ''}
    ${desc ? `<div class="prop-desc">${desc}</div>` : ''}
    ${featuresHtml ? `<div class="prop-features">${featuresHtml}</div>` : ''}
    <div class="prop-actions">
      <a href="${waLink}" class="enq-btn" target="_blank" rel="noopener">Enquire</a>
      <a href="${waLink}" class="enq-wa" target="_blank" rel="noopener" aria-label="WhatsApp">${WA_SVG}</a>
    </div>
  </div>
</div>`;
      }).join('');
    }
  }

  // -- GRILL-HOUSE ------------------------------------------------------------
  if (templateId === 'grill-house' || templateId === 'restaurant') {
    const ghTheme = c.theme || {};
    const ghPalette = resolvePalette(ghTheme.palette || 'ember-cream', ghTheme.custom_accent || '');
    const grillConfig = Object.assign({}, config, {
      paletteTokens: { ember_color: ghPalette.accent1, amber_color: ghPalette.accent2 },
      defaultPrimaryColor: ghPalette.primary,
    });
    Object.assign(extras, buildGrillExtras(c, grillConfig));
    extras.primary_color = ghPalette.primary;

    const rawPhone = (c.phone || c.contact?.phone || '').replace(/\D/g, '');
    extras.whatsapp_clean = rawPhone.startsWith('263') ? rawPhone : rawPhone ? '263' + rawPhone.replace(/^0/, '') : '';
  }

  // -- BEAUTY-SALON -----------------------------------------------------------
  if (templateId === 'beauty-salon') {
    const svcs = Array.isArray(c.services) ? c.services : [];

    const isOldGrouped = svcs.length > 0 && Array.isArray(svcs[0].items);
    const hasCategories = !isOldGrouped && svcs.some(s => s.category && s.category.trim());

    let grouped = [];
    if (isOldGrouped) {
      grouped = svcs;
    } else if (hasCategories) {
      const catMap = new Map();
      svcs.forEach(item => {
        const cat = (item.category || '').trim() || 'Services';
        if (!catMap.has(cat)) catMap.set(cat, []);
        catMap.get(cat).push(item);
      });
      catMap.forEach((items, category) => grouped.push({ category, items }));
    }

    function renderSvcItem(item, isFeatured) {
      const name = esc(item.name || item.title || '');
      const desc = esc(item.description || item.body || '');
      const price = esc(item.price || '');
      const photo = item.photo || item.image || '';
      const tag = (item.tag || item.badge || '').trim();
      const badge = isFeatured && tag ? featBadgeHtml(tag) : '';
      const hlCls = isFeatured ? ' highlighted' : '';
      return `<div class="svc-item${hlCls}" style="position:relative">${badge}
        ${photo ? `<img class="svc-photo" src="${esc(photo)}" alt="${name}" loading="lazy">` : ''}
        <div class="svc-item-body">
          <div class="svc-name">${name}</div>
          ${desc ? `<div class="svc-desc">${desc}</div>` : ''}
        </div>
        ${price ? `<div class="svc-price">${price}</div>` : ''}
      </div>`;
    }

    if (grouped.length > 0) {
      const tabs = grouped.map((cat, ci) => {
        const catId = 'cat' + ci;
        const activeClass = ci === 0 ? ' active' : '';
        return `<button class="svc-tab${activeClass}" data-cat="${catId}" onclick="switchTab('${catId}')">${esc(cat.category || cat.name || 'Services')}</button>`;
      }).join('');

      const panels = grouped.map((cat, ci) => {
        const catId = 'cat' + ci;
        const activeClass = ci === 0 ? ' active' : '';
        const rawItems = Array.isArray(cat.items) ? cat.items : [];
        const { sorted: sortedItems, hasFeatured } = extractFeatured(rawItems);
        const rows = sortedItems.map((item, i) => renderSvcItem(item, hasFeatured && i === 0)).join('');
        const panelClass = `svc-panel${activeClass}${hasFeatured ? ' has-featured' : ''}`;
        return `<div class="${panelClass}" id="svc-${catId}">${rows}</div>`;
      }).join('');

      extras.services_html = `<div class="svc-tabs">${tabs}</div>${panels}`;
    } else if (svcs.length > 0) {
      const { sorted: sortedSvcs, hasFeatured } = extractFeatured(svcs);
      const rows = sortedSvcs.map((item, i) => renderSvcItem(item, hasFeatured && i === 0)).join('');
      extras.services_html = `<div class="svc-flat${hasFeatured ? ' has-featured' : ''}">${rows}</div>`;
    } else {
      extras.services_html = '';
    }

    // Real bookable services
    const bookableServices = Array.isArray(c.booking_services) ? c.booking_services : [];
    const syncedBookableServices = bookableServices.filter(s => s && s.service_id);

    extras.bookable_services_html = syncedBookableServices.map(s => {
      const svcName = esc(s.name || '');
      const svcPrice = s.price ? esc(String(s.price)) : '';
      const svcDuration = parseInt(s.duration_min, 10) || 30;
      const staffMode = s.staff_mode === 'any' ? 'any' : 'choose';
      return `<div class="svc-item">
        <div class="svc-item-body">
          <div class="svc-name">${svcName}</div>
          <div class="svc-desc">${svcDuration} min</div>
        </div>
        ${svcPrice ? `<div class="svc-price">${svcPrice}</div>` : ''}
        <button type="button" class="wcz-slot-book-trigger wcz-slot-book-standalone" data-service-id="${esc(s.service_id)}" data-service-name="${svcName}" data-duration-min="${svcDuration}" data-price="${svcPrice}" data-staff-mode="${staffMode}">Book</button>
      </div>`;
    }).join('');

    extras.has_bookable_services = syncedBookableServices.length > 0 ? 'true' : '';

    const gallery = Array.isArray(c.gallery) ? c.gallery : [];
    extras.gallery_html = gallery.map((url, gi) =>
      `<img src="${esc(typeof url === 'string' ? url : url.url || '')}" alt="Gallery photo ${gi + 1}" loading="lazy">`
    ).join('');

    const teamMembers = Array.isArray(c.team) ? c.team : [];
    extras.team_html = teamMembers.map(member => {
      const name = esc(member.name || member.title || '');
      const role = esc(member.role || member.description || member.body || '');
      const bio = esc(member.bio || '');
      const photo = member.photo || member.image_url || '';
      const photoEl = photo ?
        `<img class="team-photo" src="${esc(photo)}" alt="${name}" loading="lazy">` :
        `<div class="team-photo-placeholder"><svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="#C96A7E" stroke-width="1.5"><circle cx="12" cy="8" r="4"/><path d="M4 20c0-4 3.6-7 8-7s8 3 8 7"/></svg></div>`;
      return `<div class="team-card">
        ${photoEl}
        <div class="team-name">${name}</div>
        ${role ? `<div class="team-role">${role}</div>` : ''}
        ${bio ? `<div class="team-bio">${bio}</div>` : ''}
      </div>`;
    }).join('');

    extras.hours_html = c.hours ? buildHoursGridHtml(c.hours) : '';
    const logoUrl = c.images?.logo || c.logo_url || '';
    extras.logo_img = logoUrl ? `<img class="logo-img" src="${esc(logoUrl)}" alt="${esc(c.name || 'Logo')}">` : '';
    const rawPhone = (c.phone || c.contact?.phone || '').replace(/\D/g, '');
    extras.wa_phone = rawPhone.startsWith('263') ? rawPhone : rawPhone ? '263' + rawPhone.replace(/^0/, '') : '';
    extras.site_name = c.business_name || c.name || '';
    extras.tagline = c.tagline || '';
    extras.phone = c.phone || c.contact?.phone || '';
    extras.address = c.address || c.location || c.contact?.address || '';
    extras.hours_text = c.hours_text || '';
    extras.hero_image_url = c.hero_image_url || c.hero_image || c.images?.hero || '';
    extras.hero_eyebrow = c.hero_eyebrow || c.tagline || 'Hair . Nails . Skin';
    extras.hero_headline = c.hero_headline || 'Where you leave feeling beautiful.';
    extras.hero_subtext = c.hero_subtext || 'Expert stylists, honest prices, same-day bookings on WhatsApp.';
    extras.hero_badge = c.hero_badge || 'Walk-ins welcome . Mon-Sat';
    extras.services_intro = c.services_intro || 'Honest prices, no surprises. Walk-ins welcome when we have space.';
    extras.team_heading = c.team_heading || 'Meet the team';
    extras.team_subtext = c.team_subtext || 'Every stylist is trained, certified and passionate about their craft.';
    extras.cta_heading = c.cta_heading || 'Ready to treat yourself?';
    extras.cta_subtext = c.cta_subtext || "Book on WhatsApp and we'll confirm your slot right away.";
    extras.map_embed_url = c.map_embed_url || c.contact?.map_embed_url || '';
    extras.primary_color = c.primary_color || c.theme?.accent || '#C96A7E';
    extras.has_gallery = gallery.length > 0 ? 'true' : '';
    extras.has_team = teamMembers.length > 0 ? 'true' : '';
    extras.has_map = extras.map_embed_url ? 'true' : '';

    // Shop / Products
    const shopProducts = Array.isArray(c.products) ? c.products : [];
    const hasShop = shopProducts.length > 0;
    extras.show_shop = hasShop ? 'true' : '';

    if (hasShop) {
      const shopCtx = {
        waNum: extras.wa_phone || '',
        bizName: c.business_name || c.name || '',
        addonActive: whatsappStoreActive
      };

      const commerce = env && env.COMMERCE_SDK ?
        await callCommerceSDK(env, shopProducts, templateId, c.theme || {}, shopCtx) :
        buildCommerceModule(shopProducts, templateId, c.theme || {}, shopCtx);

      extras.bs_shop_products_html = commerce.gridHtml;
      extras.bs_shop_filters_html = commerce.filterHtml;
      extras.wcz_qv_drawer_html = commerce.drawerHtml;
      extras.wcz_lb_html = commerce.lbHtml;
      extras.wcz_products_script = commerce.scriptHtml;
      extras.wcz_commerce_css = env && env.COMMERCE_SDK ?
        await callCommerceCSS(env) :
        buildCommerceCSS();
    } else {
      extras.bs_shop_products_html = '';
      extras.bs_shop_filters_html = '';
    }
  }

  // -- SCHOOL-INSTITUTION -----------------------------------------------------
  if (
    templateId === 'school-institution' ||
    templateId === 'school' ||
    templateId === 'sports'
  ) {
    const theme = c.theme || {};
    const sections = Array.isArray(theme.sections) ? theme.sections :
      ['hero', 'about', 'programmes', 'team', 'events', 'gallery', 'testimonials', 'contact'];

    extras.stat_1_number = c.stat_1_number || c.students_count || '1 000';
    extras.stat_1_label = c.stat_1_label || 'Students Enrolled';
    extras.stat_2_number = c.stat_2_number || c.pass_rate || '98%';
    extras.stat_2_label = c.stat_2_label || 'Pass Rate';
    extras.stat_3_number = c.stat_3_number || c.years_open || '20';
    extras.stat_3_label = c.stat_3_label || 'Years of Excellence';
    extras.stat_4_number = c.stat_4_number || c.staff_count || '80';
    extras.stat_4_label = c.stat_4_label || 'Teaching Staff';

    extras.show_stats = 'true';
    extras.show_programmes = (sections.includes('services') || sections.includes('programmes') || sections.includes('menu')) ? 'true' : '';
    extras.show_team = sections.includes('team') ? 'true' : '';
    extras.show_events = (sections.includes('events') || sections.includes('products')) ? 'true' : '';
    extras.show_gallery = sections.includes('gallery') ? 'true' : '';
    extras.show_testimonials = sections.includes('testimonials') ? 'true' : '';

    // Shop / Products
    const shopProducts = Array.isArray(c.products) ? c.products : [];
    const hasShop = shopProducts.length > 0 && sections.includes('shop');
    extras.show_shop = hasShop ? 'true' : '';

    if (hasShop) {
      const rawPhone = (c.phone || c.contact?.phone || '').replace(/\D/g, '');
      const waNum = rawPhone.startsWith('263') ? rawPhone : rawPhone ? '263' + rawPhone.replace(/^0/, '') : '';
      const shopCtx = {
        waNum: waNum || '',
        bizName: c.business_name || c.name || '',
        addonActive: whatsappStoreActive
      };

      const commerce = env && env.COMMERCE_SDK ?
        await callCommerceSDK(env, shopProducts, templateId, c.theme || {}, shopCtx) :
        buildCommerceModule(shopProducts, templateId, c.theme || {}, shopCtx);

      extras.si_shop_products_html = commerce.gridHtml;
      extras.si_shop_filters_html = commerce.filterHtml;
      extras.wcz_qv_drawer_html = commerce.drawerHtml;
      extras.wcz_lb_html = commerce.lbHtml;
      extras.wcz_products_script = commerce.scriptHtml;
      extras.wcz_commerce_css = env && env.COMMERCE_SDK ?
        await callCommerceCSS(env) :
        buildCommerceCSS();
    } else {
      extras.si_shop_products_html = '';
      extras.si_shop_filters_html = '';
    }

    const _phone = c.phone || c.contact?.phone || '';
    const _email = c.email || c.contact?.email || '';
    const _address = c.address || c.location || c.contact?.address || '';
    const _wa = c.whatsapp || c.contact?.whatsapp || _phone;
    const _logo = c.images?.logo || c.logo_url || '';
    const _hero = c.images?.hero || c.hero_image_url || c.hero_image || '';

    extras.has_phone = _phone ? 'true' : '';
    extras.has_email = _email ? 'true' : '';
    extras.has_address = _address ? 'true' : '';
    extras.has_whatsapp = _wa ? 'true' : '';
    extras.has_logo = _logo ? 'true' : '';
    extras.has_hero = _hero ? 'true' : '';
    extras.has_facebook = c.facebook_url ? 'true' : '';
    extras.has_instagram = c.instagram_url ? 'true' : '';
    extras.has_twitter = c.twitter_url ? 'true' : '';

    extras.phone = _phone;
    extras.email = _email;
    extras.address = _address;
    extras.whatsapp = (() => { const d = _wa.replace(/\D/g, ''); return d.startsWith('263') ? d : d ? '263' + d.replace(/^0/, '') : ''; })();
    extras.logo_url = _logo;
    extras.hero_image_url = _hero;
    extras.facebook_url = c.facebook_url || '';
    extras.instagram_url = c.instagram_url || '';
    extras.twitter_url = c.twitter_url || '';

    const programmesHtml = buildSchoolProgrammesHtml(c);
    const teamHtml = buildSchoolTeamHtml(c);
    const eventsHtml = buildSchoolEventsHtml(c);
    const galleryHtml = buildSchoolGalleryHtml(c);
    const testiHtml = buildSchoolTestiHtml(c);

    extras.__inject_script = `<script>
(function(){
  function inj(id,h){var el=document.getElementById(id);if(el&&h)el.innerHTML=h;}
  inj('siProgrammes',${JSON.stringify(programmesHtml)});
  inj('siTeam',${JSON.stringify(teamHtml)});
  inj('siEvents',${JSON.stringify(eventsHtml)});
  inj('siGallery',${JSON.stringify(galleryHtml)});
  inj('siTestimonials',${JSON.stringify(testiHtml)});
})();
<\/script>`;
  }

  // -- BOUTIQUE-FASHION -------------------------------------------------------
  if (templateId === 'boutique-fashion' || templateId === 'boutique' || templateId === 'fashion') {
    const bSocials = c.socials || {};

    const bName = (c.business_name || c.name || '').trim();
    const bWords = bName.split(/\s+/);
    const bHalf = Math.ceil(bWords.length / 2);
    const line1 = bWords.slice(0, bHalf).join(' ');
    const line2 = bWords.slice(bHalf).join(' ');
    extras.bf_hero_headline_html = line2 ?
      `${esc(line1)}<br><em>${esc(line2)}</em>` :
      esc(line1);

    extras.facebook_url = bSocials.facebook || c.facebook_url || '';
    extras.instagram_url = bSocials.instagram || c.instagram_url || '';
    extras.tiktok_url = bSocials.tiktok || c.tiktok_url || '';
    extras.has_facebook = extras.facebook_url ? 'true' : '';
    extras.has_instagram = extras.instagram_url ? 'true' : '';
    extras.has_tiktok = extras.tiktok_url ? 'true' : '';
    extras.has_whatsapp_social = !!(bSocials.whatsapp || c.whatsapp_social) ? 'true' : '';

    extras.has_logo = (c.images?.logo || c.logo_url) ? 'true' : '';
    extras.logo_url = c.images?.logo || c.logo_url || '';
    extras.hero_image_url = c.images?.hero || c.hero_image_url || c.hero_image || '';

    const bGallery = Array.isArray(c.gallery) ? c.gallery : [];
    const bGal0 = bGallery[0];
    extras.gallery_0_url = typeof bGal0 === 'string' ? bGal0 : (bGal0?.url || bGal0?.src || '');

    extras.phone = c.phone || c.contact?.phone || '';
    extras.email = c.email || c.contact?.email || '';
    extras.address = c.address || c.location || c.contact?.address || '';

    const rawPhone = (c.phone || c.contact?.phone || '').replace(/\D/g, '');
    const waNum = rawPhone.startsWith('263') ? rawPhone : rawPhone ? '263' + rawPhone.replace(/^0/, '') : '';
    extras.whatsapp_clean = waNum;

    if (waNum) {
      extras.wa_href_general = `https://wa.me/${waNum}?text=${encodeURIComponent('Hello, I found you on websites.co.zw!')}`;
      extras.wa_href_order = `https://wa.me/${waNum}?text=${encodeURIComponent('Hello, I would like to place an order.')}`;
    } else {
      extras.wa_href_general = '#';
      extras.wa_href_order = '#';
    }

    const bServices = Array.isArray(c.services) ? c.services : [];
    const bProducts = Array.isArray(c.products) ? c.products : [];
    const bTestimonials = Array.isArray(c.testimonials) ? c.testimonials : [];
    extras.has_services = bServices.length ? 'true' : '';
    extras.has_products = bProducts.length ? 'true' : '';
    extras.has_gallery = bGallery.length ? 'true' : '';
    extras.has_testimonials = bTestimonials.length ? 'true' : '';
    extras.services_intro = c.services_intro || '';

    extras.bf_collections_html = bServices.map((s, i) => {
      const num = String(i + 1).padStart(2, '0');
      const name = esc(s.name || s.title || '');
      const body = esc(s.body || s.description || '');
      return `<div class="col-card reveal">
  <div class="col-num">${num}</div>
  <div class="col-name">${name}</div>
  ${body ? `<div class="col-body">${body}</div>` : ''}
</div>`;
    }).join('');

    const commerce = env && env.COMMERCE_SDK ?
      await callCommerceSDK(env, bProducts, 'boutique-fashion', c.theme || {}, { waNum, bizName: bName, addonActive: whatsappStoreActive }) :
      buildCommerceModule(bProducts, 'boutique-fashion', c.theme || {}, { waNum, bizName: bName, addonActive: whatsappStoreActive });
    extras.bf_products_html = commerce.gridHtml;
    extras.fr_category_filters_html = commerce.filterHtml;
    extras.wcz_qv_drawer_html = commerce.drawerHtml;
    extras.wcz_lb_html = commerce.lbHtml;
    extras.wcz_products_script = commerce.scriptHtml;
    extras.wcz_commerce_css = env && env.COMMERCE_SDK ?
      await callCommerceCSS(env) :
      buildCommerceCSS();

    extras.bf_gallery_html = bGallery.map((img) => {
      const src = typeof img === 'string' ? img : (img.url || img.src || '');
      const alt = typeof img === 'object' ? (img.alt || img.caption || '') : '';
      if (!src) return '';
      return `<div class="g-item"><img src="${esc(src)}" alt="${esc(alt)}" loading="lazy"></div>`;
    }).filter(Boolean).join('');

    const STAR_SVG = `<svg viewBox="0 0 24 24" width="13" height="13" fill="#c8a24a" stroke="none"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>`;
    extras.bf_testimonials_html = bTestimonials.map((t) => {
      const text = esc(t.text || t.quote || t.review || '');
      const name = esc(t.name || '');
      const role = esc(t.role || t.position || '');
      const photo = t.photo || t.avatar || '';
      const avatarEl = photo ?
        `<div class="testi-avatar"><img src="${esc(photo)}" alt="${name}" loading="lazy"></div>` :
        `<div class="testi-avatar">${name ? name.charAt(0).toUpperCase() : '?'}</div>`;
      return `<div class="testi-card reveal">
  <div class="testi-stars">${STAR_SVG.repeat(5)}</div>
  ${text ? `<p class="testi-text">"${text}"</p>` : ''}
  <div class="testi-author">
    ${avatarEl}
    <div>
      ${name ? `<div class="testi-name">${name}</div>` : ''}
      ${role ? `<div class="testi-role">${role}</div>` : ''}
    </div>
  </div>
</div>`;
    }).join('');
  }

  // -- FASHION-RETAIL ---------------------------------------------------------
  if (templateId === 'fashion-retail') {
    const frSocials = c.socials || {};

    extras.fr_announce = (c.deal?.text || c.badge) ? esc(c.deal?.text || c.badge) : '';

    extras.has_logo = (c.images?.logo || c.logo_url) ? 'true' : '';
    extras.logo_url = c.images?.logo || c.logo_url || '';
    extras.phone = c.phone || c.contact?.phone || '';
    extras.email = c.email || c.contact?.email || '';
    extras.address = c.address || c.location || c.contact?.address || '';

    const rawPhone = (c.phone || c.contact?.phone || '').replace(/\D/g, '');
    const waNum = rawPhone.startsWith('263') ? rawPhone : rawPhone ? '263' + rawPhone.replace(/^0/, '') : '';
    extras.whatsapp_clean = waNum;
    extras.wa_href_general = waNum ? `https://wa.me/${waNum}?text=${encodeURIComponent('Hello, I found you on websites.co.zw!')}` : '#';
    extras.wa_href_order = waNum ? `https://wa.me/${waNum}?text=${encodeURIComponent('Hello, I would like to place an order.')}` : '#';

    extras.instagram_url = frSocials.instagram || c.instagram_url || '';
    extras.facebook_url = frSocials.facebook || c.facebook_url || '';
    extras.has_instagram = extras.instagram_url ? 'true' : '';
    extras.has_facebook = extras.facebook_url ? 'true' : '';

    const frGallery = Array.isArray(c.gallery) ? c.gallery : [];
    const frGal0 = frGallery[0];
    extras.gallery_0_url = typeof frGal0 === 'string' ? frGal0 : (frGal0?.url || frGal0?.src || '');

    const frProducts = Array.isArray(c.products) ? c.products : [];
    const commerce = env && env.COMMERCE_SDK ?
      await callCommerceSDK(env, frProducts, templateId, c.theme || {}, { waNum, bizName: c.business_name || c.name || '', addonActive: whatsappStoreActive }) :
      buildCommerceModule(frProducts, templateId, c.theme || {}, { waNum, bizName: c.business_name || c.name || '', addonActive: whatsappStoreActive });

    extras.fr_products_html = commerce.gridHtml;
    extras.fr_category_filters_html = commerce.filterHtml;
    extras.wcz_qv_drawer_html = commerce.drawerHtml;
    extras.wcz_lb_html = commerce.lbHtml;
    extras.wcz_products_script = commerce.scriptHtml;
    extras.wcz_commerce_css = env && env.COMMERCE_SDK ?
      await callCommerceCSS(env) :
      buildCommerceCSS();
  }

  // -- GROCERY-STORE ------------------------------------------------------
  if (templateId === 'grocery-fmcg' || templateId === 'grocery') {
    const bizName = c.business_name || c.name || '';
    const rawPhone = (c.phone || c.contact?.phone || '').replace(/\D/g, '');
    const waNum = rawPhone.startsWith('263') ? rawPhone : rawPhone ? '263' + rawPhone.replace(/^0/, '') : '';

    extras.hero_eyebrow = c.hero_eyebrow || (c.location ? c.location + ' · Open Daily' : 'Open Daily');
    extras.hero_headline = c.hero_headline || 'Fresh today. Family priced.';
    extras.hero_subtext = c.hero_subtext || c.about || 'Vegetables, groceries and household essentials, stocked daily.';

    const products = Array.isArray(c.products) ? c.products : [];
    const cats = Array.isArray(c.categories) && c.categories.length ?
      c.categories :
      [...new Set(products.map(p => (p.category || '').trim()).filter(Boolean))];
    extras.has_categories = cats.length ? 'true' : '';
    extras.category_pills_html = cats.map((cat, i) =>
      `<button class="cat-pill${i === 0 ? ' on' : ''}" data-cat="${esc(cat)}">${esc(cat)}</button>`
    ).join('');

    const specials = Array.isArray(c.specials) ? c.specials : [];
    extras.has_specials = specials.length ? 'true' : '';
    extras.grocery_specials_html = specials.map(s => {
      const name = esc(s.name || '');
      const was = s.price_was ? `<div class="was">${esc(s.price_was)}</div>` : '';
      const now = esc(s.price_now || s.price || '');
      const unit = esc(s.unit || '');
      return `<div class="board-item"><div class="name">${name}</div>${was}<div class="now">${now}</div>${unit ? `<div class="unit">${unit}</div>` : ''}</div>`;
    }).join('');
    extras.specials_note = esc(c.specials_note || "Specials refresh regularly — WhatsApp us to reserve before they're gone.");

    extras.delivery_note = c.delivery_note || '';
    extras.delivery_areas = c.delivery_areas || '';
    extras.has_delivery = (c.delivery_note || c.delivery_areas) ? 'true' : '';

    const shopCtx = { waNum, bizName, addonActive: whatsappStoreActive };
    const commerce = env && env.COMMERCE_SDK ?
      await callCommerceSDK(env, products, templateId, c.theme || {}, shopCtx) :
      buildCommerceModule(products, templateId, c.theme || {}, shopCtx);

    extras.gs_products_html = commerce.gridHtml;
    extras.gs_category_filters_html = commerce.filterHtml;
    extras.wcz_qv_drawer_html = commerce.drawerHtml;
    extras.wcz_lb_html = commerce.lbHtml;
    extras.wcz_products_script = commerce.scriptHtml;
    extras.wcz_commerce_css = env && env.COMMERCE_SDK ?
      await callCommerceCSS(env) :
      buildCommerceCSS();

    extras.has_logo = (c.images?.logo || c.logo_url) ? 'true' : '';
  }

  // -- HARDWARE-STORE ------------------------------------------------------
  if (templateId === 'hardware-store' || templateId === 'hardware' || templateId === 'retail-hardware') {
    console.log('✅ Hardware template detected:', templateId);

    const bizName = c.business_name || c.name || '';
    const rawPhone = (c.phone || c.contact?.phone || '').replace(/\D/g, '');
    const waNum = rawPhone.startsWith('263') ? rawPhone : rawPhone ? '263' + rawPhone.replace(/^0/, '') : '';

    extras.hero_eyebrow = c.hero_eyebrow || 'Premium Hardware Solutions';
    extras.hero_headline = c.hero_headline || 'Quality Tools & Hardware';
    extras.hero_subtext = c.hero_subtext || c.about || 'Professional-grade hardware and tools for every project.';
    extras.hero_cta_label = c.hero_cta_label || 'Shop Now';
    extras.hero_secondary_label = c.hero_secondary_label || 'View Specials';

    extras.nav_shop_label = c.nav_shop_label || 'Shop';
    extras.nav_specials_label = c.nav_specials_label || 'Specials';
    extras.nav_about_label = c.nav_about_label || 'About';
    extras.nav_contact_label = c.nav_contact_label || 'Contact';
    extras.nav_cta_label = c.nav_cta_label || (config.navCtaLabel || 'Order Now');

    extras.topbar_left = c.topbar_left || (c.location ? c.location + ' · Premium Hardware Solutions' : 'Premium Hardware Solutions');

    extras.about_eyebrow = c.about_eyebrow || 'About Us';
    extras.about_heading = c.about_heading || (bizName ? 'About ' + bizName : 'About Us');
    extras.about_text = c.about || '';
    extras.about_image = c.about_image || c.hero_image || '';

    extras.products_heading = c.products_heading || 'Shop Our Range';

    extras.sort_featured = c.sort_featured || 'Featured';
    extras.sort_price_low = c.sort_price_low || 'Price: Low to High';
    extras.sort_price_high = c.sort_price_high || 'Price: High to Low';

    extras.hours_heading = c.hours_heading || 'Opening Hours';
    extras.location_heading = c.location_heading || 'Visit Us';
    extras.cta_heading = c.cta_heading || 'Order Online';
    extras.cta_subtext = c.cta_subtext || "Send your list, we'll confirm availability and delivery";
    extras.cta_button_label = c.cta_button_label || 'Order on WhatsApp';

    extras.footer_nav_title = c.footer_nav_title || 'Quick Links';
    extras.footer_contact_title = c.footer_contact_title || 'Contact';
    extras.footer_reserve_title = c.footer_reserve_title || 'Order';
    extras.footer_order_label = c.footer_order_label || 'Order Online';
    extras.footer_contact_label = c.footer_contact_label || 'Get in Touch';
    extras.footer_credit = c.footer_credit || 'Built with websites.co.zw';

    const initials = bizName.trim().split(/\s+/).map(w => w[0] || '').join('').toUpperCase().slice(0, 2);
    extras.logo_initials = initials || 'HW';

    extras.has_logo = (c.images?.logo || c.logo_url) ? 'true' : '';
    extras.has_facebook = c.facebook_url ? 'true' : '';
    extras.has_instagram = c.instagram_url ? 'true' : '';
    extras.has_twitter = c.twitter_url ? 'true' : '';
    extras.has_whatsapp = waNum ? 'true' : '';
    extras.has_specials = (Array.isArray(c.specials) && c.specials.length) ? 'true' : '';
    extras.has_hero = (c.images?.hero || c.hero_image_url || c.hero_image) ? 'true' : '';

    const products = Array.isArray(c.products) ? c.products : [];
    console.log('📦 Hardware products count:', products.length);

    const shopCtx = { waNum, bizName, addonActive: whatsappStoreActive };

    let commerce;
    try {
      if (env && env.COMMERCE_SDK) {
        commerce = await callCommerceSDK(env, products, templateId, c.theme || {}, shopCtx);
      } else {
        commerce = buildCommerceModule(products, templateId, c.theme || {}, shopCtx);
      }
    } catch (err) {
      console.error('❌ Commerce SDK error for hardware:', err);
      commerce = {
        gridHtml: '<p class="wcz-prod-empty">Error loading products. Please try again.</p>',
        filterHtml: '',
        drawerHtml: '',
        lbHtml: '',
        scriptHtml: ''
      };
    }

    extras.hw_products_html = commerce.gridHtml || '<p class="wcz-prod-empty">No products available.</p>';
    extras.hw_category_filters_html = commerce.filterHtml || '';
    extras.wcz_qv_drawer_html = commerce.drawerHtml || '';
    extras.wcz_lb_html = commerce.lbHtml || '';
    extras.wcz_products_script = commerce.scriptHtml || '';
    extras.wcz_commerce_css = env && env.COMMERCE_SDK ?
      await callCommerceCSS(env).catch(() => buildCommerceCSS()) :
      buildCommerceCSS();

    console.log('✅ hw_products_html length:', extras.hw_products_html ? extras.hw_products_html.length : 0);

    const specials = Array.isArray(c.specials) ? c.specials : [];
    extras.has_specials = specials.length ? 'true' : '';
    extras.specials_eyebrow = c.specials_eyebrow || 'Limited Time Offers';
    extras.specials_heading = c.specials_heading || 'Flash Sales & Deals';

    extras.hw_specials_html = specials.length ? specials.map(s => `
      <div class="special-card">
        <div class="special-badge">${esc(s.discount || s.badge || 'SALE')}</div>
        <h3>${esc(s.name || s.title || '')}</h3>
        <p>${esc(s.description || s.body || '')}</p>
        <a href="${extras.wa_href_order || '#'}" class="btn btn-primary" target="_blank" rel="noopener">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="9" cy="21" r="1"/><circle cx="20" cy="21" r="1"/><path d="M1 1h4l2.68 13.39a2 2 0 0 0 2 1.61h9.72a2 2 0 0 0 2-1.61L23 6H6"/></svg>
          Shop Now
        </a>
      </div>
    `).join('') : '';

    const stats = Array.isArray(c.stats) ? c.stats : [];
    extras.hw_stats_html = stats.slice(0, 3).map(s => `
      <div class="stat-item">
        <span class="stat-number">${esc(String(s.value || s.number || '0'))}${esc(String(s.suffix || ''))}</span>
        <span class="stat-label">${esc(s.label || '')}</span>
      </div>
    `).join('');

    if (!extras.hw_stats_html) {
      extras.hw_stats_html = `
        <div class="stat-item">
          <span class="stat-number">100+</span>
          <span class="stat-label">Products</span>
        </div>
        <div class="stat-item">
          <span class="stat-number">15+</span>
          <span class="stat-label">Years Experience</span>
        </div>
        <div class="stat-item">
          <span class="stat-number">500+</span>
          <span class="stat-label">Happy Customers</span>
        </div>
      `;
    }

    if (config.showOpenBadge && c.hours) {
      extras.open_badge_html = openClosedBadge(c.hours);
    }
    if (config.showHoursGrid && c.hours) {
      extras.hours_grid_html = buildHoursGridHtml(c.hours);
    }

    if (waNum) {
      extras.wa_href_order = `https://wa.me/${waNum}?text=${encodeURIComponent('Hello, I would like to place an order.')}`;
      extras.wa_href_general = `https://wa.me/${waNum}?text=${encodeURIComponent('Hello, I found you on websites.co.zw!')}`;
    } else {
      extras.wa_href_order = '#';
      extras.wa_href_general = '#';
    }
  }

  // -- HOSPITALITY-INN (Lodges, B&Bs, Hotels) ---------------------------------
  if (templateId === 'hospitality-inn' || templateId === 'hospitality-in' ||
    templateId === 'lodge' || templateId === 'lodges' ||
    templateId === 'hotel' || templateId === 'accommodation') {
    Object.assign(extras, buildHospitalityExtras(c, site, config));
  }

  // ── BOLD-RETAIL (General Business) ──────────────────────────────────────
  if (templateId === 'bold-retail' || templateId === 'retail' || templateId === 'general' || templateId === 'general-business') {
    const sectionOrder = (c.theme && Array.isArray(c.theme.sections)) ?
      c.theme.sections :
      ['hero', 'about', 'services', 'products', 'video', 'team', 'testimonials', 'gallery', 'contact'];

    const nameParts = (c.business_name || c.name || '').trim().split(/\s+/);
    const half = Math.ceil(nameParts.length / 2);
    const line1 = nameParts.slice(0, half).join(' ');
    const line2 = nameParts.slice(half).join(' ');
    extras.br_hero_headline_html = line2 ?
      `${esc(line1)}<br><em>${esc(line2)}</em>` :
      esc(line1 || 'Your Business');

    const brServices = Array.isArray(c.services) ? c.services : [];
    const hasServices = brServices.length > 0;
    extras.has_services = hasServices ? 'true' : '';
    extras.services_eyebrow = c.services_eyebrow || 'Services';
    extras.services_heading = c.services_heading || 'What we do';
    extras.services_intro = c.services_intro || '';

    const { sorted: sortedSvcs, hasFeatured: hasFeatSvc } = extractFeatured(brServices);
    extras.br_services_html = sortedSvcs.map((s, i) => {
      const isFeat = hasFeatSvc && i === 0;
      const tag = (s.tag || s.badge || '').trim();
      const badge = isFeat && tag ? featBadgeHtml(tag) : '';
      const hlCls = isFeat ? ' highlighted' : '';
      const name = esc(s.name || s.title || '');
      const note = esc(s.description || s.body || '');
      const cat = esc(s.category || '');
      const price = esc(s.price || '');
      return `<div class="ledger-row${hlCls}" style="position:relative">
        ${badge}
        <span class="ledger-num mono">${String(i + 1).padStart(2, '0')}</span>
        <span class="ledger-name">${name}</span>
        <span class="ledger-note">${note}${cat ? ` <span style="color:var(--ink3);font-size:.78rem">— ${cat}</span>` : ''}</span>
        <span class="ledger-tag">${price ? `<b>${price}</b>` : ''}</span>
      </div>`;
    }).join('');

    const brProducts = Array.isArray(c.products) ? c.products : [];
    const hasProducts = brProducts.length > 0;
    extras.has_products = hasProducts ? 'true' : '';

    if (hasProducts) {
      const rawPhone = (c.phone || c.contact?.phone || '').replace(/\D/g, '');
      const waNum = rawPhone.startsWith('263') ? rawPhone : rawPhone ? '263' + rawPhone.replace(/^0/, '') : '';
      const shopCtx = {
        waNum: waNum || '',
        bizName: c.business_name || c.name || '',
        addonActive: whatsappStoreActive
      };

      try {
        const commerce = env && env.COMMERCE_SDK ?
          await callCommerceSDK(env, brProducts, templateId, c.theme || {}, shopCtx) :
          buildCommerceModule(brProducts, templateId, c.theme || {}, shopCtx);

        extras.br_products_html = commerce.gridHtml || '<p class="wcz-prod-empty">No products available.</p>';
        extras.fr_category_filters_html = commerce.filterHtml || '';
        extras.wcz_qv_drawer_html = commerce.drawerHtml || '';
        extras.wcz_lb_html = commerce.lbHtml || '';
        extras.wcz_products_script = commerce.scriptHtml || '';
        extras.wcz_commerce_css = (env && env.COMMERCE_SDK) ?
          await callCommerceCSS(env).catch(() => buildCommerceCSS()) :
          buildCommerceCSS();
      } catch (err) {
        console.error('Commerce SDK error for bold-retail:', err);
        extras.br_products_html = '<p class="wcz-prod-empty">Error loading products.</p>';
        extras.fr_category_filters_html = '';
      }
    } else {
      extras.br_products_html = '<p class="wcz-prod-empty">No products listed yet.</p>';
      extras.fr_category_filters_html = '';
    }

    const brGallery = Array.isArray(c.gallery) ? c.gallery : [];
    const hasGallery = brGallery.length > 0;
    extras.has_gallery = hasGallery ? 'true' : '';
    extras.gallery_0_url = hasGallery ? (typeof brGallery[0] === 'string' ? brGallery[0] : (brGallery[0]?.url || brGallery[0]?.src || '')) : '';

    extras.br_gallery_html = brGallery.map(img => {
      const src = typeof img === 'string' ? img : (img.url || img.src || '');
      const alt = typeof img === 'object' ? (img.alt || img.caption || '') : '';
      if (!src) return '';
      return `<div class="g-item"><img src="${esc(src)}" alt="${esc(alt)}" loading="lazy"></div>`;
    }).filter(Boolean).join('');

    const brTeam = Array.isArray(c.team) ? c.team : [];
    const hasTeam = brTeam.length > 0;
    extras.has_team = hasTeam ? 'true' : '';
    extras.team_subtext = c.team_subtext || 'The people behind the work.';

    extras.br_team_html = brTeam.map(member => {
      const name = esc(member.name || member.title || '');
      const role = esc(member.role || member.position || '');
      const bio = esc(member.bio || member.description || '');
      const photo = member.photo || member.image_url || '';
      const photoEl = photo ?
        `<img src="${esc(photo)}" alt="${name}" loading="lazy">` :
        `<div style="width:100%;height:100%;background:var(--ink);display:flex;align-items:center;justify-content:center;font-size:2rem;color:rgba(255,255,255,.1)">?</div>`;
      return `<div class="team-card">
        <div class="team-photo">${photoEl}</div>
        <div class="team-info">
          <div class="team-name">${name}</div>
          ${role ? `<div class="team-role">${role}</div>` : ''}
          ${bio ? `<div class="team-bio">${bio}</div>` : ''}
        </div>
      </div>`;
    }).join('');

    const brTestimonials = Array.isArray(c.testimonials) ? c.testimonials : [];
    const hasTestimonials = brTestimonials.length > 0;
    extras.has_testimonials = hasTestimonials ? 'true' : '';

    const STAR_SVG = '<svg viewBox="0 0 24 24" width="13" height="13" fill="#2451ff" stroke="none"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>';

    extras.br_testimonials_html = brTestimonials.map(t => {
      const name = esc(t.name || t.author || '');
      const role = esc(t.role || t.position || '');
      const text = esc(t.text || t.quote || t.review || '');
      const photo = t.photo || t.avatar || '';
      const avatarEl = photo ?
        `<div class="testi-avatar"><img src="${esc(photo)}" alt="${name}" loading="lazy"></div>` :
        `<div class="testi-avatar">${name ? name.charAt(0).toUpperCase() : '?'}</div>`;
      const rating = Math.max(1, Math.min(5, parseInt(t.rating, 10) || 5));
      const stars = STAR_SVG.repeat(rating);
      return `<div class="testi-card">
        <div class="testi-mark">&ldquo;</div>
        <div style="display:flex;gap:2px;margin-bottom:12px">${stars}</div>
        <p class="testi-text">${text}</p>
        <div class="testi-author">
          ${avatarEl}
          <div>
            <div class="testi-name">${name}</div>
            ${role ? `<div class="testi-role">${role}</div>` : ''}
          </div>
        </div>
      </div>`;
    }).join('');

    const video = (c.video && typeof c.video === 'object') ? c.video : null;
    const hasVideo = !!video;
    extras.has_video = hasVideo ? 'true' : '';

    if (video) {
      const vLabel = video.label || 'Our Story';
      const vHeading = video.heading || 'Experience the difference';
      const vTitle = video.title || '';
      const vSubtitle = video.subtitle || '';
      const vBody = video.body || '';
      const vRuntime = video.runtime || '';
      const vThumb = video.thumbnail || c.hero_image_url || '';
      const vType = video.embedType || 'unknown';
      const vSrc = video.embedUrl || video.url || '';

      extras.video_eyebrow = esc(vLabel);
      extras.video_heading = esc(vHeading);
      extras.video_title = esc(vTitle);
      extras.video_subtitle = esc(vSubtitle);
      extras.video_body = esc(vBody);
      extras.video_runtime = esc(vRuntime);
      extras.video_embed_type = esc(vType);
      extras.video_embed_url = esc(vSrc);
      extras.video_thumbnail_url = esc(vThumb);
    } else {
      extras.video_eyebrow = '';
      extras.video_heading = '';
      extras.video_title = '';
      extras.video_subtitle = '';
      extras.video_body = '';
      extras.video_runtime = '';
      extras.video_embed_type = '';
      extras.video_embed_url = '';
      extras.video_thumbnail_url = '';
    }

    extras.contact_heading = c.contact_heading || 'Let\'s talk.';
    extras.contact_intro = c.contact_intro || 'We reply the same day — drop us a message.';
    extras.unique_selling_point = c.unique_selling_point || c.usp || '';

    // Build ordered sections HTML
    let orderedSectionsHtml = '';

    for (const sectionKey of sectionOrder) {
      switch (sectionKey) {
        case 'hero':
          orderedSectionsHtml += `
<!-- HERO -->
<section id="hero">
  <div class="wrap">
    <div class="hero-grid">
      <div class="hero-copy">
        <div class="hero-index mono">{{business_type_label}} &middot; {{location}}</div>
        <h1 class="hero-h1">{{br_hero_headline_html}}</h1>
        <p class="hero-sub">{{tagline}}</p>
        <div class="hero-actions">
          <a href="{{wa_href_order}}" class="btn-primary" target="_blank" rel="noopener">Get a quote</a>
          <a href="#services" class="btn-ghost">See what we do</a>
        </div>
      </div>
      <div class="hero-media">
        <div class="hero-media-frame">
          {{#if has_hero_image}}<img src="{{hero_image_url}}" alt="{{business_name}}">{{/if}}
        </div>
        <div class="hero-tag"><b>Why {{business_name}}</b>{{unique_selling_point}}</div>
      </div>
    </div>
  </div>
  <div class="hero-rule"></div>
</section>`;
          break;

        case 'about':
          orderedSectionsHtml += `
<!-- ABOUT -->
<section id="about" class="pane">
  <div class="wrap">
    <div class="about-grid">
      <div class="about-img reveal">
        {{#if gallery_0_url}}<img src="{{gallery_0_url}}" alt="{{business_name}}">{{/if}}
      </div>
      <div class="about-text reveal">
        <div class="eyebrow">About us</div>
        <h2 class="sec-h2">{{business_name}}</h2>
        <p class="about-body">{{about}}</p>
        <div class="about-socials">
          {{#if has_facebook}}<a href="{{facebook_url}}" class="soc-link" target="_blank" rel="noopener" aria-label="Facebook">
            <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" stroke="none"><path d="M18 2h-3a5 5 0 0 0-5 5v3H7v4h3v8h4v-8h3l1-4h-4V7a1 1 0 0 1 1-1h3z"/></svg>
          </a>{{/if}}
          {{#if has_instagram}}<a href="{{instagram_url}}" class="soc-link" target="_blank" rel="noopener" aria-label="Instagram">
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="2" width="20" height="20" rx="5"/><path d="M16 11.37A4 4 0 1 1 12.63 8 4 4 0 0 1 16 11.37z"/><line x1="17.5" y1="6.5" x2="17.51" y2="6.5"/></svg>
          </a>{{/if}}
          {{#if has_tiktok}}<a href="{{tiktok_url}}" class="soc-link" target="_blank" rel="noopener" aria-label="TikTok">
            <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" stroke="none"><path d="M19.59 6.69a4.83 4.83 0 0 1-3.77-4.25V2h-3.45v13.67a2.89 2.89 0 0 1-2.88 2.5 2.89 2.89 0 0 1-2.89-2.89 2.89 2.89 0 0 1 2.89-2.89c.28 0 .54.04.79.1V9.01a6.33 6.33 0 0 0-.79-.05 6.34 6.34 0 0 0-6.34 6.34 6.34 6.34 0 0 0 6.34 6.34 6.34 6.34 0 0 0 6.33-6.34V8.69a8.17 8.17 0 0 0 4.77 1.52V6.77a4.85 4.85 0 0 1-1-.08z"/></svg>
          </a>{{/if}}
          {{#if has_whatsapp_social}}<a href="{{wa_href_general}}" class="soc-link" target="_blank" rel="noopener" aria-label="WhatsApp">
            <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" stroke="none"><path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347"/></svg>
          </a>{{/if}}
        </div>
      </div>
    </div>
  </div>
</section>`;
          break;

        case 'services':
          if (hasServices) {
            orderedSectionsHtml += `
<!-- SERVICES -->
<section id="services" class="pane">
  <div class="wrap">
    <div class="sec-head reveal">
      <div>
        <div class="eyebrow">{{services_eyebrow}}</div>
        <h2 class="sec-h2">{{services_heading}}</h2>
        <p class="sec-sub">{{services_intro}}</p>
      </div>
      <div class="sec-index mono">Register of services</div>
    </div>
    <div class="ledger reveal" id="br-ledger">
      {{br_services_html}}
    </div>
  </div>
</section>`;
          }
          break;

        case 'products':
          if (hasProducts) {
            orderedSectionsHtml += `
<!-- PRODUCTS -->
<section id="work" class="pane">
  <div class="wrap">
    <div class="sec-head reveal">
      <div>
        <div class="eyebrow">Catalogue</div>
        <h2 class="sec-h2">What we supply</h2>
        <p class="sec-sub">Message us on WhatsApp with what you need — we'll confirm price and availability the same day.</p>
      </div>
    </div>
    <div class="cat-filter-bar" id="wcz-cat-filters">
      {{fr_category_filters_html}}
    </div>
    <div id="wcz-products">
      {{br_products_html}}
    </div>
  </div>
</section>`;
          }
          break;

        case 'video':
          if (hasVideo) {
            orderedSectionsHtml += `
<!-- VIDEO -->
<section id="video" class="pane">
  <div class="wrap">
    <div class="video-grid">
      <div class="video-stage reveal" id="br-video-stage" data-embed-type="{{video_embed_type}}" data-embed-url="{{video_embed_url}}">
        {{#if video_thumbnail_url}}<img src="{{video_thumbnail_url}}" alt="{{video_title}}">{{/if}}
        <div class="video-play" id="br-video-play">
          <div class="video-play-btn">
            <svg viewBox="0 0 24 24" width="22" height="22" fill="var(--ink)"><path d="M8 5v14l11-7z"/></svg>
          </div>
        </div>
        {{#if video_runtime}}<span class="video-runtime mono">{{video_runtime}}</span>{{/if}}
      </div>
      <div class="video-copy reveal">
        <div class="eyebrow video-label">{{video_eyebrow}}</div>
        <h2 class="sec-h2">{{video_heading}}</h2>
        <p class="video-body">{{video_body}}</p>
      </div>
    </div>
  </div>
</section>`;
          }
          break;

        case 'team':
          if (hasTeam) {
            orderedSectionsHtml += `
<!-- TEAM -->
<section id="team" class="pane">
  <div class="wrap">
    <div class="sec-head reveal">
      <div>
        <div class="eyebrow">The people</div>
        <h2 class="sec-h2">Meet the team</h2>
        <p class="sec-sub">{{team_subtext}}</p>
      </div>
    </div>
    <div class="team-grid reveal" id="br-team">
      {{br_team_html}}
    </div>
  </div>
</section>`;
          }
          break;

        case 'testimonials':
          if (hasTestimonials) {
            orderedSectionsHtml += `
<!-- TESTIMONIALS -->
<section id="testimonials" class="pane">
  <div class="wrap">
    <div class="sec-head reveal">
      <div>
        <div class="eyebrow">On record</div>
        <h2 class="sec-h2">What clients say</h2>
      </div>
    </div>
    <div class="testi-grid reveal" id="br-testimonials">
      {{br_testimonials_html}}
    </div>
  </div>
</section>`;
          }
          break;

        case 'gallery':
          if (hasGallery) {
            orderedSectionsHtml += `
<!-- GALLERY -->
<section id="gallery" class="pane">
  <div class="wrap">
    <div class="sec-head reveal">
      <div>
        <div class="eyebrow">The work</div>
        <h2 class="sec-h2">Gallery</h2>
      </div>
    </div>
  </div>
  <div class="wrap">
    <div class="gallery-grid" id="br-gallery">
      {{br_gallery_html}}
    </div>
  </div>
</section>`;
          }
          break;

        case 'contact':
          orderedSectionsHtml += `
<!-- CONTACT -->
<section id="contact" class="pane">
  <div class="wrap">
    <div class="sec-head reveal">
      <div>
        <div class="eyebrow">Get in touch</div>
        <h2 class="sec-h2">{{contact_heading}}</h2>
        <p class="sec-sub">{{contact_intro}}</p>
      </div>
    </div>
    <div class="contact-grid">
      <div class="contact-info reveal">
        {{#if phone}}<div class="cinfo-item">
          <div class="cinfo-icon">
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07A19.5 19.5 0 0 1 4.69 12a19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 3.6 1.27h3a2 2 0 0 1 2 1.72c.127.96.361 1.903.7 2.81a2 2 0 0 1-.45 2.11L7.91 8.91a16 16 0 0 0 6.18 6.18l.91-.91a2 2 0 0 1 2.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0 1 22 16.92z"/></svg>
          </div>
          <div><div class="cinfo-label">Phone</div><div class="cinfo-val">{{phone}}</div></div>
        </div>{{/if}}
        {{#if email}}<div class="cinfo-item">
          <div class="cinfo-icon">
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect width="20" height="16" x="2" y="4" rx="2"/><path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7"/></svg>
          </div>
          <div><div class="cinfo-label">Email</div><div class="cinfo-val">{{email}}</div></div>
        </div>{{/if}}
        {{#if address}}<div class="cinfo-item">
          <div class="cinfo-icon">
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0z"/><circle cx="12" cy="10" r="3"/></svg>
          </div>
          <div><div class="cinfo-label">Location</div><div class="cinfo-val">{{address}}</div></div>
        </div>{{/if}}
        {{#if has_map}}<div class="cinfo-item" style="margin-top:6px">
          <iframe src="{{map_embed_url}}" width="100%" height="220" style="border:1px solid var(--line2);border-radius:var(--r)" loading="lazy" referrerpolicy="no-referrer-when-downgrade"></iframe>
        </div>{{/if}}
      </div>
      <div class="contact-cta reveal">
        <div class="eyebrow">Fastest reply</div>
        <h3>Talk to us on<br><span style="color:#9fb2ff">WhatsApp</span></h3>
        <p>Tell us what you need — quotes, availability, or a call-back — and we'll respond the same day.</p>
        <a href="{{wa_href_order}}" class="wa-btn" target="_blank" rel="noopener">
          <svg viewBox="0 0 24 24" width="18" height="18" fill="#fff" stroke="none"><path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 0 1-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 0 1-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 0 1 2.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0 0 12.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 0 0 5.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 0 0-3.48-8.413Z"/></svg>
          Message us now
        </a>
      </div>
    </div>
  </div>
</section>`;
          break;
      }
    }

    extras.br_ordered_sections_html = orderedSectionsHtml;
  }

  // ── CHURCH ──────────────────────────────────────────────────────────────────
  // Supports: church (dedicated church template)
  if (templateId === 'church' || templateId === 'church-institution' || templateId === 'faith') {

    const sectionOrder = (c.theme && Array.isArray(c.theme.sections)) ?
      c.theme.sections :
      ['hero', 'about', 'services', 'ministries', 'events', 'give', 'products', 'team', 'testimonials', 'gallery', 'contact'];

    const churchName = c.business_name || c.name || '';
    const nameParts = churchName.trim().split(/\s+/);
    const half = Math.ceil(nameParts.length / 2);
    const line1 = nameParts.slice(0, half).join(' ');
    const line2 = nameParts.slice(half).join(' ');
    extras.br_hero_headline_html = line2 ?
      `${esc(line1)}<br><em style="font-weight:600;color:var(--amber2)">${esc(line2)}</em>` :
      esc(line1 || 'Welcome');

    extras.hero_eyebrow = c.hero_eyebrow || (c.location ? c.location + ' · Est. ' + (c.established_year || '') : '');
    extras.hero_subtext = c.hero_subtext || c.tagline || 'A community of faith growing together in love.';

    const serviceTimes = Array.isArray(c.service_times) ? c.service_times : [];
    extras.has_service_times = serviceTimes.length > 0 ? 'true' : '';
    extras.br_service_times_html = serviceTimes.map(st => {
      const label = esc(st.label || '');
      const time = esc(st.time || '');
      return `<div class="time-item"><span class="label">${label}</span><span class="val">${time}</span></div>`;
    }).join('');

    const values = Array.isArray(c.services) ? c.services : [];
    const hasValues = values.length > 0;
    extras.has_services = hasValues ? 'true' : '';
    extras.services_eyebrow = c.services_eyebrow || 'Who We Are';
    extras.services_heading = c.services_heading || 'What we believe';
    extras.services_intro = c.services_intro || 'These values shape everything we do.';

    const { sorted: sortedValues, hasFeatured: hasFeatVal } = extractFeatured(values);
    const defaultIcons = ['🙏', '❤️', '🌍', '🤝', '✨', '🕊️', '📖', '🎵'];
    extras.br_services_html = sortedValues.map((v, i) => {
      const isFeat = hasFeatVal && i === 0;
      const tag = (v.tag || v.badge || '').trim();
      const badge = isFeat && tag ? featBadgeHtml(tag) : '';
      const hlCls = isFeat ? ' highlighted' : '';
      const name = esc(v.name || v.title || '');
      const desc = esc(v.description || v.body || '');
      const icon = v.icon || defaultIcons[i % defaultIcons.length] || '🙏';
      return `<div class="vcard${hlCls}" style="position:relative">
        ${badge}
        <div class="icon">${icon}</div>
        <h3>${name}</h3>
        <p>${desc}</p>
      </div>`;
    }).join('');

    const ministries = Array.isArray(c.ministries) ? c.ministries : [];
    extras.has_ministries = ministries.length > 0 ? 'true' : '';
    extras.ministries_eyebrow = c.ministries_eyebrow || 'Ministries';
    extras.ministries_heading = c.ministries_heading || 'There is a place for you';
    extras.ministries_intro = c.ministries_intro || '';

    const ministryIcons = ['👦', '🎸', '👩', '🤲', '📚', '🎨', '🏃', '🧘', '👴', '👶', '🎤', '📖'];
    extras.br_ministries_html = ministries.map((m, i) => {
      const name = esc(m.name || m.title || '');
      const desc = esc(m.description || m.body || '');
      const icon = m.icon || ministryIcons[i % ministryIcons.length] || '🙏';
      return `<div class="mcard">
        <div class="ico">${icon}</div>
        <div>
          <h3>${name}</h3>
          <p>${desc}</p>
        </div>
      </div>`;
    }).join('');

    const events = Array.isArray(c.events) ? c.events : [];
    extras.has_events = events.length > 0 ? 'true' : '';
    extras.events_eyebrow = c.events_eyebrow || 'Coming Up';
    extras.events_heading = c.events_heading || 'Events & Gatherings';
    extras.events_intro = c.events_intro || '';

    const eventColors = ['var(--warm)', 'var(--amber)', 'var(--warm2)'];
    extras.br_events_html = events.map((e, i) => {
      const name = esc(e.name || e.title || '');
      const desc = esc(e.description || e.details || '');
      const tag = esc(e.tag || e.category || '');
      const date = e.date || '';
      let day = '',
        month = '';
      if (date) {
        try {
          const d = new Date(date);
          if (!isNaN(d)) {
            day = d.getDate();
            month = d.toLocaleString('en-GB', { month: 'short' }).toUpperCase();
          }
        } catch (err) { /* skip */ }
      }
      if (!day && e.day) day = e.day;
      if (!month && e.month) month = e.month;
      const dateColor = eventColors[i % eventColors.length] || 'var(--warm)';
      const dateHtml = (day && month) ?
        `<div class="event-date" style="background:${dateColor}"><div class="day">${day}</div><div class="month">${month}</div></div>` :
        `<div class="event-date" style="background:${dateColor}"><div class="day" style="font-size:.8rem;padding:4px 0">${tag || '—'}</div></div>`;
      return `<div class="event-item">
        ${dateHtml}
        <div class="event-info">
          <h3>${name}</h3>
          ${desc ? `<p>${desc}</p>` : ''}
        </div>
        ${tag ? `<span class="event-tag">${tag}</span>` : ''}
      </div>`;
    }).join('');

    extras.has_give = true;
    extras.give_eyebrow = c.give_eyebrow || 'Partner With Us';
    extras.give_heading = c.give_heading || 'Your giving changes lives';
    extras.give_text = c.give_text || 'Every contribution supports our feeding programme, school bursaries, and community outreach. Give once or set up a monthly partnership.';
    extras.give_button_label = c.give_button_label || 'Give Online →';
    extras.give_wa_number = c.give_wa_number || c.whatsapp || c.phone || '';

    const team = Array.isArray(c.team) ? c.team : [];
    const pastor = team.length > 0 ? team[0] : null;
    extras.has_pastor = pastor ? 'true' : '';

    if (pastor) {
      extras.pastor_name = esc(pastor.name || pastor.title || '');
      extras.pastor_role = esc(pastor.role || pastor.position || 'Lead Pastor');
      extras.pastor_bio = esc(pastor.bio || pastor.description || '');
      extras.pastor_photo = pastor.photo || pastor.image_url || '';
      extras.pastor_eyebrow = c.pastor_eyebrow || 'Lead Pastor';
      extras.pastor_heading = c.pastor_heading || 'A message from our pastor';
      extras.pastor_cta = c.pastor_cta || 'Join Us This Sunday →';
    } else {
      extras.pastor_name = '';
      extras.pastor_role = '';
      extras.pastor_bio = '';
      extras.pastor_photo = '';
      extras.pastor_eyebrow = '';
      extras.pastor_heading = '';
      extras.pastor_cta = '';
    }

    const teamRest = team.length > 1 ? team.slice(1) : [];
    extras.has_team = teamRest.length > 0 ? 'true' : '';
    extras.team_eyebrow = c.team_eyebrow || 'Our Team';
    extras.team_heading = c.team_heading || 'Meet the leadership';
    extras.team_subtext = c.team_subtext || '';

    extras.br_team_html = teamRest.map(member => {
      const name = esc(member.name || member.title || '');
      const role = esc(member.role || member.position || '');
      const bio = esc(member.bio || member.description || '');
      const photo = member.photo || member.image_url || '';
      const photoEl = photo ?
        `<img src="${esc(photo)}" alt="${name}" loading="lazy">` :
        `<div style="width:100%;height:100%;background:var(--warm);display:grid;place-items:center;font-size:2.4rem;color:rgba(255,255,255,.2)">🙏</div>`;
      return `<div class="team-card">
        <div class="team-photo">${photoEl}</div>
        <div class="team-info">
          <div class="team-name">${name}</div>
          ${role ? `<div class="team-role">${role}</div>` : ''}
          ${bio ? `<div class="team-bio">${bio}</div>` : ''}
        </div>
      </div>`;
    }).join('');

    const testimonials = Array.isArray(c.testimonials) ? c.testimonials : [];
    extras.has_testimonials = testimonials.length > 0 ? 'true' : '';
    extras.testimonials_eyebrow = c.testimonials_eyebrow || 'On Record';
    extras.testimonials_heading = c.testimonials_heading || 'What people say';

    const STAR_SVG_CHURCH = '<svg viewBox="0 0 24 24" width="14" height="14" fill="var(--amber)" stroke="none"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>';
    extras.br_testimonials_html = testimonials.map(t => {
      const name = esc(t.name || t.author || '');
      const role = esc(t.role || t.position || '');
      const text = esc(t.text || t.quote || t.review || '');
      const photo = t.photo || t.avatar || '';
      const avatarEl = photo ?
        `<div class="testi-avatar"><img src="${esc(photo)}" alt="${name}" loading="lazy"></div>` :
        `<div class="testi-avatar">${name ? name.charAt(0).toUpperCase() : '?'}</div>`;
      const rating = Math.max(1, Math.min(5, parseInt(t.rating, 10) || 5));
      const stars = STAR_SVG_CHURCH.repeat(rating);
      return `<div class="testi-card">
        <div class="testi-stars">${stars}</div>
        <p class="testi-text">"${text}"</p>
        <div class="testi-author">
          ${avatarEl}
          <div>
            <div class="testi-name">${name}</div>
            ${role ? `<div class="testi-role">${role}</div>` : ''}
          </div>
        </div>
      </div>`;
    }).join('');

    const gallery = Array.isArray(c.gallery) ? c.gallery : [];
    extras.has_gallery = gallery.length > 0 ? 'true' : '';
    extras.gallery_eyebrow = c.gallery_eyebrow || 'The Work';
    extras.gallery_heading = c.gallery_heading || 'Gallery';
    extras.gallery_0_url = gallery.length ? (typeof gallery[0] === 'string' ? gallery[0] : (gallery[0]?.url || gallery[0]?.src || '')) : '';

    extras.br_gallery_html = gallery.map(img => {
      const src = typeof img === 'string' ? img : (img.url || img.src || '');
      const alt = typeof img === 'object' ? (img.alt || img.caption || '') : '';
      if (!src) return '';
      return `<div class="g-item"><img src="${esc(src)}" alt="${esc(alt)}" loading="lazy"></div>`;
    }).filter(Boolean).join('');

    const brProducts = Array.isArray(c.products) ? c.products : [];
    const hasProducts = brProducts.length > 0;
    extras.has_products = hasProducts ? 'true' : '';

    if (hasProducts) {
      const rawPhone = (c.phone || c.contact?.phone || '').replace(/\D/g, '');
      const waNum = rawPhone.startsWith('263') ? rawPhone : rawPhone ? '263' + rawPhone.replace(/^0/, '') : '';
      const shopCtx = {
        waNum: waNum || '',
        bizName: c.business_name || c.name || '',
        addonActive: whatsappStoreActive
      };

      try {
        const commerce = env && env.COMMERCE_SDK ?
          await callCommerceSDK(env, brProducts, templateId, c.theme || {}, shopCtx) :
          buildCommerceModule(brProducts, templateId, c.theme || {}, shopCtx);

        extras.br_products_html = commerce.gridHtml || '<p class="wcz-prod-empty">No products available.</p>';
        extras.fr_category_filters_html = commerce.filterHtml || '';
        extras.wcz_qv_drawer_html = commerce.drawerHtml || '';
        extras.wcz_lb_html = commerce.lbHtml || '';
        extras.wcz_products_script = commerce.scriptHtml || '';
        extras.wcz_commerce_css = (env && env.COMMERCE_SDK) ?
          await callCommerceCSS(env).catch(() => buildCommerceCSS()) :
          buildCommerceCSS();
      } catch (err) {
        console.error('Commerce SDK error for church:', err);
        extras.br_products_html = '<p class="wcz-prod-empty">Error loading products.</p>';
        extras.fr_category_filters_html = '';
      }
    } else {
      extras.br_products_html = '<p class="wcz-prod-empty">No products listed yet.</p>';
      extras.fr_category_filters_html = '';
    }

    extras.contact_eyebrow = c.contact_eyebrow || 'Get In Touch';
    extras.contact_heading = c.contact_heading || 'Visit this Sunday';
    extras.contact_intro = c.contact_intro || 'We\'d love to welcome you in person.';
    extras.phone = c.phone || c.contact?.phone || '';
    extras.email = c.email || c.contact?.email || '';
    extras.address = c.address || c.location || c.contact?.address || '';
    extras.map_embed_url = c.map_embed_url || c.contact?.map_embed_url || '';
    extras.has_map = extras.map_embed_url ? 'true' : '';

    const socials = c.socials || {};
    extras.facebook_url = socials.facebook || c.facebook_url || '';
    extras.instagram_url = socials.instagram || c.instagram_url || '';
    extras.youtube_url = socials.youtube || c.youtube_url || '';
    extras.has_facebook = extras.facebook_url ? 'true' : '';
    extras.has_instagram = extras.instagram_url ? 'true' : '';
    extras.has_youtube = extras.youtube_url ? 'true' : '';

    const waPhone = (c.whatsapp || c.contact?.whatsapp || c.phone || '').replace(/\D/g, '');
    const waNum = waPhone.startsWith('263') ? waPhone : waPhone ? '263' + waPhone.replace(/^0/, '') : '';
    extras.whatsapp_clean = waNum;
    extras.has_whatsapp = waNum ? 'true' : '';
    extras.wa_href_general = waNum ? `https://wa.me/${waNum}?text=${encodeURIComponent('Hello, I found you on websites.co.zw!')}` : '#';
    extras.wa_href_order = waNum ? `https://wa.me/${waNum}?text=${encodeURIComponent('Hello, I would like to place an order.')}` : '#';
    extras.wa_href_visit = waNum ? `https://wa.me/${waNum}?text=${encodeURIComponent('Hello, I\'d like to plan a visit to your church.')}` : '#';

    extras.unique_selling_point = c.unique_selling_point || c.usp || '';
    extras.established_year = c.established_year || '';

    // Build ordered sections HTML for church
    let orderedSectionsHtml = '';

    for (const sectionKey of sectionOrder) {
      switch (sectionKey) {
        case 'hero':
          orderedSectionsHtml += `
<!-- HERO -->
<section id="hero">
  ${extras.hero_image_url ? `<img class="hero-bg" src="${esc(extras.hero_image_url || '')}" alt="${esc(extras.business_name || '')}">` : `<div class="hero-bg" style="background:linear-gradient(135deg,var(--warm),var(--warm2));"></div>`}
  <div class="wrap hero-wrap">
    ${extras.hero_eyebrow ? `<p class="hero-eyebrow">${esc(extras.hero_eyebrow)}</p>` : ''}
    <h1 class="hero-h1">${extras.br_hero_headline_html || ''}</h1>
    ${extras.hero_subtext ? `<p class="hero-sub">${esc(extras.hero_subtext)}</p>` : ''}
    <div class="hero-actions">
      <a href="#contact" class="btn btn-primary">Plan Your Visit →</a>
      ${extras.has_products ? `<a href="#shop" class="btn btn-ghost">Shop Online</a>` : ''}
      ${extras.has_events ? `<a href="#events" class="btn btn-ghost">View Events</a>` : ''}
    </div>
  </div>
</section>`;
          break;

        case 'about':
          if (hasValues) {
            orderedSectionsHtml += `
<!-- ABOUT / VALUES -->
<section id="about" class="pane">
  <div class="wrap">
    <div class="sec-head reveal">
      <div class="eyebrow eyebrow-center">${esc(extras.services_eyebrow || 'Who We Are')}</div>
      <h2>${esc(extras.services_heading || 'What we believe')}</h2>
      ${extras.services_intro ? `<p>${esc(extras.services_intro)}</p>` : ''}
    </div>
    <div class="values-grid reveal">
      ${extras.br_services_html || ''}
    </div>
  </div>
</section>`;
          }
          break;

        case 'services':
          if (extras.has_service_times) {
            orderedSectionsHtml += `
<!-- SERVICE TIMES BAR -->
<div class="times-bar">
  <div class="wrap">
    <div class="times-grid">
      ${extras.br_service_times_html || ''}
      ${extras.has_whatsapp ? `<div class="time-item"><span class="label">WhatsApp Updates</span><span class="val">${esc(extras.whatsapp_clean)}</span></div>` : ''}
    </div>
  </div>
</div>`;
          }
          break;

        case 'ministries':
          if (extras.has_ministries) {
            orderedSectionsHtml += `
<!-- MINISTRIES -->
<section id="ministries" class="pane">
  <div class="wrap">
    <div class="sec-head reveal">
      <div class="eyebrow eyebrow-center">${esc(extras.ministries_eyebrow || 'Ministries')}</div>
      <h2>${esc(extras.ministries_heading || 'There is a place for you')}</h2>
      ${extras.ministries_intro ? `<p>${esc(extras.ministries_intro)}</p>` : ''}
    </div>
    <div class="min-grid reveal">
      ${extras.br_ministries_html || ''}
    </div>
  </div>
</section>`;
          }
          break;

        case 'events':
          if (extras.has_events) {
            orderedSectionsHtml += `
<!-- EVENTS -->
<section id="events" class="pane pane-alt">
  <div class="wrap">
    <div class="sec-head reveal">
      <div class="eyebrow eyebrow-center">${esc(extras.events_eyebrow || 'Coming Up')}</div>
      <h2>${esc(extras.events_heading || 'Events & Gatherings')}</h2>
      ${extras.events_intro ? `<p>${esc(extras.events_intro)}</p>` : ''}
    </div>
    <div class="events-list reveal">
      ${extras.br_events_html || ''}
    </div>
  </div>
</section>`;
          }
          break;

        case 'give':
          orderedSectionsHtml += `
<!-- GIVE / DONATIONS -->
<section id="give" class="pane">
  <div class="wrap">
    <div class="give-band reveal">
      <div class="eyebrow">${esc(extras.give_eyebrow || 'Partner With Us')}</div>
      <h2>${esc(extras.give_heading || 'Your giving changes lives')}</h2>
      <p>${esc(extras.give_text || 'Every contribution supports our feeding programme, school bursaries, and community outreach. Give once or set up a monthly partnership.')}</p>
      ${extras.has_whatsapp ? `<a href="${esc(extras.wa_href_general)}?text=${encodeURIComponent('Hello, I would like to give to the church.')}" class="btn btn-white" target="_blank" rel="noopener">${esc(extras.give_button_label || 'Give via WhatsApp →')}</a>` : `<a href="#contact" class="btn btn-white">${esc(extras.give_button_label || 'Give Online →')}</a>`}
    </div>
  </div>
</section>`;
          break;

        case 'products':
          if (hasProducts) {
            orderedSectionsHtml += `
<!-- SHOP / PRODUCTS -->
<section id="shop" class="pane pane-alt">
  <div class="wrap">
    <div class="sec-head reveal">
      <div class="eyebrow eyebrow-center">Shop</div>
      <h2>Resources &amp; Merchandise</h2>
      <p>Books, devotionals, and church merchandise — order directly on WhatsApp.</p>
    </div>
    <div class="cat-filter-bar" id="wcz-cat-filters">
      ${extras.fr_category_filters_html || ''}
    </div>
    <div id="wcz-products">
      ${extras.br_products_html || ''}
    </div>
  </div>
</section>`;
          }
          break;

        case 'team':
          if (extras.has_pastor || extras.has_team) {
            orderedSectionsHtml += `
<!-- PASTOR / LEADERSHIP -->
<section id="about" class="pane">
  <div class="wrap">
    ${extras.has_pastor ? `
    <div class="pastor-grid reveal">
      <div class="pastor-img-wrap">
        ${extras.pastor_photo ? `<img class="pastor-img" src="${esc(extras.pastor_photo)}" alt="${esc(extras.pastor_name)}">` : `<div class="pastor-img" style="background:var(--cream);display:grid;place-items:center;font-size:4rem;color:var(--ink3)">🙏</div>`}
      </div>
      <div>
        <p class="pastor-kicker">${esc(extras.pastor_eyebrow || 'Lead Pastor')}</p>
        <h2>${esc(extras.pastor_heading || 'A message from our pastor')}</h2>
        ${extras.pastor_bio ? `<p>${esc(extras.pastor_bio)}</p>` : ''}
        ${extras.pastor_cta ? `<a href="#contact" class="btn btn-primary" style="margin-top:20px">${esc(extras.pastor_cta)}</a>` : ''}
      </div>
    </div>` : ''}
    
    ${extras.has_team ? `
    <div style="margin-top:${extras.has_pastor ? '56px' : '0'}">
      <div class="sec-head reveal" style="margin-bottom:32px">
        <div class="eyebrow eyebrow-center">${esc(extras.team_eyebrow || 'Our Team')}</div>
        <h2>${esc(extras.team_heading || 'Meet the leadership')}</h2>
        ${extras.team_subtext ? `<p>${esc(extras.team_subtext)}</p>` : ''}
      </div>
      <div class="team-grid reveal">
        ${extras.br_team_html || ''}
      </div>
    </div>` : ''}
  </div>
</section>`;
          }
          break;

        case 'testimonials':
          if (extras.has_testimonials) {
            orderedSectionsHtml += `
<!-- TESTIMONIALS -->
<section id="testimonials" class="pane pane-alt">
  <div class="wrap">
    <div class="sec-head reveal">
      <div class="eyebrow eyebrow-center">${esc(extras.testimonials_eyebrow || 'On Record')}</div>
      <h2>${esc(extras.testimonials_heading || 'What people say')}</h2>
    </div>
    <div class="testi-grid reveal">
      ${extras.br_testimonials_html || ''}
    </div>
  </div>
</section>`;
          }
          break;

        case 'gallery':
          if (extras.has_gallery) {
            orderedSectionsHtml += `
<!-- GALLERY -->
<section id="gallery" class="pane">
  <div class="wrap">
    <div class="sec-head reveal">
      <div class="eyebrow eyebrow-center">${esc(extras.gallery_eyebrow || 'The Work')}</div>
      <h2>${esc(extras.gallery_heading || 'Gallery')}</h2>
    </div>
  </div>
  <div class="wrap">
    <div class="gallery-grid" id="br-gallery">
      ${extras.br_gallery_html || ''}
    </div>
  </div>
</section>`;
          }
          break;

        case 'contact':
          orderedSectionsHtml += `
<!-- CONTACT -->
<section id="contact" class="pane pane-alt">
  <div class="wrap">
    <div class="sec-head reveal">
      <div class="eyebrow eyebrow-center">${esc(extras.contact_eyebrow || 'Get In Touch')}</div>
      <h2>${esc(extras.contact_heading || 'Visit this Sunday')}</h2>
      ${extras.contact_intro ? `<p>${esc(extras.contact_intro)}</p>` : ''}
    </div>
    <div class="location-grid reveal">
      <div class="location-map">
        ${extras.has_map ? `<iframe src="${esc(extras.map_embed_url)}" loading="lazy" title="Location Map"></iframe>` : `<div class="map-placeholder">📍</div>`}
      </div>
      <div class="address-box">
        <h3>Plan your visit</h3>
        ${extras.address ? `<div class="addr-row"><span class="ico">📍</span><p>${esc(extras.address)}</p></div>` : ''}
        ${extras.has_service_times ? `<div class="addr-row"><span class="ico">🕖</span><p>${extras.br_service_times_html ? esc(extras.br_service_times_html.replace(/<div class="time-item">/g, '').replace(/<\/div>/g, ' • ').replace(/<span class="label">/g, '').replace(/<\/span><span class="val">/g, ': ')) : ''}</p></div>` : ''}
        ${extras.phone ? `<div class="addr-row"><span class="ico">📞</span><p>${esc(extras.phone)}</p></div>` : ''}
        ${extras.email ? `<div class="addr-row"><span class="ico">✉️</span><p>${esc(extras.email)}</p></div>` : ''}
        ${extras.has_whatsapp ? `<a href="${esc(extras.wa_href_visit)}" class="btn btn-wa" style="margin-top:16px" target="_blank" rel="noopener">💬 WhatsApp Us</a>` : ''}
      </div>
    </div>
  </div>
</section>`;
          break;
      }
    }

    extras.br_ordered_sections_html = orderedSectionsHtml;
  }

  return extras;
}

// --- SCHOOL HTML BUILDERS -----------------------------------------------------

function buildSchoolProgrammesHtml(c) {
  const items = c.services || c.programmes || c.menu || [];
  if (!Array.isArray(items) || !items.length) return '';
  const { sorted, hasFeatured } = extractFeatured(items);
  return sorted.map((s, i) => {
    const isFeat = hasFeatured && i === 0;
    const tag = (s.tag || s.badge || '').trim();
    const badge = isFeat && tag ? featBadgeHtml(tag) : '';
    const hlCls = isFeat ? ' highlighted' : '';
    const photo = s.photo ? `<div class="si-prog__img"><img src="${esc(s.photo)}" alt="${esc(s.name || '')}" loading="lazy"></div>` : '';
    const cat = s.category ? `<div class="si-prog__cat">${esc(s.category)}</div>` : '';
    const price = s.price ? `<div class="si-prog__price">${esc(s.price)}</div>` : '';
    return `<div class="si-prog${hlCls}" style="position:relative">${badge}${photo}<div class="si-prog__body">${cat}<div class="si-prog__name">${esc(s.name || '')}</div><div class="si-prog__desc">${esc(s.description || s.desc || '')}</div>${price}</div></div>`;
  }).join('');
}

function buildSchoolTeamHtml(c) {
  const team = c.team || c.staff || [];
  if (!Array.isArray(team) || !team.length) return '';
  return team.map(m => {
    const photo = m.photo ?
      `<div class="si-member__photo"><img src="${esc(m.photo)}" alt="${esc(m.name || '')}" loading="lazy"></div>` :
      `<div class="si-member__photo" style="background:var(--surface);display:flex;align-items:center;justify-content:center;max-width:140px;aspect-ratio:1;border-radius:50%;margin:0 auto 14px;font-size:2.5rem;"><\/div>`;
    return `<div class="si-member">${photo}<div class="si-member__name">${esc(m.name || '')}</div><div class="si-member__role">${esc(m.role || m.position || '')}</div><div class="si-member__bio">${esc(m.bio || m.description || '')}</div></div>`;
  }).join('');
}

function buildSchoolEventsHtml(c) {
  const events = c.events || c.products || [];
  if (!Array.isArray(events) || !events.length) return '';
  return events.slice(0, 6).map(ev => {
    let day = '',
      month = '';
    const rawDate = ev.date || ev.event_date || '';
    if (rawDate) {
      try {
        const d = new Date(rawDate);
        if (!isNaN(d)) { day = d.getDate();
          month = d.toLocaleString('en-GB', { month: 'short' }).toUpperCase(); }
      } catch (e) { /* skip */ }
    }
    const dateBlock = day ?
      `<div class="si-event__date"><div class="si-event__day">${day}</div><div class="si-event__month">${month}</div></div>` :
      `<div class="si-event__date" style="background:var(--gold);display:flex;align-items:center;justify-content:center;"><span style="font-size:1.8rem;">-</span></div>`;
    const meta = ev.time || ev.location || ev.venue || '';
    return `<div class="si-event">${dateBlock}<div><div class="si-event__title">${esc(ev.name || ev.title || '')}</div>${meta ? `<div class="si-event__meta">${esc(meta)}</div>` : ''}<div class="si-event__desc">${esc(ev.description || ev.desc || '')}</div></div></div>`;
  }).join('');
}

function buildSchoolGalleryHtml(c) {
  const gallery = c.gallery || [];
  if (!Array.isArray(gallery) || !gallery.length) return '';
  return gallery.map(img => {
    const src = typeof img === 'string' ? img : (img.url || img.src || '');
    const alt = typeof img === 'object' ? (img.alt || img.caption || '') : '';
    return src ? `<div class="si-gallery__item"><img src="${esc(src)}" alt="${esc(alt)}" loading="lazy"></div>` : '';
  }).filter(Boolean).join('');
}

function buildSchoolTestiHtml(c) {
  const testimonials = c.testimonials || [];
  if (!Array.isArray(testimonials) || !testimonials.length) return '';
  return testimonials.map(t => {
    const photo = t.photo ?
      `<div class="si-testi__avatar"><img src="${esc(t.photo)}" alt="${esc(t.name || '')}" loading="lazy"></div>` :
      `<div class="si-testi__avatar" style="background:rgba(201,154,46,.2);"></div>`;
    return `<div class="si-testi"><div class="si-testi__text">${esc(t.text || t.quote || t.review || '')}</div><div class="si-testi__author">${photo}<div><div class="si-testi__name">${esc(t.name || '')}</div><div class="si-testi__role">${esc(t.role || t.position || '')}</div></div></div></div>`;
  }).join('');
}

// --- GRILL EXTRAS -------------------------------------------------------------

function buildGrillExtras(c, config) {
  const extras = {};
  const menu = Array.isArray(c.menu) ? c.menu : [];

  const palette = config.paletteTokens || {};
  extras.ember_color = palette.ember_color || '#D2541F';
  extras.amber_color = palette.amber_color || '#E0A12E';

  for (const [k, v] of Object.entries(config.extraTokens || {})) { extras[k] = v; }

  extras.has_menu = menu.length > 0 ? 'true' : '';
  extras.has_team = (Array.isArray(c.team) && c.team.length > 0) ? 'true' : '';
  extras.has_gallery = (Array.isArray(c.gallery) && c.gallery.length > 0) ? 'true' : '';
  extras.has_testimonials = (Array.isArray(c.testimonials) && c.testimonials.length > 0) ? 'true' : '';
  extras.has_hours = c.hours ? 'true' : '';

  if (!menu.length) return extras;

  const getcat = item => (item.category && item.category.trim()) ? item.category.trim() : 'Menu';
  const categories = [...new Set(menu.map(getcat))];
  const ICONS = ['', '', '', '', '', ''];

  extras.menu_categories_html = categories
    .map((cat, i) => `<button class="cat-tab${i === 0 ? ' on' : ''}" data-cat="${esc(cat)}">${esc(cat)}</button>`)
    .join('');

  extras.menu_by_category_html = categories.map((catName, catIdx) => {
    const items = menu.filter(item => getcat(item) === catName);
    const featuredIdx = items.findIndex(item => (item.tag || item.badge || '').trim());
    const hasFeatured = featuredIdx >= 0;
    const sorted = hasFeatured ?
      [items[featuredIdx], ...items.filter((_, i) => i !== featuredIdx)] :
      items;

    const itemsHtml = sorted.map((item, i) => {
      const isFeatured = hasFeatured && i === 0;
      const photo = item.photo || item.image || item.photo_url || '';
      const tag = item.tag || item.badge || '';
      const sn = (item.name || '').replace(/\\/g, '\\\\').replace(/'/g, "\\'");
      const sp = (item.price || '').replace(/\\/g, '\\\\').replace(/'/g, "\\'");
      const sd = (item.description || '').replace(/'/g, "\\'").replace(/"/g, '&quot;');
      const onclickArg = `{name:'${sn}',price:'${sp}'}`;
      const lbData = `{name:'${sn}',price:'${sp}',photo:'${esc(photo)}',desc:'${sd}'}`;
      const STAR_SVG = `<svg viewBox="0 0 24 24" width="10" height="10" fill="currentColor" stroke="none"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>`;
      const badgeHtml = isFeatured ? `<span class="dish-badge">${STAR_SVG}${esc(tag)}</span>` : '';
      const highlightClass = isFeatured ? ' highlighted' : '';

      return `<div class="dish reveal${highlightClass}">
  <div class="dish-photo" onclick="lbOpen(${lbData})">${photo ?
        `<img src="${esc(photo)}" alt="${esc(item.name || '')}" loading="lazy">` :
        `<div style="width:100%;height:100%;display:flex;align-items:center;justify-content:center;font-size:2.5rem">${ICONS[i % ICONS.length]}</div>`
      }${badgeHtml}<span class="expand-hint"><svg viewBox="0 0 24 24" width="10" height="10" fill="none" stroke="#fff" stroke-width="2.5" stroke-linecap="round"><path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7"/></svg></span></div>
  <div class="dish-body"${isFeatured && tag ? ` data-badge="* ${esc(tag)}"` : ""}>
    <div class="dish-title-row">
      <span class="dish-name">${esc(item.name || '')}</span>
      ${item.price ? `<span class="dish-price">${esc(item.price)}</span>` : ''}
    </div>
    ${item.description ? `<p class="dish-desc">${esc(item.description)}</p>` : ''}
    <div class="dish-footer"><span></span><button class="add-btn" onclick="ghAddToOrder(${onclickArg},this)">+ Add to order</button></div>
  </div>
</div>`;
    }).join('');

    return `<div class="menu-cat reveal${hasFeatured ? ' has-featured' : ''}" data-cat="${esc(catName)}"${catIdx > 0 ? ' style="display:none"' : ''}>
  <div class="menu-grid">${itemsHtml}</div>
</div>`;
  }).join('');

  return extras;
}

// --- SHELL WRAPPER ------------------------------------------------------------

function wrapWithShell(body, c, site, config, isPreview) {
  const phone = c.phone || c.contact?.phone || '';
  const digits = phone.replace(/\D/g, '');
  const waNum = digits.startsWith('263') ? digits : '263' + digits.replace(/^0/, '');
  const waHref = phone ? `https://wa.me/${waNum}?text=${encodeURIComponent('Hello!')}` : '#';
  const skipNav = !!config.selfContainedNav || /<nav[\s>]|<header[\s>]/i.test(body);

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
  <span class="wcz-mobile-close" id="wcz-mobile-close">x</span>
  ${navLinks}
  ${phone ? `<a href="${esc(waHref)}" target="_blank" rel="noopener" style="background:#25d366;color:#fff;padding:.75rem 2rem;border-radius:999px;font-weight:700">WhatsApp</a>` : ''}
</div>`;

  const previewBanner = isPreview ?
    `<div style="position:fixed;bottom:0;left:0;right:0;z-index:9999;background:linear-gradient(135deg,#1a1a2e,#e94560);color:#fff;text-align:center;padding:.75rem;font-size:.85rem;font-weight:600">Preview mode -- <a href="https://app.websites.co.zw" style="color:#fff;text-decoration:underline">Go to dashboard</a> to publish</div>` :
    '';

  const shellJs = skipNav ? '' : `<script>
(function(){
  var nav=document.getElementById('wcz-nav');
  function s(){if(nav)nav.classList.toggle('scrolled',window.scrollY>60);}
  window.addEventListener('scroll',s,{passive:true});s();
  var btn=document.getElementById('wcz-hamburger'),menu=document.getElementById('wcz-mobile-menu'),close=document.getElementById('wcz-mobile-close');
  if(btn&&menu){btn.addEventListener('click',function(){menu.classList.add('open');});if(close)close.addEventListener('click',function(){menu.classList.remove('open');});menu.querySelectorAll('a').forEach(function(a){a.addEventListener('click',function(){menu.classList.remove('open');});}); }
})();
<\/script>`;

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

// --- ICON SYSTEM --------------------------------------------------------------

const ICONS = {
  menu: `<line x1="4" y1="6" x2="20" y2="6"/><line x1="4" y1="12" x2="20" y2="12"/><line x1="4" y1="18" x2="20" y2="18"/>`,
  x: `<path d="M18 6 6 18"/><path d="m6 6 12 12"/>`,
  chevronLeft: `<path d="m15 18-6-6 6-6"/>`,
  chevronRight: `<path d="m9 18 6 6-6-6"/>`,
  chevronDown: `<path d="m6 9 6 6 6-6"/>`,
  phone: `<path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07A19.5 19.5 0 0 1 4.69 12a19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 3.6 1.27h3a2 2 0 0 1 2 1.72c.127.96.361 1.903.7 2.81a2 2 0 0 1-.45 2.11L7.91 8.91a16 16 0 0 0 6.18 6.18l.91-.91a2 2 0 0 1 2.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0 1 22 16.92z"/>`,
  mail: `<rect width="20" height="16" x="2" y="4" rx="2"/><path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7"/>`,
  mapPin: `<path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0z"/><circle cx="12" cy="10" r="3"/>`,
  clock: `<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>`,
  facebook: `<path d="M18 2h-3a5 5 0 0 0-5 5v3H7v4h3v8h4v-8h3l1-4h-4V7a1 1 0 0 1 1-1h3z"/>`,
  instagram: `<rect x="2" y="2" width="20" height="20" rx="5" ry="5"/><path d="M16 11.37A4 4 0 1 1 12.63 8 4 4 0 0 1 16 11.37z"/><line x1="17.5" y1="6.5" x2="17.51" y2="6.5"/>`,
  twitter: `<path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/>`,
  whatsapp: `<path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 0 1-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 0 1-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 0 1 2.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0 0 12.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 0 0 5.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 0 0-3.48-8.413Z"/>`,
  star: `<polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>`,
  check: `<polyline points="20 6 9 17 4 12"/>`,
  zap: `<polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/>`,
  shoppingCart: `<circle cx="9" cy="21" r="1"/><circle cx="20" cy="21" r="1"/><path d="M1 1h4l2.68 13.39a2 2 0 0 0 2 1.61h9.72a2 2 0 0 0 2-1.61L23 6H6"/>`,
  utensils: `<path d="M3 2v7c0 1.1.9 2 2 2h4a2 2 0 0 0 2-2V2"/><path d="M7 2v20"/><path d="M21 15V2a5 5 0 0 0-5 5v6c0 1.1.9 2 2 2h3Zm0 0v7"/>`,
};

const FILLED_ICONS = new Set(['facebook', 'instagram', 'twitter', 'whatsapp', 'star', 'zap']);

function icon(name, size = 20, color = 'currentColor') {
  const paths = ICONS[name] || '';
  const filled = FILLED_ICONS.has(name);
  const attrs = filled ?
    `fill="${color}" stroke="none"` :
    `fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"`;
  return `<svg viewBox="0 0 24 24" width="${size}" height="${size}" ${attrs} aria-hidden="true">${paths}</svg>`;
}

// --- PALETTE RESOLUTION -------------------------------------------------------

const SITE_PALETTES = {
  'black-white-gold': { primary: '#0c0c0c', accent1: '#c8a24a', accent2: '#a87030', bg: '#f5f5f5', surface: '#fff' },
  'midnight-purple': { primary: '#0d0a14', accent1: '#a855f7', accent2: '#7c3aed', bg: '#f8f5ff', surface: '#fff' },
  'deep-teal': { primary: '#061a1a', accent1: '#14b8a6', accent2: '#0891b2', bg: '#f0fafa', surface: '#fff' },
  'sky-blue': { primary: '#0f1b2d', accent1: '#3da5e0', accent2: '#1d7cb8', bg: '#f0f7ff', surface: '#fff' },
  'elite-sports': { primary: '#0a0a0a', accent1: '#16a34a', accent2: '#15803d', bg: '#f4faf5', surface: '#fff' },
  'rose-noir': { primary: '#0e0b0d', accent1: '#e8a0b0', accent2: '#c96a7e', bg: '#fff5f7', surface: '#fff' },
  'clean-white': { primary: '#1a1a1a', accent1: '#1a1a1a', accent2: '#3d3d3d', bg: '#ffffff', surface: '#f6f6f4' },
  'warm-terracotta': { primary: '#3a1606', accent1: '#c0440e', accent2: '#a03a0a', bg: '#fdf6f0', surface: '#fff' },
  'ember-cream': { primary: '#221A14', accent1: '#D2541F', accent2: '#E0A12E', bg: '#FBF4E9', surface: '#fff' },
  'blush-plum': { primary: '#2d1620', accent1: '#c96a7e', accent2: '#B08D57', bg: '#ffffff', surface: '#F7ECEC' },
  'soft-pink': { primary: '#3a0f24', accent1: '#e91e8c', accent2: '#c0156e', bg: '#fff9fb', surface: '#fdeef3' },
  'navy-gold': { primary: '#0a2540', accent1: '#C99A2E', accent2: '#a87d1a', bg: '#ffffff', surface: '#EAF1F9' },
  'slate-gold': { primary: '#20262f', accent1: '#C08A2D', accent2: '#a87020', bg: '#ffffff', surface: '#F4F6FA' },
  'medical-teal': { primary: '#063a3f', accent1: '#0891b2', accent2: '#0e7490', bg: '#f4fbfb', surface: '#e8f6f6' },
  'forest-cream': { primary: '#1f3320', accent1: '#B0852F', accent2: '#8a6520', bg: '#F6F1E7', surface: '#fff' },
  'market-fresh': { primary: '#0f3d1a', accent1: '#1e8c3a', accent2: '#166e2c', bg: '#ffffff', surface: '#f4faf5' },
  'bright-orange': { primary: '#2b1400', accent1: '#ea580c', accent2: '#c04800', bg: '#ffffff', surface: '#fff8f3' },
  'utility-slate': { primary: '#0f1729', accent1: '#1a56db', accent2: '#1447b8', bg: '#f7f8fa', surface: '#ffffff' },
  'warm-cream': { primary: '#2C1A0E', accent1: '#C07A2B', accent2: '#E09A3B', bg: '#FAF5EE', surface: '#ffffff' },
};

function paletteFor(t) {
  const m = {
    'bold-retail': 'clean-white',
    'grill-house': 'ember-cream',
    'restaurant': 'ember-cream',
    'beauty-salon': 'blush-plum',
    'salon': 'blush-plum',
    'school-institution': 'navy-gold',
    'school': 'navy-gold',
    'church': 'warm-cream',
    'advisory-firm': 'slate-gold',
    'consultant': 'slate-gold',
    'property-estate': 'forest-cream',
    'realestate': 'forest-cream',
    'boutique-fashion': 'rose-noir',
    'boutique': 'rose-noir',
    'fashion': 'rose-noir',
    'grocery-fmcg': 'market-fresh',
    'grocery': 'market-fresh',
    'spaza': 'market-fresh',
    'fmcg': 'market-fresh',
    'hardware-store': 'utility-slate',
    'hardware': 'utility-slate',
    'retail': 'utility-slate',
    'hospitality-inn': 'navy-gold',
    'lodge': 'navy-gold',
    'hotel': 'navy-gold',
    'accommodation': 'navy-gold',
    'faith': 'warm-cream',
    'church-institution': 'warm-cream',
  };
  return m[t] || 'clean-white';
}

function fontFor(t) {
  const m = {
    'bold-retail': 'clean-sans',
    'grill-house': 'playfair-jakarta',
    'restaurant': 'playfair-jakarta',
    'beauty-salon': 'garamond-jost',
    'salon': 'garamond-jost',
    'school-institution': 'grotesk-serif',
    'school': 'grotesk-serif',
    'church': 'playfair-jakarta',
    'advisory-firm': 'grotesk-serif',
    'consultant': 'grotesk-serif',
    'property-estate': 'grotesk-serif',
    'realestate': 'grotesk-serif',
    'boutique-fashion': 'garamond-jost',
    'boutique': 'garamond-jost',
    'fashion': 'garamond-jost',
    'grocery-fmcg': 'clean-sans',
    'grocery': 'clean-sans',
    'spaza': 'clean-sans',
    'fmcg': 'clean-sans',
    'hardware-store': 'display-mono',
    'hardware': 'display-mono',
    'retail': 'display-mono',
    'sports': 'sports-sans',
    'hospitality-inn': 'playfair-jakarta',
    'lodge': 'playfair-jakarta',
    'hotel': 'playfair-jakarta',
    'faith': 'playfair-jakarta',
    'church-institution': 'playfair-jakarta',
  };
  return m[t] || 'grotesk-serif';
}

// ── PALETTE RESOLUTION (continued) ──────────────────────────────────────────

const TEMPLATE_VAR_MAP = {
  'grill-house': { primary: '--char', accent1: '--ember', accent2: '--amber', bg: '--cream', brand: '--char' },
  'restaurant': { primary: '--char', accent1: '--ember', accent2: '--amber', bg: '--cream', brand: '--char' },
  'beauty-salon': { primary: '--primary-color', accent1: '--primary-color', accent2: '--accent-color', brand: '--primary-color' },
  'school-institution': { primary: '--navy', accent1: '--gold', accent2: '--gold-lt', brand: '--navy' },
  'church': { primary: '--warm', accent1: '--amber', accent2: '--amber2', bg: '--cream', brand: '--amber' },
  'faith': { primary: '--warm', accent1: '--amber', accent2: '--amber2', bg: '--cream', brand: '--amber' },
  'church-institution': { primary: '--warm', accent1: '--amber', accent2: '--amber2', bg: '--cream', brand: '--amber' },
  'advisory-firm': { primary: '--slate', accent1: '--gold', accent2: '--gold-lt', brand: '--slate' },
  'property-estate': { primary: '--forest', accent1: '--gold', accent2: '--gold-lt', brand: '--forest' },
  'boutique-fashion': { primary: '--ink', accent1: '--gold', accent2: '--gold2', brand: '--ink' },
  'boutique': { primary: '--ink', accent1: '--gold', accent2: '--gold2', brand: '--ink' },
  'fashion': { primary: '--ink', accent1: '--gold', accent2: '--gold2', brand: '--ink' },
  'fashion-retail': { primary: '--text', accent1: '--sand', accent2: '--sand2', brand: '--text' },
  'hospitality-inn': { primary: '--ink', accent1: '--gold', accent2: '--gold-light', bg: '--cream', brand: '--gold' },
  'hospitality-in': { primary: '--ink', accent1: '--gold', accent2: '--gold-light', bg: '--cream', brand: '--gold' },
  'lodge': { primary: '--ink', accent1: '--gold', accent2: '--gold-light', bg: '--cream', brand: '--gold' },
  'hotel': { primary: '--ink', accent1: '--gold', accent2: '--gold-light', bg: '--cream', brand: '--gold' },
  'grocery-fmcg': { primary: '--green', accent1: '--sun', accent2: '--green2', brand: '--green' },
  'grocery': { primary: '--green', accent1: '--sun', accent2: '--green2', brand: '--green' },
  'hardware-store': { primary: '--primary', accent1: '--accent', accent2: '--accent-light', brand: '--accent' },
  'hardware': { primary: '--primary', accent1: '--accent', accent2: '--accent-light', brand: '--accent' },
  'bold-retail': { primary: '--ink', accent1: '--signal', accent2: '--signal-deep', bg: '--paper', brand: '--signal' },
  'retail': { primary: '--ink', accent1: '--signal', accent2: '--signal-deep', bg: '--paper', brand: '--signal' },
  'general': { primary: '--ink', accent1: '--signal', accent2: '--signal-deep', bg: '--paper', brand: '--signal' },
  'general-business': { primary: '--ink', accent1: '--signal', accent2: '--signal-deep', bg: '--paper', brand: '--signal' },
};

function resolvePalette(paletteKey, customAccent) {
  const p = SITE_PALETTES[paletteKey] || SITE_PALETTES['ember-cream'];
  return {
    primary: p.primary,
    accent1: customAccent || p.accent1,
    accent2: p.accent2,
    bg: p.bg,
    surface: p.surface,
  };
}

function buildPaletteOverride(templateId, paletteKey, customAccent) {
  if (!paletteKey && !customAccent) return '';
  const colors = resolvePalette(paletteKey || 'ember-cream', null);
  const map = TEMPLATE_VAR_MAP[templateId];

  if (map) {
    const overrides = [];
    if (map.primary) overrides.push(`${map.primary}:${colors.primary}`);
    if (map.accent1) overrides.push(`${map.accent1}:${colors.accent1}`);
    if (map.accent2 && map.accent2 !== map.accent1) overrides.push(`${map.accent2}:${colors.accent2}`);
    if (map.bg) overrides.push(`${map.bg}:${colors.bg}`);
    if (customAccent && map.brand) overrides.push(`${map.brand}:${customAccent}`);
    if (!overrides.length) return '';
    return `<style>:root{${overrides.join(';')}}</style>`;
  }

  const fallbackColors = resolvePalette(paletteKey || 'ember-cream', customAccent);
  return `<style>:root{--accent:${fallbackColors.accent1};--primary:${fallbackColors.primary};--bg:${fallbackColors.bg}}</style>`;
}

// --- FONT MAP -----------------------------------------------------------------

const FONT_MAP = {
  'clean-sans': { url: 'https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;600;700;800&display=swap', body: '"Space Grotesk",system-ui,sans-serif', head: '"Space Grotesk",system-ui,sans-serif' },
  'grotesk-serif': { url: 'https://fonts.googleapis.com/css2?family=Fraunces:ital,wght@0,700;0,800;1,700&family=Hanken+Grotesk:wght@400;500;600;700&display=swap', body: '"Hanken Grotesk",system-ui,sans-serif', head: '"Fraunces",Georgia,serif' },
  'playfair-jakarta': { url: 'https://fonts.googleapis.com/css2?family=Playfair+Display:wght@600;700;800;900&family=Plus+Jakarta+Sans:wght@400;500;600;700;800&display=swap', body: '"Plus Jakarta Sans",system-ui,sans-serif', head: '"Playfair Display",Georgia,serif' },
  'garamond-jost': { url: 'https://fonts.googleapis.com/css2?family=Cormorant+Garamond:ital,wght@0,600;0,700;1,600&family=Jost:wght@400;500;600;700&display=swap', body: '"Jost",system-ui,sans-serif', head: '"Cormorant Garamond",Georgia,serif' },
  'sports-sans': { url: 'https://fonts.googleapis.com/css2?family=Barlow+Condensed:wght@600;700;800&family=Barlow:wght@400;500;600&display=swap', body: '"Barlow",system-ui,sans-serif', head: '"Barlow Condensed",system-ui,sans-serif' },
  'display-mono': { url: 'https://fonts.googleapis.com/css2?family=DM+Mono:wght@400;500&family=DM+Sans:wght@400;500;600;700&display=swap', body: '"DM Sans",system-ui,sans-serif', head: '"DM Mono",monospace' },
};

function buildFontOverride(fontPairKey) {
  if (!fontPairKey) return { styleBlock: '', fontsUrl: '' };
  const f = FONT_MAP[fontPairKey];
  if (!f) return { styleBlock: '', fontsUrl: '' };
  return {
    styleBlock: `<style>body,button,input,select,textarea{font-family:${f.body}}h1,h2,h3,h4{font-family:${f.head}}</style>`,
    fontsUrl: f.url,
  };
}

// --- SHARED HELPERS -----------------------------------------------------------

function esc(s) {
  if (!s) return '';
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// --- VIDEO NORMALISATION -------------------------------------------------------

function hospVideoInfo(url) {
  url = String(url || '').trim();
  if (!url) return { type: '', embedUrl: '' };
  if (/\/embed\//.test(url)) return { type: 'youtube', embedUrl: url };
  if (/player\.vimeo\.com/.test(url)) return { type: 'vimeo', embedUrl: url };
  let m = url.match(/(?:youtube\.com\/(?:watch\?v=|embed\/|shorts\/)|youtu\.be\/)([A-Za-z0-9_-]{6,})/);
  if (m) return { type: 'youtube', embedUrl: 'https://www.youtube.com/embed/' + m[1] };
  m = url.match(/vimeo\.com\/(?:video\/)?(\d+)/);
  if (m) return { type: 'vimeo', embedUrl: 'https://player.vimeo.com/video/' + m[1] };
  if (/\.(mp4|webm|ogg|mov)(\?|$)/i.test(url)) return { type: 'file', embedUrl: url };
  return { type: 'unknown', embedUrl: url };
}

function normalizeVideoObj(v) {
  if (!v) return null;
  const raw = (typeof v === 'string') ? { url: v } : (typeof v === 'object' ? v : null);
  if (!raw) return null;
  const url = raw.url || raw.embedUrl || '';
  if (!url) return null;
  const info = (raw.embedUrl && raw.embedType) ?
    { type: raw.embedType, embedUrl: raw.embedUrl } :
    hospVideoInfo(url);
  return {
    url: url,
    embedUrl: info.embedUrl || url,
    embedType: info.type || 'unknown',
    thumbnail: raw.thumbnail || '',
    title: raw.title || '',
    subtitle: raw.subtitle || '',
    label: raw.label || '',
    heading: raw.heading || '',
    body: raw.body || '',
    runtime: raw.runtime || '',
  };
}

function wa(phone, msg) {
  const p = String(phone || '').replace(/\D/g, '');
  const m = encodeURIComponent(msg || 'Hello, I found you on websites.co.zw');
  return `https://wa.me/${p}?text=${m}`;
}

function getImage(obj, ...extraFields) {
  if (!obj || typeof obj !== 'object') return '';
  const fields = ['photo', 'image', 'image_url', 'photo_url', 'img', 'picture', 'thumbnail', ...extraFields];
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

function normalizeServices(arr) {
  if (!Array.isArray(arr)) return [];
  return arr.map(item => {
    if (!item || typeof item !== 'object') return item;
    return {
      ...item,
      title: item.title || item.name || '',
      name: item.name || item.title || '',
      body: item.body || item.description || '',
      description: item.description || item.body || '',
    };
  });
}

// --- HOURS HELPERS ------------------------------------------------------------

function normalizeHours(hours) {
  if (!hours) return null;
  if (typeof hours === 'string') return hours.trim();
  if (typeof hours !== 'object' || Array.isArray(hours)) return null;
  const DAY_KEYS = new Set(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']);
  const hasDay = Object.keys(hours).some(k => DAY_KEYS.has(k));
  let h = hours;
  if (!hasDay) {
    let found = null;
    for (const v of Object.values(hours)) {
      if (v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).some(k => DAY_KEYS.has(k))) { found = v; break; }
    }
    if (!found) return null;
    h = found;
  }
  function slotToStr(val) {
    if (!val) return null;
    if (typeof val === 'string') return val.trim();
    if (typeof val === 'number') return String(val).padStart(2, '0') + ':00';
    if (typeof val === 'object') {
      const hr = String(val.hour ?? val.h ?? val.hours ?? 0).padStart(2, '00');
      const min = String(val.minute ?? val.m ?? val.minutes ?? 0).padStart(2, '00');
      return `${hr}:${min}`;
    }
    return null;
  }
  const normalized = {};
  for (const d of DAY_KEYS) {
    const slot = h[d];
    if (!slot || typeof slot !== 'object') continue;
    if (slot.closed) { normalized[d] = { closed: true }; continue; }
    const open = slotToStr(slot.open ?? slot.opens ?? slot.from ?? slot.start);
    const close = slotToStr(slot.close ?? slot.closes ?? slot.to ?? slot.end);
    if (open || close) normalized[d] = { open: open || '?', close: close || '?' };
  }
  return Object.keys(normalized).length ? normalized : null;
}

function isOpenNow(hours) {
  const h = normalizeHours(hours);
  if (!h || typeof h === 'string') return null;
  const days = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
  const day = days[new Date().getDay()];
  const slot = h[day];
  if (!slot || typeof slot !== 'object' || slot.closed) return false;
  const [oh, om] = (slot.open || '00:00').split(':').map(Number);
  const [ch, cm] = (slot.close || '00:00').split(':').map(Number);
  const mins = new Date().getHours() * 60 + new Date().getMinutes();
  return mins >= oh * 60 + om && mins < ch * 60 + cm;
}

function openClosedBadge(hours) {
  const open = isOpenNow(hours);
  if (open === null) return '';
  return open ?
    `<span class="badge-open"><span class="badge-dot"></span>Open Now</span>` :
    `<span class="badge-closed"><span class="badge-dot"></span>Closed</span>`;
}

function buildHoursGridHtml(hours) {
  const h = normalizeHours(hours);
  if (!h || typeof h === 'string') return '';
  const order = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
  const labels = { mon: 'Monday', tue: 'Tuesday', wed: 'Wednesday', thu: 'Thursday', fri: 'Friday', sat: 'Saturday', sun: 'Sunday' };
  const today = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'][new Date().getDay()];
  return order.map(d => {
    const slot = h[d];
    if (!slot || typeof slot !== 'object') return null;
    const isToday = d === today;
    const isClosed = slot.closed;
    const timeStr = isClosed ? 'Closed' : `${slot.open || '?'} - ${slot.close || '?'}`;
    return `<div class="hours-row${isToday ? ' today' : ''}">
      <span class="day">${labels[d]}${isToday ? '<span class="today-pill">Today</span>' : ''}</span>
      <span class="time">${esc(timeStr)}</span>
    </div>`;
  }).filter(Boolean).join('');
}

// --- CONTENT NORMALIZATION ----------------------------------------------------

const HOSP_TEMPLATE_IDS = new Set([
  'hospitality-inn', 'hospitality-in', 'lodge', 'lodges', 'hotel', 'accommodation'
]);

const SALON_TEMPLATE_IDS = new Set(['beauty-salon']);

const GROCERY_TEMPLATE_IDS = new Set(['grocery-fmcg', 'grocery']);
const GROCERY_EXTRA_KEYS = [
  'categories', 'specials', 'specials_note',
  'delivery_note', 'delivery_areas',
  'hero_eyebrow', 'hero_headline', 'hero_subtext'
];

// Self-contained CSS + JS for hospitality templates
function buildHospAssets() {
  const css = `<style>
.hosp-slider{position:relative;width:100%;height:100%;overflow:hidden}
.hosp-slider .hosp-slide{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;opacity:0;transition:opacity .35s ease;pointer-events:none}
.hosp-slider .hosp-slide.active{opacity:1;position:relative;pointer-events:auto}
.hosp-slide-btn{position:absolute;top:50%;transform:translateY(-50%);width:30px;height:30px;border-radius:50%;background:rgba(0,0,0,.45);color:#fff;border:none;display:flex;align-items:center;justify-content:center;cursor:pointer;z-index:2;font-size:18px;line-height:1;padding:0}
.hosp-slide-btn:hover{background:rgba(0,0,0,.7)}
.hosp-slide-prev{left:8px}.hosp-slide-next{right:8px}
.hosp-slide-dots{position:absolute;bottom:8px;left:0;right:0;display:flex;gap:5px;justify-content:center;z-index:2}
.hosp-slide-dot{width:6px;height:6px;border-radius:50%;background:rgba(255,255,255,.55);cursor:pointer;padding:0;border:none}
.hosp-slide-dot.active{background:#fff}
.video-stage{position:relative;border-radius:14px;overflow:hidden;cursor:pointer;aspect-ratio:16/9;background:#0c0c0c;outline:none}
.video-stage img{width:100%;height:100%;object-fit:cover;display:block;opacity:.85;transition:opacity .3s}
.video-stage:hover img,.video-stage:focus-visible img{opacity:1}
.video-stage-ph{width:100%;height:100%;background:linear-gradient(135deg,#1a1a2e,#0c0c0c)}
.video-play-btn{position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);width:64px;height:64px;border-radius:50%;background:rgba(255,255,255,.92);color:#111;border:none;display:flex;align-items:center;justify-content:center;cursor:pointer}
.hosp-video-modal{position:fixed;inset:0;background:rgba(0,0,0,.9);display:none;align-items:center;justify-content:center;z-index:99999;padding:20px}
.hosp-video-modal.open{display:flex}
.hosp-video-modal .hosp-video-inner{position:relative;width:100%;max-width:960px;aspect-ratio:16/9;background:#000}
.hosp-video-modal iframe,.hosp-video-modal video{width:100%;height:100%;border:0;display:block}
.hosp-video-close{position:absolute;top:-40px;right:0;background:none;border:none;color:#fff;font-size:28px;line-height:1;cursor:pointer;padding:6px}
</style>`;

  const js = `<script>(function(){
function q(s,c){return (c||document).querySelector(s)}
function qa(s,c){return Array.prototype.slice.call((c||document).querySelectorAll(s))}
function openHospVideo(src,type){
  if(!src) return;
  var modal=q('.hosp-video-modal');
  if(!modal){
    modal=document.createElement('div');
    modal.className='hosp-video-modal';
    modal.innerHTML='<div class="hosp-video-inner"><button class="hosp-video-close" type="button" aria-label="Close">&times;</button><div class="hosp-video-media"></div></div>';
    document.body.appendChild(modal);
    modal.addEventListener('click',function(e){ if(e.target===modal) closeHospVideo(); });
    q('.hosp-video-close',modal).addEventListener('click',closeHospVideo);
  }
  var media=q('.hosp-video-media',modal);
  if(type==='youtube'||type==='vimeo'){
    var sep = src.indexOf('?')>-1 ? '&' : '?';
    media.innerHTML='<iframe src="'+src+sep+'autoplay=1" allow="autoplay; fullscreen; picture-in-picture" allowfullscreen title="Video"></iframe>';
  } else {
    media.innerHTML='<video src="'+src+'" controls autoplay playsinline></video>';
  }
  modal.classList.add('open');
}
function closeHospVideo(){
  var modal=q('.hosp-video-modal');
  if(!modal) return;
  modal.classList.remove('open');
  var media=q('.hosp-video-media',modal);
  if(media) media.innerHTML='';
}
document.addEventListener('click',function(e){
  var t=e.target;
  var prev=t.closest && t.closest('.hosp-slide-prev');
  var next=t.closest && t.closest('.hosp-slide-next');
  var dot =t.closest && t.closest('.hosp-slide-dot');
  if(prev||next||dot){
    e.preventDefault();
    var slider=(prev||next||dot).closest('.hosp-slider');
    if(!slider) return;
    var slides=qa('.hosp-slide',slider);
    var dots  =qa('.hosp-slide-dot',slider);
    var idx=parseInt(slider.getAttribute('data-idx')||'0',10);
    if(prev) idx=(idx-1+slides.length)%slides.length;
    else if(next) idx=(idx+1)%slides.length;
    else if(dot) idx=dots.indexOf(dot);
    slider.setAttribute('data-idx',idx);
    slides.forEach(function(s,i){ s.classList.toggle('active',i===idx); });
    dots.forEach(function(d,i){ d.classList.toggle('active',i===idx); });
    return;
  }
  var stage=t.closest && t.closest('.video-stage');
  if(stage){
    e.preventDefault();
    openHospVideo(stage.getAttribute('data-src'),stage.getAttribute('data-type'));
  }
});
document.addEventListener('keydown',function(e){
  var active=document.activeElement;
  if(active && active.classList && active.classList.contains('video-stage') && (e.key==='Enter'||e.key===' ')){
    e.preventDefault();
    openHospVideo(active.getAttribute('data-src'),active.getAttribute('data-type'));
  }
  if(e.key==='Escape') closeHospVideo();
});
})();</script>`;

  return { css, js };
}

// Booking-engine step 2: customer-facing calendar widget
function buildBookingWidgetAssets(site) {
  const siteIdJson = JSON.stringify((site && site.id) || '');

  const css = `<style>
.wcz-book-trigger{margin-top:10px;width:100%;padding:11px 18px;border-radius:2px;border:1.5px solid var(--gold,#c8a24a);background:transparent;color:var(--gold,#c8a24a);font-family:inherit;font-size:.78rem;font-weight:700;letter-spacing:.04em;text-transform:uppercase;cursor:pointer;transition:background .2s,color .2s}
.wcz-book-trigger:hover{background:var(--gold,#c8a24a);color:#0c0c0c}
#wcz-book-overlay{display:none;position:fixed;inset:0;z-index:400;background:rgba(0,0,0,.7);backdrop-filter:blur(3px)}
#wcz-book-overlay.open{display:block}
#wcz-book-modal{display:none;position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);z-index:401;width:min(420px,92vw);max-height:88vh;overflow-y:auto;background:#141414;color:#fff;border-radius:10px;box-shadow:0 20px 60px rgba(0,0,0,.5);font-family:inherit}
#wcz-book-modal.open{display:block}
.wcz-book-hdr{padding:18px 20px 14px;border-bottom:1px solid rgba(255,255,255,.08);display:flex;align-items:flex-start;justify-content:space-between;gap:10px;position:sticky;top:0;background:#141414;z-index:1}
.wcz-book-hdr h3{font-size:1.05rem;font-weight:600;margin:0 0 3px}
.wcz-book-hdr p{font-size:.72rem;letter-spacing:.08em;text-transform:uppercase;opacity:.5;margin:0}
.wcz-book-close{background:rgba(255,255,255,.08);border:none;color:#fff;width:30px;height:30px;border-radius:50%;font-size:1rem;cursor:pointer;flex-shrink:0;display:flex;align-items:center;justify-content:center}
.wcz-book-close:hover{background:rgba(255,255,255,.18)}
.wcz-book-body{padding:16px 20px 20px}
.wcz-book-cal-hdr{display:flex;align-items:center;justify-content:space-between;margin-bottom:10px}
.wcz-book-cal-hdr span{font-size:.85rem;font-weight:600}
.wcz-book-nav{background:rgba(255,255,255,.08);border:none;color:#fff;width:28px;height:28px;border-radius:50%;cursor:pointer;font-size:.9rem;display:flex;align-items:center;justify-content:center}
.wcz-book-nav:hover{background:rgba(255,255,255,.18)}
.wcz-book-nav:disabled{opacity:.25;cursor:not-allowed}
.wcz-book-weekdays{display:grid;grid-template-columns:repeat(7,1fr);gap:2px;margin-bottom:4px}
.wcz-book-weekdays span{text-align:center;font-size:.62rem;letter-spacing:.06em;text-transform:uppercase;opacity:.4;padding:4px 0}
.wcz-book-grid{display:grid;grid-template-columns:repeat(7,1fr);gap:2px}
.wcz-book-day{aspect-ratio:1;display:flex;align-items:center;justify-content:center;font-size:.78rem;border-radius:6px;cursor:pointer;background:rgba(255,255,255,.04);transition:background .15s,color .15s;border:none;color:#fff;font-family:inherit}
.wcz-book-day.empty{background:transparent;cursor:default}
.wcz-book-day.past,.wcz-book-day.booked{opacity:.25;cursor:not-allowed;text-decoration:line-through}
.wcz-book-day:hover:not(.past):not(.booked):not(.empty){background:rgba(200,162,74,.25)}
.wcz-book-day.today{box-shadow:inset 0 0 0 1px rgba(255,255,255,.3)}
.wcz-book-day.sel-start,.wcz-book-day.sel-end{background:var(--gold,#c8a24a);color:#0c0c0c;font-weight:700}
.wcz-book-day.in-range{background:rgba(200,162,74,.35)}
.wcz-book-legend{display:flex;gap:14px;margin-top:12px;flex-wrap:wrap}
.wcz-book-legend span{display:flex;align-items:center;gap:5px;font-size:.68rem;opacity:.6}
.wcz-book-legend i{width:10px;height:10px;border-radius:3px;display:inline-block}
.wcz-book-summary{margin-top:16px;padding:12px 14px;background:rgba(255,255,255,.04);border-radius:8px;font-size:.82rem;display:none}
.wcz-book-summary.show{display:block}
.wcz-book-summary strong{color:var(--gold,#c8a24a)}
.wcz-book-form{margin-top:14px;display:none;flex-direction:column;gap:10px}
.wcz-book-form.show{display:flex}
.wcz-book-form input{width:100%;padding:10px 12px;border-radius:6px;border:1.5px solid rgba(255,255,255,.15);background:rgba(255,255,255,.05);color:#fff;font-size:.85rem;font-family:inherit;box-sizing:border-box}
.wcz-book-form input::placeholder{color:rgba(255,255,255,.35)}
.wcz-book-form input:focus{outline:none;border-color:var(--gold,#c8a24a)}
.wcz-book-submit{margin-top:4px;padding:12px 18px;border-radius:6px;border:none;background:var(--gold,#c8a24a);color:#0c0c0c;font-weight:700;font-size:.8rem;letter-spacing:.04em;text-transform:uppercase;cursor:pointer;transition:background .2s}
.wcz-book-submit:hover{background:var(--gold2,#a87030)}
.wcz-book-submit:disabled{opacity:.5;cursor:not-allowed}
.wcz-book-msg{margin-top:12px;font-size:.78rem;padding:10px 12px;border-radius:6px;display:none}
.wcz-book-msg.show{display:block}
.wcz-book-msg.err{background:rgba(220,38,38,.15);color:#fca5a5}
.wcz-book-msg.ok{background:rgba(34,197,94,.15);color:#86efac}
.wcz-book-loading{text-align:center;padding:30px 0;font-size:.8rem;opacity:.5}
</style>`;

  const js = `<script>(function(){
'use strict';
var WCZ_BOOK_API = "https://bookings.websites.co.zw";
var WCZ_BOOK_SITE_ID = ${siteIdJson};

var MONTH_NAMES = ["January","February","March","April","May","June","July","August","September","October","November","December"];
var DAY_LABELS = ["Su","Mo","Tu","We","Th","Fr","Sa"];

var bookState = { resourceId:null, roomName:'', cache:{}, viewYear:0, viewMonth:0, selStart:null, selEnd:null };

function pad2(n){ return n < 10 ? '0'+n : ''+n; }
function fmtDate(d){ return d.getFullYear()+'-'+pad2(d.getMonth()+1)+'-'+pad2(d.getDate()); }
function parseDate(s){ var p=s.split('-'); return new Date(parseInt(p[0],10),parseInt(p[1],10)-1,parseInt(p[2],10)); }
function addDays(d,n){ var r=new Date(d); r.setDate(r.getDate()+n); return r; }
function todayDate(){ var t=new Date(); return new Date(t.getFullYear(),t.getMonth(),t.getDate()); }

function ensureModal(){
  if (document.getElementById('wcz-book-overlay')) return;
  var overlay = document.createElement('div');
  overlay.id = 'wcz-book-overlay';
  document.body.appendChild(overlay);
  var modal = document.createElement('div');
  modal.id = 'wcz-book-modal';
  modal.innerHTML =
    '<div class="wcz-book-hdr">' +
      '<div><h3 id="wcz-book-room-name">Room</h3><p>Check availability</p></div>' +
      '<button type="button" class="wcz-book-close" id="wcz-book-close" aria-label="Close">&#x2715;</button>' +
    '</div>' +
    '<div class="wcz-book-body">' +
      '<div id="wcz-book-loading" class="wcz-book-loading">Loading availability&hellip;</div>' +
      '<div id="wcz-book-cal-wrap" style="display:none">' +
        '<div class="wcz-book-cal-hdr">' +
          '<button type="button" class="wcz-book-nav" id="wcz-book-prev" aria-label="Previous month">&#8249;</button>' +
          '<span id="wcz-book-month-label"></span>' +
          '<button type="button" class="wcz-book-nav" id="wcz-book-next" aria-label="Next month">&#8250;</button>' +
        '</div>' +
        '<div class="wcz-book-weekdays">' + DAY_LABELS.map(function(d){return '<span>'+d+'</span>';}).join('') + '</div>' +
        '<div class="wcz-book-grid" id="wcz-book-grid"></div>' +
        '<div class="wcz-book-legend">' +
          '<span><i style="background:var(--gold,#c8a24a)"></i>Selected</span>' +
          '<span><i style="background:rgba(255,255,255,.15);text-decoration:line-through"></i>Booked</span>' +
          '<span><i style="background:rgba(255,255,255,.04)"></i>Available</span>' +
        '</div>' +
        '<div class="wcz-book-summary" id="wcz-book-summary"></div>' +
        '<div class="wcz-book-form" id="wcz-book-form">' +
          '<input type="text" id="wcz-book-name" placeholder="Your full name" maxlength="80">' +
          '<input type="tel" id="wcz-book-phone" placeholder="WhatsApp / phone number" maxlength="30">' +
          '<button type="button" class="wcz-book-submit" id="wcz-book-submit">Request booking</button>' +
        '</div>' +
        '<div class="wcz-book-msg" id="wcz-book-msg"></div>' +
      '</div>' +
    '</div>';
  document.body.appendChild(modal);
}

function openBooking(resourceId, roomName){
  ensureModal();
  bookState.resourceId = resourceId;
  bookState.roomName = roomName || 'Room';
  bookState.selStart = null;
  bookState.selEnd = null;
  var t = todayDate();
  bookState.viewYear = t.getFullYear();
  bookState.viewMonth = t.getMonth();
  document.getElementById('wcz-book-room-name').textContent = bookState.roomName;
  document.getElementById('wcz-book-overlay').classList.add('open');
  document.getElementById('wcz-book-modal').classList.add('open');
  document.body.style.overflow = 'hidden';
  resetFormState();
  loadAvailability(resourceId);
}

function closeBooking(){
  var ov=document.getElementById('wcz-book-overlay'), md=document.getElementById('wcz-book-modal');
  if(ov) ov.classList.remove('open');
  if(md) md.classList.remove('open');
  document.body.style.overflow = '';
}

function resetFormState(){
  var sum=document.getElementById('wcz-book-summary'); if(sum){ sum.classList.remove('show'); sum.textContent=''; }
  var form=document.getElementById('wcz-book-form'); if(form) form.classList.remove('show');
  var msg=document.getElementById('wcz-book-msg'); if(msg){ msg.className='wcz-book-msg'; msg.textContent=''; }
  var nameEl=document.getElementById('wcz-book-name'); if(nameEl) nameEl.value='';
  var phoneEl=document.getElementById('wcz-book-phone'); if(phoneEl) phoneEl.value='';
  var submitBtn=document.getElementById('wcz-book-submit'); if(submitBtn){ submitBtn.disabled=false; submitBtn.textContent='Request booking'; }
}

function loadAvailability(resourceId){
  var loading=document.getElementById('wcz-book-loading');
  var calWrap=document.getElementById('wcz-book-cal-wrap');
  if (bookState.cache[resourceId]) {
    if(loading) loading.style.display='none';
    if(calWrap) calWrap.style.display='block';
    renderCalendar();
    return;
  }
  if(loading){ loading.style.display='block'; loading.textContent='Loading availability\u2026'; }
  if(calWrap) calWrap.style.display='none';
  var from = fmtDate(todayDate());
  var to = fmtDate(addDays(todayDate(), 365));
  var url = WCZ_BOOK_API + '/availability?resource_id=' + encodeURIComponent(resourceId) + '&from=' + from + '&to=' + to;
  fetch(url).then(function(r){ return r.json(); }).then(function(data){
    bookState.cache[resourceId] = (data && data.booked_ranges) ? data.booked_ranges : [];
    if(loading) loading.style.display='none';
    if(calWrap) calWrap.style.display='block';
    renderCalendar();
  }).catch(function(){
    if(loading) loading.textContent = "Couldn't load availability \u2014 please try again or contact us directly.";
  });
}

function isDateBooked(dateStr){
  var ranges = bookState.cache[bookState.resourceId] || [];
  for (var i=0;i<ranges.length;i++){
    if (dateStr >= ranges[i].start_date && dateStr < ranges[i].end_date) return true;
  }
  return false;
}

function rangeHasBookedDay(startStr, endStr){
  var d = parseDate(startStr);
  var end = parseDate(endStr);
  while (d < end) {
    if (isDateBooked(fmtDate(d))) return true;
    d = addDays(d,1);
  }
  return false;
}

function renderCalendar(){
  var label = document.getElementById('wcz-book-month-label');
  var grid = document.getElementById('wcz-book-grid');
  var prevBtn = document.getElementById('wcz-book-prev');
  if (!grid) return;
  var y = bookState.viewYear, m = bookState.viewMonth;
  if (label) label.textContent = MONTH_NAMES[m] + ' ' + y;
  var today = todayDate();
  var isCurrentMonth = (y === today.getFullYear() && m === today.getMonth());
  if (prevBtn) prevBtn.disabled = isCurrentMonth;

  var firstDay = new Date(y, m, 1);
  var startOffset = firstDay.getDay();
  var daysInMonth = new Date(y, m+1, 0).getDate();

  var cells = [];
  for (var i=0;i<startOffset;i++) cells.push(null);
  for (var d=1; d<=daysInMonth; d++) cells.push(d);

  var html = '';
  cells.forEach(function(dayNum){
    if (dayNum === null) { html += '<div class="wcz-book-day empty"></div>'; return; }
    var dateObj = new Date(y, m, dayNum);
    var dateStr = fmtDate(dateObj);
    var classes = ['wcz-book-day'];
    var isPast = dateObj < today;
    var isToday = dateObj.getTime() === today.getTime();
    var booked = isDateBooked(dateStr);
    if (isPast) classes.push('past');
    else if (booked) classes.push('booked');
    if (isToday) classes.push('today');
    if (bookState.selStart && dateStr === bookState.selStart) classes.push('sel-start');
    if (bookState.selEnd && dateStr === bookState.selEnd) classes.push('sel-end');
    if (bookState.selStart && bookState.selEnd && dateStr > bookState.selStart && dateStr < bookState.selEnd) classes.push('in-range');
    var disabledAttr = (isPast || booked) ? ' disabled' : '';
    html += '<button type="button" class="'+classes.join(' ')+'" data-date="'+dateStr+'"'+disabledAttr+'>'+dayNum+'</button>';
  });
  grid.innerHTML = html;
  updateSummary();
}

function updateSummary(){
  var sum = document.getElementById('wcz-book-summary');
  var form = document.getElementById('wcz-book-form');
  if (!sum || !form) return;
  if (bookState.selStart && bookState.selEnd) {
    var nights = Math.round((parseDate(bookState.selEnd) - parseDate(bookState.selStart)) / 86400000);
    sum.innerHTML = '<strong>'+bookState.selStart+'</strong> \u2192 <strong>'+bookState.selEnd+'</strong> \u00b7 ' + nights + ' night' + (nights===1?'':'s');
    sum.classList.add('show');
    form.classList.add('show');
  } else if (bookState.selStart) {
    sum.innerHTML = 'Check-in: <strong>'+bookState.selStart+'</strong> \u2014 now pick a check-out date';
    sum.classList.add('show');
    form.classList.remove('show');
  } else {
    sum.classList.remove('show');
    form.classList.remove('show');
  }
}

function handleDayClick(dateStr){
  var msg = document.getElementById('wcz-book-msg');
  if (!bookState.selStart || (bookState.selStart && bookState.selEnd)) {
    bookState.selStart = dateStr;
    bookState.selEnd = null;
    if (msg) { msg.className='wcz-book-msg'; msg.textContent=''; }
  } else {
    if (dateStr <= bookState.selStart) {
      bookState.selStart = dateStr;
      bookState.selEnd = null;
    } else if (rangeHasBookedDay(bookState.selStart, dateStr)) {
      if (msg) { msg.className='wcz-book-msg err show'; msg.textContent='Those dates include an unavailable night \u2014 pick a shorter range.'; }
      bookState.selStart = dateStr;
      bookState.selEnd = null;
    } else {
      bookState.selEnd = dateStr;
      if (msg) { msg.className='wcz-book-msg'; msg.textContent=''; }
    }
  }
  renderCalendar();
}

function submitBooking(){
  var nameEl = document.getElementById('wcz-book-name');
  var phoneEl = document.getElementById('wcz-book-phone');
  var msg = document.getElementById('wcz-book-msg');
  var submitBtn = document.getElementById('wcz-book-submit');
  var name = nameEl ? nameEl.value.trim() : '';
  var phone = phoneEl ? phoneEl.value.trim() : '';
  if (!name || !phone) {
    if (msg) { msg.className='wcz-book-msg err show'; msg.textContent='Please add your name and phone number.'; }
    return;
  }
  if (!bookState.selStart || !bookState.selEnd) return;
  if (submitBtn) { submitBtn.disabled = true; submitBtn.textContent = 'Sending\u2026'; }
  if (msg) { msg.className='wcz-book-msg'; msg.textContent=''; }
  fetch(WCZ_BOOK_API + '/bookings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      site_id: WCZ_BOOK_SITE_ID,
      resource_id: bookState.resourceId,
      start_date: bookState.selStart,
      end_date: bookState.selEnd,
      customer_name: name,
      customer_phone: phone
    })
  }).then(function(r){
    return r.json().then(function(data){ return { ok: r.ok, status: r.status, data: data }; });
  }).then(function(res){
    if (!res.ok) {
      if (res.status === 409) {
        if (msg) { msg.className='wcz-book-msg err show'; msg.textContent='Those dates were just booked by someone else \u2014 please pick different dates.'; }
        delete bookState.cache[bookState.resourceId];
        bookState.selStart = null; bookState.selEnd = null;
        loadAvailability(bookState.resourceId);
      } else {
        if (msg) { msg.className='wcz-book-msg err show'; msg.textContent=(res.data && res.data.error) || "Couldn't send your request \u2014 please try again."; }
      }
      if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = 'Request booking'; }
      return;
    }
    if (msg) { msg.className='wcz-book-msg ok show'; msg.textContent='Request sent! We will confirm your booking shortly \u2014 keep an eye on WhatsApp.'; }
    if (submitBtn) { submitBtn.textContent = 'Requested \u2713'; }
    var range = bookState.cache[bookState.resourceId] || [];
    range.push({ start_date: bookState.selStart, end_date: bookState.selEnd });
    bookState.cache[bookState.resourceId] = range;
  }).catch(function(){
    if (msg) { msg.className='wcz-book-msg err show'; msg.textContent='Network error \u2014 please try again.'; }
    if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = 'Request booking'; }
  });
}

document.addEventListener('click', function(e){
  var trigger = e.target.closest && e.target.closest('.wcz-book-trigger');
  if (trigger) {
    var card = trigger.closest('[data-resource-id]');
    if (card) {
      var rid = card.getAttribute('data-resource-id');
      var rname = card.getAttribute('data-room-name') || 'Room';
      if (rid) openBooking(rid, rname);
    }
    return;
  }
  if (e.target.id === 'wcz-book-close' || e.target.id === 'wcz-book-overlay') { closeBooking(); return; }
  if (e.target.id === 'wcz-book-prev') {
    bookState.viewMonth--; if (bookState.viewMonth<0){bookState.viewMonth=11;bookState.viewYear--;}
    renderCalendar(); return;
  }
  if (e.target.id === 'wcz-book-next') {
    bookState.viewMonth++; if (bookState.viewMonth>11){bookState.viewMonth=0;bookState.viewYear++;}
    renderCalendar(); return;
  }
  if (e.target.id === 'wcz-book-submit') { submitBooking(); return; }
  var dayBtn = e.target.closest && e.target.closest('.wcz-book-day');
  if (dayBtn && !dayBtn.disabled && !dayBtn.classList.contains('empty')) {
    handleDayClick(dayBtn.getAttribute('data-date'));
  }
});

document.addEventListener('keydown', function(e){
  if (e.key === 'Escape') {
    var md = document.getElementById('wcz-book-modal');
    if (md && md.classList.contains('open')) closeBooking();
  }
});
})();</script>`;

  return { css, js };
}

// Slot booking widget
function buildSlotBookingWidgetAssets(site, options) {
  options = options || {};
  const accent = options.accentColor || '#7c3aed';
  const resourceLabel = options.resourceLabel || 'provider';
  const siteIdJson = JSON.stringify((site && site.id) || '');
  const resourceLabelJson = JSON.stringify(resourceLabel);

  const css = `<style>
.wcz-slot-book-trigger{cursor:pointer}
.wcz-slot-book-standalone{margin-top:10px;width:100%;padding:11px 18px;border-radius:6px;border:1.5px solid ${accent};background:transparent;color:${accent};font-family:inherit;font-size:.8rem;font-weight:700;letter-spacing:.02em;cursor:pointer;transition:background .2s,color .2s}
.wcz-slot-book-standalone:hover{background:${accent};color:#fff}
#wcz-sb-overlay{display:none;position:fixed;inset:0;z-index:400;background:rgba(20,10,14,.55);backdrop-filter:blur(3px)}
#wcz-sb-overlay.open{display:block}
#wcz-sb-modal{display:none;position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);z-index:401;width:min(420px,92vw);max-height:88vh;overflow-y:auto;background:#fff;color:#2a1c20;border-radius:14px;box-shadow:0 20px 60px rgba(0,0,0,.25);font-family:inherit}
#wcz-sb-modal.open{display:block}
.wcz-sb-hdr{padding:18px 20px 14px;border-bottom:1px solid rgba(0,0,0,.08);display:flex;align-items:flex-start;justify-content:space-between;gap:10px;position:sticky;top:0;background:#fff;z-index:1}
.wcz-sb-hdr h3{font-size:1.05rem;font-weight:600;margin:0 0 3px}
.wcz-sb-hdr p{font-size:.72rem;letter-spacing:.06em;text-transform:uppercase;opacity:.5;margin:0}
.wcz-sb-close{background:rgba(0,0,0,.06);border:none;color:#2a1c20;width:30px;height:30px;border-radius:50%;font-size:1rem;cursor:pointer;flex-shrink:0;display:flex;align-items:center;justify-content:center}
.wcz-sb-close:hover{background:rgba(0,0,0,.12)}
.wcz-sb-body{padding:16px 20px 20px}
.wcz-sb-back{background:none;border:none;color:${accent};font-size:.82rem;font-weight:600;cursor:pointer;padding:0 0 14px;display:flex;align-items:center;gap:5px}
.wcz-sb-crumb{font-size:.68rem;letter-spacing:.06em;text-transform:uppercase;opacity:.45;margin-bottom:12px}
.wcz-sb-grid{display:grid;grid-template-columns:1fr;gap:8px}
.wcz-sb-svc-card,.wcz-sb-stylist-card{border:1.5px solid rgba(0,0,0,.08);border-radius:10px;padding:12px 14px;cursor:pointer;transition:border-color .15s,background .15s;display:flex;align-items:center;justify-content:space-between;gap:10px}
.wcz-sb-svc-card:hover,.wcz-sb-stylist-card:hover{border-color:${accent};background:rgba(0,0,0,.03)}
.wcz-sb-svc-name,.wcz-sb-stylist-name{font-weight:600;font-size:.92rem}
.wcz-sb-svc-meta{font-size:.76rem;opacity:.55;margin-top:2px}
.wcz-sb-svc-price{font-weight:700;font-size:.92rem;color:${accent};white-space:nowrap}
.wcz-sb-days{display:flex;gap:8px;overflow-x:auto;padding-bottom:6px;margin-bottom:14px}
.wcz-sb-day{flex:0 0 auto;width:56px;padding:10px 0;border-radius:10px;border:1.5px solid rgba(0,0,0,.08);background:#fff;cursor:pointer;text-align:center;font-family:inherit}
.wcz-sb-day:hover{border-color:${accent}}
.wcz-sb-day.active{background:${accent};border-color:${accent};color:#fff}
.wcz-sb-day-dow{font-size:.62rem;letter-spacing:.04em;text-transform:uppercase;opacity:.6}
.wcz-sb-day.active .wcz-sb-day-dow{opacity:.85}
.wcz-sb-day-num{font-size:1rem;font-weight:700;margin-top:2px}
.wcz-sb-times{display:grid;grid-template-columns:repeat(auto-fill,minmax(72px,1fr));gap:8px}
.wcz-sb-time{padding:9px 0;border-radius:8px;border:1.5px solid rgba(0,0,0,.08);background:#fff;font-family:inherit;font-size:.82rem;font-weight:600;cursor:pointer}
.wcz-sb-time:hover{border-color:${accent}}
.wcz-sb-time.sel{background:${accent};border-color:${accent};color:#fff}
.wcz-sb-empty{font-size:.85rem;opacity:.55;padding:20px 0;text-align:center}
.wcz-sb-summary{margin:4px 0 16px;padding:12px 14px;background:rgba(0,0,0,.04);border-radius:10px;font-size:.85rem;line-height:1.6}
.wcz-sb-summary strong{color:${accent}}
.wcz-sb-form{display:flex;flex-direction:column;gap:10px}
.wcz-sb-form input{width:100%;padding:10px 12px;border-radius:8px;border:1.5px solid rgba(0,0,0,.12);background:#fff;color:#2a1c20;font-size:.85rem;font-family:inherit;box-sizing:border-box}
.wcz-sb-form input:focus{outline:none;border-color:${accent}}
.wcz-sb-submit{margin-top:4px;padding:12px 18px;border-radius:8px;border:none;background:${accent};color:#fff;font-weight:700;font-size:.85rem;cursor:pointer;transition:opacity .2s}
.wcz-sb-submit:disabled{opacity:.5;cursor:not-allowed}
.wcz-sb-msg{margin-top:12px;font-size:.78rem;padding:10px 12px;border-radius:8px;display:none}
.wcz-sb-msg.show{display:block}
.wcz-sb-msg.err{background:#fdecea;color:#a83226}
.wcz-sb-msg.ok{background:#e8f5ee;color:#146c3c}
.wcz-sb-loading{text-align:center;padding:30px 0;font-size:.82rem;opacity:.5}
.wcz-sb-continue{margin-top:4px;padding:12px 18px;border-radius:8px;border:none;background:${accent};color:#fff;font-weight:700;font-size:.85rem;cursor:pointer;width:100%}
.wcz-sb-continue:disabled{opacity:.4;cursor:not-allowed}
</style>`;

  const js = `<script>(function(){
'use strict';
var WCZ_SB_API = "https://bookings.websites.co.zw";
var WCZ_SB_SITE_ID = ${siteIdJson};
var WCZ_SB_LABEL = ${resourceLabelJson};
var DOW = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];
var DAY_COUNT = 14;

var sb = { service:null, stylist:null, resourceId:null, resources:[], date:null, time:null, slot:null };

function pad2(n){ return n < 10 ? '0'+n : ''+n; }
function fmtDate(d){ return d.getFullYear()+'-'+pad2(d.getMonth()+1)+'-'+pad2(d.getDate()); }
function todayDate(){ var t=new Date(); return new Date(t.getFullYear(),t.getMonth(),t.getDate()); }
function addDays(d,n){ var r=new Date(d); r.setDate(r.getDate()+n); return r; }

function ensureModal(){
  if (document.getElementById('wcz-sb-overlay')) return;
  var overlay = document.createElement('div');
  overlay.id = 'wcz-sb-overlay';
  document.body.appendChild(overlay);
  var modal = document.createElement('div');
  modal.id = 'wcz-sb-modal';
  modal.innerHTML =
    '<div class="wcz-sb-hdr">' +
      '<div><h3 id="wcz-sb-title">Book</h3><p id="wcz-sb-subtitle">Choose a time</p></div>' +
      '<button type="button" class="wcz-sb-close" id="wcz-sb-close" aria-label="Close">&#x2715;</button>' +
    '</div>' +
    '<div class="wcz-sb-body" id="wcz-sb-body"></div>';
  document.body.appendChild(modal);
}

function openBooking(trigger){
  ensureModal();
  var serviceId = trigger.getAttribute('data-service-id');
  if (!serviceId) {
    sb.service = null; sb.stylist = null; sb.resourceId = null; sb.resources = []; sb.date = null; sb.time = null; sb.slot = null;
    document.getElementById('wcz-sb-title').textContent = 'Book an appointment';
    document.getElementById('wcz-sb-subtitle').textContent = 'Choose a service';
    document.getElementById('wcz-sb-overlay').classList.add('open');
    document.getElementById('wcz-sb-modal').classList.add('open');
    document.body.style.overflow = 'hidden';
    renderServiceBrowseStep();
    return;
  }
  sb.service = {
    id: serviceId,
    name: trigger.getAttribute('data-service-name') || 'Service',
    durationMin: parseInt(trigger.getAttribute('data-duration-min'), 10) || 30,
    price: trigger.getAttribute('data-price') || '',
    staffMode: trigger.getAttribute('data-staff-mode') || 'choose',
  };
  sb.stylist = null; sb.resourceId = null; sb.resources = []; sb.date = null; sb.time = null; sb.slot = null;
  document.getElementById('wcz-sb-title').textContent = sb.service.name;
  document.getElementById('wcz-sb-subtitle').textContent = sb.service.durationMin + ' min' + (sb.service.price ? ' \\u00b7 ' + sb.service.price : '');
  document.getElementById('wcz-sb-overlay').classList.add('open');
  document.getElementById('wcz-sb-modal').classList.add('open');
  document.body.style.overflow = 'hidden';
  resolveStaffStep();
}

function renderServiceBrowseStep(){
  var body = document.getElementById('wcz-sb-body');
  body.innerHTML = '<div class="wcz-sb-loading">Loading services\\u2026</div>';
  fetch(WCZ_SB_API + '/services?site_id=' + encodeURIComponent(WCZ_SB_SITE_ID))
    .then(function(r){ return r.json(); })
    .then(function(data){
      var services = (data && data.services) ? data.services : [];
      if (!services.length) {
        body.innerHTML = '<div class="wcz-sb-empty">No bookable services yet \\u2014 please contact us directly.</div>';
        return;
      }
      var html = '<div class="wcz-sb-crumb">Choose a service</div><div class="wcz-sb-grid">';
      services.forEach(function(s){
        var priceLabel = s.price ? ' \\u00b7 ' + s.price : '';
        html += '<div class="wcz-sb-svc-card" data-sid="' + s.id + '" data-sname="' + s.name + '" data-sdur="' + s.duration_min + '" data-sprice="' + (s.price || '') + '" data-smode="' + s.staff_mode + '">' +
          '<div><div class="wcz-sb-svc-name">' + s.name + '</div><div class="wcz-sb-svc-meta">' + s.duration_min + ' min' + priceLabel + '</div></div>' +
          '</div>';
      });
      html += '</div>';
      body.innerHTML = html;
      body.querySelectorAll('.wcz-sb-svc-card').forEach(function(card){
        card.addEventListener('click', function(){
          sb.service = {
            id: card.getAttribute('data-sid'),
            name: card.getAttribute('data-sname'),
            durationMin: parseInt(card.getAttribute('data-sdur'), 10) || 30,
            price: card.getAttribute('data-sprice') || '',
            staffMode: card.getAttribute('data-smode') || 'choose',
          };
          document.getElementById('wcz-sb-title').textContent = sb.service.name;
          document.getElementById('wcz-sb-subtitle').textContent = sb.service.durationMin + ' min' + (sb.service.price ? ' \\u00b7 ' + sb.service.price : '');
          resolveStaffStep();
        });
      });
    })
    .catch(function(){
      body.innerHTML = '<div class="wcz-sb-empty">Could not load services \\u2014 please try again.</div>';
    });
}

function closeBooking(){
  var ov=document.getElementById('wcz-sb-overlay'), md=document.getElementById('wcz-sb-modal');
  if(ov) ov.classList.remove('open');
  if(md) md.classList.remove('open');
  document.body.style.overflow = '';
}

function resolveStaffStep(){
  var body = document.getElementById('wcz-sb-body');
  body.innerHTML = '<div class="wcz-sb-loading">Loading\\u2026</div>';
  if (sb.service.staffMode === 'any') {
    sb.resourceId = null;
    renderDateStep();
    return;
  }
  fetch(WCZ_SB_API + '/resources?site_id=' + encodeURIComponent(WCZ_SB_SITE_ID))
    .then(function(r){ return r.json(); })
    .then(function(data){
      sb.resources = (data && data.resources) ? data.resources : [];
      if (sb.resources.length <= 1) {
        sb.resourceId = sb.resources.length === 1 ? sb.resources[0].id : null;
        sb.stylist = sb.resources.length === 1 ? sb.resources[0] : null;
        renderDateStep();
      } else {
        renderStylistStep();
      }
    })
    .catch(function(){
      sb.resourceId = null;
      renderDateStep();
    });
}

function renderStylistStep(){
  var body = document.getElementById('wcz-sb-body');
  var html = '<div class="wcz-sb-crumb">Choose a ' + WCZ_SB_LABEL + '</div><div class="wcz-sb-grid">';
  sb.resources.forEach(function(r){
    html += '<div class="wcz-sb-stylist-card" data-rid="' + r.id + '"><span class="wcz-sb-stylist-name">' + r.name + '</span></div>';
  });
  html += '</div>';
  body.innerHTML = html;
  body.querySelectorAll('.wcz-sb-stylist-card').forEach(function(card){
    card.addEventListener('click', function(){
      var rid = card.getAttribute('data-rid');
      sb.resourceId = rid;
      sb.stylist = sb.resources.filter(function(r){ return r.id === rid; })[0] || null;
      renderDateStep();
    });
  });
}

function renderDateStep(){
  var body = document.getElementById('wcz-sb-body');
  var backHtml = (sb.service.staffMode === 'choose' && sb.resources.length > 1)
    ? '<button type="button" class="wcz-sb-back" id="wcz-sb-back-1">&#8249; Back</button>' : '';
  body.innerHTML = backHtml +
    '<div class="wcz-sb-crumb">Choose a day</div>' +
    '<div class="wcz-sb-days" id="wcz-sb-days"></div>' +
    '<div id="wcz-sb-times-wrap"></div>';
  var backBtn = document.getElementById('wcz-sb-back-1');
  if (backBtn) backBtn.addEventListener('click', renderStylistStep);

  var daysEl = document.getElementById('wcz-sb-days');
  var today = todayDate();
  for (var i = 0; i < DAY_COUNT; i++) {
    var d = addDays(today, i);
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'wcz-sb-day';
    btn.setAttribute('data-date', fmtDate(d));
    btn.innerHTML = '<div class="wcz-sb-day-dow">' + DOW[d.getDay()] + '</div><div class="wcz-sb-day-num">' + d.getDate() + '</div>';
    btn.addEventListener('click', function(){
      daysEl.querySelectorAll('.wcz-sb-day').forEach(function(x){ x.classList.remove('active'); });
      this.classList.add('active');
      sb.date = this.getAttribute('data-date');
      sb.time = null;
      loadTimes();
    });
    daysEl.appendChild(btn);
  }
  daysEl.firstChild.click();
}

function loadTimes(){
  var wrap = document.getElementById('wcz-sb-times-wrap');
  wrap.innerHTML = '<div class="wcz-sb-loading">Loading times\\u2026</div>';
  var url = WCZ_SB_API + '/available-slots?service_id=' + encodeURIComponent(sb.service.id) + '&date=' + encodeURIComponent(sb.date);
  url += sb.resourceId ? '&resource_id=' + encodeURIComponent(sb.resourceId) : '&site_id=' + encodeURIComponent(WCZ_SB_SITE_ID);
  fetch(url).then(function(r){ return r.json(); }).then(function(data){
    var slots = (data && data.slots) ? data.slots : [];
    if (!slots.length) {
      wrap.innerHTML = '<div class="wcz-sb-empty">No times available this day \\u2014 try another date.</div>';
      return;
    }
    var html = '<div class="wcz-sb-times">';
    slots.forEach(function(s){
      html += '<button type="button" class="wcz-sb-time" data-time="' + s.start_time + '">' + s.start_time + '</button>';
    });
    html += '</div><button type="button" class="wcz-sb-continue" id="wcz-sb-continue" disabled>Continue</button>';
    wrap.innerHTML = html;
    var continueBtn = document.getElementById('wcz-sb-continue');
    wrap.querySelectorAll('.wcz-sb-time').forEach(function(btn){
      btn.addEventListener('click', function(){
        wrap.querySelectorAll('.wcz-sb-time').forEach(function(x){ x.classList.remove('sel'); });
        this.classList.add('sel');
        sb.time = this.getAttribute('data-time');
        continueBtn.disabled = false;
      });
    });
    continueBtn.addEventListener('click', renderConfirmStep);
  }).catch(function(){
    wrap.innerHTML = '<div class="wcz-sb-empty">Could not load times \\u2014 please try again.</div>';
  });
}

function renderConfirmStep(){
  var body = document.getElementById('wcz-sb-body');
  var withWhom = sb.stylist ? sb.stylist.name : ('our next available ' + WCZ_SB_LABEL);
  body.innerHTML =
    '<button type="button" class="wcz-sb-back" id="wcz-sb-back-2">&#8249; Back</button>' +
    '<div class="wcz-sb-summary"><strong>' + sb.service.name + '</strong><br>With ' + withWhom + '<br>' + sb.date + ' at ' + sb.time + '</div>' +
    '<div class="wcz-sb-form">' +
      '<input type="text" id="wcz-sb-name" placeholder="Your full name" maxlength="80">' +
      '<input type="tel" id="wcz-sb-phone" placeholder="WhatsApp / phone number" maxlength="30">' +
      '<button type="button" class="wcz-sb-submit" id="wcz-sb-submit">Request booking</button>' +
    '</div>' +
    '<div class="wcz-sb-msg" id="wcz-sb-msg"></div>';
  document.getElementById('wcz-sb-back-2').addEventListener('click', function(){
    sb.time = null;
    renderDateStep();
    var dayBtn = document.querySelector('.wcz-sb-day[data-date="' + sb.date + '"]');
    if (dayBtn) dayBtn.click();
  });
  document.getElementById('wcz-sb-submit').addEventListener('click', submitBooking);
}

function submitBooking(){
  var nameEl = document.getElementById('wcz-sb-name');
  var phoneEl = document.getElementById('wcz-sb-phone');
  var msg = document.getElementById('wcz-sb-msg');
  var submitBtn = document.getElementById('wcz-sb-submit');
  var name = nameEl ? nameEl.value.trim() : '';
  var phone = phoneEl ? phoneEl.value.trim() : '';
  if (!name || !phone) {
    if (msg) { msg.className = 'wcz-sb-msg err show'; msg.textContent = 'Please add your name and phone number.'; }
    return;
  }
  submitBtn.disabled = true; submitBtn.textContent = 'Sending\\u2026';
  if (msg) { msg.className = 'wcz-sb-msg'; msg.textContent = ''; }
  var payload = {
    site_id: WCZ_SB_SITE_ID,
    service_id: sb.service.id,
    date: sb.date,
    start_time: sb.time,
    customer_name: name,
    customer_phone: phone,
  };
  if (sb.resourceId) payload.resource_id = sb.resourceId;
  fetch(WCZ_SB_API + '/bookings/slot', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  }).then(function(r){
    return r.json().then(function(data){ return { ok: r.ok, status: r.status, data: data }; });
  }).then(function(res){
    if (!res.ok) {
      if (res.status === 409) {
        if (msg) { msg.className = 'wcz-sb-msg err show'; msg.textContent = 'That time was just taken \\u2014 pick another.'; }
        sb.time = null;
        renderDateStep();
        var dayBtn = document.querySelector('.wcz-sb-day[data-date="' + sb.date + '"]');
        if (dayBtn) dayBtn.click();
      } else {
        if (msg) { msg.className = 'wcz-sb-msg err show'; msg.textContent = (res.data && res.data.error) || "Couldn't send your request \\u2014 please try again."; }
        submitBtn.disabled = false; submitBtn.textContent = 'Request booking';
      }
      return;
    }
    if (msg) { msg.className = 'wcz-sb-msg ok show'; msg.textContent = 'Request sent! We will confirm shortly on WhatsApp.'; }
    submitBtn.textContent = 'Requested \\u2713';
  }).catch(function(){
    if (msg) { msg.className = 'wcz-sb-msg err show'; msg.textContent = 'Network error \\u2014 please try again.'; }
    submitBtn.disabled = false; submitBtn.textContent = 'Request booking';
  });
}

document.addEventListener('click', function(e){
  var trigger = e.target.closest && e.target.closest('.wcz-slot-book-trigger');
  if (trigger) { openBooking(trigger); return; }
  if (e.target.id === 'wcz-sb-close' || e.target.id === 'wcz-sb-overlay') { closeBooking(); return; }
});
})();</script>`;

  return { css: css, js: js };
}

const HOSP_TEXT_KEYS = [
  'nav_rooms_label', 'nav_about_label', 'nav_amenities_label', 'nav_conference_label',
  'nav_packages_label', 'nav_dining_label', 'nav_gallery_label', 'nav_reviews_label',
  'nav_contact_label', 'nav_cta_label', 'hero_headline', 'hero_subtext', 'hi_hero_headline',
  'hi_hero_subtext', 'hero_cta_label', 'hero_secondary_label', 'about_eyebrow',
  'about_heading', 'rooms_eyebrow', 'rooms_heading', 'amenities_eyebrow', 'amenities_heading',
  'conference_eyebrow', 'conference_heading', 'packages_eyebrow', 'packages_heading',
  'dining_eyebrow', 'dining_name', 'dining_description', 'dining_cta_label',
  'experiences_eyebrow', 'experiences_heading', 'gallery_eyebrow', 'gallery_heading',
  'reviews_eyebrow', 'reviews_heading', 'hours_heading', 'location_eyebrow',
  'location_heading', 'location_cta_label', 'cta_eyebrow', 'cta_heading', 'cta_button_label',
  'sticky_label', 'featured_eyebrow', 'room_price_unit', 'venue_price_unit', 'amenities_sub',
  'conference_sub', 'packages_sub', 'experiences_sub', 'gallery_sub', 'location_body',
  'cta_body', 'cta_note'
];

function normalizeContent(raw, templateId) {
  if (!raw) return {};

  const inner = (raw.content && typeof raw.content === 'object' && !Array.isArray(raw.content)) ?
    raw.content : raw;
  const theme = raw.theme || {};
  const images = inner.images || {};

  const gallery = Array.isArray(inner.gallery) ?
    inner.gallery :
    Array.isArray(images.gallery) ?
    images.gallery.map(u => (typeof u === 'string' ? { url: u, caption: '' } : u)) :
    [];

  const normalized = {
    theme,
    business_name: inner.business_name || inner.name || '',
    name: inner.business_name || inner.name || '',
    tagline: inner.tagline || '',
    about: inner.about || '',
    phone: inner.contact?.phone || inner.contact?.whatsapp || inner.phone || inner._brief?.phone || '',
    email: inner.contact?.email || inner.email || inner._brief?.email || '',
    address: inner.contact?.address || inner.address || inner.location || '',
    location: inner.location || inner.contact?.address || '',
    hero_image: images.hero || inner.hero_image || '',
    hero_image_url: images.hero || inner.hero_image_url || inner.hero_image || '',
    logo_url: images.logo || inner.logo_url || '',
    primary_color: inner.primary_color || theme.accent || '',
    images,
    gallery,
    services: normalizeServices(normalizeItemImages(inner.services)),
    services_intro: inner.services_intro || '',
    menu: normalizeItemImages(inner.menu),
    products: normalizeItemImages(inner.products),
    rooms: normalizeItemImages(inner.rooms),
    amenities: Array.isArray(inner.amenities) ? inner.amenities : [],
    experiences: normalizeItemImages(inner.experiences),
    conference: normalizeItemImages(inner.conference || inner.conferencing || inner.venues),
    packages: Array.isArray(inner.packages) ? inner.packages : [],
    dining: (inner.dining && typeof inner.dining === 'object') ? inner.dining : null,
    about_image: inner.about_image || '',
    listings: normalizeItemImages(inner.listings),
    team: normalizeItemImages(inner.team),
    testimonials: inner.testimonials || [],
    stats: inner.stats || [],
    events: inner.events || inner.schedule || [],
    hours: normalizeHours(inner.hours) || null,
    socials: inner.socials || {},
    seo: inner.seo || {},
    contact: inner.contact || {},
    map_embed_url: inner.map_embed_url || inner.contact?.map_embed_url || null,
    before_after: inner.before_after || [],
    credentials: inner.credentials || [],
    brands: inner.brands || [],
    clients: inner.clients || inner.partners || [],
    deal: inner.deal || null,
    badge: inner.badge || null,
    video_url: (typeof inner.video === 'string' ? inner.video : inner.video?.url) || inner.video_url || null,
    video: normalizeVideoObj(inner.video || (inner.video_url ? { url: inner.video_url } : null)),
    stat_1_number: inner.stat_1_number || '',
    stat_1_label: inner.stat_1_label || '',
    stat_2_number: inner.stat_2_number || '',
    stat_2_label: inner.stat_2_label || '',
    stat_3_number: inner.stat_3_number || '',
    stat_3_label: inner.stat_3_label || '',
    stat_4_number: inner.stat_4_number || '',
    stat_4_label: inner.stat_4_label || '',
    students_count: inner.students_count || '',
    pass_rate: inner.pass_rate || '',
    years_open: inner.years_open || '',
    staff_count: inner.staff_count || '',
  };

  // hospitality-inn / lodge / hotel: layer in tenant-set text overrides
  if (HOSP_TEMPLATE_IDS.has(templateId)) {
    for (const _k of HOSP_TEXT_KEYS) {
      if (inner[_k] != null && inner[_k] !== '') normalized[_k] = inner[_k];
    }
  }

  if (GROCERY_TEMPLATE_IDS.has(templateId)) {
    for (const _k of GROCERY_EXTRA_KEYS) {
      if (inner[_k] != null && inner[_k] !== '') normalized[_k] = inner[_k];
    }
  }

  return normalized;
}

// --- DB QUERIES ---------------------------------------------------------------

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
<html lang="en"><head><meta charset="UTF-8"><title>Not Found - websites.co.zw</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>body{margin:0;font-family:system-ui,sans-serif;display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:100vh;background:#f5f5f5}
h1{font-size:4rem;margin:0;color:#1a1a2e}p{color:#666;margin:.5rem 0}a{color:#e94560;font-weight:600}</style>
</head><body><h1>404</h1><p>This site isn't available.</p><a href="https://websites.co.zw">Get your own site &rarr;</a></body></html>`, { status: 404, headers: { 'Content-Type': 'text/html;charset=UTF-8' } });
}

// =============================================================================
// HOSPITALITY-INN EXTRAS
// =============================================================================

const HOSP_ICONS = {
  wifi: '<path d="M5 12.55a11 11 0 0 1 14.08 0"/><path d="M1.42 9a16 16 0 0 1 21.16 0"/><path d="M8.53 16.11a6 6 0 0 1 6.95 0"/><line x1="12" y1="20" x2="12.01" y2="20"/>',
  pool: '<path d="M2 12h20"/><path d="M2 17h20"/><path d="M6 12V5a2 2 0 0 1 4 0v12"/><path d="M14 12V5a2 2 0 0 1 4 0v12"/>',
  swim: '<path d="M2 12h20"/><path d="M2 17h20"/><path d="M6 12V5a2 2 0 0 1 4 0v12"/><path d="M14 12V5a2 2 0 0 1 4 0v12"/>',
  park: '<rect x="1" y="3" width="15" height="13" rx="2"/><path d="M16 8h4l3 3v5h-7V8z"/><circle cx="5.5" cy="18.5" r="2.5"/><circle cx="18.5" cy="18.5" r="2.5"/>',
  breakfast: '<path d="M18 8h1a4 4 0 0 1 0 8h-1"/><path d="M2 8h16v9a4 4 0 0 1-4 4H6a4 4 0 0 1-4-4V8z"/><line x1="6" y1="1" x2="6" y2="4"/><line x1="10" y1="1" x2="10" y2="4"/><line x1="14" y1="1" x2="14" y2="4"/>',
  restaurant: '<path d="M3 2v7c0 1.1.9 2 2 2h4a2 2 0 0 0 2-2V2"/><path d="M7 2v20"/><path d="M21 15V2a5 5 0 0 0-5 5v6c0 1.1.9 2 2 2h3Zm0 0v7"/>',
  bar: '<path d="M8 22h8"/><path d="M12 11v11"/><path d="m19 3-7 8-7-8Z"/>',
  security: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>',
  spa: '<path d="M12 22c4.97 0 9-4.03 9-9-4.97 0-9 4.03-9 9Z"/><path d="M12 22c0-4.97-4.03-9-9-9 0 4.97 4.03 9 9 9Z"/><path d="M12 13a8.5 8.5 0 0 0 4-7 8.5 8.5 0 0 0-4-3 8.5 8.5 0 0 0-4 3 8.5 8.5 0 0 0 4 7Z"/>',
  gym: '<path d="m6.5 6.5 11 11"/><path d="m21 21-1-1"/><path d="m3 3 1 1"/><path d="m18 22 4-4"/><path d="m2 6 4-4"/><path d="m3 10 7-7"/><path d="m14 21 7-7"/>',
  ac: '<path d="M2 12h20"/><path d="M4 8h16"/><path d="M6 16h12"/>',
  tv: '<rect width="20" height="15" x="2" y="3" rx="2"/><path d="m8 21 4-4 4 4"/>',
  laundry: '<path d="M3 6h3"/><path d="M17 6h.01"/><rect width="18" height="20" x="3" y="2" rx="2"/><circle cx="12" cy="13" r="5"/>',
  shuttle: '<path d="M8 6v6"/><path d="M15 6v6"/><path d="M2 12h19.6"/><path d="M18 18h3s.5-1.7.8-2.8c.1-.4.2-.8.2-1.2 0-.4-.1-.8-.2-1.2l-1.4-5C20.1 6.8 19.1 6 18 6H4a2 2 0 0 0-2 2v10h3"/><circle cx="7" cy="18" r="2"/><circle cx="16" cy="18" r="2"/>',
  garden: '<path d="M12 10a6 6 0 0 0-6-6c0 4 2 6 6 6Z"/><path d="M12 10a6 6 0 0 1 6-6c0 4-2 6-6 6Z"/><path d="M12 22V10"/>',
  fire: '<path d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.072-2.143-.224-4.054 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.153.433-2.294 1-3a2.5 2.5 0 0 0 2.5 2.5z"/>',
  coffee: '<path d="M18 8h1a4 4 0 0 1 0 8h-1"/><path d="M2 8h16v9a4 4 0 0 1-4 4H6a4 4 0 0 1-4-4V8z"/><line x1="6" y1="1" x2="6" y2="4"/><line x1="10" y1="1" x2="10" y2="4"/><line x1="14" y1="1" x2="14" y2="4"/>',
  pet: '<circle cx="11" cy="4" r="2"/><circle cx="18" cy="8" r="2"/><circle cx="20" cy="16" r="2"/><path d="M9 10a5 5 0 0 1 5 5v3.5a3.5 3.5 0 0 1-6.84 1.045Q6.52 17.48 4.46 16.84A3.5 3.5 0 0 1 5.5 10Z"/>',
  default: '<path d="M20 6 9 17l-5-5"/>',
};

function hospIcon(name) {
  const k = String(name || '').toLowerCase();
  for (const key of Object.keys(HOSP_ICONS)) {
    if (key !== 'default' && k.indexOf(key) !== -1) return HOSP_ICONS[key];
  }
  return HOSP_ICONS.default;
}

function hospIconSvg(name, w) {
  const s = w || 20;
  return `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${hospIcon(name)}</svg>`;
}

function hospStatus(status) {
  const s = String(status || '').toLowerCase();
  if (s === 'limited' || s === 'few') return { cls: 'limited', label: 'Limited Availability', row: 'Limited' };
  if (s === 'booked' || s === 'full' || s === 'unavailable' || s === 'sold' || s === 'soldout')
    return { cls: 'booked', label: 'Fully Reserved', row: 'Booked' };
  return { cls: 'available', label: 'Available', row: 'Available' };
}

function hospWa(num, msg) {
  if (!num) return '#';
  return `https://wa.me/${num}?text=${encodeURIComponent(msg)}`;
}

const HOSP_ARROW = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14M12 5l7 7-7 7"/></svg>';
const HOSP_CHECK = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>';
const HOSP_DOT = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="3"/></svg>';
const HOSP_BED = '<svg width="56" height="56" viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,0.15)" stroke-width="1" stroke-linecap="round" stroke-linejoin="round"><path d="M2 20v-8a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v8"/><path d="M4 10V6a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v4"/><path d="M12 10v4"/><path d="M2 18h20"/></svg>';
const HOSP_BED_D = '<svg width="44" height="44" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1" stroke-linecap="round" stroke-linejoin="round"><path d="M2 20v-8a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v8"/><path d="M4 10V6a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v4"/><path d="M12 10v4"/><path d="M2 18h20"/></svg>';
const HOSP_USERS = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>';

function hospStrList(v) {
  if (Array.isArray(v)) return v.map(x => String(x)).filter(Boolean);
  if (typeof v === 'string') return v.split(/[,\n]/).map(s => s.trim()).filter(Boolean);
  return [];
}

function hospPhotoStage(item, altBase, phHtml) {
  const raw = Array.isArray(item.photos) ? item.photos.filter(Boolean) : [];
  const photos = raw.length ? raw : ((item.photo || item.image) ? [item.photo || item.image] : []);
  if (!photos.length) return phHtml;
  if (photos.length === 1) {
    return `<img src="${esc(photos[0])}" alt="${esc(altBase)}" loading="lazy">`;
  }
  const slides = photos.map((u, i) =>
    `<img class="hosp-slide${i === 0 ? ' active' : ''}" src="${esc(u)}" alt="${esc(altBase + ' photo ' + (i + 1))}" loading="lazy">`
  ).join('');
  const dots = photos.map((_, i) =>
    `<span class="hosp-slide-dot${i === 0 ? ' active' : ''}"></span>`
  ).join('');
  return `<div class="hosp-slider" data-idx="0">${slides}<button type="button" class="hosp-slide-btn hosp-slide-prev" aria-label="Previous photo">&lsaquo;</button><button type="button" class="hosp-slide-btn hosp-slide-next" aria-label="Next photo">&rsaquo;</button><div class="hosp-slide-dots">${dots}</div></div>`;
}

function buildHospitalityExtras(c, site, config) {
  const extras = {};
  const cfgTokens = (config && config.extraTokens) || {};
  for (const [k, v] of Object.entries(cfgTokens)) extras[k] = v;

  const biz = c.business_name || c.name || '';
  const phone = c.phone || c.contact?.phone || '';
  const waRaw = (c.whatsapp || c.contact?.whatsapp || phone).replace(/\D/g, '');
  const waNum = waRaw.startsWith('263') ? waRaw : waRaw ? '263' + waRaw.replace(/^0/, '') : '';
  const waLink = waNum ? `https://wa.me/${waNum}?text=${encodeURIComponent('Hello ' + biz + ', I would like to make a booking.')}` : '#';
  extras.whatsapp_clean = waNum;
  extras.whatsapp_wa_link = waLink;

  const logo = c.logo_url || c.images?.logo || site.logo_url || '';
  const hero = c.hero_image_url || c.hero_image || c.images?.hero || site.hero_image_url || '';
  const address = c.address || c.location || c.contact?.address || '';
  const email = c.email || c.contact?.email || '';
  const map = c.map_embed_url || c.contact?.map_embed_url || '';
  const fb = c.socials?.facebook || c.facebook_url || '';
  const ig = c.socials?.instagram || c.instagram_url || '';

  const rooms = Array.isArray(c.rooms) ? c.rooms : [];
  const amenities = Array.isArray(c.amenities) ? c.amenities : [];
  const conference = Array.isArray(c.conference) ? c.conference : [];
  const packages = Array.isArray(c.packages) ? c.packages : [];
  const experiences = Array.isArray(c.experiences) ? c.experiences : [];
  const gallery = Array.isArray(c.gallery) ? c.gallery : [];
  const testimonials = Array.isArray(c.testimonials) ? c.testimonials : [];
  const stats = Array.isArray(c.stats) ? c.stats : [];
  const dining = (c.dining && typeof c.dining === 'object') ? c.dining : null;
  const diningHi = dining ? (Array.isArray(dining.highlights) ? dining.highlights : []) : [];

  const t = b => (b ? 'true' : '');
  extras.has_logo = t(logo);
  extras.has_hero = t(hero);
  extras.has_whatsapp = t(waNum);
  extras.has_address = t(address);
  extras.has_phone = t(phone);
  extras.has_email = t(email);
  extras.has_map = t(map);
  extras.has_facebook = t(fb);
  extras.has_instagram = t(ig);
  extras.has_rooms = t(rooms.length);
  extras.has_multiple_rooms = t(rooms.length > 1);
  extras.has_amenities = t(amenities.length);
  extras.has_conference = t(conference.length);
  extras.has_packages = t(packages.length);
  extras.has_dining = t(dining && (dining.name || dining.description || diningHi.length || dining.image));
  extras.has_experiences = t(experiences.length);
  extras.has_gallery = t(gallery.length);
  extras.has_testimonials = t(testimonials.length);
  extras.has_about = t(c.about);
  extras.has_hours = t(c.hours);

  const L = (key, def) => (c[key] != null && c[key] !== '' ? c[key] : def);
  extras.nav_rooms_label = L('nav_rooms_label', 'Rooms');
  extras.nav_about_label = L('nav_about_label', 'About');
  extras.nav_amenities_label = L('nav_amenities_label', 'Amenities');
  extras.nav_conference_label = L('nav_conference_label', 'Conferencing');
  extras.nav_packages_label = L('nav_packages_label', 'Packages');
  extras.nav_dining_label = L('nav_dining_label', 'Dining');
  extras.nav_gallery_label = L('nav_gallery_label', 'Gallery');
  extras.nav_reviews_label = L('nav_reviews_label', 'Reviews');
  extras.nav_contact_label = L('nav_contact_label', 'Contact');
  extras.nav_cta_label = L('nav_cta_label', (config && config.navCtaLabel) || 'Reserve');

  extras.hi_hero_headline = L('hero_headline', L('hi_hero_headline', cfgTokens.hi_hero_headline || 'Your Private Retreat'));
  extras.hi_hero_subtext = L('hero_subtext', L('hi_hero_subtext', cfgTokens.hi_hero_subtext || 'A calm, comfortable stay — book directly with us on WhatsApp.'));
  extras.hero_cta_label = L('hero_cta_label', 'Reserve Your Stay');
  extras.hero_secondary_label = L('hero_secondary_label', 'Explore Rooms');
  extras.scroll_label = 'Scroll';

  extras.about_eyebrow = L('about_eyebrow', 'Our Story');
  extras.about_heading = L('about_heading', biz ? ('Welcome to ' + biz) : 'Welcome');
  extras.about_text = c.about || '';

  extras.rooms_eyebrow = L('rooms_eyebrow', 'Accommodation');
  extras.rooms_heading = L('rooms_heading', 'Rooms & Suites');
  extras.amenities_eyebrow = L('amenities_eyebrow', 'The Property');
  extras.amenities_heading = L('amenities_heading', 'Amenities & Facilities');
  extras.conference_eyebrow = L('conference_eyebrow', 'Meetings & Events');
  extras.conference_heading = L('conference_heading', 'Conferencing & Venues');
  extras.packages_eyebrow = L('packages_eyebrow', 'Special Offers');
  extras.packages_heading = L('packages_heading', 'Packages & Deals');
  extras.dining_eyebrow = L('dining_eyebrow', 'Cuisine');
  extras.dining_name = (dining && dining.name) || L('dining_name', 'Dining');
  extras.dining_description = (dining && dining.description) || L('dining_description', '');
  extras.dining_cta_label = L('dining_cta_label', 'Enquire About Dining');
  extras.experiences_eyebrow = L('experiences_eyebrow', 'Experiences');
  extras.experiences_heading = L('experiences_heading', 'Things to Do');
  extras.gallery_eyebrow = L('gallery_eyebrow', 'Gallery');
  extras.gallery_heading = L('gallery_heading', 'A Visual Journey');
  extras.reviews_eyebrow = L('reviews_eyebrow', 'Guest Voices');
  extras.reviews_heading = L('reviews_heading', 'What Our Guests Say');
  extras.hours_eyebrow = 'Hours';
  extras.hours_heading = L('hours_heading', 'Reception & Check-In');
  extras.location_eyebrow = L('location_eyebrow', 'Find Us');
  extras.location_heading = L('location_heading', 'Getting Here');
  extras.location_cta_label = L('location_cta_label', 'Message Us');
  extras.cta_eyebrow = L('cta_eyebrow', 'Reserve Your Stay');
  extras.cta_heading = L('cta_heading', 'Ready to Book Your Stay?');
  extras.cta_button_label = L('cta_button_label', 'Reserve via WhatsApp');
  extras.sticky_label = L('sticky_label', 'Now Booking');
  extras.footer_nav_title = 'Navigate';
  extras.footer_contact_title = 'Contact';
  extras.footer_reserve_title = 'Reserve';

  const priceUnit = L('room_price_unit', '/ night');
  const subP = (txt, cls) => (txt ? `<p class="section-body ${cls || ''}">${esc(String(txt))}</p>` : '');
  extras.amenities_sub_html = subP(c.amenities_sub);
  extras.conference_sub_html = subP(c.conference_sub);
  extras.packages_sub_html = subP(c.packages_sub);
  extras.experiences_sub_html = subP(c.experiences_sub);
  extras.gallery_sub_html = subP(c.gallery_sub);
  extras.location_body_html = subP(c.location_body);
  extras.cta_body_html = c.cta_body ? `<p class="booking-cta-body">${esc(String(c.cta_body))}</p>` : '';
  extras.cta_note_html = c.cta_note ? `<p class="booking-cta-note">${esc(String(c.cta_note))}</p>` : '';

  extras.hero_location_html = address ?
    `<div class="hero-location"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z"/><circle cx="12" cy="10" r="3"/></svg>${esc(address)}</div>` :
    '';

  const aboutImg = c.about_image || hero || '';
  extras.about_image_html = aboutImg ?
    `<img src="${esc(aboutImg)}" alt="${esc(biz)}" loading="lazy">` :
    '';
  extras.about_stats_html = stats.length ?
    `<div class="stat-row">${stats.slice(0, 4).map(s =>
        `<div class="stat-item"><span class="stat-number">${esc(String(s.value ?? s.number ?? ''))}${esc(String(s.suffix || ''))}</span><span class="stat-label">${esc(s.label || '')}</span></div>`
      ).join('')}</div>` :
    '';

  const fr = extractFeatured(rooms);
  const sortedRooms = fr.sorted;
  const featured = sortedRooms[0];

  if (featured) {
    const st = hospStatus(featured.status);
    const name = featured.name || featured.title || 'Suite';
    const desc = featured.description || featured.body || '';
    const price = featured.price || '';
    const feats = hospStrList(featured.amenities || featured.features);
    const link = hospWa(waNum, `Hello ${biz}, I would like to book the ${name}.`);
    const photoEl = hospPhotoStage(featured, name, `<div class="suite-photo-ph">${HOSP_BED}</div>`);
    const detailRows = feats.map(f =>
      `<div class="suite-detail-row">${HOSP_CHECK}${esc(f)}</div>`).join('');
    const cta = st.cls === 'booked' ?
      `<span class="btn-reserve-dark booked-state">Currently Unavailable</span>` :
      `<a href="${esc(link)}" class="btn-reserve-dark" target="_blank" rel="noopener">Reserve This Room ${HOSP_ARROW}</a>`;
    const resourceId = featured.resource_id || featured.resourceId || featured.id || '';
    const bookTrigger = resourceId ?
      `<button type="button" class="wcz-book-trigger">Check availability &amp; book</button>` :
      '';
    extras.rooms_featured_html =
      `<div class="suite-editorial" data-resource-id="${esc(resourceId)}" data-room-name="${esc(name)}">
  <div class="suite-photo">${photoEl}</div>
  <div class="suite-info">
    <span class="label-eyebrow">${esc(L('featured_eyebrow', 'Featured'))}</span>
    <h2 class="suite-name">${esc(name)}</h2>
    ${desc ? `<p class="suite-desc">${esc(desc)}</p>` : ''}
    ${detailRows ? `<div class="suite-details">${detailRows}</div>` : ''}
    <div>
      ${price ? `<div class="suite-price-row"><span class="suite-price">${esc(price)}</span><span class="suite-price-unit">${esc(priceUnit)}</span></div>` : ''}
      <span class="suite-status ${st.cls}">${st.label}</span>
    </div>
    ${cta}
    ${bookTrigger}
  </div>
</div>`;
  } else {
    extras.rooms_featured_html = '';
  }

  extras.rooms_collection_html = sortedRooms.slice(1).map((room, i) => {
    const st = hospStatus(room.status);
    const name = room.name || room.title || 'Room';
    const desc = room.description || room.body || '';
    const price = room.price || '';
    const tag = room.tag || room.category || room.badge || '';
    const feats = hospStrList(room.amenities || room.features);
    const link = hospWa(waNum, `Hello ${biz}, I would like to book the ${name}.`);
    const reverse = (i % 2 === 1) ? ' row-reverse' : '';
    const photoEl = hospPhotoStage(room, name, `<div class="room-row-photo-ph">${HOSP_BED_D}</div>`);
    const featRows = feats.map(f =>
      `<div class="room-feature-item">${HOSP_DOT}${esc(f)}</div>`).join('');
    const cta = st.cls === 'booked' ?
      `<span class="btn-reserve-outline disabled">Currently Unavailable</span>` :
      `<a href="${esc(link)}" class="btn-reserve-outline" target="_blank" rel="noopener">Reserve Stay ${HOSP_ARROW}</a>`;
    const resourceId = room.resource_id || room.resourceId || room.id || '';
    const bookTrigger = resourceId ?
      `<button type="button" class="wcz-book-trigger">Check availability &amp; book</button>` :
      '';
    return `<div class="room-row${reverse} reveal" data-resource-id="${esc(resourceId)}" data-room-name="${esc(name)}">
  <div class="room-row-photo">${photoEl}<span class="room-row-status ${st.cls}">${st.row}</span></div>
  <div class="room-row-info">
    ${tag ? `<span class="label-eyebrow">${esc(tag)}</span>` : ''}
    <h3 class="room-row-name">${esc(name)}</h3>
    ${desc ? `<p class="room-row-desc">${esc(desc)}</p>` : ''}
    ${featRows ? `<div class="room-row-features">${featRows}</div>` : ''}
    ${price ? `<div class="room-row-price"><span class="room-price-fig">${esc(price)}</span><span class="room-price-unit">${esc(priceUnit)}</span></div>` : ''}
    ${cta}
    ${bookTrigger}
  </div>
</div>`;
  }).join('');

  extras.amenities_cards_html = amenities.map((a, i) => {
    const name = a.name || a.title || '';
    const desc = a.description || a.body || a.desc || '';
    return `<div class="amenity-card reveal reveal-delay-${i % 6}">
  <div class="amenity-icon">${hospIconSvg(name)}</div>
  <div class="amenity-name">${esc(name)}</div>
  ${desc ? `<div class="amenity-desc">${esc(desc)}</div>` : ''}
</div>`;
  }).join('');

  extras.conference_cards_html = conference.map(v => {
    const name = v.name || v.title || 'Venue';
    const desc = v.description || v.body || '';
    const price = v.price || '';
    const unit = v.price_unit || L('venue_price_unit', '/ day');
    const feats = hospStrList(v.features || v.amenities);
    const link = hospWa(waNum, `Hello ${biz}, I would like to enquire about the ${name} venue.`);
    let capStr = '';
    if (v.capacity != null && v.capacity !== '') {
      capStr = (typeof v.capacity === 'number') ? `Up to ${v.capacity} guests` : String(v.capacity);
    }
    const photoEl = hospPhotoStage(v, name, `<div class="venue-photo-ph">${hospIconSvg('users', 40)}</div>`);
    const capEl = capStr ? `<span class="venue-cap">${HOSP_USERS}${esc(capStr)}</span>` : '';
    const chips = feats.map(f => `<span class="venue-chip">${HOSP_CHECK}${esc(f)}</span>`).join('');
    return `<div class="venue-card reveal">
  <div class="venue-photo">${photoEl}${capEl}</div>
  <div class="venue-body">
    <div class="venue-name">${esc(name)}</div>
    ${desc ? `<p class="venue-desc">${esc(desc)}</p>` : ''}
    ${chips ? `<div class="venue-features">${chips}</div>` : ''}
    <div class="venue-footer">
      ${price ? `<div class="venue-price"><span class="venue-price-fig">${esc(price)}</span><span class="venue-price-unit">${esc(unit)}</span></div>` : '<span></span>'}
      <a href="${esc(link)}" class="btn-reserve-outline" target="_blank" rel="noopener">Enquire ${HOSP_ARROW}</a>
    </div>
  </div>
</div>`;
  }).join('');

  extras.packages_cards_html = packages.map(p => {
    const name = p.name || p.title || 'Package';
    const price = p.price || '';
    const unit = p.price_unit || p.unit || p.duration || '';
    const desc = p.description || p.body || '';
    const tag = p.tag || p.badge || '';
    const isFeat = p.featured === true || /featured|popular|best/i.test(String(tag));
    const inc = hospStrList(p.includes || p.features);
    const link = hospWa(waNum, `Hello ${biz}, I would like to book the ${name} package.`);
    const incEl = inc.map(it => `<div class="package-inc-item">${HOSP_CHECK}${esc(it)}</div>`).join('');
    return `<div class="package-card${isFeat ? ' featured' : ''} reveal">
  ${tag ? `<span class="package-tag">${esc(tag)}</span>` : ''}
  <div class="package-name">${esc(name)}</div>
  ${price ? `<div class="package-price-row"><span class="package-price">${esc(price)}</span>${unit ? `<span class="package-unit">${esc(unit)}</span>` : ''}</div>` : ''}
  ${desc ? `<p class="package-desc">${esc(desc)}</p>` : ''}
  ${incEl ? `<div class="package-includes">${incEl}</div>` : ''}
  <a href="${esc(link)}" class="package-cta" target="_blank" rel="noopener">Book This Package</a>
</div>`;
  }).join('');

  if (dining) {
    const di = dining.image || dining.photo || '';
    const di2 = dining.image_2 || dining.accent_image || dining.image2 || '';
    extras.dining_images_html =
      (di ? `<div class="dining-main-img"><img src="${esc(di)}" alt="${esc(extras.dining_name)}" loading="lazy"></div>` :
        `<div class="dining-main-ph"><svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="var(--ink-3)" stroke-width="1" stroke-linecap="round" stroke-linejoin="round"><path d="M3 2v7c0 1.1.9 2 2 2h4a2 2 0 0 0 2-2V2"/><path d="M7 2v20"/><path d="M21 15V2a5 5 0 0 0-5 5v6c0 1.1.9 2 2 2h3Zm0 0v7"/></svg></div>`) +
      (di2 ? `<div class="dining-accent-img"><img src="${esc(di2)}" alt="Dining detail" loading="lazy"></div>` : '');
    extras.dining_highlights_html = diningHi.length ?
      `<div class="dining-highlight">${diningHi.map(h =>
          `<div class="dining-item"><div class="dining-item-name">${esc(h.name || h.title || '')}</div>${(h.description || h.body) ? `<div class="dining-item-desc">${esc(h.description || h.body)}</div>` : ''}</div>`
        ).join('')}</div>` :
      '';
  } else {
    extras.dining_images_html = '';
    extras.dining_highlights_html = '';
  }

  extras.experiences_cards_html = experiences.map((e, i) => {
    const name = e.name || e.title || '';
    const desc = e.description || e.body || '';
    const img = e.image || e.photo || '';
    return `<div class="experience-card reveal reveal-delay-${i % 4}">
  <div class="experience-card-img">${img ? `<img src="${esc(img)}" alt="${esc(name)}" loading="lazy">` : ''}</div>
  <div class="experience-card-body">
    <div class="experience-card-name">${esc(name)}</div>
    ${desc ? `<div class="experience-card-desc">${esc(desc)}</div>` : ''}
  </div>
</div>`;
  }).join('');

  const video = (c.video && typeof c.video === 'object' && (c.video.embedUrl || c.video.url)) ? c.video : null;
  extras.has_video = t(video);
  extras.nav_video_label = L('nav_video_label', 'Film');
  if (video) {
    const vLabel = video.label || 'Our Story';
    const vHeading = video.heading || 'Experience the Property';
    const vTitle = video.title || '';
    const vSubtitle = video.subtitle || '';
    const vBody = video.body || '';
    const vRuntime = video.runtime || '';
    const vThumb = video.thumbnail || hero || '';
    const vType = video.embedType || 'unknown';
    const vSrc = video.embedUrl || video.url || '';

    extras.video_eyebrow = esc(vLabel);
    extras.video_heading = esc(vHeading);
    extras.video_title_html = vTitle ? `<h3 class="video-title">${esc(vTitle)}</h3>` : '';
    extras.video_subtitle_html = vSubtitle ? `<p class="video-subtitle">${esc(vSubtitle)}</p>` : '';
    extras.video_body_html = vBody ? `<p class="video-body">${esc(vBody)}</p>` : '';
    extras.video_runtime_html = vRuntime ? `<span class="video-runtime">${esc(vRuntime)}</span>` : '';

    const thumbEl = vThumb ?
      `<img src="${esc(vThumb)}" alt="${esc(vTitle || biz)}" loading="lazy">` :
      `<div class="video-stage-ph"></div>`;

    extras.video_stage_html =
      `<div class="video-stage" data-src="${esc(vSrc)}" data-type="${esc(vType)}" role="button" tabindex="0" aria-label="Play video">
  ${thumbEl}
  <button class="video-play-btn" type="button" tabindex="-1" aria-hidden="true">
    <svg width="26" height="26" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>
  </button>
</div>`;
  } else {
    extras.video_eyebrow = '';
    extras.video_heading = '';
    extras.video_title_html = '';
    extras.video_subtitle_html = '';
    extras.video_body_html = '';
    extras.video_runtime_html = '';
    extras.video_stage_html = '';
  }

  extras.gallery_items_html = gallery.map(g => {
    const url = (typeof g === 'string') ? g : (g.url || g.image || g.src || '');
    if (!url) return '';
    return `<div class="gallery-item" data-src="${esc(url)}"><img src="${esc(url)}" alt="${esc((typeof g === 'object' && g.caption) || 'Gallery')}" loading="lazy"></div>`;
  }).filter(Boolean).join('');

  const STAR = '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" stroke="none"><path d="m12 2 3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/></svg>';
  extras.testimonials_cards_html = testimonials.map((r, i) => {
    const name = r.name || r.author || '';
    const text = r.text || r.quote || r.review || '';
    const role = r.role || r.position || '';
    const photo = r.photo || r.avatar || '';
    const rating = Math.max(1, Math.min(5, parseInt(r.rating, 10) || 5));
    const stars = STAR.repeat(rating);
    const av = photo ?
      `<div class="review-avatar"><img src="${esc(photo)}" alt="${esc(name)}" loading="lazy"></div>` :
      `<div class="review-avatar-init">${esc((name || '?').charAt(0).toUpperCase())}</div>`;
    return `<div class="review-card reveal reveal-delay-${i % 3}">
  <svg class="review-quote-icon" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3 21c3 0 7-1 7-8V5c0-1.25-.756-2.017-2-2H4c-1.25 0-2 .75-2 1.972V11c0 1.25.75 2 2 2 1 0 1 0 1 1v1c0 1-1 2-2 2s-1 .008-1 1.031V20c0 1 0 1 1 1z"/><path d="M15 21c3 0 7-1 7-8V5c0-1.25-.757-2.017-2-2h-4c-1.25 0-2 .75-2 1.972V11c0 1.25.75 2 2 2h.75c0 2.25.25 4-2.75 4v3c0 1 0 1 1 1z"/></svg>
  <div class="review-stars">${stars}</div>
  <p class="review-text">"${esc(text)}"</p>
  <div class="review-author">${av}<div><div class="review-name">${esc(name)}</div>${role ? `<div class="review-role">${esc(role)}</div>` : ''}</div></div>
</div>`;
  }).join('');

  extras.hours_rows_html = buildHospHoursHtml(c.hours);

  const det = [];
  if (address) det.push(`<div class="location-detail"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z"/><circle cx="12" cy="10" r="3"/></svg><span>${esc(address)}</span></div>`);
  if (phone) det.push(`<div class="location-detail"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07A19.5 19.5 0 0 1 4.69 12a19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 3.6 1.24h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L7.91 9a16 16 0 0 0 6 6l1.09-1.09a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 21.73 16l.2.92z"/></svg><a href="tel:${esc(phone)}">${esc(phone)}</a></div>`);
  if (email) det.push(`<div class="location-detail"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect width="20" height="16" x="2" y="4" rx="2"/><path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7"/></svg><a href="mailto:${esc(email)}">${esc(email)}</a></div>`);
  extras.location_details_html = det.join('');
  extras.location_map_html = map ?
    `<iframe src="${esc(map)}" allowfullscreen loading="lazy" title="Location Map"></iframe>` :
    `<div class="location-map-ph"><svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z"/><circle cx="12" cy="10" r="3"/></svg></div>`;

  extras.cta_bg_html = hero ? `<div class="booking-cta-bg" style="background-image: url('${esc(hero)}');"></div>` : '';

  const social = [];
  if (fb) social.push(`<a href="${esc(fb)}" target="_blank" rel="noopener" aria-label="Facebook"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M18 2h-3a5 5 0 0 0-5 5v3H7v4h3v8h4v-8h3l1-4h-4V7a1 1 0 0 1 1-1h3z"/></svg></a>`);
  if (ig) social.push(`<a href="${esc(ig)}" target="_blank" rel="noopener" aria-label="Instagram"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect width="20" height="20" x="2" y="2" rx="5" ry="5"/><path d="M16 11.37A4 4 0 1 1 12.63 8 4 4 0 0 1 16 11.37z"/><line x1="17.5" y1="6.5" x2="17.51" y2="6.5"/></svg></a>`);
  if (waNum) social.push(`<a href="${esc(waLink)}" target="_blank" rel="noopener" aria-label="WhatsApp"><svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" stroke="none"><path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347"/></svg></a>`);
  extras.footer_social_html = social.join('');

  const fc = [];
  if (phone) fc.push(`<div class="footer-contact-item"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07A19.5 19.5 0 0 1 4.69 12a19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 3.6 1.24h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L7.91 9a16 16 0 0 0 6 6l1.09-1.09a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 21.73 16l.2.92z"/></svg><a href="tel:${esc(phone)}">${esc(phone)}</a></div>`);
  if (email) fc.push(`<div class="footer-contact-item"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect width="20" height="16" x="2" y="4" rx="2"/><path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7"/></svg><a href="mailto:${esc(email)}">${esc(email)}</a></div>`);
  if (address) fc.push(`<div class="footer-contact-item"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z"/><circle cx="12" cy="10" r="3"/></svg><span>${esc(address)}</span></div>`);
  extras.footer_contact_html = fc.join('');

  const fr2 = [`<a href="${esc(waLink)}" target="_blank" rel="noopener">Book via WhatsApp</a>`];
  if (phone) fr2.push(`<a href="tel:${esc(phone)}">Call to Reserve</a>`);
  if (email) fr2.push(`<a href="mailto:${esc(email)}">Email Enquiry</a>`);
  extras.footer_reserve_html = fr2.join('');

  return extras;
}

function buildHospHoursHtml(hours) {
  const h = normalizeHours(hours);
  if (!h || typeof h === 'string') return '';
  const order = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
  const labels = { mon: 'Monday', tue: 'Tuesday', wed: 'Wednesday', thu: 'Thursday', fri: 'Friday', sat: 'Saturday', sun: 'Sunday' };
  const today = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'][new Date().getDay()];
  return order.map(d => {
    const slot = h[d];
    if (!slot || typeof slot !== 'object') return null;
    const isToday = d === today;
    const time = slot.closed ? 'Closed' : `${slot.open || '?'} - ${slot.close || '?'}`;
    return `<div class="hours-row${isToday ? ' today' : ''}"><span class="hours-day">${labels[d]}${isToday ? '<span class="today-pill">Today</span>' : ''}</span><span class="hours-time">${esc(time)}</span></div>`;
  }).filter(Boolean).join('');
}
