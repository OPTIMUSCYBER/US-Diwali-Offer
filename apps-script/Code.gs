/**
 * US Supplements Diwali redemption logger.
 * Configure Script Properties before deploying as a Web App:
 *   WORKER_SYNC_SECRET = the same secret stored as Cloudflare Worker Secret WORKER_SYNC_SECRET
 *   SPREADSHEET_ID = ID of the explicitly selected spreadsheet for this deployment
 * Deploy as a Web App executing as the owner. This source is not deployed automatically.
 */
const SHEET_NAME = 'Redemption Records';
const HEADERS = ['Order ID', 'Name', 'Phone Number', 'Reward Type', 'Envelope Result'];
const REWARDS = {
  SUPER_YOU_PROTEIN: 'Super You Protein – 1 kg',
  PSYCHO_PUMP: 'One Science Psycho Pump – 15 servings',
  PROTEIN_SAMPLE_BOX: 'One Science Protein Sample Box',
  REGULAR_SHAKER: 'Shaker',
  TSHIRT: 'T-shirt',
  STEEL_SHAKER: 'Steel Shaker',
  MUSCLE_SCIENCE_PREWORKOUT: 'Muscle Science Pre-workout – 2-serving pack',
  BIG_FLEX_BCAA: 'Big Flex BCAA',
  PINTOLA_OATS: 'Pintola Oats – 1 serving',
  KEYCHAIN: 'Keychain',
  BETTER_LUCK: 'Better Luck Next Time'
};

function doPost(e) {
  try {
    const props = PropertiesService.getScriptProperties();
    const expected = props.getProperty('WORKER_SYNC_SECRET');
    const contents = e && e.postData && e.postData.contents;
    if (typeof contents !== 'string' || contents.length > 4096) {
      return json_({ success: false, error: 'INVALID_RECORD' });
    }
    const data = JSON.parse(contents);
    const supplied = data && data.secret;
    if (!expected || typeof supplied !== 'string' || !constantTimeEqual_(expected, supplied)) {
      return json_({ success: false, error: 'UNAUTHORIZED' });
    }

    const requiredKeys = ['secret', 'order_id', 'name', 'phone', 'reward_type', 'envelope_result'];
    if (!data || typeof data !== 'object' || Array.isArray(data) ||
        Object.keys(data).length !== requiredKeys.length ||
        requiredKeys.some(key => !Object.prototype.hasOwnProperty.call(data, key)) ||
        requiredKeys.some(key => typeof data[key] !== 'string')) {
      return json_({ success: false, error: 'INVALID_RECORD' });
    }
    const orderId = data.order_id.trim();
    const name = data.name.trim();
    const phone = data.phone.trim();
    const rewardType = data.reward_type.trim();
    const result = data.envelope_result.trim();
    if (!/^\d{1,12}$/.test(orderId) || [name, phone, rewardType, result].some(v => v.length > 300)) {
      return json_({ success: false, error: 'INVALID_RECORD' });
    }
    if (!Object.prototype.hasOwnProperty.call(REWARDS, rewardType) || REWARDS[rewardType] !== result) {
      return json_({ success: false, error: 'INVALID_REWARD' });
    }

    const lock = LockService.getScriptLock();
    lock.waitLock(20000);
    try {
      const spreadsheetId = props.getProperty('SPREADSHEET_ID');
      if (!spreadsheetId) return json_({ success: false, error: 'SPREADSHEET_ID_NOT_CONFIGURED' });
      const ss = SpreadsheetApp.openById(spreadsheetId);
      const sheet = ss.getSheetByName(SHEET_NAME);
      if (!sheet) return json_({ success: false, error: 'SHEET_NOT_FOUND' });
      const lastColumn = sheet.getLastColumn();
      if (lastColumn > HEADERS.length) return json_({ success: false, error: 'UNEXPECTED_SHEET_STRUCTURE' });
      if (sheet.getLastRow() === 0) {
        sheet.getRange(1, 1, 1, HEADERS.length).setValues([HEADERS]);
      } else {
        const actual = sheet.getRange(1, 1, 1, HEADERS.length).getDisplayValues()[0];
        if (HEADERS.some((h, i) => actual[i] !== h)) return json_({ success: false, error: 'INVALID_HEADERS' });
      }
      const row = [orderId, safeCell_(name), safeCell_(phone), safeCell_(rewardType), safeCell_(result)];
      const rows = sheet.getLastRow() > 1 ? sheet.getRange(2, 1, sheet.getLastRow() - 1, HEADERS.length).getDisplayValues() : [];
      const existingIndex = rows.findIndex(existing => String(existing[0]) === orderId);
      if (existingIndex >= 0) {
        const existing = rows[existingIndex];
        // Sheets may hide the formula-protection apostrophe added by safeCell_, so an exact
        // retry must compare without it or a lost acknowledgement becomes a permanent conflict.
        const matches = row.every((value, index) => unquoteCell_(String(existing[index])) === unquoteCell_(value));
        return json_(matches
          ? { success: true, duplicate: true, order_id: orderId }
          : { success: false, error: 'ORDER_ID_CONFLICT' });
      }
      const target = sheet.getLastRow() + 1;
      sheet.getRange(target, 1, 1, HEADERS.length).setNumberFormat('@').setValues([row]);
      SpreadsheetApp.flush();
      return json_({ success: true, duplicate: false, order_id: orderId });
    } finally {
      lock.releaseLock();
    }
  } catch (err) {
    // Do not log request bodies, credentials, or customer data.
    return json_({ success: false, error: 'WRITE_FAILED' });
  }
}

function safeCell_(value) {
  // Force literal text to prevent spreadsheet formula execution.
  return /^[=+\-@]/.test(value) ? "'" + value : value;
}

function unquoteCell_(value) {
  return /^'[=+\-@]/.test(value) ? value.slice(1) : value;
}

function constantTimeEqual_(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function json_(value) {
  return ContentService.createTextOutput(JSON.stringify(value)).setMimeType(ContentService.MimeType.JSON);
}
