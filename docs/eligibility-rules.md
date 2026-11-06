# Final campaign eligibility rules

The Worker is the sole authority for eligibility. WordPress and Pages display Worker responses and do not independently approve orders.

| Check | Rule |
|---|---|
| WooCommerce order date | 6, 7 or 8 November 2026, using the Asia/Kolkata calendar date |
| Net product value | Strictly greater than ₹1,500 (150,000 paise) |
| Currency | Exactly `INR` |
| Status | `processing`, `completed`, `shipped`, `partially-shipped` or `partial-shipped` (Advanced Shipment Tracking's "Partially Shipped" slug, used by this store) (WooCommerce status slug; `wc-` prefix, case, spaces and underscores are normalized) |
| Product line value | Discounted `line_items[].total`, excluding tax |
| Product refunds | Subtract detailed refund `line_items[].total`, excluding tax |
| Shipping and shipping refunds | Excluded |

The amount is accumulated in integer paise. ₹1,499.99 and exactly ₹1,500 fail; ₹1,500.01 passes if all other rules pass. Missing/malformed line or refund data fails closed. A shipping-only refund does not reduce product value. Summary refund totals are not blindly subtracted from the order total.

Eligibility dates and thresholds are enforced by `worker.js`; the UI only displays explanatory copy. There is no 10–11 November eligibility window and no ₹3,500 threshold. Campaign launch is 9 November 00:00 IST inclusive and close remains 10 November 00:00 IST exclusive. New reward allocation is rejected at the close boundary by the allocation SQL; saved allocations replay without another draw.
