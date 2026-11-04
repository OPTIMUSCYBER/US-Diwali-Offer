import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const html = readFileSync(new URL('../wordpress/diwali-unlock-page.html', import.meta.url), 'utf8');
const source = /<script>([\s\S]*)<\/script>/.exec(html)[1];

// Minimal stand-in for the live /home/diwali-unlock/ markup the script expects.
function loadForm(responder, { orderId = '#262500', phone = '+91 98765 43210' } = {}) {
  const el = (extra = {}) => ({ style: {}, dataset: {}, textContent: '', innerHTML: '', className: '', disabled: false, ...extra });
  const statusParts = { '.status-icon': el(), h2: el(), p: el() };
  const statusBox = el({ querySelector: (s) => statusParts[s] });
  const submit = el();
  let onSubmit;
  const form = el({ addEventListener: (_type, fn) => { onSubmit = fn; } });
  const inputs = { '#diwaliOrder': el({ value: orderId }), '#diwaliPhone': el({ value: phone }) };
  const nodes = { '#diwaliVerifyForm': form, '#diwaliSubmit': submit, '#diwaliStatus': statusBox, '#diwaliParticles': el({ appendChild() {} }), ...inputs };
  const classes = new Set();
  const root = el({ querySelector: (s) => nodes[s], classList: { add: (c) => classes.add(c), remove: (c) => classes.delete(c) } });
  const requests = [], assigned = [], alerts = [];
  const context = {
    document: { getElementById: (id) => (id === 'diwali-entry' ? root : null), createElement: () => el() },
    window: { location: { assign: (u) => assigned.push(u) }, addEventListener() {}, AbortController },
    fetch: async (url, opts) => { requests.push({ url, opts, body: JSON.parse(opts.body) }); return responder(); },
    alert: (m) => alerts.push(m),
    // Run the short redirect delay immediately; keep the 15 s request timeout real.
    setTimeout: (fn, ms) => (ms < 5000 ? (fn(), 0) : setTimeout(fn, ms)), clearTimeout, AbortController, Math, JSON, encodeURIComponent
  };
  vm.runInNewContext(source, context);
  return { submit: () => onSubmit({ preventDefault() {} }), requests, assigned, alerts, statusBox, statusParts, button: submit, form, classes };
}
const json = (body, status = 200) => new Response(JSON.stringify(body), { status });
const TOKEN = 'A'.repeat(21) + '_-' + 'b'.repeat(20);

test('WordPress form script contains no backslashes (the WordPress editor strips them)', () => {
  // Observed live 2026-11-04: /^\d{6}$/ was saved as /^d{6}$/, rejecting every real Order ID.
  assert.ok(!source.includes('\\'), 'use character classes like [0-9] instead of escapes');
});

test('WordPress form: success redirects to the envelope page with the handoff token and no static code', async () => {
  const f = loadForm(() => json({ success: true, handoffToken: TOKEN, expiresInSeconds: 600, alreadyOpened: false }));
  await f.submit();
  assert.equal(f.requests.length, 1);
  assert.equal(f.requests[0].url, 'https://uss-diwali-auth-2026.822005harsh.workers.dev/api/envelope/authorize');
  assert.deepEqual(f.requests[0].body, { orderId: '262500', phone: '919876543210' });
  assert.equal(f.requests[0].opts.credentials, 'omit');
  assert.deepEqual(f.assigned, ['https://us-supplements-diwali.pages.dev/#token=' + TOKEN]);
  assert.equal(f.button.disabled, true, 'button stays disabled while redirecting');
  assert.ok(f.classes.has('is-open'), 'the page envelope opens before the redirect');
  assert.equal(f.form.style.display, 'none');
  assert.equal(f.statusParts.h2.textContent, 'Order verified!');
  assert.doesNotMatch(source, /DIWALI2026|REPLACE-WITH-ENVELOPE-PAGE-SLUG|diwali-code/);
  assert.match(html, /<form id="diwaliVerifyForm">/, 'original form markup is kept');
});

test('WordPress form: ineligible or unmatched orders show "Order not eligible" and never redirect', async () => {
  for (const code of ['INELIGIBLE_ORDER', 'INVALID_ORDER']) {
    const f = loadForm(() => json({ success: false, error: { code } }, code === 'INVALID_ORDER' ? 404 : 403));
    await f.submit();
    assert.deepEqual(f.assigned, []);
    assert.equal(f.statusBox.className, 'diwali-status error');
    assert.equal(f.statusParts.h2.textContent, 'Order not eligible');
    assert.equal(f.button.disabled, false);
    assert.ok(!f.classes.has('is-open'));
  }
});

test('WordPress form: pre-launch, malformed token, network failure and bad input are handled safely', async () => {
  const early = loadForm(() => json({ success: false, error: { code: 'CAMPAIGN_NOT_STARTED' } }, 403));
  await early.submit();
  assert.equal(early.statusParts.h2.textContent, 'Not open yet');
  const badToken = loadForm(() => json({ success: true, handoffToken: 'short' }));
  await badToken.submit();
  assert.deepEqual(badToken.assigned, []);
  assert.equal(badToken.statusParts.h2.textContent, 'Something went wrong');
  const offline = loadForm(() => { throw new TypeError('Failed to fetch'); });
  await offline.submit();
  assert.equal(offline.statusParts.h2.textContent, 'Connection error');
  const badId = loadForm(() => assert.fail('must not call the Worker'), { orderId: '12ab' });
  await badId.submit();
  assert.equal(badId.requests.length, 0);
  assert.equal(badId.alerts.length, 1);
});
