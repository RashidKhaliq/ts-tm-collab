# ThriftSync v3 Analytics + Cancellation Beta (`3.0.0-beta.1`)

**Order synchronization remains the core function**, while analytics is summary-based rather than product-level.

## What is implemented in v3

### 1. Order cancellation restore (`orders/cancelled`)
`orders/cancelled` is now processed in addition to `orders/create`.

For every new sale processed by this version, ThriftSync saves the product's **pre-sale state before making its own Shopify changes**. When the original customer order is cancelled, the system uses that snapshot to:
- restore inventory to the recorded pre-sale quantity on every linked store using idempotent `inventorySetQuantities` mutations (setting absolute quantities);
- restore the previous Shopify product status, normally `ACTIVE`;
- remove the relevant `Soldby_[SellingStoreName]` tag using Shopify's supported `tagsRemove` mutation;
- release ThriftSync's internal claim on the physical item.

*Limitation:* Orders sold before this v3 release don't have pre-sale cancellation snapshots, so those historical orders cannot be safely auto-restored. When cancelled, they are safely skipped and logged.

### 2. Configurable dropship discount
The internal supplier-order discount is now configurable via:
**Settings → Internal supplier order → Discount percentage**
Presets: `99%`, `95%`, `90%`, `80%`, `50%`, `0%` (or any custom value).
Stored in Neon PostgreSQL &mdash; changing it through the dashboard **does not require a Vercel redeploy**.
Initial/default value set via:
```env
INTERNAL_DISCOUNT_PERCENT=99
```

### 3. ShopifyQL Sales Analytics
Historical sales are queried directly via ShopifyQL rather than storing thousands of old orders in Neon:
```sql
FROM sales
SHOW net_items_sold, gross_sales, total_sales
WHERE order_tags NOT CONTAINS 'Dropshipped_Order'
GROUP BY product.metafields.custom.supplier,
  product_type,
  product.metafields.custom.brand
SINCE 2026-09-11 UNTIL 2026-10-10
ORDER BY total_sales DESC
LIMIT 1000 OFFSET 0
```
- Paginates automatically (`OFFSET 0`, `OFFSET 1000`, `OFFSET 2000`...).
- Automatically excludes internal dropship supplier orders (`WHERE order_tags NOT CONTAINS 'Dropshipped_Order'`).
- Results cached in Neon for `ANALYTICS_CACHE_MINUTES` (default 15 minutes).

### 4. Inventory Architecture for 10,000+ Products
Rather than scanning 10,000+ products live whenever the dashboard opens:
- An **Inventory Sync** worker walks the Shopify catalog in small pages and aggregates: `Store`, `Supplier`, `Product Type`, `Brand`, `Product Count`, `Available Qty`, `Retail Value`.
- Stores lightweight summaries in Neon.
- The dashboard reads from Neon instantly.

### 5. Mobile-First Analytics Dashboard
Main KPIs:
- **Available Now**: Current physical owner inventory
- **Inventory Value**: Available quantity &times; current retail selling price
- **Sold Qty**: Net units sold in selected period
- **Total Sales**: Shopify customer sales value for selected period
- **Sell-through**: Sold &divide; (Sold + Available)
- **Products Tracked**: Products represented by current inventory aggregates

Filters:
- **Date**: Today, Yesterday, Last 7 Days, Last 30 Days, Last 90 Days, Custom Date
- **Selling Store**: All / Store A / Store B / ...
- **Owner Store**: All / Store A / Store B / ...
- **Product Type**: All / discovered product types
- **Brand**: All / discovered `custom.brand` values
- **Group By**: Product Type / Brand

## Required Scopes & Configuration

### Shopify Scopes
Ensure your Shopify app has granted:
```text
read_products
write_products
read_inventory
write_inventory
read_orders
write_orders
read_reports
```
*Note:* `read_reports` and protected customer data access are required for ShopifyQL.

### Webhook Subscriptions
Subscribe both topics to your webhook endpoint:
```text
https://ts-tm.onlinethriftstore.pk/api/webhooks
```
- **Order creation** (`orders/create`)
- **Order cancellation** (`orders/cancelled`)

### Environment Variables
```env
SHOPIFY_API_VERSION=2026-10
INTERNAL_DISCOUNT_PERCENT=99
ANALYTICS_CACHE_MINUTES=15
LIVE_WRITES=true
```

## Local Development & Testing

```bash
npm install
npm test
npm run check
npm start
```
All 19 test suites validate configuration, order drafting, dropship discounts, pre-sale snapshots, order cancellation restoration, ShopifyQL paging, inventory aggregation, and analytics metrics.
