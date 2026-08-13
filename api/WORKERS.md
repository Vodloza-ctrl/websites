# websites.co.zw — Worker Inventory

Every Cloudflare Worker that makes up the websites.co.zw platform, what it
actually does, and how it was last verified against the live deployed code.
Generated during a repo-sync pass on 2026-08-13, prompted by a beauty-salon
template audit that widened into checking every worker for the same class
of cache-purge bug.

**Scope note:** this covers only the `websites-*` / `websites-cozw-*`
workers — the ZVAKHO workers (`zvakho-*`) are a separate product with their
own codebase and are deliberately not included here.

## Deploy model — read this first

Workers deploy via **manual paste into the Cloudflare dashboard**, not Git
auto-deploy. Only Pages (the editor UI, `templates/`) auto-deploys from
this repo's `main` branch. **Every time a file in this `api/` folder
changes, it must be manually redeployed on Cloudflare** — a commit landing
in GitHub does nothing to production on its own for these files. This has
already caused one real incident (Frame's `hero_media_html` token sat
un-deployed for several turns while the template file itself auto-updated
via Pages) and is the single most common source of "I pushed it but it's
not working" confusion in this project.

## Cache model — the other thing that causes tickets

render-worker caches published pages: `public, max-age=300,
stale-while-revalidate=3600` (5 min fresh, up to 1hr stale-while-revalidate
after that). Two things are **not** affected by this at all:
- The in-editor **Preview** button — always `no-store`, always fresh.
- Booking availability — fetched live client-side via `fetch()` at
  interaction time, never baked into the cached page.

What **is** baked into the cached HTML at render time, and therefore goes
stale until something purges it: the **Store Payments shop grid**
(`extras.bs_shop_products_html`, computed server-side in render.js). Any
worker that changes what should appear there must purge the cache after
writing, the same way `auth.js`'s `saveSite()`/`switchTemplate()` already
does. This inventory exists partly to confirm which workers actually do
that and which didn't.

---

## Core platform workers

### `websites-cozw-render` — `render-worker.js`
**What it does:** renders every published site's public HTML. Owns all 20+
templates, palette/font resolution, section toggle/reorder, and the
Universal Commerce SDK integration (calls out to
`websites-commerce-sdk-worker` for the shop grid). This is the biggest file
in the platform by a wide margin.
**Cache-purge relevance:** N/A — this worker *serves* the cache, it doesn't
write to D1 in ways that need purging.
**Sync status:** deployed version is **one commit behind** this repo as of
writing — missing the `hero_media_html` token (Frame's hero video/photo
support). Needs a manual redeploy.

### `websites-cozw-auth` — `auth-worker.js`
**What it does:** the account/dashboard API. OTP login, site CRUD, template
switching + premium-template entitlement gating, AI generation proxy,
domain wish/registration flow, email routing, admin endpoints.
**Cache-purge relevance:** yes — and already handled. `saveSite()` and
`switchTemplate()` (v5.10/5.11) purge the public cache on every edit to a
published site. This was the fix that established the pattern every other
worker below is now being checked against.
**Sync status:** confirmed fully current (v5.11) against live deployed
code.

### `websites-cozw-payments` — `payments-worker.js`
**What it does:** the single source of truth for Paynow. Site plan
publish/renew, one-time addon purchases (premium templates, Bookings),
owner-connected Paynow credentials for direct-collection deposits, Store
Payments checkout and the $20/mo subscription gate, digital product
delivery.
**Cache-purge relevance:** yes. `confirmPaid()`'s site_plan branch already
purged the cache on publish. **`confirmStorePurchasePaid()` did not** — a
real customer purchase could sell a product out and the storefront would
keep showing it as available for up to an hour. Fixed in this pass (v1.17).
**Sync status:** confirmed current (v1.17) against live deployed code —
this repo IS the source of truth here, the fix was made directly in it.

### `websites-products-worker` — `websites-products-worker.js`
**What it does:** owner-facing CRUD for the normalized product catalogue
(products, variant_options, product_variants) — create/update/archive a
product, adjust stock, replace a variant matrix.
**Cache-purge relevance:** yes, and this was the original bug that started
this whole audit. **Had zero cache-purge calls anywhere.** Every mutation
route could change the shop grid and the public page would keep serving
the old version for up to an hour. Fixed in this pass (v1.1) — every
handler that writes now calls a new `purgeSiteCache()` helper, matching
`auth.js`'s pattern.
**Sync status:** wasn't in this repo at all before this pass. Now present
and fixed — **needs its first-ever deploy** of this fix.

### `websites-bookings-worker` — `websites-bookings-worker.js`
**What it does:** interval bookings (hospitality rooms) and slot bookings
(salon/consultant appointments) — availability, atomic overlap-safe
booking creation, WhatsApp handoff, owner block-off, deposit/full-payment
commitment per service (Pro tier, charges via the owner's own Paynow
account through payments-worker), check-in reminder cron, manual entry and
payment-ledger tracking (Pro tier).
**Cache-purge relevance:** checked, genuinely not needed. Booking
availability is fetched live client-side (see render.js's
`WCZ_BOOK_API`/`WCZ_SB_API` calls, both inside `<script>` blocks, not
server-rendered) — it's never affected by render-worker's page cache
regardless of what this worker does.
**Sync status:** the repo copy was **badly stale** — v1.10 committed once
long ago, deployed version is v1.17 (seven versions of real functionality
ahead: deposit bookings, staff assignment modes, operator-owned services,
block-off, default-hours fallback). Overwritten with the current version
in this pass.

### `websites-orders-worker` — `websites-orders-worker.js`
**What it does:** captures WhatsApp Store order records (the free tier,
before Store Payments) and their status for the owner's dashboard. Also
exposes a generic `/addon-check` endpoint render-worker calls to decide
whether to show ordering UI at all.
**Cache-purge relevance:** checked, not needed — pure order-tracking
records, never touches the products table or anything baked into the
cached page.
**Sync status:** repo copy was stale (had drifted from the deployed v1.1).
Overwritten with the current version in this pass.

### `websites-commerce-sdk-worker` — `websites-commerce-sdk-worker.js`
**What it does:** a pure-function service (no DB, no bindings at all) that
builds the shop grid/drawer/lightbox HTML+CSS+JS for every store-enabled
template. render-worker calls it, embeds the result in the cached page —
this is the actual thing that goes stale, not this worker itself.
**Cache-purge relevance:** N/A — stateless, never writes anything anywhere.
**Sync status:** repo copy was stale. Overwritten with the current
deployed version (v5.6) in this pass.

### `websites-notify-worker` — `websites-notify-worker.js`
**What it does:** single-responsibility WhatsApp sender (via ManyChat),
used by bookings-worker and payments-worker so neither talks to ManyChat
directly. Can only message existing ManyChat subscribers — cannot
cold-message a phone number.
**Cache-purge relevance:** N/A — pure messaging, no site content.
**Sync status:** wasn't in this repo before this pass. Now present,
confirmed current (v1.0) against live deployed code.

---

### `websites-cozw-ai` — `websites-cozw-ai.js`
**What it does:** AI copy generation (initial site content) and AI "tune"
(rewrite a single field — about text, a service description, a person bio,
etc.) via the Anthropic API. Also a lightweight template recommender.
**Cache-purge relevance:** none needed — whatever it generates is returned
to the caller, which saves it through `auth.js`'s `saveSite()`, and that
already purges the cache.
**Sync status:** confirmed current (v2.1/v2.2) against live deployed code
— repo copy already matched exactly, no changes needed.

### `websites-cozw-renewal-cron` — `websites-cozw-renewal-cron.js`
**What it does:** the daily scheduled sweep that moves sites through
`published → grace → suspended` and addons through `active → grace →
suspended` once their `expires_at` passes, plus pre-expiry WhatsApp renewal
reminders.
**Cache-purge relevance:** yes — a third real bug, found and fixed in this
pass (v2.2). `render.js`'s `Cache-Control` logic only special-cases
`grace` status as `no-store`; `suspended` falls through to the normal
`public, max-age=300, stale-while-revalidate=3600` branch. Combined with
this worker never purging the CDN cache on a status flip, a site (or an
addon-gated feature) whose subscription lapsed could keep serving its old,
fully-live cached page for up to an hour after being suspended. Fixed:
every site/addon that transitions `expiredToGrace` or `graceToSuspended`
now gets its cache purged, same pattern as everywhere else.
**Sync status:** was in the repo but missing the fix above — now current
(v2.2) and includes it. **Needs deploy** — this fix has never been live.

### `websites-cozw-dashboard` — ⚠️ status unresolved, not synced into this repo
**What it actually is, confirmed by reading its source directly:** a
**complete, separate, older implementation of the entire auth system** —
its own OTP request/verify, its own session issuing, its own site
create/read/save. It self-documents as deploying to `app.websites.co.zw`
— the exact same custom domain `websites-cozw-auth` (the worker actively
maintained and confirmed current throughout this whole project) is
documented as using. Two Workers cannot both be bound to the same custom
domain at once, so **one of these two is almost certainly not receiving
any live traffic** — but which one is a question this repo's tools can't
answer; Cloudflare route/custom-domain bindings aren't exposed through the
API access available here.

**Why this matters if it turns out to still be live:** its `saveSite()`
has no cache-purge call at all — it's an earlier version of the exact bug
`auth.js` v5.11 already fixed. If this worker is somehow still handling
any real traffic, it would be silently reproducing the stale-cache
problem this whole audit was hunting for, through a code path nobody's
been looking at.

**Action needed (Cloudflare dashboard, not something I can check):** open
Workers & Pages → `websites-cozw-dashboard` → Settings → Domains & Routes.
If nothing is bound to it, it's dead weight — safe to delete, and doing
so removes a confusing, unpatched duplicate of the real auth system from
the account. If something IS bound to it, that's a live incident: it
means real users may be hitting this old code path instead of the
current, fixed one.

Not added to this repo as an active file — doing so would misrepresent
whether it's actually part of the running platform, which is genuinely
unknown right now.

