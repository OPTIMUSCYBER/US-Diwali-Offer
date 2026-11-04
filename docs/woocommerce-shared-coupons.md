# WooCommerce coupon note

The Diwali Mystery Envelope reward system no longer awards coupons or discount codes. Its rewards are the physical inventory listed in migration `0003_physical_reward_inventory.sql` plus the unlimited Better Luck Next Time fallback.

This project does not inspect, create, edit, or remove unrelated WooCommerce coupons. Existing store coupons are separate from envelope rewards and are not managed by this integration.
