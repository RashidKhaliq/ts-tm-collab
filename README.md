# ThriftSync Simple v2.1 (Dashboard Fix)

**Fix:** `/api/status` and `/api/retry` now surface detailed HTTP errors rather than a JSON.parse failure. The dashboard is moved out of Vercel's publicly served static directory and requires Express Basic Auth.

**For the screenshot showing 503:** On Vercel, verify `ADMIN_USER` and `ADMIN_PASSWORD` exist in the deployed environment (Production, Preview, etc.), that neither is a template placeholder, and redeploy. `/health` should return JSON. `/api/status` should ask for login (`401`) when not authenticated, and return JSON when logged in. If it still returns `503`, the dashboard now shows the precise reason.

**Safety:** Don't click Retry failed orders until both stores are connected and you know whether `LIVE_WRITES=true`; Retry can create real Shopify orders.

# ThriftSync Simple v2

**2+ independent Shopify stores. No manual product import. No Google Sheets. No SKU linking dashboard.**

An order on any configured Shopify store triggers a `orders/create` webhook. The app looks up that line item on its selling store, reads `custom.supplier` from the **product**, and identifies the owning store via `STORE_X_SUPPLIER_NAME`. It then finds the same SKU **and** supplier on every configured store through live Shopify Admin GraphQL queries. Only exact unique matches are changed.

## The two flows

**Owner sale:** Store A sells an item with `SKU=ABC-123`, `custom.supplier=ZIA` and Store A is configured with `STORE_A_SUPPLIER_NAME=ZIA`. No additional Shopify order is created. Matching listing on Store A and other connected stores are marked `DRAFT`, tagged `Soldby_Owner_Store` (based on configured store name), and tracked available inventory is set to zero.

**Reseller sale:** Store B sells item `ABC-123` with `custom.supplier=ZIA`. App finds Store A owner listing with `ABC-123 + ZIA`, and creates **one internal order on Store A** with buyer info pointing to Store B's owner email and configured owner delivery address, a 99% percentage discount, shipping line costing 0, `Dropshipped_Order` and unique `TS_` reference tags. Original customer name, email, phone, postal address, original Shopify order number and SKU appear in internal order notes. The app first drafts and tags all matching listings to stop further sales. On non-owner stores available quantity is zeroed immediately; on the owner store it remains available until the supplier order decrements it, and any remaining available quantity is then set to zero. The final state is DRAFT + `Soldby_Selling_Store` + available quantity 0 in **all** stores where it is listed. Shopify internal order inventory is explicitly decremented with `DECREMENT_OBEYING_POLICY`.

For a multi-line customer order, one supplier order is created per distinct owner. No extra orders for owner-owned items.

## Quick deployment (Vercel + Neon)

1. Upload contents **inside this folder** to GitHub repository root. You should see `package.json`, `vercel.json`, `api/index.js`, `src/`, `public/`.
2. Create or reuse Neon Postgres database. Ensure `DATABASE_URL` is set for the correct deployment environment. Existing old ThriftSync tables (`stores`, etc.) can stay; this version uses separate `ts_` tables, created automatically on first request using one statement at a time (fixes Neon prepared-statement multi-query error).
3. Vercel Settings > Build & Deployment > Framework Preset: **Other**. Root directory: folder containing `package.json`. No `next` dependency. Add environment variables from `.env.example`, with real values. `STORE_A_URL`/`STORE_B_URL` must be `something.myshopify.com`, not your public domain. More stores use `STORE_C_*`, etc.
4. Start with `LIVE_WRITES=false` and deploy. Open your deployment root dashboard (HTTP Basic Auth: `ADMIN_USER`/`ADMIN_PASSWORD`). It tests API access and lists missing scopes for each store. A 401 means the token is invalid/expired/wrong shop; this **cannot be fixed by application code**. API tokens may begin `shpca_` if issued for the Admin API, but prefix alone proves nothing. GraphQL `orderCreate` additionally **requires offline app authorization**. This is a Shopify restriction.
5. Ensure Admin API access scopes: `read_products`, `write_products`, `read_inventory`, `write_inventory`, `read_orders`, `write_orders` (and adequate order/customer access to read buyer fields). Grant protected customer data permissions if Shopify restricts them. App uses Shopify's GraphQL Admin API version `2026-10`.
6. In **each** Shopify store, subscribe **Order creation** webhook to `https://ts-tm.onlinethriftstore.pk/api/webhooks` JSON. It must send `X-Shopify-Shop-Domain` and `X-Shopify-Hmac-Sha256`. Set `STORE_X_WEBHOOK_SECRET` to the signing secret used for that Shopify webhook, **not** the notification webhook URL, the webhook delivery ID, or the API token. If both stores share the same Shopify app, their signing secret may be the same. If you manually created webhooks, use the actual matching signing secret.
7. The existing subscriptions for Order cancellation, Product update and Inventory item update may remain, but this streamlined app **ignores** them. There is **no automatic cancellation reversal**.
8. Place development-store test order. Check dashboard's Latest orders and Activity. In DRY RUN no Shopify write takes place, but the app records what would match. Toggle `LIVE_WRITES=true` after confirming tokens/webhooks and create **a new test order**. Dry-run orders are not later processed automatically.
9. Once LIVE_WRITES is true, order webhook instantly queues a Neon job and the serverless function schedules background processing with Vercel `waitUntil`. Failed items appear in the dashboard; use **Retry failed orders** after fixing the error. This version also exposes a secured `GET /api/worker` endpoint, authorized by `Authorization: Bearer <CRON_SECRET>`, for an **external recurring scheduler** (recommended for reliable retries and recovery). On Vercel Hobby, minute-by-minute Vercel Cron isn't available; do not assume background processing is guaranteed if functions are stopped. Add an external schedule invoking this endpoint every 1-5 minutes, or use an eligible Vercel Cron plan.
10. Build command: none. Vercel uses the Express entry point through `api/index.js`.

## Required Vercel env values

See `.env.example`. Existing old values `STORE_X_*` can be reused but `STORE_X_WEBHOOK_SECRET` must be correct. `STORE_ENCRYPTION_KEY` and `PRISMA_DATABASE_URL` are **not required** for this clean rebuild; tokens are read from Vercel environment variables and never stored in DB.

## Domain and webhook verification

`GET /health` is unauthenticated and safe. Dashboard `/` and `/api/status` require Basic Auth. Webhooks must be genuine Shopify messages with valid raw-body HMAC; a normal browser GET to the webhook endpoint will not process an order.

## Limits and important facts

- **Shopify checkout is completed before an order-created webhook arrives.** The application reacts as quickly as possible, but two simultaneous checkouts can happen. Neon claims prevent both webhook processors from treating the same SKU as available, but can't revoke an already-completed checkout automatically.
- If there are two products in the same shop with identical SKU + supplier, the app **stops** for that SKU rather than drafting the wrong product.
- Product DRAFT affects **all variants on that product**, not only the ordered variant. Intended for one-off thrift items; group different variants into separate products if needed.
- The 99% discount is an actual Shopify order discount, not a fake price. Zero shipping is a defined zero-price shipping line; taxation follows Shopify's order rules and may still apply.
- When a supplier order is created and Shopify emits another order/create event for it, the app **ignores** the internal order using `Dropshipped_Order` / `TS_` tags.
- Syncing old orders is not part of this deliberately minimal version. The webhook must be installed and working **before** placing the test order.
- If the target product is absent on some shops, those shops are skipped; the owner store must have an exact matched listing.
- Store owners' `custom.supplier` values must match `STORE_X_SUPPLIER_NAME` case-insensitively; SKU matching is also case-insensitive. Metafield belongs on Shopify **product** (not variant) in this app.
- Shopify token 401 errors reflect credentials/store permissions and cannot be fixed by changing a token prefix. The dashboard checks each store live.
- No direct token display, no customer data in logs. The webhook payload (including buyer details) is temporarily held in Neon for processing. Protect access and set a retention/cleanup process as appropriate to your privacy requirements.

## Local dev

```
cp .env.example .env
npm install
npm start
npm test
```

See `public/index.html` for the minimal built-in status dashboard. No product-maintenance UI or manual inventory-listing tools exist.

## How to debug specific failure

- `401` under Connected Stores: wrong/expired/offline authorization mismatch token and `.myshopify.com` domain; verify Shopify Admin API directly.
- No Latest orders after checkout: Shopify webhook not delivered to `/api/webhooks`, wrong URL, invalid HMAC, or webhook created on wrong store; inspect Vercel Function logs.
- `DRY_RUN` jobs: set `LIVE_WRITES=true` and submit a *new* test order.
- `ERROR` with missing supplier: add `custom.supplier` product metafield to source and partner products.
- `ERROR` owner matching: verify matching SKU and supplier exist on owner's store.
- `ERROR` scope/401: grant correct scopes and obtain a valid offline Admin API token per shop.
- `ERROR` `OrderCreate` requiring offline token: Shopify requires offline authorization for this mutation; update app auth, not webhook config.
- `PENDING` for too long: scheduled processing not running; call the protected worker endpoint using your scheduler, or retry via dashboard.
