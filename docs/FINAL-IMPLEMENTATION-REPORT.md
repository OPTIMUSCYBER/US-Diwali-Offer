# Final implementation report — US Supplements Diwali Mystery Envelope 2026

## Audit of 2026-11-04 (supersedes older status lines below where they conflict)

### Live production state — read-only evidence gathered 2026-11-04

| Component | Finding | Evidence |
| --- | --- | --- |
| Cloudflare account | `822005harsh@gmail.com's Account` (`40f42ad836594cb8586ad632ef0fc11c`) | `wrangler whoami` |
| Worker secrets | **All four names present:** `SESSION_SECRET`, `WC_CONSUMER_KEY`, `WC_CONSUMER_SECRET`, `WORKER_SYNC_SECRET` (values never read) | `wrangler secret list` |
| Live Worker code | **Not this repository's `worker.js`.** `GET /api/envelope/status` returns `{"success":true,"message":"US Supplements Diwali verification service is running."}` with no `state` and none of the local security headers. | `curl` of the live endpoint |
| Live Worker version (rollback target) | Active `75694b1a-e915-478c-8b8f-1614be9b81e6` (2026-11-03 secret change on top of the 2026-11-02 upload `a801d9ff-4402-414f-baab-3c0b76a4b657`) | `wrangler deployments list` |
| Live Pages | **Old coupon-era build** (coupon code UI, `sold_out` "All 2,000 envelopes", eligibility copy "6–8 November … above ₹2,500"). Not the local `cloudflare-pages-deploy/index.html`. | `curl` + diff (155 diff lines) |
| Pages project / rollback target | `us-supplements-diwali`, production branch `main`, current production deployment `4a08da33-09ab-4b8d-9537-fe14e273d2c9` (direct upload) | `wrangler pages deployment list` |
| Live WordPress | `/diwali/` 301-redirects to `/home/diwali-unlock/`. That page runs a **custom inline snippet, not `[usd_diwali_auth]`**: it POSTs `{orderId, phone}` to the Worker root `/`, its `ENVELOPE_PAGE_URL` is still `https://ussupplements.in/REPLACE-WITH-ENVELOPE-PAGE-SLUG/`, it accepts only 6-digit Order IDs, and on success shows a **static code `DIWALI2026`**. It never issues a handoff token. | public page fetch, decoded inline script |
| Apps Script Web App | URL in `wrangler.toml` responds to anonymous GET with `Script function not found: doGet` — deployed, publicly reachable, no `doGet` (consistent with `Code.gs`). Deployed source version and Script Properties **not verified**. | `curl` GET (no POST sent) |
| Apps Script editor source (owner-supplied 2026-11-04) | Older script: hard-coded spreadsheet ID (`1wRe7Hyf…zgw_E`), sheet `Redemption Records`, only `WORKER_SYNC_SECRET` read from Script Properties, `appendRow`. It returns `MISSING_NAME`/`MISSING_PHONE` for empty fields (a customer with no billing name would stay pending forever). Any existing Order ID gets `duplicate: true` without comparing the data, so there is no conflict detection and no reward validation. Manifest: `executeAs USER_DEPLOYING`, `access ANYONE_ANONYMOUS`, V8, Asia/Kolkata — correct for the Worker; keep it. It is not yet confirmed that this editor source is the deployed version. | Owner paste |
| Google Sheet | The spreadsheet ID referenced in tests is **not visible** to the Google Drive account connected to this session; no Diwali/Redemption files found there. Spreadsheet, sheet name `Redemption Records` and headers **not verified**. | Drive metadata lookup |
| Production D1 | Operator-reported complete (cleanup, 0001, 0002, postflight). **Not re-queried** in this audit (no production SQL run). | — |

**Update 2026-11-04 09:45 UTC:** the owner deployed this repository's `worker.js` to `uss-diwali-auth-2026` (version `1b4d17b2-b034-4f37-8308-45321775e0bf`); non-mutating live checks passed (see checklist). A second Worker `us-diwali-offer`, bound to production D1 with no secrets and not used by Pages/WordPress, was also found; its future is an owner decision.

**Consequence (as of the read-only audit, before the Worker deploy):** none of the new flow is live yet. Before 9 November 2026 00:00 IST the Worker and Pages must be deployed from this repository and the WordPress page must be switched to `[usd_diwali_auth]`; otherwise customers on the live page receive a static code and no envelope link.

### Fixes made locally on 2026-11-04 (not deployed)

1. **Apps Script retry idempotency (`apps-script/Code.gs`, staging copy synced).** `safeCell_` prefixes values starting with `= + - @` with an apostrophe; Google Sheets can hide that prefix, so an exact retry of a record whose phone starts with `+91` was compared against the un-prefixed display value and returned `ORDER_ID_CONFLICT` forever (the Worker would retry every 6 h without ever syncing). Duplicate comparison now ignores that protection apostrophe on both sides. A regression run against the previous code reproduced `ORDER_ID_CONFLICT`; the fixed code returns `duplicate: true`. Conflicting data is still rejected.
2. **Sheets sync diagnostics (`worker.js`).** `last_error` was always `SYNC_FAILED`. It now records `SHEETS_HTTP_<status>`, `SHEETS_HTTP_<status>_NON_JSON` (e.g. a Google sign-in page = wrong Web App access setting), `SHEETS_REJECTED_<APPS_SCRIPT_ERROR>` (e.g. `UNAUTHORIZED` = secret mismatch, `SHEET_NOT_FOUND`, `INVALID_HEADERS`, `ORDER_ID_CONFLICT`), `SHEETS_ACK_ORDER_MISMATCH` or `SHEETS_TIMEOUT`. Codes never contain secrets, URLs or customer data.
3. **`/open` no longer waits on Apps Script (`worker.js`).** The reward response previously awaited the Sheets POST (up to 8 s). With a Workers execution context the sync now runs via `ctx.waitUntil`; the cron still retries anything pending. Allocation, stock and outbox writes are unchanged and still happen before the response.
4. **Pages dead ends (`Index.html`, both Pages copies).** Lock-screen errors told customers to "authenticate again" with no link, a direct visit showed "This key doesn't open the door", and retryable verify errors kept the token but offered no retry. Every stopped state now shows **Try again** (same key, only for network/timeout/server/rate-limit errors) or **Enter your Order ID** (link to `https://ussupplements.in/diwali/`). A direct visit now reads "Your envelope is waiting". Existing visual classes are reused.
5. **WordPress shortcode copy (`wp-envelope-auth.php`).** `CAMPAIGN_CLOSED` said "All the Diwali envelopes have been opened" (inaccurate — closure is time-based and Better Luck is unlimited); it now states the campaign closed at midnight after 9 November 2026. Back-button (bfcache) restores no longer leave the submit button disabled. Removed the unused `ENTRY_CLOSED` message.

Campaign dates, thresholds, statuses, financial rules, inventory quantities and migrations were **not changed**.

### Local verification 2026-11-04

`npm test`: **94 passed, 0 failed, 0 skipped** (90 previous + 4 new regressions). `node --check` passed for `worker.js`, `tests/worker.test.mjs`, `tests/apps-script.test.mjs`, `tests/d1-shim.mjs`; `apps-script/Code.gs` parsed with `vm.Script`. `git diff --check` is not meaningful: the repository has no commits, so every file is untracked. PHP lint and browser visual QA remain **not performed** (no PHP runtime / headless browser).

### Audit notes (no change made)

- Before 9 Nov, `/authorize` returns `CAMPAIGN_NOT_STARTED`, so the full live flow can only be exercised in the campaign window. Authorization after close is refused, so saved-reward replay after close works only within an existing session.
- Allocation is weighted by remaining stock, so Better Luck is only drawn after all 216 physical units are allocated (approved behaviour).
- Optional edge rate limiters remain disabled; wrong-phone attempts are not counted by the per-order D1 cap, so each costs one WooCommerce API call. Enabling `AUTH_LIMITER` is recommended.
- Refunds with an amount but no product or shipping lines fail closed (order treated as ineligible) per the fail-closed rule.


## Status (pre-2026-11-04 wording, retained for history)

**COMPLETE —** local reward-system implementation, synchronization logic, frontend copies, migration and documentation are saved in this project. Local tests and JavaScript parsing passed as recorded below.

**NOT VERIFIED —** no Cloudflare account, D1 database, live Worker, WordPress, WooCommerce, Apps Script deployment, Google Sheet or production browser integration was accessed. Local tests use SQLite and mocks. This report does not certify production readiness.

**PENDING —** production deployment and live integration testing remain pending. Production D1 preflight, the approved six-row cleanup, migrations 0001/0002, and postflight are operator-reported complete; this local review does not independently verify those operations. Configure private Worker/Apps Script secrets and complete the remaining deployment checklist in a controlled sequence.

## Final rules and reward inventory

- Eligible orders were placed between 6 and 8 November 2026 (Asia/Kolkata), use INR, have `processing`, `completed`, `shipped`, `partially-shipped` or `partial-shipped` status, and have discounted product value after applicable product refunds strictly above ₹1,500. Product tax, shipping and shipping refunds are excluded. Malformed or incomplete required data fails closed.
- The participation window is 9 November 2026 00:00 IST inclusive through 10 November 2026 00:00 IST exclusive. The allocation boundary is enforced in SQL; already saved allocations can replay.
- The additive inventory migration initializes the ten physical categories at exactly 216 units. The Worker selects randomly from remaining units on the server; database uniqueness, triggers and the allocation/outbox batch protect stock and retries. **One WooCommerce Order ID is the allocation boundary.** `auth_id` and `order_id` are unique; trusted customer key/email are non-unique audit metadata, so a second eligible order from the same customer can participate independently. Better Luck Next Time is the unlimited fallback. No coupon reward deck is used for new allocations.
- Legacy coupon-era allocations are retained, not translated. A claimed legacy **Order ID** receives `AUTH_ALREADY_USED` at `/authorize`; old handoffs for that order are blocked at `/verify`; old redeemed sessions are blocked at `/open` before reward lookup, including orphaned non-null `reward_slot` markers. They receive no replacement physical reward and no old coupon is presented as a physical gift. A different eligible order belonging to the same customer is not blocked. Support must reconcile any historical result from its preserved deck row.
- `migrations/0004_order_id_allocation_boundary.sql` is a data-preserving upgrade only for the earlier local 0003 schema that made `customer_key`/non-null email unique. It rebuilds `reward_allocation`, preserves allocation rows and inventory quantities, and recreates order-only triggers. It must be applied only through tracked D1 migrations after schema and migration-history preflight; it is not a direct `d1 execute` script.

## Files inspected

`worker.js`, `wp-envelope-auth.php`, `Index.html`, `cloudflare-pages-deploy/index.html`, `cloudflare-pages-staging/index.html`, `schema.sql`, `seed.sql`, all migration SQL, both Wrangler configs, both Apps Script sources, all test files, `README.md`, and the eligibility, inventory, staging, preflight and deployment documentation.

## Implementation files

- Backend and database: `worker.js`, historical/local compatibility migrations, and production-only tracked bootstrap migrations `migrations/production/0001_create_envelope_schema.sql` and `migrations/production/0002_install_physical_reward_inventory.sql`.
- Public page copies: `Index.html`, `cloudflare-pages-deploy/index.html`, `cloudflare-pages-staging/index.html`.
- Sync: `apps-script/Code.gs`, `apps-script-staging/Code.gs`.
- Configuration: `wrangler.toml`, `wrangler.staging.toml`.
- Local checks: `tests/worker.test.mjs`, `tests/apps-script.test.mjs`.
- Operator documentation: `README.md`, `docs/eligibility-rules.md`, `docs/reward-inventory.md`, `docs/testing.md`, `docs/cloudflare-staging.md`, generic/local preflights, and production-specific `docs/production-d1-preflight.sql`, `docs/production-d1-cleanup-six-test-redemptions.sql`, `docs/production-d1-postflight.sql`, `docs/PRODUCTION-DEPLOYMENT-CHECKLIST.md`, `docs/FINAL-IMPLEMENTATION-REPORT.md`.

There is no initialized Git index in this project folder, so a reliable baseline diff/status is unavailable. The list above describes the implementation files that were inspected and finalized; it is not a claim that every listed file changed in this final pass.

## Verified locally

- `npm test` (before 2026-11-04): **90 passed, 0 failed, 0 skipped**; see the 2026-11-04 audit for the current 94/94 (Node test runner; in-memory SQLite D1 shim and mocked WooCommerce/Apps Script requests).
- `node --check worker.js`, `node --check tests/worker.test.mjs`, `node --check tests/d1-shim.mjs`, and `node --check tests/apps-script.test.mjs`.
- Apps Script source parsing and tested behaviors run through `vm` with mocked Google services in the suite. Frontend inline JavaScript parsing is also covered by tests for all three HTML files.
- Migration tests cover the confirmed production starting shape (`_cf_KV` and `redemptions`), guarded six-row cleanup, production bootstrap/inventory installation, historical compatibility paths, exact inventory totals, atomic failure rollback, duplicate requests, retries, and concurrent allocations. Allocation regressions prove the same Order ID replays without stock loss, while different eligible orders sharing a customer ID or email allocate independently.
- Inventory constraints reject null or fractional finite quantities, constrain remaining stock to its initial stock, and require the unlimited fallback quantities to remain null.
- Generic and production preflight/postflight SQL were executed locally against the SQLite shim in their respective simulated schemas. This proves local SQL syntax/query behavior only.
- Apps Script request validation now requires exactly the shared secret plus five string record fields; duplicate identical rows are idempotent, conflicts reject, and cell values are formula-protected. Outbox retry and redirect behavior are still tested with mocks only.
- Scheduled authorization cleanup uses a seven-day cutoff and atomically removes eligible unused/unallocated auth rows together with their customer and issue records. Allocations are explicitly excluded even if an authorization has a null `redeemed_at`. Local tests cover preservation and rollback. Missing Sheets URL or sync secret is written as a configuration error on the pending outbox row and schedules the existing backoff; it remains unsynced. These scheduled-handler checks use the local SQLite D1 shim only.
- Eligibility tests include November 6/7/8, threshold boundaries, refunds, tax/shipping exclusion, malformed data, currency/status, and campaign IST boundaries.
- Security tests cover mobile verification, missing configuration, handoff expiry/replay/browser binding, unauthorized allocation, exact CORS, origin rejection, payload hygiene, and secret isolation.
- Pages copies were synchronized from the shared source; only the staging configuration block differs. Production HTML uses the configured Worker URL and no staging placeholders. No obsolete `sold_out` state remains in the synchronized copies.

## Not tested / external limitations

- **NOT VERIFIED — Cloudflare D1:** The operator reports production preflight, cleanup, migrations 0001/0002 and postflight complete. This review did not access Cloudflare, independently verify those operations, or exercise `D1Database.batch` against Cloudflare.
- **NOT VERIFIED — live integrations:** Worker-to-WooCommerce authorization, live mobile/order data, D1 bindings, Apps Script redirect behavior, deployed Script Properties, actual spreadsheet headers, and cron retries were not contacted.
- **NOT TESTED — browser visual QA:** no Playwright/Puppeteer runtime was available. Edge was present, but desktop automation stopped before opening the local file because it could not verify the browser's current URL with sufficient confidence. The five viewport sizes and gate/envelope/reward/copy interactions were not visually tested. Source parsing is not a substitute.
- **NOT TESTED — PHP lint:** PHP is not available in this environment. WordPress PHP behavior was inspected and contract-tested by source assertions only.
- External Google Fonts require network access in the browser; the page is otherwise a single HTML file with inline styles/scripts and no referenced local assets.

## Remaining blockers and required configuration

1. **DONE (names verified 2026-11-04) — Worker secrets:** `SESSION_SECRET`, `WC_CONSUMER_KEY`, `WC_CONSUMER_SECRET`, `WORKER_SYNC_SECRET` are present. Values were not read.
2. **REQUIRED — Apps Script:** verify the intended Web App deployment URL; deploy reviewed `apps-script/Code.gs` if required; privately set `SPREADSHEET_ID` and matching `WORKER_SYNC_SECRET`; verify the five exact columns without clearing rows.
3. **OPTIONAL — edge rate limits:** D1 enforces per-order authorization limits. Approximate `AUTH_LIMITER`, `VERIFY_LIMITER`, and `OPEN_LIMITER` bindings remain disabled; if enabled, assign unique IDs from the intended account.
4. **REQUIRED — pending integrations:** verify existing WordPress shortcode/configuration and confirmed URLs, then deploy the Worker and Pages only through the approved controlled process. Live Sheets and customer-flow integration tests have not passed and remain pending.
5. **REQUIRED — visual QA:** test 1920×1080, 1366×768, 768×1024, 390×844 and 360×800 in a browser before declaring the experience ready.

## Controlled integration order

Follow the remaining integration steps in `docs/PRODUCTION-DEPLOYMENT-CHECKLIST.md`. Production database operations are operator-reported complete; do not repeat cleanup or migrations as part of integration setup. Configure secrets and Apps Script properties privately, verify WordPress configuration, then perform the separately controlled Worker/Pages deployment and live testing. Do not execute this sequence from local code work.

## Readiness decision

**BLOCKED for a production release.** Production D1 operations are operator-reported complete but were not independently verified here. Worker secrets, Apps Script properties/deployment URL, WordPress configuration, Worker/Pages deployment, Cloudflare behavior, browser QA and live integrations remain pending. Optional isolated backend testing can start after its separate resources and secrets are configured; production allocation testing must occur only in-window and with accepted physical-stock consumption.
