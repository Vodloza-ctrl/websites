/**
 * websites-products-worker
 *
 * Owner-facing CRUD for the normalized product catalogue (products,
 * variant_options, product_variants) — the tables Store Payments checkout
 * and stock-decrement actually read/write against.
 *
 * WHY THIS IS ITS OWN WORKER, NOT PART OF THE MAIN CONTENT SAVE FLOW:
 * The editor's main "Save" button batches the whole site's content JSON
 * (about text, hours, etc.) into one write, on whatever cadence the owner
 * happens to click Save. Product STOCK, by contrast, changes continuously
 * from real customer purchases via payments-worker's confirmStorePurchasePaid
 * — completely independent of the owner's editor session. If product edits
 * went through the same "batch and save later" content pipeline, an owner
 * editing their About text at 3pm could silently overwrite stock numbers
 * that changed from real sales at 2pm, using stale data from when they
 * opened the editor. Every write here is immediate and scoped to exactly
 * the field being changed — same reasoning as why Bookings deposits and
 * Store Payments checkout live in their own tables rather than content JSON.
 *
 * AUTH: Bearer token or wcz_session cookie against the shared `sessions`
 * table (same contract as auth-worker/bookings-worker), then a site
 * ownership check (site.owner_id === resolved owner_id) before any read or
 * write — no route here trusts site_id alone, per the platform's core
 * multi-tenancy rule.
 *
 * v1.1 CHANGE — CACHE PURGE ON EVERY MUTATION:
 *   Found via a repo-wide cache-purge exposure audit (prompted by a
 *   beauty-salon template audit that widened into checking every worker
 *   with a Store/shop feature): this worker had NO cache-purge call
 *   anywhere. render-worker bakes the shop's product grid into the
 *   PUBLISHED page's cached HTML at render time (see render.js's
 *   extras.bs_shop_products_html = commerce.gridHtml, computed server-side,
 *   not fetched live by the browser -- unlike booking availability, which
 *   IS a live client-side fetch and was never affected by this). That
 *   means every route below -- create, update, archive, direct stock
 *   adjust, replace-the-whole-variant-set, single-variant update -- could
 *   change what should be showing on the live storefront and the public
 *   page would keep serving the OLD version for up to render-worker's
 *   cache window (5 min, stale-while-revalidate up to an hour). Same class
 *   of bug auth.js v5.11 already fixed for saveSite()/switchTemplate(),
 *   and payments.js v1.17 already fixed for confirmStorePurchasePaid()'s
 *   stock decrement -- this worker was the one place nobody had checked
 *   yet. purgePublicCache()/purgeCustomDomainCache() below match those
 *   two files' existing pattern exactly, called at the end of every
 *   handler that writes to products/variant_options/product_variants.
 *
 * Routes:
 *   GET    /products?site_id=...            list active products + variants
 *   POST   /products                        create a product
 *   PUT    /products/:id                    update product fields
 *   DELETE /products/:id                    archive (soft delete)
 *   POST   /products/:id/stock              direct stock adjustment (no-variant products)
 *   PUT    /products/:id/variants           replace the whole variant set
 *   PUT    /product-variants/:id            adjust one variant's stock/price directly
 *   POST   /products/:id/digital-asset      upload a private digital file to R2
 *
 * Bindings required: DB (D1, shared with everything else), DIGITAL_ASSETS
 * (R2 bucket — same one payments-worker's /store/download route reads from).
 */

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const { pathname } = url;

    if (request.method === "OPTIONS") return preflight(env);

    try {
      const owner = await verifyOwner(request, env);
      if (!owner) return json({ error: "unauthorized" }, 401, env);

      if (request.method === "GET" && pathname === "/products") {
        return await handleListProducts(url, env, owner);
      }
      if (request.method === "POST" && pathname === "/products") {
        return await handleCreateProduct(request, env, owner);
      }
      const productMatch = pathname.match(/^\/products\/([^/]+)$/);
      if (productMatch) {
        if (request.method === "PUT") return await handleUpdateProduct(request, env, owner, productMatch[1]);
        if (request.method === "DELETE") return await handleArchiveProduct(env, owner, productMatch[1]);
      }
      const stockMatch = pathname.match(/^\/products\/([^/]+)\/stock$/);
      if (stockMatch && request.method === "POST") {
        return await handleAdjustStock(request, env, owner, stockMatch[1]);
      }
      const variantsMatch = pathname.match(/^\/products\/([^/]+)\/variants$/);
      if (variantsMatch && request.method === "PUT") {
        return await handleReplaceVariants(request, env, owner, variantsMatch[1]);
      }
      const variantMatch = pathname.match(/^\/product-variants\/([^/]+)$/);
      if (variantMatch && request.method === "PUT") {
        return await handleUpdateVariant(request, env, owner, variantMatch[1]);
      }
      const digitalMatch = pathname.match(/^\/products\/([^/]+)\/digital-asset$/);
      if (digitalMatch && request.method === "POST") {
        return await handleUploadDigitalAsset(request, env, owner, digitalMatch[1]);
      }
    } catch (err) {
      console.error('products-worker error:', err);
      return json({ error: "internal_error", detail: String(err && err.message || err) }, 500, env);
    }
    return json({ error: "not_found" }, 404, env);
  },
};

/* ========================================================================= *
 * Cache purge — v1.1. Matches auth.js's purgePublicCache()/
 * purgeCustomDomainCache() and payments.js's inline equivalent exactly, so
 * the same site's cache gets invalidated the same way regardless of which
 * worker triggered the change. Non-fatal by design: a cache-purge failure
 * must never fail the product mutation itself, same reasoning as every
 * other best-effort side-effect on this platform (owner notifications,
 * etc.) -- the write already succeeded in D1, that's what matters most.
 * ========================================================================= */
async function purgeSiteCache(env, siteId) {
  try {
    const site = await env.DB.prepare(
      "SELECT draft_subdomain, custom_domain, custom_domain_status FROM sites WHERE id=?1"
    ).bind(siteId).first();
    if (!site) return;
    if (site.draft_subdomain) {
      await caches.default.delete(new Request(`https://${site.draft_subdomain}.websites.co.zw/`));
    }
    if (site.custom_domain && site.custom_domain_status === "active") {
      await caches.default.delete(new Request(`https://${site.custom_domain}/`));
    }
  } catch (e) {
    console.error("purgeSiteCache failed for site", siteId, e && e.message);
  }
}

/* ========================================================================= *
 * Auth — same session contract documented across the platform: a `sessions`
 * table keyed by token, presented via Authorization: Bearer or a wcz_session
 * cookie. Returns { owner_id } or null.
 * ========================================================================= */
function parseCookie(request, name) {
  const header = request.headers.get('cookie') || '';
  const match = header.match(new RegExp('(?:^|;\\s*)' + name + '=([^;]+)'));
  return match ? decodeURIComponent(match[1]) : null;
}

function resolveToken(request) {
  const auth = request.headers.get('authorization') || '';
  if (auth.startsWith('Bearer ')) return auth.slice(7).trim();
  return parseCookie(request, 'wcz_session');
}

async function verifyOwner(request, env) {
  const token = resolveToken(request);
  if (!token || !env.DB) return null;
  const row = await env.DB.prepare(
    "SELECT owner_id, expires_at FROM sessions WHERE token = ?1"
  ).bind(token).first();
  if (!row) return null;
  if (row.expires_at && Number(row.expires_at) < Math.floor(Date.now() / 1000)) return null;
  return { owner_id: row.owner_id };
}

// Every route needs this before touching a site's products — never trust
// site_id alone, always confirm this owner actually owns this site.
async function assertOwnsSite(env, owner, siteId) {
  if (!siteId) return false;
  const site = await env.DB.prepare("SELECT owner_id FROM sites WHERE id = ?1").bind(siteId).first();
  return !!site && site.owner_id === owner.owner_id;
}

async function assertOwnsProduct(env, owner, productId) {
  const product = await env.DB.prepare("SELECT site_id FROM products WHERE id = ?1").bind(productId).first();
  if (!product) return null;
  const ok = await assertOwnsSite(env, owner, product.site_id);
  return ok ? product : null;
}

/* ========================================================================= *
 * GET /products?site_id=...
 * Returns every active product for the site, each with its variant_options
 * and product_variants nested — everything the editor needs in one call.
 * ========================================================================= */
async function handleListProducts(url, env, owner) {
  const siteId = url.searchParams.get('site_id');
  if (!(await assertOwnsSite(env, owner, siteId))) return json({ error: "forbidden" }, 403, env);

  const { results: products } = await env.DB.prepare(
    `SELECT id, site_id, name, description, product_type, base_price, currency,
            image_url, has_variants, stock, digital_asset_key, status, position
     FROM products WHERE site_id = ?1 AND status != 'archived'
     ORDER BY position ASC, created_at ASC`
  ).bind(siteId).all();

  if (!products.length) return json({ products: [] }, 200, env);

  const ids = products.map(p => p.id);
  const placeholders = ids.map(() => '?').join(',');

  const { results: options } = await env.DB.prepare(
    `SELECT id, product_id, option_name, position FROM variant_options
     WHERE product_id IN (${placeholders}) ORDER BY position ASC`
  ).bind(...ids).all();

  const { results: variants } = await env.DB.prepare(
    `SELECT id, product_id, sku, option_values, price_delta, stock, status
     FROM product_variants WHERE product_id IN (${placeholders}) AND status != 'archived'`
  ).bind(...ids).all();

  const optionsByProduct = {};
  for (const o of options) (optionsByProduct[o.product_id] = optionsByProduct[o.product_id] || []).push(o);
  const variantsByProduct = {};
  for (const v of variants) {
    v.option_values = safeParseJson(v.option_values, {});
    (variantsByProduct[v.product_id] = variantsByProduct[v.product_id] || []).push(v);
  }

  const out = products.map(p => ({
    ...p,
    has_variants: !!p.has_variants,
    variant_options: optionsByProduct[p.id] || [],
    variants: variantsByProduct[p.id] || [],
  }));

  return json({ products: out }, 200, env);
}

/* ========================================================================= *
 * POST /products — create. Starts with has_variants=0; variants are added
 * afterward via PUT /products/:id/variants once the product exists.
 * ========================================================================= */
async function handleCreateProduct(request, env, owner) {
  let body;
  try { body = await request.json(); } catch { return json({ error: "bad_json" }, 400, env); }

  const { site_id, name } = body;
  if (!(await assertOwnsSite(env, owner, site_id))) return json({ error: "forbidden" }, 403, env);
  if (!name || !String(name).trim()) return json({ error: "missing_name" }, 400, env);

  const productType = body.product_type === 'digital' ? 'digital' : 'physical';
  const currency = body.currency === 'ZIG' ? 'ZIG' : 'USD';
  const basePrice = Number(body.base_price) || 0;
  const id = 'prod_' + crypto.randomUUID().replace(/-/g, '').slice(0, 20);

  await env.DB.prepare(
    `INSERT INTO products (id, site_id, name, description, product_type, base_price, currency,
                            image_url, has_variants, stock, status, position)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 0, ?9, 'active', ?10)`
  ).bind(
    id, site_id, String(name).trim(), body.description || '', productType, basePrice, currency,
    body.image_url || null, (productType === 'physical' ? 0 : null),
    Number.isFinite(body.position) ? body.position : 0
  ).run();

  await purgeSiteCache(env, site_id);

  const product = await env.DB.prepare("SELECT * FROM products WHERE id = ?1").bind(id).first();
  return json({ product: { ...product, has_variants: false, variant_options: [], variants: [] } }, 201, env);
}

/* ========================================================================= *
 * PUT /products/:id — update basic fields. Deliberately does NOT accept
 * `stock` here (see handleAdjustStock) or `has_variants` (see
 * handleReplaceVariants) — those have their own narrower, safer routes so a
 * generic "save this product form" call can never accidentally clobber
 * stock with whatever stale value happened to be in the form.
 * ========================================================================= */
async function handleUpdateProduct(request, env, owner, productId) {
  const product = await assertOwnsProduct(env, owner, productId);
  if (!product) return json({ error: "forbidden" }, 403, env);

  let body;
  try { body = await request.json(); } catch { return json({ error: "bad_json" }, 400, env); }

  const fields = [];
  const values = [];
  let i = 1;

  if (typeof body.name === 'string' && body.name.trim()) { fields.push(`name = ?${++i}`); values.push(body.name.trim()); }
  if (typeof body.description === 'string') { fields.push(`description = ?${++i}`); values.push(body.description); }
  if (body.product_type === 'physical' || body.product_type === 'digital') { fields.push(`product_type = ?${++i}`); values.push(body.product_type); }
  if (body.base_price !== undefined && !isNaN(Number(body.base_price))) { fields.push(`base_price = ?${++i}`); values.push(Number(body.base_price)); }
  if (body.currency === 'USD' || body.currency === 'ZIG') { fields.push(`currency = ?${++i}`); values.push(body.currency); }
  if (typeof body.image_url === 'string') { fields.push(`image_url = ?${++i}`); values.push(body.image_url); }
  if (body.status === 'active' || body.status === 'draft') { fields.push(`status = ?${++i}`); values.push(body.status); }
  if (Number.isFinite(body.position)) { fields.push(`position = ?${++i}`); values.push(body.position); }

  if (!fields.length) return json({ error: "nothing_to_update" }, 400, env);

  fields.push(`updated_at = unixepoch()`);
  await env.DB.prepare(
    `UPDATE products SET ${fields.join(', ')} WHERE id = ?1`
  ).bind(productId, ...values).run();

  await purgeSiteCache(env, product.site_id);

  const updated = await env.DB.prepare("SELECT * FROM products WHERE id = ?1").bind(productId).first();
  return json({ product: updated }, 200, env);
}

// DELETE /products/:id — soft delete. Orders already store a snapshot of
// the product name/price in items_json, so archiving (not hard-deleting)
// keeps historical order records making sense.
async function handleArchiveProduct(env, owner, productId) {
  const product = await assertOwnsProduct(env, owner, productId);
  if (!product) return json({ error: "forbidden" }, 403, env);

  await env.DB.prepare(
    "UPDATE products SET status='archived', updated_at=unixepoch() WHERE id=?1"
  ).bind(productId).run();

  await purgeSiteCache(env, product.site_id);

  return json({ archived: true }, 200, env);
}

// POST /products/:id/stock  body: { stock }
// Direct stock set for products WITHOUT variants. Narrow and explicit on
// purpose — this is the only route allowed to touch products.stock.
async function handleAdjustStock(request, env, owner, productId) {
  const product = await assertOwnsProduct(env, owner, productId);
  if (!product) return json({ error: "forbidden" }, 403, env);
  if (product.has_variants) return json({ error: "product_has_variants", message: "Adjust stock per-variant instead." }, 400, env);

  let body;
  try { body = await request.json(); } catch { return json({ error: "bad_json" }, 400, env); }
  const stock = Number(body.stock);
  if (!Number.isFinite(stock) || stock < 0) return json({ error: "bad_stock_value" }, 400, env);

  await env.DB.prepare(
    "UPDATE products SET stock=?2, updated_at=unixepoch() WHERE id=?1"
  ).bind(productId, Math.floor(stock)).run();

  await purgeSiteCache(env, product.site_id);

  return json({ stock: Math.floor(stock) }, 200, env);
}

/* ========================================================================= *
 * PUT /products/:id/variants — replaces the ENTIRE variant set in one call.
 * The editor builds the full Size × Color grid client-side (including any
 * stock/price the owner typed for each row) and submits it whole, rather
 * than incremental per-variant CRUD — much simpler for a "build a grid,
 * hit Save" UI than reconciling adds/removes/renames individually.
 *
 * body: {
 *   option_names: ["Size","Color"],
 *   variants: [{ option_values:{Size,Color}, sku, price_delta, stock }]
 * }
 *
 * Passing an empty variants array turns the product back into a simple
 * (non-variant) product — has_variants flips to 0 and products.stock
 * resets to 0 (physical) or stays NULL (digital), same convention as create.
 * ========================================================================= */
async function handleReplaceVariants(request, env, owner, productId) {
  const product = await assertOwnsProduct(env, owner, productId);
  if (!product) return json({ error: "forbidden" }, 403, env);

  let body;
  try { body = await request.json(); } catch { return json({ error: "bad_json" }, 400, env); }

  const optionNames = Array.isArray(body.option_names) ? body.option_names.filter(Boolean) : [];
  const variants = Array.isArray(body.variants) ? body.variants : [];

  if (variants.length > 200) return json({ error: "too_many_variants" }, 400, env);

  // Archive (not hard-delete) existing option rows and variant rows — same
  // reasoning as product archiving, keeps old order snapshots sensible even
  // though nothing currently references variant_options.id directly.
  await env.DB.prepare("DELETE FROM variant_options WHERE product_id = ?1").bind(productId).run();
  await env.DB.prepare("UPDATE product_variants SET status='archived' WHERE product_id = ?1").bind(productId).run();

  if (!variants.length) {
    await env.DB.prepare(
      "UPDATE products SET has_variants=0, stock=?2, updated_at=unixepoch() WHERE id=?1"
    ).bind(productId, product.product_type === 'physical' ? 0 : null).run();
    await purgeSiteCache(env, product.site_id);
    return json({ has_variants: false, variant_options: [], variants: [] }, 200, env);
  }

  for (let pos = 0; pos < optionNames.length; pos++) {
    await env.DB.prepare(
      "INSERT INTO variant_options (id, product_id, option_name, position) VALUES (?1, ?2, ?3, ?4)"
    ).bind('vopt_' + crypto.randomUUID().replace(/-/g, '').slice(0, 16), productId, optionNames[pos], pos).run();
  }

  const insertedVariants = [];
  for (const v of variants) {
    const ov = (v && typeof v.option_values === 'object') ? v.option_values : {};
    const priceDelta = Number(v.price_delta) || 0;
    const stock = Math.max(0, Math.floor(Number(v.stock) || 0));
    const vid = 'var_' + crypto.randomUUID().replace(/-/g, '').slice(0, 16);
    await env.DB.prepare(
      `INSERT INTO product_variants (id, product_id, sku, option_values, price_delta, stock, status)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'active')`
    ).bind(vid, productId, v.sku || null, JSON.stringify(ov), priceDelta, stock).run();
    insertedVariants.push({ id: vid, option_values: ov, sku: v.sku || null, price_delta: priceDelta, stock });
  }

  await env.DB.prepare(
    "UPDATE products SET has_variants=1, stock=NULL, updated_at=unixepoch() WHERE id=?1"
  ).bind(productId).run();

  await purgeSiteCache(env, product.site_id);

  return json({ has_variants: true, option_names: optionNames, variants: insertedVariants }, 200, env);
}

// PUT /product-variants/:id  body: { stock?, price_delta?, sku? }
// Quick single-variant edit (e.g. "restock Medium/Red to 12") without
// resubmitting the whole matrix.
async function handleUpdateVariant(request, env, owner, variantId) {
  const variant = await env.DB.prepare(
    "SELECT id, product_id FROM product_variants WHERE id = ?1"
  ).bind(variantId).first();
  if (!variant) return json({ error: "not_found" }, 404, env);

  const product = await assertOwnsProduct(env, owner, variant.product_id);
  if (!product) return json({ error: "forbidden" }, 403, env);

  let body;
  try { body = await request.json(); } catch { return json({ error: "bad_json" }, 400, env); }

  const fields = [];
  const values = [];
  let i = 1;
  if (body.stock !== undefined && Number.isFinite(Number(body.stock))) { fields.push(`stock = ?${++i}`); values.push(Math.max(0, Math.floor(Number(body.stock)))); }
  if (body.price_delta !== undefined && Number.isFinite(Number(body.price_delta))) { fields.push(`price_delta = ?${++i}`); values.push(Number(body.price_delta)); }
  if (typeof body.sku === 'string') { fields.push(`sku = ?${++i}`); values.push(body.sku); }
  if (!fields.length) return json({ error: "nothing_to_update" }, 400, env);

  await env.DB.prepare(
    `UPDATE product_variants SET ${fields.join(', ')} WHERE id = ?1`
  ).bind(variantId, ...values).run();

  await purgeSiteCache(env, product.site_id);

  return json({ updated: true }, 200, env);
}

/* ========================================================================= *
 * POST /products/:id/digital-asset — uploads the raw file bytes straight
 * into the PRIVATE DIGITAL_ASSETS R2 bucket (the same one payments-worker's
 * /store/download route reads from). Deliberately separate from
 * uploadToR2()'s existing presigned-URL flow, which only allows image MIME
 * types and uploads to a PUBLIC bucket — digital products (ebooks, audio,
 * zips, etc.) must never land in a publicly listable/guessable location.
 *
 * No cache purge here — a digital asset swap doesn't change anything
 * rendered on the public page itself (the download link is only ever
 * generated after a real payment, in payments-worker's
 * confirmStorePurchasePaid()), so there's nothing stale to invalidate.
 *
 * Body: raw file bytes. Filename comes from the X-Filename header (used
 * only to derive an extension for the stored key, never trusted for
 * anything else).
 * ========================================================================= */
async function handleUploadDigitalAsset(request, env, owner, productId) {
  const product = await assertOwnsProduct(env, owner, productId);
  if (!product) return json({ error: "forbidden" }, 403, env);
  if (!env.DIGITAL_ASSETS) return json({ error: "digital_assets_not_configured" }, 503, env);

  const filename = request.headers.get('x-filename') || 'file';
  const ext = (filename.includes('.') ? filename.split('.').pop() : '').replace(/[^a-zA-Z0-9]/g, '').slice(0, 8);
  const key = `digital/${product.site_id}/${productId}/${crypto.randomUUID()}${ext ? '.' + ext : ''}`;

  const body = await request.arrayBuffer();
  if (!body || !body.byteLength) return json({ error: "empty_upload" }, 400, env);
  if (body.byteLength > 200 * 1024 * 1024) return json({ error: "file_too_large", message: "Digital files must be under 200MB." }, 400, env);

  await env.DIGITAL_ASSETS.put(key, body, {
    httpMetadata: { contentType: request.headers.get('content-type') || 'application/octet-stream' },
  });

  await env.DB.prepare(
    "UPDATE products SET digital_asset_key=?2, updated_at=unixepoch() WHERE id=?1"
  ).bind(productId, key).run();

  return json({ uploaded: true, filename: filename }, 200, env);
}

/* ========================================================================= *
 * Helpers
 * ========================================================================= */
function safeParseJson(s, fallback) {
  try { return JSON.parse(s); } catch { return fallback; }
}

function corsHeaders(env) {
  return {
    "access-control-allow-origin": env.ALLOWED_ORIGIN || "*",
    "access-control-allow-methods": "GET, POST, PUT, DELETE, OPTIONS",
    "access-control-allow-headers": "content-type, authorization, x-filename",
    "access-control-max-age": "600",
    "vary": "Origin",
  };
}
function preflight(env) {
  return new Response(null, { status: 204, headers: corsHeaders(env) });
}
function json(obj, status, env) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...corsHeaders(env) },
  });
}
