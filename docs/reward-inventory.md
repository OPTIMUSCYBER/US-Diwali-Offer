# Physical reward inventory

For the confirmed production D1, the initialization source is tracked `../migrations/production/0002_install_physical_reward_inventory.sql`, after `0001_create_envelope_schema.sql`. Its `INSERT OR IGNORE` seeds only absent IDs; reruns never reset stock. The top-level 0003 migration remains for the historical/local compatibility path and is not the production migration path. Do not edit inventory quantities or run a manual reset against a populated database.

| Reward ID | Reward | Initial quantity | Unit value |
| --- | --- | ---: | ---: |
| `SUPER_YOU_PROTEIN` | Super You Protein – 1 kg | 1 | ₹2,200 |
| `PSYCHO_PUMP` | One Science Psycho Pump – 15 servings | 1 | ₹700 |
| `PROTEIN_SAMPLE_BOX` | One Science Protein Sample Box | 1 | ₹700 |
| `REGULAR_SHAKER` | Shaker | 1 | ₹70 |
| `TSHIRT` | T-shirt | 1 | ₹100 |
| `STEEL_SHAKER` | Steel Shaker | 1 | ₹350 |
| `MUSCLE_SCIENCE_PREWORKOUT` | Muscle Science Pre-workout – 2-serving pack | 100 | ₹50 |
| `BIG_FLEX_BCAA` | Big Flex BCAA | 10 | Not specified |
| `PINTOLA_OATS` | Pintola Oats – 1 serving | 50 | Not specified |
| `KEYCHAIN` | Keychain | 50 | Not specified |
| `BETTER_LUCK` | Better Luck Next Time | Unlimited fallback | ₹0 |

Finite physical inventory is 216 units. Better Luck is excluded from physical weighting and is selected when finite inventory reaches zero. The database check requires finite quantities to be non-null integers with `0 <= remaining_quantity <= initial_quantity`; fallback quantities must both remain `NULL`. Unit values must be non-negative integers or `NULL` when no value was provided.

## Allocation

The Worker computes a random integer in `[0, total_remaining)` and selects the row whose cumulative remaining quantity contains that index. Thus each remaining physical unit has equal selection probability, and categories are weighted by remaining quantity. Browser input does not participate in the draw.

`reward_allocation.auth_id` and `reward_allocation.order_id` are unique. **Order ID is the only customer-facing allocation boundary.** Canonical customer key and non-null email are trusted WooCommerce audit metadata and deliberately are not unique: another eligible order from the same customer/email receives its own independent allocation. An `AFTER INSERT` trigger decrements exactly one unit for non-fallback rewards, aborting the insert if stock is unavailable. The Worker uses `D1Database.batch` for allocation, auth redemption and Sheets outbox creation; the D1 batch is one sequential SQL transaction and rolls back on a failing statement. Duplicate requests for the same Order ID find/replay that persisted allocation and do not decrement stock again.

Legacy `reward_deck` rows and `envelope_auth.reward_slot` remain unchanged and readable. A legacy claim blocks a new physical allocation only for the same legacy Order ID; it does not block another eligible Order ID from the same customer. New allocations leave `reward_slot` null and use `reward_allocation`.

## Existing 0003 databases

An earlier local 0003 draft made `customer_key` unique and added a unique non-null email index. That design is incompatible with the order-level policy. Do not attempt to remove SQLite's table-level unique constraint manually or reset stock. After reviewing the target and the existing allocation data, use the tracked, data-preserving `../migrations/0004_order_id_allocation_boundary.sql` upgrade. It rebuilds only `reward_allocation`, preserves every allocation row and inventory quantity, and recreates the stock/legacy triggers with Order ID checks. Any production schema that differs from both the final 0003 and the specifically supported earlier 0003 shape needs a separately reviewed data-preserving migration.
