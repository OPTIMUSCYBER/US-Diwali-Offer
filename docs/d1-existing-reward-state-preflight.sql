-- READ ONLY. Run ONLY if sqlite_master confirms BOTH reward_inventory AND
-- reward_allocation exist. If only one exists, use the matching split preflight:
-- d1-existing-inventory-preflight.sql or d1-existing-allocation-preflight.sql.
-- Confirm the target database ID first. This output contains order/customer identifiers.
SELECT type, name, tbl_name, sql
FROM sqlite_master
WHERE type IN ('table', 'index', 'trigger')
  AND (name LIKE '%reward%' OR name LIKE '%allocation%' OR name LIKE '%sheet_sync%')
ORDER BY type, name;

SELECT reward_id, reward_name, initial_quantity, remaining_quantity, unit_value_paise, is_fallback
FROM reward_inventory ORDER BY reward_id;

SELECT reward_id, COUNT(*) AS allocation_rows,
       SUM(stock_decremented = 1) AS finite_decrements
FROM reward_allocation GROUP BY reward_id ORDER BY reward_id;

SELECT a.id, a.auth_id, a.order_id, a.customer_key, a.customer_email, a.reward_id,
       a.stock_decremented, a.allocated_at
FROM reward_allocation a ORDER BY a.id;

SELECT auth_id, COUNT(*) AS duplicate_count FROM reward_allocation
GROUP BY auth_id HAVING COUNT(*) > 1;
SELECT order_id, COUNT(*) AS duplicate_count FROM reward_allocation
GROUP BY order_id HAVING COUNT(*) > 1;
-- Repeated customer_key/email across different Order IDs is expected under the
-- approved order-level policy. It is useful audit information, not an anomaly.
SELECT customer_key, COUNT(*) AS order_count FROM reward_allocation
GROUP BY customer_key HAVING COUNT(*) > 1;
SELECT customer_email, COUNT(*) AS order_count FROM reward_allocation
WHERE customer_email IS NOT NULL GROUP BY customer_email HAVING COUNT(*) > 1;

SELECT i.reward_id, i.initial_quantity, i.remaining_quantity,
       COALESCE(SUM(CASE WHEN a.stock_decremented = 1 THEN 1 ELSE 0 END), 0) AS decremented_allocations
FROM reward_inventory i LEFT JOIN reward_allocation a ON a.reward_id = i.reward_id
WHERE i.is_fallback = 0
GROUP BY i.reward_id, i.initial_quantity, i.remaining_quantity
HAVING COALESCE(SUM(CASE WHEN a.stock_decremented = 1 THEN 1 ELSE 0 END), 0)
       <> (i.initial_quantity - i.remaining_quantity);

SELECT a.order_id, a.reward_id
FROM reward_allocation a LEFT JOIN sheet_sync s ON s.order_id = a.order_id
WHERE s.order_id IS NULL;

SELECT order_id, sync_state, attempts, next_attempt_at, last_error
FROM sheet_sync WHERE sync_state = 'pending' ORDER BY next_attempt_at;
