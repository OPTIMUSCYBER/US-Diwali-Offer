-- DESTRUCTIVE, MANUAL, ONE-TIME OPERATION — NOT A MIGRATION.
--
-- No BEGIN/COMMIT: D1 uses auto-commit and explicit transaction control may be rejected
-- by Console/query execution. The DELETE is one atomic statement. A mismatch deletes zero.
--
-- Required table definition: order_id TEXT PRIMARY KEY and
-- redeemed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, exactly those two columns.
-- Required row set: exactly 262153, 262185, 262193, 262203, 262232, 263105.
-- The statements below preserve redemptions and never touch _cf_KV.

DELETE FROM redemptions
WHERE (SELECT COUNT(*) FROM redemptions) = 6
  AND (SELECT COUNT(*) FROM pragma_table_info('redemptions')) = 2
  AND (SELECT COUNT(*) FROM pragma_table_info('redemptions')
       WHERE name = 'order_id' AND upper(type) = 'TEXT' AND pk = 1
         AND "notnull" = 0 AND dflt_value IS NULL) = 1
  AND (SELECT COUNT(*) FROM pragma_table_info('redemptions')
       WHERE name = 'redeemed_at' AND upper(type) = 'TEXT' AND "notnull" = 1
         AND dflt_value = 'CURRENT_TIMESTAMP' AND pk = 0) = 1
  AND (SELECT COUNT(*) FROM redemptions
       WHERE order_id IN ('262153','262185','262193','262203','262232','263105')) = 6
  AND (SELECT COUNT(DISTINCT order_id) FROM redemptions) = 6
  AND order_id IN ('262153','262185','262193','262203','262232','263105');

SELECT CASE changes()
  WHEN 6 THEN 'DELETED_EXACTLY_SIX_APPROVED_TEST_REDEMPTIONS'
  ELSE 'STOP_AND_REQUIRE_MANUAL_REVIEW'
END AS cleanup_status;
