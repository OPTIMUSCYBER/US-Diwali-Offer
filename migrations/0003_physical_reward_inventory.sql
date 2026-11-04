-- Additive persistent stock and redemption mapping. Safe to rerun: INSERT OR IGNORE
-- never resets quantities, and legacy reward_deck / reward_slot history is untouched.
CREATE TABLE IF NOT EXISTS reward_inventory (
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

CREATE TABLE IF NOT EXISTS reward_allocation (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  auth_id INTEGER NOT NULL UNIQUE REFERENCES envelope_auth(id),
  order_id TEXT NOT NULL UNIQUE,
  -- Trusted WooCommerce metadata only. Allocation uniqueness is order_id.
  customer_key TEXT NOT NULL,
  customer_email TEXT,
  reward_id TEXT NOT NULL REFERENCES reward_inventory(reward_id),
  allocated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  stock_decremented INTEGER NOT NULL DEFAULT 0 CHECK (stock_decremented IN (0,1))
);
CREATE INDEX IF NOT EXISTS idx_reward_allocation_reward ON reward_allocation(reward_id);

-- Keep a legacy claimed ORDER from receiving a second, new-format allocation.
-- Customer/email metadata intentionally does not participate: a second eligible order
-- from the same customer remains independently eligible.
CREATE TRIGGER IF NOT EXISTS trg_reward_allocation_not_legacy_claimed
BEFORE INSERT ON reward_allocation
WHEN EXISTS (
  SELECT 1 FROM reward_deck d
   WHERE d.order_id = NEW.order_id
)
BEGIN
  SELECT RAISE(ABORT, 'LEGACY_REWARD_ALREADY_ALLOCATED');
END;

-- Also block a still-running legacy Worker from claiming the same order after a new
-- allocation committed. Existing legacy rows are never modified by this trigger.
CREATE TRIGGER IF NOT EXISTS trg_legacy_deck_prevent_new_duplicate
BEFORE UPDATE OF customer_key, customer_email, order_id ON reward_deck
WHEN NEW.order_id IS NOT NULL AND EXISTS (
  SELECT 1 FROM reward_allocation a
   WHERE a.order_id = NEW.order_id
)
BEGIN
  SELECT RAISE(ABORT, 'REWARD_ALREADY_ALLOCATED');
END;

-- Cover legacy writers that insert an already-claimed deck row instead of updating a
-- pre-seeded slot. This is additive and never changes an existing deck record.
CREATE TRIGGER IF NOT EXISTS trg_legacy_deck_prevent_insert_duplicate
BEFORE INSERT ON reward_deck
WHEN NEW.order_id IS NOT NULL AND EXISTS (
  SELECT 1 FROM reward_allocation a
   WHERE a.order_id = NEW.order_id
)
BEGIN
  SELECT RAISE(ABORT, 'REWARD_ALREADY_ALLOCATED');
END;

-- The allocation insert is the stock claim. SQLite serializes D1 writes; the trigger
-- conditionally decrements exactly one unit and aborts the enclosing transaction if
-- stock is unavailable. Duplicate INSERT OR IGNORE retries do not fire this trigger.
CREATE TRIGGER IF NOT EXISTS trg_reward_allocation_claim_stock
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

-- Exact approved inventory. Better Luck has no finite stock.
INSERT OR IGNORE INTO reward_inventory (reward_id,reward_name,initial_quantity,remaining_quantity,unit_value_paise,is_fallback) VALUES
 ('SUPER_YOU_PROTEIN','Super You Protein – 1 kg',1,1,220000,0),
 ('PSYCHO_PUMP','One Science Psycho Pump – 15 servings',1,1,70000,0),
 ('PROTEIN_SAMPLE_BOX','One Science Protein Sample Box',1,1,70000,0),
 ('REGULAR_SHAKER','Shaker',1,1,7000,0),
 ('TSHIRT','T-shirt',1,1,10000,0),
 ('STEEL_SHAKER','Steel Shaker',1,1,35000,0),
 ('MUSCLE_SCIENCE_PREWORKOUT','Muscle Science Pre-workout – 2-serving pack',100,100,5000,0),
 ('BIG_FLEX_BCAA','Big Flex BCAA',10,10,NULL,0),
 ('PINTOLA_OATS','Pintola Oats – 1 serving',50,50,NULL,0),
 ('KEYCHAIN','Keychain',50,50,NULL,0),
 ('BETTER_LUCK','Better Luck Next Time',NULL,NULL,0,1);
