-- websites.co.zw — Canonical D1 Schema
-- Run this once against your D1 database:
--   wrangler d1 execute websites-cozw-db --file=api/schema.sql
--
-- All tables use IF NOT EXISTS so it's safe to re-run.

PRAGMA journal_mode=WAL;

-- ── Identity ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS owners (
  id         TEXT PRIMARY KEY,          -- usr_<hex>
  phone      TEXT NOT NULL UNIQUE,      -- normalised E.164 without + e.g. 263772123456
  name       TEXT,
  email      TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS otp_codes (
  id          TEXT PRIMARY KEY,         -- otp_<hex>
  phone       TEXT NOT NULL,
  code_hash   TEXT NOT NULL,            -- HMAC-SHA256(phone:code) — never plaintext
  channel     TEXT NOT NULL DEFAULT 'whatsapp',
  attempts    INTEGER NOT NULL DEFAULT 0,
  expires_at  INTEGER NOT NULL,
  consumed_at INTEGER,
  created_at  INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_otp_phone ON otp_codes(phone);

CREATE TABLE IF NOT EXISTS sessions (
  token      TEXT PRIMARY KEY,          -- 48-byte hex random
  owner_id   TEXT NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_sessions_owner ON sessions(owner_id);

-- ── Sites ──────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS sites (
  id                   TEXT PRIMARY KEY,   -- site_<hex>
  owner_id             TEXT NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  site_name            TEXT NOT NULL,
  status               TEXT NOT NULL DEFAULT 'draft',
    -- draft | pending_payment | published | grace | suspended
  plan                 TEXT NOT NULL DEFAULT 'starter',
    -- starter | pro
  draft_subdomain      TEXT UNIQUE,        -- slug.websites.co.zw
  custom_domain        TEXT UNIQUE,        -- e.g. myshop.com (Pro only)
  custom_domain_status TEXT DEFAULT 'none',
    -- none | pending | verifying | active | failed
  template_id          TEXT DEFAULT 'bold-retail',
  content              TEXT DEFAULT '{}',  -- full content+theme JSON
  ai_generations_used  INTEGER DEFAULT 0,
  published_at         INTEGER,
  expires_at           INTEGER,            -- Unix epoch when subscription expires
  updated_at           INTEGER DEFAULT (unixepoch()),
  created_at           INTEGER DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_sites_owner  ON sites(owner_id);
CREATE INDEX IF NOT EXISTS idx_sites_status ON sites(status);
CREATE INDEX IF NOT EXISTS idx_sites_slug   ON sites(draft_subdomain);

-- ── Payments ───────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS payments (
  id           TEXT PRIMARY KEY,
  site_id      TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  reference    TEXT UNIQUE,              -- Paynow reference WCZ-<uuid>
  poll_url     TEXT,
  integration  TEXT,                     -- usd | zig
  currency     TEXT,                     -- USD | ZIG
  amount       REAL,
  purpose      TEXT DEFAULT 'publish',   -- publish | renewal
  status       TEXT DEFAULT 'pending',   -- pending | paid | failed | cancelled
  created_at   INTEGER DEFAULT (unixepoch()),
  confirmed_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_payments_site ON payments(site_id);
CREATE INDEX IF NOT EXISTS idx_payments_ref  ON payments(reference);

-- ── Renewal reminder tracking ──────────────────────────────────────────────
ALTER TABLE sites ADD COLUMN renewal_reminder_stage INTEGER;

-- ── Seed: first owner (replace phone with real number) ────────────────────
-- INSERT OR IGNORE INTO owners (id, phone, name)
-- VALUES ('usr_001', '263772000000', 'Admin');
