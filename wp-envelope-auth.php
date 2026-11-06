<?php
/**
 * US Supplements — Diwali Mystery Envelope: WordPress AUTHENTICATION PAGE.
 *
 * Replaces the old email-code snippet (wp-unlock-code.php, now retired). Customers no longer type a code
 * from an email. They enter their Order ID (+ registered mobile number) here, the Cloudflare Worker checks the real
 * WooCommerce order, and the customer is sent to the separately hosted envelope page with a one-time,
 * short-lived handoff token.
 *
 * INSTALL
 *   1. Add this file with the "Code Snippets" plugin (Run everywhere) or in a child theme's functions.php.
 *   2. Optional: the production URLs below are built in. To override them, add to wp-config.php
 *      (above "That's all, stop editing!"):
 *        define( 'USD_DIWALI_API_BASE',     'https://uss-diwali-auth-2026.822005harsh.workers.dev' );
 *        define( 'USD_DIWALI_ENVELOPE_URL', 'https://us-supplements-diwali.pages.dev/' );
 *   3. Create a WordPress page (e.g. /diwali/) containing the shortcode:   [usd_diwali_auth]
 *   4. Put this page's exact origin (e.g. https://ussupplements.in) in the Worker's AUTH_ORIGINS variable.
 *
 * SECURITY NOTES
 *   - NO secrets live in WordPress or in this page's JavaScript. The handoff token is random, single-use,
 *     expires in 10 minutes, and is passed in the URL FRAGMENT (#token=…), which browsers never send to servers
 *     or in Referer headers. The envelope page removes it from the address bar immediately.
 *   - The token never contains the order, customer details, or reward information.
 *   - Eligibility is decided only by the Worker. Nothing here is trusted.
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

function usd_diwali_auth_config() {
	// Production defaults; wp-config.php constants override them (e.g. for staging).
	$api = defined( 'USD_DIWALI_API_BASE' ) ? rtrim( (string) USD_DIWALI_API_BASE, '/' ) : 'https://uss-diwali-auth-2026.822005harsh.workers.dev';
	$env = defined( 'USD_DIWALI_ENVELOPE_URL' ) ? (string) USD_DIWALI_ENVELOPE_URL : 'https://us-supplements-diwali.pages.dev/';
	$ok  = 0 === strpos( $api, 'https://' ) && 0 === strpos( $env, 'https://' );
	return array( 'api' => $api, 'envelope' => $env, 'ok' => $ok );
}

add_shortcode(
	'usd_diwali_auth',
	function () {
		$cfg = usd_diwali_auth_config();
		if ( ! $cfg['ok'] ) {
			return current_user_can( 'manage_options' )
				? '<p><strong>Diwali envelope:</strong> set USD_DIWALI_API_BASE and USD_DIWALI_ENVELOPE_URL (both https://) in wp-config.php.</p>'
				: '<p>This page is not available right now. Please check back soon.</p>';
		}

		$conf = wp_json_encode(
			array(
				'authorize' => $cfg['api'] . '/api/envelope/authorize',
				'envelope'  => $cfg['envelope'],
			),
			JSON_HEX_TAG | JSON_HEX_AMP | JSON_HEX_APOS | JSON_HEX_QUOT | JSON_UNESCAPED_SLASHES
		);

		ob_start();
		?>
<div class="usd-auth" id="usd-auth">
	<style>
		.usd-auth{max-width:520px;margin:32px auto;padding:34px 28px;border:1px solid #d4a23a;border-radius:14px;background:linear-gradient(180deg,#650d20,#390712);color:#ffe9b0;font-family:Georgia,'Times New Roman',serif;box-shadow:0 18px 50px rgba(0,0,0,.35)}
		.usd-auth h2{margin:0 0 6px;font-size:1.6rem;letter-spacing:.06em;color:#ffd875;text-align:center}
		.usd-auth p.lede{margin:0 0 22px;text-align:center;color:#f5d9a6}
		.usd-auth label{display:block;margin:14px 0 6px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;font-size:.8rem;color:#ffd875}
		.usd-auth input[type=text],.usd-auth input[type=tel]{width:100%;box-sizing:border-box;padding:14px 16px;border:2px solid #d4a23a;border-radius:10px;background:#1c0610;color:#ffe9b0;font-size:1.05rem}
		.usd-auth input:focus{outline:none;border-color:#ffd875;box-shadow:0 0 0 3px rgba(255,216,117,.3)}
		.usd-auth button{width:100%;margin-top:22px;padding:15px 18px;border:0;border-radius:10px;background:linear-gradient(180deg,#fff3c8,#d4a23a 60%,#8a6420);color:#390712;font-weight:800;font-size:1rem;letter-spacing:.14em;text-transform:uppercase;cursor:pointer}
		.usd-auth button[disabled]{opacity:.65;cursor:progress}
		.usd-auth .usd-auth__msg{margin-top:16px;padding:12px 14px;border:1px solid #ffae35;border-radius:10px;background:rgba(0,0,0,.25);display:none}
		.usd-auth .usd-auth__msg.is-on{display:block}
		.usd-auth .usd-auth__hp{position:absolute;left:-9999px;height:0;overflow:hidden}
	</style>
	<h2>Unlock Your Diwali Envelope</h2>
	<p class="lede">Enter the Order ID and registered mobile number from your eligible Diwali order.</p>
	<form id="usd-auth-form" novalidate autocomplete="off">
		<label for="usd-auth-order">Order ID</label>
		<input id="usd-auth-order" name="order" type="text" inputmode="numeric" autocomplete="off" maxlength="14" placeholder="e.g. 48213" required>
		<label for="usd-auth-phone">Registered mobile number</label>
		<input id="usd-auth-phone" name="phone" type="tel" inputmode="tel" autocomplete="tel" maxlength="24" placeholder="e.g. +91 98765 43210" required>
		<div class="usd-auth__hp" aria-hidden="true"><label>Leave empty <input id="usd-auth-hp" type="text" tabindex="-1" autocomplete="off"></label></div>
		<button id="usd-auth-btn" type="submit">Verify my order</button>
		<div class="usd-auth__msg" id="usd-auth-msg" role="alert"></div>
	</form>
</div>
<script>
(function () {
	'use strict';
	var CONF = <?php echo $conf; // phpcs:ignore WordPress.Security.EscapeOutput.OutputNotEscaped -- encoded with JSON_HEX_* flags ?>;
	var MSG = {
		INVALID_ORDER:        'We couldn’t match that Order ID and registered mobile number. Please check both and try again.',
		INELIGIBLE_ORDER:     'This order isn’t part of the Diwali draw. Eligible orders were placed between 6 and 8 November 2026 with net product spend strictly above ₹1,500.',
		CAMPAIGN_NOT_STARTED: 'The envelope opens on 9 November 2026. Please come back then.',
		CAMPAIGN_CLOSED:      'The Diwali Mystery Envelope campaign closed at midnight after 9 November 2026. Thank you for celebrating with US Supplements!',
		RATE_LIMITED:         'Too many attempts. Please wait a few minutes and try again.',
		AUTH_ALREADY_USED:    'This order’s envelope has already been opened.',
		INVALID_REQUEST:      'Please enter a valid Order ID (digits only) and registered mobile number.',
		NETWORK:              'We couldn’t reach the server. Check your connection and try again.',
		SERVER_ERROR:         'Something went wrong on our side. Please try again in a moment.'
	};
	var form = document.getElementById('usd-auth-form'), btn = document.getElementById('usd-auth-btn'), box = document.getElementById('usd-auth-msg');
	var busy = false;
	function show(text) { box.textContent = text; box.className = 'usd-auth__msg is-on'; }
	// Returning with the Back button can restore this page from the browser cache mid-navigation;
	// re-enable the form so the customer is not stuck with a disabled button.
	window.addEventListener('pageshow', function (e) { if (e.persisted) { busy = false; btn.disabled = false; } });

	form.addEventListener('submit', function (e) {
		e.preventDefault();
		if (busy) return;
		if (document.getElementById('usd-auth-hp').value) return;               // honeypot
		var order = document.getElementById('usd-auth-order').value.replace(/^#/, '').trim();
		var phone = document.getElementById('usd-auth-phone').value.trim();
		if (!/^\d{1,12}$/.test(order) || !/^\+?[0-9\s().-]{7,24}$/.test(phone)) { show(MSG.INVALID_REQUEST); return; }

		busy = true; btn.disabled = true; box.className = 'usd-auth__msg';
		var ctrl = window.AbortController ? new AbortController() : null;
		var timer = ctrl ? setTimeout(function () { ctrl.abort(); }, 15000) : null;

		fetch(CONF.authorize, {
			method: 'POST',
			mode: 'cors',
			credentials: 'omit',
			cache: 'no-store',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ orderId: order, phone: phone }),
			signal: ctrl ? ctrl.signal : undefined
		}).then(function (res) {
			return res.json().catch(function () { return null; });
		}).then(function (data) {
			if (data && data.success && typeof data.handoffToken === 'string' && /^[A-Za-z0-9_-]{43}$/.test(data.handoffToken)) {
				// Fragment, not query string: never sent to servers or leaked via Referer.
				var base = CONF.envelope.split('#')[0];
				window.location.assign(base + '#token=' + encodeURIComponent(data.handoffToken));
				return;
			}
			var code = data && data.error && data.error.code;
			show(MSG[code] || MSG.SERVER_ERROR);
			busy = false; btn.disabled = false;
		}).catch(function () {
			show(MSG.NETWORK);
			busy = false; btn.disabled = false;
		}).then(function () { if (timer) clearTimeout(timer); });
	});
})();
</script>
		<?php
		return ob_get_clean();
	}
);
