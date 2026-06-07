// dashboard-api.ts — admin dashboard aggregation endpoint (Cloudflare Worker + D1)
//
// Mount behind the auth from auth.ts:  app.get('/api/admin/dashboard', requireAuth, requireAdmin, dashboard)
// Returns exactly the JSON shape dashboard.html consumes. One batched round-trip to D1.

import type { Context } from 'hono';

type Env = { DB: D1Database };

export async function dashboard(c: Context<{ Bindings: Env }>) {
  const db = c.env.DB;

  // unixepoch() helpers evaluated in SQL; 30d window for renewals, month start for cohorts
  const [
    sites, newSites, estores, arr, mrr, renewals, failed, funnelDomains, queueCounts, cohortRows, queueRows,
  ] = await db.batch([
    db.prepare(`SELECT COUNT(*) AS n FROM sites WHERE status = 'published'`),
    db.prepare(`SELECT COUNT(*) AS n FROM sites WHERE created_at >= unixepoch('now','start of month')`),
    db.prepare(`SELECT COUNT(DISTINCT owner_id) AS n FROM subscriptions
                WHERE plan = 'estore' AND status = 'active'`),
    // annualise everything: monthly plans × 12
    db.prepare(`SELECT COALESCE(SUM(CASE WHEN billing_period = 'annual' THEN amount_usd
                  ELSE amount_usd * 12 END), 0) AS v
                FROM subscriptions WHERE status = 'active'`),
    db.prepare(`SELECT COALESCE(SUM(amount_usd), 0) AS v FROM subscriptions
                WHERE plan = 'estore' AND billing_period = 'monthly' AND status = 'active'`),
    db.prepare(`SELECT COUNT(*) AS n FROM subscriptions
                WHERE status = 'active'
                  AND current_period_end BETWEEN unixepoch() AND unixepoch('now','+30 days')`),
    db.prepare(`SELECT COUNT(*) AS n FROM payments
                WHERE status = 'failed' AND created_at >= unixepoch('now','-30 days')`),
    db.prepare(`SELECT COUNT(DISTINCT site_id) AS n FROM domains WHERE status = 'active'`),
    db.prepare(`SELECT
                  SUM(state = 'submitted')     AS submitted,
                  SUM(state = 'pending_zispa') AS pending,
                  SUM(state = 'docs_collected') AS needsDocs
                FROM domain_orders`),
    // cohort: for each signup month, share of owners that now hold an active e-store
    db.prepare(`SELECT strftime('%Y-%m', s.created_at, 'unixepoch') AS month,
                  COUNT(DISTINCT s.owner_id) AS signups,
                  COUNT(DISTINCT CASE WHEN sub.id IS NOT NULL THEN s.owner_id END) AS upgraded
                FROM sites s
                LEFT JOIN subscriptions sub
                  ON sub.owner_id = s.owner_id AND sub.plan = 'estore' AND sub.status = 'active'
                GROUP BY month ORDER BY month DESC LIMIT 8`),
    db.prepare(`SELECT d.domain, d.tld, do.state, do.created_at, u.name AS customer
                FROM domain_orders do
                JOIN domains d ON d.id = do.domain_id
                JOIN users u   ON u.id = do.owner_id
                WHERE do.state IN ('submitted','pending_zispa','docs_collected','active')
                ORDER BY do.created_at ASC LIMIT 12`),
  ]);

  const n = (r: D1Result) => Number((r.results?.[0] as any)?.n ?? 0);
  const v = (r: D1Result) => Number((r.results?.[0] as any)?.v ?? 0);
  const activeSites = n(sites);
  const estoreCount = n(estores);

  const stateMap: Record<string, string> = {
    submitted: 'submitted', pending_zispa: 'pending', docs_collected: 'needsDocs', active: 'active',
  };
  const now = Math.floor(Date.now() / 1000);
  const age = (ts: number) => {
    const h = Math.floor((now - ts) / 3600);
    return h < 24 ? `${h}h` : `${Math.floor(h / 24)}d`;
  };

  return c.json({
    meta: { location: 'Harare', period: 'this month', user: c.get('user')?.name ?? 'Admin' },
    metrics: {
      activeSites,
      newThisMonth: n(newSites),
      arr: Math.round(v(arr)),
      mrr: Math.round(v(mrr)),
      estoreCount,
      estoreConversion: activeSites ? estoreCount / activeSites : 0,
      convDelta: 0.006, // compute from a stored monthly snapshot; placeholder for now
      renewalsDue30d: n(renewals),
      failedPayments: n(failed),
    },
    funnel: [
      { label: 'New signups', value: activeSites + n(newSites) },
      { label: 'Published', value: activeSites },
      { label: 'Custom domain', value: n(funnelDomains) },
      { label: 'E-store', value: estoreCount },
    ],
    queue: {
      counts: {
        submitted: Number((queueCounts.results?.[0] as any)?.submitted ?? 0),
        pending: Number((queueCounts.results?.[0] as any)?.pending ?? 0),
        needsDocs: Number((queueCounts.results?.[0] as any)?.needsDocs ?? 0),
      },
      rows: (queueRows.results as any[]).map((r) => ({
        domain: r.domain,
        customer: r.customer ?? '—',
        state: stateMap[r.state] ?? r.state,
        age: r.state === 'active' ? '—' : age(r.created_at),
      })),
    },
    renewals: {
      due30d: n(renewals),
      renewalRate: 0.86,        // derive from renewed vs due over trailing window
      grossMrrRetention: 0.91,  // derive from e-store churn
      failedPayments: n(failed),
    },
    cohorts: (cohortRows.results as any[]).reverse().map((r) => ({
      month: new Date(r.month + '-01').toLocaleString('en', { month: 'short' }),
      signups: Number(r.signups),
      pct: r.signups ? Number(r.upgraded) / Number(r.signups) : 0,
    })),
  });
}
