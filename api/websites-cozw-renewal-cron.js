/**
 * websites.co.zw — Renewal Cron Worker
 * -------------------------------------
 * Single-file Worker (no imports). Drives the time-based half of the site
 * lifecycle state machine:
 *
 *      published  --(expires_at passed)-->        grace
 *      grace      --(grace window passed)-->      suspended
 *
 * The render Worker still computes effectiveStatus() on the fly, but this cron
 * MATERIALISES the status column so the dashboard, owner reports and any
 * status-filtered queries stay accurate, and so that owner notifications fire
 * exactly once per transition.
 *
 * It also (optionally) sends pre-expiry renewal reminders to nudge owners to
 * pay before they lapse.
 *
 * ── Conventions assumed (adjust to match your live schema) ──
 *   • D1 binding name:            env.DB           (rename if your render Worker uses another)
 *   • Table:                      sites
 *   • Columns used (core):        id, owner_id, status, expires_at
 *   • Timestamps:                 INTEGER epoch SECONDS (matches effectiveStatus())
 *   • Status values:              draft | pending_payment | published | grace | suspended
 *
 * ── Env vars / secrets ──
 *   CRON_SECRET          required to call POST/GET /run manually (Bearer token)
 *   GRACE_DAYS           optional, default 14
 *   REMINDERS_ENABLED    optional "1" to turn on pre-expiry reminders
 *                        (requires the renewal_reminder_stage column — see migration below)
 *   REMINDER_DAYS        optional CSV of day thresholds, default "14,7,1"
 *   MANYCHAT_API_TOKEN   optional — if set, owner notifications are attempted
 *   MANYCHAT_FLOW_*      optional flow ids per event (see notifyOwner)
 *
 * ── Optional migration (only needed if REMINDERS_ENABLED) ──
 *   ALTER TABLE sites ADD COLUMN renewal_reminder_stage INTEGER;
 */

const GRACE_DAYS_DEFAULT = 14;
const REMINDER_DAYS_DEFAULT = [14, 7, 1];

export default {
  // Cloudflare Cron Trigger entry point. Configure schedule in wrangler.toml.
  async scheduled(event, env, ctx) {
    ctx.waitUntil(
      runRenewalSweep(env, { trigger: "cron" }).catch((err) => {
        console.error("renewal sweep failed", err && err.stack ? err.stack : err);
      })
    );
  },

  // Manual trigger + health, for testing without waiting on the schedule.
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      return json({ ok: true, service: "websites-cozw-renewal-cron" });
    }

    if (url.pathname === "/run") {
      const token = (request.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
      if (!env.CRON_SECRET || token !== env.CRON_SECRET) {
        return json({ error: "unauthorized" }, 401);
      }
      // /run?dry=1 reports what WOULD change without writing.
      const dryRun = url.searchParams.get("dry") === "1";
      const result = await runRenewalSweep(env, { trigger: "manual", dryRun });
      return json(result);
    }

    return json({ error: "not_found" }, 404);
  },
};

/**
 * One full pass. Each transition uses a conditional UPDATE guarded by the
 * source status, so it is naturally idempotent: a row that has already moved
 * on will not match next time, which means an owner is never notified twice
 * for the same transition.
 */
async function runRenewalSweep(env, opts = {}) {
  const now = nowSeconds();
  const graceDays = clampInt(env.GRACE_DAYS, GRACE_DAYS_DEFAULT, 0, 365);
  const graceSeconds = graceDays * 86400;
  const dryRun = !!opts.dryRun;

  const summary = {
    now,
    trigger: opts.trigger || "unknown",
    dryRun,
    graceDays,
    expiredToGrace: 0,
    graceToSuspended: 0,
    remindersSent: 0,
    notified: 0,
    errors: [],
  };

  try {
    // ── 1) published → grace  (expiry reached) ──────────────────────────────
    {
      const due = await selectSites(
        env,
        "status = 'published' AND expires_at <= ?",
        [now]
      );
      if (due.length && !dryRun) {
        await env.DB
          .prepare("UPDATE sites SET status = 'grace' WHERE status = 'published' AND expires_at <= ?")
          .bind(now)
          .run();
      }
      summary.expiredToGrace = due.length;
      for (const site of due) {
        summary.notified += await notifyOwner(env, site, "grace_started", { graceDays }, dryRun);
      }
    }

    // ── 2) grace → suspended  (grace window elapsed) ────────────────────────
    {
      const cutoff = now - graceSeconds; // expires_at older than this => grace window is over
      const due = await selectSites(
        env,
        "status = 'grace' AND expires_at <= ?",
        [cutoff]
      );
      if (due.length && !dryRun) {
        await env.DB
          .prepare("UPDATE sites SET status = 'suspended' WHERE status = 'grace' AND expires_at <= ?")
          .bind(cutoff)
          .run();
      }
      summary.graceToSuspended = due.length;
      for (const site of due) {
        summary.notified += await notifyOwner(env, site, "suspended", {}, dryRun);
      }
    }

    // ── 3) pre-expiry renewal reminders (optional) ──────────────────────────
    if (truthy(env.REMINDERS_ENABLED)) {
      summary.remindersSent = await sendReminders(env, now, dryRun, summary);
    }
  } catch (err) {
    summary.errors.push(String(err && err.message ? err.message : err));
  }

  return summary;
}

/**
 * Sends a reminder when a published site crosses a configured day-threshold
 * before expiry. Dedup is handled by renewal_reminder_stage, which records the
 * most-urgent threshold already sent. A reminder fires only when the currently
 * due stage is MORE urgent (a smaller day number) than the last one sent.
 */
async function sendReminders(env, now, dryRun, summary) {
  const thresholds = parseReminderDays(env.REMINDER_DAYS); // descending, e.g. [14,7,1]
  const maxDays = thresholds[0];
  const horizon = now + maxDays * 86400;

  // Only sites still published and inside the reminder window, not yet expired.
  const rows = await selectSites(
    env,
    "status = 'published' AND expires_at > ? AND expires_at <= ?",
    [now, horizon],
    "id, owner_id, expires_at, renewal_reminder_stage"
  );

  let sent = 0;
  for (const site of rows) {
    const daysLeft = Math.ceil((site.expires_at - now) / 86400);
    // Most-urgent (smallest) threshold the site has crossed. e.g. 7 days left,
    // thresholds [14,7,1] -> crossed {14,7}, due stage = 7. find() on a
    // descending list would wrongly return 14, so take the min of the matches.
    const crossed = thresholds.filter((t) => daysLeft <= t);
    if (!crossed.length) continue;
    const dueStage = Math.min(...crossed);

    const last = site.renewal_reminder_stage;
    const alreadyCovered = last !== null && last !== undefined && Number(last) <= dueStage;
    if (alreadyCovered) continue;

    if (!dryRun) {
      await env.DB
        .prepare("UPDATE sites SET renewal_reminder_stage = ? WHERE id = ?")
        .bind(dueStage, site.id)
        .run();
    }
    summary.notified += await notifyOwner(env, site, "renewal_reminder", { daysLeft }, dryRun);
    sent++;
  }
  return sent;
}

/**
 * Owner notification hook — fully non-fatal, never throws, never blocks the
 * lifecycle transition (same pattern as the Zvakho payments worker).
 *
 * TODO: confirm where the owner contact lives. This assumes an `owners` table
 * with a `phone` column in international format WITHOUT the leading '+'. Adjust
 * the lookup and the ManyChat flow ids to your setup, or swap this body for
 * email / a queue push.
 */
async function notifyOwner(env, site, kind, extra = {}, dryRun = false) {
  try {
    if (dryRun) return 0;
    if (!env.MANYCHAT_API_TOKEN) return 0; // notifications disabled

    const flowId = pickFlow(env, kind);
    if (!flowId) return 0;

    // Resolve owner phone. Guarded: if the table/column differs this just no-ops.
    let phone = null;
    try {
      const owner = await env.DB
        .prepare("SELECT phone FROM owners WHERE id = ?")
        .bind(site.owner_id)
        .first();
      phone = owner && owner.phone ? normalizeZwPhone(owner.phone) : null;
    } catch (_) {
      return 0; // owners table/column not as assumed — skip silently
    }
    if (!phone) return 0;

    // Find ManyChat subscriber by phone, then trigger the flow.
    const findRes = await fetch(
      "https://api.manychat.com/fb/subscriber/findBySystemField?phone=" + encodeURIComponent(phone),
      { headers: { Authorization: "Bearer " + env.MANYCHAT_API_TOKEN } }
    );
    const found = await safeJson(findRes);
    const subscriberId = found && found.data && found.data.id;
    if (!subscriberId) return 0;

    await fetch("https://api.manychat.com/fb/sending/sendFlow", {
      method: "POST",
      headers: {
        Authorization: "Bearer " + env.MANYCHAT_API_TOKEN,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ subscriber_id: subscriberId, flow_ns: flowId }),
    });
    return 1;
  } catch (err) {
    console.error("notifyOwner failed (non-fatal)", kind, err && err.message);
    return 0;
  }
}

function pickFlow(env, kind) {
  switch (kind) {
    case "renewal_reminder": return env.MANYCHAT_FLOW_REMINDER || null;
    case "grace_started":    return env.MANYCHAT_FLOW_GRACE || null;
    case "suspended":        return env.MANYCHAT_FLOW_SUSPENDED || null;
    default:                 return null;
  }
}

/* ── helpers ─────────────────────────────────────────────────────────────── */

async function selectSites(env, where, params, cols = "id, owner_id, status, expires_at") {
  const res = await env.DB.prepare(`SELECT ${cols} FROM sites WHERE ${where}`).bind(...params).all();
  return (res && res.results) || [];
}

function nowSeconds() {
  return Math.floor(Date.now() / 1000);
}

/**
 * Normalise a Zimbabwe phone number to international format (no '+'), as
 * ManyChat's findBySystemField expects. Handles the three common ways an
 * owner row might be stored:
 *   "+263 77 212 3456" / "263772123456" -> 263772123456  (already international)
 *   "0772123456"                        -> 263772123456  (local, leading 0)
 *   "772123456"                         -> 263772123456  (missing leading 0)
 * Anything else falls back to a digits-only string.
 */
function normalizeZwPhone(raw) {
  const p = String(raw || "").replace(/[^0-9]/g, "");
  if (!p) return null;
  if (p.startsWith("263")) return p;
  if (p.startsWith("0")) return "263" + p.slice(1);
  if (p.length === 9 && p.startsWith("7")) return "263" + p;
  return p;
}

function clampInt(v, dflt, min, max) {
  const n = parseInt(v, 10);
  if (Number.isNaN(n)) return dflt;
  return Math.min(max, Math.max(min, n));
}

function truthy(v) {
  return v === "1" || v === 1 || v === true || v === "true";
}

function parseReminderDays(csv) {
  if (!csv) return REMINDER_DAYS_DEFAULT.slice();
  const days = String(csv)
    .split(",")
    .map((s) => parseInt(s.trim(), 10))
    .filter((n) => Number.isInteger(n) && n > 0);
  if (!days.length) return REMINDER_DAYS_DEFAULT.slice();
  return days.sort((a, b) => b - a); // descending
}

async function safeJson(res) {
  try { return await res.json(); } catch (_) { return null; }
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj, null, 2), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}