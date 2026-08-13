// websites-bookings-worker.js
//
// v1.17 — DEPOSIT / FULL-PAYMENT BOOKINGS (Pro tier). The other half of the
// direct-collection deposit model designed alongside payments-worker.js
// v1.6's owner Paynow credentials + POST /deposit/charge:
//   - New booking_services columns: commitment_level ('none'|'deposit'|
//     'full', default 'none'), deposit_amount (fixed $), deposit_percent
//     (% of service price). Owner sets these per service in the editor,
//     same as staff_mode (v1.13) -- a barber might require a deposit for
//     a wedding-day package but not a walk-in trim. Setting either field
//     to non-'none' now requires Bookings PRO (requireBookingsAddon(...,
//     "pro")), matching the pricing split agreed alongside the $12/$25
//     tiers: deposits are the Pro-tier revenue-protection feature.
//   - New bookings.hold_expires_at (nullable INTEGER, epoch seconds). A
//     slot booking created against a deposit/full-commitment service is
//     inserted as status='pending' with a ~15 minute hold instead of
//     occupying the slot indefinitely while awaiting payment.
//     insertSlotBookingAtomic()'s NOT EXISTS overlap guard now excludes
//     rows whose hold has already expired, so a customer who abandons
//     checkout doesn't permanently squat the slot -- this is enforced at
//     the SQL level (atomic, race-safe) rather than relying on the cron
//     sweep below to have already run.
//   - createSlotBooking(): when the chosen service has commitment_level
//     != 'none', the booking is inserted with a hold, THEN charged via a
//     service-binding call to payments-worker's POST /deposit/charge
//     (using the OWNER's own connected Paynow account, not the platform's
//     USD/ZiG integrations). Before even attempting this, checks the
//     owner has a VERIFIED merchant_credentials row (via payments-worker's
//     GET /merchant-credentials/status) -- failing fast with a clear
//     message rather than creating a hold nobody can ever pay off. If the
//     charge itself fails to initiate, the hold is released immediately
//     (not left to expire) so another customer isn't made to wait.
//   - Deliberately does NOT notify the owner at booking-creation time for
//     a deposit/full-commitment booking -- only once payment is confirmed
//     (see handleDepositConfirmed below). Getting pinged about a booking
//     nobody's paid for yet is worse than not being pinged at all; a
//     commitment_level='none' service is completely unaffected and keeps
//     notifying immediately, exactly as before.
//   - New INTERNAL route POST /deposit-confirmed -- called by
//     payments-worker (service binding) once a deposit/full payment is
//     confirmed paid. Flips bookings.payment_status to 'paid', clears the
//     hold, and is the point at which the owner finally gets notified
//     (now with the paid amount in the message). Protected by a shared
//     secret header (X-Internal-Secret / env.INTERNAL_SHARED_SECRET) --
//     unlike a service binding, this route is still reachable by its
//     public URL, so it needs its own gate, matching the CRON_SECRET
//     pattern already used for /admin/run-reminders.
//   - New GET /bookings/deposit-status?ref=... -- guest-facing (no owner
//     session), thin proxy to payments-worker's GET /pay/status?ref=,
//     mirroring the existing owner-facing purchaseStatus() pattern from
//     v1.11 but reachable by the customer's own browser/WhatsApp flow
//     while they wait for their EcoCash prompt to be approved.
//   - New releaseExpiredHolds() sweep, run alongside the existing
//     check-in reminder cron -- not load-bearing for correctness (the
//     hold_expires_at check in the SQL guard already prevents double
//     booking even before this runs), but keeps the owner's dashboard
//     from showing abandoned unpaid holds as if they were live pending
//     requests forever.
//   - REQUIRES payments-worker.js v1.6 to be deployed first (its
//     /merchant-credentials/status and /deposit/charge routes), reusing
//     the SAME PAYMENTS_WORKER service binding already required since
//     v1.11 -- no new binding needed, just the new routes on the other
//     side of it.
//   - NEW SECRET REQUIRED: INTERNAL_SHARED_SECRET -- any random string,
//     shared between this worker and payments-worker's confirmDepositPaid()
//     call to POST /deposit-confirmed. Set via dashboard Settings ->
//     Variables -> Add secret (Encrypt) on BOTH workers, same value.
//
// v1.16 — owner block-off (maintenance, holidays, staff time off). Two new
// endpoints, matching the two existing booking models exactly rather than
// inventing a third shape:
//   POST /bookings/block-interval — rooms/venues, date-range (start_date/
//     end_date). The overlap-checking queries for interval bookings were
//     ALREADY widened to include booking_type='block' back when this
//     schema was first designed (see the v1.4 changelog) -- this is the
//     endpoint that was always missing to actually create one.
//   POST /bookings/block — stylists/consultants, either a whole day (or
//     day range via end_date) or a partial-day window (start_time/
//     end_time on a single day). Required widening insertSlotBookingAtomic()
//     and availableSlotsHandler()'s two existing-bookings queries from
//     booking_type='slot' to IN ('slot','block') -- the slot side never had
//     this concept at all until now, unlike interval's head start.
// Both endpoints:
//   - resource_id optional -- omit to block every active resource for the
//     site at once (e.g. "closed for the holidays" across all rooms/chairs).
//   - Reuse the EXACT SAME atomic overlap guard as a real booking
//     (insertBookingAtomic()/insertSlotBookingAtomic(), now parameterized
//     on bookingType + blockReason rather than forked into a second copy
//     of the same race-safe SQL). This is deliberate: a block cannot be
//     created on top of an already-confirmed guest booking. A multi-
//     resource block reports per-resource success so the owner can see
//     exactly which ones didn't go through (because something's already
//     booked there) rather than a single opaque pass/fail.
//   - Un-blocking is NOT a new endpoint -- the existing
//     PUT /bookings/:id/status with status='cancelled' already stops a row
//     from counting toward availability, identical to a real cancelled
//     booking. No new removal code needed.
//
// v1.15 — default opening hours fallback. A site whose owner has never
// touched the Hours tab at all previously showed ZERO available slots on
// EVERY day, forever, with no error or indication why -- exactly the kind
// of silent gap this project keeps tripping over. Now falls back to a
// sensible 9am-6pm default (DEFAULT_DAY_HOURS) ONLY when the whole hours
// object is absent (owner never configured Hours at all). The moment any
// day is configured, this stops applying entirely -- an owner's actual
// choices (including deliberately closing a specific day) are never
// overridden, only the "nothing was ever set" case gets a sensible
// default instead of permanent silence.
//
// v1.14 — operator-owned services (the "rent-a-chair" model). Most multi-
// chair salons in this market are actually several independent operators
// sharing one space, not one business with interchangeable staff -- a
// client booking Stylist A's chair must never silently be routed to
// Stylist B. New booking_services.resource_id (nullable):
//   - NULL: a shared, site-wide service (traditional salon) -- any
//     qualifying stylist can perform it, staff_mode governs how a guest
//     picks one (v1.13).
//   - populated: the service belongs to exactly ONE operator. There is no
//     "any available" question for these rows at all -- staff_mode is
//     simply irrelevant when there's only ever one possible person.
// GET /services now has two distinct modes, matching the two eventual
// widget entry points:
//   ?site_id=X            -> shared services only (service-first browsing,
//                            traditional salon's site-wide price list)
//   ?site_id=X&resource_id=Y -> exactly Y's own services (person-first:
//                            guest already picked an operator's profile,
//                            sees only what THAT person offers)
// Deliberately never mixed in one response -- a shared-catalog browse
// should never show one operator's owned pricing, and an operator's
// profile should never show services that aren't theirs.
//
// v1.13 — per-service staff assignment mode ('any' | 'choose'), owner-set
// in the editor per booking_service, not a global site setting. Business
// reasoning: a salon might want "any available stylist" for a quick
// blow-dry (guest books faster, backend picks who's free) but "choose"
// for a service where clients have a regular stylist they expect to see.
//   - New booking_services.staff_mode column, default 'choose' -- most
//     multi-chair salons in this market are actually several independent
//     rent-a-chair operators sharing one space, not one business with
//     interchangeable staff. A client is booking a specific person's
//     chair, not "whoever's free at the salon," so "choose" is the
//     realistic default; "any" stays available as an opt-in for genuinely
//     interchangeable services (e.g. a quick blow-dry at a salon that
//     really does run that way).
//   - GET /available-slots: resource_id is now OPTIONAL. Given (or a
//     "choose" scenario), behaves exactly as v1.12. Omitted: computes the
//     UNION of availability across every active resource for the site in
//     two queries total (not one per resource) -- a candidate time is
//     available if AT LEAST ONE resource is free. The guest never learns
//     which stylist that is; this endpoint is read-only and has zero side
//     effects, unlike booking creation below.
//   - POST /bookings/slot: resource_id is now OPTIONAL. Given, books that
//     resource (unchanged). Omitted: tries every active resource for the
//     site in turn via the new insertSlotBookingAtomic() helper (extracted
//     from the old inline SQL) -- same atomic WHERE NOT EXISTS guard as
//     always, just attempted across candidates until one succeeds. This
//     endpoint doesn't enforce a service's staff_mode itself -- that's a
//     widget-UI decision (whether to show a stylist picker at all); the
//     backend just does whatever the caller actually asked for.
//
// v1.12 — slot bookings. Second booking_type ('slot') alongside the
// existing 'interval' (hospitality rooms) -- SAME Bookings addon
// (Basic/Pro, same gating), not a separate product. Built for beauty-salon
// first; consultant/real-estate/restaurant reuse the identical mechanics
// once proven -- see migration-slot-bookings.sql for the schema addition.
//   - New booking_services table (name, duration_min, price) -- the one
//     concept interval bookings never needed: a fixed DURATION tied to
//     what's being booked. `resources` needed no schema change at all --
//     a stylist, consultant, listing, or restaurant table is already
//     exactly "a named thing that gets booked," same as a hospitality room.
//   - New bookings.service_id column (nullable, slot-only) -- links a
//     booking to what was actually booked, since a service's duration/
//     price can change later without retroactively affecting past bookings.
//   - GET /services, POST /services, PUT /services/:id, DELETE /services/:id
//     -- CRUD mirroring the existing resources endpoints exactly.
//   - GET /available-slots?resource_id=&service_id=&date= -- the one
//     genuinely new mechanic. Reads the site's opening hours (from
//     `sites.content` JSON -- the same hours data the editor's Hours tab
//     already writes), steps candidate start times across that day by the
//     service's duration, subtracts existing slot bookings for that
//     resource, returns what's actually bookable. Zimbabwe is UTC+2 with
//     no DST, so Harare-local <-> UTC conversion is a fixed-offset shift,
//     reusing the same HARARE_UTC_OFFSET_MS constant the check-in reminder
//     sweep already established.
//   - POST /bookings/slot (guest-facing, mirrors POST /bookings but for
//     slot type) -- atomic overlap guard on start_ts/end_ts, same
//     INSERT...WHERE NOT EXISTS pattern as insertBookingAtomic(), just
//     comparing timestamps instead of date strings.
//   - Manual slot entry (Pro) and slot-aware owner notifications are NOT
//     built in this pass -- guest-facing creation + availability first,
//     proven on one template, before extending either.
//
// v1.11 — addon purchase flow. New owner-authed POST /bookings/purchase and
// GET /bookings/purchase/status, both thin proxies to payments-worker.js's
// addon-kind Paynow flow (POST /pay with kind='addon', addon_type='bookings',
// tier). This Worker owns the ownership/tier validation
// (assertSiteOwnership(), tier value check); payments-worker stays purely a
// trusted-caller Paynow gateway, same trust model as its existing site_plan
// flow.
//   - New PAYMENTS_WORKER service binding required (with a
//     PAYMENTS_WORKER_URL fallback, matching the existing
//     NOTIFY_WORKER/NOTIFY_WORKER_URL pattern already in this file).
//   - Uses Paynow's EcoCash push (Mobile/Remote Transaction API) via
//     payments-worker.js v1.4, NOT a browser-redirect checkout -- requires
//     the owner's phone number, no return_url or redirect_url involved at
//     all. This was a deliberate switch from an earlier version of this
//     addition that used Express Checkout/browser-redirect, once it turned
//     out that flow had never actually been confirmed against a real
//     Paynow transaction, unlike the EcoCash push pattern.
//   - GET /bookings/purchase/status?ref=&site_id= is a generic proxy to
//     payments-worker's GET /pay/status?ref= (which is itself generic by
//     reference, unaware of kind) -- ties the check to a site_id the
//     caller actually owns via assertSiteOwnership() as a courtesy, though
//     the reference alone is already unguessable per payments-worker's own
//     security model.
//   - Before this, the ONLY way to grant a site a bookings addon was the
//     manual backfill script + hand-run SQL -- there was no way for an
//     owner to actually buy or upgrade Bookings themselves.
//
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
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Internal-Secret",
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

// v1.12 -- slot bookings. The one concept interval bookings never needed:
// a fixed DURATION tied to what's being booked. `resources` itself needs
// no change at all -- a stylist, consultant, listing, or restaurant table
// is already exactly "a named thing that gets booked."
const BOOKING_SERVICES_DDL = `
CREATE TABLE IF NOT EXISTS booking_services (
  id            TEXT PRIMARY KEY,
  site_id       TEXT NOT NULL,
  resource_id   TEXT,
  name          TEXT NOT NULL,
  duration_min  INTEGER NOT NULL,
  price         REAL,
  staff_mode    TEXT NOT NULL DEFAULT 'choose',
  active        INTEGER NOT NULL DEFAULT 1,
  created_at    INTEGER NOT NULL
);`;

const INDEX_DDL = [
  `CREATE INDEX IF NOT EXISTS idx_resources_site ON resources (site_id, active);`,
  `CREATE INDEX IF NOT EXISTS idx_bookings_resource_dates ON bookings (resource_id, status, start_date, end_date);`,
  `CREATE INDEX IF NOT EXISTS idx_bookings_site ON bookings (site_id, status);`,
  `CREATE INDEX IF NOT EXISTS idx_booking_payments_booking ON booking_payments (booking_id, created_at);`,
  `CREATE INDEX IF NOT EXISTS idx_booking_services_site ON booking_services (site_id, active);`,
  `CREATE INDEX IF NOT EXISTS idx_bookings_slot_resource_ts ON bookings (resource_id, status, start_ts, end_ts) WHERE booking_type IN ('slot','block');`,
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
  await DB.prepare(BOOKING_SERVICES_DDL).run();
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

  // v1.12 additive column -- links a slot booking to what was actually
  // booked (nullable; interval bookings never set this).
  await ensureColumn(DB, "bookings", "service_id", "TEXT");

  // v1.13 additive column -- per-service staff assignment mode. 'any' (the
  // default): guest never sees a stylist picker, backend auto-assigns among
  // the site's active resources. 'choose': guest explicitly picks a
  // resource before seeing times. Owner sets this per service in the
  // editor, not a global site setting -- a salon might want "any" for a
  // quick blow-dry but "choose" for a service where clients have a
  // regular stylist.
  await ensureColumn(DB, "booking_services", "staff_mode", "TEXT NOT NULL DEFAULT 'choose'");

  // v1.14 additive column -- NULL means a shared, site-wide service
  // (traditional salon: any qualifying stylist can perform it, staff_mode
  // governs how). Populated means the service belongs to exactly one
  // operator -- the rent-a-chair case, where most multi-chair salons in
  // this market actually operate: independent businesses sharing a roof,
  // not one business with interchangeable staff. An owned service has no
  // "any available" question at all -- there is only ever one possible
  // person, so staff_mode is simply irrelevant for these rows.
  await ensureColumn(DB, "booking_services", "resource_id", "TEXT");

  // v1.17 additive columns -- deposit/full-payment commitment per service
  // (Pro tier), and the soft-hold TTL on a booking awaiting that payment.
  await ensureColumn(DB, "booking_services", "commitment_level", "TEXT NOT NULL DEFAULT 'none'");
  await ensureColumn(DB, "booking_services", "deposit_amount", "REAL");
  await ensureColumn(DB, "booking_services", "deposit_percent", "REAL");
  await ensureColumn(DB, "bookings", "hold_expires_at", "INTEGER");

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
//   pro:   manual multi-channel entry, proof-of-payment tracking,
//          AND (v1.17) deposit/full-payment commitment per service --
//          the revenue-protection feature the Pro tier's upsell case is
//          actually built around. When a new Pro-only feature is added,
//          gate it with requireBookingsAddon(DB, siteId, "pro")
//          specifically -- do not relax the basic gate on the routes
//          below to do it.
//   - Deliberate exception: runCheckinReminders() (the Cron Trigger sweep)
//     is NOT gated. It only touches bookings already confirmed while the
//     addon was active -- if the addon lapses between confirmation and
//     check-in, the guest still gets their reminder. This is a courtesy
//     follow-through on a booking already taken, not a new paid action.
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
// v1.17 — expired deposit-hold sweep. NOT load-bearing for correctness --
// insertSlotBookingAtomic()'s NOT EXISTS guard already excludes rows whose
// hold has expired at the SQL level, so a slot frees up for booking the
// instant the hold TTL passes even if this sweep hasn't run yet. This
// exists purely for dashboard hygiene: without it, an owner's Bookings tab
// would show abandoned unpaid holds sitting in 'pending' forever, visually
// indistinguishable from a live request actually awaiting their decision.
// ---------------------------------------------------------------------------
async function releaseExpiredHolds(DB) {
  const now = nowSec();
  const res = await DB.prepare(
    `UPDATE bookings SET status = 'cancelled', payment_status = 'failed'
       WHERE booking_type = 'slot' AND status = 'pending' AND payment_status = 'pending'
         AND hold_expires_at IS NOT NULL AND hold_expires_at < ?`
  ).bind(now).run();
  const released = res.meta && res.meta.changes ? res.meta.changes : 0;
  return { released: released };
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
  const bookingType = params.bookingType || "interval";
  const placeholders = BLOCKING_STATUSES.map(function () { return "?"; }).join(",");
  // Widened to 'interval','block' (see getBookedRanges()): a new booking
  // must not be creatable on top of an existing 'block' row either, once
  // those exist. v1.16: bookingType/blockReason are now parameters so this
  // same atomic guard creates real bookings AND owner-created block rows
  // (maintenance, holidays) -- one insert path, not two copies of the same
  // race-safe SQL to keep in sync.
  const sql = `
    INSERT INTO bookings (id, site_id, resource_id, booking_type, start_date, end_date,
                           customer_name, customer_phone, customer_email, status, source, block_reason, created_at)
    SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
    WHERE NOT EXISTS (
      SELECT 1 FROM bookings
        WHERE resource_id = ? AND booking_type IN ('interval','block')
          AND status IN (${placeholders})
          AND start_date < ? AND end_date > ?
    )`;
  const binds = [
    id, params.siteId, params.resourceId, bookingType, params.startDate, params.endDate,
    params.customerName || null, params.customerPhone || null, params.customerEmail || null,
    params.status, params.source || "owner", params.blockReason || null, nowSec(),
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

// ── Owner block-off: interval resources (rooms, venues) — v1.16 ────────────
// POST /bookings/block-interval — marks resource(s) unavailable for
// maintenance, a holiday closure, an event, etc. Reuses insertBookingAtomic()
// with bookingType='block' -- the exact same atomic overlap guard as a real
// booking, deliberately: a block CANNOT be created on top of an already-
// confirmed guest stay, forcing the owner to notice and resolve that
// conflict rather than silently double-booking someone out of their
// existing reservation. Un-blocking is NOT a separate endpoint -- the
// existing PUT /bookings/:id/status with status='cancelled' already stops
// a row from counting toward availability (same as it does for a real
// cancelled booking), so that's the removal path, no new code needed there.
async function createIntervalBlock(DB, ownerId, body) {
  const siteId = body.site_id;
  const startDate = body.start_date;
  const endDate = body.end_date;
  const reason = body.reason || "Blocked";
  if (!siteId || !isValidISODate(startDate) || !isValidISODate(endDate)) {
    return err("site_id, start_date, end_date (YYYY-MM-DD) required");
  }
  if (startDate >= endDate) return err("start_date must be before end_date");
  await assertSiteOwnership(DB, siteId, ownerId);
  await requireBookingsAddon(DB, siteId, "basic");

  // resource_id omitted -> block every active resource for the site (e.g.
  // "we're closed for the holidays" across all rooms at once).
  let resourceIds;
  if (body.resource_id) {
    const resource = await DB.prepare(`SELECT id FROM resources WHERE id = ? AND site_id = ? AND active = 1`)
      .bind(body.resource_id, siteId).first();
    if (!resource) return err("resource not found or inactive", 404);
    resourceIds = [body.resource_id];
  } else {
    const rows = await DB.prepare(`SELECT id FROM resources WHERE site_id = ? AND active = 1`).bind(siteId).all();
    resourceIds = (rows.results || []).map(function (r) { return r.id; });
    if (!resourceIds.length) return err("no resources found for this site", 404);
  }

  const results = [];
  for (const rid of resourceIds) {
    const attempt = await insertBookingAtomic(DB, {
      siteId: siteId, resourceId: rid, startDate: startDate, endDate: endDate,
      status: "confirmed", bookingType: "block", blockReason: reason,
    });
    results.push({ resource_id: rid, blocked: attempt.inserted, booking_id: attempt.inserted ? attempt.id : null });
  }
  const blockedCount = results.filter(function (r) { return r.blocked; }).length;
  // 409 only when NOTHING could be blocked (e.g. the single named resource
  // already has a conflicting confirmed stay) -- a partial success across
  // multiple resources still returns 201 with the per-resource breakdown so
  // the owner can see exactly which ones didn't go through and why.
  return json({ blocked: blockedCount, total: resourceIds.length, results: results }, blockedCount > 0 ? 201 : 409);
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
// Slot bookings (v1.12) — second booking_type ('slot') alongside 'interval'.
// Same Bookings addon (Basic/Pro), same gating pattern (requireBookingsAddon)
// as everything else in this file. Built first for beauty-salon; the same
// mechanics are intended to extend to consultant/real-estate/restaurant
// once proven here -- see the v1.12 changelog at the top of this file.
// ---------------------------------------------------------------------------

// ── booking_services CRUD — mirrors the resources CRUD above exactly ──────

// v1.14: two distinct browsing modes, matching the two entry points into
// the eventual widget --
//   GET /services?site_id=X              -> shared services only
//     (resource_id IS NULL) -- the service-first flow for a traditional
//     salon's site-wide price list.
//   GET /services?site_id=X&resource_id=Y -> exactly Y's own services
//     (resource_id = Y) -- the person-first flow: a guest already picked
//     an operator's profile, sees only what THAT person offers.
// Deliberately never mixes the two in one response -- a shared-catalog
// browse should never show a specific operator's owned pricing mixed in,
// and an operator's profile should never show services that aren't theirs.
async function listServicesPublic(DB, siteId, resourceId) {
  await requireBookingsAddon(DB, siteId, "basic");
  const sql = resourceId
    ? `SELECT id, resource_id, name, duration_min, price, staff_mode, commitment_level, deposit_amount, deposit_percent FROM booking_services WHERE site_id = ? AND resource_id = ? AND active = 1 ORDER BY created_at ASC`
    : `SELECT id, resource_id, name, duration_min, price, staff_mode, commitment_level, deposit_amount, deposit_percent FROM booking_services WHERE site_id = ? AND resource_id IS NULL AND active = 1 ORDER BY created_at ASC`;
  const stmt = resourceId ? DB.prepare(sql).bind(siteId, resourceId) : DB.prepare(sql).bind(siteId);
  const rows = await stmt.all();
  return json({ services: rows.results || [] });
}

const STAFF_MODES = ["any", "choose"];

// v1.17 — commitment_level validation, shared by createService/updateService.
// `existing` is null for a create (nothing to fall back to); for an update,
// any field the caller didn't send falls back to the existing row's value,
// matching this file's established "only touch what's provided" convention.
const COMMITMENT_LEVELS = ["none", "deposit", "full"];

function resolveCommitmentFields(body, existing) {
  const level = body.commitment_level !== undefined
    ? body.commitment_level
    : (existing ? existing.commitment_level : "none");
  if (COMMITMENT_LEVELS.indexOf(level) < 0) {
    return { ok: false, error: "commitment_level must be one of: " + COMMITMENT_LEVELS.join(", ") };
  }
  const depositAmount = body.deposit_amount !== undefined
    ? (body.deposit_amount != null ? Number(body.deposit_amount) : null)
    : (existing ? existing.deposit_amount : null);
  const depositPercent = body.deposit_percent !== undefined
    ? (body.deposit_percent != null ? Number(body.deposit_percent) : null)
    : (existing ? existing.deposit_percent : null);
  if (level === "deposit" && depositAmount == null && depositPercent == null) {
    return { ok: false, error: "deposit_amount or deposit_percent required when commitment_level is 'deposit'" };
  }
  return { ok: true, commitment_level: level, deposit_amount: depositAmount, deposit_percent: depositPercent };
}

async function createService(DB, ownerId, body) {
  if (!body.site_id || !body.name || !body.duration_min) {
    return err("site_id, name, and duration_min required");
  }
  const durationMin = parseInt(body.duration_min, 10);
  if (!(durationMin > 0)) return err("duration_min must be a positive number of minutes");
  const staffMode = STAFF_MODES.indexOf(body.staff_mode) > -1 ? body.staff_mode : "choose";
  await assertSiteOwnership(DB, body.site_id, ownerId);
  await requireBookingsAddon(DB, body.site_id, "basic");

  const commitment = resolveCommitmentFields(body, null);
  if (!commitment.ok) return err(commitment.error);
  // Deposits/full-payment are a Pro-tier feature -- the revenue-protection
  // upsell case the $25/mo tier is actually priced around. A basic-tier
  // site can still create services fine, just always with 'none'.
  if (commitment.commitment_level !== "none") {
    await requireBookingsAddon(DB, body.site_id, "pro");
  }
  if (commitment.commitment_level === "full" && body.price == null) {
    return err("price is required to charge full payment upfront -- set a price for this service");
  }
  if (commitment.commitment_level === "deposit" && commitment.deposit_percent != null && body.price == null) {
    return err("price is required when deposit_percent is used -- either set a price, or use deposit_amount instead");
  }

  // If this service belongs to a specific operator, confirm that resource
  // actually exists on this site -- same ownership discipline as every
  // other resource_id reference in this file.
  let resourceId = null;
  if (body.resource_id) {
    const resource = await DB.prepare(`SELECT id FROM resources WHERE id = ? AND site_id = ? AND active = 1`)
      .bind(body.resource_id, body.site_id).first();
    if (!resource) return err("resource not found or inactive", 404);
    resourceId = body.resource_id;
  }

  const id = newId("svc");
  await DB.prepare(
    `INSERT INTO booking_services (id, site_id, resource_id, name, duration_min, price, staff_mode, commitment_level, deposit_amount, deposit_percent, active, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`
  ).bind(
    id, body.site_id, resourceId, body.name, durationMin,
    body.price != null ? Number(body.price) : null, staffMode,
    commitment.commitment_level, commitment.deposit_amount, commitment.deposit_percent,
    nowSec()
  ).run();
  return json({ service: {
    id: id, site_id: body.site_id, resource_id: resourceId, name: body.name, duration_min: durationMin,
    price: body.price || null, staff_mode: staffMode, active: 1,
    commitment_level: commitment.commitment_level, deposit_amount: commitment.deposit_amount, deposit_percent: commitment.deposit_percent,
  } }, 201);
}

async function updateService(DB, ownerId, serviceId, body) {
  const existing = await DB.prepare(`SELECT * FROM booking_services WHERE id = ?`).bind(serviceId).first();
  if (!existing) return err("service not found", 404);
  await assertSiteOwnership(DB, existing.site_id, ownerId);
  await requireBookingsAddon(DB, existing.site_id, "basic");
  const name = body.name != null ? body.name : existing.name;
  const durationMin = body.duration_min != null ? parseInt(body.duration_min, 10) : existing.duration_min;
  const price = body.price != null ? Number(body.price) : existing.price;
  const staffMode = STAFF_MODES.indexOf(body.staff_mode) > -1 ? body.staff_mode : existing.staff_mode;
  const active = body.active != null ? (body.active ? 1 : 0) : existing.active;

  const commitment = resolveCommitmentFields(body, existing);
  if (!commitment.ok) return err(commitment.error);
  if (commitment.commitment_level !== "none") {
    await requireBookingsAddon(DB, existing.site_id, "pro");
  }
  const effectivePrice = body.price != null ? Number(body.price) : existing.price;
  if (commitment.commitment_level === "full" && effectivePrice == null) {
    return err("price is required to charge full payment upfront -- set a price for this service");
  }
  if (commitment.commitment_level === "deposit" && commitment.deposit_percent != null && effectivePrice == null) {
    return err("price is required when deposit_percent is used -- either set a price, or use deposit_amount instead");
  }

  // resource_id can be explicitly cleared (pass an empty string) to turn an
  // owned service back into a shared one, or set/changed to reassign it --
  // undefined (key absent entirely) leaves it untouched, matching this
  // function's existing "only touch what's provided" convention for every
  // other field above.
  let resourceId = existing.resource_id;
  if (body.resource_id !== undefined) {
    if (body.resource_id) {
      const resource = await DB.prepare(`SELECT id FROM resources WHERE id = ? AND site_id = ? AND active = 1`)
        .bind(body.resource_id, existing.site_id).first();
      if (!resource) return err("resource not found or inactive", 404);
      resourceId = body.resource_id;
    } else {
      resourceId = null;
    }
  }

  await DB.prepare(`UPDATE booking_services SET name = ?, duration_min = ?, price = ?, staff_mode = ?, resource_id = ?, commitment_level = ?, deposit_amount = ?, deposit_percent = ?, active = ? WHERE id = ?`)
    .bind(name, durationMin, price, staffMode, resourceId, commitment.commitment_level, commitment.deposit_amount, commitment.deposit_percent, active, serviceId).run();
  return json({ ok: true });
}

async function deleteService(DB, ownerId, serviceId) {
  const existing = await DB.prepare(`SELECT * FROM booking_services WHERE id = ?`).bind(serviceId).first();
  if (!existing) return err("service not found", 404);
  await assertSiteOwnership(DB, existing.site_id, ownerId);
  await requireBookingsAddon(DB, existing.site_id, "basic");
  // Soft delete -- past bookings referencing this service must survive.
  await DB.prepare(`UPDATE booking_services SET active = 0 WHERE id = ?`).bind(serviceId).run();
  return json({ ok: true });
}

// ── Harare-local time helpers ──────────────────────────────────────────────
// Zimbabwe is UTC+2 with no DST (same constant already established by the
// check-in reminder sweep), so local<->UTC is always a fixed-offset shift,
// never a timezone-library lookup.

const DAY_KEYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

// Used ONLY when a site's Hours tab has never been touched at all (see
// getSiteHours() returning null) -- a sensible generic default so a brand-
// new site isn't silently unbookable on every single day just because the
// owner hasn't gotten around to Hours yet. The moment ANY day is
// configured, this stops applying entirely.
const DEFAULT_DAY_HOURS = { open: "09:00", close: "18:00", closed: false };

// v1.17 -- soft-hold window for a slot booking awaiting deposit/full
// payment before it's released back for someone else to book.
const HOLD_TTL_SECONDS = 15 * 60; // 15 minutes

// "2026-08-01" -> "sat" (the Harare-LOCAL weekday for that calendar date,
// not whatever weekday the date would be in UTC -- a date string on its
// own has no timezone, so we anchor it at Harare midday to sidestep any
// UTC-day-boundary edge case entirely).
function dayKeyForDate(dateStr) {
  const d = new Date(dateStr + "T12:00:00Z");
  return DAY_KEYS[d.getUTCDay()];
}

// ("2026-08-01", "09:00") -> epoch seconds for 09:00 Harare time on that date.
function harareLocalToUtcSec(dateStr, timeStr) {
  const utcMs = Date.parse(dateStr + "T" + timeStr + ":00Z") - HARARE_UTC_OFFSET_MS;
  return Math.floor(utcMs / 1000);
}

// Reverse of the above, for returning slot start times to the caller.
function utcSecToHarareTimeString(ts) {
  const shifted = new Date(ts * 1000 + HARARE_UTC_OFFSET_MS);
  const h = String(shifted.getUTCHours()).padStart(2, "0");
  const m = String(shifted.getUTCMinutes()).padStart(2, "0");
  return h + ":" + m;
}

// Reads the site's opening hours from `sites.content` -- the SAME JSON blob
// the editor's Hours tab already writes to (content.hours = { mon: {open,
// close, closed}, ... }). bookings-worker already reads other fields off
// `sites` directly elsewhere in this file (bookingIntentHandler,
// notifyOwnerOfNewBooking), so this follows the same established pattern
// rather than inventing a separate hours store.
async function getSiteHours(DB, siteId) {
  const row = await DB.prepare(`SELECT content FROM sites WHERE id = ?`).bind(siteId).first();
  if (!row || !row.content) return null;
  try {
    const parsed = JSON.parse(row.content);
    const hours = (parsed.content && parsed.content.hours) || parsed.hours || null;
    return hours || null;
  } catch (e) {
    return null;
  }
}

// ── Available slots — the one genuinely new mechanic ───────────────────────
// GET /available-slots?service_id=&date=&resource_id=  (resource_id optional)
// Steps candidate start times across the day (by the service's own
// duration -- back-to-back scheduling, no gaps) from open to close minus
// duration, subtracts existing 'slot' bookings, returns what's actually
// bookable.
//
// v1.17: both branches now also exclude bookings whose deposit hold has
// already expired (hold_expires_at IS NULL OR hold_expires_at > now) --
// an abandoned, unpaid hold must not make a slot look unavailable forever.
//
// v1.13: resource_id is now OPTIONAL, parameterized by the service's
// staff_mode (per-service, owner-set in the editor):
//   - resource_id given (or service.staff_mode === 'choose'): single-
//     resource behaviour, unchanged from v1.12 -- a candidate time is
//     available if THAT resource is free.
//   - resource_id omitted AND service.staff_mode === 'any': computes the
//     UNION of availability across every active resource for the site --
//     a candidate time is available if AT LEAST ONE resource is free. The
//     guest never sees which stylist that is; createSlotBooking() resolves
//     the actual assignment atomically at booking time, not here (this
//     endpoint is read-only and must never have side effects).
async function availableSlotsHandler(DB, url) {
  const resourceId = url.searchParams.get("resource_id");
  const serviceId = url.searchParams.get("service_id");
  const siteIdParam = url.searchParams.get("site_id");
  const date = url.searchParams.get("date");
  if (!serviceId || !isValidISODate(date) || (!resourceId && !siteIdParam)) {
    return err("service_id, date (YYYY-MM-DD), and either resource_id or site_id required");
  }

  const siteId = resourceId ? await getResourceSiteId(DB, resourceId) : siteIdParam;
  if (!siteId) return err("resource not found", 404);
  await requireBookingsAddon(DB, siteId, "basic");

  const service = await DB.prepare(`SELECT id, site_id, duration_min, staff_mode, active FROM booking_services WHERE id = ?`)
    .bind(serviceId).first();
  if (!service || service.site_id !== siteId || !service.active) {
    return err("service not found or inactive", 404);
  }
  const durationSec = service.duration_min * 60;
  // Explicit resource_id always wins (e.g. a "choose" service where the
  // guest already picked a stylist) -- staff_mode only matters when the
  // caller didn't name one.
  const anyMode = !resourceId;

  const hours = await getSiteHours(DB, siteId);
  const dayKey = dayKeyForDate(date);
  // If the owner has NEVER touched the Hours tab at all (hours is null --
  // not just this one day being unset), fall back to a sensible default
  // schedule rather than showing the site as permanently unbookable every
  // single day. Once ANY day has been configured, this fallback stops
  // applying entirely -- an owner who deliberately left Sunday unset (or
  // marked it closed) must have that respected, not silently overridden.
  const dayHours = hours ? hours[dayKey] : DEFAULT_DAY_HOURS;
  if (!dayHours || dayHours.closed || !dayHours.open || !dayHours.close) {
    return json({ resource_id: resourceId || null, service_id: serviceId, date: date, duration_min: service.duration_min, slots: [] });
  }

  const dayStartTs = harareLocalToUtcSec(date, dayHours.open);
  const dayEndTs = harareLocalToUtcSec(date, dayHours.close);
  const placeholders = BLOCKING_STATUSES.map(function () { return "?"; }).join(",");
  const nowTs = nowSec();

  const slots = [];

  if (!anyMode) {
    const existing = await DB.prepare(
      `SELECT start_ts, end_ts FROM bookings
         WHERE resource_id = ? AND booking_type IN ('slot','block')
           AND status IN (${placeholders})
           AND (hold_expires_at IS NULL OR hold_expires_at > ?)
           AND start_ts < ? AND end_ts > ?
         ORDER BY start_ts ASC`
    ).bind(resourceId, ...BLOCKING_STATUSES, nowTs, dayEndTs, dayStartTs).all();
    const booked = existing.results || [];

    for (let candidateStart = dayStartTs; candidateStart + durationSec <= dayEndTs; candidateStart += durationSec) {
      const candidateEnd = candidateStart + durationSec;
      const overlaps = booked.some(function (b) { return candidateStart < b.end_ts && candidateEnd > b.start_ts; });
      if (!overlaps) slots.push({ start_time: utcSecToHarareTimeString(candidateStart), start_ts: candidateStart, end_ts: candidateEnd });
    }
  } else {
    // "Any available" -- fetch every active resource for the site, and
    // that resource's booked ranges for the day, in two queries total
    // (not one query per resource) regardless of staff count.
    const resourceRows = await DB.prepare(`SELECT id FROM resources WHERE site_id = ? AND active = 1`).bind(siteId).all();
    const resourceIds = (resourceRows.results || []).map(function (r) { return r.id; });
    if (!resourceIds.length) {
      return json({ resource_id: null, service_id: serviceId, date: date, duration_min: service.duration_min, slots: [] });
    }
    const resourcePlaceholders = resourceIds.map(function () { return "?"; }).join(",");
    const existing = await DB.prepare(
      `SELECT resource_id, start_ts, end_ts FROM bookings
         WHERE resource_id IN (${resourcePlaceholders}) AND booking_type IN ('slot','block')
           AND status IN (${placeholders})
           AND (hold_expires_at IS NULL OR hold_expires_at > ?)
           AND start_ts < ? AND end_ts > ?`
    ).bind(...resourceIds, ...BLOCKING_STATUSES, nowTs, dayEndTs, dayStartTs).all();
    const bookedByResource = {};
    (existing.results || []).forEach(function (b) {
      if (!bookedByResource[b.resource_id]) bookedByResource[b.resource_id] = [];
      bookedByResource[b.resource_id].push(b);
    });

    for (let candidateStart = dayStartTs; candidateStart + durationSec <= dayEndTs; candidateStart += durationSec) {
      const candidateEnd = candidateStart + durationSec;
      // Available if ANY resource has no overlapping booking -- the guest
      // never learns which one; createSlotBooking() resolves it for real,
      // atomically, at submit time.
      const anyResourceFree = resourceIds.some(function (rid) {
        const bookedForResource = bookedByResource[rid] || [];
        return !bookedForResource.some(function (b) { return candidateStart < b.end_ts && candidateEnd > b.start_ts; });
      });
      if (anyResourceFree) slots.push({ start_time: utcSecToHarareTimeString(candidateStart), start_ts: candidateStart, end_ts: candidateEnd });
    }
  }

  return json({ resource_id: resourceId || null, service_id: serviceId, date: date, duration_min: service.duration_min, slots: slots });
}

// Shared atomic insert for slot bookings -- extracted so auto-assign mode
// (below) can try multiple candidate resources in turn, each attempt using
// the exact same race-safe INSERT...WHERE NOT EXISTS guard. Whichever
// resource's attempt actually succeeds has genuinely claimed that slot --
// no window between "checking" and "booking" the way a separate
// read-then-write check would have.
async function insertSlotBookingAtomic(DB, params) {
  const id = newId("bk");
  const bookingType = params.bookingType || "slot";
  const placeholders = BLOCKING_STATUSES.map(function () { return "?"; }).join(",");
  const now = nowSec();
  // v1.16: widened from booking_type = 'slot' to IN ('slot','block') -- a
  // real booking must not be creatable on top of an owner's block-off
  // (maintenance, holiday), and a new block must not silently overwrite an
  // already-confirmed guest appointment. bookingType/blockReason are now
  // parameters so this one atomic guard serves both real bookings and
  // owner-created blocks -- matching the same pattern already used for
  // interval bookings via insertBookingAtomic().
  //
  // v1.17: also widened to exclude rows whose deposit hold has already
  // expired (hold_expires_at IS NULL OR hold_expires_at > now) -- a
  // 'pending' booking still technically in that status but whose payment
  // window has lapsed must not block a new attempt at the same slot. This
  // check happens INSIDE the atomic guard, not as a separate cleanup step
  // beforehand, so there's no race between "checking if expired" and
  // "inserting a new booking" either.
  const sql = `
    INSERT INTO bookings (id, site_id, resource_id, service_id, booking_type, start_ts, end_ts,
                           customer_name, customer_phone, customer_email, status, source, block_reason, hold_expires_at, created_at)
    SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
    WHERE NOT EXISTS (
      SELECT 1 FROM bookings
        WHERE resource_id = ? AND booking_type IN ('slot','block')
          AND status IN (${placeholders})
          AND (hold_expires_at IS NULL OR hold_expires_at > ?)
          AND start_ts < ? AND end_ts > ?
    )`;
  const binds = [
    id, params.siteId, params.resourceId, params.serviceId || null, bookingType, params.startTs, params.endTs,
    params.customerName || null, params.customerPhone || null, params.customerEmail || null,
    params.status, params.source || "owner", params.blockReason || null, params.holdExpiresAt || null, now,
    params.resourceId, ...BLOCKING_STATUSES, now, params.endTs, params.startTs,
  ];
  const result = await DB.prepare(sql).bind(...binds).run();
  const inserted = result.meta && result.meta.changes ? result.meta.changes : 0;
  return { id: id, inserted: !!inserted };
}

// v1.17 -- checks whether the site owner has a VERIFIED Paynow merchant
// account connected on payments-worker, via the same PAYMENTS_WORKER
// service binding already required since v1.11. Called before ever
// attempting to hold a slot for a deposit/full-commitment service, so a
// misconfigured (or never-connected) owner account fails with a clear
// message instead of creating a hold nobody can ever actually pay off.
async function ownerPaynowConnected(env, siteId) {
  const r = await callPaymentsWorker(env, "/merchant-credentials/status?site_id=" + encodeURIComponent(siteId), { method: "GET" });
  if (!r.ok || !r.data) return false;
  return !!(r.data.connected && r.data.status === "verified");
}

// v1.18 -- GUEST-facing currency lookup (see GET /bookings/currency route
// below). Lets the booking widget show "Deposit required: ZiG 15" instead
// of always assuming USD, BEFORE the customer ever submits and triggers a
// real charge -- at which point payments-worker's own /deposit/charge
// response is the authoritative source (this is just a display hint).
// Defaults to USD when nothing is connected yet or the lookup fails, since
// that's the safer assumption for a service that hasn't been fully set up.
async function ownerPaynowCurrency(env, siteId) {
  const r = await callPaymentsWorker(env, "/merchant-credentials/status?site_id=" + encodeURIComponent(siteId), { method: "GET" });
  if (!r.ok || !r.data || !r.data.connected) return "USD";
  return r.data.currency === "ZIG" ? "ZIG" : "USD";
}

// ── Slot booking creation (guest-facing) ────────────────────────────────────
// POST /bookings/slot -- mirrors createBooking() (interval) but for slot
// type. resource_id is OPTIONAL (v1.13): when provided, books that specific
// resource (a "choose"-mode service, or a guest who already picked a
// stylist). When omitted, tries every active resource for the site in turn
// via insertSlotBookingAtomic() -- the same atomic guard as always, just
// attempted across candidates until one succeeds -- for "any available
// stylist" services. This endpoint doesn't enforce a service's staff_mode
// itself (that's a widget-UI concern: whether to show a stylist picker at
// all); it just does whatever the caller actually asked for.
//
// v1.17: if the chosen service has commitment_level 'deposit' or 'full',
// the booking is inserted with a soft hold (HOLD_TTL_SECONDS) instead of
// occupying the slot indefinitely, then immediately charged via
// payments-worker's POST /deposit/charge using the owner's OWN connected
// Paynow account. The owner is deliberately NOT notified at this point --
// see handleDepositConfirmed() below for why, and for where that
// notification actually fires. If the charge fails to even initiate, the
// hold is released right away rather than left to expire on its own.
async function createSlotBooking(DB, env, body) {
  const siteId = body.site_id;
  const resourceId = body.resource_id || null;
  const serviceId = body.service_id;
  const date = body.date;
  const startTime = body.start_time;
  if (!siteId || !serviceId || !isValidISODate(date) || !startTime) {
    return err("site_id, service_id, date (YYYY-MM-DD), start_time (HH:MM) required");
  }

  await requireBookingsAddon(DB, siteId, "basic");

  const service = await DB.prepare(`SELECT id, duration_min, price, commitment_level, deposit_amount, deposit_percent FROM booking_services WHERE id = ? AND site_id = ? AND active = 1`)
    .bind(serviceId, siteId).first();
  if (!service) return err("service not found or inactive", 404);

  const commitmentLevel = service.commitment_level || "none";
  let depositAmount = null;

  if (commitmentLevel !== "none") {
    if (!body.customer_phone) {
      return err("customer_phone required -- this service needs a " + (commitmentLevel === "full" ? "full payment" : "deposit") + " to book");
    }
    if (commitmentLevel === "full") {
      if (service.price == null) return err("this service isn't fully set up for payment yet -- please contact the business directly");
      depositAmount = service.price;
    } else {
      if (service.deposit_amount != null) {
        depositAmount = service.deposit_amount;
      } else if (service.deposit_percent != null && service.price != null) {
        depositAmount = Math.round(service.price * (service.deposit_percent / 100) * 100) / 100;
      } else {
        return err("this service isn't fully set up for payment yet -- please contact the business directly");
      }
    }
    if (!(depositAmount > 0)) return err("this service isn't fully set up for payment yet -- please contact the business directly");

    const connected = await ownerPaynowConnected(env, siteId);
    if (!connected) {
      return err("this business hasn't finished setting up online payments yet -- please contact them directly to book", 409);
    }
  }

  const startTs = harareLocalToUtcSec(date, startTime);
  const endTs = startTs + service.duration_min * 60;
  const source = body.source === "whatsapp" ? "whatsapp" : "web";

  let candidateResourceIds;
  if (resourceId) {
    const resource = await DB.prepare(`SELECT id FROM resources WHERE id = ? AND site_id = ? AND active = 1`)
      .bind(resourceId, siteId).first();
    if (!resource) return err("resource not found or inactive", 404);
    candidateResourceIds = [resourceId];
  } else {
    const resourceRows = await DB.prepare(`SELECT id FROM resources WHERE site_id = ? AND active = 1`).bind(siteId).all();
    candidateResourceIds = (resourceRows.results || []).map(function (r) { return r.id; });
    if (!candidateResourceIds.length) return err("no stylists available for this site", 404);
  }

  const holdExpiresAt = commitmentLevel !== "none" ? nowSec() + HOLD_TTL_SECONDS : null;

  let bookingId = null;
  let assignedResourceId = null;
  for (const rid of candidateResourceIds) {
    const attempt = await insertSlotBookingAtomic(DB, {
      siteId: siteId, resourceId: rid, serviceId: serviceId, startTs: startTs, endTs: endTs,
      customerName: body.customer_name, customerPhone: body.customer_phone, customerEmail: body.customer_email,
      status: "pending", source: source, holdExpiresAt: holdExpiresAt,
    });
    if (attempt.inserted) { bookingId = attempt.id; assignedResourceId = rid; break; }
  }
  if (!bookingId) return err("that time slot is no longer available", 409);

  // No payment required -- unchanged from v1.13: notify the owner right
  // away and return.
  if (commitmentLevel === "none") {
    try {
      await notifySlotBookingOwner(DB, env, siteId, {
        resourceId: assignedResourceId, serviceId: serviceId, date: date, startTime: startTime,
        customerName: body.customer_name, customerPhone: body.customer_phone,
      });
    } catch (e) {
      console.error("Owner notify failed (non-fatal):", e && e.message);
    }
    return json({ booking: { id: bookingId, status: "pending", date: date, start_time: startTime, source: source, resource_id: assignedResourceId, payment_status: "not_required" } }, 201);
  }

  // Deposit/full required -- charge now via payments-worker, using the
  // OWNER's own connected Paynow account (direct-collection model). The
  // owner is deliberately NOT notified yet: pinging them about a booking
  // nobody's paid for would have them mentally reserve a slot that might
  // never actually be paid for. handleDepositConfirmed() (below) fires
  // that notification once payment is actually confirmed.
  const chargeResp = await callPaymentsWorker(env, "/deposit/charge", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      site_id: siteId, booking_id: bookingId, amount: depositAmount,
      customer_phone: body.customer_phone, customer_email: body.customer_email,
    }),
  });

  if (!chargeResp.ok) {
    // Release the hold immediately rather than leaving it to expire on
    // its own -- no reason to make another customer wait out the full
    // 15-minute TTL for a slot that's already known to be unchargeable.
    await DB.prepare(`UPDATE bookings SET status = 'cancelled', payment_status = 'failed' WHERE id = ?`).bind(bookingId).run();
    return json(Object.keys(chargeResp.data || {}).length ? chargeResp.data : { error: "deposit_charge_failed" }, chargeResp.status || 502);
  }

  return json({
    booking: {
      id: bookingId, status: "pending", date: date, start_time: startTime, source: source,
      resource_id: assignedResourceId, payment_status: "pending", commitment_level: commitmentLevel, deposit_amount: depositAmount,
    },
    payment: chargeResp.data,
  }, 201);
}

// Shared owner-notify helper for slot bookings, split out of
// createSlotBooking() in v1.17 so both the no-payment path above and
// handleDepositConfirmed() (below, once payment clears) can call the same
// message-building logic instead of drifting into two copies of it.
async function notifySlotBookingOwner(DB, env, siteId, info) {
  const site = await DB.prepare(
    `SELECT s.site_name AS site_name, o.phone AS owner_phone, o.email AS owner_email
       FROM sites s JOIN owners o ON o.id = s.owner_id WHERE s.id = ?`
  ).bind(siteId).first();
  if (!site || (!site.owner_phone && !site.owner_email)) return;

  const resourceRow = info.resourceId ? await DB.prepare(`SELECT name FROM resources WHERE id = ?`).bind(info.resourceId).first() : null;
  const serviceRow = info.serviceId ? await DB.prepare(`SELECT name FROM booking_services WHERE id = ?`).bind(info.serviceId).first() : null;
  const guestLine = info.customerName
    ? info.customerName + (info.customerPhone ? " (" + info.customerPhone + ")" : "")
    : (info.customerPhone || "a guest");

  const paidCurrency = info.currency === "ZIG" ? "ZIG" : "USD";
  const paidLabel = info.amountPaid != null
    ? (paidCurrency === "ZIG" ? "ZiG " + Number(info.amountPaid).toFixed(2) : "$" + Number(info.amountPaid).toFixed(2))
    : "";
  const paidLine = info.amountPaid != null ? ("Amount paid: " + paidLabel + "\n") : "";
  const headline = info.amountPaid != null ? "\uD83D\uDCB0 Deposit paid \u2014 new booking request" : "New booking request";

  const message =
    headline + " \u2014 " + (site.site_name || "your site") + "\n\n" +
    (serviceRow && serviceRow.name ? serviceRow.name : "Appointment") +
    (resourceRow && resourceRow.name ? " with " + resourceRow.name : "") + "\n" +
    info.date + " at " + info.startTime + "\n" +
    "From: " + guestLine + "\n" +
    paidLine + "\n" +
    "Open your dashboard to confirm.";

  await sendNotifyWithFallback(env, site.owner_phone, site.owner_email, message, headline + " \u2014 " + (site.site_name || "your site"));
}

// ── Owner block-off: slot resources (stylists, consultants) — v1.16 ────────
// POST /bookings/block — two shapes, mutually exclusive:
//   whole day(s): { date, end_date? } -- end_date omitted means one day,
//     provided means a range (e.g. a holiday closure spanning several days)
//   partial day:  { date, start_time, end_time } -- a single day only,
//     e.g. "closed 2-4pm Friday for a staff meeting"
// Same reasoning as createIntervalBlock(): reuses insertSlotBookingAtomic()
// with bookingType='block', so a block can never be created on top of an
// already-confirmed guest appointment (the atomic guard simply fails that
// attempt, surfaced per-resource in the response) -- and un-blocking is the
// existing PUT /bookings/:id/status with status='cancelled', no separate
// delete endpoint.
async function createSlotBlock(DB, ownerId, body) {
  const siteId = body.site_id;
  const date = body.date;
  const endDate = body.end_date || date;
  const startTime = body.start_time;
  const endTime = body.end_time;
  const reason = body.reason || "Blocked";
  if (!siteId || !isValidISODate(date) || !isValidISODate(endDate)) {
    return err("site_id and date (YYYY-MM-DD) required");
  }
  if (endDate < date) return err("end_date must be on or after date");
  await assertSiteOwnership(DB, siteId, ownerId);
  await requireBookingsAddon(DB, siteId, "basic");

  let startTs, endTs;
  if (startTime && endTime) {
    if (endDate !== date) return err("start_time/end_time only apply to a single day -- omit end_date for a partial-day block");
    startTs = harareLocalToUtcSec(date, startTime);
    endTs = harareLocalToUtcSec(date, endTime);
    if (endTs <= startTs) return err("end_time must be after start_time");
  } else {
    // Whole day(s) -- midnight of `date` through midnight AFTER `endDate`,
    // regardless of the site's configured opening hours (a block should
    // hold even outside business hours, e.g. blocking a full calendar day
    // that also happens to include hours the salon is normally closed).
    startTs = harareLocalToUtcSec(date, "00:00");
    endTs = harareLocalToUtcSec(endDate, "00:00") + 86400;
  }

  // resource_id omitted -> block every active resource for the site.
  let resourceIds;
  if (body.resource_id) {
    const resource = await DB.prepare(`SELECT id FROM resources WHERE id = ? AND site_id = ? AND active = 1`)
      .bind(body.resource_id, siteId).first();
    if (!resource) return err("resource not found or inactive", 404);
    resourceIds = [body.resource_id];
  } else {
    const rows = await DB.prepare(`SELECT id FROM resources WHERE site_id = ? AND active = 1`).bind(siteId).all();
    resourceIds = (rows.results || []).map(function (r) { return r.id; });
    if (!resourceIds.length) return err("no resources found for this site", 404);
  }

  const results = [];
  for (const rid of resourceIds) {
    const attempt = await insertSlotBookingAtomic(DB, {
      siteId: siteId, resourceId: rid, startTs: startTs, endTs: endTs,
      status: "confirmed", bookingType: "block", blockReason: reason,
    });
    results.push({ resource_id: rid, blocked: attempt.inserted, booking_id: attempt.inserted ? attempt.id : null });
  }
  const blockedCount = results.filter(function (r) { return r.blocked; }).length;
  return json({ blocked: blockedCount, total: resourceIds.length, results: results }, blockedCount > 0 ? 201 : 409);
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
// Addon purchase (v1.11) -- thin proxy to payments-worker.js v1.3's addon
// flow. This Worker validates ownership and the requested tier; the actual
// Paynow initiate/poll/confirm logic lives entirely in payments-worker,
// reached via a service binding (same pattern as NOTIFY_WORKER: binding
// first, public-URL fallback second, since a Cloudflare service binding is
// not guaranteed to exist in every environment this file might run in).
//
// v1.17: this same PAYMENTS_WORKER binding is now ALSO used for
// ownerPaynowConnected() and the deposit-charge call in createSlotBooking()
// above -- no new binding required, just new routes on the payments-worker
// side (v1.6).
// ---------------------------------------------------------------------------
const PURCHASE_TIERS = ["basic", "pro"];

async function callPaymentsWorker(env, path, opts) {
  if (!env.PAYMENTS_WORKER && !env.PAYMENTS_WORKER_URL) {
    return { ok: false, status: 0, data: { error: "payments_worker_unavailable" } };
  }
  try {
    const resp = env.PAYMENTS_WORKER
      ? await env.PAYMENTS_WORKER.fetch(new Request("https://internal" + path, opts))
      : await fetch(env.PAYMENTS_WORKER_URL.replace(/\/+$/, "") + path, opts);
    const data = await resp.json().catch(function () { return {}; });
    return { ok: resp.ok, status: resp.status, data: data };
  } catch (e) {
    return { ok: false, status: 0, data: { error: "payments_worker_unreachable" } };
  }
}

// POST /bookings/purchase (owner) -- initiates a Bookings Basic/Pro Paynow
// payment via Paynow's EcoCash push (Mobile/Remote Transaction API -- see
// payments-worker.js v1.4 for why this flow was chosen over Express
// Checkout: it's the one actually proven to move money on this account).
// Requires the owner's EcoCash phone number; there is no redirect_url in
// the response since there's no browser leg to this flow -- the owner
// approves a USSD prompt on their phone, and the caller polls
// GET /bookings/purchase/status with the returned reference until it's
// confirmed.
async function purchaseBookingsAddon(DB, env, ownerId, body) {
  const siteId = body.site_id;
  const tier = body.tier;
  const phone = body.phone;
  const email = typeof body.email === "string" ? body.email.trim() : "";
  if (!siteId) return err("site_id required");
  if (!phone) return err("phone required (EcoCash number to push the payment prompt to)");
  // Paynow needs a real email for the transaction record/receipt -- this
  // Worker validates presence early (payments-worker also validates format,
  // this just avoids a round-trip for the common "forgot to fill it in" case).
  if (!email) return err("email required (Paynow sends the payment receipt here)");
  if (PURCHASE_TIERS.indexOf(tier) < 0) return err("tier must be one of: " + PURCHASE_TIERS.join(", "));
  await assertSiteOwnership(DB, siteId, ownerId);

  const payload = {
    site_id: siteId,
    kind: "addon",
    addon_type: "bookings",
    tier: tier,
    phone: phone,
    email: email,
  };

  const r = await callPaymentsWorker(env, "/pay", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!r.ok) {
    return json(Object.keys(r.data || {}).length ? r.data : { error: "purchase_failed" }, r.status || 502);
  }
  return json(r.data, 200);
}

// GET /bookings/purchase/status?ref=&site_id= (owner) -- proxies
// payments-worker's generic-by-reference GET /pay/status. site_id is
// optional but when present is checked against ownership as a courtesy
// (the reference itself is already unguessable, per payments-worker's own
// security model -- this isn't the load-bearing check, just consistent
// with every other route in this file gating through assertSiteOwnership()
// wherever a site_id is available).
async function purchaseStatus(DB, env, ownerId, siteId, reference) {
  if (siteId) await assertSiteOwnership(DB, siteId, ownerId);
  const r = await callPaymentsWorker(env, "/pay/status?ref=" + encodeURIComponent(reference), { method: "GET" });
  if (!r.ok) {
    return json(Object.keys(r.data || {}).length ? r.data : { error: "status_check_failed" }, r.status || 502);
  }
  return json(r.data, 200);
}

// GET /bookings/deposit-status?ref=... -- v1.17, GUEST-facing (no owner
// session -- the customer paying the deposit has no account here). Thin
// proxy to payments-worker's GET /pay/status?ref=, same underlying call
// as purchaseStatus() above but reachable without auth, so the booking
// widget can poll it while the customer approves their EcoCash prompt.
// The reference is unguessable per payments-worker's own security model,
// same reasoning as purchaseStatus()'s courtesy-only site_id check.
async function depositStatus(env, reference) {
  const r = await callPaymentsWorker(env, "/pay/status?ref=" + encodeURIComponent(reference), { method: "GET" });
  if (!r.ok) {
    return json(Object.keys(r.data || {}).length ? r.data : { error: "status_check_failed" }, r.status || 502);
  }
  return json(r.data, 200);
}

// GET /bookings/currency?site_id=... -- v1.18, GUEST-facing (no owner
// session), same reasoning as depositStatus() above: the booking widget
// needs this before a customer ever submits, to show "Deposit required:
// ZiG 15" instead of always assuming USD. Read-only, no secrets exposed --
// just the currency code payments-worker already returns from
// GET /merchant-credentials/status.
async function currencyForSite(env, siteId) {
  const currency = await ownerPaynowCurrency(env, siteId);
  return json({ currency: currency }, 200);
}

// ---------------------------------------------------------------------------
// v1.17 -- POST /deposit-confirmed (INTERNAL). Called by payments-worker's
// confirmDepositPaid() once a booking deposit/full payment has actually
// cleared. Protected by a shared-secret header rather than trusting the
// service binding alone -- this route's URL is still publicly reachable
// like any other Worker route, a service binding call just happens to be
// how payments-worker reaches it in the normal case. Matches the
// CRON_SECRET pattern already used for /admin/run-reminders.
//
// This is the point where the owner FINALLY gets notified for a deposit/
// full-commitment booking -- see the "deliberately NOT notified yet" note
// in createSlotBooking() above for why it waits until here.
// ---------------------------------------------------------------------------
async function handleDepositConfirmed(DB, env, request) {
  const provided = request.headers.get("x-internal-secret") || "";
  if (!env.INTERNAL_SHARED_SECRET || provided !== env.INTERNAL_SHARED_SECRET) {
    return err("unauthorized", 401);
  }

  const body = await request.json().catch(function () { return {}; });
  const bookingId = body.booking_id;
  if (!bookingId) return err("booking_id required");

  const booking = await DB.prepare(`SELECT * FROM bookings WHERE id = ?`).bind(bookingId).first();
  if (!booking) return err("booking not found", 404);

  const amount = body.amount != null ? body.amount : booking.amount;
  // v1.18 -- payments-worker v1.8 now forwards the actual currency of the
  // owner's connected Paynow account (USD or ZIG) instead of this route
  // silently assuming USD. Falls back to USD only if an older
  // payments-worker (pre-v1.8) calls this without the field.
  const currency = body.currency === "ZIG" ? "ZIG" : "USD";

  await DB.prepare(
    `UPDATE bookings SET payment_status = 'paid', payment_reference = ?, amount = ?, currency = ?, hold_expires_at = NULL WHERE id = ?`
  ).bind(body.reference || null, amount, currency, bookingId).run();

  try {
    await notifySlotBookingOwner(DB, env, booking.site_id, {
      resourceId: booking.resource_id,
      serviceId: booking.service_id,
      date: booking.start_ts ? harareDateString(booking.start_ts * 1000, 0) : "",
      startTime: booking.start_ts ? utcSecToHarareTimeString(booking.start_ts) : "",
      customerName: booking.customer_name,
      customerPhone: booking.customer_phone,
      amountPaid: amount,
      currency: currency,
    });
  } catch (e) {
    console.error("Owner notify (deposit confirmed) failed (non-fatal):", e && e.message);
  }

  return json({ ok: true });
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
      // v1.17 -- manual trigger for the expired-hold sweep, same
      // CRON_SECRET gate as run-reminders (this doesn't message anyone,
      // but it does mutate booking status, so it gets the same care).
      if (path === "/admin/release-holds" && method === "POST") {
        const token = (request.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
        if (!env.CRON_SECRET || token !== env.CRON_SECRET) {
          return err("unauthorized", 401);
        }
        return json(await releaseExpiredHolds(DB));
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
      // v1.12 slot booking routes -- public, storefront-facing, same
      // pattern as the interval routes directly above.
      if (path === "/services" && method === "GET") {
        const siteId = url.searchParams.get("site_id");
        if (!siteId) return err("site_id required");
        const resourceId = url.searchParams.get("resource_id") || null;
        return await listServicesPublic(DB, siteId, resourceId);
      }
      if (path === "/available-slots" && method === "GET") {
        return await availableSlotsHandler(DB, url);
      }
      if (path === "/bookings/slot" && method === "POST") {
        const body = await request.json().catch(function () { return {}; });
        return await createSlotBooking(DB, env, body);
      }
      // v1.17 -- guest-facing deposit payment status poll, no auth (see
      // depositStatus() for why that's safe).
      if (path === "/bookings/deposit-status" && method === "GET") {
        const reference = url.searchParams.get("ref");
        if (!reference) return err("ref required");
        return await depositStatus(env, reference);
      }
      // v1.18 -- guest-facing currency lookup, no auth (see currencyForSite()
      // for why that's safe -- read-only, no secrets).
      if (path === "/bookings/currency" && method === "GET") {
        const siteId = url.searchParams.get("site_id");
        if (!siteId) return err("site_id required");
        return await currencyForSite(env, siteId);
      }
      // v1.17 -- INTERNAL callback from payments-worker, shared-secret
      // gated (not owner-session gated -- there is no owner session on
      // this call path at all).
      if (path === "/deposit-confirmed" && method === "POST") {
        return await handleDepositConfirmed(DB, env, request);
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
      // v1.12 -- service CRUD, mirrors the resources CRUD immediately above.
      if (path === "/services" && method === "POST") {
        const { owner_id } = await verifyOwner(request, env);
        const body = await request.json().catch(function () { return {}; });
        return await createService(DB, owner_id, body);
      }
      const serviceMatch = path.match(/^\/services\/([^/]+)$/);
      if (serviceMatch && method === "PUT") {
        const { owner_id } = await verifyOwner(request, env);
        const body = await request.json().catch(function () { return {}; });
        return await updateService(DB, owner_id, serviceMatch[1], body);
      }
      if (serviceMatch && method === "DELETE") {
        const { owner_id } = await verifyOwner(request, env);
        return await deleteService(DB, owner_id, serviceMatch[1]);
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
      // Owner block-off (v1.16, Basic tier and up) -- maintenance,
      // holidays, staff time off. Two endpoints matching the two booking
      // models: interval (rooms/venues, date-range) and slot
      // (stylists/consultants, whole-day or partial-day). Un-blocking is
      // the existing PUT /bookings/:id/status with status='cancelled',
      // no separate route needed.
      if (path === "/bookings/block-interval" && method === "POST") {
        const { owner_id } = await verifyOwner(request, env);
        const body = await request.json().catch(function () { return {}; });
        return await createIntervalBlock(DB, owner_id, body);
      }
      if (path === "/bookings/block" && method === "POST") {
        const { owner_id } = await verifyOwner(request, env);
        const body = await request.json().catch(function () { return {}; });
        return await createSlotBlock(DB, owner_id, body);
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
      if (path === "/bookings/purchase" && method === "POST") {
        const { owner_id } = await verifyOwner(request, env);
        const body = await request.json().catch(function () { return {}; });
        return await purchaseBookingsAddon(DB, env, owner_id, body);
      }
      if (path === "/bookings/purchase/status" && method === "GET") {
        const { owner_id } = await verifyOwner(request, env);
        const siteId = url.searchParams.get("site_id");
        const reference = url.searchParams.get("ref");
        if (!reference) return err("ref required");
        return await purchaseStatus(DB, env, owner_id, siteId, reference);
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
  //
  // v1.17: also runs releaseExpiredHolds() on the same schedule -- cheap
  // (one UPDATE...WHERE), and doesn't need its own separate cron entry.
  async scheduled(event, env, ctx) {
    ctx.waitUntil(
      runCheckinReminders(env.DB, env).catch(function (e) {
        console.error("Check-in reminder sweep failed:", e && e.message);
      })
    );
    ctx.waitUntil(
      releaseExpiredHolds(env.DB).catch(function (e) {
        console.error("Expired-hold release sweep failed:", e && e.message);
      })
    );
  },
};
