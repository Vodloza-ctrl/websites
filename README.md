# websites.co.zw — Build v2

**Multi-tenant WaaS platform for Zimbabwean SMEs**  
Built by Ya-Sibo? Media · Runs on Cloudflare Workers + D1 + R2

---

## What's in this zip

### Front of House
| File | Purpose |
|------|---------|
| `marketing/index.html` | Marketing/landing site → deploy to Cloudflare Pages at `websites.co.zw` |
| `dashboard/customer.html` | Owner dashboard → wires to `app.websites.co.zw/api/sites` |
| `dashboard/admin.html` | Ops/admin view — all sites, payments, ZISPA queue |
| `editor/index.html` | Self-service site editor with live preview + AI generation |

### Templates (7 industries, 3 archetypes)
| Template | Archetype | Industry |
|----------|-----------|---------|
| `templates/restaurant/` | Showcase | Restaurants / grills |
| `templates/salon/` | Showcase | Salons / beauty |
| `templates/school/` | Institution | Schools / academies |
| `templates/consultant/` | Showcase | Consultants / advisory |
| `templates/realestate/` | Catalogue | Real estate |
| `templates/church/` | Institution | Churches / NGOs (**NEW**) |
| `templates/sports/` | Institution | Sports clubs / academies (**NEW**) |

### Cloudflare Workers (deploy via wrangler)
| File | Deployed at | Purpose |
|------|-------------|---------|
| `api/websites-cozw-render.js` | `*.websites.co.zw` | Multi-tenant site render from D1 |
| `api/websites-cozw-payments.js` | `api.websites.co.zw` | Paynow USD + ZiG payments |
| `api/websites-cozw-dashboard.js` | `app.websites.co.zw` | Sites CRUD + AI proxy |
| `api/websites-cozw-ai.js` | Internal | Claude Sonnet copy generation |
| `api/websites-cozw-renewal-cron.js` | Cron Worker | Lifecycle transitions + WhatsApp reminders |

### Data
| File | Purpose |
|------|---------|
| `api/schema.sql` | Canonical D1 schema |

---

## Pricing (live)
- **Starter** — $30/year · Free `.co.zw` subdomain · AI copy generation (3 runs) · 25 images
- **Pro** — $60/year · Custom `.com` domain · Everything in Starter + priority support

## Site lifecycle
`draft` → `pending_payment` → `published` → `grace` (14 days) → `suspended`

## Quick start (Phase 1 concierge)
1. Build the site manually in D1 (one row in `sites` + assets in R2)  
2. Call `POST https://api.websites.co.zw/pay` with `{site_id, currency:"USD", purpose:"publish"}`  
3. Send the `redirect_url` to the client via WhatsApp  
4. Client pays → Paynow webhook fires → `confirmPaid` flips site to `published`  
5. Site goes live at `<slug>.websites.co.zw` instantly

## Outstanding before Phase 1 launch
- [ ] Set Paynow secrets: `PAYNOW_USD_ID`, `PAYNOW_USD_KEY`, `PAYNOW_ZIG_ID`, `PAYNOW_ZIG_KEY`  
- [ ] Set `ALLOWED_ORIGIN`, `RESULT_URL`, `RETURN_URL` on payments Worker  
- [ ] Run one real low-value test transaction end to end  
- [ ] Deploy `marketing/index.html` to Cloudflare Pages on apex `websites.co.zw`  
- [ ] Seed `owners` table: `INSERT INTO owners (id,phone,name) VALUES ('user_001','263772XXXXXX','Elite Sports')`  
- [ ] Configure `mail.websites.co.zw` in Resend for OTP emails  

---

© 2026 Ya-Sibo? Media · Bulawayo, Zimbabwe
