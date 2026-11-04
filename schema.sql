-- US Supplements — Diwali Mystery Envelope (Cloudflare D1)
--
-- reward_deck   : legacy reward history only. New draws use reward_inventory and reward_allocation
--                 from additive migration migrations/0003_physical_reward_inventory.sql.
--                 It is legacy-compatibility storage only. New customer flow has no static
--                 access codes, and physical allocations use Order ID as the sole boundary.
-- envelope_auth : one row per one-time authorization (NEW). Replaces the old emailed unlock code.
--
-- This file is a local/legacy compatibility base schema. Do not execute it against the
-- confirmed production D1; use migrations/production/0001 and 0002 instead.

CREATE TABLE IF NOT EXISTS reward_deck (
  slot           INTEGER PRIMARY KEY,
  reward_id      TEXT NOT NULL,          -- historical reward identifier; never used for new draws
  customer_key   TEXT,                   -- legacy metadata only; never a uniqueness boundary
  customer_email TEXT,                   -- legacy metadata only; never a uniqueness boundary
  order_id       TEXT UNIQUE,            -- WooCommerce order id used to open
  claimed_at     TEXT                    -- ISO timestamp (UTC)
);

CREATE INDEX IF NOT EXISTS idx_reward_deck_unclaimed ON reward_deck (slot) WHERE order_id IS NULL;

-- One-time authorization. The handoff token itself is NEVER stored, only its SHA-256 hash.
CREATE TABLE IF NOT EXISTS envelope_auth (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  token_hash         TEXT NOT NULL UNIQUE,   -- sha256(handoff token)
  order_id           TEXT NOT NULL,          -- WooCommerce order that was authorized
  customer_key       TEXT NOT NULL,          -- same format as reward_deck.customer_key
  customer_email     TEXT,                   -- trusted WooCommerce billing email (audit metadata)
  created_at         INTEGER NOT NULL,       -- epoch seconds
  expires_at         INTEGER NOT NULL,       -- handoff token must be exchanged before this
  verified_at        INTEGER,                -- set when the handoff token is exchanged (single use)
  bind_hash          TEXT,                   -- sha256('bind:' || clientNonce): ties the token to ONE browser
  session_expires_at INTEGER,                -- opening session lifetime
  redeemed_at        INTEGER,                -- set atomically with the reward claim
  reward_slot        INTEGER,                -- legacy reward_deck.slot; remains NULL for new allocations
  was_existing       INTEGER,                -- 1 = customer already had a saved reward (re-view, no new draw)
  superseded_at      INTEGER                 -- a newer handoff was issued for the same order
);

CREATE INDEX IF NOT EXISTS idx_envelope_auth_order ON envelope_auth (order_id, created_at);

CREATE TABLE IF NOT EXISTS envelope_customer (
  auth_id       INTEGER PRIMARY KEY,
  customer_name TEXT NOT NULL DEFAULT '',
  phone_number  TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS envelope_customer_issue (
  auth_id    INTEGER PRIMARY KEY,
  data_issue TEXT NOT NULL DEFAULT ''
);

-- Durable secondary reporting queue. D1 remains authoritative; only the five record fields
-- are sent to Google Sheets. Operational retry metadata stays in D1.
CREATE TABLE IF NOT EXISTS sheet_sync (
  order_id        TEXT PRIMARY KEY,
  name            TEXT NOT NULL DEFAULT '',
  phone_number    TEXT NOT NULL DEFAULT '',
  reward_type     TEXT NOT NULL,
  envelope_result TEXT NOT NULL,
  sync_state      TEXT NOT NULL CHECK (sync_state IN ('pending', 'synced')),
  attempts        INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL,
  synced_at       INTEGER,
  last_error      TEXT
);
CREATE INDEX IF NOT EXISTS idx_sheet_sync_pending ON sheet_sync (next_attempt_at) WHERE sync_state = 'pending';
