-- READ ONLY — actual production D1 preflight.
-- Confirm the target is uss-diwali-redemptions / the dashboard-confirmed database ID
-- before running. This file never changes _cf_KV, redemptions, or any other object.

SELECT type, name, tbl_name, sql
FROM sqlite_master
WHERE type IN ('table', 'index', 'trigger')
ORDER BY type, name;

-- Expected before cleanup: exactly six owner-confirmed test rows. Any other count is a STOP.
SELECT COUNT(*) AS redemptions_count FROM redemptions;
SELECT order_id, redeemed_at FROM redemptions ORDER BY order_id;

-- Expected existing application-table columns. Review manually; do not infer safety
-- merely from a matching row count.
SELECT cid, name, type, "notnull", dflt_value, pk
FROM pragma_table_info('redemptions')
ORDER BY cid;

-- _cf_KV is Cloudflare internal state. It is inspected only through sqlite_master above
-- and must never be modified or deleted by this project.
