# websites.co.zw — Deployment Guide

## What's fixed in this build

1. ✅ Root `index.html` IS the marketing page (no redirect needed)
2. ✅ Render Worker passes `www.websites.co.zw` through to Pages instead of 404
3. ✅ Auth Worker (`websites-cozw-auth.js`) — fully built. Handles login, account creation, sessions
4. ✅ Dashboard API (`websites-cozw-dashboard.js`) — full CRUD: list, create, get, save, generate
5. ✅ Schema aligned — `owners`, `sessions`, `otp_codes` tables match what Workers expect

---

## GitHub repo structure (push exactly this)

```
index.html                  ← marketing page (served at websites.co.zw)
_redirects                  ← Cloudflare Pages routing
dashboard/customer.html     ← owner dashboard
editor/index.html           ← site editor
templates/*/index.html      ← 7 industry templates (preview only)
api/                        ← Workers — deploy via wrangler (NOT via Pages)
README.md
```

The `api/` folder goes to GitHub for version control but Workers are deployed
separately via wrangler, not by Pages.

---

## Step 1 — D1 database

```bash
# Create the database (once)
wrangler d1 create websites-cozw-db

# Run the schema
wrangler d1 execute websites-cozw-db --file=api/schema.sql

# Seed your first owner (replace with your real phone number)
wrangler d1 execute websites-cozw-db --command="INSERT OR IGNORE INTO owners (id,phone,name) VALUES ('usr_001','263772000000','Admin')"
```

---

## Step 2 — Deploy Workers

### Render Worker (handles *.websites.co.zw)
```bash
wrangler deploy api/websites-cozw-render.js \
  --name websites-cozw-render \
  --compatibility-date 2024-01-01

# Secrets
wrangler secret put PLATFORM_ROOT       # websites.co.zw
wrangler secret put PREVIEW_SECRET      # any random 32+ char string
```

### Auth + Dashboard Worker (handles app.websites.co.zw)

Both the auth Worker and dashboard Worker should be combined into ONE
Worker deployed at app.websites.co.zw. The easiest way is to use a single
entry point that routes between them. For now, deploy auth as the main
Worker — it passes all non-/auth/* requests through (including /api/*
which the dashboard API handles separately, OR combine them).

**Option A — Two separate Workers with route splitting (recommended):**
- `websites-cozw-auth` → handles `app.websites.co.zw/auth/*`
- `websites-cozw-dashboard` → handles `app.websites.co.zw/api/*`

```bash
# Auth Worker
wrangler deploy api/websites-cozw-auth.js \
  --name websites-cozw-auth \
  --compatibility-date 2024-01-01

wrangler secret put OTP_HMAC_SECRET      # random 32+ chars
wrangler secret put SESSION_SECRET       # random 32+ chars  
wrangler secret put PREVIEW_HMAC_SECRET  # random 32+ chars (SAME value as PREVIEW_SECRET on render Worker)
wrangler secret put MANYCHAT_API_TOKEN   # from ManyChat (optional — falls back to dev mode)
wrangler secret put RESEND_API_KEY       # from Resend (optional)

# Dashboard API Worker
wrangler deploy api/websites-cozw-dashboard.js \
  --name websites-cozw-dashboard \
  --compatibility-date 2024-01-01
```

Both Workers need the D1 binding:
```toml
# In Cloudflare dashboard → Worker → Settings → Bindings → D1
# Variable name: DB
# Database: websites-cozw-db
```

### Payments Worker
```bash
wrangler deploy api/websites-cozw-payments.js \
  --name websites-cozw-payments \
  --compatibility-date 2024-01-01

wrangler secret put PAYNOW_USD_ID
wrangler secret put PAYNOW_USD_KEY
wrangler secret put PAYNOW_ZIG_ID
wrangler secret put PAYNOW_ZIG_KEY
# Vars (not secrets):
# ALLOWED_ORIGIN = https://app.websites.co.zw
# RESULT_URL     = https://api.websites.co.zw/paynow/result
# RETURN_URL     = https://app.websites.co.zw/payment-return
```

### Renewal Cron Worker
```bash
wrangler deploy api/websites-cozw-renewal-cron.js \
  --name websites-cozw-renewal-cron \
  --compatibility-date 2024-01-01
```

---

## Step 3 — Cloudflare Pages

1. Connect repo `Vodloza-ctrl/websites` to Cloudflare Pages
2. **Build command**: (leave empty — static files)
3. **Output directory**: `/` (repo root)
4. **Root directory**: `/` (repo root)
5. Custom domains: `websites.co.zw` and `www.websites.co.zw`

The marketing page (`index.html`) is already at repo root — Pages serves it automatically.

---

## Step 4 — DNS / Worker Routes

In Cloudflare DNS:
```
*.websites.co.zw    CNAME   websites-cozw-render.workers.dev   (Proxied)
app.websites.co.zw  CNAME   websites-cozw-auth.workers.dev     (Proxied)
api.websites.co.zw  CNAME   websites-cozw-payments.workers.dev (Proxied)
```

Worker routes (in Cloudflare dashboard):
```
*.websites.co.zw/*  → websites-cozw-render
```

---

## Testing login (DEV_MODE)

Set `DEV_MODE=1` on the auth Worker during testing. The OTP code will be
returned in the API response as `dev_code` and shown on the login screen.
Remove this before going live.

```bash
wrangler secret put DEV_MODE   # value: 1
```
