-- Websites.co.zw — Cloudflare D1 schema (SQLite dialect)
--
-- Tenant isolation note: D1 has no row-level security. Isolation is enforced
-- in the Worker data layer instead: every tenant-owned row carries owner_id,
-- and every query binds owner_id FROM THE SESSION (never from client input).

PRAGMA foreign_keys = ON;

-- ─────────────────────────────────────────────────────────────
-- Identity
-- ─────────────────────────────────────────────────────────────
CREATE TABLE users (
  id               TEXT PRIMARY KEY,               -- usr_…
  phone            TEXT UNIQUE,                     -- E.164, primary login (OTP-first)
  email            TEXT UNIQUE,                     -- optional
  name             TEXT,
  password_hash    TEXT,                            -- null when OTP-only or external auth
  external_auth_id TEXT,                            -- set if you use Clerk/Stytch instead
  role             TEXT NOT NULL DEFAULT 'owner',   -- 'owner' | 'admin' | 'support'
  status           TEXT NOT NULL DEFAULT 'active',  -- 'active' | 'suspended'
  created_at       INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at       INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE sessions (
  id          TEXT PRIMARY KEY,                     -- ses_… (256-bit random token)
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at  INTEGER NOT NULL,
  ip          TEXT,
  user_agent  TEXT,
  created_at  INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX idx_sessions_user ON sessions(user_id);

CREATE TABLE otp_codes (
  id          TEXT PRIMARY KEY,                     -- otp_…
  phone       TEXT NOT NULL,
  code_hash   TEXT NOT NULL,                        -- HMAC-SHA256(phone:code) — never plaintext
  purpose     TEXT NOT NULL DEFAULT 'login',
  attempts    INTEGER NOT NULL DEFAULT 0,
  expires_at  INTEGER NOT NULL,
  consumed_at INTEGER,
  created_at  INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX idx_otp_phone ON otp_codes(phone);

-- ─────────────────────────────────────────────────────────────
-- Tenant data — every row carries owner_id
-- ─────────────────────────────────────────────────────────────
CREATE TABLE sites (
  id            TEXT PRIMARY KEY,                   -- site_…
  owner_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  business_name TEXT NOT NULL,
  slug          TEXT NOT NULL UNIQUE,               -- slug.websites.co.zw
  template_id   TEXT NOT NULL,                      -- archetype / skin
  config_json   TEXT NOT NULL DEFAULT '{}',         -- drives the rendered static site
  status        TEXT NOT NULL DEFAULT 'draft',      -- 'draft' | 'published'
  published_at  INTEGER,
  created_at    INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at    INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX idx_sites_owner ON sites(owner_id);

CREATE TABLE domains (
  id                    TEXT PRIMARY KEY,           -- dom_…
  site_id               TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  owner_id              TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  domain                TEXT NOT NULL UNIQUE,       -- e.g. mystore.co.zw
  tld                   TEXT NOT NULL,              -- 'co.zw' | 'com'
  status                TEXT NOT NULL DEFAULT 'pending', -- 'pending'|'active'|'failed'
  cf_custom_hostname_id TEXT,                        -- Cloudflare for SaaS hostname id
  ssl_status            TEXT,
  created_at            INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at            INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX idx_domains_owner ON domains(owner_id);

-- Async .co.zw provisioning pipeline (the ZISPA state machine)
CREATE TABLE domain_orders (
  id              TEXT PRIMARY KEY,                 -- dor_…
  domain_id       TEXT NOT NULL REFERENCES domains(id) ON DELETE CASCADE,
  owner_id        TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  registrar       TEXT NOT NULL DEFAULT 'zispa_reseller',
  state           TEXT NOT NULL DEFAULT 'requested',
    -- requested → docs_collected → submitted → pending_zispa → active | rejected
  registrant_json TEXT,                              -- KYC / real-owner details for ZISPA
  letter_url      TEXT,                              -- auto-generated application letter (R2)
  notes           TEXT,
  submitted_at    INTEGER,
  activated_at    INTEGER,
  created_at      INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at      INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX idx_domain_orders_state ON domain_orders(state);
CREATE INDEX idx_domain_orders_owner ON domain_orders(owner_id);

-- ─────────────────────────────────────────────────────────────
-- Billing
-- ─────────────────────────────────────────────────────────────
CREATE TABLE subscriptions (
  id                   TEXT PRIMARY KEY,            -- sub_…
  owner_id             TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  site_id              TEXT REFERENCES sites(id) ON DELETE SET NULL,
  plan                 TEXT NOT NULL,               -- 'starter_cozw' | 'pro_com' | 'estore'
  billing_period       TEXT NOT NULL,               -- 'annual' | 'monthly'
  amount_usd           REAL NOT NULL,
  status               TEXT NOT NULL DEFAULT 'active', -- active|past_due|canceled|trialing
  current_period_start INTEGER NOT NULL,
  current_period_end   INTEGER NOT NULL,            -- the renewal date (drives cash-flow + dunning)
  provider             TEXT NOT NULL DEFAULT 'paynow', -- 'paynow' | 'stripe'
  provider_ref         TEXT,                         -- gateway subscription/customer id
  created_at           INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at           INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX idx_subs_owner   ON subscriptions(owner_id);
CREATE INDEX idx_subs_renewal ON subscriptions(current_period_end);

CREATE TABLE payments (
  id              TEXT PRIMARY KEY,                 -- pay_…
  subscription_id TEXT NOT NULL REFERENCES subscriptions(id) ON DELETE CASCADE,
  owner_id        TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  amount_usd      REAL NOT NULL,
  method          TEXT,                              -- 'ecocash'|'onemoney'|'visa'|'card'
  provider_ref    TEXT,
  status          TEXT NOT NULL DEFAULT 'pending',   -- 'paid'|'pending'|'failed'
  paid_at         INTEGER,
  created_at      INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX idx_payments_owner ON payments(owner_id);

-- e-store tables (products, orders, carts) extend this same owner_id pattern
-- when you build the commerce tier — not included here.
