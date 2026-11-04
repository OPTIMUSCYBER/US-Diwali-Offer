-- READ ONLY — run after tracked production migrations 0001 and 0002 complete.
-- Confirm the target database identity independently before running. No rows are changed.

SELECT type, name, tbl_name, sql
FROM sqlite_master
WHERE type IN ('table', 'index', 'trigger')
  AND (name IN ('redemptions', '_cf_KV', 'reward_deck', 'envelope_auth', 'envelope_customer',
                'envelope_customer_issue', 'sheet_sync', 'reward_inventory', 'reward_allocation')
       OR name LIKE 'idx_reward_%'
       OR name LIKE 'idx_envelope_%'
       OR name LIKE 'idx_sheet_%'
       OR name LIKE 'trg_reward_%'
       OR name LIKE 'trg_legacy_%')
ORDER BY type, name;

-- The cleanup is separate. It should leave the table present and empty before launch.
SELECT COUNT(*) AS redemptions_remaining FROM redemptions;

SELECT reward_id, reward_name, initial_quantity, remaining_quantity,
       unit_value_paise, is_fallback
FROM reward_inventory ORDER BY reward_id;

SELECT COUNT(*) AS physical_categories,
       SUM(initial_quantity) AS configured_physical_units,
       SUM(remaining_quantity) AS remaining_physical_units
FROM reward_inventory
WHERE is_fallback = 0;

SELECT COUNT(*) AS unlimited_fallback_rows
FROM reward_inventory
WHERE reward_id = 'BETTER_LUCK'
  AND is_fallback = 1
  AND initial_quantity IS NULL
  AND remaining_quantity IS NULL;

SELECT COUNT(*) AS invalid_finite_stock_rows
FROM reward_inventory
WHERE is_fallback = 0
  AND (initial_quantity IS NULL OR remaining_quantity IS NULL
       OR typeof(initial_quantity) <> 'integer' OR typeof(remaining_quantity) <> 'integer'
       OR remaining_quantity < 0 OR remaining_quantity > initial_quantity);

SELECT COUNT(*) AS duplicate_order_allocations
FROM (SELECT order_id FROM reward_allocation GROUP BY order_id HAVING COUNT(*) > 1);
SELECT COUNT(*) AS duplicate_auth_allocations
FROM (SELECT auth_id FROM reward_allocation GROUP BY auth_id HAVING COUNT(*) > 1);

SELECT a.order_id, a.reward_id
FROM reward_allocation a LEFT JOIN sheet_sync s ON s.order_id = a.order_id
WHERE s.order_id IS NULL;
