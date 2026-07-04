/**
 * websites.co.zw — Renewal Cron Worker  v2.0
 * -------------------------------------------
 * Single-file Worker. Drives the time-based half of the site lifecycle:
 *
 *   published  ──(expires_at passed)──►  grace
 *   grace      ──(grace window over)──►  suspended
 *
 * Also sends pre-expiry WhatsApp reminders at configurable day thresholds.
 *
 * Changes from v1:
 *   - Notifications use sendContent (free text) not sendFlow — matches auth Worker
 *   - renewal_reminder_stage column is optional; reminders dedup via D1 upsert
 *   - site_name included in queries for personalised messages
 *   - Hardened against missing columns with try/catch per-site
 *
 * ── Bindings ──
 *   DB                   D1 database (websites-cozw)
 *
 * ── Secrets ──
 *   CRON_SECRET          Bearer token for manual /run endpoint
 *   MANYCHAT_API_TOKEN   WhatsApp notification (optional — silent if missing)
 *
 * ── Vars ──
 *   GRACE_DAYS           Grace period in days (default: 14)
 *   REMINDERS_ENABLED    Set to "1" to enable pre-expiry reminders
 *   REMINDER_DAYS        CSV of day thresholds (default: "14,7,1")
 *
 * ── D1 migration (run once before deploying) ──
 *   ALTER TABLE sites ADD COLUMN renewal_reminder_stage INTEGER;
 *
 * ── wrangler.toml cron schedule ──
 *   [triggers]
 *   crons = ["0 3 * * *"]   # runs at 3am UTC every day
 */

const GRACE_DAYS_DEFAULT   = 14;
const REMINDER_DAYS_DEFAULT = [14, 7, 1];

export default {
  // ── Cron trigger ─────────────────────────────────────────────────────────
  async scheduled(event, env, ctx) {
    ctx.waitUntil(
      runRenewalSweep(env, { trigger: "cron" }).catch((err) => {
        console.error("renewal sweep failed:", err?.stack || err);
      })
    );
  },

  // ── Manual trigger for testing ────────────────────────────────────────────
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/health")
      return json({ ok: true, service: "websites-cozw-renewal-cron", version: "2.0" });

    if (url.pathname === "/run") {
      const token = (request.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
      if (!env.CRON_SECRET || token !== env.CRON_SECRET)
        return json({ error: "unauthorized" }, 401);
      const dryRun = url.searchParams.get("dry") === "1";
      const result = await runRenewalSweep(env, { trigger: "manual", dryRun });
      return json(result);
    }

    return json({ error: "not_found" }, 404);
  },
};

// ─── MAIN SWEEP ───────────────────────────────────────────────────────────────

async function runRenewalSweep(env, opts = {}) {
  const now         = nowSec();
  const graceDays   = clampInt(env.GRACE_DAYS, GRACE_DAYS_DEFAULT, 0, 365);
  const graceWindow = graceDays * 86400;
  const dryRun      = !!opts.dryRun;

  const summary = {
    now,
    now_human:        new Date(now * 1000).toISOString(),
    trigger:          opts.trigger || "unknown",
    dryRun,
    graceDays,
    expiredToGrace:   0,
    graceToSuspended: 0,
    remindersSent:    0,
    notified:         0,
    errors:           [],
  };

  try {
    // ── 1) published → grace ─────────────────────────────────────────────────
    // Any published site whose expires_at is in the past moves to grace.
    // The UPDATE is guarded by status='published' so it's idempotent.
    const expiring = await querySites(env,
      "status='published' AND expires_at IS NOT NULL AND expires_at <= ?1",
      [now]
    );

    if (expiring.length && !dryRun) {
      await env.DB.prepare(
        "UPDATE sites SET status='grace', updated_at=unixepoch() " +
        "WHERE status='published' AND expires_at IS NOT NULL AND expires_at <= ?1"
      ).bind(now).run();
    }

    summary.expiredToGrace = expiring.length;
    for (const site of expiring) {
      summary.notified += await notifyWhatsApp(env, site, "grace_started", { graceDays }, dryRun);
    }

    // ── 2) grace → suspended ─────────────────────────────────────────────────
    // Once grace window has elapsed (expires_at + graceWindow < now), suspend.
    const cutoff = now - graceWindow;
    const gracing = await querySites(env,
      "status='grace' AND expires_at IS NOT NULL AND expires_at <= ?1",
      [cutoff]
    );

    if (gracing.length && !dryRun) {
      await env.DB.prepare(
        "UPDATE sites SET status='suspended', updated_at=unixepoch() " +
        "WHERE status='grace' AND expires_at IS NOT NULL AND expires_at <= ?1"
      ).bind(cutoff).run();
    }

    summary.graceToSuspended = gracing.length;
    for (const site of gracing) {
      summary.notified += await notifyWhatsApp(env, site, "suspended", {}, dryRun);
    }

    // ── 3) Pre-expiry renewal reminders ──────────────────────────────────────
    if (env.REMINDERS_ENABLED === "1") {
      summary.remindersSent = await sendRenewalReminders(env, now, dryRun);
      summary.notified += summary.remindersSent;
    }

  } catch (err) {
    const msg = err?.message || String(err);
    summary.errors.push(msg);
    console.error("sweep error:", msg);
  }

  console.log("renewal sweep complete:", JSON.stringify(summary));
  return summary;
}

// ─── RENEWAL REMINDERS ────────────────────────────────────────────────────────

async function sendRenewalReminders(env, now, dryRun) {
  const thresholds = parseReminderDays(env.REMINDER_DAYS); // descending e.g. [14,7,1]
  const maxDays    = thresholds[0];
  const horizon    = now + maxDays * 86400;

  // Sites still published, inside the reminder window, not yet expired
  const sites = await querySites(env,
    "status='published' AND expires_at > ?1 AND expires_at <= ?2",
    [now, horizon]
  );

  let sent = 0;
  for (const site of sites) {
    try {
      const daysLeft = Math.ceil((site.expires_at - now) / 86400);
      // Which threshold has this site just crossed? Take the smallest (most urgent).
      const crossed = thresholds.filter(t => daysLeft <= t);
      if (!crossed.length) continue;
      const dueStage = Math.min(...crossed);

      // Check if we already sent this stage (or a more urgent one)
      // renewal_reminder_stage column may not exist — handle gracefully
      let lastStage = null;
      try {
        const row = await env.DB.prepare(
          "SELECT renewal_reminder_stage FROM sites WHERE id=?1"
        ).bind(site.id).first();
        lastStage = row?.renewal_reminder_stage ?? null;
      } catch { /* column not migrated yet — skip dedup, send anyway */ }

      const alreadySent = lastStage !== null && Number(lastStage) <= dueStage;
      if (alreadySent) continue;

      if (!dryRun) {
        // Record stage so we don't send it again
        try {
          await env.DB.prepare(
            "UPDATE sites SET renewal_reminder_stage=?2, updated_at=unixepoch() WHERE id=?1"
          ).bind(site.id, dueStage).run();
        } catch { /* column not migrated — skip */ }

        sent += await notifyWhatsApp(env, site, "renewal_reminder", { daysLeft, dueStage }, false);
      } else {
        sent++; // count as would-send in dry run
      }
    } catch (err) {
      console.error("reminder error for site", site.id, err?.message);
    }
  }

  return sent;
}

// ─── WHATSAPP NOTIFICATION ────────────────────────────────────────────────────
// Uses sendContent (free text) — same pattern as the auth Worker.
// Never throws, never blocks a lifecycle transition.

async function notifyWhatsApp(env, site, event, extra, dryRun) {
  try {
    if (dryRun || !env.MANYCHAT_API_TOKEN) return 0;

    // Resolve owner phone
    const owner = await env.DB.prepare(
      "SELECT phone FROM owners WHERE id=?1"
    ).bind(site.owner_id).first().catch(() => null);
    if (!owner?.phone) return 0;

    const phone = normalizePhone(owner.phone);
    if (!phone) return 0;

    const text = buildMessage(event, site, extra);
    if (!text) return 0;

    // Find ManyChat subscriber
    const findResp = await fetch(
      "https://api.manychat.com/fb/subscriber/findBySystemField?phone=" +
        encodeURIComponent(phone),
      { headers: { Authorization: "Bearer " + env.MANYCHAT_API_TOKEN } }
    );
    const found = await findResp.json().catch(() => ({}));
    const subId = found?.data?.id;
    if (!subId) return 0;

    // Send message
    const r = await fetch("https://api.manychat.com/fb/sending/sendContent", {
      method: "POST",
      headers: {
        Authorization:  "Bearer " + env.MANYCHAT_API_TOKEN,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        subscriber_id: subId,
        data: {
          version: "v2",
          content: {
            messages: [{ type: "text", text }],
          },
        },
      }),
    });

    return r.ok ? 1 : 0;
  } catch (err) {
    console.error("notifyWhatsApp failed (non-fatal):", event, err?.message);
    return 0;
  }
}

// ─── MESSAGE COPY ─────────────────────────────────────────────────────────────

function buildMessage(event, site, extra) {
  const name    = site.site_name || "your website";
  const slug    = site.draft_subdomain || "";
  const url     = slug ? `https://${slug}.websites.co.zw` : "your website";
  const renewUrl = "https://app.websites.co.zw/dashboard/customer.html";

  switch (event) {
    case "grace_started":
      return (
        `⚠️ Your websites.co.zw subscription for *${name}* has expired.\n\n` +
        `Your site is still live for the next *${extra.graceDays} days* while you renew.\n\n` +
        `👉 Renew now to keep it online: ${renewUrl}\n\n` +
        `After ${extra.graceDays} days without renewal your site will go offline.`
      );

    case "suspended":
      return (
        `🔴 *${name}* is now offline.\n\n` +
        `Your grace period has ended and your site has been suspended.\n\n` +
        `To bring it back online, renew your subscription at:\n${renewUrl}\n\n` +
        `Your content is safe — renew any time to restore your site immediately.`
      );

    case "renewal_reminder":
      return (
        `💡 Reminder: your websites.co.zw subscription for *${name}* expires in ` +
        `*${extra.daysLeft} day${extra.daysLeft === 1 ? "" : "s"}*.\n\n` +
        `Renew now to keep your site live: ${renewUrl}`
      );

    default:
      return null;
  }
}

// ─── DB HELPER ────────────────────────────────────────────────────────────────

async function querySites(env, where, params) {
  const res = await env.DB.prepare(
    `SELECT id, owner_id, site_name, status, expires_at, draft_subdomain
     FROM sites WHERE ${where}`
  ).bind(...params).all();
  return res?.results || [];
}

// ─── HELPERS ──────────────────────────────────────────────────────────────────

function nowSec() { return Math.floor(Date.now() / 1000); }

function clampInt(v, dflt, min, max) {
  const n = parseInt(v, 10);
  return Number.isNaN(n) ? dflt : Math.min(max, Math.max(min, n));
}

function parseReminderDays(csv) {
  if (!csv) return REMINDER_DAYS_DEFAULT.slice();
  const days = String(csv).split(",")
    .map(s => parseInt(s.trim(), 10))
    .filter(n => Number.isInteger(n) && n > 0);
  return days.length ? days.sort((a, b) => b - a) : REMINDER_DAYS_DEFAULT.slice();
}

function normalizePhone(raw) {
  const p = String(raw || "").replace(/[^\d]/g, "");
  if (!p || p.length < 7) return null;
  if (p.startsWith("263") && p.length >= 12) return p;
  if (p.startsWith("0") && p.length >= 10)   return "263" + p.slice(1);
  if (p.length === 9 && (p.startsWith("7") || p.startsWith("8"))) return "263" + p;
  return p;
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj, null, 2), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}