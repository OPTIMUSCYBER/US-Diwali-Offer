-- READ ONLY. Use only when sqlite_master confirms reward_inventory exists but
-- reward_allocation does not. This file deliberately does not query reward_allocation.
-- Confirm account, database name and database ID before running; keep output private.
SELECT type, name, tbl_name, sql
FROM sqlite_master
WHERE type IN ('table', 'index', 'trigger')
  AND name IN ('reward_inventory', 'trg_reward_allocation_claim_stock')
ORDER BY type, name;

SELECT reward_id, reward_name, initial_quantity, remaining_quantity,
       unit_value_paise, is_fallback
FROM reward_inventory ORDER BY reward_id;

SELECT SUM(initial_quantity) AS configured_physical_units,
       SUM(remaining_quantity) AS remaining_physical_units,
       COUNT(*) AS physical_categories
FROM reward_inventory WHERE is_fallback = 0;

SELECT COUNT(*) AS invalid_finite_stock_rows
FROM reward_inventory
WHERE is_fallback = 0
  AND (initial_quantity IS NULL OR remaining_quantity IS NULL
       OR typeof(initial_quantity) <> 'integer' OR typeof(remaining_quantity) <> 'integer'
       OR remaining_quantity < 0 OR remaining_quantity > initial_quantity);

SELECT COUNT(*) AS invalid_fallback_rows
FROM reward_inventory
WHERE is_fallback = 1
  AND (initial_quantity IS NOT NULL OR remaining_quantity IS NOT NULL);
