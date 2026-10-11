# StockBridge v3 — Shopify Multi-Store Inventory & Analytics

A Node.js 20+ / Express application for coordinating one-of-a-kind thrift products between independent Shopify stores, with Vercel serverless hosting and Neon PostgreSQL storage. Store examples throughout this repository use **Store A, Store B, Store C and Store D** only.

## Included features

- Store connections read securely from environment variables (no API tokens sent to the dashboard).
- Orders/create and orders/cancelled webhook ingestion, verified against the original raw-body HMAC.
- SKU + Shopify **product-level** metafield `custom.supplier` owner identification; matched SKU+supplier across participating stores.
- Customer order on the owning store: mark linked listings sold and synchronize inventory.
- Customer order on a selling store: place one internal supplier order per owning store, with configurable default **99%** discount and optional free shipping; mark linked listings sold. Internal orders are marked to prevent webhook loops.
- Safe cancellation workflow using saved product status/tags and inventory location snapshots; cancellation can require manual intervention if stock locations or other claims are ambiguous.
- Responsive dashboard behind HTTP Basic Auth: Overview, Inventory & Sales Analytics, Dropshipping, Operations and Settings.
- Sales reporting via lightweight local order ledger and ShopifyQL fallback. Date filters: Today, Yesterday, 7/30/90 days, custom dates; store, owner, product type and brand filters. CSV download.
- Current inventory stock snapshot, retail valuation and deduplicated physical-item totals when selecting all stores.
- Optional catalog synchronization and 12-month historical order backfill through bounded API requests.

**Important:** This is a source-code delivery, not a verified production deployment. The JavaScript syntax and archive can be checked offline. A full `npm install`, automated tests, real Shopify API integration tests, and live inventory restoration tests are still required before enabling writes. No Shopify orders or products were changed when creating this ZIP.

## 1. Prerequisites

- Node.js 20 or newer for local development.
- Neon PostgreSQL database (or PostgreSQL-compatible connection URL).
- A Shopify Admin API offline access token and appropriate API permission for each store.
- A Vercel project using **Framework Preset: Other** (or a compatible Node.js host).
- Correct Shopify app/webhook signing secret for each store.

Required Shopify access depends on the operation: `read_products`, `write_products`, `read_inventory`, `write_inventory`, `read_orders`, `write_orders`. `read_reports` is required for ShopifyQL. Older than 60 days of order history may require the extra approval/scope `read_all_orders`. Protected customer data access and valid **offline** authentication may be required for order creation and original buyer details. Verify permissions in Shopify before enabling live writes.

## 2. Install locally

```bash
unzip StockBridge-v3.zip
cd StockBridge-v3
cp .env.example .env
npm install
npm run check
npm test
npm start
```

Visit `http://localhost:3000`, then sign in using `ADMIN_USER` and `ADMIN_PASSWORD` from `.env`. Keep the `.env` file private; `.gitignore` excludes it. On first database-backed request, the app creates the required tables.

## 3. Environment variables

Copy `.env.example` and replace its placeholders. Do not commit real credentials.

| Variable | Description |
|---|---|
| `DATABASE_URL` | Neon/Postgres connection string with SSL configuration |
| `ADMIN_USER`, `ADMIN_PASSWORD` | HTTP Basic Auth for the dashboard and its APIs |
| `CRON_SECRET` | Strong bearer secret for `/api/worker` |
| `SHOPIFY_API_VERSION` | Admin GraphQL API version, `2026-10` by default; verify support for your stores |
| `LIVE_WRITES` | **`false` by default**; no product/order changes in dry run |
| `DEFAULT_DISCOUNT_PERCENT` | Default supplier-order discount, normally `99` |
| `STORE_A_NAME` | Display name, e.g. `Store A` |
| `STORE_A_URL` | Shopify admin domain, e.g. `store-a.myshopify.com` |
| `STORE_A_SUPPLIER_NAME` | Expected value for ownership metafield `custom.supplier`, e.g. `Store A` |
| `STORE_A_ACCESS_TOKEN` | Shopify Admin API offline token |
| `STORE_A_WEBHOOK_SECRET` | Signing secret used to verify webhook HMAC |
| `STORE_A_OWNER_EMAIL` | Supplier-order contact for Store A |
| `STORE_A_OWNER_ADDRESS1`, `STORE_A_OWNER_CITY`, `STORE_A_OWNER_COUNTRY` | Supplier-order delivery/contact address |

Repeat the same keys for Store B, Store C and Store D. Only fully configured stores should have a `STORE_X_URL` variable. Owners are found from **supplier metafield**, not tags alone. The same SKU can exist across stores, but each supplier/SKU combination should uniquely identify one physical thrift item.

## 4. Prepare Shopify products

For products shared across stores, use the same SKU and **product-level** `custom.supplier` value on every copy. Example: an item belonging to Store A uses `SKU=ITEM-001`, `custom.supplier=Store A` on Store A and Store B. `productType` determines category; optional `custom.brand` determines the brand grouping. StockBridge does not manufacture product copies; ensure source items and chosen copies exist in the participating stores.

For best results, each one-off garment is a separate Shopify product with one inventory-tracked variant. Drafting a Shopify product hides **all its variants**; multi-variant products need deliberate testing. Multi-location inventory restoration is guarded and may require manual review.

## 5. Configure webhooks

Configure Shopify webhook subscriptions for each participating store:

- **Order creation** (`orders/create`) → `https://YOUR-DOMAIN/api/webhooks`
- **Order cancellation** (`orders/cancelled`) → the same endpoint.

Use JSON delivery with Shopify's headers `X-Shopify-Shop-Domain`, `X-Shopify-Topic` and `X-Shopify-Hmac-Sha256`. Set the matching webhook signing secret for each store. Only valid signed webhook POST requests are accepted; browsing to the endpoint is not a valid webhook test. Verify the Shopify-app webhook configuration and permissions for each installation.

Webhooks are queued into PostgreSQL, then processed asynchronously. Because serverless functions are ephemeral, add a scheduled worker call for reliable retries and cancellations.

## 6. Worker and scheduling

A scheduler should periodically call:

```bash
curl -H "Authorization: Bearer YOUR_CRON_SECRET" "https://YOUR-DOMAIN/api/worker?limit=3"
```

The included `vercel.cron-pro.example.json` illustrates a one-minute cron schedule for an eligible Vercel plan. Vercel Hobby and other plans have cron frequency/usage limitations; configure a compliant schedule. The app calls background workers after webhooks, but **do not rely only on background execution for reliable processing**. Review Vercel function duration and plan restrictions. The worker endpoint runs order jobs; also verify cancellation processing via app background execution before production and use Operations to track/retry failures.

## 7. Dashboard workflow

- **Overview:** current stock and sales summaries, connection health.
- **Inventory & Sales Analytics:** select selling store, owner store, product type, brand, dates; compare available units, retail stock value, sold units and sales value. Export CSV.
- **Dropshipping:** view cross-store sales grouped by owning supplier.
- **Operations:** view jobs, errors, cancellations; run a bounded catalog sync (200 products per dashboard action); manually import past orders in batches and retry failed jobs.
- **Settings:** edit supplier-order discount (0–100%), free internal shipping and analytics cache TTL (60–86,400 seconds). Changes affect **new** supplier orders, not existing ones.

The dashboard serves data from an authenticated Express route, not a publicly accessible static folder.

## 8. Initial stock sync and historical sales import

Perform stock synchronization for **each** connected store from Operations; repeat until catalog traversal completes. From local CLI, the included bounded incremental scripts can iterate more pages:

```bash
STORE_KEY=A npm run sync:catalog
STORE_KEY=B npm run sync:catalog
STORE_KEY=A npm run backfill:orders
STORE_KEY=B npm run backfill:orders
```

Repeat with C/D where enabled. The sales backfill requests up to 12 months; actual access depends on Shopify order-history authorization. Catalog sync is needed to populate stock summaries. The current available-stock figure is a **current** snapshot; the app cannot reconstruct arbitrary historical inventory levels from today's stock alone.

## 9. Enabling live synchronization safely

Keep `LIVE_WRITES=false` initially, and check `/api/status` with the dashboard login. Confirm store credentials, missing scopes, supplier metafields and matching SKU copies. Test a new order and webhook in a development store. Then review dry-run logs and the Operations dashboard. Only after making backups and verifying the specific test scenario, switch `LIVE_WRITES=true`, redeploy and test **one** item at a time.

### Example A — owner sale

Store A owns `ITEM-001` (`custom.supplier=Store A`). Customer buys it on Store A. Matching copies on the other stores are made unavailable/drafted, and the sold state is recorded. No additional supplier order should be created for Store A's own item.

### Example B — reseller sale

Store B lists Store A's `ITEM-001`. When a customer buys on Store B, StockBridge marks copies sold across connected stores and creates an internal supplier order on Store A for the selling-store contact. The supplier-order discount comes from Settings (default 99%), free shipping can be enabled, and internal tags prevent recursive processing. The original order reference is added to the supplier order.

### Example C — cancellation

When the customer order on Store B is cancelled, the app processes the cancellation event, attempts to cancel the internal supplier order, checks existing physical claims and restores listing snapshots only when safe. If the order was already fulfilled, the inventory location is ambiguous, or Shopify rejects cancellation, it records an error for manual review rather than blindly incrementing stock.

**Concurrency warning:** Checkout can finish before the webhook arrives. Two simultaneous checkouts may happen before the first webhook is processed; database claims mitigate application duplicates but cannot reverse Shopify checkouts.

## 10. Deployment to Vercel

1. Unzip the source and commit the **contents of `StockBridge-v3/`** to a **private** GitHub repository. Do not commit `.env`.
2. Import that repository to Vercel. Set Framework Preset **Other** and choose root where `package.json`, `vercel.json`, and `api/index.js` live.
3. Create Neon PostgreSQL, store its connection string in Vercel `DATABASE_URL`.
4. Add the variables from `.env.example` in Vercel's relevant environments. Set a real strong password and a unique cron secret.
5. Deploy. Visit `https://YOUR-DOMAIN/health` (expects JSON) and the login-protected dashboard at `/`.
6. Test `/api/status` from an authenticated dashboard, then configure webhooks on Shopify stores and verify delivery via Shopify and Vercel logs.
7. Keep `LIVE_WRITES=false` until dry-run tests are correct, then enable and redeploy after validating one product end-to-end.
8. Set up a recurring authenticated worker. Monitor Operations for failures.

### Important endpoints

| Route | Method | Access | Purpose |
|---|---|---|---|
| `/` | GET | Basic Auth | Dashboard |
| `/health` | GET | Public | Basic readiness |
| `/api/status` | GET | Basic Auth | Connections and recent jobs |
| `/api/webhooks` | POST | Shopify HMAC | Orders/create and orders/cancelled |
| `/api/worker?limit=3` | GET | `Bearer CRON_SECRET` | Queued order processing |
| `/api/settings` | GET/PUT | Basic Auth | Discount/free shipping/cache |
| `/api/analytics` | GET | Basic Auth | Aggregated reporting |
| `/api/analytics/csv` | GET | Basic Auth | CSV export |
| `/api/sync` | POST | Basic Auth | Bounded stock catalog sync |
| `/api/backfill` | POST | Basic Auth | Bounded historical order import |
| `/api/cancellations` | GET | Basic Auth | Cancellation tracking |
| `/api/retry` | POST | Basic Auth | Requeue failed work |

## 11. ShopifyQL analytics notes

Your Shopify Analytics query is useful for supplier/product-type sales grouping. StockBridge removes `TOP 5` so supplier/category records are not intentionally truncated, and supports a brand-based grouping using `custom.brand`. Access through the Admin API is **not** guaranteed simply because the query runs in Shopify Admin Reports. Confirm `shopifyqlQuery` permissions (`read_reports`) and per-store compatibility. If unavailable, the dashboard uses locally imported sales events where present; mixed ShopifyQL `total_sales` and local gross line value can have **different definitions**. For consistent cross-store comparisons, complete and reconcile historical backfill. ShopifyQL may not support all metafield dimensions or metrics on every store.

Current inventory uses cached SKU/variant stock levels. Selecting all selling stores deduplicates physical stock by supplier/SKU using the owner store. Stock valuation is based on Shopify **selling price**, not landed cost. Currency conversion is not performed between stores; compare numeric sales totals only where currencies are compatible.

## 12. Tests and troubleshooting

```bash
npm run check
npm test
```

The included logic tests cover matching, env parsing, webhook signatures, order/cancellation flows with mocked dependencies. These must be run after `npm install` on an actual environment. Real Shopify integration tests should additionally verify `orderCreate`, owner-order inventory reduction, 99% discount, free shipping, multi-location handling, historical reporting, and safe cancellation.

- **401 API connection:** re-check exact `.myshopify.com` shop domain, valid offline Admin API token and granted scopes.
- **403/401 webhook:** verify signing secret and raw-body HMAC; do not substitute Admin API token for secret.
- **No jobs appear:** inspect Shopify webhook deliveries and Vercel logs.
- **Unknown owner or duplicate SKU:** confirm product-level `custom.supplier` matches an enabled store, and that there is one unique SKU+supplier per store.
- **PENDING or ERROR jobs:** check scheduler, permission errors and Operations; retry only after examining whether supplier orders already exist.
- **Empty analytics:** run catalog sync and historical backfill for each store, or verify ShopifyQL access and reporting dimensions.
- **Cancellation blocked:** verify fulfillment/refund state, location inventory and competing claims; manually reconcile as necessary.

## 13. Security and operational limitations

Keep credentials only in environment variables, use an isolated production database, and enable Neon backups. Webhook payloads and order customer information may be processed/stored temporarily in the DB. Apply retention and customer-data controls appropriate to applicable law and Shopify policy. HTTP Basic Auth should be used only over HTTPS. For larger teams, consider stronger user/session access control with per-user permissions and audit history.

The source has **not** been confirmed against real Shopify credentials or a live Vercel deployment. The purchase, drafting, stock and cancellation paths should be treated as pre-production until validated with actual development stores. Ensure compliance with Vercel's hosting terms and your Shopify app's access permissions.

---

**StockBridge v3** — one-of-a-kind inventory coordination for Store A, Store B, Store C and Store D.
