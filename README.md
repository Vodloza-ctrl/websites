# websites — demo build

**Where Zimbabwe builds online.** A premium, low-cost Website-as-a-Service platform:
self-service static sites on a free `.co.zw` domain, with upsells to `.com`, online
stores and bespoke builds.

> This is a **demo build** — every page runs standalone with placeholder images
> (picsum.photos) and mock data. No backend is required to click through it.

## Open it

Open **`index.html`** in a browser — it's the overview that links to every surface.
Or open any page directly (each is self-contained).

## Structure

```
index.html                 Overview / launcher (start here)
marketing/index.html       Public marketing site
templates/
  consultant/              Showcase archetype — professional services
  salon/                   Showcase archetype — salon & beauty
  restaurant/              Catalogue archetype — menu + order cart (e-store on-ramp)
  realestate/              Catalogue archetype — property listings
  school/                  Institution archetype — programmes, news, enrolment
dashboard/
  customer.html            What a site owner sees (status, domains, billing, upsells)
  admin.html               Internal ops cockpit (revenue, funnel, ZISPA queue)
editor/index.html          Self-service editor with live preview
shared/render.js           One render-from-JSON function (Worker + editor)
data/demo.json             Sample site config that drives a template
api/
  schema.sql               Cloudflare D1 schema (owner_id on every tenant row)
  auth.ts                  Phone-OTP login, session middleware, tenant isolation
  dashboard-api.ts         Admin metrics endpoint (one batched D1 query)
assets/logo.png            Logo source
```

## Three template archetypes

The five templates are skins on **three** real layouts — showcase, catalogue,
institution. New industries are added as configuration, not new code.

## Brand

- **Type:** Archivo (display/wordmark) + Hanken Grotesk (body)
- **Surface:** white / near-white; near-black text
- **Accent:** Zimbabwe flag triad (green `#15924B`, yellow `#F4C20D`, red `#E23B2E`)
  used as the dot motif, hairline bars and status — not as fills
- **Primary action:** near-black buttons

## Demo vs production

| Demo (this build) | Production |
|---|---|
| Mock data + picsum images | Cloudflare D1 + R2 |
| Static template HTML | Templates rendered from JSON via `shared/render.js` |
| `dashboard.html` fetch falls back to mock | `api/dashboard-api.ts` behind `requireAuth`+`requireAdmin` |
| WhatsApp/`.com` links are placeholders | Paynow (EcoCash/OneMoney), registrar + ZISPA pipeline |

## Pricing modelled

- Website — **$30/yr**, free `.co.zw` domain included
- Website + `.com` — **$50/yr**
- Online store — **$30/mo** (products, payments, WhatsApp checkout)
- Bespoke — from **$250** / project
