/**
 * US Supplements — Diwali Mystery Envelope API
 * Cloudflare Worker + D1
 *
 * ONE-TIME AUTHORIZATION FLOW (replaces the old emailed unlock code)
 *
 *   1. WordPress authentication page  ──POST /api/envelope/authorize──▶  Worker
 *        { orderId, phone }   Worker checks the live WooCommerce order and billing phone, then issues a random,
 *        short-lived HANDOFF TOKEN (only its SHA-256 hash is stored) → { handoffToken }
 *      The WP page redirects the customer to the envelope page with the token in the URL fragment.
 *
 *   2. Envelope page ───────POST /api/envelope/verify────────────────▶  Worker
 *        { handoffToken, clientNonce }   The token is consumed ONCE and bound to the browser that
 *        presented it (via clientNonce). Returns a signed, short-lived OPENING SESSION token that
 *        the page keeps in memory only. Nothing about the reward is returned here.
 *
 *   3. Envelope page ───────POST /api/envelope/open──────────────────▶  Worker
 *        { sessionToken }   ATOMIC redeem: marks the authorization used and claims one
 *        weighted physical gift from persistent D1 stock. Returns the saved result.
 *
 *   GET  /api/envelope/status → { success, state: 'open' | 'closed' | 'not_started' }
 *
 * Why this is safe
 *   - Handoff tokens are 256-bit random values; the database stores only their hash.
 *   - A handoff token can be exchanged exactly once. A copy of the link used in another browser
 *     fails with AUTH_ALREADY_USED (the first browser proved possession with its clientNonce).
 *   - Eligibility is re-read from WooCommerce at authorize time AND at verify time.
 *   - Rewards are drawn server-side with probability weighted by remaining stock. A database
 *     trigger claims one physical unit only when a new authorization-linked allocation is inserted.
 *     Better Luck is unlimited after the physical inventory is exhausted.
 *   - Retries are idempotent: if a response is lost, the same browser can repeat verify/open and
 *     gets the same outcome, never a second draw.
 *   - CORS is enforced here, per route, against exact origins (no wildcards, no credentials).
 *
 * Secrets (wrangler secret put …): SESSION_SECRET, WC_CONSUMER_KEY, WC_CONSUMER_SECRET, WORKER_SYNC_SECRET
 * Vars (wrangler.toml): WC_STORE_URL, AUTH_ORIGINS, ENVELOPE_ORIGINS
 */

const CONFIG = {
  CAMPAIGN_ID: 'diwali-2026',
  LAUNCH_AT: '2026-11-09T00:00:00+05:30',
  CLOSES_AT: '2026-11-10T00:00:00+05:30',
  ELIGIBLE_FROM: '2026-11-06',                       // IST dates, inclusive
  ELIGIBLE_TO: '2026-11-08',
  MIN_PRODUCT_VALUE_EXCLUSIVE_PAISE: 150000,         // strictly above ₹1,500
  ELIGIBLE_STATUSES: ['processing', 'completed', 'shipped', 'partially-shipped'], // WooCommerce status slugs
  HANDOFF_TTL_SECONDS: 10 * 60,                     // link from the WP page must be used within 10 minutes
  SESSION_TTL_SECONDS: 20 * 60,                     // opening session after a successful verify
  MAX_HANDOFFS_PER_ORDER_PER_HOUR: 10,              // brute-force / abuse cap per order
  ALLOW_VIEW_SAVED_REWARD: true,                    // true: an order/customer that already opened can re-view the SAME saved reward (never a new draw)
  REDIRECT_AFTER_SECONDS: 10
};

/**
 * Public reward presentation data. Stock is authoritative in reward_inventory.
 */
const GIFT_DISPATCH_MESSAGE = 'Your Diwali gift will be dispatched to you shortly.';
const REWARDS = {
  SUPER_YOU_PROTEIN: { type: 'physical', title: 'Super You Protein – 1 kg', highlight: 'YOU WON!', description: GIFT_DISPATCH_MESSAGE, valuePaise: 220000 },
  PSYCHO_PUMP: { type: 'physical', title: 'One Science Psycho Pump – 15 servings', highlight: 'YOU WON!', description: GIFT_DISPATCH_MESSAGE, valuePaise: 70000 },
  PROTEIN_SAMPLE_BOX: { type: 'physical', title: 'One Science Protein Sample Box', highlight: 'YOU WON!', description: GIFT_DISPATCH_MESSAGE, valuePaise: 70000 },
  REGULAR_SHAKER: { type: 'physical', title: 'Shaker', highlight: 'YOU WON!', description: GIFT_DISPATCH_MESSAGE, valuePaise: 7000 },
  TSHIRT: { type: 'physical', title: 'T-shirt', highlight: 'YOU WON!', description: GIFT_DISPATCH_MESSAGE, valuePaise: 10000 },
  STEEL_SHAKER: { type: 'physical', title: 'Steel Shaker', highlight: 'YOU WON!', description: GIFT_DISPATCH_MESSAGE, valuePaise: 35000 },
  MUSCLE_SCIENCE_PREWORKOUT: { type: 'physical', title: 'Muscle Science Pre-workout – 2-serving pack', highlight: 'YOU WON!', description: GIFT_DISPATCH_MESSAGE, valuePaise: 5000 },
  BIG_FLEX_BCAA: { type: 'physical', title: 'Big Flex BCAA', highlight: 'YOU WON!', description: GIFT_DISPATCH_MESSAGE },
  PINTOLA_OATS: { type: 'physical', title: 'Pintola Oats – 1 serving', highlight: 'YOU WON!', description: GIFT_DISPATCH_MESSAGE },
  KEYCHAIN: { type: 'physical', title: 'Keychain', highlight: 'YOU WON!', description: GIFT_DISPATCH_MESSAGE },
  BETTER_LUCK: { type: 'luck', title: 'BETTER LUCK NEXT TIME!', description: 'Thank you for celebrating Diwali with US Supplements. Stay tuned for more exciting surprises.' }
};

/* ------------------------------------------------------------------ */
/* Routes (each route has its own exact-origin allow-list)             */
/* ------------------------------------------------------------------ */
const ROUTES = {
  '/api/envelope/status':    { methods: ['GET'],  origins: 'ENVELOPE_ORIGINS', handler: handleStatus },
  '/api/envelope/authorize': { methods: ['POST'], origins: 'AUTH_ORIGINS',     handler: handleAuthorize, limiter: 'AUTH_LIMITER' },
  '/api/envelope/verify':    { methods: ['POST'], origins: 'ENVELOPE_ORIGINS', handler: handleVerify,    limiter: 'VERIFY_LIMITER' },
  '/api/envelope/open':      { methods: ['POST'], origins: 'ENVELOPE_ORIGINS', handler: handleOpen, limiter: 'OPEN_LIMITER' }
};

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    // Opening the bare Worker URL in a browser shows a health message, not an error.
    if (url.pathname === '/' && request.method === 'GET') {
      return reply(success({ message: 'US Supplements Diwali envelope service is running.', state: campaignState() }), {});
    }
    const route =Object.prototype.hasOwnProperty.call(ROUTES, url.pathname) ? ROUTES[url.pathname] : null;
    if (!route) return reply(failure('NOT_FOUND', 404), {});

    const origin = request.headers.get('Origin');
    const allowed = parseOrigins(env[route.origins]);
    const originOk = !origin || allowed.includes(origin);
    const cors = origin && originOk ? corsHeaders(origin, route.methods) : {};

    // Browser requests from any origin that is not on this route's list are refused here,
    // not just hidden from JavaScript by the browser.
    if (!originOk) return reply(failure('ORIGIN_NOT_ALLOWED', 403), {});

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: { ...baseHeaders(), ...cors } });
    if (!route.methods.includes(request.method)) return reply(failure('METHOD_NOT_ALLOWED', 405), cors);

    try {
      if (request.method === 'POST') {
        const type = String(request.headers.get('Content-Type') || '').toLowerCase();
        if (!type.startsWith('application/json')) return reply(failure('INVALID_REQUEST', 415), cors);
      }
      if (route.limiter) {
        const limited = await rateLimit(request, env, route.limiter);
        if (limited) return reply(limited, cors);
      }
      return reply(await route.handler(request, env, ctx), cors);
    } catch (err) {
      console.error('envelope-api error', err && err.stack ? err.stack : err);
      return reply(failure('SERVER_ERROR', 500), cors);
    }
  },

  // Optional (add a cron trigger in wrangler.toml): drops stale, never-redeemed authorizations.
  async scheduled(_event, env) {
    const cutoff = nowSec() - 7 * 24 * 3600;
    // Keep the customer metadata cleanup and auth deletion atomic. Allocations are
    // explicitly excluded even if a historical/inconsistent row has redeemed_at NULL.
    const expiredUnusedAuthIds = `SELECT a.id FROM envelope_auth a
      WHERE a.redeemed_at IS NULL AND a.created_at < ?1
        AND NOT EXISTS (SELECT 1 FROM reward_allocation r WHERE r.auth_id = a.id)`;
    await env.DB.batch([
      env.DB.prepare(`DELETE FROM envelope_customer WHERE auth_id IN (${expiredUnusedAuthIds})`).bind(cutoff),
      env.DB.prepare(`DELETE FROM envelope_customer_issue WHERE auth_id IN (${expiredUnusedAuthIds})`).bind(cutoff),
      env.DB.prepare(`DELETE FROM envelope_auth WHERE id IN (${expiredUnusedAuthIds})`).bind(cutoff)
    ]);
    const due = await env.DB.prepare("SELECT * FROM sheet_sync WHERE sync_state = 'pending' AND next_attempt_at <= ?1 ORDER BY next_attempt_at LIMIT 50").bind(nowSec()).all();
    for (const row of due.results || []) await trySyncRecord(env, row);
  }
};

/* ------------------------------------------------------------------ */
/* Handlers                                                            */
/* ------------------------------------------------------------------ */
async function handleStatus(_request, env) {
  const state = campaignState();
  return success({ state });
}

/**
 * Called by the WordPress authentication page. Proves the customer knows an eligible order,
 * then issues a one-time handoff token for the envelope page.
 */
async function handleAuthorize(request, env) {
  const body = await readJson(request);
  const orderId = normalizeOrderId(body && body.orderId);
  if (!orderId) return failure('INVALID_REQUEST');
  const suppliedPhone = normalizePhone(body && body.phone);
  if (!suppliedPhone) return failure('INVALID_REQUEST');
  if (!hasWooCommerceConfig(env) || !env.SESSION_SECRET) return failure('CONFIG_ERROR', 503);

  const campaign = campaignState();
  if (campaign === 'not_started') return failure('CAMPAIGN_NOT_STARTED', 403);
  if (campaign === 'closed') return failure('CAMPAIGN_CLOSED', 409);

  const t = nowSec();
  const recent = await env.DB.prepare('SELECT COUNT(*) AS n FROM envelope_auth WHERE order_id = ?1 AND created_at > ?2')
    .bind(orderId, t - 3600).first();
  if (recent && Number(recent.n) >= CONFIG.MAX_HANDOFFS_PER_ORDER_PER_HOUR) return failure('RATE_LIMITED', 429);

  const order = await fetchOrder(orderId, env);
  // Same answer for "no such order" and a phone mismatch so order IDs can't be probed.
  if (!order) return failure('INVALID_ORDER', 404);
  const verifiedPhone = billingPhone(order);
  const verifiedPhoneNormalized = normalizePhone(verifiedPhone);
  if (!verifiedPhoneNormalized || !timingSafeEqual(suppliedPhone, verifiedPhoneNormalized)) return failure('INVALID_ORDER', 404);
  if (!isEligible(order)) return failure('INELIGIBLE_ORDER', 403);
  if (campaignState() !== 'open') return failure(campaignState() === 'not_started' ? 'CAMPAIGN_NOT_STARTED' : 'CAMPAIGN_CLOSED', 409);

  const ident = await identityOf(order);
  if (!ident) return failure('INELIGIBLE_ORDER', 403);

  // An allocation belongs to one WooCommerce order. Customer/email fields remain
  // trusted audit metadata only; another eligible order may participate.
  const existing = await findClaimFor(env, ident.o);
  if (await findLegacyClaimFor(env, ident.o)) return failure('AUTH_ALREADY_USED', 409);
  if (existing && !CONFIG.ALLOW_VIEW_SAVED_REWARD) return failure('AUTH_ALREADY_USED', 409);

  const handoffToken = randomToken();
  const orderName = billingName(order);
  const orderPhone = billingPhone(order);
  const dataIssue = [!orderName && 'MISSING_BILLING_NAME', !orderPhone && 'MISSING_BILLING_PHONE'].filter(Boolean).join(',');
  await env.DB.batch([
    // Only the newest unused handoff for an order stays valid.
    env.DB.prepare('UPDATE envelope_auth SET superseded_at = ?1 WHERE order_id = ?2 AND verified_at IS NULL AND superseded_at IS NULL')
      .bind(t, ident.o),
    env.DB.prepare('INSERT INTO envelope_auth (token_hash, order_id, customer_key, customer_email, created_at, expires_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)')
      .bind(await sha256hex(handoffToken), ident.o, ident.c, ident.e, t, t + CONFIG.HANDOFF_TTL_SECONDS),
    env.DB.prepare('INSERT INTO envelope_customer (auth_id, customer_name, phone_number) SELECT id, ?1, ?2 FROM envelope_auth WHERE token_hash = ?3')
      .bind(orderName, orderPhone, await sha256hex(handoffToken)),
    env.DB.prepare('INSERT INTO envelope_customer_issue (auth_id, data_issue) SELECT id, ?1 FROM envelope_auth WHERE token_hash = ?2')
      .bind(dataIssue, await sha256hex(handoffToken))
  ]);

  return success({ handoffToken, expiresInSeconds: CONFIG.HANDOFF_TTL_SECONDS, alreadyOpened: !!existing });
}

/**
 * Called by the envelope page with the handoff token. Consumes it once and returns an opening
 * session. The client nonce binds the token to the browser that presented it first.
 */
async function handleVerify(request, env) {
  if (!env.SESSION_SECRET) return failure('CONFIG_ERROR', 503);
  const body = await readJson(request);
  const token = body && body.handoffToken;
  const nonce = body && body.clientNonce;
  if (!TOKEN_RE.test(String(token || '')) || !NONCE_RE.test(String(nonce || ''))) return failure('INVALID_AUTH', 401);

  const campaign = campaignState();
  if (campaign === 'not_started') return failure('CAMPAIGN_NOT_STARTED', 403);

  const tokenHash = await sha256hex(token);
  const bind = await sha256hex(`bind:${nonce}`);
  const t = nowSec();

  const row = await getAuthByHash(env, tokenHash);
  if (!row || row.superseded_at) return failure('INVALID_AUTH', 401);
  if (await findLegacyAllocationForAuth(env, row)) return failure('AUTH_ALREADY_USED', 409);

  if (row.verified_at) {
    // Same browser retrying (e.g. the first response was lost): hand back a session again.
    if (timingSafeEqual(String(row.bind_hash || ''), bind)) {
      if (row.redeemed_at) return failure('AUTH_ALREADY_USED', 409);
      if (row.session_expires_at <= t) return failure('EXPIRED_AUTH', 410);
      return sessionResponse(env, row, bind, !!(await findClaimFor(env, row.order_id)));
    }
    return failure('AUTH_ALREADY_USED', 409);       // someone else already exchanged this token
  }
  if (campaign === 'closed') return failure('CAMPAIGN_CLOSED', 409);
  if (row.expires_at <= t) return failure('EXPIRED_AUTH', 410);

  // Eligibility is re-read from the live order (cancellations / refunds since authorize).
  const order = await fetchOrder(row.order_id, env);
  if (!order) return failure('INVALID_AUTH', 401);
  if (!isEligible(order)) return failure('INELIGIBLE_ORDER', 403);
  if (campaignState() !== 'open') return failure(campaignState() === 'not_started' ? 'CAMPAIGN_NOT_STARTED' : 'CAMPAIGN_CLOSED', 409);
  const verifiedName = billingName(order);
  const verifiedPhone = billingPhone(order);
  const dataIssue = [!verifiedName && 'MISSING_BILLING_NAME', !verifiedPhone && 'MISSING_BILLING_PHONE'].filter(Boolean).join(',');
  await env.DB.batch([
    env.DB.prepare('UPDATE envelope_customer SET customer_name = ?1, phone_number = ?2 WHERE auth_id = ?3').bind(verifiedName, verifiedPhone, row.id),
    env.DB.prepare('INSERT INTO envelope_customer_issue (auth_id, data_issue) VALUES (?1, ?2) ON CONFLICT(auth_id) DO UPDATE SET data_issue = excluded.data_issue').bind(row.id, dataIssue)
  ]);

  // Atomic single-use consume of the handoff token.
  const consumed = await env.DB.prepare(
    `UPDATE envelope_auth
        SET verified_at = ?1, bind_hash = ?2, session_expires_at = ?3
      WHERE id = ?4 AND verified_at IS NULL AND redeemed_at IS NULL AND superseded_at IS NULL AND expires_at > ?1
      RETURNING id`
  ).bind(t, bind, t + CONFIG.SESSION_TTL_SECONDS, row.id).first();

  if (!consumed) {
    // Lost a race with another request: decide what the caller should be told.
    const now = await getAuthByHash(env, tokenHash);
    if (now && now.verified_at && timingSafeEqual(String(now.bind_hash || ''), bind) && !now.redeemed_at) {
      return sessionResponse(env, now, bind, !!(await findClaimFor(env, now.order_id)));
    }
    return failure(now && now.expires_at <= t && !now.verified_at ? 'EXPIRED_AUTH' : 'AUTH_ALREADY_USED', now && now.expires_at <= t && !now.verified_at ? 410 : 409);
  }

  const fresh = await getAuthByHash(env, tokenHash);
  return sessionResponse(env, fresh, bind, !!(await findClaimFor(env, fresh.order_id)));
}

/**
 * Redeem: one atomic step that marks the authorization used AND claims a reward.
 */
async function handleOpen(request, env, ctx) {
  if (!env.SESSION_SECRET) return failure('CONFIG_ERROR', 503);
  const body = await readJson(request);
  const session = await verifyToken(body && body.sessionToken, env.SESSION_SECRET);
  if (!session || !session.a || !session.b) return failure('SESSION_EXPIRED', 401);
  const campaign = campaignState();
  if (campaign === 'not_started') return failure('CAMPAIGN_NOT_STARTED', 403);

  const row = await getAuthById(env, session.a);
  if (!row || row.superseded_at || !row.verified_at || !timingSafeEqual(String(row.bind_hash || ''), String(session.b))) {
    return failure('INVALID_SESSION', 401);
  }

  // Already redeemed by THIS session (retry after a lost response): return the same result.
  if (row.redeemed_at) return replayRedeemed(env, row, ctx);

  const t = nowSec();
  if (row.session_expires_at <= t) return failure('SESSION_EXPIRED', 401);

  const orderId = String(row.order_id);
  const existing = await findClaimFor(env, orderId);
  if (existing) return finishViewOnly(env, row, existing, ctx);
  if (await findLegacyClaimFor(env, orderId)) return failure('AUTH_ALREADY_USED', 409);
  if (campaign === 'closed') return failure('CAMPAIGN_CLOSED', 409);

  let results;
  try {
    // D1 batch is atomic. The allocation trigger conditionally decrements stock on a new
    // insert and aborts the transaction if no unit remains. Duplicate retries are ignored.
    const closesAt = Math.floor(Date.parse(CONFIG.CLOSES_AT) / 1000);
    results = await env.DB.batch([
      env.DB.prepare(
        `WITH available AS MATERIALIZED (
           SELECT reward_id, remaining_quantity FROM reward_inventory WHERE is_fallback = 0 AND remaining_quantity > 0
         ), totals AS MATERIALIZED (
           SELECT COALESCE(SUM(remaining_quantity), 0) AS total FROM available
         ), draw AS MATERIALIZED (
           SELECT total, CASE WHEN total > 0 THEN abs(random()) % total ELSE 0 END AS n FROM totals
         ), cumulative AS MATERIALIZED (
           SELECT reward_id, SUM(remaining_quantity) OVER (ORDER BY reward_id) AS through FROM available
         ), chosen AS (
           SELECT CASE WHEN draw.total = 0 THEN 'BETTER_LUCK'
                       ELSE (SELECT reward_id FROM cumulative WHERE through > draw.n ORDER BY through LIMIT 1)
                  END AS reward_id FROM draw
         )
         INSERT OR IGNORE INTO reward_allocation (auth_id, order_id, customer_key, customer_email, reward_id)
         SELECT ?1, ?2, ?3, ?4, chosen.reward_id FROM chosen
          WHERE EXISTS (SELECT 1 FROM envelope_auth WHERE id = ?1 AND bind_hash = ?5
                         AND verified_at IS NOT NULL AND redeemed_at IS NULL AND superseded_at IS NULL
                         AND session_expires_at > ?6)
            AND unixepoch() < ?7
            AND NOT EXISTS (SELECT 1 FROM reward_allocation WHERE order_id = ?2)
            AND NOT EXISTS (SELECT 1 FROM reward_deck WHERE order_id = ?2)
         RETURNING id, reward_id`
      ).bind(row.id, orderId, row.customer_key, row.customer_email || null, row.bind_hash, t, closesAt),
      env.DB.prepare(
        `UPDATE envelope_auth
            SET redeemed_at = ?1, reward_slot = NULL,
                was_existing = CASE WHEN EXISTS (SELECT 1 FROM reward_allocation WHERE auth_id = ?2) THEN 0 ELSE 1 END
          WHERE id = ?2 AND bind_hash = ?3 AND redeemed_at IS NULL
            AND EXISTS (SELECT 1 FROM reward_allocation WHERE auth_id = ?2 OR order_id = ?4)
        RETURNING id`
      ).bind(t, row.id, row.bind_hash, orderId),
      env.DB.prepare(
        `INSERT OR IGNORE INTO sheet_sync (order_id, name, phone_number, reward_type, envelope_result, sync_state, next_attempt_at)
         SELECT a.order_id, c.customer_name, c.phone_number, d.reward_id, i.reward_name,
           'pending', ?1
         FROM envelope_auth a JOIN envelope_customer c ON c.auth_id = a.id
           JOIN reward_allocation d ON d.order_id = a.order_id
           JOIN reward_inventory i ON i.reward_id = d.reward_id
         WHERE a.id = ?2 AND a.redeemed_at IS NOT NULL`
      ).bind(t, row.id)
    ]);
  } catch (err) {
    // A concurrent handoff for this same order may have committed first.
    if (/LEGACY_REWARD_ALREADY_ALLOCATED|REWARD_ALREADY_ALLOCATED/i.test(String(err && err.message))) {
      return failure('AUTH_ALREADY_USED', 409);
    }
    if (/UNIQUE/i.test(String(err && err.message))) {
      const winner = await findClaimFor(env, orderId);
      if (winner) return finishViewOnly(env, row, winner, ctx);
    }
    throw err;
  }

  const allocation = firstRow(results[0]);
  const marked = firstRow(results[1]);
  if ((allocation || marked) && marked) {
    const sync = await env.DB.prepare('SELECT * FROM sheet_sync WHERE order_id = ?1').bind(row.order_id).first();
    await syncAfterResponse(env, ctx, sync);
    const saved = await findClaimFor(env, orderId);
    if (saved) return rewardResponse(env, saved.reward_id, !allocation);
  }

  // Nothing was claimed. Work out why from the current state.
  const current = await getAuthById(env, row.id);
  if (current && current.redeemed_at) return replayRedeemed(env, current, ctx);
  if (campaignState() === 'closed') return failure('CAMPAIGN_CLOSED', 409);
  return failure('SESSION_EXPIRED', 401);
}

/* ------------------------------------------------------------------ */
/* Data helpers                                                        */
/* ------------------------------------------------------------------ */
function getAuthByHash(env, tokenHash) {
  return env.DB.prepare('SELECT * FROM envelope_auth WHERE token_hash = ?1').bind(tokenHash).first();
}
function getAuthById(env, id) {
  return env.DB.prepare('SELECT * FROM envelope_auth WHERE id = ?1').bind(id).first();
}

function findClaimFor(env, orderId) {
  return env.DB.prepare(
    'SELECT id, auth_id, order_id, customer_key, reward_id FROM reward_allocation WHERE order_id = ?1'
  ).bind(String(orderId)).first();
}
function findAllocationForAuth(env, authId) {
  return env.DB.prepare('SELECT id, auth_id, order_id, customer_key, reward_id FROM reward_allocation WHERE auth_id = ?1').bind(authId).first();
}
function findLegacyClaimFor(env, orderId) {
  return env.DB.prepare(
    'SELECT slot, reward_id, order_id FROM reward_deck WHERE order_id = ?1'
  ).bind(String(orderId)).first();
}
function findLegacyAllocationForAuth(env, row) {
  if (row.reward_slot !== null && row.reward_slot !== undefined) {
    // A non-null legacy slot is itself a durable legacy marker. Fail closed even if
    // its referenced deck row is damaged or missing; never make a replacement draw.
    return env.DB.prepare('SELECT slot, reward_id, order_id FROM reward_deck WHERE slot = ?1').bind(row.reward_slot).first()
      .then((legacy) => legacy || { slot: row.reward_slot, reward_id: null, order_id: row.order_id });
  }
  return findLegacyClaimFor(env, row.order_id);
}
function hasWooCommerceConfig(env) {
  return !!(env.WC_STORE_URL && env.WC_CONSUMER_KEY && env.WC_CONSUMER_SECRET);
}

async function identityOf(order) {
  const customerKey = order.customer_id > 0 ? `cust:${order.customer_id}` : null;
  const email = normalizeEmail(order.billing && order.billing.email);
  if (customerKey) return { o: String(order.id), c: customerKey, e: email };
  if (email) return { o: String(order.id), c: `email:${email}`, e: email };
  const phone = normalizePhone(billingPhone(order));
  if (!phone) return null;
  // Guest identity fallback is derived from the verified WooCommerce phone, never request input.
  return { o: String(order.id), c: `phone:${await sha256hex(phone)}`, e: null };
}

function firstRow(result) { return result && result.results && result.results[0] ? result.results[0] : null; }

async function sessionResponse(env, row, bind, alreadyOpened) {
  const sessionToken = await signToken({ a: row.id, b: bind }, env.SESSION_SECRET, row.session_expires_at);
  return success({ sessionToken, expiresInSeconds: Math.max(0, row.session_expires_at - nowSec()), alreadyOpened });
}

// The reward for this authorization was already drawn by this same session: return it again.
async function replayRedeemed(env, row, ctx) {
  // A legacy coupon-era redemption has no physical allocation row and must never fall
  // through to SERVER_ERROR or be replaced with a new physical draw.
  if (await findLegacyAllocationForAuth(env, row)) return failure('AUTH_ALREADY_USED', 409);
  const claim = await findAllocationForAuth(env, row.id) || await findClaimFor(env, row.order_id);
  if (!claim) return failure('SERVER_ERROR', 500);
  await syncAfterResponse(env, ctx, await ensureSyncRecord(env, row, claim.reward_id));
  return rewardResponse(env, claim.reward_id, row.was_existing === 1);
}

// This same Order ID already has a saved reward (another handoff / earlier session):
// show it, never make a new draw.
async function finishViewOnly(env, row, existing, ctx) {
  await env.DB.prepare('UPDATE envelope_auth SET redeemed_at = ?1, reward_slot = NULL, was_existing = 1 WHERE id = ?2 AND bind_hash = ?3 AND redeemed_at IS NULL')
    .bind(nowSec(), row.id, row.bind_hash).run();
  await syncAfterResponse(env, ctx, await ensureSyncRecord(env, row, existing.reward_id));
  return rewardResponse(env, existing.reward_id, true);
}

async function ensureSyncRecord(env, row, rewardId) {
  await env.DB.prepare(
    `INSERT OR IGNORE INTO sheet_sync (order_id, name, phone_number, reward_type, envelope_result, sync_state, next_attempt_at)
     SELECT a.order_id, c.customer_name, c.phone_number, i.reward_id, i.reward_name, 'pending', ?1
       FROM envelope_auth a JOIN envelope_customer c ON c.auth_id = a.id
       JOIN reward_inventory i ON i.reward_id = ?2 WHERE a.id = ?3`
  ).bind(nowSec(), rewardId, row.id).run();
  return env.DB.prepare('SELECT * FROM sheet_sync WHERE order_id = ?1').bind(row.order_id).first();
}

async function rewardResponse(env, rewardId, alreadyOpened) {
  const r = REWARDS[rewardId];
  if (!r) throw new Error(`Unknown reward_id in allocation: ${rewardId}`);
  const stock = await env.DB.prepare('SELECT reward_name, unit_value_paise FROM reward_inventory WHERE reward_id = ?1').bind(rewardId).first();
  const reward = {
    type: r.type,
    title: rewardId === 'BETTER_LUCK' ? r.title : (stock && stock.reward_name ? stock.reward_name : r.title),
    highlight: r.highlight || null,
    description: r.description || null,
    value: stock && stock.unit_value_paise != null ? Number(stock.unit_value_paise) / 100 : null,
    claimInstructions: null
  };
  return success({ alreadyOpened, reward, redirectAfterSeconds: CONFIG.REDIRECT_AFTER_SECONDS });
}

// The customer's reward response never waits on Apps Script. With an execution context the
// sync runs after the response; without one (tests, direct calls) it is awaited. Anything
// left pending is retried by the scheduled handler.
function syncAfterResponse(env, ctx, record) {
  if (!record || record.sync_state === 'synced') return undefined;
  const work = trySyncRecord(env, record).catch((err) => { console.error('sheets-sync error', err && err.message ? err.message : err); });
  if (ctx && typeof ctx.waitUntil === 'function') { ctx.waitUntil(work); return undefined; }
  return work;
}

async function trySyncRecord(env, record) {
  if (record.sync_state === 'synced') return true;
  const missingConfig = [];
  if (!env.GOOGLE_SHEETS_WEB_APP_URL) missingConfig.push('GOOGLE_SHEETS_WEB_APP_URL');
  if (!env.WORKER_SYNC_SECRET) missingConfig.push('WORKER_SYNC_SECRET');
  if (missingConfig.length) {
    const attempts = Number(record.attempts || 0) + 1;
    const delay = Math.min(6 * 3600, 30 * (2 ** Math.min(attempts - 1, 10)));
    await env.DB.prepare("UPDATE sheet_sync SET attempts = attempts + 1, next_attempt_at = ?1, last_error = ?2 WHERE order_id = ?3 AND sync_state = 'pending'")
      .bind(nowSec() + delay, `CONFIG_MISSING_${missingConfig.join('_AND_')}`, record.order_id).run();
    return false;
  }
  const payload = { secret: env.WORKER_SYNC_SECRET, order_id: record.order_id, name: record.name || '', phone: record.phone_number || '', reward_type: record.reward_type, envelope_result: record.envelope_result };
  let response;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  try {
    response = await fetch(env.GOOGLE_SHEETS_WEB_APP_URL, {
      method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload), signal: controller.signal
    });
    // Apps Script ContentService redirects to a one-time googleusercontent URL. Fetch that URL
    // as GET; only its JSON acknowledgement can mark a row synced.
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('Location');
      if (!location) throw new Error('SHEETS_REDIRECT_MISSING_LOCATION');
      response = await fetch(location, { method: 'GET', redirect: 'follow', signal: controller.signal });
    }
    // Each failure gets a specific, non-sensitive last_error code so operators can tell a
    // secret mismatch or sheet problem apart from an access/deployment problem.
    let body;
    try { body = await response.json(); } catch (_) { throw new Error(`SHEETS_HTTP_${response.status}_NON_JSON`); }
    if (!response.ok) throw new Error(`SHEETS_HTTP_${response.status}`);
    if (!body || body.success !== true) {
      throw new Error(body && typeof body.error === 'string' && /^[A-Z_]{1,40}$/.test(body.error) ? `SHEETS_REJECTED_${body.error}` : 'SHEETS_ACK_INVALID');
    }
    if (body.order_id && String(body.order_id) !== String(record.order_id)) throw new Error('SHEETS_ACK_ORDER_MISMATCH');
    await env.DB.prepare("UPDATE sheet_sync SET sync_state = 'synced', synced_at = ?1, attempts = attempts + 1, last_error = NULL WHERE order_id = ?2 AND sync_state = 'pending'")
      .bind(nowSec(), record.order_id).run();
    return true;
  } catch (err) {
    const attempts = Number(record.attempts || 0) + 1;
    const delay = Math.min(6 * 3600, 30 * (2 ** Math.min(attempts - 1, 10)));
    const code = err && err.name === 'AbortError' ? 'SHEETS_TIMEOUT'
      : (err && /^SHEETS_[A-Z0-9_]{1,60}$/.test(String(err.message)) ? err.message : 'SYNC_FAILED');
    await env.DB.prepare("UPDATE sheet_sync SET attempts = attempts + 1, next_attempt_at = ?1, last_error = ?2 WHERE order_id = ?3 AND sync_state = 'pending'")
      .bind(nowSec() + delay, code, record.order_id).run();
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchOrder(orderId, env) {
  const auth = btoa(`${env.WC_CONSUMER_KEY}:${env.WC_CONSUMER_SECRET}`);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  try {
    const res = await fetch(`${env.WC_STORE_URL.replace(/\/$/, '')}/wp-json/wc/v3/orders/${orderId}`, {
      headers: { Authorization: `Basic ${auth}`, Accept: 'application/json', 'User-Agent': 'usd-envelope-worker' },
      signal: ctrl.signal
    });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`WooCommerce responded ${res.status}`);
    const order = await res.json();
    if (!order || !Array.isArray(order.refunds)) return null;
    order.refund_details = [];
    if (order.refunds.length) {
      const refundRes = await fetch(`${env.WC_STORE_URL.replace(/\/$/, '')}/wp-json/wc/v3/orders/${orderId}/refunds`, {
        headers: { Authorization: `Basic ${auth}`, Accept: 'application/json', 'User-Agent': 'usd-envelope-worker' }, signal: ctrl.signal
      });
      if (!refundRes.ok) throw new Error(`WooCommerce refunds responded ${refundRes.status}`);
      const details = await refundRes.json();
      if (!Array.isArray(details)) return null;
      const expected = order.refunds.map(r => String(r.id)).sort();
      const actual = details.map(r => String(r && r.id)).sort();
      if (expected.length !== actual.length || expected.some((id, i) => id !== actual[i])) return null;
      order.refund_details = details;
    }
    return order;
  } finally {
    clearTimeout(timer);
  }
}

// WooCommerce line_items[].total is the discounted product amount excluding tax.
// Refund detail line_items[].total is the product refund excluding tax. Shipping
// lines and refund summary totals are intentionally excluded from this calculation.
function productValuePaise(order) {
  if (!order || !Array.isArray(order.line_items) || !order.line_items.length || !Array.isArray(order.refunds) || !Array.isArray(order.refund_details)) return null;
  let product = 0;
  const ids = new Set();
  for (const item of order.line_items) {
    if (!item || item.id == null || ids.has(String(item.id))) return null;
    const amount = decimalPaise(item.total);
    if (amount == null || amount < 0) return null;
    ids.add(String(item.id)); product += amount;
  }
  let refunded = 0;
  const details = new Map(order.refund_details.map(r => [String(r && r.id), r]));
  if (details.size !== order.refunds.length) return null;
  for (const summary of order.refunds) {
    const detail = details.get(String(summary && summary.id));
    if (!detail || !Array.isArray(detail.line_items)) return null;
    for (const item of detail.line_items) {
      if (!item || !ids.has(String(item.id))) return null;
      const amount = decimalPaise(item.total);
      if (amount == null) return null;
      refunded += Math.abs(amount);
    }
    const refundSummary = decimalPaise(summary && summary.total);
    if (refundSummary == null) return null;
    if (Math.abs(refundSummary) > 0 && detail.line_items.length === 0 &&
        (!Array.isArray(detail.shipping_lines) || detail.shipping_lines.length === 0)) return null;
  }
  return Math.max(0, product - refunded);
}

function decimalPaise(value) {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const m = /^(-?)(\d+)(?:\.(\d{1,2}))?$/.exec(String(value).trim());
  if (!m) return null;
  const paise = Number(m[2]) * 100 + Number((m[3] || '').padEnd(2, '0'));
  if (!Number.isSafeInteger(paise)) return null;
  return m[1] ? -paise : paise;
}

// 'wc-Partially Shipped' / 'partially_shipped' -> 'partially-shipped'
function statusSlug(status) {
  return String(status || '').trim().toLowerCase().replace(/^wc-/, '').replace(/[\s_]+/g, '-');
}

function isEligible(order) {
  if (!CONFIG.ELIGIBLE_STATUSES.includes(statusSlug(order.status))) return false;
  if (order.currency !== 'INR') return false;
  if (!order.date_created_gmt) return false;
  let day;
  try { day = istDate(order.date_created_gmt); } catch (_) { return false; }
  if (!day) return false;
  if (day < CONFIG.ELIGIBLE_FROM || day > CONFIG.ELIGIBLE_TO) return false;
  const value = productValuePaise(order);
  return value != null && value > CONFIG.MIN_PRODUCT_VALUE_EXCLUSIVE_PAISE;
}

function billingName(order) { return [order.billing && order.billing.first_name, order.billing && order.billing.last_name].filter(v => typeof v === 'string' && v.trim()).map(v => v.trim()).join(' '); }
function billingPhone(order) { return String(order.billing && order.billing.phone || '').trim(); }

function istDate(gmtString) {
  const ms = Date.parse(/Z$|[+-]\d\d:?\d\d$/.test(gmtString) ? gmtString : `${gmtString}Z`);
  if (!Number.isFinite(ms)) return null;
  return new Date(ms + 330 * 60 * 1000).toISOString().slice(0, 10);
}

function campaignState(at = Date.now()) {
  if (at < Date.parse(CONFIG.LAUNCH_AT)) return 'not_started';
  if (at >= Date.parse(CONFIG.CLOSES_AT)) return 'closed';
  return 'open';
}

/* ------------------------------------------------------------------ */
/* Tokens & crypto                                                     */
/* ------------------------------------------------------------------ */
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;          // 32 random bytes, base64url
const NONCE_RE = /^[A-Za-z0-9_-]{16,64}$/;       // client-generated binding nonce

const nowSec = () => Math.floor(Date.now() / 1000);

function normalizeOrderId(value) {
  const id = String(value == null ? '' : value).trim().replace(/^#/, '');
  return /^\d{1,12}$/.test(id) ? id : null;
}

function normalizeEmail(email) {
  const e = String(email || '').trim().toLowerCase();
  return e.includes('@') && e.length <= 254 ? e : null;
}

function normalizePhone(value) {
  // India-only canonical policy: accept a 10-digit national number, a leading trunk 0,
  // +91/91, or 0091; compare exactly as the same 91 + 10-digit representation.
  // Only common visual separators are ignored. Extensions, letters, multiple numbers,
  // partial numbers, and non-Indian country codes fail closed.
  if (typeof value !== 'string' || value.length > 40) return null;
  const raw = value.trim();
  if (!raw || !/^\+?[0-9\s().-]+$/.test(raw)) return null;
  let digits = raw.replace(/[\s().-]/g, '');
  if (digits.startsWith('+')) digits = digits.slice(1);
  if (digits.startsWith('00')) digits = digits.slice(2);
  if (digits.startsWith('91') && (digits.length === 12 || digits.length === 13)) digits = digits.slice(2);
  if (digits.startsWith('0') && digits.length === 11) digits = digits.slice(1);
  if (!/^\d{10}$/.test(digits)) return null;
  return `91${digits}`;
}

function randomToken() {
  return bytesToB64url(crypto.getRandomValues(new Uint8Array(32)));
}

async function sha256hex(text) {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
  return Array.from(digest, (b) => b.toString(16).padStart(2, '0')).join('');
}

async function hmac(secret, message) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message)));
}

function timingSafeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function bytesToB64url(bytes) {
  let bin = '';
  bytes.forEach((b) => { bin += String.fromCharCode(b); });
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64urlToString(s) {
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/'));
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
}

// exp is an absolute epoch-seconds expiry.
async function signToken(payload, secret, exp) {
  const body = bytesToB64url(new TextEncoder().encode(JSON.stringify({ ...payload, exp })));
  return `${body}.${bytesToB64url(await hmac(secret, body))}`;
}

async function verifyToken(token, secret) {
  if (typeof token !== 'string' || token.length > 2000 || !secret) return null;
  const [body, sig] = token.split('.');
  if (!body || !sig) return null;
  if (!timingSafeEqual(bytesToB64url(await hmac(secret, body)), sig)) return null;
  try {
    const p = JSON.parse(b64urlToString(body));
    if (!p.exp || p.exp < Date.now() / 1000) return null;
    return p;
  } catch (_) {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* HTTP helpers                                                        */
/* ------------------------------------------------------------------ */
async function readJson(request) {
  try {
    const text = await request.text();
    if (text.length > 4096) return null;
    return JSON.parse(text);
  } catch (_) { return null; }
}

function success(data) { return { status: 200, body: { success: true, ...data } }; }
function failure(code, status = 400) { return { status, body: { success: false, error: { code } } }; }

function baseHeaders() {
  return {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Strict-Transport-Security': 'max-age=31536000; includeSubDomains'
  };
}

function reply({ status, body }, cors) {
  return new Response(JSON.stringify(body), { status, headers: { ...baseHeaders(), ...cors } });
}

// Exact origins only. A "*" entry is ignored on purpose.
function parseOrigins(value) {
  return String(value || '').split(',').map((s) => s.trim().replace(/\/$/, '')).filter((s) => s && s !== '*');
}

function corsHeaders(origin, methods) {
  return {
    Vary: 'Origin',
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': `${methods.join(', ')}, OPTIONS`,
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '600'
  };
}

/** Optional: uses a Workers rate-limit binding (AUTH_LIMITER / VERIFY_LIMITER) if you add one. */
async function rateLimit(request, env, bindingName) {
  const binding = env[bindingName];
  if (!binding) return null;
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  const { success: ok } = await binding.limit({ key: ip });
  return ok ? null : failure('RATE_LIMITED', 429);
}
