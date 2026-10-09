# ThriftSync: Shopify multi-store inventory collaboration

Node.js 20+, Express, PostgreSQL, Shopify GraphQL Admin API, and a lightweight HTML dashboard. Based on the supplied older Next.js/Express project's business intent, this is a clean independent implementation, **not a migration of its existing database**.

## What this implementation does

- Configure any number of stores from the dashboard. Each store has its own encrypted Admin API offline token and Shopify webhook secret.
- Create a unique database identity for each **physical thrift item**. An item has one owner and explicit Shopify variant listings across stores. Same SKU by itself never links different items.
- Verify each listing via Shopify, including exact `custom.supplier` value equal to the physical item's owner's supplier code.
- Accept and HMAC-verify `orders/create` and `orders/cancelled` webhooks, persist them to PostgreSQL, and process them idempotently from a worker.
- On original sale, atomically reserve the physical item once using a SQL row lock. For each linked store product: add `Soldby_StoreName`, set product status DRAFT.
- When seller differs from original owner, create owner-side order with `Dropshipped_Order`, 99% discount, one zero-cost shipping line, selling-store reference and original customer contact/shipping information in order **notes**. Supplier order decrements owner inventory, rather than bypassing the inventory claim.
- When owner sells directly, do not create an owner-side duplicate order.
- On cancellation, place the item in `REVIEW` and require manual approval of restoration **after** reviewing physical custody, fulfillment, and any supplier order. This intentionally differs from immediate automatic restocking, which can create another oversale.
- Record webhook processing errors, sale states and human-readable audit history.

## Requirements

- Node.js 20+ and a PostgreSQL database with `pgcrypto` extension support (Supabase, Neon, managed PostgreSQL).
- Supported Shopify offline Admin API tokens and scopes: `read_products`, `write_products`, `read_orders`, `write_orders`. Access to the `custom.supplier` product metafield and Shopify webhook subscription management.
- Each Shopify store's product variant must already exist. The owner and all participating stores must have matching `custom.supplier` on the product, exactly equal to the owner's configured supplier code. Inventory linkage is explicitly entered; automatic catalog copying is **not included**.
- Scheduler to POST `/api/worker/run` with header `X-Worker-Secret` at least once per minute. This is required on Vercel because background tasks must not depend on an HTTP response continuing to run. Use a reliable external cron/scheduler or suitable Vercel cron configuration for your plan.

## Local installation

```bash
npm install
cp .env.example .env
# Fill in DATABASE_URL, ADMIN_USER, ADMIN_PASSWORD, WORKER_SECRET,
# STORE_ENCRYPTION_KEY, and set LIVE_WRITES=false
npm run db:setup
npm test
npm start
```

Visit `http://localhost:3000` and sign in with the browser's HTTP Basic login dialog using `ADMIN_USER` / `ADMIN_PASSWORD`. Set a random 64-hex-character encryption key once. Do not rotate it without first re-encrypting stored credentials.

For local worker simulation:

```bash
curl -X POST http://localhost:3000/api/worker/run -H 'X-Worker-Secret: YOUR_WORKER_SECRET'
```

`LIVE_WRITES=false` is a test-only dry run. It **does** ingest webhook data and reserves database items. Use a disposable database for dry-run testing. It does **not** change Shopify listing status or create supplier orders. Never turn on `LIVE_WRITES=true` without verifying product links, scopes, test orders, webhook authenticity, order pricing, and database backups.

## Shopify store setup

1. Connect the stores through `Stores` in dashboard. Enter each store's `.myshopify.com` domain, supplier code, selling-store owner name/email/address and API credentials. Supported count is not hardcoded.
2. Ensure all physical item listings have `custom.supplier` equal to the real owner's supplier code; create physical items under `Inventory` and link Shopify product/variant IDs under `Listings`.
3. Configure BOTH `orders/create` and `orders/cancelled` webhooks to the *same* URL in **every** connected store: `https://YOUR-APP.vercel.app/api/webhooks/shopify`. Supply each store's exact HMAC webhook signing secret in its dashboard record.
4. Configure scheduler: POST `https://YOUR-APP.vercel.app/api/worker/run` with `X-Worker-Secret` header. The scheduler credential must never be included in browser scripts.
5. Review `Webhooks`, `Sales`, and `Audit` tabs. When cancellation occurs, verify owner fulfillment/courier state and customer/order outcome before admin restores inventory. The current restoration UI does not automatically cancel the supplier-side order.

## Vercel: "No Next.js version detected" fix

This package is **Express**, not Next.js. In Vercel Project Settings > Build and Deployment, select Framework Preset **Other** (not Next.js). The `vercel.json` in this release also declares `"framework": null` to override Next.js detection. Disable a `next build` override; select the folder containing this package's `package.json` as Root Directory (usually `./`, or `ThriftSync-Vercel-Fix` if the repository has an enclosing directory). Commit and redeploy.

Do not add `next` merely to satisfy Vercel's framework check. Successful compilation does not mean the database, worker schedule, or Shopify API credentials have been configured.

## Deployment to Vercel

1. Create PostgreSQL and execute `npm run db:setup` from a machine with connection access.
2. Push **only this folder** to GitHub; ensure `.env` remains excluded.
3. Import repository into Vercel. Set environment variables from `.env.example` under project settings. Enable Node.js runtime and check rewrite routes.
4. Configure Shopify callbacks and an external HTTPS scheduler.
5. Visit `/health` for basic readiness status, then `/` for the password-protected dashboard.

No SQLite, JSON-database fallback, in-process cron loops, or API tokens in browser state.

## Known boundaries and production readiness

This is a practical implementation baseline, **not a guarantee of live production correctness** without store-connected testing. In particular:

- Shopify checkout can occur on two independent stores **before** webhook processing. Atomic database locks prevent two internal successful reservations, but cannot undo an accepted external Shopify checkout. An oversale is logged for manual handling. High-value single-unit items should use an additional storefront availability gate/checkout reservation mechanism or be listed in only one place at a time.
- Event delivery is asynchronous. Real-world listing draft speed depends on webhook delivery, worker interval, and Shopify API response/rate limiting.
- Supplier order creation is retried with a stable reference. A Shopify timeout after creating an order but before responding must be reconciled by matching the internal reference in the owner's orders. Verify that reconciliation against real shops before production.
- The app links existing products rather than automatically creating or deleting catalog items. Linking is manual by product and variant ID; bulk importer and OAuth self-service installation are not implemented.
- The dashboard uses Basic authentication, suitable for a private single-admin installation behind HTTPS, not a public multi-tenant SaaS. Set a strong password and limit network access if possible.
- Full returns/refunds, partial cancellations, fulfillment/tracking relay, customer-privacy compliance review, multi-quantity product stock accounting, seller billing, bulk inventory onboarding, API rate-limit queues, and automated customer notifications are outside this version.
- Product-level DRAFT affects **all variants** of that product. Use single-variant products or dedicate one product per physical thrift item.
- No live Shopify store tests, load tests, or Vercel deployment have been performed in this environment. Test order mutation, discount and shipping line behavior on a development store.

## File organization

```text
api/index.js           Vercel route handler
src/app.js             Dashboard and API routes, webhook validation
src/engine.js          Order queue, atomic reservation, sync, cancellation review
src/shopify.js         Shopify GraphQL Admin API integration
src/security.js        HMAC and encrypted credentials
src/db.js              PostgreSQL pool and transactions
sql/schema.sql         Durable item, listing, sale, webhook and audit schema
scripts/setup.js       Database creation
public/index.html      Admin dashboard
server.js              Local Node.js entry point
```

### Priority next steps after developer-store testing

Validate Shopify orderCreate against the owner's real currency, tax and discounts; confirm DRAFT tagging and status, then add bulk matching/registration and fine-grained permissions. Reliable prevention of cross-store double-checkout requires coordinating availability earlier than order webhooks.
