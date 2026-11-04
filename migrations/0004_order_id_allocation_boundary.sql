-- Data-preserving upgrade from the earlier 0003 customer-level allocation boundary.
--
-- Apply ONLY after the preflight confirms that reward_inventory AND reward_allocation
-- both exist and reward_allocation has the old unique customer_key / email design.
-- Do not execute this file directly against an unidentified database. Apply it through
-- D1's tracked migration mechanism after reviewing its backup/rollback plan.
--
-- This rebuild preserves every reward_allocation row, its ids/timestamps, and all
-- reward_inventory quantities. It intentionally drops only constraints/triggers that
-- enforce customer-wide allocation, then recreates order-only equivalents.

PRAGMA defer_foreign_keys = on;

DROP TRIGGER IF EXISTS trg_reward_allocation_not_legacy_claimed;
DROP TRIGGER IF EXISTS trg_reward_allocation_claim_stock;
DROP TRIGGER IF EXISTS trg_legacy_deck_prevent_new_duplicate;
DROP TRIGGER IF EXISTS trg_legacy_deck_prevent_insert_duplicate;

CREATE TABLE reward_allocation_order_boundary_upgrade (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  auth_id INTEGER NOT NULL UNIQUE REFERENCES envelope_auth(id),
  order_id TEXT NOT NULL UNIQUE,
  -- Retained trusted WooCommerce metadata; never a uniqueness boundary.
  customer_key TEXT NOT NULL,
  customer_email TEXT,
  reward_id TEXT NOT NULL REFERENCES reward_inventory(reward_id),
  allocated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  stock_decremented INTEGER NOT NULL DEFAULT 0 CHECK (stock_decremented IN (0,1))
);

INSERT INTO reward_allocation_order_boundary_upgrade
  (id, auth_id, order_id, customer_key, customer_email, reward_id, allocated_at, stock_decremented)
SELECT id, auth_id, order_id, customer_key, customer_email, reward_id, allocated_at, stock_decremented
FROM reward_allocation;

DROP TABLE reward_allocation;
ALTER TABLE reward_allocation_order_boundary_upgrade RENAME TO reward_allocation;

CREATE INDEX idx_reward_allocation_reward ON reward_allocation(reward_id);

-- A legacy coupon claim blocks only the same WooCommerce order.
CREATE TRIGGER trg_reward_allocation_not_legacy_claimed
BEFORE INSERT ON reward_allocation
WHEN EXISTS (SELECT 1 FROM reward_deck d WHERE d.order_id = NEW.order_id)
BEGIN
  SELECT RAISE(ABORT, 'LEGACY_REWARD_ALREADY_ALLOCATED');
END;

-- A still-running legacy writer cannot claim an order already allocated in the
-- physical system. Customer/email equality intentionally does not block another order.
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

PRAGMA defer_foreign_keys = off;
