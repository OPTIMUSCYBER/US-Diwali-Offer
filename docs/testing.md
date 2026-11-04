# Local verification

Run from the repository root with Node.js 22 or later:

```powershell
npm test
node --check worker.js
node --check tests/worker.test.mjs
node --check tests/d1-shim.mjs
node --check tests/apps-script.test.mjs
```

The latest local run (2026-11-04) completed **94 tests: 94 passed, 0 failed, 0 skipped**. The four tests added on 2026-11-04 cover: specific Sheets sync diagnostic codes (`SHEETS_HTTP_503`, `SHEETS_REJECTED_ORDER_ID_CONFLICT`, `SHEETS_HTTP_200_NON_JSON`) with rows kept pending; `/open` handing the Sheets sync to `ctx.waitUntil` so the reward response does not wait on Apps Script; Apps Script exact-retry idempotency when Google Sheets hides the formula-protection apostrophe (a regression run against the previous comparison returned `ORDER_ID_CONFLICT`); and Pages lock states offering a retry or a link back to the WordPress Order ID page. It uses `tests/d1-shim.mjs` (Node SQLite in memory) and stubbed WooCommerce, Apps Script, and Google redirect responses. Migration validation simulates the production starting shape (`_cf_KV` plus `redemptions`), production bootstrap and inventory installation, and the guarded test-row cleanup. Production-trigger integration tests passed **8/8** locally, covering physical stock decrement, duplicate Order ID, out-of-stock rollback, fallback stock behavior, legacy claim protection, same-customer distinct orders, and transaction rollback. The approved physical inventory is 11 entries: 10 finite categories totaling 216 units and one unlimited fallback. Historical migrations and the old-customer-boundary upgrade remain covered locally. These tests use SQLite/mocks and do not connect to Cloudflare D1, WooCommerce, Apps Script, or Google Sheets.

Scheduled-handler regressions verify that authorizations older than seven days are cleaned up only when unused and unallocated; their customer and issue records are deleted in the same atomic D1 batch. Non-expired and allocated authorizations (including an allocated row with a null `redeemed_at`) are preserved. Tests also verify missing Sheets URL/secret configuration is recorded on the pending outbox row and retried with the existing backoff without marking it synced. Normal synchronization, redirect handling, and retry/idempotency continue to use mocked Apps Script responses; no live Sheets behavior is verified.

Apps Script parsing and mock behavior are checked by loading both `.gs` files through Node's `vm`; the standalone final syntax pass also parsed both files through `vm.Script`. This checks syntax and tested branches but does not validate Apps Script deployment permissions, spreadsheet schema or redirect behavior in Google's environment. PHP lint was unavailable because PHP is not installed.

Frontend inline JavaScript parsing is included in the test suite for all three HTML copies and was repeated with `vm.Script`. **Browser visual QA was not performed:** Playwright/Puppeteer were unavailable. Edge was present, but desktop automation stopped before opening the local page because it could not verify the browser's current URL with sufficient confidence. Required viewports remain 1920×1080, 1366×768, 768×1024, 390×844 and 360×800. Inspect gate CTA/animation, envelope open, each server reward card, Better Luck, loading/error states, reduced-motion behavior, clipping, overflow and browser console. No real customer order or live integration should be used for local testing.
