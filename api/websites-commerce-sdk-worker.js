/**
 * websites-commerce-sdk-worker
 *
 * Service binding worker — called internally by websites-render-worker.
 * Exposes the Universal Commerce SDK as an HTTP service (no public routes).
 *
 * Routes:
 *   POST /commerce  → buildCommerceModule() → { gridHtml, filterHtml, drawerHtml, lbHtml, scriptHtml }
 *   POST /css       → buildCommerceCSS()    → { css: '<style>...' }
 *
 * No bindings required (pure functions, no DB/R2/env).
 *
 * v5.2 CHANGE — FIXED GROCERY TEMPLATE ID:
 *   Changed "grocery-store" → "grocery-fmcg" in TEMPLATE_RENDERER_MAP
 *   to match the render worker's folder name.
 *
 * v5.3 CHANGE — LEGIBILITY FIX:
 *   .wcz-prod-card and #wcz-qv-drawer now set an explicit color:#fff so their
 *   text can't inherit a dark, palette-driven page text colour onto their
 *   permanently-dark backgrounds (was unreadable on light palettes like
 *   Clean White).
 *   .wcz-add-btn, .wcz-qv-btn-cart:hover, .wcz-nav-cart-active,
 *   .wcz-order-count now read text colour from var(--btn-fg) instead of
 *   hardcoded var(--ink), fixing near-black-on-near-black buttons for accent
 *   colours like Clean White's #1a1a1a. --btn-fg is computed and injected by
 *   the render worker (buildThemeCss / buildPaletteOverride) alongside the
 *   palette CSS -- this worker just needs to consume it.
 *
 * v5.4 CHANGE — WHATSAPP STORE ADDON GATING:
 *   Mirrors render-worker.js v10.26. buildCommerceModule() now reads
 *   ctx.addonActive (defaults to true if unspecified, so callers that don't
 *   pass it -- e.g. an older render-worker still on v10.25 -- see unchanged
 *   behaviour). When addonActive is false: buildProductCard() omits the
 *   "+ Add to cart" button, buildDrawerHtml() omits the cart/buy-now actions
 *   (replaced with a plain contact note), and buildProductScript() skips
 *   injecting the floating cart FAB, order panel, and WhatsApp enquiry FAB,
 *   plus guards wczCartAdd/wczAddToOrder/wczCardAdd as no-ops. Browsing --
 *   grid, quick-view drawer, image carousel, lightbox -- is unaffected either
 *   way; only the ordering/conversion mechanism is suppressed. This worker
 *   has no DB access and does not itself decide addon status -- the caller
 *   (render-worker) checks websites-orders-worker and passes the boolean in.
 */

export default {
  async fetch(request) {
    try {
      const url = new URL(request.url);

      if (request.method !== 'POST') {
        return new Response('Method not allowed', { status: 405 });
      }

      if (url.pathname === '/commerce') {
        const { products, templateId, contentTheme, ctx } = await request.json();
        const result = buildCommerceModule(products, templateId, contentTheme, ctx);
        return Response.json(result);
      }

      if (url.pathname === '/css') {
        return Response.json({ css: buildCommerceCSS() });
      }

      return new Response('Not found', { status: 404 });

    } catch (err) {
      console.error('commerce-sdk-worker error:', err);
      return new Response(JSON.stringify({ error: err.message }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      });
    }
  }
};


// =============================================================================
// UNIVERSAL COMMERCE SDK
// =============================================================================

const RENDERERS = {

  fashion: {
    gridCols:          { mobile: 2, tablet: 3, desktop: 3 },
    cardAspect:        '3/4',
    cardShowPrice:     'below',
    cardShowSpecs:     false,
    cardShowStock:     false,
    cardHoverEffect:   'quickview',
    drawerImageLayout: 'stack',
    drawerShowDetails: true,
    drawerShowSpecs:   false,
    drawerShowRelated: true,
    drawerPricePos:    'below-name',
    variantLabel:      'Size',
    variantStyle:      'pill',
    colorLabel:        'Colour',
    colorStyle:        'swatch',
    showColorName:     true,
    showQuantity:      false,
    showIngredients:   false,
    showWarranty:      false,
    waTemplate:        'Hi {biz}, I would like to order:\n\u2022 {name}\n  Colour: {color}\n  Size: {variant}\n  Price: {price}\n\nPlease confirm availability.',
    waTemplateNoVar:   'Hi {biz}, I would like to order:\n\u2022 {name}\n  Price: {price}\n\nPlease confirm availability.',
    badges: {
      new:  { label: 'New',      bg: '#0e0e0e', color: '#fff' },
      sale: { label: 'Sale',     bg: '#b8956a', color: '#fff' },
      out:  { label: 'Sold out', bg: '#b8b0a8', color: '#fff' },
    },
    specsLabel: 'Details',
  },

  hardware: {
    gridCols:          { mobile: 2, tablet: 3, desktop: 4 },
    cardAspect:        '1/1',
    cardShowPrice:     'overlay',
    cardShowSpecs:     true,
    cardShowStock:     true,
    cardHoverEffect:   'zoom',
    drawerImageLayout: 'thumbs',
    drawerShowDetails: false,
    drawerShowSpecs:   true,
    drawerShowRelated: true,
    drawerPricePos:    'top',
    variantLabel:      'Size / Dimension',
    variantStyle:      'pill',
    colorLabel:        'Finish',
    colorStyle:        'text-pill',
    showColorName:     false,
    showQuantity:      true,
    showIngredients:   false,
    showWarranty:      false,
    waTemplate:        'Hi {biz}, I would like to order:\n\u2022 {name}\n  Finish: {color}\n  Size: {variant}\n  Qty: {qty}\n  Price: {price}\n\nPlease confirm stock and delivery.',
    waTemplateNoVar:   'Hi {biz}, I would like to order:\n\u2022 {name}\n  Qty: {qty}\n  Price: {price}\n\nPlease confirm stock and delivery.',
    badges: {
      new:  { label: 'New',          bg: '#1a56db', color: '#fff' },
      sale: { label: 'Special',      bg: '#ea580c', color: '#fff' },
      out:  { label: 'Out of Stock', bg: '#6b7280', color: '#fff' },
    },
    specsLabel: 'Specifications',
  },

  grocery: {
    gridCols:          { mobile: 2, tablet: 3, desktop: 4 },
    cardAspect:        '1/1',
    cardShowPrice:     'prominent',
    cardShowSpecs:     false,
    cardShowStock:     true,
    cardHoverEffect:   'addbutton',
    drawerImageLayout: 'single',
    drawerShowDetails: true,
    drawerShowSpecs:   false,
    drawerShowRelated: true,
    drawerPricePos:    'top',
    variantLabel:      'Pack size',
    variantStyle:      'pill',
    colorLabel:        '',
    colorStyle:        'none',
    showColorName:     false,
    showQuantity:      true,
    showIngredients:   true,
    showWarranty:      false,
    waTemplate:        'Hi {biz}, I would like to order:\n\u2022 {name} ({variant})\n  Qty: {qty}\n  Price: {price} each\n\nPlease confirm availability.',
    waTemplateNoVar:   'Hi {biz}, I would like to order:\n\u2022 {name}\n  Qty: {qty}\n  Price: {price} each\n\nPlease confirm availability.',
    badges: {
      new:   { label: 'New',         bg: '#16a34a', color: '#fff' },
      sale:  { label: 'Special',     bg: '#ea580c', color: '#fff' },
      out:   { label: 'Unavailable', bg: '#6b7280', color: '#fff' },
      fresh: { label: 'Fresh Today', bg: '#16a34a', color: '#fff' },
    },
    specsLabel: 'Nutritional Info',
  },

  beauty: {
    gridCols:          { mobile: 2, tablet: 3, desktop: 3 },
    cardAspect:        '3/4',
    cardShowPrice:     'below',
    cardShowSpecs:     false,
    cardShowStock:     false,
    cardHoverEffect:   'quickview',
    drawerImageLayout: 'stack',
    drawerShowDetails: true,
    drawerShowSpecs:   false,
    drawerShowRelated: true,
    drawerPricePos:    'below-name',
    variantLabel:      'Size',
    variantStyle:      'pill',
    colorLabel:        'Shade',
    colorStyle:        'swatch',
    showColorName:     true,
    showQuantity:      false,
    showIngredients:   true,
    showWarranty:      false,
    waTemplate:        'Hi {biz}, I would like to order:\n\u2022 {name}\n  Shade: {color}\n  Size: {variant}\n  Price: {price}\n\nPlease confirm availability.',
    waTemplateNoVar:   'Hi {biz}, I would like to order:\n\u2022 {name}\n  Price: {price}\n\nPlease confirm availability.',
    badges: {
      new:        { label: 'New',         bg: '#0e0e0e', color: '#fff' },
      sale:       { label: 'On Sale',     bg: '#c96a7e', color: '#fff' },
      out:        { label: 'Sold out',    bg: '#b8b0a8', color: '#fff' },
      bestseller: { label: 'Best Seller', bg: '#b8956a', color: '#fff' },
    },
    specsLabel: 'Ingredients',
  },

  electronics: {
    gridCols:          { mobile: 1, tablet: 2, desktop: 3 },
    cardAspect:        '4/3',
    cardShowPrice:     'prominent',
    cardShowSpecs:     true,
    cardShowStock:     true,
    cardHoverEffect:   'zoom',
    drawerImageLayout: 'thumbs',
    drawerShowDetails: false,
    drawerShowSpecs:   true,
    drawerShowRelated: true,
    drawerPricePos:    'top',
    variantLabel:      'Configuration',
    variantStyle:      'pill',
    colorLabel:        'Colour',
    colorStyle:        'text-pill',
    showColorName:     false,
    showQuantity:      false,
    showIngredients:   false,
    showWarranty:      true,
    waTemplate:        'Hi {biz}, I would like to enquire about:\n\u2022 {name}\n  Config: {variant}\n  Colour: {color}\n  Price: {price}\n\nPlease confirm availability and warranty.',
    waTemplateNoVar:   'Hi {biz}, I would like to enquire about:\n\u2022 {name}\n  Price: {price}\n\nPlease confirm availability and warranty.',
    badges: {
      new:      { label: 'New',          bg: '#1a56db', color: '#fff' },
      sale:     { label: 'Deal',         bg: '#ea580c', color: '#fff' },
      out:      { label: 'Sold Out',     bg: '#6b7280', color: '#fff' },
      warranty: { label: '1yr Warranty', bg: '#16a34a', color: '#fff' },
    },
    specsLabel: 'Specifications',
  },
};

const TEMPLATE_RENDERER_MAP = {
  'fashion-retail':   'fashion',
  'boutique-fashion': 'fashion',
  'boutique':         'fashion',
  'grocery-fmcg':     'grocery',
  'grocery':          'grocery',
  'hardware-store':   'hardware',
  'hardware':         'hardware',
  'beauty-salon':     'beauty',
  'electronics':      'electronics',
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
  const isOut    = (product.stock || '').toLowerCase() === 'out';
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
  return `<div class="wcz-prod-card-specs">${
    entries.map(([k, v]) => `<span class="wcz-prod-spec-chip">${_esc(String(v))}</span>`).join('')
  }</div>`;
}

function buildCardStockHtml(product) {
  const isOut = (product.stock || '').toLowerCase() === 'out';
  if (isOut) return `<div class="wcz-prod-stock wcz-prod-stock-out">Out of stock</div>`;
  return `<div class="wcz-prod-stock wcz-prod-stock-in">In stock</div>`;
}

function buildProductCard(product, renderer, ctx, addonActive) {
  const isOut      = (product.stock || '').toLowerCase() === 'out';
  const name       = product.name || product.title || '';
  const price      = product.price || '';
  const priceWas   = product.price_was || '';
  const cat        = (product.category || '').trim();
  const primaryImg = product.image || product.photo || '';
  const allImgs    = Array.isArray(product.images) && product.images.length
    ? product.images : primaryImg ? [primaryImg] : [];

  const photoEl = primaryImg
    ? `<img src="${_esc(primaryImg)}" alt="${_esc(name)}" loading="lazy">`
    : `<div class="wcz-prod-photo-ph"><svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="m3 9 3-3 4 4 4-4 4 4"/><circle cx="7.5" cy="7.5" r="1"/></svg></div>`;

  const stockOverlay = isOut
    ? `<div class="wcz-prod-stock-overlay">${_esc(renderer.badges.out?.label || 'Out of stock')}</div>`
    : '';

  const badgeHtml = buildBadgeHtml(product, renderer);

  let priceHtml = '';
  if (renderer.cardShowPrice === 'overlay') {
    priceHtml = price ? `<div class="wcz-prod-price-overlay">${_esc(price)}</div>` : '';
  } else if (renderer.cardShowPrice === 'prominent') {
    priceHtml = price
      ? `<div class="wcz-prod-price wcz-prod-price-prominent">${_esc(price)}${priceWas ? `<span class="wcz-prod-price-old">${_esc(priceWas)}</span>` : ''}</div>`
      : '';
  } else {
    priceHtml = price
      ? `<div class="wcz-prod-price">${_esc(price)}${priceWas ? `<span class="wcz-prod-price-old">${_esc(priceWas)}</span>` : ''}</div>`
      : '';
  }

  const cardSpecsHtml = renderer.cardShowSpecs ? buildCardSpecsHtml(product) : '';
  const swatchHtml    = buildCardSwatchesHtml(product.colors || [], renderer);

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

  // Escape name and price for inline onclick (same pattern as grill-house)
  const sn = name.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
  const sp = price.replace(/\\/g, '\\\\').replace(/'/g, "\\'");

  // Add to cart button — gated behind the whatsapp_store addon. When inactive,
  // the card stays fully clickable to open the quick-view drawer (browsing is
  // unaffected); only the ordering CTA is omitted.
  let addBtn = '';
  if (addonActive !== false) {
    addBtn = isOut
      ? `<button class="wcz-add-btn" disabled>Sold out</button>`
      : `<button class="wcz-add-btn" onclick="wczAddToOrder({name:'${sn}',price:'${sp}'},this)">+ Add to cart</button>`;
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

// -- UPDATED v5.4: drawer's Add to cart + Buy now block gated on addonActive --
function buildDrawerHtml(renderer, addonActive) {
  const hasQty    = renderer.showQuantity;
  const hasSpecs  = renderer.drawerShowSpecs;
  const hasDetail = renderer.drawerShowDetails;
  const priceTop  = renderer.drawerPricePos === 'top';

  const actionsHtml = addonActive === false
    ? `<p class="wcz-qv-note">Contact us directly to enquire about this item.</p>`
    : `<div class="wcz-qv-actions">
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

// -- cart bar + WA FAB HTML (used by buildProductScript's self-injection) ----
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

// NEW buildProductScript - self-contained, no external token dependencies
// Mirrors grill-house: injects its own DOM, wires its own events
// Templates only need: {{wcz_qv_drawer_html}}, {{wcz_lb_html}}, {{wcz_products_script}}
//
// v5.4: addonActive gates the cart bar / WA FAB injection and no-ops the
// ordering functions client-side too, as defense in depth alongside the
// server-side HTML omission in buildProductCard/buildDrawerHtml.

function buildProductScript(products, renderer, ctx, addonActive) {
  const productsJson = JSON.stringify(products);
  const rendererJson = JSON.stringify({
    colorStyle:        renderer.colorStyle,
    showColorName:     renderer.showColorName,
    colorLabel:        renderer.colorLabel,
    variantLabel:      renderer.variantLabel,
    showQuantity:      renderer.showQuantity,
    drawerShowSpecs:   renderer.drawerShowSpecs,
    drawerShowDetails: renderer.drawerShowDetails,
    drawerShowRelated: renderer.drawerShowRelated,
    showWarranty:      renderer.showWarranty,
    drawerImageLayout: renderer.drawerImageLayout,
    waTemplate:        renderer.waTemplate,
    waTemplateNoVar:   renderer.waTemplateNoVar,
  });

  const waNum   = (ctx.waNum   || '').replace(/'/g, "\\'");
  const bizName = (ctx.bizName || '').replace(/'/g, "\\'");

  // Cart bar HTML — injected by script into body. Empty when addon inactive.
  const cartBarHtml = addonActive === false ? '' : `<button class="wcz-order-fab" id="wcz-order-fab" onclick="wczCartToggle()"><svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="9" cy="21" r="1"/><circle cx="20" cy="21" r="1"/><path d="M1 1h4l2.68 13.39a2 2 0 0 0 2 1.61h9.72a2 2 0 0 0 2-1.61L23 6H6"/></svg> My order <span class="wcz-order-count" id="wcz-order-count">0</span></button><div class="wcz-order-panel" id="wcz-order-panel"><div class="wcz-order-hdr"><span>Your order</span><button class="wcz-order-hdr-close" onclick="wczCartToggle()">&#x2715;</button></div><div class="wcz-order-items" id="wcz-order-items"><div class="wcz-order-empty">Your order is empty.<br>Add items to get started.</div></div><div class="wcz-order-total" id="wcz-order-total" style="display:none"></div><div class="wcz-order-actions"><button class="wcz-order-clear" onclick="wczCartClear()">Clear</button><a class="wcz-order-send" id="wcz-order-send" href="#" target="_blank" rel="noopener">Send on WhatsApp &#x1F4AC;</a></div></div>`;

  // WA FAB HTML — injected by script into body. Empty when addon inactive.
  const waFabHtml = (addonActive !== false && waNum)
    ? `<a class="wcz-wa-fab" id="wcz-wa-fab" href="https://wa.me/${waNum}?text=${encodeURIComponent('Hello ' + bizName + ', I have an enquiry.')}" target="_blank" rel="noopener" aria-label="WhatsApp enquiry"><div class="wcz-wa-fab-pulse"></div><svg viewBox="0 0 24 24" width="26" height="26" fill="#fff" stroke="none"><path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 0 1-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 0 1-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 0 1 2.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0 0 12.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 0 0 5.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 0 0-3.48-8.413Z"/></svg></a>`
    : '';

  return `<script>
(function(){
'use strict';

var WCZ_PRODUCTS = ${productsJson};
var WCZ_R        = ${rendererJson};
var WCZ_WA       = '${waNum}';
var WCZ_BIZ      = '${bizName}';
var WCZ_ADDON_ACTIVE = ${addonActive === false ? 'false' : 'true'};

/* ── SELF-INJECT CART + WA FAB INTO BODY (skipped when addon inactive) ── */
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

/* ── CART STATE ─────────────────────────────────────── */
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

/* WA FAB scroll reveal */
window.addEventListener('scroll', function() {
  var f = document.getElementById('wcz-wa-fab');
  if (f) f.classList.toggle('wcz-wa-fab-visible', window.scrollY > 300);
}, { passive:true });

/* ── DRAWER ─────────────────────────────────────────── */
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

/* Add-to-cart — use event delegation on drawer, not getElementById */
document.addEventListener('click', function(e) {
  if (!WCZ_ADDON_ACTIVE) return;
  var btn = e.target.closest('#wcz-qv-add-cart');
  if (!btn) return;
  var p = state.product;
  if (!p) return;
  var qty = WCZ_R.showQuantity ? state.qty : 1;
  wczCartAdd(p.name, p.price, state.color, state.variant, qty);
  closeDrawer();
  /* green flash on FAB */
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
      /* swap main image to colour-specific image if product has one */
      var colorImg = btn.dataset.img || '';
      if (colorImg) {
        var mainEl = $('wcz-qv-img-0');
        if (mainEl) mainEl.innerHTML = '<img src="' + colorImg + '" alt="" style="width:100%;height:100%;object-fit:cover;cursor:zoom-in" onclick="wczOpenLightbox(0)">';
      }
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

/* ── EVENT WIRING ────────────────────────────────────── */
/* Use event delegation throughout so it works regardless of DOM order */
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

/* ── PUBLIC API ──────────────────────────────────────── */
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

/* Direct card add — no drawer needed when no variants */
window.wczCardAdd = function(btn, name, price) {
  if (!WCZ_ADDON_ACTIVE) return;
  wczCartAdd(name, price, '', '', 1);
  var orig = btn.textContent;
  btn.textContent = 'Added \u2713';
  btn.disabled = true;
  setTimeout(function(){ btn.textContent = orig; btn.disabled = false; }, 1400);
};

/* Card add-to-order — called by wcz-add-btn onclick="wczAddToOrder({name,price},this)" */
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

/* Init */
cartRender();

})();
<\/script>`;
}

// -- UPDATED v5.4: buildCommerceModule reads ctx.addonActive and threads it
// through to all four builders. Defaults to true (unaffected) when the
// caller doesn't pass it, so older render-worker versions see no change.
function buildCommerceModule(products, templateId, contentTheme, ctx) {
  const renderer = resolveRenderer(templateId, contentTheme);
  const addonActive = (ctx && ctx.addonActive === false) ? false : true;
  return {
    gridHtml:   buildGridHtml(products, renderer, ctx, addonActive),
    filterHtml: buildFilterHtml(products),
    drawerHtml: buildDrawerHtml(renderer, addonActive),
    lbHtml:     buildLightboxHtml(),
    scriptHtml: buildProductScript(products, renderer, ctx, addonActive),
  };
}

// -- buildCommerceCSS — injected into self-contained template heads ------
function buildCommerceCSS() {
  return `<style>
/* ── WCZ COMMERCE SDK ── */
.wcz-prod-grid{display:grid;grid-template-columns:repeat(2,1fr);gap:20px}
@media(min-width:640px){.wcz-prod-grid{grid-template-columns:repeat(3,1fr)}}
.wcz-prod-card{cursor:pointer;background:var(--ink2,#1a1a1a);color:#fff;border-radius:6px;overflow:hidden;transition:transform .2s}
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
#wcz-qv-drawer{position:fixed;top:0;right:0;bottom:0;z-index:195;width:min(480px,100vw);background:var(--ink2,#1a1a1a);color:#fff;overflow-y:auto;overflow-x:hidden;transform:translateX(100%);transition:transform .32s cubic-bezier(.4,0,.2,1);display:flex;flex-direction:column}
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
.wcz-qv-btn-cart:hover{background:var(--gold,#c8a24a);color:var(--btn-fg,#0c0c0c)}
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
.wcz-order-count{background:var(--gold,#c8a24a);color:var(--btn-fg,#0c0c0c);border-radius:50%;width:20px;height:20px;display:inline-flex;align-items:center;justify-content:center;font-size:.7rem;font-weight:800}
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
.wcz-nav-cart-active{background:var(--gold,#c8a24a)!important;color:var(--btn-fg,#0c0c0c)!important;border-color:var(--gold,#c8a24a)!important}
.wcz-nav-cart-count{background:rgba(0,0,0,.2);border-radius:50%;width:18px;height:18px;display:inline-flex;align-items:center;justify-content:center;font-size:.68rem;font-weight:800;margin-left:4px;vertical-align:middle}
.wcz-wa-fab{position:fixed;bottom:1.5rem;right:1.5rem;z-index:900;width:54px;height:54px;border-radius:50%;background:#25D366;display:flex;align-items:center;justify-content:center;box-shadow:0 4px 20px rgba(37,211,102,.4);opacity:0;transform:scale(.85);transition:opacity .3s,transform .3s;pointer-events:none}
.wcz-wa-fab.wcz-wa-fab-visible{opacity:1;transform:scale(1);pointer-events:auto}
.wcz-wa-fab:hover{transform:scale(1.08)!important;box-shadow:0 6px 28px rgba(37,211,102,.55)}
.wcz-wa-fab-pulse{position:absolute;inset:0;border-radius:50%;border:2px solid #25D366;animation:wcz-fabpulse 2s infinite}
@keyframes wcz-fabpulse{0%{transform:scale(1);opacity:.8}100%{transform:scale(1.8);opacity:0}}
.wcz-add-btn{width:100%;margin-top:10px;padding:8px 12px;font-size:.72rem;font-weight:700;letter-spacing:.06em;text-transform:uppercase;border-radius:2px;cursor:pointer;transition:background .2s,transform .15s;border:none;font-family:inherit;background:var(--gold,#c8a24a);color:var(--btn-fg,#0c0c0c)}
.wcz-add-btn:hover{background:var(--gold2,#a87030);transform:translateY(-1px)}
.wcz-add-btn:disabled{background:var(--ink3,#2a2a2a);color:rgba(255,255,255,.3);cursor:not-allowed;transform:none}
.wcz-order-panel .wcz-order-hdr button{color:#fff;background:rgba(255,255,255,.15);width:28px;height:28px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:.85rem;border:none;cursor:pointer}
</style>`;
}

// =============================================================================
// END UNIVERSAL COMMERCE SDK
// =============================================================================
