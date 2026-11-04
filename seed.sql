-- Physical reward stock is initialized idempotently by
-- migrations/0003_physical_reward_inventory.sql. No card deck is seeded.
-- Do not use this file to reset or replenish an existing inventory.
SELECT reward_id, initial_quantity, remaining_quantity, unit_value_paise, is_fallback
FROM reward_inventory
ORDER BY reward_id;
