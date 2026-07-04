// websites-bookings-worker.js
// v1.10 — GET /bookings/tier (owner, any tier). Returns the site's current
// bookings tier so the editor UI can decide whether to render Pro-only
// controls (manual entry button, mark-as-paid, payment history) at all.
// This is a UI convenience only -- it grants no access. Every write route
// still independently calls requireBookingsAddon() per v1.8/v1.9, so a
// stale or spoofed client-side tier value can never bypass the real check;
// worst case the editor shows a button that then 402s, which the client
// already handles as a normal error path.
//
// v1.9 — Bookings Pro features: manual multi-channel entry and
// proof-of-payment tracking + one-tap mark-as-paid. Both gated at
// requireBookingsAddon(DB, siteId, "pro") -- the two features the $25/mo
// Pro tier was actually priced around, per the v1.8 changelog's note that
// they didn't exist as routes yet.
//   - insertBookingAtomic(): the atomic overlap-guard INSERT (previously
//     inline inside createBooking() only) is extracted into a shared
//     helper, parameterized on status/source/customer fields. Both the
//     guest-facing createBooking() and the new owner-facing
//     createManualBooking() now call it, so the race-safe
//     INSERT...SELECT...WHERE NOT EXISTS logic exists in exactly one
//     place -- duplicating it across two call sites was exactly the kind
//     of thing that quietly drifts (e.g. one path widened to include
//     'block' rows, the other forgotten) the next time either needs a
//     change.
//   - POST /bookings/manual (owner, Pro) -- createManualBooking(). Same
//     overlap protection as the guest flow, per the pricing description
//     ("same overlap protection"). Accepts a `channel` field
//     (phone|walk_in|email|other), stored directly in the existing
//     `source` column -- no schema change, that column was never
//     constrained to just 'web'/'whatsapp' values, just documented as
//     typically holding them. Defaults to status='confirmed' (staff
//     already arranged the booking at the point of entry) unless the
//     owner explicitly passes status='pending' for a tentative hold.
//     Requires customer_name -- unlike the guest flow, there's no
//     WhatsApp thread backing this booking, so something must identify
//     who it's for.
//   - booking_payments ledger (table existed since v1.4, unused until
//     now) gets its first writers:
//       POST /bookings/:id/payments (owner, Pro) -- recordBookingPayment().
//         General ledger entry: type in deposit|balance|refund|adjustment,
//         amount, currency. Does NOT touch bookings.payment_status --
//         that summary column is only ever written by the one-tap action
//         below, keeping "detailed history" and "fast-path summary"
//         cleanly separated per the v1.4 design intent.
//       POST /bookings/:id/mark-paid (owner, Pro) -- markBookingPaid().
//         The one-tap action: writes a type='full' ledger row AND sets
//         bookings.payment_status='paid' (+ amount/currency/
//         payment_reference) in the same call, via the shared
//         insertPaymentLedgerRow() helper so the ledger-row shape can
//         never drift between the two payment-writing endpoints.
//       GET /bookings/:id/payments (owner, Pro) -- listBookingPayments().
//         Read side of the ledger, for a booking detail view.
//
// v1.8 — bookings addon tier gating. Prior to this version, NO route in
// this file checked the `addons` table at all -- a site with a lapsed or
// never-purchased Bookings subscription could still take live bookings.
// Depends on migration-addons-tier.sql (adds `addons.tier`, nullable,
// 'basic'|'pro'|NULL). See that migration's notes for why tier lives on
// the existing addon_type='bookings' row rather than as two separate
// addon_type values: a site has exactly one active bookings plan, and
// upgrading/downgrading is a tier change on that row, not a second
// purchase.
//   - New requireBookingsAddon(DB, siteId, minTier) -- throws Response(402)
//     the same way verifyOwner() throws Response(401), caught by the same
//     try/catch in fetch(). Every resources/bookings route now calls this
//     before doing anything else, using site_id resolved however that
//     route already gets it (query param, request body, or a lookup via
//     resource_id for routes that don't receive site_id directly).
//   - getBookingsTier() / tierAtLeast(): minimum-tier check via a
//     TIER_RANK comparison (basic=1, pro=2), not a plain boolean --
//     Pro must satisfy a Basic requirement. Fails CLOSED (treats DB
//     errors and missing/inactive rows as no access), unlike
//     render-worker's checkAddonActive() which fails OPEN when its
//     service binding is merely absent -- that distinction doesn't apply
//     here since this worker's own env.DB binding is never optional.
//   - Feature split agreed alongside the $12/$25 pricing: everything in
//     this file today (calendar/availability, WhatsApp handoff booking
//     creation, owner notification, confirm/decline/cancel) is Basic-
//     level and gated at "basic". Manual multi-channel entry and
//     proof-of-payment tracking are Pro-only per the pricing agreement,
//     but have NO routes in this file yet -- when they're built, gate
//     them at "pro" specifically; do not raise the bar on the routes
//     gated at "basic" below to do it.
//   - Deliberate exception: runCheckinReminders() (the Cron Trigger sweep)
//     is NOT gated. It only touches bookings already confirmed while the
//     addon was active -- if the addon lapses between confirmation and
//     check-in, the guest still gets their reminder. This is a courtesy
//     follow-through on a booking already taken, not a new paid action.
//
// v1.7 — email as a second notification channel, alongside WhatsApp.
// Depends on websites-notify-worker v1.1's new /send channel dispatch;
// see that file's changelog for the full design (email via Resend, SMS
// reserved-not-implemented).
//   - New `customer_email` TEXT column on `bookings` (idempotent, same
//     ensureColumn pattern as every prior additive column). Optional at
//     booking time -- nothing requires it, guests who never provide an
//     email simply get WhatsApp-only notifications as before.
//   - sendNotifyMessage() (v1.5) is replaced by two more specific helpers:
//       sendNotifyWithFallback(env, phone, email, message, subject) --
//         tries WhatsApp first, only tries email if WhatsApp came back
//         ok:false (no known subscriber, or send failed). Used for the
//         owner new-booking ping and the guest status-change notification
//         -- both usually fire soon after a WhatsApp interaction, so
//         WhatsApp is trusted as primary and email is a safety net, not a
//         duplicate.
//       sendNotifyBothChannels(env, phone, email, message, subject) --
//         attempts WhatsApp AND email independently, returns true if
//         EITHER succeeded. Used ONLY by the check-in reminder sweep,
//         deliberately more aggressive than the fallback helper: this is
//         the one notification explicitly discussed as the "key upsell"
//         and the one most likely to fall outside WhatsApp's 24-hour
//         session window by the time it fires (see v1.5 changelog), so
//         reminders get both channels rather than a fallback chain.
//   - Owner notification now also uses the OWNER's email (owners.email --
//     already an existing column, no schema change needed there) as its
//     fallback target, not just WhatsApp.
//   - createBooking() accepts an optional `customer_email` field in the
//     request body (from the calendar widget, the ManyChat flow, or any
//     future manual-entry path) and stores it.
//
// v1.6 — /admin/run-reminders is now gated behind CRON_SECRET (Authorization:
// Bearer <token>, 401 otherwise), matching websites-cozw-renewal-cron.js's
// /run endpoint exactly. It was unauthenticated in v1.5, following the
// existing /admin/migrate convention -- but unlike that endpoint (idempotent
// DDL, harmless to hit repeatedly), this one sends real WhatsApp messages to
// real guests on every successful call, so it needed the stricter gate the
// moment there was a working precedent to copy. New secret required:
// CRON_SECRET (can be the same value already used on renewal-cron, or a
// distinct one -- either works, they're independent Workers).
//
// v1.5 — guest status notification + reminder cron scaffolding.
//   - updateBookingStatus() now notifies the GUEST (not just the owner) on
//     confirmed/declined/cancelled, via the same websites-notify-worker
//     used since v1.2. This is the "future pass" flagged in the v1.3
//     changelog: once a guest completes the WhatsApp handoff flow, they
//     are a known ManyChat subscriber, which is what makes messaging them
//     back possible at all (see v1.2's constraints note -- unchanged,
//     still true, just no longer a one-way limitation for THESE guests).
//     Attempted regardless of booking source -- a web-form guest who was
//     never a subscriber just gets a silent, harmless ok:false from
//     notify-worker, same fail-open behaviour as the owner notification.
//   - New sendNotifyMessage(env, phone, message) -> boolean: the one place
//     all three notification call sites (owner-on-new-booking,
//     guest-on-status-change, guest-check-in-reminder) talk to
//     notify-worker, so the service-binding/fallback/JSON-response
//     handling exists in exactly one place.
//   - New scheduled() export (Cron Trigger handler) + runCheckinReminders():
//     sweeps confirmed bookings whose start_date is "tomorrow" in Harare
//     local time and sends a reminder, using the checkin_reminder_sent_at
//     column added (unused) back in v1.3 as the idempotency guard -- a
//     reminder is only ever sent once per booking, and the column is only
//     stamped on a confirmed successful send, so a transient notify
//     failure just gets retried on the next sweep rather than silently
//     lost.
//   - harareDateString(utcMs, dayOffset): Zimbabwe is UTC+2 with no DST,
//     so "tomorrow in Harare" is computed with a fixed offset shift, not a
//     timezone library. Cron Triggers themselves always fire in UTC --
//     the wrangler.toml schedule needs to account for that (see deploy
//     note below), this function only computes which CALENDAR DATE counts
//     as "tomorrow" once the sweep is already running.
//   - New POST /admin/run-reminders -- manual trigger for testing the
//     sweep logic before the wrangler.toml cron entry exists, matching the
//     existing unauthenticated /admin/migrate convention already in this
//     file (not owner-session-gated; not linked from any client).
//   - DEPLOY NOTE (wrangler.toml, not something this file can contain):
//       [triggers]
//       crons = ["0 7 * * *"]
//     Fires once daily at 07:00 UTC = 09:00 Harare -- a reasonable time to
//     remind someone checking in tomorrow. Also requires the NOTIFY_WORKER
//     service binding already documented in the v1.2 deploy notes; no new
//     binding needed.
//
// v1.4 — schema prep only, no new endpoints/UI yet (that's the manual-entry
// pass, still to come). Three additions, all purely additive:
//   1. `external_reference` TEXT (nullable) on `bookings` -- for a future
//      Booking.com/Airbnb/travel-agent ID, so that if calendar sync is ever
//      built, the column already exists rather than needing a backfill
//      across every historical row.
//   2. `booking_payments` ledger table -- one row per money event
//      (deposit/balance/refund/adjustment) against a booking, instead of
//      trying to represent partial payments and refunds in a single
//      `payment_status` column, which cannot express "deposit paid, balance
//      pending". `bookings.payment_status`/`amount`/`currency` (from v1.3)
//      are UNCHANGED and still the fast-path summary a one-tap "mark as
//      paid" writes to -- this table is the detail behind that summary,
//      not a replacement. No endpoint reads/writes it yet.
//   3. `block_reason` TEXT (nullable) on `bookings`, plus widening the
//      overlap guard (both getBookedRanges() and createBooking()'s atomic
//      insert check) from `booking_type = 'interval'` to
//      `booking_type IN ('interval','block')`. This is READ-side prep only:
//      a future "block these dates for maintenance" feature can insert a
//      row with booking_type='block', null customer_name/phone, and a
//      block_reason, and it will correctly occupy the calendar the moment
//      that feature exists -- no second migration needed. There is still
//      no endpoint that creates a block row today.
//
// v1.3 — WhatsApp booking handoff + forward schema prep.
//   - New GET /booking-intent?ref=<token> -- decodes a booking-widget
//     reference token (site_id/resource_id/dates, base64url JSON, no DB
//     storage needed since it's self-describing and re-validated on every
//     use) and returns human-readable room/site/date details plus a live
//     availability re-check. This is what the ManyChat flow calls first,
//     so it can show the guest "You're booking the Garden Suite, 12->15
//     Jul -- confirm?" without ManyChat having to parse free text itself.
//   - POST /bookings now accepts an optional `source` field ('web' or
//     'whatsapp', default 'web') so bookings created via the new WhatsApp
//     flow are distinguishable from the original in-page form submission.
//     Both the site owner's instant notification and the owner's Bookings
//     tab (SELECT * already picks up new columns automatically) reflect it.
//   - Schema additions (idempotent via PRAGMA table_info -- ALTER TABLE
//     ADD COLUMN has no IF NOT EXISTS in SQLite, and this table already has
//     live rows in production, so a straight CREATE TABLE IF NOT EXISTS
//     alone would never apply these to the existing table):
//       source                    TEXT NOT NULL DEFAULT 'web'
//       checkin_reminder_sent_at  INTEGER (nullable) -- reserved for the
//         not-yet-built check-in reminder cron job. Deliberately added now
//         rather than as a separate migration later, so that piece of work
//         doesn't need its own ALTER TABLE pass.
//       payment_status            TEXT NOT NULL DEFAULT 'unpaid'
//       payment_reference         TEXT (nullable) -- will link to the
//         payments-worker's payment reference once paid bookings exist.
//       amount / currency         REAL / TEXT (nullable) -- reserved for
//         when a booking carries a price (deposit or full stay). None of
//         this is wired to payments-worker yet -- this is schema space
//         only, so that adding real payment support later is an UPDATE,
//         not another migration.
//
// v1.2 — added owner WhatsApp notification on new booking (step 4a of the
// booking-engine plan), via websites-notify-worker service binding.
// v1.1 — from-scratch Bookings feature. Owns `resources` + `bookings` tables.
// v1.1: verifyOwner() wired to auth-worker.js v5.4's real session mechanism
// (was a stub in v1.0).
// Scope for v1: INTERVAL bookings only (hospitality-inn rooms — the one template
// with real editor data behind it). SLOT bookings (salon/tutor/clinic) are in the
// schema as nullable columns but have no routes here yet — build when a template
// actually needs them, per the "universal = config-driven primitives, not one
// code path built ahead of demand" call made in the June 30 design session.
//
// Conventions followed (matches orders-worker / payments-worker / render-worker):
//   - readable ID prefixes: rm_<epoch_ms>, bk_<epoch_ms>
//   - ISO YYYY-MM-DD TEXT dates, epoch-second timestamps elsewhere
//   - half-open [start, end) ranges — checkout day == next check-in day is free
//   - idempotent migration via PRAGMA table_info, never "ADD COLUMN IF NOT EXISTS"
//   - site_id-scoped everything — an owner's other sites must never leak in
//   - node --check validated before delivery
//
// Auth: verifyOwner() matches auth-worker.js v5.4's session verification
// exactly (Authorization: Bearer or wcz_session cookie → plain lookup
// against D1 `sessions.token`, expires_at > unixepoch()). Confirmed against
// the real file rather than guessed, per the orders-worker lesson.
//
// v1.2 owner notification -- IMPORTANT constraints (confirmed, not guessed,
// during the July 2026 notify-worker design discussion):
//   - ManyChat/WhatsApp cannot cold-message a guest's phone number -- only
//     numbers that have already messaged the WhatsApp bot are reachable.
//     That rules out notifying the GUEST from here. Guest-facing messaging
//     (confirmations, reminders) needs either a "Continue on WhatsApp"
//     wa.me click-through or WhatsApp Cloud API template messages -- neither
//     of which this worker attempts.
//   - Owner notifications therefore go to the OWNER'S LOGIN PHONE
//     (owners.phone, verified via WhatsApp OTP -- guaranteed to already be a
//     known ManyChat subscriber), never to the site's public-facing
//     content.whatsapp number, which has no such guarantee.
//   - Multi-tenant: one owner can run several sites. The notification
//     message always names the site so a multi-property owner knows which
//     property the booking is for.
//   - Sent via the websites-notify-worker service binding (env.NOTIFY_WORKER)
//     with a public-URL fallback (env.NOTIFY_WORKER_URL), matching the
//     service-binding-first / fetch-fallback pattern already used by
//     auth-worker.js's delegateToPaymentsWorker(). Fails OPEN and silent --
//     a notify failure never blocks or fails the booking response itself.
//
// v1.3 WhatsApp handoff -- IMPORTANT: once a guest completes this flow, they
// are a known ManyChat subscriber (they messaged the bot first). This means
// updateBookingStatus() (Confirm/Decline from the owner's Bookings tab) can
// -- in a future pass, not this one -- also notify the GUEST via the same
// notify-worker, which was previously impossible. That's intentionally not
// built here; this pass only adds the plumbing that makes it possible.

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

function json(data, status) {
  status = status || 200;
  return new Response(JSON.stringify(data), {
    status: status,
    headers: Object.assign({ "Content-Type": "application/json" }, CORS_HEADERS),
  });
}
function err(message, status) {
  return json({ error: message }, status || 400);
}
function nowSec() {
  return Math.floor(Date.now() / 1000);
}
function newId(prefix) {
  return prefix + "_" + Date.now() + "_" + Math.random().toString(36).slice(2, 8);
}
function isValidISODate(s) {
  return typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);
}

// ---------------------------------------------------------------------------
// Migration — idempotent, safe to call on every cold start or via /admin/migrate
// ---------------------------------------------------------------------------
const RESOURCES_DDL = `
CREATE TABLE IF NOT EXISTS resources (
  id          TEXT PRIMARY KEY,
  site_id     TEXT NOT NULL,
  name        TEXT NOT NULL,
  active      INTEGER NOT NULL DEFAULT 1,
  created_at  INTEGER NOT NULL
);`;

const BOOKINGS_DDL = `
CREATE TABLE IF NOT EXISTS bookings (
  id                        TEXT PRIMARY KEY,
  site_id                   TEXT NOT NULL,
  resource_id               TEXT NOT NULL,
  booking_type              TEXT NOT NULL,
  start_date                TEXT,
  end_date                  TEXT,
  start_ts                  INTEGER,
  end_ts                    INTEGER,
  customer_name             TEXT,
  customer_phone            TEXT,
  status                    TEXT NOT NULL DEFAULT 'pending',
  source                    TEXT NOT NULL DEFAULT 'web',
  checkin_reminder_sent_at  INTEGER,
  payment_status            TEXT NOT NULL DEFAULT 'unpaid',
  payment_reference         TEXT,
  amount                    REAL,
  currency                  TEXT,
  external_reference        TEXT,
  block_reason              TEXT,
  customer_email            TEXT,
  created_at                INTEGER NOT NULL
);`;

// Ledger of individual money events against a booking -- deposits,
// balances, refunds, adjustments -- kept separate from the fast-path
// `bookings.payment_status` summary column (v1.3) so that a single column
// never has to represent "deposit paid, balance still owing". No endpoint
// reads or writes this table yet; it exists so that when deposit/refund
// UI is eventually built, it's an INSERT against an existing table, not
// another migration.
const BOOKING_PAYMENTS_DDL = `
CREATE TABLE IF NOT EXISTS booking_payments (
  id           TEXT PRIMARY KEY,
  booking_id   TEXT NOT NULL,
  type         TEXT NOT NULL,
  amount       REAL,
  currency     TEXT,
  recorded_by  TEXT,
  created_at   INTEGER NOT NULL
);`;

const INDEX_DDL = [
  `CREATE INDEX IF NOT EXISTS idx_resources_site ON resources (site_id, active);`,
  `CREATE INDEX IF NOT EXISTS idx_bookings_resource_dates ON bookings (resource_id, status, start_date, end_date);`,
  `CREATE INDEX IF NOT EXISTS idx_bookings_site ON bookings (site_id, status);`,
  `CREATE INDEX IF NOT EXISTS idx_booking_payments_booking ON booking_payments (booking_id, created_at);`,
];

// Adds `column` to `table` only if it doesn't already exist. SQLite's
// ALTER TABLE ADD COLUMN has no IF NOT EXISTS clause, and `bookings`
// already has live rows in production (this migration runs against a
// table CREATE TABLE IF NOT EXISTS will silently skip) -- so every new
// column added after v1.1 must go through this, not the DDL string above.
// The DDL string above is still kept in sync for fresh installs, where
// CREATE TABLE already includes the column and this becomes a no-op.
async function ensureColumn(DB, table, column, columnDdl) {
  const info = await DB.prepare(`PRAGMA table_info(${table})`).all();
  const existing = (info.results || []).map((r) => r.name);
  if (existing.indexOf(column) === -1) {
    await DB.prepare(`ALTER TABLE ${table} ADD COLUMN ${column} ${columnDdl}`).run();
  }
}

async function migrateBookingTables(DB) {
  await DB.prepare(RESOURCES_DDL).run();
  await DB.prepare(BOOKINGS_DDL).run();
  await DB.prepare(BOOKING_PAYMENTS_DDL).run();
  for (const ix of INDEX_DDL) await DB.prepare(ix).run();

  // v1.4 additive columns on the already-live `bookings` table.
  await ensureColumn(DB, "bookings", "external_reference", "TEXT");
  await ensureColumn(DB, "bookings", "block_reason", "TEXT");

  // v1.7 additive column on the already-live `bookings` table.
  await ensureColumn(DB, "bookings", "customer_email", "TEXT");

  // v1.3 additive columns on the already-live `bookings` table.
  await ensureColumn(DB, "bookings", "source", "TEXT NOT NULL DEFAULT 'web'");
  await ensureColumn(DB, "bookings", "checkin_reminder_sent_at", "INTEGER");
  await ensureColumn(DB, "bookings", "payment_status", "TEXT NOT NULL DEFAULT 'unpaid'");
  await ensureColumn(DB, "bookings", "payment_reference", "TEXT");
  await ensureColumn(DB, "bookings", "amount", "REAL");
  await ensureColumn(DB, "bookings", "currency", "TEXT");

  return { ok: true };
}

// ---------------------------------------------------------------------------
// Auth — matches auth-worker.js v5.4's resolveToken()/resolveOwner()/
// parseCookie() verbatim: session token via Authorization: Bearer header or
// wcz_session cookie, looked up directly against the D1 `sessions` table
// (token is stored plain, not hashed — session row already carries owner_id,
// no join to `owners` needed). expires_at compared with SQLite's unixepoch()
// to stay consistent with how auth-worker checks it.
// ---------------------------------------------------------------------------
async function verifyOwner(request, env) {
  const token = resolveToken(request);
  if (!token) throw json({ error: "unauthorized" }, 401);
  const row = await env.DB.prepare(
    "SELECT owner_id FROM sessions WHERE token=?1 AND expires_at > unixepoch()"
  ).bind(token).first();
  if (!row || !row.owner_id) throw json({ error: "unauthorized" }, 401);
  return { owner_id: row.owner_id };
}
function resolveToken(request) {
  const auth = request.headers.get("Authorization") || "";
  if (auth.startsWith("Bearer ")) return auth.slice(7);
  return parseCookie(request.headers.get("cookie") || "")["wcz_session"] || null;
}
function parseCookie(h) {
  const out = {};
  String(h).split(";").forEach(function (pair) {
    const i = pair.indexOf("=");
    if (i > -1) out[pair.slice(0, i).trim()] = decodeURIComponent(pair.slice(i + 1).trim());
  });
  return out;
}

// Confirms the given site_id actually belongs to owner_id — the site_id
// scoping rule applies here exactly as it does for addons/payments: an
// owner with multiple sites must never be able to touch resources/bookings
// on a site they don't own via one that they do.
async function assertSiteOwnership(DB, siteId, ownerId) {
  const row = await DB.prepare(`SELECT id FROM sites WHERE id = ? AND owner_id = ?`)
    .bind(siteId, ownerId)
    .first();
  if (!row) throw json({ error: "site not found or not yours" }, 404);
}

// ---------------------------------------------------------------------------
// Bookings addon gating (v1.8) -- see migration-addons-tier.sql. Bookings
// ships as two tiers under the SAME addon_type='bookings' row (tier changes
// via UPDATE, never a second row), so this is a minimum-tier check, not a
// plain active/inactive boolean like orders-worker's isAddonActive(). Pro
// automatically satisfies a Basic requirement (TIER_RANK comparison).
//
// Fails CLOSED (no active row / DB error -> requireBookingsAddon throws a
// 402 Response), unlike render-worker's checkAddonActive() which fails
// OPEN when its service binding is merely absent -- that distinction
// doesn't apply here because this worker's own env.DB is never optional.
//
// Every route below that reads or writes resources/bookings must resolve
// a site_id and call requireBookingsAddon() with it before doing anything
// else. No route in this file is exempt: prior to v1.8 there was no addon
// check at all, meaning a site with a lapsed or never-purchased bookings
// addon could still take live bookings -- this closes that gap.
//
// Feature split agreed alongside the $12/$25 pricing:
//   basic: calendar/availability, WhatsApp handoff booking creation,
//          owner notification, confirm/decline/cancel
//   pro:   (routes not built yet) manual multi-channel entry,
//          proof-of-payment tracking. When those routes are added, gate
//          them with requireBookingsAddon(DB, siteId, "pro") specifically
//          -- do not relax the basic gate on the routes below to do it.
// ---------------------------------------------------------------------------
const TIER_RANK = { basic: 1, pro: 2 };

async function getBookingsTier(DB, siteId) {
  if (!siteId) return null;
  try {
    const row = await DB.prepare(
      `SELECT status, tier FROM addons WHERE site_id = ? AND addon_type = 'bookings' LIMIT 1`
    ).bind(siteId).first();
    if (!row) return null;
    if (row.status !== "active" && row.status !== "grace") return null;
    if (!row.tier) return null; // row exists but tier never set -- treat as inactive
    return row.tier; // 'basic' | 'pro'
  } catch (e) {
    console.error("getBookingsTier error:", e && e.message);
    return null;
  }
}

function tierAtLeast(currentTier, requiredTier) {
  if (!currentTier) return false;
  return (TIER_RANK[currentTier] || 0) >= (TIER_RANK[requiredTier] || Infinity);
}

// Throws a Response(402) the same way verifyOwner() throws Response(401) --
// caught by the same try/catch in fetch() below.
async function requireBookingsAddon(DB, siteId, minTier) {
  const required = minTier || "basic";
  const tier = await getBookingsTier(DB, siteId);
  if (!tierAtLeast(tier, required)) {
    throw json({ error: "bookings addon not active", required_tier: required }, 402);
  }
  return tier;
}

// Small lookup used by routes that only receive a resource_id (not a
// site_id directly), e.g. GET /availability.
async function getResourceSiteId(DB, resourceId) {
  const row = await DB.prepare(`SELECT site_id FROM resources WHERE id = ?`).bind(resourceId).first();
  return row ? row.site_id : null;
}

// ---------------------------------------------------------------------------
// Resources — owner-managed room/venue list, synced from the editor's room tab
// ---------------------------------------------------------------------------

// Public: storefront needs resource names to render booking UI.
async function listResourcesPublic(DB, siteId) {
  await requireBookingsAddon(DB, siteId, "basic");
  const rows = await DB.prepare(
    `SELECT id, name FROM resources WHERE site_id = ? AND active = 1 ORDER BY created_at ASC`
  ).bind(siteId).all();
  return json({ resources: rows.results || [] });
}

// Owner: full CRUD, used by the editor's room-save sync (not yet wired in —
// that's the next step once this worker is confirmed).
async function createResource(DB, ownerId, body) {
  if (!body.site_id || !body.name) return err("site_id and name required");
  await assertSiteOwnership(DB, body.site_id, ownerId);
  await requireBookingsAddon(DB, body.site_id, "basic");
  const id = newId("rm");
  await DB.prepare(
    `INSERT INTO resources (id, site_id, name, active, created_at) VALUES (?, ?, ?, 1, ?)`
  ).bind(id, body.site_id, body.name, nowSec()).run();
  return json({ resource: { id: id, site_id: body.site_id, name: body.name, active: 1 } }, 201);
}

async function updateResource(DB, ownerId, resourceId, body) {
  const existing = await DB.prepare(`SELECT * FROM resources WHERE id = ?`).bind(resourceId).first();
  if (!existing) return err("resource not found", 404);
  await assertSiteOwnership(DB, existing.site_id, ownerId);
  await requireBookingsAddon(DB, existing.site_id, "basic");
  const name = body.name != null ? body.name : existing.name;
  const active = body.active != null ? (body.active ? 1 : 0) : existing.active;
  await DB.prepare(`UPDATE resources SET name = ?, active = ? WHERE id = ?`)
    .bind(name, active, resourceId).run();
  return json({ ok: true });
}

async function deleteResource(DB, ownerId, resourceId) {
  const existing = await DB.prepare(`SELECT * FROM resources WHERE id = ?`).bind(resourceId).first();
  if (!existing) return err("resource not found", 404);
  await assertSiteOwnership(DB, existing.site_id, ownerId);
  await requireBookingsAddon(DB, existing.site_id, "basic");
  // Soft delete — a booking history referencing this resource must survive.
  await DB.prepare(`UPDATE resources SET active = 0 WHERE id = ?`).bind(resourceId).run();
  return json({ ok: true });
}

// ---------------------------------------------------------------------------
// Shared notify-worker call -- the one place every caller in this file
// (owner-on-new-booking, guest-on-status-change, guest-check-in-reminder)
// talks to websites-notify-worker, so the service-binding/fallback/
// response-parsing logic exists exactly once. Depends on notify-worker
// v1.1's channel dispatch (whatsapp/email/sms) -- see that file's
// changelog. sms is a recognized value here too (so this code doesn't need
// touching again once a provider exists) but notify-worker currently
// always returns ok:false for it.
// ---------------------------------------------------------------------------

async function sendNotifyChannel(env, payloadBody) {
  if (!env.NOTIFY_WORKER && !env.NOTIFY_WORKER_URL) return false;
  const payload = {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payloadBody),
  };
  try {
    const resp = env.NOTIFY_WORKER
      ? await env.NOTIFY_WORKER.fetch(new Request("https://internal/send", payload))
      : await fetch(env.NOTIFY_WORKER_URL.replace(/\/+$/, "") + "/send", payload);
    const data = await resp.json().catch(function () { return {}; });
    return !!data.ok;
  } catch (e) {
    return false;
  }
}

// WhatsApp first; email only attempted if WhatsApp reports failure (no
// known subscriber, or the send itself failed) AND an email address is
// available. Used for notifications that usually fire soon after a
// WhatsApp interaction, where WhatsApp is trusted as primary -- the owner
// new-booking ping, and the guest status-change notification.
async function sendNotifyWithFallback(env, phone, email, message, subject) {
  if (phone) {
    const sentWhatsApp = await sendNotifyChannel(env, { channel: "whatsapp", phone: phone, message: message });
    if (sentWhatsApp) return true;
  }
  if (email) {
    return await sendNotifyChannel(env, { channel: "email", email: email, subject: subject, message: message });
  }
  return false;
}

// WhatsApp AND email both attempted independently, regardless of whether
// the other succeeded. Used ONLY by the check-in reminder sweep -- the one
// notification most likely to fire outside WhatsApp's 24-hour session
// window (see v1.5 changelog), so it gets both channels rather than a
// fallback chain. Returns true if EITHER channel reports success.
async function sendNotifyBothChannels(env, phone, email, message, subject) {
  let anySent = false;
  if (phone) {
    const sentWhatsApp = await sendNotifyChannel(env, { channel: "whatsapp", phone: phone, message: message });
    if (sentWhatsApp) anySent = true;
  }
  if (email) {
    const sentEmail = await sendNotifyChannel(env, { channel: "email", email: email, subject: subject, message: message });
    if (sentEmail) anySent = true;
  }
  return anySent;
}

// ---------------------------------------------------------------------------
// Owner notification (step 4a of the notifications plan) — instant WhatsApp
// ping to the owner when a guest submits a new booking request. See the
// v1.2 changelog note at the top of this file for the constraints this
// design is built around (guest cannot be notified; owner LOGIN phone, not
// site contact number; multi-tenant site-name disambiguation).
// ---------------------------------------------------------------------------

async function notifyOwnerOfNewBooking(DB, env, siteId, booking) {
  const site = await DB.prepare(
    `SELECT s.site_name AS site_name, o.phone AS owner_phone, o.email AS owner_email
       FROM sites s JOIN owners o ON o.id = s.owner_id
      WHERE s.id = ?`
  ).bind(siteId).first();
  if (!site || (!site.owner_phone && !site.owner_email)) return;

  const resource = await DB.prepare(`SELECT name FROM resources WHERE id = ?`)
    .bind(booking.resourceId).first();
  const roomName = (resource && resource.name) || "a room";
  const siteName = site.site_name || "your site";
  const guestLine = booking.customerName
    ? booking.customerName + (booking.customerPhone ? " (" + booking.customerPhone + ")" : "")
    : (booking.customerPhone || "a guest");

  const message =
    "New booking request \u2014 " + siteName + "\n\n" +
    roomName + "\n" +
    booking.startDate + " \u2192 " + booking.endDate + "\n" +
    "From: " + guestLine + "\n" +
    "Via: " + (booking.source === "whatsapp" ? "WhatsApp" : "website") + "\n\n" +
    "Open your dashboard to confirm or decline.";

  await sendNotifyWithFallback(env, site.owner_phone, site.owner_email, message, "New booking request \u2014 " + siteName);
}

// ---------------------------------------------------------------------------
// Guest status notification (v1.5) -- the other half of the loop that was
// one-way (owner-only) since v1.2. Fires on confirmed/declined/cancelled.
// Attempted for every booking regardless of source -- notify-worker itself
// silently no-ops (ok:false) for a phone that was never a ManyChat
// subscriber, so this is harmless for a web-form guest and simply works
// for anyone who came through the WhatsApp handoff flow.
// ---------------------------------------------------------------------------

async function notifyGuestOfStatusChange(DB, env, booking) {
  if (!booking.customer_phone && !booking.customer_email) return;

  const site = await DB.prepare(`SELECT site_name FROM sites WHERE id = ?`)
    .bind(booking.site_id).first();
  const resource = await DB.prepare(`SELECT name FROM resources WHERE id = ?`)
    .bind(booking.resource_id).first();
  const siteName = (site && site.site_name) || "the property";
  const roomName = (resource && resource.name) || "your room";

  let message;
  if (booking.status === "confirmed") {
    message =
      "Good news! Your booking at " + siteName + " is confirmed.\n\n" +
      roomName + "\n" +
      booking.start_date + " \u2192 " + booking.end_date + "\n\n" +
      "We look forward to hosting you.";
  } else if (booking.status === "declined") {
    message =
      "Sorry \u2014 " + siteName + " isn't able to accommodate " + roomName +
      " for " + booking.start_date + " \u2192 " + booking.end_date + ". " +
      "Message us if you'd like to check other dates.";
  } else if (booking.status === "cancelled") {
    message =
      "Your booking at " + siteName + " for " + roomName + " (" +
      booking.start_date + " \u2192 " + booking.end_date + ") has been cancelled. " +
      "Message us if you have any questions.";
  } else {
    return;
  }

  const subjectBySiteName = {
    confirmed: "Booking confirmed \u2014 " + siteName,
    declined: "About your booking request \u2014 " + siteName,
    cancelled: "Booking cancelled \u2014 " + siteName,
  };

  await sendNotifyWithFallback(env, booking.customer_phone, booking.customer_email, message, subjectBySiteName[booking.status]);
}

// ---------------------------------------------------------------------------
// Check-in reminder sweep (v1.5) -- run by the Cron Trigger below.
// Zimbabwe is UTC+2 with no DST, so "tomorrow in Harare" is a fixed-offset
// shift, not a timezone-library lookup. Cron Triggers themselves always
// fire in UTC (see the wrangler.toml deploy note in the changelog above);
// this function only decides which calendar DATE counts as "tomorrow"
// once the sweep is already running.
// ---------------------------------------------------------------------------

const HARARE_UTC_OFFSET_MS = 2 * 60 * 60 * 1000; // UTC+2, no DST

function harareDateString(utcMs, dayOffset) {
  const shifted = new Date(utcMs + HARARE_UTC_OFFSET_MS + (dayOffset || 0) * 86400000);
  const y = shifted.getUTCFullYear();
  const m = String(shifted.getUTCMonth() + 1).padStart(2, "0");
  const d = String(shifted.getUTCDate()).padStart(2, "0");
  return y + "-" + m + "-" + d;
}

// Idempotent via checkin_reminder_sent_at (added unused in v1.3): only
// stamped after a CONFIRMED successful send, so a transient notify failure
// is naturally retried on the next sweep instead of the reminder being
// silently lost -- and a booking already stamped is never re-swept.
//
// NOTE (v1.8): deliberately NOT gated by requireBookingsAddon(). If a
// site's bookings addon lapses between confirming a stay and the
// check-in date, the guest still deserves their reminder -- this sweep
// is guest-facing courtesy on an already-confirmed booking, not a new
// paid action, so it runs regardless of current addon status.
async function runCheckinReminders(DB, env) {
  const tomorrow = harareDateString(Date.now(), 1);
  const rows = await DB.prepare(
    `SELECT * FROM bookings
       WHERE booking_type = 'interval'
         AND status = 'confirmed'
         AND start_date = ?
         AND checkin_reminder_sent_at IS NULL`
  ).bind(tomorrow).all();

  const bookings = rows.results || [];
  let sentCount = 0;

  for (const b of bookings) {
    if (!b.customer_phone && !b.customer_email) continue;

    const site = await DB.prepare(`SELECT site_name FROM sites WHERE id = ?`)
      .bind(b.site_id).first();
    const resource = await DB.prepare(`SELECT name FROM resources WHERE id = ?`)
      .bind(b.resource_id).first();
    const siteName = (site && site.site_name) || "us";
    const roomName = (resource && resource.name) || "your room";

    const message =
      "Reminder: your check-in at " + siteName + " is tomorrow (" + b.start_date + ").\n\n" +
      roomName + "\n\n" +
      "We look forward to hosting you!";

    // Both channels, not fallback -- this is the notification most likely
    // to fall outside WhatsApp's 24-hour session window (see v1.5), so it
    // gets the most aggressive delivery strategy available.
    const ok = await sendNotifyBothChannels(env, b.customer_phone, b.customer_email, message, "Check-in reminder \u2014 " + siteName);
    if (ok) {
      await DB.prepare(`UPDATE bookings SET checkin_reminder_sent_at = ? WHERE id = ?`)
        .bind(nowSec(), b.id).run();
      sentCount++;
    }
  }

  return { checked: bookings.length, sent: sentCount, for_date: tomorrow };
}

// ---------------------------------------------------------------------------
// Booking-intent reference (WhatsApp handoff) — a short, self-describing
// token embedded in the "Continue on WhatsApp" wa.me link the calendar
// widget generates. No DB storage needed: it's just base64url(JSON), and
// every value inside it is re-validated (site/resource ownership, live
// availability, date sanity) on every use, both here in bookingIntentHandler
// and again by the atomic overlap guard in createBooking(). A stale or
// tampered ref simply fails safely (400/404/409) -- it carries no authority
// of its own, it's just a compact way to pass 4 fields through a WhatsApp
// message and back out again via ManyChat's External Request action.
// ---------------------------------------------------------------------------

function encodeBookingRef(obj) {
  const json = JSON.stringify(obj);
  const b64 = btoa(json);
  return b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function decodeBookingRef(ref) {
  try {
    let b64 = String(ref || "").replace(/-/g, "+").replace(/_/g, "/");
    while (b64.length % 4) b64 += "=";
    return JSON.parse(atob(b64));
  } catch (e) {
    return null;
  }
}

// GET /booking-intent?ref=<token> -- called by the ManyChat flow as the
// first step after a guest sends the prefilled WhatsApp message. Decodes
// the ref, resolves it to a human-readable room + site name, and does a
// live availability re-check (the guest may have taken a while to switch
// from the website to WhatsApp, so the ref's dates could already be stale
// by the time this fires -- better to tell them that up front than let
// them find out only after confirming, via a 409 on POST /bookings).
async function bookingIntentHandler(DB, url) {
  const ref = url.searchParams.get("ref");
  const decoded = decodeBookingRef(ref);
  if (
    !decoded ||
    !decoded.site_id ||
    !decoded.resource_id ||
    !isValidISODate(decoded.start_date) ||
    !isValidISODate(decoded.end_date) ||
    decoded.start_date >= decoded.end_date
  ) {
    return err("invalid or expired booking reference", 400);
  }

  await requireBookingsAddon(DB, decoded.site_id, "basic");

  const row = await DB.prepare(
    `SELECT r.name AS room_name, s.site_name AS site_name
       FROM resources r JOIN sites s ON s.id = r.site_id
      WHERE r.id = ? AND r.site_id = ? AND r.active = 1`
  ).bind(decoded.resource_id, decoded.site_id).first();
  if (!row) return err("room not found or no longer available", 404);

  const booked = await getBookedRanges(DB, decoded.resource_id, decoded.start_date, decoded.end_date);
  const nights = Math.round(
    (new Date(decoded.end_date + "T00:00:00Z") - new Date(decoded.start_date + "T00:00:00Z")) / 86400000
  );

  return json({
    site_id: decoded.site_id,
    resource_id: decoded.resource_id,
    site_name: row.site_name || "the property",
    room_name: row.room_name || "the room",
    start_date: decoded.start_date,
    end_date: decoded.end_date,
    nights: nights,
    still_available: booked.length === 0,
  });
}

// ---------------------------------------------------------------------------
// Availability + booking creation — interval shape only (v1 scope)
// ---------------------------------------------------------------------------

const BLOCKING_STATUSES = ["pending", "confirmed"];

async function getBookedRanges(DB, resourceId, fromDate, toDate) {
  const placeholders = BLOCKING_STATUSES.map(function () { return "?"; }).join(",");
  // 'block' rows (maintenance/owner-use -- no booking-creation endpoint
  // for these yet, see v1.4 changelog) occupy the calendar exactly like
  // 'interval' bookings do. Widened from 'interval'-only so that whenever
  // a future feature starts inserting block rows, availability correctly
  // reflects them immediately -- no second migration or logic change.
  const sql = `SELECT start_date, end_date FROM bookings
     WHERE resource_id = ? AND booking_type IN ('interval','block')
       AND status IN (${placeholders})
       AND start_date < ? AND end_date > ?
     ORDER BY start_date ASC`;
  const binds = [resourceId, ...BLOCKING_STATUSES, toDate, fromDate];
  const rows = await DB.prepare(sql).bind(...binds).all();
  return rows.results || [];
}

async function availabilityHandler(DB, url) {
  const resourceId = url.searchParams.get("resource_id");
  const from = url.searchParams.get("from");
  const to = url.searchParams.get("to");
  if (!resourceId || !isValidISODate(from) || !isValidISODate(to)) {
    return err("resource_id, from (YYYY-MM-DD), to (YYYY-MM-DD) required");
  }
  const siteId = await getResourceSiteId(DB, resourceId);
  if (!siteId) return err("resource not found", 404);
  await requireBookingsAddon(DB, siteId, "basic");
  const booked = await getBookedRanges(DB, resourceId, from, to);
  return json({ resource_id: resourceId, booked_ranges: booked });
}

// Atomic overlap guard: INSERT ... SELECT ... WHERE NOT EXISTS(conflict).
// If a conflicting row exists, zero rows are inserted — no read-then-write
// race window between checking availability and creating the booking.
//
// v1.9: extracted from createBooking() so createManualBooking() (Pro,
// owner-facing) shares the exact same race-safe logic rather than a
// second hand-copied version of this SQL. Returns { id, inserted:boolean }
// -- callers decide what a failed insert means for their own response.
async function insertBookingAtomic(DB, params) {
  const id = newId("bk");
  const placeholders = BLOCKING_STATUSES.map(function () { return "?"; }).join(",");
  // Widened to 'interval','block' (see getBookedRanges()): a new booking
  // must not be creatable on top of an existing 'block' row either, once
  // those exist.
  const sql = `
    INSERT INTO bookings (id, site_id, resource_id, booking_type, start_date, end_date,
                           customer_name, customer_phone, customer_email, status, source, created_at)
    SELECT ?, ?, ?, 'interval', ?, ?, ?, ?, ?, ?, ?, ?
    WHERE NOT EXISTS (
      SELECT 1 FROM bookings
        WHERE resource_id = ? AND booking_type IN ('interval','block')
          AND status IN (${placeholders})
          AND start_date < ? AND end_date > ?
    )`;
  const binds = [
    id, params.siteId, params.resourceId, params.startDate, params.endDate,
    params.customerName || null, params.customerPhone || null, params.customerEmail || null,
    params.status, params.source, nowSec(),
    params.resourceId, ...BLOCKING_STATUSES, params.endDate, params.startDate,
  ];
  const result = await DB.prepare(sql).bind(...binds).run();
  const inserted = result.meta && result.meta.changes ? result.meta.changes : 0;
  return { id: id, inserted: !!inserted };
}

async function createBooking(DB, env, body) {
  const siteId = body.site_id;
  const resourceId = body.resource_id;
  const startDate = body.start_date;
  const endDate = body.end_date;
  if (!siteId || !resourceId || !isValidISODate(startDate) || !isValidISODate(endDate)) {
    return err("site_id, resource_id, start_date, end_date (YYYY-MM-DD) required");
  }
  if (startDate >= endDate) return err("start_date must be before end_date");

  // Gate before touching resources/bookings at all -- a lapsed or
  // never-purchased bookings addon must not be able to take a live
  // booking, regardless of whether the resource itself is valid.
  await requireBookingsAddon(DB, siteId, "basic");

  // 'whatsapp' = created via the ManyChat handoff flow, 'web' = the
  // original in-page calendar form. Anything else falls back to 'web'
  // rather than erroring -- this field is informational (owner
  // notifications + future reporting), not a security boundary.
  const source = body.source === "whatsapp" ? "whatsapp" : "web";

  const resource = await DB.prepare(`SELECT id FROM resources WHERE id = ? AND site_id = ? AND active = 1`)
    .bind(resourceId, siteId).first();
  if (!resource) return err("resource not found or inactive", 404);

  const { id, inserted } = await insertBookingAtomic(DB, {
    siteId: siteId, resourceId: resourceId, startDate: startDate, endDate: endDate,
    customerName: body.customer_name, customerPhone: body.customer_phone, customerEmail: body.customer_email,
    status: "pending", source: source,
  });
  if (!inserted) return err("those dates are no longer available for this resource", 409);

  // Best-effort owner notification. Never blocks or fails the booking
  // response itself -- a notify failure (worker unreachable, owner not a
  // ManyChat subscriber, etc.) must not look like a failed booking to the
  // guest, who has no way to interpret or retry a notify-layer error.
  try {
    await notifyOwnerOfNewBooking(DB, env, siteId, {
      resourceId: resourceId,
      startDate: startDate,
      endDate: endDate,
      customerName: body.customer_name || "",
      customerPhone: body.customer_phone || "",
      source: source,
    });
  } catch (e) {
    console.error("Owner notify failed (non-fatal):", e && e.message);
  }

  return json({ booking: { id: id, status: "pending", start_date: startDate, end_date: endDate, source: source } }, 201);
}

// ---------------------------------------------------------------------------
// Manual multi-channel entry (v1.9, Pro only) — for bookings taken over the
// phone, at the front desk (walk-in), or by email: any channel where the
// owner/staff is the one entering the booking, not the guest. Same overlap
// protection as the guest-facing flow (shares insertBookingAtomic()), per
// the Pro pricing description.
//
// Defaults to status='confirmed' -- unlike a guest-submitted booking, a
// manual entry represents something staff has already agreed to with the
// customer at the point of typing it in, not a request awaiting review.
// An owner can still pass status='pending' explicitly for a tentative
// hold they haven't confirmed with the guest yet.
// ---------------------------------------------------------------------------
const MANUAL_CHANNELS = ["phone", "walk_in", "email", "other"];

async function createManualBooking(DB, ownerId, body) {
  const siteId = body.site_id;
  const resourceId = body.resource_id;
  const startDate = body.start_date;
  const endDate = body.end_date;
  if (!siteId || !resourceId || !isValidISODate(startDate) || !isValidISODate(endDate)) {
    return err("site_id, resource_id, start_date, end_date (YYYY-MM-DD) required");
  }
  if (startDate >= endDate) return err("start_date must be before end_date");
  if (!body.customer_name) return err("customer_name required for manual entry");

  await assertSiteOwnership(DB, siteId, ownerId);
  await requireBookingsAddon(DB, siteId, "pro");

  const channel = MANUAL_CHANNELS.indexOf(body.channel) > -1 ? body.channel : "other";
  const status = body.status === "pending" ? "pending" : "confirmed";

  const resource = await DB.prepare(`SELECT id FROM resources WHERE id = ? AND site_id = ? AND active = 1`)
    .bind(resourceId, siteId).first();
  if (!resource) return err("resource not found or inactive", 404);

  const { id, inserted } = await insertBookingAtomic(DB, {
    siteId: siteId, resourceId: resourceId, startDate: startDate, endDate: endDate,
    customerName: body.customer_name, customerPhone: body.customer_phone || null,
    customerEmail: body.customer_email || null, status: status, source: channel,
  });
  if (!inserted) return err("those dates are no longer available for this resource", 409);

  return json({ booking: { id: id, status: status, start_date: startDate, end_date: endDate, source: channel } }, 201);
}

// Owner: dashboard list + confirm/decline/cancel
async function listBookings(DB, ownerId, siteId) {
  await assertSiteOwnership(DB, siteId, ownerId);
  await requireBookingsAddon(DB, siteId, "basic");
  const rows = await DB.prepare(
    `SELECT * FROM bookings WHERE site_id = ? ORDER BY created_at DESC LIMIT 200`
  ).bind(siteId).all();
  return json({ bookings: rows.results || [] });
}

async function updateBookingStatus(DB, env, ownerId, bookingId, newStatus) {
  const valid = ["confirmed", "declined", "cancelled"];
  if (valid.indexOf(newStatus) < 0) return err("status must be one of: " + valid.join(", "));
  const existing = await DB.prepare(`SELECT * FROM bookings WHERE id = ?`).bind(bookingId).first();
  if (!existing) return err("booking not found", 404);
  await assertSiteOwnership(DB, existing.site_id, ownerId);
  await requireBookingsAddon(DB, existing.site_id, "basic");
  await DB.prepare(`UPDATE bookings SET status = ? WHERE id = ?`).bind(newStatus, bookingId).run();

  // Best-effort guest notification -- never blocks or fails this response.
  // Same fail-open discipline as the owner notification in createBooking().
  try {
    await notifyGuestOfStatusChange(DB, env, {
      site_id: existing.site_id,
      resource_id: existing.resource_id,
      customer_phone: existing.customer_phone,
      customer_email: existing.customer_email,
      start_date: existing.start_date,
      end_date: existing.end_date,
      status: newStatus,
    });
  } catch (e) {
    console.error("Guest notify failed (non-fatal):", e && e.message);
  }

  return json({ ok: true });
}

// ---------------------------------------------------------------------------
// Proof-of-payment tracking (v1.9, Pro only) — writes against the
// `booking_payments` ledger table (schema existed since v1.4, unused until
// now). Kept deliberately separate from `bookings.payment_status`, which
// is the fast-path summary column: this table can represent "deposit
// paid, balance still owing" in a way a single status column cannot, per
// the v1.4 design note.
// ---------------------------------------------------------------------------
const PAYMENT_TYPES = ["deposit", "balance", "refund", "adjustment", "full"];

async function insertPaymentLedgerRow(DB, bookingId, type, amount, currency, recordedBy) {
  const id = newId("pay");
  await DB.prepare(
    `INSERT INTO booking_payments (id, booking_id, type, amount, currency, recorded_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).bind(id, bookingId, type, amount != null ? amount : null, currency || null, recordedBy, nowSec()).run();
  return id;
}

// General ledger entry -- deposit, balance, refund, or adjustment.
// Deliberately does NOT touch bookings.payment_status: that summary is
// only ever written by markBookingPaid() below, so "detailed history" and
// "fast-path summary" stay cleanly separated rather than this endpoint
// guessing what a partial payment should mean for the summary column.
async function recordBookingPayment(DB, ownerId, bookingId, body) {
  const type = body.type;
  if (PAYMENT_TYPES.indexOf(type) < 0 || type === "full") {
    return err("type must be one of: deposit, balance, refund, adjustment");
  }
  const existing = await DB.prepare(`SELECT * FROM bookings WHERE id = ?`).bind(bookingId).first();
  if (!existing) return err("booking not found", 404);
  await assertSiteOwnership(DB, existing.site_id, ownerId);
  await requireBookingsAddon(DB, existing.site_id, "pro");

  const paymentId = await insertPaymentLedgerRow(
    DB, bookingId, type, body.amount, body.currency, ownerId
  );
  return json({ payment: { id: paymentId, booking_id: bookingId, type: type, amount: body.amount || null, currency: body.currency || null } }, 201);
}

// One-tap "mark as paid" -- the fast path the Pro tier is priced around.
// Writes a type='full' ledger row (so the payment still shows up in the
// booking's history) AND sets bookings.payment_status='paid' plus
// amount/currency/payment_reference in the same call.
async function markBookingPaid(DB, ownerId, bookingId, body) {
  const existing = await DB.prepare(`SELECT * FROM bookings WHERE id = ?`).bind(bookingId).first();
  if (!existing) return err("booking not found", 404);
  await assertSiteOwnership(DB, existing.site_id, ownerId);
  await requireBookingsAddon(DB, existing.site_id, "pro");

  const amount = body.amount != null ? body.amount : existing.amount;
  const currency = body.currency || existing.currency || "USD";

  await insertPaymentLedgerRow(DB, bookingId, "full", amount, currency, ownerId);
  await DB.prepare(
    `UPDATE bookings SET payment_status = 'paid', amount = ?, currency = ?, payment_reference = ? WHERE id = ?`
  ).bind(amount, currency, body.reference || existing.payment_reference || null, bookingId).run();

  return json({ ok: true, payment_status: "paid", amount: amount, currency: currency });
}

// Read side -- full payment history for a booking, for a detail view.
async function listBookingPayments(DB, ownerId, bookingId) {
  const existing = await DB.prepare(`SELECT site_id FROM bookings WHERE id = ?`).bind(bookingId).first();
  if (!existing) return err("booking not found", 404);
  await assertSiteOwnership(DB, existing.site_id, ownerId);
  await requireBookingsAddon(DB, existing.site_id, "pro");

  const rows = await DB.prepare(
    `SELECT id, type, amount, currency, recorded_by, created_at FROM booking_payments
       WHERE booking_id = ? ORDER BY created_at ASC`
  ).bind(bookingId).all();
  return json({ payments: rows.results || [] });
}

// Read-only tier lookup for the editor UI (v1.10). Deliberately available
// at ANY tier (including null/no addon) -- the editor needs to know "no
// addon" just as much as "basic" or "pro" so it can render the right
// upsell state. This does not call requireBookingsAddon() since there is
// nothing here to gate; it's a status check, not a protected action.
async function getBookingsTierForOwner(DB, ownerId, siteId) {
  if (!siteId) return err("site_id required");
  await assertSiteOwnership(DB, siteId, ownerId);
  const tier = await getBookingsTier(DB, siteId);
  return json({ tier: tier });
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------
export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS });

    const DB = env.DB;
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    try {
      // Utility — safe to leave in prod, no-ops after first successful run.
      if (path === "/admin/migrate" && method === "POST") {
        return json(await migrateBookingTables(DB));
      }
      // Manual trigger for the check-in reminder sweep -- lets this be
      // tested before the wrangler.toml Cron Trigger exists, and gives a
      // way to force a re-run later if ever needed. Gated behind
      // CRON_SECRET, matching websites-cozw-renewal-cron.js's /run
      // endpoint exactly (Authorization: Bearer <token>, 401 otherwise) --
      // unlike /admin/migrate above, this one sends real WhatsApp messages
      // to real guests on every successful call, so it doesn't get the
      // same unauthenticated treatment.
      if (path === "/admin/run-reminders" && method === "POST") {
        const token = (request.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
        if (!env.CRON_SECRET || token !== env.CRON_SECRET) {
          return err("unauthorized", 401);
        }
        return json(await runCheckinReminders(DB, env));
      }

      // Public, storefront-facing
      if (path === "/resources" && method === "GET") {
        const siteId = url.searchParams.get("site_id");
        if (!siteId) return err("site_id required");
        return await listResourcesPublic(DB, siteId);
      }
      if (path === "/availability" && method === "GET") {
        return await availabilityHandler(DB, url);
      }
      if (path === "/booking-intent" && method === "GET") {
        return await bookingIntentHandler(DB, url);
      }
      if (path === "/bookings" && method === "POST") {
        const body = await request.json().catch(function () { return {}; });
        return await createBooking(DB, env, body);
      }

      // Owner-only, requires session
      if (path === "/resources" && method === "POST") {
        const { owner_id } = await verifyOwner(request, env);
        const body = await request.json().catch(function () { return {}; });
        return await createResource(DB, owner_id, body);
      }
      const resourceMatch = path.match(/^\/resources\/([^/]+)$/);
      if (resourceMatch && method === "PUT") {
        const { owner_id } = await verifyOwner(request, env);
        const body = await request.json().catch(function () { return {}; });
        return await updateResource(DB, owner_id, resourceMatch[1], body);
      }
      if (resourceMatch && method === "DELETE") {
        const { owner_id } = await verifyOwner(request, env);
        return await deleteResource(DB, owner_id, resourceMatch[1]);
      }
      if (path === "/bookings" && method === "GET") {
        const { owner_id } = await verifyOwner(request, env);
        const siteId = url.searchParams.get("site_id");
        if (!siteId) return err("site_id required");
        return await listBookings(DB, owner_id, siteId);
      }
      const statusMatch = path.match(/^\/bookings\/([^/]+)\/status$/);
      if (statusMatch && method === "PUT") {
        const { owner_id } = await verifyOwner(request, env);
        const body = await request.json().catch(function () { return {}; });
        return await updateBookingStatus(DB, env, owner_id, statusMatch[1], body.status);
      }

      // Manual multi-channel entry + proof-of-payment tracking (v1.9,
      // Pro only -- gated inside each handler via requireBookingsAddon).
      if (path === "/bookings/manual" && method === "POST") {
        const { owner_id } = await verifyOwner(request, env);
        const body = await request.json().catch(function () { return {}; });
        return await createManualBooking(DB, owner_id, body);
      }
      const paymentsMatch = path.match(/^\/bookings\/([^/]+)\/payments$/);
      if (paymentsMatch && method === "POST") {
        const { owner_id } = await verifyOwner(request, env);
        const body = await request.json().catch(function () { return {}; });
        return await recordBookingPayment(DB, owner_id, paymentsMatch[1], body);
      }
      if (paymentsMatch && method === "GET") {
        const { owner_id } = await verifyOwner(request, env);
        return await listBookingPayments(DB, owner_id, paymentsMatch[1]);
      }
      const markPaidMatch = path.match(/^\/bookings\/([^/]+)\/mark-paid$/);
      if (markPaidMatch && method === "POST") {
        const { owner_id } = await verifyOwner(request, env);
        const body = await request.json().catch(function () { return {}; });
        return await markBookingPaid(DB, owner_id, markPaidMatch[1], body);
      }
      if (path === "/bookings/tier" && method === "GET") {
        const { owner_id } = await verifyOwner(request, env);
        const siteId = url.searchParams.get("site_id");
        return await getBookingsTierForOwner(DB, owner_id, siteId);
      }

      return err("not found", 404);
    } catch (e) {
      if (e instanceof Response) return e; // verifyOwner/requireBookingsAddon throw Response directly
      return err("internal error: " + (e && e.message ? e.message : String(e)), 500);
    }
  },

  // Cron Trigger handler -- see the wrangler.toml deploy note in the v1.5
  // changelog at the top of this file for the actual schedule entry this
  // requires. ctx.waitUntil() lets the sweep finish after the scheduled
  // event itself returns, same as any background work in a Worker.
  async scheduled(event, env, ctx) {
    ctx.waitUntil(
      runCheckinReminders(env.DB, env).catch(function (e) {
        console.error("Check-in reminder sweep failed:", e && e.message);
      })
    );
  },
};