-- Historical compatibility migration for the former reward-deck implementation.
-- It is not the physical-inventory initialization path. It preserves every redemption row
-- and intentionally does not rewrite/delete the existing reward deck.
CREATE TABLE IF NOT EXISTS envelope_customer (
  auth_id       INTEGER PRIMARY KEY,
  customer_name TEXT NOT NULL DEFAULT '',
  phone_number  TEXT NOT NULL DEFAULT ''
);
INSERT OR IGNORE INTO envelope_customer (auth_id, customer_name, phone_number)
SELECT id, '', '' FROM envelope_auth;
CREATE TABLE IF NOT EXISTS envelope_customer_issue (
  auth_id INTEGER PRIMARY KEY,
  data_issue TEXT NOT NULL DEFAULT ''
);

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

-- Historical deck inspection only. Do not use this query or seed.sql to initialize
-- physical inventory; migration 0003 is the sole 216-gift initializer. If rows exist,
-- retain them and review/prepare a separately approved inventory migration first.
SELECT reward_id, COUNT(*) AS quantity, SUM(customer_key IS NOT NULL) AS claimed
FROM reward_deck GROUP BY reward_id ORDER BY reward_id;
