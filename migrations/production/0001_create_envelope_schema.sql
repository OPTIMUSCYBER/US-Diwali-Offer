-- PRODUCTION BOOTSTRAP — US Supplements Diwali Mystery Envelope 2026
--
-- Target confirmed during the production inspection:
--   existing application table: redemptions(order_id TEXT PRIMARY KEY,
--                                         redeemed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)
--   Cloudflare internal table: _cf_KV
--
-- This tracked migration intentionally does NOT read, alter, drop, rename, or delete
-- either table. It uses plain CREATE statements (not IF NOT EXISTS) so an unexpected
-- pre-existing envelope table makes the migration fail rather than silently accepting
-- an unknown schema. Run the read-only production preflight first.
--
-- Physical inventory rows are installed separately by 0002.

CREATE TABLE reward_deck (
  -- Legacy compatibility only. New customer flow never uses static codes or this table
  -- for allocation; Order ID is the only allocation boundary in reward_allocation.
  slot           INTEGER PRIMARY KEY,
  reward_id      TEXT NOT NULL,
  customer_key   TEXT,
  customer_email TEXT,
  order_id       TEXT UNIQUE,
  claimed_at     TEXT
);
CREATE INDEX idx_reward_deck_unclaimed ON reward_deck (slot) WHERE order_id IS NULL;

CREATE TABLE envelope_auth (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  token_hash         TEXT NOT NULL UNIQUE,
  order_id           TEXT NOT NULL,
  customer_key       TEXT NOT NULL,
  customer_email     TEXT,
  created_at         INTEGER NOT NULL,
  expires_at         INTEGER NOT NULL,
  verified_at        INTEGER,
  bind_hash          TEXT,
  session_expires_at INTEGER,
  redeemed_at        INTEGER,
  reward_slot        INTEGER,
  was_existing       INTEGER,
  superseded_at      INTEGER
);
CREATE INDEX idx_envelope_auth_order ON envelope_auth (order_id, created_at);

CREATE TABLE envelope_customer (
  auth_id       INTEGER PRIMARY KEY,
  customer_name TEXT NOT NULL DEFAULT '',
  phone_number  TEXT NOT NULL DEFAULT ''
);

CREATE TABLE envelope_customer_issue (
  auth_id    INTEGER PRIMARY KEY,
  data_issue TEXT NOT NULL DEFAULT ''
);

CREATE TABLE sheet_sync (
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
CREATE INDEX idx_sheet_sync_pending ON sheet_sync (next_attempt_at) WHERE sync_state = 'pending';

CREATE TABLE reward_inventory (
  reward_id TEXT PRIMARY KEY,
  reward_name TEXT NOT NULL,
  initial_quantity INTEGER,
  remaining_quantity INTEGER,
  unit_value_paise INTEGER,
  is_fallback INTEGER NOT NULL DEFAULT 0 CHECK (is_fallback IN (0,1)),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  CHECK (
    (is_fallback = 1 AND initial_quantity IS NULL AND remaining_quantity IS NULL)
    OR (is_fallback = 0 AND typeof(initial_quantity) = 'integer' AND typeof(remaining_quantity) = 'integer'
        AND initial_quantity >= 0 AND remaining_quantity >= 0 AND remaining_quantity <= initial_quantity)
  ),
  CHECK (unit_value_paise IS NULL OR (typeof(unit_value_paise) = 'integer' AND unit_value_paise >= 0))
);

CREATE TABLE reward_allocation (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  auth_id INTEGER NOT NULL UNIQUE REFERENCES envelope_auth(id),
  -- One allocation per eligible WooCommerce Order ID. Customer metadata is never unique.
  order_id TEXT NOT NULL UNIQUE,
  customer_key TEXT NOT NULL,
  customer_email TEXT,
  reward_id TEXT NOT NULL REFERENCES reward_inventory(reward_id),
  allocated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  stock_decremented INTEGER NOT NULL DEFAULT 0 CHECK (stock_decremented IN (0,1))
);
CREATE INDEX idx_reward_allocation_reward ON reward_allocation(reward_id);

CREATE TRIGGER trg_reward_allocation_not_legacy_claimed
BEFORE INSERT ON reward_allocation
WHEN EXISTS (SELECT 1 FROM reward_deck d WHERE d.order_id = NEW.order_id)
BEGIN
  SELECT RAISE(ABORT, 'LEGACY_REWARD_ALREADY_ALLOCATED');
END;

CREATE TRIGGER trg_legacy_deck_prevent_new_duplicate
BEFORE UPDATE OF customer_key, customer_email, order_id ON reward_deck
WHEN NEW.order_id IS NOT NULL
 AND EXISTS (SELECT 1 FROM reward_allocation a WHERE a.order_id = NEW.order_id)
BEGIN
  SELECT RAISE(ABORT, 'REWARD_ALREADY_ALLOCATED');
END;

CREATE TRIGGER trg_legacy_deck_prevent_insert_duplicate
BEFORE INSERT ON reward_deck
WHEN NEW.order_id IS NOT NULL
 AND EXISTS (SELECT 1 FROM reward_allocation a WHERE a.order_id = NEW.order_id)
BEGIN
  SELECT RAISE(ABORT, 'REWARD_ALREADY_ALLOCATED');
END;

CREATE TRIGGER trg_reward_allocation_claim_stock
AFTER INSERT ON reward_allocation
WHEN (SELECT is_fallback FROM reward_inventory WHERE reward_id = NEW.reward_id) = 0
BEGIN
  UPDATE reward_inventory
     SET remaining_quantity = remaining_quantity - 1,
         updated_at = unixepoch()
   WHERE reward_id = NEW.reward_id AND remaining_quantity > 0;
  SELECT CASE WHEN changes() = 0 THEN RAISE(ABORT, 'REWARD_OUT_OF_STOCK') END;
  UPDATE reward_allocation SET stock_decremented = 1 WHERE id = NEW.id;
END;
