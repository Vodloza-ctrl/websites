/**
 * websites.co.zw — Renewal Cron Worker  v2.2
 * -------------------------------------------
 * Single-file Worker. Drives the time-based half of two lifecycles:
 *
 *   SITES (annual):   published ──(expires_at passed)──► grace ──(grace window over)──► suspended
 *   ADDONS (monthly): active    ──(expires_at passed)──► grace ──(grace window over)──► suspended
 *
 * Also sends pre-expiry WhatsApp reminders at configurable day thresholds (sites only, for now).
 *
 * v2.2 CHANGE — CACHE PURGE ON EVERY STATUS TRANSITION:
 *   Found via the same repo-wide cache-purge audit that fixed
 *   websites-products-worker.js and payments.js's confirmStorePurchasePaid().
 *   render.js's Cache-Control logic only special-cases 'grace' status as
 *   no-store -- 'suspended' falls through to the normal 'public,
 *   max-age=300, stale-while-revalidate=3600' branch. Combined with this
 *   worker never purging the CDN cache when it flips a site's status, the
 *   practical effect was: a site whose subscription lapsed and got moved
 *   published -> grace -> suspended could keep serving its OLD cached
 *   fully-live page for up to an hour after suspension, even though a
 *   fresh render would correctly reflect the new status. Same risk for
 *   addon status flips (active -> grace -> suspended) -- a suspended
 *   Store Payments/Bookings addon wouldn't immediately stop showing that
 *   feature on the public page either. Fixed: purgeSiteCache() (mirrors
 *   auth.js/payments.js/websites-products-worker.js's existing pattern)
 *   is now called for every site that transitions expiredToGrace or
 *   graceToSuspended, and for the site behind every addon that does the
 *   same. Skipped entirely in dryRun mode, same as every other DB write
 *   in this sweep.
 *
 * Changes from v2.0:
 *   - NEW: addons sweep (active → grace → suspended), mirroring the sites sweep.
 *     Required because gating (getBookingsTier() etc.) reads addons.status directly
 *     and nothing was ever flipping it after expires_at passed -- addon purchases
 *     billed correctly once and then granted access forever.
 *   - addons.expires_at IS NULL is treated as a PERMANENT grant and is never swept
 *     (e.g. Iris Hotel's free Bookings Pro grant). Run the one-time migration to
 *     mark existing permanent grants as NULL before enabling this -- see
 *     migration-addons-expiry-normalize.sql.
 *   - Separate, shorter grace window for addons (ADDON_GRACE_DAYS, default 5) --
 *     monthly billing shouldn't get the same 14-day runway as an annual site plan.
 *   - Addon sweep requires expires_at to already be an epoch INTEGER (unixepoch()),
 *     not a date() TEXT string -- see confirmPaidAddon() patch in payments-worker.js.
 *     Rows still holding the old TEXT format are silently skipped (a WHERE clause
 *     on a numeric comparison against TEXT never matches in SQLite), not
 *     mis-suspended -- but they also won't get downgraded until migrated.
 *
 * ── Bindings ──
 *   DB                   D1 database (websites-cozw)
 *
 * ── Secrets ──
 *   CRON_SECRET          Bearer token for manual /run endpoint
 *   MANYCHAT_API_TOKEN   WhatsApp notification (optional — silent if missing)
 *   RESEND_API_KEY       Trial reminder/expiry emails (optional — silent if missing).
 *                         WhatsApp Business API isn't live yet, so trial
 *                         notifications go through email instead — this secret
 *                         must be set on THIS Worker specifically, separate
 *                         from websites-cozw-auth's own copy of the same key.
 *
 * ── Vars ──
 *   GRACE_DAYS           Site grace period in days (default: 14)
 *   ADDON_GRACE_DAYS     Addon grace period in days (default: 5)
 *   REMINDERS_ENABLED    Set to "1" to enable pre-expiry reminders (sites only)
 *   REMINDER_DAYS        CSV of day thresholds (default: "14,7,1")
 *
 * ── D1 migration (run once before deploying) ──
 *   ALTER TABLE sites ADD COLUMN renewal_reminder_stage INTEGER;
 *   -- plus migration-addons-expiry-normalize.sql (converts existing TEXT
 *   -- expires_at/activated_at to epoch INTEGER, marks true permanent
 *   -- grants as NULL) -- run BEFORE deploying this version.
 *
 * ── wrangler.toml cron schedule ──
 *   [triggers]
 *   crons = ["0 3 * * *"]   # runs at 3am UTC every day
 */

const GRACE_DAYS_DEFAULT       = 14;
const ADDON_GRACE_DAYS_DEFAULT = 5;
const REMINDER_DAYS_DEFAULT    = [14, 7, 1];

const ADDON_DISPLAY_NAME = {
  whatsapp_store: "WhatsApp Store",
  bookings:       "Bookings",
  template:       "your premium template",
  promotions:     "Promotions",
  analytics:      "Analytics",
};

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
      return json({ ok: true, service: "websites-cozw-renewal-cron", version: "2.2" });

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

// ─── CACHE PURGE (v2.2) ──────────────────────────────────────────────────────
// Mirrors auth.js / payments.js / websites-products-worker.js's existing
// pattern exactly, so the same site's cache gets invalidated the same way
// regardless of which worker triggered the change. Non-fatal by design --
// a purge failure must never abort or roll back the status transition
// itself, same reasoning as every other best-effort side-effect on this
// platform.
async function purgeSiteCache(env, draftSubdomain, customDomain, customDomainStatus) {
  try {
    if (draftSubdomain) {
      await caches.default.delete(new Request(`https://${draftSubdomain}.websites.co.zw/`));
    }
    if (customDomain && customDomainStatus === "active") {
      await caches.default.delete(new Request(`https://${customDomain}/`));
    }
  } catch (e) {
    console.error("purgeSiteCache failed:", e?.message);
  }
}

async function purgeSiteCacheById(env, siteId) {
  try {
    const site = await env.DB.prepare(
      "SELECT draft_subdomain, custom_domain, custom_domain_status FROM sites WHERE id=?1"
    ).bind(siteId).first();
    if (!site) return;
    await purgeSiteCache(env, site.draft_subdomain, site.custom_domain, site.custom_domain_status);
  } catch (e) {
    console.error("purgeSiteCacheById failed for site", siteId, e?.message);
  }
}

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
    trialsExpired:    0,
    trialRemindersSent: 0,
    expiredToGrace:   0,
    graceToSuspended: 0,
    remindersSent:    0,
    addonsExpiredToGrace:   0,
    addonsGraceToSuspended: 0,
    notified:         0,
    cachePurged:      0,
    errors:           [],
  };

  try {
    // ── 0) TRIAL sites: published (trial) → draft, no grace ──────────────────
    // Free trial sites skip the grace/suspended pipeline entirely -- that
    // pipeline exists to soften a billing lapse, and a trial was never
    // billed. Straight back to draft (still fully editable, just not
    // live) the moment the trial window closes. A short pre-expiry
    // WhatsApp nudge fires separately below, mirroring the paid-site
    // reminder pattern but with trial-specific copy.
    const TRIAL_REMINDER_DAYS = 3;
    const trialsExpiring = await querySites(env,
      "status='published' AND plan='trial' AND expires_at IS NOT NULL AND expires_at <= ?1",
      [now]
    );
    if (trialsExpiring.length && !dryRun) {
      await env.DB.prepare(
        "UPDATE sites SET status='draft', updated_at=unixepoch() " +
        "WHERE status='published' AND plan='trial' AND expires_at IS NOT NULL AND expires_at <= ?1"
      ).bind(now).run();
    }
    summary.trialsExpired = trialsExpiring.length;
    for (const site of trialsExpiring) {
      summary.notified += await notifyTrialEmail(env, site, "trial_ended", {}, dryRun);
      if (!dryRun) {
        await purgeSiteCache(env, site.draft_subdomain, site.custom_domain, site.custom_domain_status);
        summary.cachePurged++;
      }
    }

    const trialReminderHorizon = now + TRIAL_REMINDER_DAYS * 86400;
    const trialsReminding = await querySites(env,
      "status='published' AND plan='trial' AND expires_at IS NOT NULL " +
      "AND expires_at > ?1 AND expires_at <= ?2 AND (renewal_reminder_stage IS NULL OR renewal_reminder_stage != -1)",
      [now, trialReminderHorizon]
    );
    summary.trialRemindersSent = 0;
    for (const site of trialsReminding) {
      const daysLeft = Math.max(1, Math.ceil((site.expires_at - now) / 86400));
      const sent = await notifyTrialEmail(env, site, "trial_reminder", { daysLeft }, dryRun);
      summary.trialRemindersSent += sent;
      summary.notified += sent;
      if (sent && !dryRun) {
        // Reuses the same dedup column paid-site reminders use -- safe
        // because a site is never plan='trial' and mid paid-reminder-cycle
        // at the same time, so there's no collision between the two
        // meanings. -1 is a sentinel meaning "trial reminder already sent",
        // distinct from the numeric day-threshold values paid reminders use.
        await env.DB.prepare(
          "UPDATE sites SET renewal_reminder_stage=-1, updated_at=unixepoch() WHERE id=?1"
        ).bind(site.id).run().catch(() => {});
      }
    }
  } catch (err) {
    const msg = err?.message || String(err);
    summary.errors.push("trial sweep: " + msg);
    console.error("trial sweep error:", msg);
  }

  try {
    // ── 1) published → grace ─────────────────────────────────────────────────
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
      if (!dryRun) {
        await purgeSiteCache(env, site.draft_subdomain, site.custom_domain, site.custom_domain_status);
        summary.cachePurged++;
      }
    }

    // ── 2) grace → suspended ─────────────────────────────────────────────────
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
      if (!dryRun) {
        await purgeSiteCache(env, site.draft_subdomain, site.custom_domain, site.custom_domain_status);
        summary.cachePurged++;
      }
    }

    // ── 3) Pre-expiry renewal reminders (sites) ──────────────────────────────
    if (env.REMINDERS_ENABLED === "1") {
      summary.remindersSent = await sendRenewalReminders(env, now, dryRun);
      summary.notified += summary.remindersSent;
    }

    // ── 4) ADDONS: active → grace → suspended ────────────────────────────────
    // NULL expires_at = permanent grant, never swept (Iris Hotel etc.).
    // Only touches rows where expires_at is a real epoch INTEGER -- rows still
    // in the old date()-TEXT format are silently skipped by the numeric
    // comparison, not mis-suspended. Run the migration to fix those first.
    const addonGraceDays   = clampInt(env.ADDON_GRACE_DAYS, ADDON_GRACE_DAYS_DEFAULT, 0, 90);
    const addonGraceWindow = addonGraceDays * 86400;

    // price_usd > 0 is a second, independent guard alongside expires_at IS NOT
    // NULL -- a $0 row is a grant by definition (real purchases always carry
    // a real ADDON_USD_PRICE), so it's excluded here even if expires_at was
    // ever accidentally left non-NULL on one.
    const addonsExpiring = await queryAddons(env,
      "a.status='active' AND a.price_usd > 0 AND a.expires_at IS NOT NULL AND a.expires_at <= ?1",
      [now]
    );
    if (addonsExpiring.length && !dryRun) {
      await env.DB.prepare(
        "UPDATE addons SET status='grace', updated_at=unixepoch() " +
        "WHERE status='active' AND price_usd > 0 AND expires_at IS NOT NULL AND expires_at <= ?1"
      ).bind(now).run();
    }
    summary.addonsExpiredToGrace = addonsExpiring.length;
    for (const addon of addonsExpiring) {
      summary.notified += await notifyAddonWhatsApp(env, addon, "addon_grace_started", { graceDays: addonGraceDays }, dryRun);
      if (!dryRun) {
        await purgeSiteCacheById(env, addon.site_id);
        summary.cachePurged++;
      }
    }

    const addonCutoff = now - addonGraceWindow;
    const addonsGracing = await queryAddons(env,
      "a.status='grace' AND a.price_usd > 0 AND a.expires_at IS NOT NULL AND a.expires_at <= ?1",
      [addonCutoff]
    );
    if (addonsGracing.length && !dryRun) {
      await env.DB.prepare(
        "UPDATE addons SET status='suspended', updated_at=unixepoch() " +
        "WHERE status='grace' AND price_usd > 0 AND expires_at IS NOT NULL AND expires_at <= ?1"
      ).bind(addonCutoff).run();
    }
    summary.addonsGraceToSuspended = addonsGracing.length;
    for (const addon of addonsGracing) {
      summary.notified += await notifyAddonWhatsApp(env, addon, "addon_suspended", {}, dryRun);
      if (!dryRun) {
        await purgeSiteCacheById(env, addon.site_id);
        summary.cachePurged++;
      }
    }

  } catch (err) {
    const msg = err?.message || String(err);
    summary.errors.push(msg);
    console.error("sweep error:", msg);
  }

  console.log("renewal sweep complete:", JSON.stringify(summary));
  return summary;
}

// ─── RENEWAL REMINDERS (sites) ─────────────────────────────────────────────────

async function sendRenewalReminders(env, now, dryRun) {
  const thresholds = parseReminderDays(env.REMINDER_DAYS);
  const maxDays    = thresholds[0];
  const horizon    = now + maxDays * 86400;

  const sites = await querySites(env,
    "status='published' AND expires_at > ?1 AND expires_at <= ?2",
    [now, horizon]
  );

  let sent = 0;
  for (const site of sites) {
    try {
      const daysLeft = Math.ceil((site.expires_at - now) / 86400);
      const crossed = thresholds.filter(t => daysLeft <= t);
      if (!crossed.length) continue;
      const dueStage = Math.min(...crossed);

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
        try {
          await env.DB.prepare(
            "UPDATE sites SET renewal_reminder_stage=?2, updated_at=unixepoch() WHERE id=?1"
          ).bind(site.id, dueStage).run();
        } catch { /* column not migrated — skip */ }

        sent += await notifyWhatsApp(env, site, "renewal_reminder", { daysLeft, dueStage }, false);
      } else {
        sent++;
      }
    } catch (err) {
      console.error("reminder error for site", site.id, err?.message);
    }
  }

  return sent;
}

// ─── WHATSAPP NOTIFICATION (sites) ──────────────────────────────────────────────

// ─── EMAIL NOTIFICATION (trial-specific) ────────────────────────────────────
// WhatsApp Business API isn't live yet (Meta approval pending, per Lenni
// directly) -- notifyWhatsApp() above would either no-op (no
// MANYCHAT_API_TOKEN) or silently fail (token set but the WhatsApp channel
// itself not actually working), meaning trial reminders built to go
// through it would never actually reach anyone. Trial notifications go
// through Resend instead -- same API, same env var name, same request
// shape as sendEmail() in websites-cozw-auth.js, so this is proven,
// already-working infrastructure, not a new integration.
//
// Deliberately scoped to trial events only, not a wholesale swap of the
// paid-site grace/suspended notifications above -- those already exist,
// already work as WhatsApp-only, and changing them wasn't asked for.
//
// REQUIRES: RESEND_API_KEY secret set on THIS Worker (websites-cozw-
// renewal-cron) specifically -- it's a separate Worker from websites-cozw-
// auth, so having it configured there does not carry over here.
async function notifyTrialEmail(env, site, event, extra, dryRun) {
  try {
    if (dryRun || !env.RESEND_API_KEY) return 0;

    const owner = await env.DB.prepare(
      "SELECT email FROM owners WHERE id=?1"
    ).bind(site.owner_id).first().catch(() => null);
    if (!owner?.email) return 0;

    const { subject, html } = buildTrialEmail(event, site, extra);
    if (!subject) return 0;

    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: "Bearer " + env.RESEND_API_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: env.RESEND_FROM || "noreply@mail.websites.co.zw",
        to: [owner.email],
        subject,
        html,
      }),
    });
    return r.ok ? 1 : 0;
  } catch (err) {
    console.error("notifyTrialEmail failed (non-fatal):", event, err?.message);
    return 0;
  }
}

function buildTrialEmail(event, site, extra) {
  const name = site.site_name || "your website";
  const siteUrl = site.draft_subdomain ? `https://${site.draft_subdomain}.websites.co.zw` : "";
  const upgradeUrl = "https://app.websites.co.zw/dashboard/customer.html";
  const wrap = (heading, body, ctaLabel) => `
<div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:40px 24px">
  <h2 style="font-size:22px;margin:0 0 12px;color:#0c0e13">${heading}</h2>
  <p style="color:#3d4251;line-height:1.6;margin:0 0 24px">${body}</p>
  <a href="${upgradeUrl}" style="display:inline-block;background:#15924B;color:#fff;font-weight:700;padding:13px 24px;border-radius:11px;text-decoration:none">${ctaLabel}</a>
  ${siteUrl ? `<p style="color:#767c8c;font-size:13px;margin:24px 0 0">Your site: <a href="${siteUrl}" style="color:#767c8c">${siteUrl.replace('https://','')}</a></p>` : ""}
</div>`;

  switch (event) {
    case "trial_reminder":
      return {
        subject: `Your free trial for ${name} ends in ${extra.daysLeft} day${extra.daysLeft === 1 ? "" : "s"}`,
        html: wrap(
          `⏳ ${extra.daysLeft} day${extra.daysLeft === 1 ? "" : "s"} left on your free trial`,
          `Your site <strong>${esc(name)}</strong> is still live for now, but your 14-day free trial is almost up. Upgrade any time to keep it published — nothing you've built will be lost either way.`,
          "Upgrade now →"
        ),
      };
    case "trial_ended":
      return {
        subject: `Your free trial for ${name} has ended`,
        html: wrap(
          "Your free trial has ended",
          `<strong>${esc(name)}</strong> is no longer live on the web — your 14-day free trial ran out. Nothing is lost: your site is saved exactly as you left it. Upgrade any time to publish it again.`,
          "Upgrade & republish →"
        ),
      };
    default:
      return { subject: null, html: null };
  }
}

function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

async function notifyWhatsApp(env, site, event, extra, dryRun) {
  try {
    if (dryRun || !env.MANYCHAT_API_TOKEN) return 0;

    const owner = await env.DB.prepare(
      "SELECT phone FROM owners WHERE id=?1"
    ).bind(site.owner_id).first().catch(() => null);
    if (!owner?.phone) return 0;

    const phone = normalizePhone(owner.phone);
    if (!phone) return 0;

    const text = buildMessage(event, site, extra);
    if (!text) return 0;

    return await sendWhatsAppText(env, phone, text);
  } catch (err) {
    console.error("notifyWhatsApp failed (non-fatal):", event, err?.message);
    return 0;
  }
}

// ─── WHATSAPP NOTIFICATION (addons) ─────────────────────────────────────────────
// addon rows don't carry owner_id/phone directly -- queryAddons() below joins
// sites+owners so this has everything notifyWhatsApp() has, plus addon_type/tier.

async function notifyAddonWhatsApp(env, addon, event, extra, dryRun) {
  try {
    if (dryRun || !env.MANYCHAT_API_TOKEN) return 0;
    const phone = normalizePhone(addon.owner_phone);
    if (!phone) return 0;

    const text = buildAddonMessage(event, addon, extra);
    if (!text) return 0;

    return await sendWhatsAppText(env, phone, text);
  } catch (err) {
    console.error("notifyAddonWhatsApp failed (non-fatal):", event, err?.message);
    return 0;
  }
}

async function sendWhatsAppText(env, phone, text) {
  const findResp = await fetch(
    "https://api.manychat.com/fb/subscriber/findBySystemField?phone=" +
      encodeURIComponent(phone),
    { headers: { Authorization: "Bearer " + env.MANYCHAT_API_TOKEN } }
  );
  const found = await findResp.json().catch(() => ({}));
  const subId = found?.data?.id;
  if (!subId) return 0;

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
        content: { messages: [{ type: "text", text }] },
      },
    }),
  });

  return r.ok ? 1 : 0;
}

// ─── MESSAGE COPY (sites) ───────────────────────────────────────────────────────

function buildMessage(event, site, extra) {
  const name    = site.site_name || "your website";
  const slug    = site.draft_subdomain || "";
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

// ─── MESSAGE COPY (addons) ──────────────────────────────────────────────────────

function buildAddonMessage(event, addon, extra) {
  const label = ADDON_DISPLAY_NAME[addon.addon_type] || addon.addon_type;
  const name  = addon.site_name || "your site";
  const renewUrl = "https://app.websites.co.zw/dashboard/customer.html";

  switch (event) {
    case "addon_grace_started":
      return (
        `⚠️ *${label}* on *${name}* has expired.\n\n` +
        `It'll keep working for the next *${extra.graceDays} days* while you renew.\n\n` +
        `👉 Renew here: ${renewUrl}`
      );

    case "addon_suspended":
      return (
        `🔴 *${label}* on *${name}* has been switched off — the grace period ended without renewal.\n\n` +
        `Renew any time to turn it back on: ${renewUrl}`
      );

    default:
      return null;
  }
}

// ─── DB HELPERS ───────────────────────────────────────────────────────────────

async function querySites(env, where, params) {
  const res = await env.DB.prepare(
    `SELECT id, owner_id, site_name, status, expires_at, draft_subdomain, custom_domain, custom_domain_status
     FROM sites WHERE ${where}`
  ).bind(...params).all();
  return res?.results || [];
}

// Joins sites + owners so addon rows carry everything notify needs without a
// second round trip per row. Alias `a` for addons is assumed by the WHERE
// clauses passed in above -- keep that alias if you add more addon queries.
async function queryAddons(env, where, params) {
  const res = await env.DB.prepare(
    `SELECT a.id, a.site_id, a.addon_type, a.tier, a.status, a.expires_at, a.price_usd,
            s.site_name, o.phone AS owner_phone
     FROM addons a
     JOIN sites s ON s.id = a.site_id
     JOIN owners o ON o.id = s.owner_id
     WHERE ${where}`
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
