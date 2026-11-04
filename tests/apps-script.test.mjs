import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

function loadAppsScript(sourcePath = '../apps-script/Code.gs', scriptProperties = { WORKER_SYNC_SECRET: 'test-secret', SPREADSHEET_ID: 'test-sheet' }, { hideQuotePrefix = false } = {}) {
  const rows = [];
  // Google Sheets treats a leading apostrophe as a hidden text prefix; display values omit it.
  const display = value => (hideQuotePrefix ? String(value).replace(/^'/, '') : String(value));
  const sheet = {
    maxColumns: 26,
    getLastColumn() { return rows.reduce((m, row) => Math.max(m, row.length), 0); },
    getMaxColumns() { return this.maxColumns; },
    deleteColumns(start, count) { assert.equal(start, 6); this.maxColumns -= count; },
    getLastRow() { return rows.length; },
    getRange(r, c, nr = 1, nc = 1) {
      return {
        getDisplayValues() { return Array.from({ length: nr }, (_, ri) => Array.from({ length: nc }, (_, ci) => display(rows[r - 1 + ri]?.[c - 1 + ci] ?? ''))); },
        setNumberFormat() { return this; },
        setValues(values) {
          values.forEach((value, ri) => {
            rows[r - 1 + ri] ||= [];
            value.forEach((cell, ci) => { rows[r - 1 + ri][c - 1 + ci] = cell; });
          });
          return this;
        }
      };
    }
  };
  const context = {
    PropertiesService: { getScriptProperties: () => ({ getProperty: key => scriptProperties[key] || null }) },
    LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
    SpreadsheetApp: { openById: id => { assert.equal(id, 'test-sheet'); return { getSheetByName: () => sheet, insertSheet: () => sheet }; }, flush() {} },
    ContentService: { MimeType: { JSON: 'application/json' }, createTextOutput: value => ({ getContent: () => value, setMimeType() { return this; } }) },
    rows,
  };
  vm.runInNewContext(readFileSync(new URL(sourcePath, import.meta.url), 'utf8'), context);
  return { doPost: context.doPost, rows };
}

const request = (secret, orderId = '12345') => ({ postData: { contents: JSON.stringify({ secret, order_id: orderId, name: 'Customer Name', phone: '9876543210', reward_type: 'KEYCHAIN', envelope_result: 'Keychain' }) } });
const parse = result => JSON.parse(result.getContent());

test('Apps Script: rejects an invalid shared secret', () => {
  const { doPost } = loadAppsScript();
  assert.deepEqual(parse(doPost(request('wrong'))), { success: false, error: 'UNAUTHORIZED' });
  assert.deepEqual(parse(doPost(request(undefined))), { success: false, error: 'UNAUTHORIZED' });
});

test('Apps Script fails closed when required Script Properties are missing', () => {
  const noSecret = loadAppsScript('../apps-script/Code.gs', { SPREADSHEET_ID: 'test-sheet' });
  assert.deepEqual(parse(noSecret.doPost(request('test-secret'))), { success: false, error: 'UNAUTHORIZED' });
  const noSpreadsheet = loadAppsScript('../apps-script/Code.gs', { WORKER_SYNC_SECRET: 'test-secret' });
  assert.deepEqual(parse(noSpreadsheet.doPost(request('test-secret'))), { success: false, error: 'SPREADSHEET_ID_NOT_CONFIGURED' });
});

test('Apps Script accepts only the secret plus five string record fields', () => {
  const { doPost, rows } = loadAppsScript();
  const extra = request('test-secret');
  extra.postData.contents = JSON.stringify({ ...JSON.parse(extra.postData.contents), unexpected: 'ignored?' });
  assert.deepEqual(parse(doPost(extra)), { success: false, error: 'INVALID_RECORD' });
  const wrongType = request('test-secret');
  wrongType.postData.contents = JSON.stringify({ ...JSON.parse(wrongType.postData.contents), name: { value: 'not a string' } });
  assert.deepEqual(parse(doPost(wrongType)), { success: false, error: 'INVALID_RECORD' });
  assert.equal(rows.length, 0);
});

test('Apps Script source never deletes columns', () => {
  const source = readFileSync(new URL('../apps-script/Code.gs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /deleteColumns\s*\(/);
});

test('Apps Script: writes exactly five fields and prevents duplicate Order ID rows', () => {
  const { doPost, rows } = loadAppsScript();
  assert.deepEqual(parse(doPost(request('test-secret'))), { success: true, duplicate: false, order_id: '12345' });
  assert.deepEqual(parse(doPost(request('test-secret'))), { success: true, duplicate: true, order_id: '12345' });
  const changed = request('test-secret');
  changed.postData.contents = JSON.stringify({ ...JSON.parse(changed.postData.contents), reward_type: 'PINTOLA_OATS', envelope_result: 'Pintola Oats – 1 serving' });
  assert.deepEqual(parse(doPost(changed)), { success: false, error: 'ORDER_ID_CONFLICT' });
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0], ['Order ID', 'Name', 'Phone Number', 'Reward Type', 'Envelope Result']);
  assert.deepEqual(rows[1], ['12345', 'Customer Name', '9876543210', 'KEYCHAIN', 'Keychain']);
  assert.deepEqual(Object.keys(JSON.parse(request('test-secret').postData.contents)).sort(), ['envelope_result', 'name', 'order_id', 'phone', 'reward_type', 'secret'].sort());
});

test('Apps Script rejects coupon/unknown reward mappings and mismatched display names', () => {
  const { doPost } = loadAppsScript();
  for (const [reward_type, envelope_result] of [['DIWALI50', '₹50 OFF - DIWALI50'], ['KEYCHAIN', 'Pintola Oats – 1 serving']]) {
    const req = request('test-secret');
    req.postData.contents = JSON.stringify({ ...JSON.parse(req.postData.contents), reward_type, envelope_result });
    assert.deepEqual(parse(doPost(req)), { success: false, error: 'INVALID_REWARD' });
  }
});

test('Apps Script accepts the complete physical reward ID/name mapping', () => {
  const { doPost, rows } = loadAppsScript();
  const rewards = {
    SUPER_YOU_PROTEIN: 'Super You Protein – 1 kg',
    PSYCHO_PUMP: 'One Science Psycho Pump – 15 servings',
    PROTEIN_SAMPLE_BOX: 'One Science Protein Sample Box',
    REGULAR_SHAKER: 'Shaker', TSHIRT: 'T-shirt', STEEL_SHAKER: 'Steel Shaker',
    MUSCLE_SCIENCE_PREWORKOUT: 'Muscle Science Pre-workout – 2-serving pack',
    BIG_FLEX_BCAA: 'Big Flex BCAA', PINTOLA_OATS: 'Pintola Oats – 1 serving',
    KEYCHAIN: 'Keychain', BETTER_LUCK: 'Better Luck Next Time'
  };
  for (const [i, [reward_type, envelope_result]] of Object.entries(rewards).entries()) {
    const req = request('test-secret', String(20000 + i));
    req.postData.contents = JSON.stringify({ ...JSON.parse(req.postData.contents), reward_type, envelope_result });
    assert.equal(parse(doPost(req)).success, true, reward_type);
  }
  assert.equal(rows.length, 12);
  assert.equal(rows[0].length, 5);
});

test('Apps Script: protects cells from formula injection', () => {
  const { doPost, rows } = loadAppsScript();
  const req = request('test-secret');
  req.postData.contents = JSON.stringify({ ...JSON.parse(req.postData.contents), name: '=IMPORTXML("https://bad.example","//x")' });
  assert.equal(parse(doPost(req)).success, true);
  assert.equal(rows[1][1], "'=IMPORTXML(\"https://bad.example\",\"//x\")");
});

test('staging Apps Script requires a staging spreadsheet property and has no live spreadsheet fallback', () => {
  const source = readFileSync(new URL('../apps-script-staging/Code.gs', import.meta.url), 'utf8');
  assert.match(source, /if\s*\(!spreadsheetId\)/);
  assert.match(source, /openById\(spreadsheetId\)/);
  assert.doesNotMatch(source, /1wRe7Hyf8gvd6op72UXZgOaS0EaWlyEDuEaFvZxgzw_E/);
});

test('staging Apps Script parses and writes the same five-column reward record through mocks', () => {
  const { doPost, rows } = loadAppsScript('../apps-script-staging/Code.gs');
  const req = request('test-secret', '8888');
  req.postData.contents = JSON.stringify({ ...JSON.parse(req.postData.contents), reward_type: 'BIG_FLEX_BCAA', envelope_result: 'Big Flex BCAA' });
  assert.equal(parse(doPost(req)).success, true);
  assert.deepEqual(rows[1], ['8888', 'Customer Name', '9876543210', 'BIG_FLEX_BCAA', 'Big Flex BCAA']);
});

test('Apps Script source requires an explicit spreadsheet property and contains no configured spreadsheet ID', () => {
  const source = readFileSync(new URL('../apps-script/Code.gs', import.meta.url), 'utf8');
  assert.match(source, /if\s*\(!spreadsheetId\)/);
  assert.match(source, /openById\(spreadsheetId\)/);
  assert.doesNotMatch(source, /1wRe7Hyf8gvd6op72UXZgOaS0EaWlyEDuEaFvZxgzw_E/);
});

test('Apps Script: exact retry is idempotent when Sheets hides the formula-protection apostrophe', () => {
  for (const hideQuotePrefix of [true, false]) {
    const { doPost, rows } = loadAppsScript('../apps-script/Code.gs', undefined, { hideQuotePrefix });
    const req = request('test-secret', '262500');
    req.postData.contents = JSON.stringify({ ...JSON.parse(req.postData.contents), phone: '+91 98765 43210' });
    assert.deepEqual(parse(doPost(req)), { success: true, duplicate: false, order_id: '262500' });
    assert.deepEqual(parse(doPost(req)), { success: true, duplicate: true, order_id: '262500' }, `hideQuotePrefix=${hideQuotePrefix}`);
    const conflict = request('test-secret', '262500');
    conflict.postData.contents = JSON.stringify({ ...JSON.parse(conflict.postData.contents), phone: '+91 91234 56789' });
    assert.deepEqual(parse(doPost(conflict)), { success: false, error: 'ORDER_ID_CONFLICT' });
    assert.equal(rows.length, 2);
  }
});
