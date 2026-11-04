-- READ ONLY. Use only when sqlite_master confirms reward_allocation exists but
-- reward_inventory does not. This file deliberately does not query reward_inventory.
-- Confirm account, database name and database ID before running; keep output private.
SELECT type, name, tbl_name, sql
FROM sqlite_master
WHERE type IN ('table', 'index', 'trigger')
  AND (name = 'reward_allocation' OR name LIKE 'idx_reward_allocation%' OR name LIKE 'trg_reward_allocation%')
ORDER BY type, name;

SELECT id, auth_id, order_id, customer_key, customer_email, reward_id,
       stock_decremented, allocated_at
FROM reward_allocation ORDER BY id;

SELECT auth_id, COUNT(*) AS duplicate_count FROM reward_allocation
GROUP BY auth_id HAVING COUNT(*) > 1;
SELECT order_id, COUNT(*) AS duplicate_count FROM reward_allocation
GROUP BY order_id HAVING COUNT(*) > 1;

-- Repeated customer metadata is permitted when orders differ.
SELECT customer_key, COUNT(*) AS order_count FROM reward_allocation
GROUP BY customer_key HAVING COUNT(*) > 1;
SELECT customer_email, COUNT(*) AS order_count FROM reward_allocation
WHERE customer_email IS NOT NULL GROUP BY customer_email HAVING COUNT(*) > 1;
