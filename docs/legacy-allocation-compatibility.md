# Legacy allocation compatibility

This document applies only to an older database that already has `reward_deck` and/or
`envelope_auth.reward_slot` history. The confirmed production database for this release has
only `_cf_KV` and six test rows in `redemptions`; it uses the separate
`migrations/production/` bootstrap path and does not import coupon-era history.

## What an existing customer sees

Legacy rewards are records in `reward_deck`, commonly with a coupon-era `reward_id`; older authorizations may also retain `envelope_auth.reward_slot`. Migration `0003_physical_reward_inventory.sql` does not rewrite, delete, translate, or count those coupon-era rewards as physical inventory.

When a returning customer submits the existing WordPress Order ID + registered mobile form, the Worker still fetches and validates the WooCommerce order. It compares **that Order ID only** to claimed `reward_deck` rows. If that same order is found, `/authorize` returns `AUTH_ALREADY_USED` (409), issues no handoff token, and the WordPress page shows its “already been opened” message. A pre-migration unused handoff for that order is refused by `/verify` with the same code. No new physical allocation is made. A different eligible Order ID from the same customer or email remains eligible for a new physical allocation.

If an already redeemed legacy opening session calls `/open`, the Worker sees the non-null legacy `reward_slot` before looking for a new-format allocation and returns `AUTH_ALREADY_USED` (409). It does not return the old coupon as if it were a physical gift. This remains fail-closed even if the referenced old deck row is missing. Support must review the retained old `reward_id`/slot history to answer what the original reward was; this code does not replay or renew expired coupon terms.

New-format saved physical rewards are different: `/open` replays the same `reward_allocation` response for the same Order ID and does not decrement stock again. A customer is never silently given a replacement for that same order, but a different eligible Order ID is independent by business rule.

## Database protections

- `reward_allocation` has unique `auth_id` and `order_id` only. `customer_key` and `customer_email` remain trusted audit metadata and have no unique constraint/index.
- A `BEFORE INSERT` trigger blocks a new-format claim only if the same Order ID already has a claimed legacy deck row.
- `BEFORE UPDATE` and `BEFORE INSERT` triggers on `reward_deck` block a still-running legacy writer only when it attempts to claim an Order ID already allocated in the new table.
- The stock trigger decrements only on a successful new finite-reward allocation and aborts at zero. Duplicate `INSERT OR IGNORE` does not decrement again.
- Migration seeds with `INSERT OR IGNORE`; reruns do not reset consumed stock. Existing legacy rows and old `reward_slot` values stay untouched.

## Required compatibility gate before production replacement

The repository no longer contains the old deployed Worker implementation, so the exact legacy writer query and production response behavior cannot be confirmed from this checkout. Before replacing it, inspect the deployed Worker/source history and confirm that its claim path writes the order ID to `reward_deck`. The guards cover both insert and update paths by Order ID, but do not prove the deployed old Worker supplies it.

Run the private, read-only `docs/d1-pre-migration-preflight.sql` against the manually confirmed database, preserve its output, and reconcile all claimed legacy rows and non-null `reward_slot` authorizations. If any legacy customer expects an old coupon replay, stop for a support-approved reconciliation process. Do not clear rows or map coupon IDs to physical reward IDs.

## Local regression evidence

Tests cover repeat migration preserving a claimed coupon-era deck row, same-Order-ID refusal, a different Order ID for the same customer succeeding, pre-migration handoff refusal at `/verify`, redeemed old session refusal at `/open`, orphaned `reward_slot` fail-closed behavior, and both legacy insert/update attempts blocked after a new allocation for the same order. These tests use SQLite locally; Cloudflare D1 and the deployed legacy Worker remain **NOT VERIFIED**.
