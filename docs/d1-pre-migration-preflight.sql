-- READ ONLY. Confirm account, database name and database ID independently before running.
-- Output includes customer/order identifiers; keep it private. No rows are rewritten.
-- Review all returned schema definitions against schema.sql and migration 0003 before proceeding.
SELECT type, name, tbl_name, sql
FROM sqlite_master
WHERE type IN ('table', 'index', 'trigger')
  AND name IN (
    'reward_deck', 'envelope_auth', 'envelope_customer', 'envelope_customer_issue', 'sheet_sync',
    'reward_inventory', 'reward_allocation', 'idx_reward_allocation_reward',
    'trg_reward_allocation_not_legacy_claimed', 'trg_legacy_deck_prevent_new_duplicate',
    'trg_legacy_deck_prevent_insert_duplicate', 'trg_reward_allocation_claim_stock'
  )
ORDER BY type, name;

-- Legacy claims are history; never delete or rewrite them to make the new system fit.
SELECT COUNT(*) AS legacy_reward_deck_rows,
       SUM(customer_key IS NOT NULL) AS legacy_claimed_rows
FROM reward_deck;

SELECT reward_id, COUNT(*) AS row_count, SUM(customer_key IS NOT NULL) AS claimed_count
FROM reward_deck GROUP BY reward_id ORDER BY reward_id;

SELECT slot, reward_id, order_id, claimed_at
FROM reward_deck WHERE customer_key IS NOT NULL OR order_id IS NOT NULL
ORDER BY slot;

SELECT order_id, COUNT(*) AS duplicate_count FROM reward_deck
WHERE order_id IS NOT NULL GROUP BY order_id HAVING COUNT(*) > 1;
SELECT customer_key, COUNT(*) AS duplicate_count FROM reward_deck
WHERE customer_key IS NOT NULL GROUP BY customer_key HAVING COUNT(*) > 1;
SELECT customer_email, COUNT(*) AS duplicate_count FROM reward_deck
WHERE customer_email IS NOT NULL GROUP BY customer_email HAVING COUNT(*) > 1;

-- Review active, redeemed and legacy-slot authorizations before any Worker replacement.
-- Keep this output private; it contains order and customer identifiers.
SELECT id, order_id, customer_key, customer_email, created_at, expires_at,
       verified_at, session_expires_at, redeemed_at, reward_slot, was_existing, superseded_at
FROM envelope_auth
WHERE redeemed_at IS NOT NULL OR reward_slot IS NOT NULL
   OR (superseded_at IS NULL AND expires_at > unixepoch())
ORDER BY id;

-- Existing pending sync events must be preserved and retried in place, not re-created.
SELECT order_id, sync_state, attempts, next_attempt_at, last_error
FROM sheet_sync WHERE sync_state = 'pending' ORDER BY next_attempt_at;
