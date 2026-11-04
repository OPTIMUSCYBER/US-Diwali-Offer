# Isolated Cloudflare staging

Local preparation only. No Worker, Pages site, D1, WordPress, WooCommerce, Apps Script or Sheet was changed. Do not run these commands until every placeholder below has been replaced with a value confirmed for isolated staging.

## Required isolated resources

- New D1 database `uss-diwali-auth-2026-staging`; its ID belongs only in `wrangler.staging.toml`.
- Separate staging Worker using the same file but `--config wrangler.staging.toml`.
- Optional separate Pages preview. A second customer-facing site is not required for production integration; never configure the staging Worker to accept the production Pages origin.
- Separate WordPress authentication page testing Order ID + registered mobile against a safe WooCommerce staging store or fixture service.
- Separate Apps Script deployment and spreadsheet. Never use the live Apps Script URL or spreadsheet.
- Staging-only Cloudflare secrets and WooCommerce read-only credentials.

`wrangler.staging.toml` still has placeholders for the D1 database ID, WooCommerce URL, WordPress origin, envelope origin (if used), Apps Script deployment URL, and optional rate-limit namespace IDs. Do not copy production values from `wrangler.toml` to fill them. `cloudflare-pages-staging/index.html` still has placeholders for Worker, WordPress auth and shop URLs.

## D1 setup and migration

First create a staging database only after confirming the Cloudflare account/environment:

```powershell
npx wrangler d1 create uss-diwali-auth-2026-staging
```

After setting the returned staging-only ID, a fresh empty database can be initialized with:

```powershell
npx wrangler d1 execute uss-diwali-auth-2026-staging --remote --file=./schema.sql --config ./wrangler.staging.toml
npx wrangler d1 execute uss-diwali-auth-2026-staging --remote --file=./migrations/0003_physical_reward_inventory.sql --config ./wrangler.staging.toml
npx wrangler d1 execute uss-diwali-auth-2026-staging --remote --file=./docs/d1-preflight.sql --config ./wrangler.staging.toml
```

Before upgrading a pre-existing staging database, verify it is staging, inspect the schema and legacy records, and confirm `envelope_auth`, `envelope_customer`, and `sheet_sync` exist. If no reward tables exist, run 0003 and verify inventory. If both reward tables exist, run the combined `docs/d1-existing-reward-state-preflight.sql`; if exactly one exists, use the matching split preflight and stop for a reviewed migration plan. If both exist with the earlier customer-level `customer_key`/email uniqueness, first run `npx wrangler d1 migrations list uss-diwali-auth-2026-staging --remote --config ./wrangler.staging.toml`. Use the data-preserving 0004 order-boundary upgrade only when the tracked migration state and backup plan prove it is the sole intended pending migration, then use `wrangler d1 migrations apply`; never run 0004 through `d1 execute --file`. It preserves allocation rows and inventory quantities. Migration 0003 is additive and its initial rows use `INSERT OR IGNORE`; it never overwrites remaining quantities. The old deck tables and old `reward_slot` values remain intact as history. `seed.sql` is read-only and is not required to initialize stock.

Expected preflight: ten finite reward categories, 216 initial units, the approved category quantities/values, one unlimited fallback, and zero allocations before testing. Do not execute any D1 command with the production config or against production.

## Worker configuration

Set the staging WooCommerce URL and exact staging WordPress origin in `wrangler.staging.toml`. If a separate Pages preview is used, set its exact origin in `ENVELOPE_ORIGINS`; do not use wildcard origins or the production Pages origin `https://us-supplements-diwali.pages.dev`. Keep `AUTH_ORIGINS` limited to the separate staging WordPress authentication origin. Set secrets interactively with staging config; never place values in source, HTML or command text:

```powershell
npx wrangler secret put SESSION_SECRET --config ./wrangler.staging.toml
npx wrangler secret put WC_CONSUMER_KEY --config ./wrangler.staging.toml
npx wrangler secret put WC_CONSUMER_SECRET --config ./wrangler.staging.toml
npx wrangler secret put WORKER_SYNC_SECRET --config ./wrangler.staging.toml
```

Worker URL is unknown until the isolated Worker is provisioned. Do not invent it. Optional `AUTH_LIMITER`, `VERIFY_LIMITER`, and `OPEN_LIMITER` bindings remain disabled until actual unique staging namespace IDs are assigned. The Worker retains its D1 per-order authorization cap.

## Sheets staging

Create a new spreadsheet with a `Redemption Records` sheet and exactly these headers: `Order ID`, `Name`, `Phone Number`, `Reward Type`, `Envelope Result`. Deploy `apps-script-staging/Code.gs` separately. Set its `SPREADSHEET_ID` and `WORKER_SYNC_SECRET` script properties privately. Put only the new staging deployment URL into `GOOGLE_SHEETS_WEB_APP_URL` in the staging config. The script checks the reward ID/name pair, duplicate order data, formula injection, secret, and uses `LockService`; local tests mock Apps Script and do not prove deployed behavior.

## WordPress and Pages

Use a separate WordPress staging page and its exact origin in Worker `AUTH_ORIGINS`. Configure its local/staging `wp-config.php` only:

```php
define( 'USD_DIWALI_API_BASE', 'YOUR_STAGING_WORKER_URL' );
define( 'USD_DIWALI_ENVELOPE_URL', 'YOUR_CONFIRMED_STAGING_ENVELOPE_URL' );
```

Set `cloudflare-pages-staging/index.html` to the issued staging Worker URL and the separate staging WordPress/shop URLs. Preserve the existing Order ID + registered mobile page and token-fragment redirect. Do not edit the live WordPress site.

## Verification before internal team testing

Run `npm test`, JS syntax checks, SQL migration checks, Apps Script parsing and inline frontend JS parsing. Then test the deployed isolated endpoints using fixture/test orders only. Browser visual checks need actual local/staging browser execution at 1920×1080, 1366×768, 768×1024, 390×844 and 360×800. Local SQLite and mocks are not substitutes for D1, WooCommerce, Apps Script, CORS, or UI integration checks.
