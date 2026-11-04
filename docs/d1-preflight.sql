-- READ ONLY physical inventory/allocation checks. Run only after schema + migration 0003
-- on a database whose account, name and ID have been independently confirmed. Keep output private.
SELECT reward_id, reward_name, initial_quantity, remaining_quantity,
       unit_value_paise, is_fallback
FROM reward_inventory ORDER BY reward_id;

SELECT SUM(initial_quantity) AS configured_physical_units,
       SUM(remaining_quantity) AS remaining_physical_units,
       COUNT(*) AS physical_categories
FROM reward_inventory WHERE is_fallback = 0;

SELECT reward_id, COUNT(*) AS allocation_count
FROM reward_allocation GROUP BY reward_id ORDER BY reward_id;

SELECT COUNT(*) AS duplicate_auth_allocations
FROM (SELECT auth_id FROM reward_allocation GROUP BY auth_id HAVING COUNT(*) > 1);
SELECT COUNT(*) AS duplicate_order_allocations
FROM (SELECT order_id FROM reward_allocation GROUP BY order_id HAVING COUNT(*) > 1);
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

-- Each consumed physical unit must correspond to exactly one allocation row marked decremented.
SELECT i.reward_id, i.initial_quantity, i.remaining_quantity,
       COALESCE(SUM(CASE WHEN a.stock_decremented = 1 THEN 1 ELSE 0 END), 0) AS decremented_allocations,
       (i.initial_quantity - i.remaining_quantity) AS quantity_consumed
FROM reward_inventory i
LEFT JOIN reward_allocation a ON a.reward_id = i.reward_id
WHERE i.is_fallback = 0
GROUP BY i.reward_id, i.initial_quantity, i.remaining_quantity
HAVING COALESCE(SUM(CASE WHEN a.stock_decremented = 1 THEN 1 ELSE 0 END), 0)
       <> (i.initial_quantity - i.remaining_quantity);

-- New-format allocations should have their durable outbox record. Review any returned rows.
SELECT a.order_id, a.reward_id
FROM reward_allocation a
LEFT JOIN sheet_sync s ON s.order_id = a.order_id
WHERE s.order_id IS NULL;

-- Confirm allocation indexes/constraints and stock/legacy triggers after migration.
-- Expected: unique auth_id and order_id only. There must be no unique customer_key
-- or customer_email index. customer metadata may repeat across different orders.
SELECT type, name, tbl_name, sql
FROM sqlite_master
WHERE tbl_name IN ('reward_inventory', 'reward_allocation')
   OR name IN ('trg_reward_allocation_not_legacy_claimed', 'trg_legacy_deck_prevent_new_duplicate',
               'trg_legacy_deck_prevent_insert_duplicate', 'trg_reward_allocation_claim_stock')
ORDER BY type, name;

SELECT sync_state, COUNT(*) AS rows FROM sheet_sync GROUP BY sync_state;
SELECT COUNT(*) AS legacy_deck_rows FROM reward_deck;
SELECT COUNT(*) AS legacy_reward_slot_rows FROM envelope_auth WHERE reward_slot IS NOT NULL;
