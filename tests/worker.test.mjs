import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { D1Shim } from './d1-shim.mjs';
import worker from '../worker.js';

/* ---------------- fixtures ---------------- */
const AUTH_ORIGIN = 'https://shop.example';
const ENV_ORIGIN = 'https://envelope.example';
const RealDate = Date;
let fakeNow = RealDate.parse('2026-11-09T10:00:00+05:30');
globalThis.Date = class extends RealDate {
  constructor(...a) { if (a.length === 0) super(fakeNow); else super(...a); }
  static now() { return fakeNow; }
};
const setNow = (iso) => { fakeNow = RealDate.parse(iso); };
const advance = (sec) => { fakeNow += sec * 1000; };

let orders = {};
let sheetMode = 'ok';
let sheetRequests = [];
globalThis.fetch = async (url, options = {}) => {
  const target = String(url);
  if (target.includes('script.google.com')) {
    sheetRequests.push(JSON.parse(options.body));
    if (sheetMode === 'outage') return new Response('{}', { status: 503 });
    return new Response(null, { status: 302, headers: { Location: 'https://googleusercontent.example/ack' } });
  }
  if (target.includes('googleusercontent.example/ack')) {
    if (sheetMode === 'conflict') return new Response(JSON.stringify({ success: false, error: 'ORDER_ID_CONFLICT' }), { status: 200 });
    if (sheetMode === 'login-page') return new Response('<html>Sign in</html>', { status: 200 });
    return new Response(JSON.stringify({ success: true, order_id: sheetRequests.at(-1).order_id }), { status: 200 });
  }
  const refundMatch = /orders\/(\d+)\/refunds$/.exec(target);
  if (refundMatch) { const ro = orders[refundMatch[1]]; return ro ? new Response(JSON.stringify(ro.refund_details || []), { status: 200 }) : new Response('[]', { status: 404 }); }
  const m = /orders\/(\d+)$/.exec(target);
  const o = m && orders[m[1]];
  if (!o) return new Response('{}', { status: 404 });
  return new Response(JSON.stringify(o), { status: 200, headers: { 'Content-Type': 'application/json' } });
};
const mkOrder = (id, over = {}) => ({
  id: Number(id), status: 'processing', currency: 'INR', total: '3600.00', refunds: [], refund_details: [], line_items: [{ id: 111, total: '3000.00', total_tax: '600.00' }], shipping_total: '500.00', customer_id: 5,
  date_created_gmt: '2026-11-07T08:00:00', ...over, billing: { email: 'a@x.com', first_name: 'Asha', last_name: 'Rao', phone: '9876543210', ...(over.billing || {}) }
});

function freshEnv({ seed = false, deck = 5 } = {}) {
  const db = new D1Shim();
  db.exec(readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'));
  db.exec(readFileSync(new URL('../migrations/0003_physical_reward_inventory.sql', import.meta.url), 'utf8'));
  if (seed) db.exec(readFileSync(new URL('../seed.sql', import.meta.url), 'utf8'));
  sheetMode = 'ok'; sheetRequests = [];
  orders = { 1001: mkOrder(1001), 1002: mkOrder(1002, { customer_id: 0, total: '2500.00', line_items: [{ id: 112, total: '2000.00', total_tax: '500.00' }], date_created_gmt: '2026-11-07T08:00:00', billing: { email: 'b@x.com', phone: '9876543210' } }),
             1003: mkOrder(1003, { total: '1800.00', line_items: [{ id: 113, total: '1000.00', total_tax: '200.00' }] }), 1005: mkOrder(1005, { billing: { email: 'a@x.com' }, date_created_gmt: '2026-11-06T08:00:00' }) };
  return { DB: db, SESSION_SECRET: 's3cret-session-key', WC_CONSUMER_KEY: 'ck', WC_CONSUMER_SECRET: 'cs', WC_STORE_URL: 'https://shop.example',
           AUTH_ORIGINS: AUTH_ORIGIN, ENVELOPE_ORIGINS: ENV_ORIGIN };
}

function oldCustomerBoundaryEnv() {
  const env = freshEnv();
  env.DB.db.exec(`
    DROP TRIGGER IF EXISTS trg_reward_allocation_not_legacy_claimed;
    DROP TRIGGER IF EXISTS trg_reward_allocation_claim_stock;
    DROP TRIGGER IF EXISTS trg_legacy_deck_prevent_new_duplicate;
    DROP TRIGGER IF EXISTS trg_legacy_deck_prevent_insert_duplicate;
    DROP TABLE reward_allocation;
    CREATE TABLE reward_allocation (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      auth_id INTEGER NOT NULL UNIQUE REFERENCES envelope_auth(id),
      order_id TEXT NOT NULL UNIQUE,
      customer_key TEXT NOT NULL UNIQUE,
      customer_email TEXT,
      reward_id TEXT NOT NULL REFERENCES reward_inventory(reward_id),
      allocated_at INTEGER NOT NULL DEFAULT (unixepoch()),
      stock_decremented INTEGER NOT NULL DEFAULT 0 CHECK (stock_decremented IN (0,1))
    );
    CREATE UNIQUE INDEX idx_reward_allocation_email ON reward_allocation(customer_email) WHERE customer_email IS NOT NULL;
    CREATE INDEX idx_reward_allocation_reward ON reward_allocation(reward_id);
  `);
  return env;
}

const productionSql = (file) => readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');

function actualProductionDb(testRedemptionCount = 6) {
  const db = new D1Shim();
  // This mirrors only the confirmed production objects; _cf_KV is never modified.
  db.exec('CREATE TABLE _cf_KV (key TEXT PRIMARY KEY, value BLOB)');
  db.exec('CREATE TABLE redemptions (order_id TEXT PRIMARY KEY, redeemed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)');
  db.db.prepare("INSERT INTO _cf_KV(key, value) VALUES ('internal-marker', X'01')").run();
  const ids = ['262153', '262185', '262193', '262203', '262232', '263105'];
  for (let i = 0; i < testRedemptionCount; i++) db.db.prepare('INSERT INTO redemptions(order_id) VALUES (?1)').run(ids[i] || `unexpected-${i}`);
  return db;
}

const call = async (env, path, body, { origin, method = 'POST', headers = {} } = {}) => {
  const res = await worker.fetch(new Request('https://api.example' + path, {
    method, headers: { 'Content-Type': 'application/json', ...(origin ? { Origin: origin } : {}), ...headers },
    body: method === 'GET' || method === 'OPTIONS' ? undefined : JSON.stringify(body)
  }), env);
  let json = null; try { json = await res.json(); } catch (_) { /* no body */ }
  return { status: res.status, json, headers: res.headers };
};
const authorize = (env, orderId = 1001, phone = '9876543210') => call(env, '/api/envelope/authorize', { orderId, phone }, { origin: AUTH_ORIGIN });
const verify = (env, handoffToken, clientNonce = 'nonce-browser-A-0123456789') => call(env, '/api/envelope/verify', { handoffToken, clientNonce }, { origin: ENV_ORIGIN });
const open = (env, sessionToken) => call(env, '/api/envelope/open', { sessionToken }, { origin: ENV_ORIGIN });
const fullFlow = async (env, orderId, _unused, nonce) => {
  const a = await authorize(env, orderId, '9876543210'); assert.equal(a.status, 200, JSON.stringify(a.json));
  const v = await verify(env, a.json.handoffToken, nonce); assert.equal(v.status, 200, JSON.stringify(v.json));
  return { a, v, o: await open(env, v.json.sessionToken) };
};
const claimed = (env) => env.DB.db.prepare('SELECT COUNT(*) n FROM reward_allocation').get().n;

/* ---------------- authorize ---------------- */
test('authorize: issues a random handoff token and stores only its hash', async () => {
  const env = freshEnv();
  const r = await authorize(env);
  assert.equal(r.status, 200);
  assert.match(r.json.handoffToken, /^[A-Za-z0-9_-]{43}$/);
  const row = env.DB.db.prepare('SELECT * FROM envelope_auth').get();
  assert.notEqual(row.token_hash, r.json.handoffToken);
  assert.match(row.token_hash, /^[0-9a-f]{64}$/);
  assert.ok(!JSON.stringify(r.json).includes('reward'), 'authorize must not reveal rewards');
});
test('authorize: unknown order and wrong phone give the SAME answer (no order probing)', async () => {
  const env = freshEnv();
  const unknown = await authorize(env, 9999);
  const wrong = await authorize(env, 1001, '9123456789');
  for (const r of [unknown, wrong]) { assert.equal(r.status, 404); assert.equal(r.json.error.code, 'INVALID_ORDER'); }
  const none = await call(env, '/api/envelope/authorize', { orderId: 1001 }, { origin: AUTH_ORIGIN });
  assert.equal(none.status, 400); assert.equal(none.json.error.code, 'INVALID_REQUEST');
});
test('authorize: ineligible order (value too low) is refused', async () => {
  const r = await authorize(freshEnv(), 1003);
  assert.equal(r.status, 403); assert.equal(r.json.error.code, 'INELIGIBLE_ORDER');
});
test('authorize: requires the full registered mobile and stores WooCommerce billing details', async () => {
  const env = freshEnv();
  for (const phone of ['+91 98765-43210', '91 (987) 654-3210', '0091 (987) 654-3210', '09876543210', '98765 43210', '+91 098765-43210']) {
    const r = await authorize(env, 1001, phone);
    assert.equal(r.status, 200);
  }
  const row = env.DB.db.prepare('SELECT customer_name, phone_number FROM envelope_customer ORDER BY auth_id LIMIT 1').get();
  assert.equal(row.customer_name, 'Asha Rao');
  assert.equal(row.phone_number, '9876543210');
});
test('authorize: invalid WooCommerce order status is refused even with matching mobile', async () => {
  const env = freshEnv();
  orders[1001].status = 'cancelled';
  const r = await authorize(env);
  assert.equal(r.status, 403);
  assert.equal(r.json.error.code, 'INELIGIBLE_ORDER');
});
test('authorize: guest order with valid WooCommerce phone does not require billing email', async () => {
  const env = freshEnv();
  orders[1001].customer_id = 0;
  orders[1001].billing.email = '';
  const r = await authorize(env);
  assert.equal(r.status, 200);
  assert.match(env.DB.db.prepare('SELECT customer_key FROM envelope_auth').get().customer_key, /^phone:[0-9a-f]{64}$/);
});
test('authorize: rejects partial and similar-but-different mobile numbers', async () => {
  const env = freshEnv();
  for (const phone of ['987654321', '9876543211', '6543210']) {
    const r = await authorize(env, 1001, phone);
    assert.equal(r.status, phone.length < 10 ? 400 : 404);
    assert.equal(r.json.error.code, phone.length < 10 ? 'INVALID_REQUEST' : 'INVALID_ORDER');
  }
});
test('authorize: missing/ambiguous WooCommerce phone cannot authenticate', async () => {
  const env = freshEnv();
  orders[1001].billing.phone = '';
  assert.equal((await authorize(env)).json.error.code, 'INVALID_ORDER');
  orders[1001].billing.phone = '98765/43210';
  assert.equal((await authorize(env)).json.error.code, 'INVALID_ORDER');
});
test('authorize: empty submitted mobile is rejected', async () => {
  const env = freshEnv();
  const r = await call(env, '/api/envelope/authorize', { orderId: 1001, phone: '' }, { origin: AUTH_ORIGIN });
  assert.equal(r.status, 400);
  assert.equal(r.json.error.code, 'INVALID_REQUEST');
});
test('authorize: before launch and malformed ids', async () => {
  const env = freshEnv();
  assert.equal((await authorize(env, 'abc')).json.error.code, 'INVALID_REQUEST');
  setNow('2026-11-08T10:00:00+05:30');
  assert.equal((await authorize(env)).json.error.code, 'CAMPAIGN_NOT_STARTED');
  setNow('2026-11-09T10:00:00+05:30');
});

test('missing WooCommerce or session secrets fail closed before handoff or redemption', async () => {
  const missingWoo = freshEnv(); delete missingWoo.WC_CONSUMER_SECRET;
  const rejected = await authorize(missingWoo);
  assert.equal(rejected.status, 503); assert.equal(rejected.json.error.code, 'CONFIG_ERROR');
  assert.equal(missingWoo.DB.db.prepare('SELECT COUNT(*) n FROM envelope_auth').get().n, 0);

  const missingSession = freshEnv(); const a = await authorize(missingSession);
  delete missingSession.SESSION_SECRET;
  const v = await verify(missingSession, a.json.handoffToken);
  assert.equal(v.status, 503); assert.equal(v.json.error.code, 'CONFIG_ERROR');
  assert.equal(missingSession.DB.db.prepare('SELECT verified_at FROM envelope_auth').get().verified_at, null);
});

test('campaign boundaries: launch inclusive, close exclusive across status, authorize, verify and open', async () => {
  const env = freshEnv({ deck: 3 });
  setNow('2026-11-08T23:59:59+05:30');
  assert.equal((await call(env, '/api/envelope/status', null, { method: 'GET', origin: ENV_ORIGIN })).json.state, 'not_started');
  assert.equal((await authorize(env)).json.error.code, 'CAMPAIGN_NOT_STARTED');
  setNow('2026-11-09T00:00:00+05:30');
  assert.equal((await call(env, '/api/envelope/status', null, { method: 'GET', origin: ENV_ORIGIN })).json.state, 'open');
  setNow('2026-11-09T23:59:59+05:30');
  const a = await authorize(env); assert.equal(a.status, 200);
  const v = await verify(env, a.json.handoffToken); assert.equal(v.status, 200);
  setNow('2026-11-09T23:59:59+05:30');
  const redeemed = await open(env, v.json.sessionToken); assert.equal(redeemed.status, 200);
  const b = await authorize(env, 1002, '9876543210'); assert.equal(b.status, 200);
  setNow('2026-11-10T00:00:00+05:30');
  assert.equal((await call(env, '/api/envelope/status', null, { method: 'GET', origin: ENV_ORIGIN })).json.state, 'closed');
  assert.equal((await authorize(env, 1002, '9876543210')).json.error.code, 'CAMPAIGN_CLOSED');
  assert.equal((await verify(env, b.json.handoffToken)).json.error.code, 'CAMPAIGN_CLOSED');
  assert.equal((await open(env, v.json.sessionToken)).status, 200, 'saved reward replay remains allowed');
  setNow('2026-11-10T00:00:01+05:30');
  assert.equal((await call(env, '/api/envelope/status', null, { method: 'GET', origin: ENV_ORIGIN })).json.state, 'closed');
  setNow('2026-11-09T10:00:00+05:30');
});

test('campaign close: verified but unredeemed session cannot claim after midnight', async () => {
  const env = freshEnv({ deck: 1 });
  setNow('2026-11-09T23:59:59+05:30');
  const a = await authorize(env), v = await verify(env, a.json.handoffToken);
  setNow('2026-11-10T00:00:00+05:30');
  const out = await open(env, v.json.sessionToken);
  assert.equal(out.json.error.code, 'CAMPAIGN_CLOSED');
  assert.equal(claimed(env), 0);
  setNow('2026-11-09T10:00:00+05:30');
});

test('eligibility: discounted product line totals exclude shipping and tax, thresholds are strict', async () => {
  const cases = [
    ['₹1,501 accepted', { line_items: [{ id: 1, total: '1501.00', total_tax: '900.00' }], shipping_total: '9000.00', total: '99999.00' }, true],
    ['₹1,500.01 accepted', { line_items: [{ id: 1, total: '1500.01', total_tax: '900.00' }] }, true],
    ['₹1,500 rejected', { line_items: [{ id: 1, total: '1500.00', total_tax: '900.00' }] }, false],
    ['₹1,499.99 rejected', { line_items: [{ id: 1, total: '1499.99', total_tax: '0.00' }] }, false],
    ['₹1,499 rejected', { line_items: [{ id: 1, total: '1499.00' }] }, false],
    ['discounted product total used', { line_items: [{ id: 1, subtotal: '4000.00', total: '2000.00', total_tax: '1000.00' }] }, true],
    ['5 November rejected', { date_created_gmt: '2026-11-05T08:00:00', line_items: [{ id: 1, total: '2000.00' }] }, false],
    ['6 November eligible', { date_created_gmt: '2026-11-06T08:00:00', line_items: [{ id: 1, total: '2000.00' }] }, true],
    ['7 November eligible', { date_created_gmt: '2026-11-07T08:00:00', line_items: [{ id: 1, total: '2000.00' }] }, true],
    ['8 November rejected', { date_created_gmt: '2026-11-08T08:00:00', line_items: [{ id: 1, total: '2000.00' }] }, false],
    ['9 November rejected', { date_created_gmt: '2026-11-09T08:00:00', line_items: [{ id: 1, total: '2000.00' }] }, false],
    ['10 November rejected', { date_created_gmt: '2026-11-10T08:00:00', line_items: [{ id: 1, total: '2000.00' }] }, false],
    ['refund leaves ₹1,500 rejected', { line_items: [{ id: 1, total: '1600.00' }], refunds: [{ id: 7, total: '-100.00' }], refund_details: [{ id: 7, line_items: [{ id: 1, total: '-100.00' }], shipping_lines: [] }] }, false],
    ['refund leaves ₹1,501 accepted', { line_items: [{ id: 1, total: '1601.00' }], refunds: [{ id: 7, total: '-100.00' }], refund_details: [{ id: 7, line_items: [{ id: 1, total: '-100.00' }], shipping_lines: [] }] }, true],
    ['shipping excluded', { line_items: [{ id: 1, total: '1400.00' }], shipping_total: '900.00', total: '4000.00' }, false],
    ['tax excluded', { line_items: [{ id: 1, total: '1499.00', total_tax: '800.00' }], total: '4000.00' }, false],
    ['partial product refund', { line_items: [{ id: 1, total: '1800.00' }], refunds: [{ id: 7, total: '-100.00' }], refund_details: [{ id: 7, line_items: [{ id: 1, total: '-100.00' }], shipping_lines: [] }] }, true],
    ['full product refund', { line_items: [{ id: 1, total: '2000.00' }], refunds: [{ id: 7, total: '-2000.00' }], refund_details: [{ id: 7, line_items: [{ id: 1, total: '-2000.00' }], shipping_lines: [] }] }, false],
    ['shipping-only refund', { line_items: [{ id: 1, total: '1600.00' }], refunds: [{ id: 7, total: '-500.00' }], refund_details: [{ id: 7, line_items: [], shipping_lines: [{ total: '-500.00' }] }] }, true],
    ['multiple product refunds', { line_items: [{ id: 1, total: '1800.00' }], refunds: [{ id: 7, total: '-100' }, { id: 8, total: '-100' }], refund_details: [{ id: 7, line_items: [{ id: 1, total: '-100' }], shipping_lines: [] }, { id: 8, line_items: [{ id: 1, total: '-100' }], shipping_lines: [] }] }, true],
    ['missing refund details', { line_items: [{ id: 1, total: '2000.00' }], refunds: [{ id: 7, total: '-100.00' }], refund_details: [] }, false],
    ['mixed product and shipping refunds', { line_items: [{ id: 1, total: '1800.00' }], refunds: [{ id: 7, total: '-500.00' }], refund_details: [{ id: 7, line_items: [{ id: 1, total: '-400.00' }], shipping_lines: [{ total: '-100.00' }] }] }, false],
    ['missing product data', { line_items: undefined }, false],
    ['malformed amount', { line_items: [{ id: 1, total: '2,600.00' }] }, false],
    ['missing currency', { currency: undefined }, false],
    ['non-INR currency', { currency: 'USD' }, false]
  ];
  for (const [label, override, expected] of cases) {
    const env = freshEnv();
    const order = mkOrder(1001, override);
    orders[1001] = order;
    const result = await authorize(env);
    assert.equal(result.status === 200, expected, label + ': ' + JSON.stringify(result.json));
  }
});
test('authorize: per-order hourly cap', async () => {
  const env = freshEnv();
  for (let i = 0; i < 10; i++) assert.equal((await authorize(env)).status, 200);
  assert.equal((await authorize(env)).json.error.code, 'RATE_LIMITED');
});
test('authorize: a newer handoff supersedes the older unused one', async () => {
  const env = freshEnv();
  const first = await authorize(env), second = await authorize(env);
  assert.equal((await verify(env, first.json.handoffToken)).json.error.code, 'INVALID_AUTH');
  assert.equal((await verify(env, second.json.handoffToken)).status, 200);
});

/* ---------------- verify ---------------- */
test('verify: success returns a session and NO reward information', async () => {
  const env = freshEnv();
  const a = await authorize(env);
  const v = await verify(env, a.json.handoffToken);
  assert.equal(v.status, 200);
  assert.ok(v.json.sessionToken.includes('.'));
  assert.equal(v.json.alreadyOpened, false);
  assert.ok(!('reward' in v.json));
});
test('verify: single use, bound to the first browser; same browser may retry', async () => {
  const env = freshEnv();
  const a = await authorize(env);
  const A = 'nonce-browser-A-0123456789', B = 'nonce-browser-B-0123456789';
  assert.equal((await verify(env, a.json.handoffToken, A)).status, 200);
  const retry = await verify(env, a.json.handoffToken, A);              // lost-response retry, same browser
  assert.equal(retry.status, 200);
  const other = await verify(env, a.json.handoffToken, B);              // link copied to another browser
  assert.equal(other.status, 409); assert.equal(other.json.error.code, 'AUTH_ALREADY_USED');
});
test('verify: two browsers racing with the same token -> exactly one wins', async () => {
  const env = freshEnv();
  const a = await authorize(env);
  const results = await Promise.all(['nonce-aaaaaaaaaaaaaaaa1', 'nonce-bbbbbbbbbbbbbbbb2', 'nonce-cccccccccccccccc3']
    .map((n) => verify(env, a.json.handoffToken, n)));
  assert.equal(results.filter((r) => r.status === 200).length, 1);
  assert.equal(results.filter((r) => r.json.error && r.json.error.code === 'AUTH_ALREADY_USED').length, 2);
});
test('verify: expired / invalid / malformed tokens', async () => {
  const env = freshEnv();
  const a = await authorize(env);
  advance(11 * 60);
  const expired = await verify(env, a.json.handoffToken);
  assert.equal(expired.status, 410); assert.equal(expired.json.error.code, 'EXPIRED_AUTH');
  assert.equal((await verify(env, 'A'.repeat(43))).json.error.code, 'INVALID_AUTH');
  assert.equal((await verify(env, 'short')).json.error.code, 'INVALID_AUTH');
  assert.equal((await verify(env, a.json.handoffToken, 'x')).json.error.code, 'INVALID_AUTH');
  setNow('2026-11-09T10:00:00+05:30');
});
test('verify: order that stopped being eligible is refused and the token is NOT consumed', async () => {
  const env = freshEnv();
  const a = await authorize(env);
  orders[1001].status = 'refunded';
  const v = await verify(env, a.json.handoffToken);
  assert.equal(v.json.error.code, 'INELIGIBLE_ORDER');
  assert.equal(env.DB.db.prepare('SELECT verified_at FROM envelope_auth').get().verified_at, null);
});

/* ---------------- physical inventory allocation ---------------- */
test('production bootstrap initializes an empty confirmed D1 shape without touching _cf_KV', () => {
  const db = actualProductionDb(0);
  db.exec(productionSql('docs/production-d1-preflight.sql'));
  db.exec(productionSql('migrations/production/0001_create_envelope_schema.sql'));
  db.exec(productionSql('migrations/production/0002_install_physical_reward_inventory.sql'));
  db.exec(productionSql('docs/production-d1-postflight.sql'));
  assert.equal(db.db.prepare("SELECT COUNT(*) AS n FROM _cf_KV WHERE key='internal-marker'").get().n, 1);
  assert.equal(db.db.prepare('SELECT COUNT(*) AS n FROM redemptions').get().n, 0);
  assert.equal(db.db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name='envelope_auth'").get().n, 1);
  assert.equal(db.db.prepare('SELECT SUM(initial_quantity) AS n FROM reward_inventory WHERE is_fallback=0').get().n, 216);
});

test('Worker allocation works on the production bootstrap schema', async () => {
  const db = actualProductionDb(0);
  db.exec(productionSql('migrations/production/0001_create_envelope_schema.sql'));
  db.exec(productionSql('migrations/production/0002_install_physical_reward_inventory.sql'));
  sheetMode = 'ok'; sheetRequests = [];
  orders = { 1001: mkOrder(1001) };
  const env = {
    DB: db, SESSION_SECRET: 'production-schema-test-session', WC_CONSUMER_KEY: 'ck', WC_CONSUMER_SECRET: 'cs',
    WC_STORE_URL: 'https://shop.example', AUTH_ORIGINS: AUTH_ORIGIN, ENVELOPE_ORIGINS: ENV_ORIGIN
  };
  const result = await fullFlow(env, 1001, null, 'nonce-production-schema-01');
  assert.equal(result.o.status, 200);
  assert.equal(db.db.prepare('SELECT COUNT(*) AS n FROM reward_allocation WHERE order_id = ?').get('1001').n, 1);
  assert.equal(db.db.prepare("SELECT COUNT(*) AS n FROM _cf_KV WHERE key='internal-marker'").get().n, 1);
});

function productionTriggerDb() {
  const db = actualProductionDb(0);
  db.exec(productionSql('migrations/production/0001_create_envelope_schema.sql'));
  db.exec(productionSql('migrations/production/0002_install_physical_reward_inventory.sql'));
  const auth = db.db.prepare(`INSERT INTO envelope_auth
    (token_hash, order_id, customer_key, created_at, expires_at)
    VALUES (?, ?, ?, 1, 9999999999) RETURNING id`).get(`hash-${Math.random()}`, 'seed-order', 'cust:trigger');
  return { db, addAuth(orderId, customerKey = 'cust:trigger') {
    return db.db.prepare(`INSERT INTO envelope_auth
      (token_hash, order_id, customer_key, created_at, expires_at)
      VALUES (?, ?, ?, 1, 9999999999) RETURNING id`).get(`hash-${Math.random()}`, orderId, customerKey).id;
  }, seedAuthId: auth.id };
}

test('production trigger: physical allocation decrements stock by exactly one', () => {
  const { db, addAuth } = productionTriggerDb();
  const authId = addAuth('510001');
  const before = db.db.prepare("SELECT remaining_quantity FROM reward_inventory WHERE reward_id='KEYCHAIN'").get().remaining_quantity;
  db.db.prepare(`INSERT INTO reward_allocation(auth_id, order_id, customer_key, reward_id)
    VALUES (?, '510001', 'cust:trigger', 'KEYCHAIN')`).run(authId);
  assert.equal(db.db.prepare("SELECT remaining_quantity FROM reward_inventory WHERE reward_id='KEYCHAIN'").get().remaining_quantity, before - 1);
  assert.equal(db.db.prepare("SELECT stock_decremented FROM reward_allocation WHERE order_id='510001'").get().stock_decremented, 1);
});

test('production trigger: same Order ID cannot allocate or decrement twice', () => {
  const { db, addAuth } = productionTriggerDb();
  const firstAuth = addAuth('510002'); const secondAuth = addAuth('510002');
  const before = db.db.prepare("SELECT remaining_quantity FROM reward_inventory WHERE reward_id='KEYCHAIN'").get().remaining_quantity;
  db.db.prepare(`INSERT INTO reward_allocation(auth_id, order_id, customer_key, reward_id)
    VALUES (?, '510002', 'cust:trigger', 'KEYCHAIN')`).run(firstAuth);
  assert.throws(() => db.db.prepare(`INSERT INTO reward_allocation(auth_id, order_id, customer_key, reward_id)
    VALUES (?, '510002', 'cust:trigger', 'KEYCHAIN')`).run(secondAuth), /UNIQUE/);
  assert.equal(db.db.prepare("SELECT COUNT(*) AS n FROM reward_allocation WHERE order_id='510002'").get().n, 1);
  assert.equal(db.db.prepare("SELECT remaining_quantity FROM reward_inventory WHERE reward_id='KEYCHAIN'").get().remaining_quantity, before - 1);
});

test('production trigger: out-of-stock physical allocation aborts without an allocation row', () => {
  const { db, addAuth } = productionTriggerDb(); const authId = addAuth('510003');
  db.db.prepare("UPDATE reward_inventory SET remaining_quantity=0 WHERE reward_id='KEYCHAIN'").run();
  assert.throws(() => db.db.prepare(`INSERT INTO reward_allocation(auth_id, order_id, customer_key, reward_id)
    VALUES (?, '510003', 'cust:trigger', 'KEYCHAIN')`).run(authId), /REWARD_OUT_OF_STOCK/);
  assert.equal(db.db.prepare("SELECT COUNT(*) AS n FROM reward_allocation WHERE order_id='510003'").get().n, 0);
  assert.equal(db.db.prepare("SELECT remaining_quantity FROM reward_inventory WHERE reward_id='KEYCHAIN'").get().remaining_quantity, 0);
});

test('production trigger: fallback allocation does not decrement physical stock', () => {
  const { db, addAuth } = productionTriggerDb(); const authId = addAuth('510004');
  const before = db.db.prepare('SELECT SUM(remaining_quantity) AS n FROM reward_inventory WHERE is_fallback=0').get().n;
  db.db.prepare(`INSERT INTO reward_allocation(auth_id, order_id, customer_key, reward_id)
    VALUES (?, '510004', 'cust:trigger', 'BETTER_LUCK')`).run(authId);
  assert.equal(db.db.prepare('SELECT SUM(remaining_quantity) AS n FROM reward_inventory WHERE is_fallback=0').get().n, before);
  assert.equal(db.db.prepare("SELECT stock_decremented FROM reward_allocation WHERE order_id='510004'").get().stock_decremented, 0);
});

test('production trigger: legacy deck claim blocks allocation for same Order ID', () => {
  const { db, addAuth } = productionTriggerDb(); const authId = addAuth('510005');
  db.db.prepare("INSERT INTO reward_deck(slot, reward_id, order_id) VALUES (91005, 'OLD', '510005')").run();
  assert.throws(() => db.db.prepare(`INSERT INTO reward_allocation(auth_id, order_id, customer_key, reward_id)
    VALUES (?, '510005', 'cust:trigger', 'KEYCHAIN')`).run(authId), /LEGACY_REWARD_ALREADY_ALLOCATED/);
  assert.equal(db.db.prepare("SELECT COUNT(*) AS n FROM reward_allocation WHERE order_id='510005'").get().n, 0);
});

test('production trigger: new allocation blocks legacy insert and update claims for same Order ID', () => {
  const { db, addAuth } = productionTriggerDb(); const authId = addAuth('510006');
  db.db.prepare("INSERT INTO reward_allocation(auth_id, order_id, customer_key, reward_id) VALUES (?, '510006', 'cust:trigger', 'KEYCHAIN')").run(authId);
  db.db.prepare("INSERT INTO reward_deck(slot, reward_id) VALUES (91006, 'OLD')").run();
  assert.throws(() => db.db.prepare("UPDATE reward_deck SET order_id='510006' WHERE slot=91006").run(), /REWARD_ALREADY_ALLOCATED/);
  assert.throws(() => db.db.prepare("INSERT INTO reward_deck(slot, reward_id, order_id) VALUES (91007, 'OLD', '510006')").run(), /REWARD_ALREADY_ALLOCATED/);
});

test('production schema: same customer can allocate distinct Order IDs', () => {
  const { db, addAuth } = productionTriggerDb();
  for (const orderId of ['510008', '510009']) {
    const authId = addAuth(orderId);
    db.db.prepare('INSERT INTO reward_allocation(auth_id, order_id, customer_key, customer_email, reward_id) VALUES (?, ?, ?, ?, ?)')
      .run(authId, orderId, 'cust:same', 'same@example.test', 'KEYCHAIN');
  }
  assert.equal(db.db.prepare("SELECT COUNT(*) AS n FROM reward_allocation WHERE customer_key='cust:same'").get().n, 2);
  assert.equal(db.db.prepare("SELECT remaining_quantity FROM reward_inventory WHERE reward_id='KEYCHAIN'").get().remaining_quantity, 48);
});

test('production D1 transaction: allocation and stock decrement roll back together on later failure', () => {
  const { db, addAuth } = productionTriggerDb(); const authId = addAuth('510010');
  const before = db.db.prepare("SELECT remaining_quantity FROM reward_inventory WHERE reward_id='KEYCHAIN'").get().remaining_quantity;
  assert.throws(() => db.db.exec(`BEGIN;
    INSERT INTO reward_allocation(auth_id, order_id, customer_key, reward_id) VALUES (${authId}, '510010', 'cust:trigger', 'KEYCHAIN');
    INSERT INTO sheet_sync(order_id, reward_type, envelope_result, sync_state, next_attempt_at)
      VALUES ('510010', 'KEYCHAIN', 'Keychain', 'invalid-state', 1);
    COMMIT;`), /CHECK constraint failed/);
  db.db.exec('ROLLBACK');
  assert.equal(db.db.prepare("SELECT COUNT(*) AS n FROM reward_allocation WHERE order_id='510010'").get().n, 0);
  assert.equal(db.db.prepare("SELECT remaining_quantity FROM reward_inventory WHERE reward_id='KEYCHAIN'").get().remaining_quantity, before);
});

test('production cleanup deletes exactly six authorized test redemptions and preserves both tables', () => {
  const db = actualProductionDb(6);
  assert.equal(db.db.prepare('SELECT COUNT(*) AS n FROM redemptions').get().n, 6);
  db.exec(productionSql('docs/production-d1-cleanup-six-test-redemptions.sql'));
  assert.equal(db.db.prepare('SELECT COUNT(*) AS n FROM redemptions').get().n, 0);
  assert.equal(db.db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name='redemptions'").get().n, 1);
  assert.equal(db.db.prepare("SELECT COUNT(*) AS n FROM _cf_KV WHERE key='internal-marker'").get().n, 1);
});

test('production cleanup rejects one unexpected ID replacing an authorized ID', () => {
  const db = actualProductionDb(5);
  db.db.prepare('INSERT INTO redemptions(order_id) VALUES (?)').run('999999');
  db.exec(productionSql('docs/production-d1-cleanup-six-test-redemptions.sql'));
  assert.equal(db.db.prepare('SELECT COUNT(*) AS n FROM redemptions').get().n, 6);
  assert.equal(db.db.prepare("SELECT COUNT(*) AS n FROM redemptions WHERE order_id='999999'").get().n, 1);
  assert.equal(db.db.prepare("SELECT COUNT(*) AS n FROM _cf_KV WHERE key='internal-marker'").get().n, 1);
});

test('production cleanup rejects seven records', () => {
  const db = actualProductionDb(6);
  db.db.prepare('INSERT INTO redemptions(order_id) VALUES (?)').run('999999');
  db.exec(productionSql('docs/production-d1-cleanup-six-test-redemptions.sql'));
  assert.equal(db.db.prepare('SELECT COUNT(*) AS n FROM redemptions').get().n, 7);
});

test('production cleanup rejects five records', () => {
  const db = actualProductionDb(5);
  db.exec(productionSql('docs/production-d1-cleanup-six-test-redemptions.sql'));
  assert.equal(db.db.prepare('SELECT COUNT(*) AS n FROM redemptions').get().n, 5);
});

test('production cleanup rejects incorrect table structure', () => {
  const db = actualProductionDb(0);
  db.exec('DROP TABLE redemptions; CREATE TABLE redemptions (order_id TEXT PRIMARY KEY, redeemed_at TEXT)');
  for (const id of ['262153', '262185', '262193', '262203', '262232', '263105']) db.db.prepare('INSERT INTO redemptions(order_id) VALUES (?)').run(id);
  db.exec(productionSql('docs/production-d1-cleanup-six-test-redemptions.sql'));
  assert.equal(db.db.prepare('SELECT COUNT(*) AS n FROM redemptions').get().n, 6);
  assert.equal(db.db.prepare("SELECT COUNT(*) AS n FROM _cf_KV WHERE key='internal-marker'").get().n, 1);
});

test('cleanup SQL contains no explicit transaction commands', () => {
  const sql = productionSql('docs/production-d1-cleanup-six-test-redemptions.sql');
  assert.doesNotMatch(sql, /^\s*(BEGIN|COMMIT|ROLLBACK)\b/im);
});

test('production cleanup fails closed on a five-row set without touching _cf_KV', () => {
  const db = actualProductionDb(5);
  db.exec(productionSql('docs/production-d1-cleanup-six-test-redemptions.sql'));
  assert.equal(db.db.prepare('SELECT COUNT(*) AS n FROM redemptions').get().n, 5);
  assert.equal(db.db.prepare("SELECT COUNT(*) AS n FROM _cf_KV WHERE key='internal-marker'").get().n, 1);
});

test('production Wrangler configuration uses the confirmed Worker and D1 identity with isolated migrations', () => {
  const config = readFileSync(new URL('../wrangler.toml', import.meta.url), 'utf8');
  assert.match(config, /^name = "uss-diwali-auth-2026"/m);
  assert.match(config, /database_name = "uss-diwali-redemptions"/);
  assert.match(config, /database_id = "7e58a497-e28c-4c05-9d28-05aeaf1c3b58"/);
  assert.match(config, /migrations_dir = "migrations\/production"/);
  assert.doesNotMatch(config, /7e58a497-e28c-4c4c-05ae-af1c3b5b8d28|REPLACE_WITH_YOUR_D1_DATABASE_ID/);
});

test('inventory migration creates the exact 216 physical units and unlimited fallback', () => {
  const env = freshEnv();
  const rows = env.DB.db.prepare('SELECT * FROM reward_inventory ORDER BY reward_id').all();
  const finite = rows.filter(r => r.is_fallback === 0);
  assert.equal(finite.length, 10);
  assert.equal(finite.reduce((n, r) => n + r.initial_quantity, 0), 216);
  assert.deepEqual(Object.fromEntries(finite.map(r => [r.reward_id, r.initial_quantity])), {
    BIG_FLEX_BCAA: 10, KEYCHAIN: 50, MUSCLE_SCIENCE_PREWORKOUT: 100, PINTOLA_OATS: 50,
    PROTEIN_SAMPLE_BOX: 1, PSYCHO_PUMP: 1, REGULAR_SHAKER: 1, STEEL_SHAKER: 1, SUPER_YOU_PROTEIN: 1, TSHIRT: 1
  });
  assert.deepEqual(Object.fromEntries(finite.map(r => [r.reward_id, r.unit_value_paise])), {
    BIG_FLEX_BCAA: null, KEYCHAIN: null, MUSCLE_SCIENCE_PREWORKOUT: 5000, PINTOLA_OATS: null,
    PROTEIN_SAMPLE_BOX: 70000, PSYCHO_PUMP: 70000, REGULAR_SHAKER: 7000,
    STEEL_SHAKER: 35000, SUPER_YOU_PROTEIN: 220000, TSHIRT: 10000
  });
  const fallback = rows.find(r => r.reward_id === 'BETTER_LUCK');
  assert.equal(fallback.is_fallback, 1); assert.equal(fallback.remaining_quantity, null);
  assert.equal(finite.filter(r => r.initial_quantity === 1).length, 6);
});

test('historical 0002 followed by final 0003 initializes only the approved 216 physical units', () => {
  const db = new D1Shim();
  db.exec(readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'));
  db.exec(readFileSync(new URL('../migrations/0002_reward_inventory_and_sheets_sync.sql', import.meta.url), 'utf8'));
  db.exec(readFileSync(new URL('../migrations/0003_physical_reward_inventory.sql', import.meta.url), 'utf8'));
  assert.equal(db.db.prepare('SELECT SUM(initial_quantity) AS total FROM reward_inventory WHERE is_fallback = 0').get().total, 216);
  assert.equal(db.db.prepare('SELECT COUNT(*) AS n FROM reward_inventory WHERE is_fallback = 1').get().n, 1);
  assert.equal(db.db.prepare('SELECT COUNT(*) AS n FROM reward_deck').get().n, 0);
});

test('migration is repeatable, preserves changed stock and legacy reward history', () => {
  const env = freshEnv();
  env.DB.db.exec("INSERT INTO reward_deck(slot,reward_id,customer_key,customer_email,order_id,claimed_at) VALUES(9001,'DIWALI50','cust:77','legacy@example.test','old-order','2026-11-09T00:00:00Z')");
  env.DB.db.exec("INSERT INTO envelope_auth(token_hash,order_id,customer_key,customer_email,created_at,expires_at,redeemed_at,reward_slot,was_existing) VALUES('legacy-token-hash','old-order','cust:77','legacy@example.test',100,200,150,9001,1)");
  env.DB.db.exec("UPDATE reward_inventory SET remaining_quantity=17 WHERE reward_id='KEYCHAIN'");
  const sql = readFileSync(new URL('../migrations/0003_physical_reward_inventory.sql', import.meta.url), 'utf8');
  env.DB.exec(sql); env.DB.exec(sql);
  assert.equal(env.DB.db.prepare("SELECT remaining_quantity FROM reward_inventory WHERE reward_id='KEYCHAIN'").get().remaining_quantity, 17);
  assert.deepEqual({ ...env.DB.db.prepare("SELECT reward_id, customer_key, customer_email, order_id, claimed_at FROM reward_deck WHERE slot=9001").get() }, {
    reward_id: 'DIWALI50', customer_key: 'cust:77', customer_email: 'legacy@example.test', order_id: 'old-order', claimed_at: '2026-11-09T00:00:00Z'
  });
  assert.deepEqual({ ...env.DB.db.prepare("SELECT redeemed_at, reward_slot, was_existing FROM envelope_auth WHERE token_hash='legacy-token-hash'").get() }, { redeemed_at: 150, reward_slot: 9001, was_existing: 1 });
});

test('inventory constraints reject null or fractional finite stock and preserve unlimited fallback nulls', () => {
  const env = freshEnv();
  assert.throws(() => env.DB.db.exec("INSERT INTO reward_inventory(reward_id,reward_name,initial_quantity,remaining_quantity,is_fallback) VALUES('BAD_NULL','Bad',NULL,NULL,0)"), /CHECK constraint failed/);
  assert.throws(() => env.DB.db.exec("INSERT INTO reward_inventory(reward_id,reward_name,initial_quantity,remaining_quantity,is_fallback) VALUES('BAD_FRACTION','Bad',1.5,1.5,0)"), /CHECK constraint failed/);
  const fallback = env.DB.db.prepare("SELECT initial_quantity, remaining_quantity FROM reward_inventory WHERE reward_id='BETTER_LUCK'").get();
  assert.deepEqual({ ...fallback }, { initial_quantity: null, remaining_quantity: null });
});

test('order-boundary upgrade preserves allocations and stock while removing customer-level uniqueness', async () => {
  const env = oldCustomerBoundaryEnv();
  const a = await authorize(env, 1001);
  const v = await verify(env, a.json.handoffToken);
  const authId = env.DB.db.prepare('SELECT id FROM envelope_auth WHERE order_id = ?').get('1001').id;
  env.DB.db.prepare(`INSERT INTO reward_allocation
    (auth_id, order_id, customer_key, customer_email, reward_id, allocated_at, stock_decremented)
    VALUES (?, '1001', 'cust:5', 'a@x.com', 'KEYCHAIN', ?, 1)`).run(authId, Math.floor(Date.now() / 1000));
  env.DB.db.exec("UPDATE reward_inventory SET remaining_quantity = remaining_quantity - 1 WHERE reward_id = 'KEYCHAIN'");
  const before = env.DB.db.prepare("SELECT remaining_quantity FROM reward_inventory WHERE reward_id='KEYCHAIN'").get().remaining_quantity;
  env.DB.exec(readFileSync(new URL('../migrations/0004_order_id_allocation_boundary.sql', import.meta.url), 'utf8'));
  assert.equal(env.DB.db.prepare("SELECT remaining_quantity FROM reward_inventory WHERE reward_id='KEYCHAIN'").get().remaining_quantity, before);
  assert.deepEqual({ ...env.DB.db.prepare('SELECT order_id, customer_key, customer_email, reward_id, stock_decremented FROM reward_allocation WHERE id=1').get() }, {
    order_id: '1001', customer_key: 'cust:5', customer_email: 'a@x.com', reward_id: 'KEYCHAIN', stock_decremented: 1
  });
  assert.equal(env.DB.db.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE type='index' AND name='idx_reward_allocation_email'").get().n, 0);
  orders[1005] = mkOrder(1005, { customer_id: 5, billing: { email: 'a@x.com', phone: '9876543210' } });
  const second = await fullFlow(env, 1005, null, 'nonce-upgrade-1005-00001');
  assert.equal(second.o.status, 200);
  assert.equal(claimed(env), 2);
  assert.equal((await open(env, v.json.sessionToken)).status, 200, 'old allocation still replays after upgrade');
});

test('legacy claimed identities are preserved and cannot receive another new-format allocation', async () => {
  const env = freshEnv();
  env.DB.db.exec("INSERT INTO reward_deck(slot,reward_id,customer_key,customer_email,order_id,claimed_at) VALUES(9002,'LEGACY_REWARD','cust:5','a@x.com','1001','2026-11-09T00:00:00Z')");
  const a = await authorize(env, 1001);
  assert.equal(a.status, 409); assert.equal(a.json.error.code, 'AUTH_ALREADY_USED');
  assert.equal(claimed(env), 0);
  assert.equal(env.DB.db.prepare('SELECT COUNT(*) n FROM envelope_auth').get().n, 0, 'legacy customer receives no replacement handoff');
  assert.equal(env.DB.db.prepare('SELECT reward_id FROM reward_deck WHERE slot=9002').get().reward_id, 'LEGACY_REWARD');
});

test('legacy claim blocks only its own Order ID; another eligible order for that customer can allocate', async () => {
  const env = freshEnv();
  env.DB.db.exec("INSERT INTO reward_deck(slot,reward_id,customer_key,customer_email,order_id,claimed_at) VALUES(9007,'DIWALI50','cust:5','a@x.com','1001','2026-11-09T00:00:00Z')");
  assert.equal((await authorize(env, 1001)).json.error.code, 'AUTH_ALREADY_USED');
  orders[1005] = mkOrder(1005, { customer_id: 5, billing: { email: 'a@x.com', phone: '9876543210' } });
  const second = await fullFlow(env, 1005, null, 'nonce-legacy-B-1005-0001');
  assert.equal(second.o.status, 200);
  assert.equal(claimed(env), 1);
  assert.equal(env.DB.db.prepare("SELECT reward_id FROM reward_deck WHERE slot=9007").get().reward_id, 'DIWALI50');
});

test('legacy pre-migration handoff cannot be verified or converted into a new physical draw', async () => {
  const env = freshEnv();
  const a = await authorize(env);
  env.DB.db.exec("INSERT INTO reward_deck(slot,reward_id,customer_key,customer_email,order_id,claimed_at) VALUES(9004,'DIWALI50','cust:5','a@x.com','1001','2026-11-09T00:00:00Z')");
  const v = await verify(env, a.json.handoffToken);
  assert.equal(v.status, 409); assert.equal(v.json.error.code, 'AUTH_ALREADY_USED');
  assert.equal(env.DB.db.prepare('SELECT verified_at FROM envelope_auth').get().verified_at, null);
  assert.equal(claimed(env), 0);
  assert.equal(env.DB.db.prepare("SELECT reward_id FROM reward_deck WHERE slot=9004").get().reward_id, 'DIWALI50');
});

test('legacy redeemed-session replay is refused explicitly and never shown as a physical reward', async () => {
  const env = freshEnv();
  const a = await authorize(env); const v = await verify(env, a.json.handoffToken);
  env.DB.db.exec("INSERT INTO reward_deck(slot,reward_id,customer_key,customer_email,order_id,claimed_at) VALUES(9005,'DIWALI50','cust:5','a@x.com','1001','2026-11-09T00:00:00Z')");
  env.DB.db.prepare('UPDATE envelope_auth SET redeemed_at = ?, reward_slot = 9005, was_existing = 1 WHERE id = 1').run(Math.floor(Date.now() / 1000));
  const result = await open(env, v.json.sessionToken);
  assert.equal(result.status, 409); assert.equal(result.json.error.code, 'AUTH_ALREADY_USED');
  assert.equal(result.json.reward, undefined);
  assert.equal(claimed(env), 0);
  assert.equal(env.DB.db.prepare("SELECT reward_id FROM reward_deck WHERE slot=9005").get().reward_id, 'DIWALI50');
});

test('orphaned legacy reward_slot marker fails closed without allocating or presenting a replacement', async () => {
  const env = freshEnv();
  const a = await authorize(env); const v = await verify(env, a.json.handoffToken);
  env.DB.db.prepare('UPDATE envelope_auth SET redeemed_at = ?, reward_slot = 9999, was_existing = 1 WHERE id = 1').run(Math.floor(Date.now() / 1000));
  const result = await open(env, v.json.sessionToken);
  assert.equal(result.status, 409); assert.equal(result.json.error.code, 'AUTH_ALREADY_USED');
  assert.equal(result.json.reward, undefined);
  assert.equal(claimed(env), 0);
});

test('legacy Worker cannot claim an identity after a new allocation is committed', async () => {
  const env = freshEnv(); await fullFlow(env, 1001);
  env.DB.db.exec("INSERT INTO reward_deck(slot,reward_id) VALUES(9003,'LEGACY_REWARD')");
  assert.throws(() => env.DB.db.exec("UPDATE reward_deck SET customer_key='cust:5',customer_email='a@x.com',order_id='1001' WHERE slot=9003"), /REWARD_ALREADY_ALLOCATED/);
  assert.equal(env.DB.db.prepare('SELECT customer_key FROM reward_deck WHERE slot=9003').get().customer_key, null);
  assert.throws(() => env.DB.db.exec("INSERT INTO reward_deck(slot,reward_id,customer_key,customer_email,order_id) VALUES(9006,'LEGACY_REWARD','cust:5','a@x.com','1001')"), /REWARD_ALREADY_ALLOCATED/);
  assert.equal(env.DB.db.prepare('SELECT COUNT(*) n FROM reward_deck WHERE slot=9006').get().n, 0);
});

test('open allocates a server-selected physical reward and records exactly one stock unit', async () => {
  const env = freshEnv();
  const { o } = await fullFlow(env, 1001);
  assert.equal(o.status, 200); assert.equal(o.json.alreadyOpened, false);
  assert.equal(o.json.reward.type, 'physical');
  assert.ok(REWARD_IDS.includes(env.DB.db.prepare('SELECT reward_id FROM reward_allocation').get().reward_id));
  assert.equal(env.DB.db.prepare('SELECT stock_decremented FROM reward_allocation').get().stock_decremented, 1);
  assert.equal(env.DB.db.prepare('SELECT SUM(initial_quantity-remaining_quantity) n FROM reward_inventory WHERE is_fallback=0').get().n, 1);
  assert.equal(env.DB.db.prepare('SELECT reward_slot FROM envelope_auth').get().reward_slot, null);
});

const REWARD_IDS = ['SUPER_YOU_PROTEIN','PSYCHO_PUMP','PROTEIN_SAMPLE_BOX','REGULAR_SHAKER','TSHIRT','STEEL_SHAKER','MUSCLE_SCIENCE_PREWORKOUT','BIG_FLEX_BCAA','PINTOLA_OATS','KEYCHAIN','BETTER_LUCK'];

test('allocation retry returns the same reward and never consumes additional stock', async () => {
  const env = freshEnv(); const { v, o } = await fullFlow(env, 1001);
  const before = env.DB.db.prepare('SELECT SUM(remaining_quantity) n FROM reward_inventory WHERE is_fallback=0').get().n;
  const again = await open(env, v.json.sessionToken);
  assert.equal(again.status, 200); assert.deepEqual(again.json.reward, o.json.reward);
  assert.equal(claimed(env), 1);
  assert.equal(env.DB.db.prepare('SELECT SUM(remaining_quantity) n FROM reward_inventory WHERE is_fallback=0').get().n, before);
});

test('a fresh handoff for the same Order ID replays its allocation without another stock decrement', async () => {
  const env = freshEnv();
  const first = await fullFlow(env, 1001, null, 'nonce-order-replay-0001');
  const before = env.DB.db.prepare('SELECT SUM(remaining_quantity) n FROM reward_inventory WHERE is_fallback=0').get().n;
  const replay = await fullFlow(env, 1001, null, 'nonce-order-replay-0002');
  assert.equal(replay.v.json.alreadyOpened, true);
  assert.equal(replay.o.status, 200);
  assert.deepEqual(replay.o.json.reward, first.o.json.reward);
  assert.equal(replay.o.json.alreadyOpened, true);
  assert.equal(claimed(env), 1);
  assert.equal(env.DB.db.prepare('SELECT SUM(remaining_quantity) n FROM reward_inventory WHERE is_fallback=0').get().n, before);
});

test('12 parallel opens for one session create one allocation and identical responses', async () => {
  const env = freshEnv(); const a = await authorize(env); const v = await verify(env, a.json.handoffToken);
  const rs = await Promise.all(Array.from({ length: 12 }, () => open(env, v.json.sessionToken)));
  assert.ok(rs.every(r => r.status === 200));
  assert.equal(new Set(rs.map(r => JSON.stringify(r.json.reward))).size, 1);
  assert.equal(claimed(env), 1);
});

test('concurrent different eligible Order IDs for one customer allocate without overselling', async () => {
  const env = freshEnv(); env.DB.db.exec('UPDATE reward_inventory SET remaining_quantity=0 WHERE is_fallback=0');
  env.DB.db.exec("UPDATE reward_inventory SET remaining_quantity=1 WHERE reward_id='KEYCHAIN'");
  orders[1101] = mkOrder(1101, { customer_id: 11, billing: { email: 'same-customer@x.com', phone: '9876543210' } });
  orders[1102] = mkOrder(1102, { customer_id: 11, billing: { email: 'same-customer@x.com', phone: '9876543210' } });
  const a1 = await authorize(env, 1101); const a2 = await authorize(env, 1102);
  const v1 = await verify(env, a1.json.handoffToken, 'nonce-111111111111');
  const v2 = await verify(env, a2.json.handoffToken, 'nonce-222222222222');
  const rs = await Promise.all([open(env, v1.json.sessionToken), open(env, v2.json.sessionToken)]);
  assert.ok(rs.every(r => r.status === 200));
  assert.deepEqual(rs.map(r => r.json.reward.title).sort(), ['BETTER LUCK NEXT TIME!','Keychain'].sort());
  assert.equal(env.DB.db.prepare("SELECT remaining_quantity FROM reward_inventory WHERE reward_id='KEYCHAIN'").get().remaining_quantity, 0);
  assert.equal(env.DB.db.prepare('SELECT MIN(remaining_quantity) n FROM reward_inventory WHERE is_fallback=0').get().n, 0);
  assert.equal(claimed(env), 2);
  assert.equal(env.DB.db.prepare("SELECT COUNT(*) n FROM reward_allocation WHERE customer_key='cust:11'").get().n, 2);
});

test('all 216 physical units allocate once in exact configured quantities, then fallback continues', async () => {
  const env = freshEnv(); const observed = {};
  for (let i = 0; i < 216; i++) {
    const id = 30000 + i;
    orders[id] = mkOrder(id, { customer_id: 5000 + i, billing: { email: `physical-${i}@example.test` } });
    const { o } = await fullFlow(env, id, null, `nonce-customer-${String(i).padStart(10, '0')}`);
    assert.equal(o.status, 200, `allocation ${i}: ${JSON.stringify(o.json)}`);
    const row = env.DB.db.prepare('SELECT a.reward_id, i.reward_name, i.unit_value_paise FROM reward_allocation a JOIN reward_inventory i USING(reward_id) WHERE a.order_id=?').get(String(id));
    assert.equal(o.json.reward.type, 'physical');
    assert.equal(o.json.reward.title, row.reward_name);
    assert.equal(o.json.reward.value, row.unit_value_paise == null ? null : row.unit_value_paise / 100);
    const rewardId = row.reward_id;
    observed[rewardId] = (observed[rewardId] || 0) + 1;
  }
  const expected = Object.fromEntries(env.DB.db.prepare('SELECT reward_id, initial_quantity FROM reward_inventory WHERE is_fallback=0').all().map(r => [r.reward_id, r.initial_quantity]));
  assert.deepEqual(observed, expected);
  assert.equal(env.DB.db.prepare('SELECT SUM(remaining_quantity) n FROM reward_inventory WHERE is_fallback=0').get().n, 0);
  orders[30216] = mkOrder(30216, { customer_id: 6000, billing: { email: 'fallback@example.test' } });
  const fallback = await fullFlow(env, 30216, null, 'nonce-fallback-0000000000');
  assert.equal(fallback.o.json.reward.title, 'BETTER LUCK NEXT TIME!');
  assert.equal(claimed(env), 217);
});

test('exhausted finite stock allocates Better Luck without a finite-stock decrement', async () => {
  const env = freshEnv(); env.DB.db.exec('UPDATE reward_inventory SET remaining_quantity=0 WHERE is_fallback=0');
  const { o } = await fullFlow(env, 1001);
  assert.equal(o.json.reward.title, 'BETTER LUCK NEXT TIME!');
  assert.equal(env.DB.db.prepare('SELECT reward_id FROM reward_allocation').get().reward_id, 'BETTER_LUCK');
  assert.equal(env.DB.db.prepare('SELECT stock_decremented FROM reward_allocation').get().stock_decremented, 0);
  assert.equal((await call(env, '/api/envelope/status', null, { method: 'GET', origin: ENV_ORIGIN })).json.state, 'open');
});

test('transaction failure rolls back allocation and stock decrement; retry can succeed', async () => {
  const errors = []; const oldError = console.error; console.error = (...args) => errors.push(args.join(' '));
  const env = freshEnv(); env.DB.db.exec("CREATE TRIGGER fail_sheet BEFORE INSERT ON sheet_sync BEGIN SELECT RAISE(ABORT,'test outbox failure'); END");
  const a = await authorize(env); const v = await verify(env, a.json.handoffToken);
  const initial = env.DB.db.prepare('SELECT SUM(remaining_quantity) n FROM reward_inventory WHERE is_fallback=0').get().n;
  assert.equal((await open(env, v.json.sessionToken)).status, 500);
  assert.equal(claimed(env), 0);
  assert.equal(env.DB.db.prepare('SELECT SUM(remaining_quantity) n FROM reward_inventory WHERE is_fallback=0').get().n, initial);
  assert.equal(errors.length, 1); assert.match(errors[0], /envelope-api error/);
  env.DB.db.exec('DROP TRIGGER fail_sheet');
  assert.equal((await open(env, v.json.sessionToken)).status, 200);
  console.error = oldError;
});

test('saved allocation replay after campaign close returns the exact saved reward', async () => {
  const env = freshEnv(); setNow('2026-11-09T23:59:59+05:30'); const { v, o } = await fullFlow(env, 1001);
  setNow('2026-11-10T00:00:00+05:30');
  const again = await open(env, v.json.sessionToken);
  assert.equal(again.status, 200); assert.deepEqual(again.json.reward, o.json.reward);
  setNow('2026-11-09T10:00:00+05:30');
});

test('different eligible Order IDs with the same customer ID allocate independently', async () => {
  const env = freshEnv(); const first = await fullFlow(env, 1001);
  orders[1005] = mkOrder(1005, { customer_id: 5, billing: { email: 'a@x.com', phone: '9876543210' } });
  const second = await fullFlow(env, 1005, null, 'nonce-second-0123456789');
  assert.equal(first.o.json.alreadyOpened, false); assert.equal(second.o.json.alreadyOpened, false);
  assert.equal(claimed(env), 2);
  assert.equal(env.DB.db.prepare("SELECT COUNT(*) n FROM reward_allocation WHERE customer_key='cust:5'").get().n, 2);
});

test('different eligible Order IDs with the same billing email allocate independently', async () => {
  const env = freshEnv(); await fullFlow(env, 1001);
  orders[1010] = mkOrder(1010, { customer_id: 77, billing: { email: 'a@x.com', phone: '9876543210' } });
  const second = await fullFlow(env, 1010, null, 'nonce-email-1010-0000001');
  assert.equal(second.o.json.alreadyOpened, false);
  assert.equal(claimed(env), 2);
  assert.equal(env.DB.db.prepare("SELECT COUNT(*) n FROM reward_allocation WHERE customer_email='a@x.com'").get().n, 2);
});

test('authorized customer cannot choose a reward in request data', async () => {
  const env = freshEnv(); const a = await authorize(env); const v = await verify(env, a.json.handoffToken);
  const r = await call(env, '/api/envelope/open', { sessionToken: v.json.sessionToken, rewardId: 'BETTER_LUCK', reward: 'coupon', slot: -1 }, { origin: ENV_ORIGIN });
  assert.equal(r.status, 200); assert.notEqual(env.DB.db.prepare('SELECT reward_id FROM reward_allocation').get().reward_id, 'R2_BUMPER');
});

test('invalid and expired sessions cannot allocate stock', async () => {
  const env = freshEnv(); const a = await authorize(env); const v = await verify(env, a.json.handoffToken);
  assert.equal((await open(env, 'garbage')).status, 401); advance(21 * 60);
  assert.equal((await open(env, v.json.sessionToken)).status, 401); assert.equal(claimed(env), 0);
  setNow('2026-11-09T10:00:00+05:30');
});

test('allocation transaction uses weighted remaining-stock selection and campaign close boundary', () => {
  const source = readFileSync(new URL('../worker.js', import.meta.url), 'utf8');
  assert.match(source, /SUM\(remaining_quantity\) OVER \(ORDER BY reward_id\)/);
  assert.match(source, /abs\(random\(\)\) % total/);
  assert.match(source, /AND unixepoch\(\) < \?7/);
  assert.match(source, /INSERT OR IGNORE INTO reward_allocation/);
});

test('seed does not initialize a fixed card deck', () => {
  const seed = readFileSync(new URL('../seed.sql', import.meta.url), 'utf8');
  assert.doesNotMatch(seed, /2000|reward_deck|R1_LUCK|DIWALI50/i);
});

test('frontend contains no simulated rewards/auth flow or Worker sync secret', () => {
  const html = readFileSync(new URL('../cloudflare-pages-deploy/index.html', import.meta.url), 'utf8');
  assert.doesNotMatch(html, /DEMO-|Demo controls|Enter the code you received on your mail|email-code/i);
  assert.doesNotMatch(html, /WORKER_SYNC_SECRET|worker-side-secret/);
  assert.doesNotMatch(html, /<input\b[^>]*(?:type=["']email|name=["']order)/i);
  assert.match(html, /<button[^>]+id="usd-gate-open"[^>]*>[^]*?OPEN THE GATE/);
  assert.match(html, /API\.verify\(handoff, clientNonce\)/);
  assert.match(html, /el\.gateOpen\.addEventListener\('click'/);
});

test('all Pages copies render only Worker-supplied physical reward data and contain no old coupon rewards', () => {
  for (const file of ['../Index.html', '../cloudflare-pages-deploy/index.html', '../cloudflare-pages-staging/index.html']) {
    const html = readFileSync(new URL(file, import.meta.url), 'utf8');
    assert.match(html, /physical:\s*\{ icon: 'gift'/);
    assert.match(html, /reward\.claimInstructions/);
    assert.match(html, /reward\.value/);
    assert.doesNotMatch(html, /DIWALI50|DIWALI100|DIWALI4|DIWALI8|R1_LUCK|R2_BUMPER|2,000 envelopes|reward__code/);
    const scripts = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)].map(match => match[1]).filter(source => source.trim());
    assert.equal(scripts.length, 1, `${file} should contain one inline application script`);
    assert.doesNotThrow(() => new vm.Script(scripts[0], { filename: file }), `${file} inline JavaScript syntax`);
  }
});

test('WordPress mobile contract hands off to the configured Pages URL', () => {
  const php = readFileSync(new URL('../wp-envelope-auth.php', import.meta.url), 'utf8');
  assert.match(php, /name="phone" type="tel"/);
  assert.match(php, /body:\s*JSON\.stringify\(\{\s*orderId:\s*order,\s*phone:\s*phone\s*\}\)/);
  assert.doesNotMatch(php, /type="email"|orderId:\s*order,\s*email:/);
  assert.match(php, /base \+ '#token='/);
  assert.match(php, /https:\/\/us-supplements-diwali\.pages\.dev\//);
});

test('Pages frontend uses one Worker base for status, verify and open with no duplicate auth form', () => {
  const html = readFileSync(new URL('../cloudflare-pages-deploy/index.html', import.meta.url), 'utf8');
  assert.match(html, /API_BASE_URL:\s*'https:\/\/uss-diwali-auth-2026\.822005harsh\.workers\.dev'/);
  assert.match(html, /status:\s*'\/api\/envelope\/status'/);
  assert.match(html, /verify:\s*'\/api\/envelope\/verify'/);
  assert.match(html, /redeem:\s*'\/api\/envelope\/open'/);
  assert.match(html, /fetch\(base \+ path/);
  assert.doesNotMatch(html, /<form\b|<input\b[^>]*type=["'](?:tel|email)["']/i);
});

test('Pages lock states always offer a retry or a link back to the WordPress Order ID page', () => {
  for (const file of ['../Index.html', '../cloudflare-pages-deploy/index.html', '../cloudflare-pages-staging/index.html']) {
    const html = readFileSync(new URL(file, import.meta.url), 'utf8');
    assert.match(html, /LOCKED:\s*\['Your envelope is waiting'/);
    assert.match(html, /function addAuthAction\(code\)/);
    assert.match(html, /RETRYABLE\.has\(code\) && !!state\.handoffToken/);
    assert.match(html, /action\.href = CONFIG\.authPageUrl/);
    assert.doesNotMatch(html, /showAuth\('locked'\)|incomingToken \? 'INVALID_AUTH' : 'INVALID_AUTH'/);
  }
});

test('production and staging endpoint configuration stays separated', () => {
  const productionHtml = readFileSync(new URL('../cloudflare-pages-deploy/index.html', import.meta.url), 'utf8');
  const stagingHtml = readFileSync(new URL('../cloudflare-pages-staging/index.html', import.meta.url), 'utf8');
  const productionConfig = readFileSync(new URL('../wrangler.toml', import.meta.url), 'utf8');
  const stagingConfig = readFileSync(new URL('../wrangler.staging.toml', import.meta.url), 'utf8');
  assert.match(productionHtml, /API_BASE_URL:\s*'https:\/\/uss-diwali-auth-2026\.822005harsh\.workers\.dev'/);
  assert.match(productionHtml, /authPageUrl:\s*'https:\/\/ussupplements\.in\/diwali\/'/);
  assert.match(productionConfig, /ENVELOPE_ORIGINS = "https:\/\/us-supplements-diwali\.pages\.dev"/);
  assert.match(productionConfig, /GOOGLE_SHEETS_WEB_APP_URL = "https:\/\/script\.google\.com\/macros\/s\/[^\"]+\/exec"/);
  assert.match(stagingHtml, /API_BASE_URL:\s*'YOUR_STAGING_WORKER_URL'/);
  assert.match(stagingConfig, /GOOGLE_SHEETS_WEB_APP_URL = "REPLACE_WITH_STAGING_APPS_SCRIPT_DEPLOYMENT_URL"/);
  assert.doesNotMatch(stagingHtml + stagingConfig, /uss-diwali-auth-2026\.822005harsh\.workers\.dev|us-supplements-diwali\.pages\.dev|AKfycbwReatR4zL7d9dL8kuA7PW3fDpq-qy4uWPHXl7wA9YMBWKUUt08CiTi7fjZfdGCwwio/);
  assert.match(stagingConfig, /ENVELOPE_ORIGINS = "REQUIRED_STAGING_ENVELOPE_ORIGIN"/);
});

test('scheduled cleanup removes only expired unused auth and its customer records', async () => {
  const env = freshEnv();
  const now = Math.floor(Date.now() / 1000);
  const addAuth = (id, ageSeconds) => env.DB.db.prepare(
    'INSERT INTO envelope_auth (token_hash, order_id, customer_key, created_at, expires_at) VALUES (?, ?, ?, ?, ?)'
  ).run(`cleanup-hash-${id}`, String(id), `cust:${id}`, now - ageSeconds, now + 3600).lastInsertRowid;
  const expired = addAuth(71001, 7 * 24 * 3600 + 1);
  const current = addAuth(71002, 60);
  const allocated = addAuth(71003, 7 * 24 * 3600 + 1);
  for (const [authId, name] of [[expired, 'expired'], [current, 'current'], [allocated, 'allocated']]) {
    env.DB.db.prepare('INSERT INTO envelope_customer (auth_id, customer_name, phone_number) VALUES (?, ?, ?)').run(authId, name, '9999999999');
    env.DB.db.prepare('INSERT INTO envelope_customer_issue (auth_id, data_issue) VALUES (?, ?)').run(authId, `issue-${name}`);
  }
  env.DB.db.prepare('INSERT INTO reward_allocation (auth_id, order_id, customer_key, reward_id) VALUES (?, ?, ?, ?)')
    .run(allocated, '71003', 'cust:71003', 'KEYCHAIN');

  await worker.scheduled({}, env);

  assert.equal(env.DB.db.prepare('SELECT COUNT(*) n FROM envelope_auth WHERE id=?').get(expired).n, 0);
  assert.equal(env.DB.db.prepare('SELECT COUNT(*) n FROM envelope_customer WHERE auth_id=?').get(expired).n, 0);
  assert.equal(env.DB.db.prepare('SELECT COUNT(*) n FROM envelope_customer_issue WHERE auth_id=?').get(expired).n, 0);
  for (const id of [current, allocated]) {
    assert.equal(env.DB.db.prepare('SELECT COUNT(*) n FROM envelope_auth WHERE id=?').get(id).n, 1);
    assert.equal(env.DB.db.prepare('SELECT COUNT(*) n FROM envelope_customer WHERE auth_id=?').get(id).n, 1);
    assert.equal(env.DB.db.prepare('SELECT COUNT(*) n FROM envelope_customer_issue WHERE auth_id=?').get(id).n, 1);
  }
});

test('scheduled cleanup rolls back customer-data deletes if auth deletion fails', async () => {
  const env = freshEnv();
  const now = Math.floor(Date.now() / 1000);
  const authId = env.DB.db.prepare(
    'INSERT INTO envelope_auth (token_hash, order_id, customer_key, created_at, expires_at) VALUES (?, ?, ?, ?, ?)'
  ).run('cleanup-rollback-hash', '71004', 'cust:71004', now - 7 * 24 * 3600 - 1, now + 3600).lastInsertRowid;
  env.DB.db.prepare('INSERT INTO envelope_customer (auth_id, customer_name, phone_number) VALUES (?, ?, ?)').run(authId, 'rollback', '9999999999');
  env.DB.db.prepare('INSERT INTO envelope_customer_issue (auth_id, data_issue) VALUES (?, ?)').run(authId, 'rollback-issue');
  env.DB.db.exec("CREATE TRIGGER fail_expired_auth_delete BEFORE DELETE ON envelope_auth BEGIN SELECT RAISE(ABORT, 'test cleanup failure'); END");

  await assert.rejects(worker.scheduled({}, env), /test cleanup failure/);
  assert.equal(env.DB.db.prepare('SELECT COUNT(*) n FROM envelope_auth WHERE id=?').get(authId).n, 1);
  assert.equal(env.DB.db.prepare('SELECT COUNT(*) n FROM envelope_customer WHERE auth_id=?').get(authId).n, 1);
  assert.equal(env.DB.db.prepare('SELECT COUNT(*) n FROM envelope_customer_issue WHERE auth_id=?').get(authId).n, 1);
});

test('scheduled sync records missing URL and secret as retryable configuration errors', async () => {
  for (const [missing, expectedError] of [
    ['GOOGLE_SHEETS_WEB_APP_URL', 'CONFIG_MISSING_GOOGLE_SHEETS_WEB_APP_URL'],
    ['WORKER_SYNC_SECRET', 'CONFIG_MISSING_WORKER_SYNC_SECRET']
  ]) {
    const env = freshEnv();
    env.WORKER_SYNC_SECRET = 'local-test-secret';
    env.GOOGLE_SHEETS_WEB_APP_URL = 'https://script.google.com/macros/s/local-test/exec';
    delete env[missing];
    const now = Math.floor(Date.now() / 1000);
    env.DB.db.prepare(`INSERT INTO sheet_sync (order_id, reward_type, envelope_result, sync_state, attempts, next_attempt_at)
      VALUES ('71005', 'KEYCHAIN', 'Keychain', 'pending', 0, ?)` ).run(now - 1);

    await worker.scheduled({}, env);

    const row = env.DB.db.prepare('SELECT * FROM sheet_sync WHERE order_id=?').get('71005');
    assert.equal(row.sync_state, 'pending');
    assert.equal(row.attempts, 1);
    assert.equal(row.next_attempt_at, now + 30);
    assert.equal(row.last_error, expectedError);
    assert.doesNotMatch(row.last_error, /local-test-secret|script\.google\.com/);
  }
});

test('Sheets sync: failed first attempt stays pending, retry follows Apps Script redirect and is idempotent', async () => {
  const env = freshEnv();
  orders[1001].billing = { email: 'a@x.com', first_name: 'Asha', last_name: 'Rao', phone: '9876543210' };
  env.WORKER_SYNC_SECRET = 'worker-side-secret';
  env.GOOGLE_SHEETS_WEB_APP_URL = 'https://script.google.com/macros/s/example/exec';
  sheetMode = 'outage';
  const { v, o } = await fullFlow(env, 1001, 'a@x.com');
  assert.equal(o.status, 200);
  assert.equal(claimed(env), 1);
  let record = env.DB.db.prepare('SELECT * FROM sheet_sync WHERE order_id = ?').get('1001');
  assert.equal(record.sync_state, 'pending');
  assert.equal(record.name, 'Asha Rao');
  assert.equal(record.phone_number, '9876543210');
  sheetMode = 'ok';
  const retry = await open(env, v.json.sessionToken);
  assert.equal(retry.status, 200);
  assert.equal(claimed(env), 1);
  record = env.DB.db.prepare('SELECT * FROM sheet_sync WHERE order_id = ?').get('1001');
  assert.equal(record.sync_state, 'synced');
  assert.equal(sheetRequests.length, 2);
  assert.deepEqual(Object.keys(sheetRequests.at(-1)).sort(), ['envelope_result', 'name', 'order_id', 'phone', 'reward_type', 'secret'].sort());
  assert.equal(sheetRequests.at(-1).secret, 'worker-side-secret');
  assert.equal(sheetRequests.at(-1).order_id, '1001');
  const fields = env.DB.db.prepare('SELECT order_id, name, phone_number, reward_type, envelope_result FROM sheet_sync WHERE order_id = ?').get('1001');
  assert.deepEqual({ ...fields }, { order_id: sheetRequests.at(-1).order_id, name: sheetRequests.at(-1).name, phone_number: sheetRequests.at(-1).phone, reward_type: sheetRequests.at(-1).reward_type, envelope_result: sheetRequests.at(-1).envelope_result });
  const allocation = env.DB.db.prepare('SELECT a.reward_id, i.reward_name FROM reward_allocation a JOIN reward_inventory i USING(reward_id) WHERE a.order_id=?').get('1001');
  assert.equal(fields.reward_type, allocation.reward_id);
  assert.equal(fields.envelope_result, allocation.reward_name);
  await open(env, v.json.sessionToken);
  assert.equal(sheetRequests.length, 2, 'synced records are not posted again on replay');
});

test('Sheets sync failures record specific non-sensitive diagnostic codes and stay pending', async () => {
  for (const [mode, expected] of [['outage', 'SHEETS_HTTP_503'], ['conflict', 'SHEETS_REJECTED_ORDER_ID_CONFLICT'], ['login-page', 'SHEETS_HTTP_200_NON_JSON']]) {
    const env = freshEnv();
    env.WORKER_SYNC_SECRET = 'worker-side-secret';
    env.GOOGLE_SHEETS_WEB_APP_URL = 'https://script.google.com/macros/s/example/exec';
    sheetMode = mode;
    const { o } = await fullFlow(env, 1001, null, 'nonce-diag-1001-00000001');
    assert.equal(o.status, 200, mode);
    const row = env.DB.db.prepare('SELECT sync_state, attempts, last_error FROM sheet_sync WHERE order_id = ?').get('1001');
    assert.equal(row.sync_state, 'pending', mode);
    assert.equal(row.attempts, 1, mode);
    assert.equal(row.last_error, expected);
    assert.doesNotMatch(row.last_error, /worker-side-secret|script\.google\.com|Asha|9876543210/);
  }
});

test('open returns the reward without waiting for Sheets when an execution context is available', async () => {
  const env = freshEnv();
  env.WORKER_SYNC_SECRET = 'worker-side-secret';
  env.GOOGLE_SHEETS_WEB_APP_URL = 'https://script.google.com/macros/s/example/exec';
  const a = await authorize(env);
  const v = await verify(env, a.json.handoffToken);
  const deferred = [];
  const ctx = { waitUntil: (p) => { deferred.push(p); } };
  const res = await worker.fetch(new Request('https://api.example/api/envelope/open', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: ENV_ORIGIN }, body: JSON.stringify({ sessionToken: v.json.sessionToken })
  }), env, ctx);
  assert.equal(res.status, 200);
  assert.equal((await res.json()).success, true);
  assert.equal(deferred.length, 1, 'sync is handed to waitUntil');
  await Promise.all(deferred);
  assert.equal(env.DB.db.prepare('SELECT sync_state FROM sheet_sync WHERE order_id = ?').get('1001').sync_state, 'synced');
  assert.equal(sheetRequests.length, 1);
  assert.equal(claimed(env), 1);
});

test('Sheets outbox stays unique per Order ID when one customer has two eligible orders', async () => {
  const env = freshEnv();
  env.WORKER_SYNC_SECRET = 'worker-side-secret';
  env.GOOGLE_SHEETS_WEB_APP_URL = 'https://script.google.com/macros/s/example/exec';
  orders[1011] = mkOrder(1011, { customer_id: 5, billing: { email: 'a@x.com', phone: '9876543210' } });
  const first = await fullFlow(env, 1001, null, 'nonce-sheet-1001-0000001');
  const second = await fullFlow(env, 1011, null, 'nonce-sheet-1011-0000001');
  assert.equal(first.o.status, 200); assert.equal(second.o.status, 200);
  const rows = env.DB.db.prepare('SELECT order_id, reward_type, envelope_result, sync_state FROM sheet_sync ORDER BY order_id').all();
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map(row => row.order_id), ['1001', '1011']);
  assert.ok(rows.every(row => row.sync_state === 'synced'));
  assert.equal(sheetRequests.length, 2);
  await open(env, first.v.json.sessionToken);
  await open(env, second.v.json.sessionToken);
  assert.equal(env.DB.db.prepare('SELECT COUNT(*) n FROM sheet_sync').get().n, 2);
  assert.equal(sheetRequests.length, 2, 'saved Order IDs do not create or post duplicate records');
});

/* ---------------- CORS & request hygiene ---------------- */
test('cors: each route only accepts its own exact origins (enforced server-side)', async () => {
  const env = freshEnv();
  const wrong1 = await call(env, '/api/envelope/authorize', { orderId: 1001, phone: '9876543210' }, { origin: ENV_ORIGIN });
  const wrong2 = await call(env, '/api/envelope/verify', { handoffToken: 'A'.repeat(43), clientNonce: 'n'.repeat(20) }, { origin: AUTH_ORIGIN });
  const evil = await call(env, '/api/envelope/open', { sessionToken: 'x' }, { origin: 'https://evil.example' });
  for (const r of [wrong1, wrong2, evil]) { assert.equal(r.status, 403); assert.equal(r.json.error.code, 'ORIGIN_NOT_ALLOWED'); assert.equal(r.headers.get('access-control-allow-origin'), null); }
});
test('cors: allowed origin is echoed exactly, never a wildcard, never credentials', async () => {
  const env = freshEnv();
  const ok = await authorize(env);
  assert.equal(ok.headers.get('access-control-allow-origin'), AUTH_ORIGIN);
  assert.equal(ok.headers.get('vary'), 'Origin');
  assert.equal(ok.headers.get('access-control-allow-credentials'), null);
  const pre = await worker.fetch(new Request('https://api.example/api/envelope/verify', { method: 'OPTIONS', headers: { Origin: ENV_ORIGIN, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type' } }), env);
  assert.equal(pre.status, 204);
  assert.equal(pre.headers.get('access-control-allow-origin'), ENV_ORIGIN);
  const badPre = await worker.fetch(new Request('https://api.example/api/envelope/verify', { method: 'OPTIONS', headers: { Origin: AUTH_ORIGIN } }), env);
  assert.equal(badPre.status, 403);
});
test('cors: a "*" in the allow-list is ignored (fail closed)', async () => {
  const env = freshEnv(); env.ENVELOPE_ORIGINS = '*';
  const r = await call(env, '/api/envelope/status', null, { method: 'GET', origin: 'https://anything.example' });
  assert.equal(r.status, 403);
});
test('hygiene: non-JSON bodies, wrong methods, unknown routes, oversized bodies, security headers', async () => {
  const env = freshEnv();
  const form = await worker.fetch(new Request('https://api.example/api/envelope/verify', { method: 'POST', headers: { 'Content-Type': 'text/plain', Origin: ENV_ORIGIN }, body: 'x' }), env);
  assert.equal(form.status, 415);
  assert.equal((await call(env, '/api/envelope/verify', null, { method: 'GET', origin: ENV_ORIGIN })).status, 405);
  assert.equal((await call(env, '/api/envelope/nope', {})).status, 404);
  const big = await call(env, '/api/envelope/verify', { handoffToken: 'A'.repeat(5000), clientNonce: 'n'.repeat(20) }, { origin: ENV_ORIGIN });
  assert.equal(big.json.error.code, 'INVALID_AUTH');
  const ok = await authorize(env);
  assert.equal(ok.headers.get('cache-control'), 'no-store');
  assert.equal(ok.headers.get('x-content-type-options'), 'nosniff');
});
