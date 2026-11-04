# Production deployment checklist — US Supplements Diwali Mystery Envelope 2026

This checklist records the current reported production database state and the remaining integration/deployment work. Production database completion below is based on the operator's confirmation; this local review did not connect to Cloudflare or independently inspect production.

## Current completion status

| Work item | Status | Evidence / boundary |
| --- | --- | --- |
| Production D1 preflight | **COMPLETE — operator-confirmed** | Preflight was completed for the confirmed database. This local task did not independently query Cloudflare. |
| Six approved test redemptions | **COMPLETE — operator-confirmed** | The six confirmed test rows were deleted. The `redemptions` table was preserved. |
| Production migration 0001 | **APPLIED — operator-confirmed** | Production envelope schema bootstrap. |
| Production migration 0002 | **APPLIED — operator-confirmed** | Physical inventory installation. |
| Production postflight | **PASSED — operator-confirmed** | Inventory reported 11 entries, including 216 finite physical units and one unlimited fallback. |
| Local trigger tests | **PASS** | 8/8 isolated local SQLite/D1-shim integration checks. |
| Full local test suite | **PASS** | 94/94 passed, 0 failed, 0 skipped (2026-11-04). |
| Production Worker secrets | **VERIFIED BY NAME — 2026-11-04** | `wrangler secret list` shows all four names. Values not read. |
| Apps Script deployment/configuration | **PENDING** | Deployment and Script Properties still require verification. |
| Live Google Sheets verification | **PENDING / NOT TESTED** | Local tests use mocks only. |
| WordPress configuration | **PENDING — shortcode not installed** | `/diwali/` → `/home/diwali-unlock/` runs a custom snippet (Worker root `/`, placeholder envelope URL, static `DIWALI2026` code). |
| Pages deployment | **PENDING — live site is the old coupon build** | Live production deployment `4a08da33-09ab-4b8d-9537-fe14e273d2c9` differs from `cloudflare-pages-deploy/index.html`. |
| Worker deployment | **PENDING — live Worker is an older build** | Active version `75694b1a-e915-478c-8b8f-1614be9b81e6`; its `/status` response does not match `worker.js`. |
| Live integration testing | **PENDING / NOT PASSED** | No claim of production integration success. |

The reported D1 work is distinct from Worker, Apps Script, Sheets, WordPress, Pages, and live customer-flow integration. Database migration completion alone does not establish that those integrations work.

## Confirmed production configuration

| Item | Confirmed value |
| --- | --- |
| Worker name | `uss-diwali-auth-2026` |
| Worker URL | `https://uss-diwali-auth-2026.822005harsh.workers.dev` |
| D1 binding | `DB` |
| D1 name | `uss-diwali-redemptions` |
| D1 ID | `7e58a497-e28c-4c05-9d28-05aeaf1c3b58` |
| Pages URL | `https://us-supplements-diwali.pages.dev/` |
| WordPress entry | `https://ussupplements.in/diwali/` |

The production database inspection reported `_cf_KV` and `redemptions(order_id TEXT PRIMARY KEY, redeemed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)`. The six owner-confirmed test rows have since been deleted per operator confirmation. The table remains; `_cf_KV` must never be modified or deleted. Production migrations 0001 and 0002 and postflight are reported complete. Do not repeat cleanup or migrations unless a fresh preflight and change plan explicitly require it.

## Approved behavior to preserve

- WordPress remains the only customer authentication page: Order ID + registered mobile.
- Worker verifies the order against WooCommerce, creates a short-lived one-time handoff, and Pages silently verifies the token after URL-fragment scrubbing.
- One allocation per eligible **Order ID**. A different eligible order belonging to the same customer is independent.
- Campaign order dates are 6–7 November 2026 IST; product value after product refunds is strictly above ₹1,500; INR and `processing`/`completed` only. Tax, shipping, and shipping refunds are excluded.
- Opening is 9 November 2026 00:00 IST inclusive; closing is 10 November 2026 00:00 IST exclusive. No new allocation after close; a saved reward can replay.
- Physical inventory is exactly 216 gifts. Better Luck is the unlimited fallback.

## Production migration files

`wrangler.toml` intentionally uses `migrations_dir = "migrations/production"`. Therefore the only production migrations Wrangler discovers are:

1. `migrations/production/0001_create_envelope_schema.sql` — creates the Worker-required envelope tables, indexes, and triggers. It does not modify `_cf_KV` or `redemptions`.
2. `migrations/production/0002_install_physical_reward_inventory.sql` — inserts the approved inventory with `INSERT OR IGNORE`; it never resets remaining quantities.

Do **not** run the historical generic files `migrations/0002_reward_inventory_and_sheets_sync.sql`, `migrations/0003_physical_reward_inventory.sql`, or `migrations/0004_order_id_allocation_boundary.sql` against this production database. They are retained for legacy/local compatibility and have different prerequisites.

## Remaining manual integration and deployment sequence

The production D1 preflight, approved cleanup, tracked migrations, and postflight are reported complete. The following are remaining tasks only. Confirm account and resource identities before any Cloudflare action, and keep query output private because it may include order IDs.

1. Preserve the existing database backup/change record for the completed migration. Do not rerun cleanup or migrations as part of integration setup.

2. Set Worker secrets interactively; never add values to TOML, HTML, or documentation:

   ```powershell
   npx wrangler secret put SESSION_SECRET --config ./wrangler.toml
   npx wrangler secret put WC_CONSUMER_KEY --config ./wrangler.toml
   npx wrangler secret put WC_CONSUMER_SECRET --config ./wrangler.toml
   npx wrangler secret put WORKER_SYNC_SECRET --config ./wrangler.toml
   ```

   Confirm the Apps Script deployment URL and its private `WORKER_SYNC_SECRET`/`SPREADSHEET_ID` properties separately. The Worker sends only the secret plus the five record fields; D1 remains authoritative and retries the same outbox row. If the Sheets URL or Worker sync secret is missing, the pending outbox row records a configuration error, remains unsynced, and receives the normal retry backoff. Verify the settings before deployment; the local case was tested only with the SQLite shim.
3. Verify the production Apps Script deployment URL, deploy the reviewed production Apps Script source if still required, set its Script Properties privately, and confirm the five existing sheet columns without clearing rows.
4. Verify the live WordPress `[usd_diwali_auth]` shortcode and its Worker/Pages constants. The customer entry remains `https://ussupplements.in/diwali/`.
5. Deploy the Worker and existing Pages project only after secrets, Apps Script configuration, exact origins, and WordPress configuration are verified. The Pages URL remains `https://us-supplements-diwali.pages.dev/`.
6. Run live integration testing only under the controlled procedure below. Until completed, record live Sheets and end-to-end integration as **NOT TESTED**.

## Rollback and recovery

- Before mutation, preserve the export and record the Time Travel bookmark privately.
- If tracked migration apply fails, stop: Cloudflare rolls back the failing migration. Do not replace it with `d1 execute --file`.
- If a successful migration must be reverted, use the approved Cloudflare backup/Time Travel procedure with the recorded bookmark. Do not drop Worker tables, reset inventory, or edit allocations manually.
- `redemptions` is retained permanently unless its separate deletion receives explicit approval. This project does not drop it.

## Production versus staging

`wrangler.staging.toml` remains a separate configuration with a separate D1 placeholder, origins, Worker name, Apps Script URL, WooCommerce source, and secrets. Never point staging at the production database, Pages origin, WordPress page, Sheet, Apps Script deployment, or secret values.

## Controlled live verification

Authorization and Pages handoff may be observed without allocating inventory. `/open` is the first allocation call and may consume one physical gift; it cannot be forced to Better Luck. Test it only during the approved window using one existing, owner-approved eligible order, after recording private baseline inventory/allocation/outbox counts. Verify exactly one allocation and one Sheets outbox row for that order, then verify replay returns the same reward without another decrement.

## Local versus live status

Production D1 preflight, cleanup, migrations 0001/0002, and postflight are **operator-reported complete**. Local tests pass 90/90, and production trigger tests pass 8/8 in isolated SQLite. Scheduled cleanup tests cover the seven-day expiry, associated customer/issue deletion, allocated-auth protection, and atomic rollback. Missing Sheets configuration is recorded and retried locally; normal sync/retry remains mock-tested. Production Worker deployment/secrets, WooCommerce, WordPress configuration, Apps Script deployment, Google Sheets writes/retries, Pages deployment, browser CORS/visual behavior, and live customer-flow testing remain **PENDING / NOT VERIFIED**. No production integration test is claimed as passed.

## Approval-gated runbook (prepared 2026-11-04; nothing below has been executed)

Each step needs explicit owner approval at the time it is run. Do not run any `d1 execute` or migration command; production D1 is already prepared.

**Rollback targets recorded 2026-11-04**
- Worker: active version `75694b1a-e915-478c-8b8f-1614be9b81e6` → `npx wrangler rollback 75694b1a-e915-478c-8b8f-1614be9b81e6 --config ./wrangler.toml`
- Pages: production deployment `4a08da33-09ab-4b8d-9537-fe14e273d2c9` → Cloudflare dashboard → Workers & Pages → `us-supplements-diwali` → Deployments → that deployment → *Rollback to this deployment*.
- WordPress: copy the current `/home/diwali-unlock/` page content (the custom HTML block) into a private file before replacing it.
- D1: preserved SQL backup and Time Travel bookmark; never restore without owner approval.

**A. Apps Script (owner, in the Apps Script editor of the project behind the `wrangler.toml` URL)**
1. Project Settings → Script Properties: confirm `SPREADSHEET_ID` points to the existing spreadsheet and `WORKER_SYNC_SECRET` holds the same value already stored in the Worker. Enter values directly in the editor; never paste them into chat. Do not generate a new secret.
2. In that spreadsheet confirm a tab named exactly `Redemption Records` whose row 1 is `Order ID | Name | Phone Number | Reward Type | Envelope Result` and that has no data beyond column E (otherwise the script refuses with `INVALID_HEADERS` / `UNEXPECTED_SHEET_STRUCTURE`). Do not clear or rename anything; if the layout differs, stop and decide with the developer.
3. Replace the editor's `Code.gs` with the reviewed `apps-script/Code.gs`, then Deploy → Manage deployments → edit the **existing** deployment → Version: *New version* → Execute as: *Me* → Who has access: *Anyone*. Editing the existing deployment keeps the `/exec` URL in `wrangler.toml`.

**B. Worker** — `npx wrangler deploy --config ./wrangler.toml` (keeps the `*/5 * * * *` cron, D1 binding, vars and existing secrets). Verify: `curl -s https://uss-diwali-auth-2026.822005harsh.workers.dev/api/envelope/status -H "Origin: https://us-supplements-diwali.pages.dev"` returns `{"success":true,"state":"not_started"}` before 9 Nov, and `npx wrangler deployments list` shows the new version. Deploying the Worker before WordPress is switched makes the current custom WP snippet (which POSTs to `/`) show its generic "could not verify" error; it currently leads nowhere anyway.

**C. Pages** — `npx wrangler pages deploy cloudflare-pages-deploy --project-name us-supplements-diwali --branch main`. Verify the live HTML contains `LOCKED:` and `physical: { icon: 'gift'` and no `usd-reward__code`.

**D. WordPress** — install `wp-envelope-auth.php` (Code Snippets, *Run everywhere*), add `USD_DIWALI_API_BASE` = `https://uss-diwali-auth-2026.822005harsh.workers.dev` and `USD_DIWALI_ENVELOPE_URL` = `https://us-supplements-diwali.pages.dev/` to `wp-config.php`, then replace the custom block on `/home/diwali-unlock/` with `[usd_diwali_auth]`. Keep the `/diwali/` redirect. Verify before 9 Nov that submitting a real order shows "The envelope opens on 9 November 2026" (the Worker refuses before launch; nothing is allocated).

**E. Live test (9 Nov, in window, owner-approved order only)** — record baseline inventory/allocation/outbox counts privately; run one owner-approved eligible order end to end; confirm one allocation, one stock decrement (unless Better Luck), one `sheet_sync` row reaching `synced`, one sheet row; replay the same order (same reward, no decrement); if available, a second eligible order from the same customer allocates independently. If a row stays pending, its `last_error` code identifies the cause (see the final report).
