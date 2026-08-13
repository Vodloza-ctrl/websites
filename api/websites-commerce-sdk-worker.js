/**
 * websites-commerce-sdk-worker
 *
 * Service binding worker — called internally by websites-render-worker.
 * Exposes the Universal Commerce SDK as an HTTP service (no public routes).
 *
 * v5.6 CHANGE — INLINE CARD CONTROLS WERE INERT (stopPropagation bug):
 *   buildProductCard() wrapped its colour/size pickers and Pay/Add buttons
 *   in a div with onclick="event.stopPropagation()", intended only to stop
 *   those clicks from ALSO opening the drawer (the whole card had
 *   onclick="wczOpenProduct(this)"). But every handler for those inline
 *   controls is a delegated document-level listener (cardResolve() and the
 *   click handlers near the bottom of this file all use
 *   document.addEventListener('click', ...) with .closest() matching) — so
 *   stopping propagation at the wrapper meant the click never reached
 *   document at all. Symptom: color swatches, size chips, Pay Online, and
 *   Add to Cart all looked present but did nothing when clicked, no error,
 *   because no listener ever ran. The drawer worked fine throughout, since
 *   it's opened by clicking the photo, which sat outside this wrapper.
 *   Fix: removed stopPropagation entirely, and moved the drawer's
 *   open-trigger off the whole card and onto just the photo and product
 *   name (both now carry their own onclick calling
 *   wczOpenProduct(this.closest('.wcz-prod-card'))). Picking a size/colour
 *   or hitting Pay/Add no longer has any conflicting behaviour to avoid.
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

  // Escape name/price/id for inline attributes (same pattern as grill-house)
  const sn    = name.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
  const sp    = price.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
  const spid  = String(product.id || '').replace(/\\/g, '\\\\').replace(/'/g, "\\'");
  const sptype = String(product.product_type || 'physical').replace(/\\/g, '\\\\').replace(/'/g, "\\'");

  const photoEl = primaryImg
    ? `<img src="${_esc(primaryImg)}" alt="${_esc(name)}" loading="lazy">`
    : `<div class="wcz-prod-photo-ph"><svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="m3 9 3-3 4 4 4-4 4 4"/><circle cx="7.5" cy="7.5" r="1"/></svg></div>`;

  const stockOverlay = isOut
    ? `<div class="wcz-prod-stock-overlay">${_esc(renderer.badges.out?.label || 'Out of stock')}</div>`
    : '';

  const badgeHtml = buildBadgeHtml(product, renderer);

  let priceHtml = '';
  if (renderer.cardShowPrice === 'overlay') {
    priceHtml = price ? `<div class="wcz-prod-price-overlay" id="wcz-card-price-${spid}">${_esc(price)}</div>` : '';
  } else if (renderer.cardShowPrice === 'prominent') {
    priceHtml = price
      ? `<div class="wcz-prod-price wcz-prod-price-prominent" id="wcz-card-price-${spid}">${_esc(price)}${priceWas ? `<span class="wcz-prod-price-old">${_esc(priceWas)}</span>` : ''}</div>`
      : '';
  } else {
    priceHtml = price
      ? `<div class="wcz-prod-price" id="wcz-card-price-${spid}">${_esc(price)}${priceWas ? `<span class="wcz-prod-price-old">${_esc(priceWas)}</span>` : ''}</div>`
      : '';
  }

  const cardSpecsHtml = renderer.cardShowSpecs ? buildCardSpecsHtml(product) : '';

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
    // SKU-level matrix from the normalized products/product_variants tables,
    // when present (render-worker's getStoreProducts adapter). Each entry is
    // { variant_id, sku, option_values:{Size,Color}, price, stock }. When
    // null/absent (legacy JSON products, or a product with has_variants=0),
    // the drawer falls back to today's independent colour/size behaviour.
    variant_matrix: Array.isArray(product._variantMatrix) ? product._variantMatrix : null,
    product_type: product.product_type || 'physical',
  };

  // Any product with real options routes through the same SKU-matrix
  // resolution logic — inline on the card now, not forced into the
  // drawer. Legacy (non-matrix) variant products still get pickers here
  // too, just without per-combo price/stock (same as the drawer's
  // fallback behaviour for un-migrated products).
  const colors = Array.isArray(product.colors) ? product.colors : [];
  const sizes  = Array.isArray(product.variants) ? product.variants : [];
  const hasVariants = (Array.isArray(product._variantMatrix) && product._variantMatrix.length > 0) || colors.length > 0 || sizes.length > 0;
  const storePaymentsEnabled = !!(ctx && ctx.storePaymentsEnabled);

  let colorPickerHtml = '';
  if (colors.length) {
    colorPickerHtml = `<div class="wcz-card-picker-label" id="wcz-card-colorlabel-${spid}">Colour — <span>${_esc(colors[0].name || '')}</span></div>`
      + `<div class="wcz-card-colors" data-pid-scope="${spid}">` + colors.map((c, i) =>
        `<button type="button" class="wcz-card-color${i === 0 ? ' active' : ''}" style="background:${_esc(c.hex || c.color || '#ccc')}" title="${_esc(c.name || '')}" data-pid="${spid}" data-color="${_esc(c.name || '')}" aria-label="${_esc(c.name || '')}"></button>`
      ).join('') + `</div>`;
  }
  let sizePickerHtml = '';
  if (sizes.length) {
    sizePickerHtml = `<div class="wcz-card-picker-label">Size</div>`
      + `<div class="wcz-card-sizes" data-pid-scope="${spid}">` + sizes.map(s => {
        const label = typeof s === 'string' ? s : (s.label || s.name || String(s));
        return `<button type="button" class="wcz-card-size" data-pid="${spid}" data-size="${_esc(label)}">${_esc(label)}</button>`;
      }).join('') + `</div>`;
  }

  // Pay Online is the primary action — it's the one that actually gets the
  // owner paid immediately. Before a full selection is made, this collapses
  // to ONE neutral "Select options" button (not duplicate locked stubs for
  // both Pay and Add) — once resolved, Pay Online takes the full-width
  // primary slot and Add to Cart / WhatsApp share a smaller secondary row,
  // closer to a standard single-CTA product card instead of three stacked
  // full-width buttons competing for attention.
  let cardActionsHtml = '';
  if (addonActive !== false) {
    if (isOut) {
      cardActionsHtml = `<div class="wcz-card-actions"><button type="button" class="wcz-card-add-btn" disabled>Sold out</button></div>`;
    } else if (hasVariants) {
      // Locked state: one button, not two. JS swaps this whole block's
      // relevant buttons live once a full selection resolves — see
      // cardResolve(), which toggles disabled/label on whichever of these
      // exists rather than re-rendering the DOM.
      const payBtnLocked = storePaymentsEnabled
        ? `<button type="button" class="wcz-card-pay-btn" data-pid="${spid}" disabled>Select options</button>`
        : '';
      const addBtnLocked = storePaymentsEnabled ? '' : `<button type="button" class="wcz-card-add-btn wcz-card-add-btn-full" data-pid="${spid}" disabled>Select options</button>`;
      const waBtnHtml = `<button type="button" class="wcz-card-wa-btn" data-pid="${spid}"><svg viewBox="0 0 24 24" fill="currentColor" stroke="none"><path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 0 1-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 0 1-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 0 1 2.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0 0 12.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 0 0 5.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 0 0-3.48-8.413Z"/></svg>WhatsApp</button>`;
      // Add to Cart button always exists in the DOM (even when Pay is the
      // locked primary) so cardResolve() has something to un-disable once
      // a selection completes — just visually secondary via CSS, tucked
      // into the row below Pay Online.
      const addBtnSecondary = storePaymentsEnabled
        ? `<button type="button" class="wcz-card-add-btn" data-pid="${spid}" disabled>Add to cart</button>`
        : '';
      cardActionsHtml = `<div class="wcz-card-actions">${payBtnLocked}${addBtnLocked}<div class="wcz-card-actions-row">${addBtnSecondary}${waBtnHtml}</div></div>`;
    } else {
      const payBtnHtml = storePaymentsEnabled
        ? `<button type="button" class="wcz-card-pay-btn" data-pid="${spid}">Pay online</button>`
        : '';
      const addBtnHtml = `<button type="button" class="wcz-card-add-btn${storePaymentsEnabled ? '' : ' wcz-card-add-btn-full'}" data-pid="${spid}">Add to cart</button>`;
      const waBtnHtml = `<button type="button" class="wcz-card-wa-btn" data-pid="${spid}"><svg viewBox="0 0 24 24" fill="currentColor" stroke="none"><path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 0 1-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 0 1-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 0 1 2.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0 0 12.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 0 0 5.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 0 0-3.48-8.413Z"/></svg>WhatsApp</button>`;
      cardActionsHtml = storePaymentsEnabled
        ? `<div class="wcz-card-actions">${payBtnHtml}<div class="wcz-card-actions-row">${addBtnHtml}${waBtnHtml}</div></div>`
        : `<div class="wcz-card-actions">${addBtnHtml}${waBtnHtml}</div>`;
    }
  }

  // v5.6 — was: `<div onclick="event.stopPropagation()">...`. That stopped
  // clicks on color swatches, size chips, and the Pay/Add buttons from ever
  // reaching document — but EVERY handler for those controls is a delegated
  // document-level listener (see cardResolve() and the click handlers
  // further down this file), so stopping propagation here silently broke
  // all of them: no color/size selection ever registered, buttons stayed
  // permanently on "Select options". The only reason anything worked at
  // all was the drawer, opened by clicking the photo — which sits outside
  // this wrapper and was never affected. Removing stopPropagation lets
  // these clicks bubble normally; the drawer's own open-trigger moved onto
  // just the photo/name (below) so picking a size doesn't also pop the
  // drawer open.
  const interactiveBlock = (colorPickerHtml || sizePickerHtml || cardActionsHtml)
    ? `<div>${colorPickerHtml}${sizePickerHtml}${cardActionsHtml}</div>`
    : '';


  return `<div class="wcz-prod-card" data-cat="${_esc(cat)}" data-id="${_esc(product.id || '')}" data-qv="${_esc(JSON.stringify(qvPayload))}">
  <div class="wcz-prod-photo" style="aspect-ratio:${renderer.cardAspect};cursor:pointer" onclick="wczOpenProduct(this.closest('.wcz-prod-card'))">
    ${photoEl}
    ${badgeHtml}
    ${stockOverlay}
    ${renderer.cardShowPrice === 'overlay' ? priceHtml : ''}
  </div>
  <div class="wcz-prod-info">
    <div class="wcz-prod-name" style="cursor:pointer" onclick="wczOpenProduct(this.closest('.wcz-prod-card'))">${_esc(name)}</div>
    ${renderer.cardShowPrice !== 'overlay' ? priceHtml : ''}
    ${cardSpecsHtml}
    ${interactiveBlock}
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
function buildDrawerHtml(renderer, addonActive, storePaymentsEnabled) {
  const hasQty    = renderer.showQuantity;
  const hasSpecs  = renderer.drawerShowSpecs;
  const hasDetail = renderer.drawerShowDetails;
  const priceTop  = renderer.drawerPricePos === 'top';

  const payOnlineBtn = (addonActive !== false && storePaymentsEnabled)
    ? `<button class="wcz-qv-btn-payonline" id="wcz-qv-pay-online">Pay online now</button>`
    : '';

  const actionsHtml = addonActive === false
    ? `<p class="wcz-qv-note">Contact us directly to enquire about this item.</p>`
    : `<div class="wcz-qv-actions">
    ${payOnlineBtn}
    <button class="wcz-qv-btn-cart" id="wcz-qv-add-cart">
      <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="9" cy="21" r="1"/><circle cx="20" cy="21" r="1"/><path d="M1 1h4l2.68 13.39a2 2 0 0 0 2 1.61h9.72a2 2 0 0 0 2-1.61L23 6H6"/></svg>
      Add to cart
    </button>
    <a class="wcz-qv-btn-buynow" id="wcz-qv-wa" href="#" target="_blank" rel="noopener">
      <svg viewBox="0 0 24 24" width="12" height="12" fill="currentColor" stroke="none"><path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 0 1-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 0 1-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 0 1 2.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0 0 12.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 0 0 5.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 0 0-3.48-8.413Z"/></svg>
      Or order via WhatsApp
    </a>
  </div>
  <p class="wcz-qv-note">Paying online sends the money straight to us — instant confirmation, no waiting on WhatsApp.</p>`;

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
  const storePaymentsEnabled = !!ctx.storePaymentsEnabled;
  const siteId          = (ctx.siteId || '').replace(/'/g, "\\'");
  const checkoutApiBase = (ctx.checkoutApiBase || 'https://api.websites.co.zw').replace(/'/g, "\\'");

  // Cart bar HTML — injected by script into body. Empty when addon inactive.
  // Adds a "Pay online" action alongside "Send on WhatsApp" when the site
  // has Store Payments enabled — the WhatsApp path is never removed, this
  // is purely additive.
  const payOnlineCartBtn = storePaymentsEnabled
    ? `<button class="wcz-order-pay-online" id="wcz-order-pay-online">Pay online</button>`
    : '';
  const cartBarHtml = addonActive === false ? '' : `<button class="wcz-order-fab" id="wcz-order-fab" onclick="wczCartToggle()"><svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="9" cy="21" r="1"/><circle cx="20" cy="21" r="1"/><path d="M1 1h4l2.68 13.39a2 2 0 0 0 2 1.61h9.72a2 2 0 0 0 2-1.61L23 6H6"/></svg> My order <span class="wcz-order-count" id="wcz-order-count">0</span></button><div class="wcz-order-panel" id="wcz-order-panel"><div class="wcz-order-hdr"><span>Your order</span><button class="wcz-order-hdr-close" onclick="wczCartToggle()">&#x2715;</button></div><div class="wcz-order-items" id="wcz-order-items"><div class="wcz-order-empty">Your order is empty.<br>Add items to get started.</div></div><div class="wcz-order-total" id="wcz-order-total" style="display:none"></div><div class="wcz-order-actions">${payOnlineCartBtn}<a class="wcz-order-send" id="wcz-order-send" href="#" target="_blank" rel="noopener">WhatsApp</a><button class="wcz-order-clear" onclick="wczCartClear()">Clear</button></div></div>`;

  // Checkout modal — the phone/name/shipping form, the "waiting on
  // EcoCash" step, and success/failure states. Only injected at all when
  // Store Payments is enabled; otherwise the WhatsApp-only flow is
  // completely unaffected by any of this.
  const checkoutModalHtml = storePaymentsEnabled ? `
<div id="wcz-checkout-overlay"></div>
<div id="wcz-checkout-modal" role="dialog" aria-modal="true" aria-label="Checkout">
  <button class="wcz-checkout-close" id="wcz-checkout-close" aria-label="Close">&#x2715;</button>
  <div id="wcz-checkout-step-form">
    <h3 class="wcz-checkout-title">Pay online</h3>
    <p class="wcz-checkout-summary" id="wcz-checkout-summary"></p>
    <label class="wcz-checkout-label">Your name</label>
    <input class="wcz-checkout-input" id="wcz-checkout-name" type="text" placeholder="Your name" autocomplete="name">
    <label class="wcz-checkout-label">EcoCash number</label>
    <input class="wcz-checkout-input" id="wcz-checkout-phone" type="tel" placeholder="e.g. 0771234567" autocomplete="tel">
    <label class="wcz-checkout-label">Email <span style="font-weight:400;opacity:.6">optional — for your receipt</span></label>
    <input class="wcz-checkout-input" id="wcz-checkout-email" type="email" placeholder="you@example.com" autocomplete="email">
    <div id="wcz-checkout-shipping-wrap" style="display:none">
      <label class="wcz-checkout-label">Delivery address</label>
      <textarea class="wcz-checkout-input wcz-checkout-textarea" id="wcz-checkout-address" placeholder="Where should this be delivered?"></textarea>
    </div>
    <p class="wcz-checkout-error" id="wcz-checkout-error" style="display:none"></p>
    <button class="wcz-checkout-submit" id="wcz-checkout-submit">Pay now</button>
    <p class="wcz-checkout-note">You'll get an EcoCash prompt on your phone to approve.</p>
  </div>
  <div id="wcz-checkout-step-waiting" style="display:none">
    <div class="wcz-checkout-spinner"></div>
    <h3 class="wcz-checkout-title">Check your phone</h3>
    <p class="wcz-checkout-note">Approve the EcoCash prompt to complete your payment.</p>
    <p class="wcz-checkout-note" id="wcz-checkout-waiting-sub"></p>
  </div>
  <div id="wcz-checkout-step-success" style="display:none">
    <div class="wcz-checkout-check">&#10003;</div>
    <h3 class="wcz-checkout-title">Payment received</h3>
    <p class="wcz-checkout-note" id="wcz-checkout-success-note"></p>
    <button class="wcz-checkout-submit" id="wcz-checkout-done">Done</button>
  </div>
  <div id="wcz-checkout-step-failed" style="display:none">
    <h3 class="wcz-checkout-title">Payment didn't go through</h3>
    <p class="wcz-checkout-note" id="wcz-checkout-failed-note"></p>
    <button class="wcz-checkout-submit" id="wcz-checkout-retry">Try again</button>
  </div>
</div>` : '';


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
var WCZ_STORE_PAYMENTS_ENABLED = ${storePaymentsEnabled ? 'true' : 'false'};
var WCZ_SITE_ID = '${siteId}';
var WCZ_CHECKOUT_API = '${checkoutApiBase}';

/* ── SELF-INJECT CART + WA FAB + CHECKOUT MODAL INTO BODY ────────────── */
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
  if (${JSON.stringify(checkoutModalHtml)} && !document.getElementById('wcz-checkout-modal')) {
    var coWrap = document.createElement('div');
    coWrap.innerHTML = ${JSON.stringify(checkoutModalHtml)};
    while (coWrap.firstChild) document.body.appendChild(coWrap.firstChild);
  }
})();

/* ── CART STATE ─────────────────────────────────────── */
var _cart = [];
var checkoutState = { items: [], hasPhysical: false, isCartCheckout: false, polling: null, pollAttempts: 0, reference: null, orderId: null };

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

window.wczCartAdd = function(opts) {
  if (!WCZ_ADDON_ACTIVE) return;
  var name = opts.name || '', price = opts.price || '', color = opts.color || '', variant = opts.variant || '';
  var qty = opts.qty || 1, variantId = opts.variantId || null, productId = opts.productId || null;
  var productType = opts.productType || 'physical';
  // Key on productId+variantId when we have them (SKU-precise dedupe); fall
  // back to the old label-based key for anything added without an id (kept
  // only for backward compatibility with the legacy wczCardAdd helper).
  var key = (productId || name) + '|' + (variantId || '') + '|' + color + '|' + variant;
  var ex  = _cart.find(function(i) {
    return ((i.productId || i.name) + '|' + (i.variantId||'') + '|' + (i.color||'') + '|' + (i.variant||'')) === key;
  });
  if (ex) { ex.qty += qty; }
  else    { _cart.push({ productId:productId, variantId:variantId, productType:productType, name:name, price:price, color:color, variant:variant, qty:qty }); }
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
var state = {
  product:null, imgIdx:0, imgs:[], color:'', variant:'', qty:1, lbImgs:[], lbIdx:0,
  /* SKU matrix (Store Payments): the current product's variant_matrix (or
     null when the product has no real matrix — legacy JSON product, or
     has_variants=0). selectedVariantId/-Price/-Stock reflect the exact
     combo currently picked, resolved by refreshVariantSelection(). */
  variantMatrix:null, selectedVariantId:null, selectedVariantPrice:null, selectedVariantStock:null
};

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
  var effectivePrice = state.selectedVariantPrice || p.price;
  var msg = tpl
    .replace('{biz}',     WCZ_BIZ)
    .replace('{name}',    p.name    || '')
    .replace('{color}',   state.color   || (WCZ_R.colorLabel   ? 'Not selected' : ''))
    .replace('{variant}', state.variant || (WCZ_R.variantLabel ? 'Not selected' : ''))
    .replace('{qty}',     qty || '1')
    .replace('{price}',   effectivePrice || '');
  return WCZ_WA ? 'https://wa.me/' + WCZ_WA + '?text=' + encodeURIComponent(msg) : '#';
}
function refreshDrawerActions() { setHref('wcz-qv-wa', buildBuyNowMsg()); }

/* ── SKU MATRIX RESOLUTION (Store Payments) ──────────────
   When a product has a real variant_matrix (from the normalized
   products/product_variants tables), Size and Color are no longer two
   independent pickers with one flat product price — each exact combo is
   its own SKU with its own price/stock. This resolves the currently
   selected combo against that matrix and updates price + add-to-cart
   availability accordingly. Products without a matrix (legacy JSON, or
   has_variants=0) are completely unaffected — everything below no-ops. */

function matrixNeeds(key) {
  var vm = state.variantMatrix;
  if (!vm || !vm.length) return false;
  return vm.some(function(v){ return v.option_values && (key in v.option_values); });
}

function findMatrixVariant(color, size) {
  var vm = state.variantMatrix;
  if (!vm || !vm.length) return null;
  var needColor = matrixNeeds('Color');
  var needSize  = matrixNeeds('Size');
  return vm.find(function(v){
    var ov = v.option_values || {};
    if (needColor && ov.Color !== color) return false;
    if (needSize  && ov.Size  !== size)  return false;
    return true;
  }) || null;
}

function setAddCartState(enabled, label) {
  var btn = $('wcz-qv-add-cart');
  if (!btn) return;
  btn.disabled = !enabled;
  if (label) btn.textContent = label;
  else btn.innerHTML = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="9" cy="21" r="1"/><circle cx="20" cy="21" r="1"/><path d="M1 1h4l2.68 13.39a2 2 0 0 0 2 1.61h9.72a2 2 0 0 0 2-1.61L23 6H6"/></svg> Add to cart';
}

/* Re-grey size buttons that would be out of stock for the currently
   selected colour (and vice versa isn't needed since colour is picked
   first) — cross-filters the picker instead of only checking on submit. */
function refreshSizeAvailability() {
  var el = $('wcz-qv-sizes');
  if (!el || !state.variantMatrix) return;
  var needColor = matrixNeeds('Color');
  el.querySelectorAll('button[data-val]').forEach(function(btn){
    var size = btn.dataset.val;
    var match = needColor ? findMatrixVariant(state.color, size) : findMatrixVariant('', size);
    var outOfStock = match ? (match.stock || 0) <= 0 : false;
    btn.classList.toggle('out', outOfStock);
    btn.disabled = outOfStock;
  });
}

function refreshVariantSelection() {
  var vm = state.variantMatrix;
  if (!vm || !vm.length) {
    // No matrix at all — legacy behaviour, nothing to resolve.
    refreshDrawerActions();
    return;
  }
  var needColor = matrixNeeds('Color');
  var needSize  = matrixNeeds('Size');
  var complete  = (!needColor || state.color) && (!needSize || state.variant);

  if (!complete) {
    state.selectedVariantId = null; state.selectedVariantPrice = null; state.selectedVariantStock = null;
    setText('wcz-qv-price', state.product ? (state.product.price || '') : '');
    setAddCartState(false, 'Select options');
    refreshDrawerActions();
    return;
  }

  var match = findMatrixVariant(state.color, state.variant);
  if (!match) {
    state.selectedVariantId = null; state.selectedVariantPrice = null; state.selectedVariantStock = null;
    setAddCartState(false, 'Unavailable');
    refreshDrawerActions();
    return;
  }

  state.selectedVariantId    = match.variant_id;
  state.selectedVariantPrice = match.price || (state.product ? state.product.price : '');
  state.selectedVariantStock = match.stock || 0;
  setText('wcz-qv-price', state.selectedVariantPrice || '');

  if (state.selectedVariantStock <= 0) {
    setAddCartState(false, 'Sold out');
  } else {
    setAddCartState(true);
  }
  refreshSizeAvailability();
  refreshDrawerActions();
}

/* Add-to-cart — use event delegation on drawer, not getElementById */
document.addEventListener('click', function(e) {
  if (!WCZ_ADDON_ACTIVE) return;
  var btn = e.target.closest('#wcz-qv-add-cart');
  if (!btn || btn.disabled) return;
  var p = state.product;
  if (!p) return;
  // When the product has a real SKU matrix, refuse to add unless a valid,
  // in-stock combo is actually resolved — setAddCartState already disables
  // the button in that case, this is defense in depth against stale DOM.
  if (state.variantMatrix && (!state.selectedVariantId || state.selectedVariantStock <= 0)) return;
  // Legacy products (no real SKU matrix, just a plain colors/variants
  // list from the old JSON format) don't get the matrix's automatic
  // button-disabling — enforce the same "must pick an option" rule here
  // instead, so this isn't only airtight for products migrated to Store
  // Payments.
  var needsColorLegacy = !state.variantMatrix && Array.isArray(p.colors) && p.colors.length > 0 && !state.color;
  var needsSizeLegacy  = !state.variantMatrix && Array.isArray(p.variants) && p.variants.length > 0 && !state.variant;
  if (needsColorLegacy || needsSizeLegacy) {
    var origLabel = btn.textContent;
    btn.textContent = 'Select options above';
    btn.style.background = '#c0392b';
    setTimeout(function(){ btn.textContent = origLabel; btn.style.background = ''; }, 1600);
    return;
  }
  var qty = WCZ_R.showQuantity ? state.qty : 1;
  var effectivePrice = state.selectedVariantPrice || p.price;
  wczCartAdd({
    productId: p.id || null, variantId: state.selectedVariantId, productType: p.product_type || 'physical',
    name: p.name, price: effectivePrice, color: state.color, variant: state.variant, qty: qty
  });
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
      refreshVariantSelection();
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
      refreshVariantSelection();
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
  state.variantMatrix = Array.isArray(product.variant_matrix) ? product.variant_matrix : null;
  state.selectedVariantId = null; state.selectedVariantPrice = null; state.selectedVariantStock = null;
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
  // Run an initial resolution pass so a matrix product shows the right
  // "Select options" / price / stock state immediately, not just after
  // the shopper's first click.
  refreshVariantSelection();
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

/* Direct card add — no drawer needed when no variants. Legacy helper, not
   currently wired to card render (buildProductCard uses wczAddToOrder,
   which carries productId) — kept exported for backward compatibility.
   Items added this way lack productId, so they're WhatsApp-order-only,
   not eligible for "Pay online" checkout. */
window.wczCardAdd = function(btn, name, price) {
  if (!WCZ_ADDON_ACTIVE) return;
  wczCartAdd({ name: name, price: price, qty: 1 });
  var orig = btn.textContent;
  btn.textContent = 'Added \u2713';
  btn.disabled = true;
  setTimeout(function(){ btn.textContent = orig; btn.disabled = false; }, 1400);
};

/* Card add-to-order — called by wcz-add-btn onclick="wczAddToOrder({id,name,price,productType},this)" */
window.wczAddToOrder = function(item, btnEl) {
  if (!WCZ_ADDON_ACTIVE) return;
  wczCartAdd({ productId: item.id || null, name: item.name || '', price: item.price || '', productType: item.productType || 'physical', qty: 1 });
  if (btnEl) {
    var orig = btnEl.textContent;
    btnEl.textContent = 'Added \u2713';
    btnEl.disabled = true;
    setTimeout(function(){ btnEl.textContent = orig; btnEl.disabled = false; }, 1400);
  }
  var fab = document.getElementById('wcz-order-fab');
  if (fab) { fab.style.background = '#1fb357'; setTimeout(function(){ fab.style.background = ''; }, 900); }
};

/* ── STORE PAYMENTS CHECKOUT (Pay online) ────────────────
   Entirely additive alongside the WhatsApp order flow — nothing here
   replaces wczCartAdd/cartBuildWaMsg/"Send on WhatsApp". Only reachable
   when WCZ_STORE_PAYMENTS_ENABLED is true (server-gated by the site's
   Store Payments status, threaded through ctx from render-worker). ── */

function wczOpenCheckout(items, hasPhysical, isCartCheckout, summaryText) {
  if (!WCZ_STORE_PAYMENTS_ENABLED) return;
  checkoutState.items = items;
  checkoutState.hasPhysical = hasPhysical;
  checkoutState.isCartCheckout = !!isCartCheckout;
  checkoutState.reference = null;
  checkoutState.orderId = null;
  var sumEl = document.getElementById('wcz-checkout-summary');
  if (sumEl) sumEl.textContent = summaryText || '';
  var shipWrap = document.getElementById('wcz-checkout-shipping-wrap');
  if (shipWrap) shipWrap.style.display = hasPhysical ? '' : 'none';
  var submitBtn = document.getElementById('wcz-checkout-submit');
  if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = 'Pay now'; }
  showCheckoutStep('form');
  var ov = document.getElementById('wcz-checkout-overlay'), modal = document.getElementById('wcz-checkout-modal');
  if (ov) ov.classList.add('open');
  if (modal) modal.classList.add('open');
}

function openCheckoutError(msg) {
  if (!WCZ_STORE_PAYMENTS_ENABLED) return;
  var ov = document.getElementById('wcz-checkout-overlay'), modal = document.getElementById('wcz-checkout-modal');
  if (ov) ov.classList.add('open');
  if (modal) modal.classList.add('open');
  showCheckoutStep('failed');
  var note = document.getElementById('wcz-checkout-failed-note');
  if (note) note.textContent = msg;
}

function closeCheckout() {
  var ov = document.getElementById('wcz-checkout-overlay'), modal = document.getElementById('wcz-checkout-modal');
  if (ov) ov.classList.remove('open');
  if (modal) modal.classList.remove('open');
  stopPolling();
}

function showCheckoutStep(step) {
  ['form','waiting','success','failed'].forEach(function(s){
    var el = document.getElementById('wcz-checkout-step-' + s);
    if (el) el.style.display = (s === step) ? '' : 'none';
  });
  var err = document.getElementById('wcz-checkout-error');
  if (err) err.style.display = 'none';
}

function checkoutShowFieldError(msg) {
  var err = document.getElementById('wcz-checkout-error');
  if (err) { err.textContent = msg; err.style.display = ''; }
}

function checkoutErrorMessage(data) {
  var code = data && data.error;
  if (code === 'owner_not_connected')      return "Online payment isn't set up for this store yet.";
  if (code === 'insufficient_stock')       return 'Sorry, that item just sold out.';
  if (code === 'missing_shipping_address') return 'Please enter a delivery address.';
  if (code === 'mixed_cart_not_supported') return 'Please check out digital and physical items separately.';
  if (code === 'variant_required')         return 'Please choose an option for this item.';
  if (code === 'missing_customer_phone')   return 'Please enter a valid EcoCash number.';
  if (code === 'empty_cart' || code === 'empty_total') return 'Your order is empty.';
  return (data && data.message) || 'Payment could not be started. Please try again.';
}

async function submitCheckout() {
  var nameEl  = document.getElementById('wcz-checkout-name');
  var phoneEl = document.getElementById('wcz-checkout-phone');
  var emailEl = document.getElementById('wcz-checkout-email');
  var addrEl  = document.getElementById('wcz-checkout-address');
  var name    = nameEl  ? nameEl.value.trim()  : '';
  var phone   = phoneEl ? phoneEl.value.trim() : '';
  var email   = emailEl ? emailEl.value.trim() : '';
  var address = addrEl  ? addrEl.value.trim()  : '';

  if (!phone || phone.replace(/\D/g, '').length < 9) {
    checkoutShowFieldError('Please enter a valid EcoCash number.');
    return;
  }
  // Email is optional and only ever used as a Paynow receipt fallback — it
  // must never be able to block a real purchase over a validation edge
  // case. If it doesn't look like an email, just drop it silently rather
  // than stopping checkout.
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    email = '';
  }
  if (checkoutState.hasPhysical && !address) {
    checkoutShowFieldError('Please enter a delivery address.');
    return;
  }
  if (!checkoutState.items || !checkoutState.items.length) {
    checkoutShowFieldError('Your order is empty.');
    return;
  }

  var submitBtn = document.getElementById('wcz-checkout-submit');
  if (submitBtn) { submitBtn.disabled = true; submitBtn.textContent = 'Sending...'; }

  try {
    var resp = await fetch(WCZ_CHECKOUT_API + '/store/checkout', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        site_id: WCZ_SITE_ID,
        items: checkoutState.items,
        customer_name: name,
        customer_phone: phone,
        customer_email: email || undefined,
        shipping_address: checkoutState.hasPhysical ? address : undefined,
      }),
    });
    var data = await resp.json();

    if (!resp.ok) {
      checkoutShowFieldError(checkoutErrorMessage(data));
      if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = 'Pay now'; }
      return;
    }

    checkoutState.reference = data.reference;
    checkoutState.orderId   = data.order_id;
    showCheckoutStep('waiting');
    startPolling();
  } catch (err) {
    console.error('Store checkout submit failed:', err);
    checkoutShowFieldError('Could not reach payment server: ' + String(err && err.message || err));
    if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = 'Pay now'; }
  }
}

var POLL_INTERVAL_MS  = 3500;
var POLL_MAX_ATTEMPTS = 40; // roughly 2.5 minutes of polling before giving up on the tab staying open

function startPolling() {
  checkoutState.pollAttempts = 0;
  stopPolling();
  checkoutState.polling = setInterval(pollCheckoutStatus, POLL_INTERVAL_MS);
  pollCheckoutStatus();
}
function stopPolling() {
  if (checkoutState.polling) { clearInterval(checkoutState.polling); checkoutState.polling = null; }
}

async function pollCheckoutStatus() {
  checkoutState.pollAttempts++;
  if (!checkoutState.reference) { stopPolling(); return; }
  try {
    var resp = await fetch(WCZ_CHECKOUT_API + '/pay/status?ref=' + encodeURIComponent(checkoutState.reference));
    var data = await resp.json();
    if (data.status === 'paid') {
      stopPolling();
      onCheckoutPaid();
    } else if (data.status === 'cancelled' || data.status === 'failed') {
      stopPolling();
      onCheckoutFailed('The payment was cancelled or declined.');
    } else if (checkoutState.pollAttempts >= POLL_MAX_ATTEMPTS) {
      stopPolling();
      var sub = document.getElementById('wcz-checkout-waiting-sub');
      if (sub) sub.textContent = "This is taking a while — you'll get a WhatsApp confirmation once it clears. You can close this.";
    }
  } catch (err) {
    // transient network error while polling — keep trying rather than
    // failing the whole flow over one dropped request
  }
}

function onCheckoutPaid() {
  var note = document.getElementById('wcz-checkout-success-note');
  if (note) note.textContent = checkoutState.hasPhysical
    ? "We'll confirm your order and arrange delivery."
    : "Check WhatsApp — your download link is on its way.";
  showCheckoutStep('success');
  if (checkoutState.isCartCheckout) { _cart = []; cartRender(); }
}

function onCheckoutFailed(msg) {
  var note = document.getElementById('wcz-checkout-failed-note');
  if (note) note.textContent = msg || 'Please try again.';
  showCheckoutStep('failed');
}

/* Wire checkout modal + Pay online triggers via delegation */
document.addEventListener('click', function(e) {
  if (e.target.closest('#wcz-checkout-close') || e.target.id === 'wcz-checkout-overlay' || e.target.closest('#wcz-checkout-done')) {
    closeCheckout(); return;
  }
  if (e.target.closest('#wcz-checkout-submit')) { submitCheckout(); return; }
  if (e.target.closest('#wcz-checkout-retry'))  { showCheckoutStep('form'); return; }

  // Per-product "Pay online now" in the drawer — checks out just this item
  // at whatever variant/qty is currently selected.
  if (e.target.closest('#wcz-qv-pay-online')) {
    if (!WCZ_ADDON_ACTIVE || !WCZ_STORE_PAYMENTS_ENABLED) return;
    var p = state.product;
    if (!p) return;
    if (state.variantMatrix && (!state.selectedVariantId || state.selectedVariantStock <= 0)) return;
    var qty = WCZ_R.showQuantity ? state.qty : 1;
    var items = [{ product_id: p.id, variant_id: state.selectedVariantId || null, qty: qty }];
    var hasPhysical = (p.product_type || 'physical') !== 'digital';
    var label = p.name + (state.variant ? ' — ' + state.variant : '') + (state.color ? ' / ' + state.color : '');
    closeDrawer();
    wczOpenCheckout(items, hasPhysical, false, label);
    return;
  }

  // Full-cart "Pay online" in the order panel.
  if (e.target.closest('#wcz-order-pay-online')) {
    if (!WCZ_ADDON_ACTIVE || !WCZ_STORE_PAYMENTS_ENABLED) return;
    // Only items added with a real productId are checkout-eligible (see
    // wczCartAdd) — anything added via the legacy wczCardAdd helper isn't,
    // and silently can't be included here.
    var eligible = _cart.filter(function(i){ return i.productId; });
    if (!eligible.length) return;

    var hasPhysicalCart = eligible.some(function(i){ return (i.productType || 'physical') !== 'digital'; });
    var hasDigitalCart  = eligible.some(function(i){ return i.productType === 'digital'; });
    if (hasPhysicalCart && hasDigitalCart) {
      openCheckoutError('Please check out digital and physical items separately.');
      return;
    }

    var items = eligible.map(function(i){ return { product_id: i.productId, variant_id: i.variantId || null, qty: i.qty }; });
    var itemCount = eligible.reduce(function(a,i){ return a + i.qty; }, 0);
    wczOpenCheckout(items, hasPhysicalCart, true, itemCount + ' item' + (itemCount === 1 ? '' : 's') + ' in your order');
  }
});

/* ── CARD-LEVEL INLINE VARIANT QUICK-SELECT ──────────────
   Same SKU-matrix resolution the drawer already does, but scoped per-card
   instead of to one global 'state' object — multiple cards render at once
   on the grid, each needs its own independent colour/size selection. */
var _cardSelection = {};

function cardMatrixNeeds(matrix, key) {
  if (!matrix || !matrix.length) return false;
  return matrix.some(function(v){ return v.option_values && (key in v.option_values); });
}
function cardFindVariant(matrix, color, size) {
  if (!matrix || !matrix.length) return null;
  var needColor = cardMatrixNeeds(matrix, 'Color');
  var needSize  = cardMatrixNeeds(matrix, 'Size');
  return matrix.find(function(v){
    var ov = v.option_values || {};
    if (needColor && ov.Color !== color) return false;
    if (needSize  && ov.Size  !== size)  return false;
    return true;
  }) || null;
}

function cardResolve(pid) {
  var p = WCZ_PRODUCTS.find(function(x){ return x.id === pid; });
  if (!p) return;
  var sel = _cardSelection[pid] || (_cardSelection[pid] = { color: '', size: '' });
  var matrix = p._variantMatrix || null;
  var priceEl  = document.getElementById('wcz-card-price-' + pid);
  var addBtn   = document.querySelector('.wcz-card-add-btn[data-pid="' + pid + '"]');
  var payBtn   = document.querySelector('.wcz-card-pay-btn[data-pid="' + pid + '"]');
  var colorsArr = Array.isArray(p.colors) ? p.colors : [];
  var sizesArr  = Array.isArray(p.variants) ? p.variants : [];
  var needColor = matrix ? cardMatrixNeeds(matrix, 'Color') : colorsArr.length > 0;
  var needSize  = matrix ? cardMatrixNeeds(matrix, 'Size')  : sizesArr.length > 0;
  var complete  = (!needColor || sel.color) && (!needSize || sel.size);

  function setBtns(enabled, label) {
    if (addBtn) { addBtn.disabled = !enabled; addBtn.textContent = label || 'Add to cart'; }
    if (payBtn) { payBtn.disabled = !enabled; payBtn.textContent = label || 'Pay online'; }
  }

  if (!complete) {
    if (priceEl) priceEl.textContent = p.price || '';
    setBtns(false, 'Select options');
    return;
  }

  if (!matrix || !matrix.length) {
    // Legacy variant product (no real SKU matrix) — labels only, no
    // per-combo price/stock to resolve against, same fallback the drawer
    // uses for un-migrated products.
    if (priceEl) priceEl.textContent = p.price || '';
    setBtns(true);
    return;
  }

  var match = cardFindVariant(matrix, sel.color, sel.size);
  if (!match) { setBtns(false, 'Unavailable'); return; }
  if (priceEl) priceEl.textContent = match.price || p.price || '';
  if ((match.stock || 0) <= 0) { setBtns(false, 'Sold out'); return; }
  setBtns(true);

  // Cross-filter: grey out sizes that would be a 0-stock combo for the
  // selected colour, same behaviour as the drawer's picker.
  var sizesWrap = document.querySelector('.wcz-card-sizes[data-pid-scope="' + pid + '"]');
  if (sizesWrap && needColor) {
    sizesWrap.querySelectorAll('.wcz-card-size[data-size]').forEach(function(btn){
      var m = cardFindVariant(matrix, sel.color, btn.dataset.size);
      var out = m ? (m.stock || 0) <= 0 : false;
      btn.classList.toggle('out', out);
      btn.disabled = out;
    });
  }
}

// Seed default colour selection (matches the drawer's own default-to-
// first-colour behaviour) so cards start in a resolved state rather than
// always showing "Select options" when only a colour choice remains.
function initCardSelections() {
  WCZ_PRODUCTS.forEach(function(p){
    var colorsArr = Array.isArray(p.colors) ? p.colors : [];
    if (colorsArr.length) {
      _cardSelection[p.id] = { color: colorsArr[0].name || '', size: '' };
    }
    if (colorsArr.length || (Array.isArray(p.variants) && p.variants.length) || (p._variantMatrix && p._variantMatrix.length)) {
      cardResolve(p.id);
    }
  });
}

document.addEventListener('click', function(e){
  var colorBtn = e.target.closest('.wcz-card-color[data-pid]');
  if (colorBtn) {
    var pidc = colorBtn.dataset.pid;
    var wrapc = colorBtn.parentElement;
    if (wrapc) wrapc.querySelectorAll('.wcz-card-color').forEach(function(b){ b.classList.remove('active'); });
    colorBtn.classList.add('active');
    (_cardSelection[pidc] = _cardSelection[pidc] || { color:'', size:'' }).color = colorBtn.dataset.color || '';
    var labelEl = document.querySelector('#wcz-card-colorlabel-' + pidc + ' span');
    if (labelEl) labelEl.textContent = colorBtn.dataset.color || '';
    cardResolve(pidc);
    return;
  }

  var sizeBtn = e.target.closest('.wcz-card-size[data-pid]');
  if (sizeBtn && !sizeBtn.disabled) {
    var pids = sizeBtn.dataset.pid;
    var wraps = sizeBtn.parentElement;
    if (wraps) wraps.querySelectorAll('.wcz-card-size').forEach(function(b){ b.classList.remove('active'); });
    sizeBtn.classList.add('active');
    (_cardSelection[pids] = _cardSelection[pids] || { color:'', size:'' }).size = sizeBtn.dataset.size || '';
    cardResolve(pids);
    return;
  }

  var cardAddBtn = e.target.closest('.wcz-card-add-btn[data-pid]');
  if (cardAddBtn && !cardAddBtn.disabled) {
    if (!WCZ_ADDON_ACTIVE) return;
    var pida = cardAddBtn.dataset.pid;
    var pa = WCZ_PRODUCTS.find(function(x){ return x.id === pida; });
    if (!pa) return;
    var sela = _cardSelection[pida] || {};
    var matrixa = pa._variantMatrix || null;
    var matcha = matrixa ? cardFindVariant(matrixa, sela.color, sela.size) : null;
    if (Array.isArray(matrixa) && (!matcha || (matcha.stock || 0) <= 0)) return; // defense in depth
    wczCartAdd({
      productId: pa.id, variantId: matcha ? matcha.variant_id : null, productType: pa.product_type || 'physical',
      name: pa.name, price: (matcha ? matcha.price : pa.price) || '', color: sela.color || '', variant: sela.size || '', qty: 1
    });
    var origLabel = cardAddBtn.textContent;
    cardAddBtn.textContent = 'Added \u2713';
    setTimeout(function(){ cardAddBtn.textContent = origLabel; }, 1200);
    var fabA = document.getElementById('wcz-order-fab');
    if (fabA) { fabA.style.background = '#1fb357'; setTimeout(function(){ fabA.style.background = ''; }, 900); }
    return;
  }

  var cardPayBtn = e.target.closest('.wcz-card-pay-btn[data-pid]');
  if (cardPayBtn && !cardPayBtn.disabled) {
    if (!WCZ_ADDON_ACTIVE || !WCZ_STORE_PAYMENTS_ENABLED) return;
    var pidp = cardPayBtn.dataset.pid;
    var pp = WCZ_PRODUCTS.find(function(x){ return x.id === pidp; });
    if (!pp) return;
    var selp = _cardSelection[pidp] || {};
    var matrixp = pp._variantMatrix || null;
    var matchp = matrixp ? cardFindVariant(matrixp, selp.color, selp.size) : null;
    if (Array.isArray(matrixp) && (!matchp || (matchp.stock || 0) <= 0)) return;
    var itemsp = [{ product_id: pp.id, variant_id: matchp ? matchp.variant_id : null, qty: 1 }];
    var hasPhysicalp = (pp.product_type || 'physical') !== 'digital';
    var labelp = pp.name + (selp.size ? ' \u2014 ' + selp.size : '') + (selp.color ? ' / ' + selp.color : '');
    wczOpenCheckout(itemsp, hasPhysicalp, false, labelp);
    return;
  }

  var cardWaBtn = e.target.closest('.wcz-card-wa-btn[data-pid]');
  if (cardWaBtn) {
    var pidw = cardWaBtn.dataset.pid;
    var pw = WCZ_PRODUCTS.find(function(x){ return x.id === pidw; });
    if (!pw || !WCZ_WA) return;
    var selw = _cardSelection[pidw] || {};
    var matrixw = pw._variantMatrix || null;
    var matchw = matrixw ? cardFindVariant(matrixw, selw.color, selw.size) : null;
    var effPriceW = (matchw ? matchw.price : pw.price) || '';
    var hasSelW = selw.color || selw.size;
    var tplW = (hasSelW || !WCZ_R.waTemplateNoVar) ? WCZ_R.waTemplate : WCZ_R.waTemplateNoVar;
    var msgW = tplW
      .replace('{biz}',     WCZ_BIZ)
      .replace('{name}',    pw.name || '')
      .replace('{color}',   selw.color || (WCZ_R.colorLabel   ? 'Not selected' : ''))
      .replace('{variant}', selw.size  || (WCZ_R.variantLabel ? 'Not selected' : ''))
      .replace('{qty}',     '1')
      .replace('{price}',   effPriceW);
    window.open('https://wa.me/' + WCZ_WA + '?text=' + encodeURIComponent(msgW), '_blank');
    return;
  }
});

initCardSelections();

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
  const storePaymentsEnabled = !!(ctx && ctx.storePaymentsEnabled);
  return {
    gridHtml:   buildGridHtml(products, renderer, ctx, addonActive),
    filterHtml: buildFilterHtml(products),
    drawerHtml: buildDrawerHtml(renderer, addonActive, storePaymentsEnabled),
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
.wcz-qv-btn-cart{display:flex;align-items:center;justify-content:center;gap:10px;padding:13px 20px;background:transparent;color:#fff;border:1.5px solid rgba(255,255,255,.25);border-radius:2px;font-family:var(--mono,"DM Mono",monospace);font-size:.7rem;letter-spacing:.1em;text-transform:uppercase;font-weight:600;transition:border-color .2s,background .2s;cursor:pointer;width:100%}
.wcz-qv-btn-cart:hover{border-color:rgba(255,255,255,.6);background:rgba(255,255,255,.05)}
.wcz-qv-btn-buynow{display:flex;align-items:center;justify-content:center;gap:7px;padding:9px 20px;background:transparent;color:rgba(255,255,255,.55);border:1px solid rgba(255,255,255,.15);border-radius:2px;font-family:var(--mono,"DM Mono",monospace);font-size:.64rem;letter-spacing:.06em;text-transform:uppercase;font-weight:500;transition:color .2s,border-color .2s}
.wcz-qv-btn-buynow svg{opacity:.6;width:12px;height:12px}
.wcz-qv-btn-buynow:hover{color:rgba(255,255,255,.85);border-color:rgba(255,255,255,.35)}
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
.wcz-order-send{flex:1;text-align:center;background:transparent;color:rgba(0,0,0,.5);border:1px solid rgba(0,0,0,.15);border-radius:999px;padding:.6rem 1rem;font-weight:600;font-size:.8rem;text-decoration:none;display:block;transition:border-color .2s,color .2s}
.wcz-order-send:hover{border-color:rgba(0,0,0,.35);color:rgba(0,0,0,.75)}
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

/* ── Card-level inline variant quick-select (Shopify/Woo style) ── */
.wcz-card-picker-label{font-family:var(--mono,"DM Mono",monospace);font-size:.6rem;letter-spacing:.06em;text-transform:uppercase;opacity:.45;margin-top:9px}
.wcz-card-picker-label span{opacity:1;color:var(--gold,#c8a24a)}
.wcz-card-colors{display:flex;gap:5px;flex-wrap:wrap;margin-top:5px}
.wcz-card-color{width:18px;height:18px;border-radius:50%;border:1.5px solid rgba(255,255,255,.2);cursor:pointer;transition:box-shadow .15s,border-color .15s;padding:0}
.wcz-card-color.active{border-color:#fff;box-shadow:0 0 0 2px rgba(255,255,255,.3)}
.wcz-card-sizes{display:flex;gap:4px;flex-wrap:wrap;margin-top:7px}
.wcz-card-size{font-family:var(--mono,"DM Mono",monospace);font-size:.6rem;letter-spacing:.03em;padding:4px 8px;border:1px solid rgba(255,255,255,.2);border-radius:2px;cursor:pointer;background:transparent;color:inherit;transition:border-color .15s,background .15s,color .15s}
.wcz-card-size:hover{border-color:rgba(255,255,255,.5)}
.wcz-card-size.active{border-color:var(--gold,#c8a24a);color:var(--gold,#c8a24a);background:rgba(200,162,74,.1)}
.wcz-card-size.out{opacity:.3;cursor:not-allowed;text-decoration:line-through}
.wcz-card-size:disabled{opacity:.3;cursor:not-allowed}
.wcz-card-actions{display:flex;flex-direction:column;gap:6px;margin-top:10px}
.wcz-card-actions-row{display:flex;gap:6px}
.wcz-card-actions-row .wcz-card-add-btn,.wcz-card-actions-row .wcz-card-wa-btn{flex:1}
.wcz-card-add-btn-full{width:100%}
.wcz-card-add-btn{width:100%;padding:8px 10px;font-size:.68rem;font-weight:600;letter-spacing:.04em;text-transform:uppercase;border-radius:2px;cursor:pointer;border:1px solid rgba(255,255,255,.25);background:transparent;color:inherit;font-family:inherit;transition:border-color .2s,background .2s}
.wcz-card-add-btn:hover{border-color:rgba(255,255,255,.6);background:rgba(255,255,255,.05)}
.wcz-card-add-btn:disabled{opacity:.35;cursor:not-allowed}
.wcz-card-pay-btn{width:100%;padding:9px 10px;font-size:.68rem;font-weight:700;letter-spacing:.04em;text-transform:uppercase;border-radius:2px;cursor:pointer;border:none;background:var(--gold,#c8a24a);color:var(--btn-fg,#0c0c0c);font-family:inherit;transition:background .2s}
.wcz-card-pay-btn:hover{background:var(--gold2,#a87030)}
.wcz-card-pay-btn:disabled{opacity:.35;cursor:not-allowed;background:var(--ink3,#2a2a2a);color:rgba(255,255,255,.3)}
.wcz-card-wa-btn{width:100%;padding:6px 10px;font-size:.6rem;font-weight:500;letter-spacing:.02em;text-transform:uppercase;border-radius:2px;cursor:pointer;border:1px solid rgba(255,255,255,.12);background:transparent;color:rgba(255,255,255,.45);font-family:inherit;transition:color .2s,border-color .2s;display:flex;align-items:center;justify-content:center;gap:5px}
.wcz-card-wa-btn:hover{color:rgba(255,255,255,.8);border-color:rgba(255,255,255,.3)}
.wcz-card-wa-btn svg{width:10px;height:10px}
.wcz-order-panel .wcz-order-hdr button{color:#fff;background:rgba(255,255,255,.15);width:28px;height:28px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:.85rem;border:none;cursor:pointer}

/* ── STORE PAYMENTS — Pay online buttons + checkout modal ── */
.wcz-qv-btn-payonline{width:100%;padding:14px 20px;background:var(--gold,#c8a24a);color:var(--btn-fg,#0c0c0c);border:1.5px solid var(--gold,#c8a24a);border-radius:2px;font-family:var(--mono,"DM Mono",monospace);font-size:.72rem;letter-spacing:.08em;text-transform:uppercase;font-weight:700;cursor:pointer;transition:background .2s,color .2s}
.wcz-qv-btn-payonline:hover{background:var(--gold2,#a87030);border-color:var(--gold2,#a87030)}
.wcz-qv-btn-payonline:hover{background:var(--gold,#c8a24a);color:var(--btn-fg,#0c0c0c)}
.wcz-order-pay-online{flex-shrink:0;font-size:.78rem;font-weight:700;background:var(--gold,#c8a24a);color:var(--btn-fg,#0c0c0c);border-radius:999px;padding:.65rem 1.1rem;border:none;cursor:pointer;font-family:inherit;transition:opacity .2s}
.wcz-order-pay-online:hover{opacity:.85}
#wcz-checkout-overlay{display:none;position:fixed;inset:0;z-index:1200;background:rgba(0,0,0,.7);backdrop-filter:blur(4px)}
#wcz-checkout-overlay.open{display:block}
#wcz-checkout-modal{display:none;position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);z-index:1205;width:min(400px,92vw);max-height:88vh;overflow-y:auto;background:#fff;color:#111;border-radius:12px;padding:28px 24px;box-shadow:0 20px 60px rgba(0,0,0,.35)}
#wcz-checkout-modal.open{display:block}
.wcz-checkout-close{position:absolute;top:14px;right:14px;width:30px;height:30px;border-radius:50%;background:rgba(0,0,0,.06);border:none;font-size:.9rem;cursor:pointer;display:flex;align-items:center;justify-content:center}
.wcz-checkout-title{font-size:1.1rem;font-weight:800;margin:0 0 6px}
.wcz-checkout-summary{font-size:.85rem;opacity:.6;margin:0 0 18px}
.wcz-checkout-label{display:block;font-size:.7rem;font-weight:700;letter-spacing:.04em;text-transform:uppercase;opacity:.5;margin:14px 0 6px}
.wcz-checkout-input{width:100%;padding:11px 12px;border:1.5px solid rgba(0,0,0,.12);border-radius:6px;font-size:.9rem;font-family:inherit;box-sizing:border-box}
.wcz-checkout-input:focus{outline:none;border-color:var(--gold,#c8a24a)}
.wcz-checkout-textarea{min-height:70px;resize:vertical}
.wcz-checkout-error{color:#c0392b;font-size:.82rem;margin:10px 0 0;padding:8px 10px;background:rgba(192,57,43,.08);border-radius:6px}
.wcz-checkout-submit{width:100%;margin-top:20px;padding:13px 20px;background:var(--ink,#0c0c0c);color:#fff;border:none;border-radius:6px;font-weight:700;font-size:.88rem;cursor:pointer;transition:opacity .2s}
.wcz-checkout-submit:hover{opacity:.88}
.wcz-checkout-submit:disabled{opacity:.5;cursor:not-allowed}
.wcz-checkout-note{font-size:.78rem;opacity:.5;text-align:center;margin-top:12px;line-height:1.5}
#wcz-checkout-step-waiting,#wcz-checkout-step-success,#wcz-checkout-step-failed{text-align:center;padding:10px 0}
.wcz-checkout-spinner{width:38px;height:38px;border-radius:50%;border:3px solid rgba(0,0,0,.1);border-top-color:var(--gold,#c8a24a);margin:0 auto 18px;animation:wcz-spin 0.8s linear infinite}
@keyframes wcz-spin{to{transform:rotate(360deg)}}
.wcz-checkout-check{width:52px;height:52px;border-radius:50%;background:#1fb357;color:#fff;font-size:1.5rem;display:flex;align-items:center;justify-content:center;margin:0 auto 16px}
</style>`;
}

// =============================================================================
// END UNIVERSAL COMMERCE SDK
// =============================================================================
