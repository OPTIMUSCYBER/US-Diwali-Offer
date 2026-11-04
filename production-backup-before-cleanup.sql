PRAGMA defer_foreign_keys=TRUE;
CREATE TABLE redemptions (     order_id TEXT PRIMARY KEY,     redeemed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP );
INSERT INTO "redemptions" ("order_id","redeemed_at") VALUES('262203','2026-10-31 11:04:05');
INSERT INTO "redemptions" ("order_id","redeemed_at") VALUES('262153','2026-10-31 11:06:35');
INSERT INTO "redemptions" ("order_id","redeemed_at") VALUES('262232','2026-10-31 12:06:09');
INSERT INTO "redemptions" ("order_id","redeemed_at") VALUES('262193','2026-10-31 12:08:57');
INSERT INTO "redemptions" ("order_id","redeemed_at") VALUES('262185','2026-10-31 12:09:46');
INSERT INTO "redemptions" ("order_id","redeemed_at") VALUES('263105','2026-11-02 05:10:05');
