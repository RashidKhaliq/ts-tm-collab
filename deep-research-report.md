# ThriftSync v3 Analytics + Cancellation Beta

Coding has started and the first integrated beta build is ready.

[Download ThriftSync v3 Analytics + Cancellation Beta](sandbox:/mnt/data/ThriftSync-v3-Analytics-Cancellation-Beta.zip)

This build keeps the original ThriftSync concept simple: **order synchronization remains the core function**, while analytics is summary-based rather than product-level.

## What is implemented

### Order cancellation restore

`orders/cancelled` is now processed in addition to `orders/create`.

For every new sale processed by this version, ThriftSync saves the product's **pre-sale state before making its own Shopify changes**. When the original customer order is cancelled, the system uses that snapshot to:

- restore inventory to the recorded pre-sale quantity on every linked store;
- restore the previous Shopify product status, normally `ACTIVE`;
- remove the relevant `Soldby_[SellingStoreName]` tag;
- release ThriftSync's internal claim on the physical item.

The restore uses Shopify's current inventory mutation rather than simply adding `+1`. This matters because blindly incrementing inventory can produce incorrect stock when Shopify itself has already restocked an item during cancellation. Shopify's current `inventorySetQuantities` API supports setting an absolute available quantity and, in API 2026-10, the implementation uses idempotent inventory writes. citeturn13view1

One important limitation applies: **orders sold before this v3 release don't have ThriftSync cancellation snapshots**, so those historical orders cannot be safely auto-restored.

### Configurable dropship discount

The previous hard-coded `99%` internal supplier-order discount is now configurable.

The new dashboard has:

**Settings → Internal supplier order → Discount percentage**

For example:

```text
99%
95%
90%
80%
50%
0%
```

The value is stored in Neon, so changing it through the dashboard **does not require a Vercel redeploy**.

You can also define the initial/default value through:

```env
INTERNAL_DISCOUNT_PERCENT=99
```

The internal owner-store order still receives:

```text
Dropshipped_Order
TS_xxxxxxxxxxxxxxxxxxxx
```

tags, free internal shipping, the original selling-store order reference, customer details in the note, and the configured percentage discount.

Shopify's current `orderCreate` mutation officially supports an `itemPercentageDiscountCode`, and `orderCreate` requires `write_orders` plus offline-token authentication. citeturn14view0turn15view4

## Analytics dashboard

The application now has a separate **Analytics** section with a mobile-first responsive interface rather than copying the design from your reference image.

The dashboard contains these main KPIs:

| KPI | Meaning |
|---|---|
| Available Now | Current physical owner inventory |
| Inventory Value | Available quantity × current Shopify selling price |
| Sold Qty | Net units sold in selected period |
| Total Sales | Shopify sales value for selected period |
| Sell-through | Sold ÷ (Sold + Available) |
| Products Tracked | Products represented by the current inventory aggregate |

The analytics filters include:

| Filter | Options |
|---|---|
| Date | Today |
| | Yesterday |
| | Last 7 Days |
| | Last 30 Days |
| | Last 90 Days |
| | Custom Date |
| Selling Store | All / Store A / Store B / Store C / ... |
| Owner Store | All / Store A / Store B / Store C / ... |
| Product Type | All / all discovered Shopify Product Types |
| Brand | All / all discovered `custom.brand` values |
| Group By | Product Type / Brand |

This gives you the type of report you described. For example:

**Selling Store = ThriftShop**  
**Owner Store = ThriftMall**  
**Product Type = Jackets**

could show:

| Product Type | Available | Inventory Value | Sold Qty | Gross Sales | Total Sales | Sell-through |
|---|---:|---:|---:|---:|---:|---:|
| Jackets | 173 | 624,500 | 27 | 113,000 | 118,250 | 13.5% |

The numbers above are illustrative only.

## ShopifyQL implementation

Historical sales are now designed around ShopifyQL rather than importing thousands of old orders into Neon.

The generated query is conceptually:

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

The application automatically pages using:

```sql
LIMIT 1000 OFFSET 0
LIMIT 1000 OFFSET 1000
LIMIT 1000 OFFSET 2000
...
```

instead of using:

```sql
ONLY TOP 5
```

So your dashboard isn't restricted to the five largest Product Types or suppliers.

Shopify officially supports custom product metafields as dimensions in the `sales` schema. The required syntax is:

```text
product.metafields.<namespace>.<key>
```

Therefore:

```text
product.metafields.custom.supplier
product.metafields.custom.brand
```

are valid dimensions **provided their metafield definitions have `analyticsQueryable` enabled**. Shopify also documents `product_type` directly as a sales dimension. citeturn21view0turn19search23

ShopifyQL's GraphQL endpoint returns structured `tableData`, including column metadata and rows, and returns `parseErrors` when a ShopifyQL field/query is unsupported. citeturn13view0

### Internal dropship sales are excluded

This is particularly important for your architecture.

Suppose:

**ThriftShop sells a ThriftMall product**

Customer order:

```text
ThriftShop
Order #1050
Rs. 10,000
```

ThriftSync then creates:

```text
ThriftMall
Internal supplier order
99% discount
```

Without filtering, Shopify Analytics could potentially count activity related to both orders and distort the cross-store dashboard.

Every internal owner order is therefore tagged:

```text
Dropshipped_Order
```

and the analytics query uses:

```sql
WHERE order_tags NOT CONTAINS 'Dropshipped_Order'
```

`order_tags` is an official `ARRAY<STRING>` dimension of the sales schema. citeturn22view0

So customer sales remain in the analysis while ThriftSync-created supplier orders are excluded.

## Inventory architecture for ten thousand-plus products

I deliberately did **not** make the dashboard load 10,000+ Shopify products whenever you open Analytics.

That would be the wrong architecture for Vercel/Neon free resources.

Instead, there is now an **Inventory Sync** section.

It walks the Shopify catalog in small pages and saves only summarized rows such as:

```text
Store
Supplier
Product Type
Brand
Product Count
Available Qty
Retail Value
```

For example, instead of Neon containing 15,000 individual product records:

```text
Product 1
Product 2
Product 3
...
Product 15000
```

it can end up with a much smaller aggregate dataset such as:

```text
ThriftShop | ThriftShop | Jackets | Nike    | 63 | 63 | 441000
ThriftShop | ThriftShop | Jackets | Adidas  | 51 | 51 | 331500
ThriftShop | ThriftMall | Shoes   | Puma    | 28 | 28 | 196000
...
```

The dashboard then reads these aggregate rows from Neon.

That means opening the dashboard does **not** trigger a complete Shopify product scan.

### Why inventory uses a different method from sales

ShopifyQL sales supports custom product metafields such as `custom.supplier` and `custom.brand` when they are analytics-queryable. citeturn21view0

For current inventory, however, the most reliable design for the brand/owner combinations you require is to aggregate current Admin API product data ourselves.

So v3 uses a hybrid model:

```text
Historical sales
       ↓
 ShopifyQL
       ↓
 supplier + product type + brand
       ↓
     cache
       ↓
      Neon
```

and:

```text
Current Shopify catalog
       ↓
incremental GraphQL pages
       ↓
supplier + type + brand aggregation
       ↓
only summaries saved
       ↓
      Neon
```

Then:

```text
Sales aggregates
       +
Inventory aggregates
       ↓
ThriftSync Analytics
       ↓
Mobile dashboard
```

This avoids maintaining a second full product database just for reporting.

## Deployment requirements

Keep:

```env
LIVE_WRITES=true
```

because you said this application should operate live.

Also add:

```env
INTERNAL_DISCOUNT_PERCENT=99
ANALYTICS_CACHE_MINUTES=15
SHOPIFY_API_VERSION=2026-10
```

The discount environment variable only supplies the initial/default value. Once you change the setting from the dashboard, the Neon setting takes precedence.

Your Shopify app should have at least:

```text
read_products
write_products
read_inventory
write_inventory
read_orders
write_orders
read_reports
```

The dashboard now reports missing scopes for each store.

`shopifyqlQuery` officially requires `read_reports` **and Level 2 protected customer-data access**, even though ThriftSync is requesting aggregate reporting data rather than displaying individual customer records. citeturn13view0

Your `orders/create` and `orders/cancelled` webhooks should point to:

```text
https://ts-tm.onlinethriftstore.pk/api/webhooks
```

For the simplified architecture, these are the two important webhook topics:

```text
Order creation
Order cancellation
```

The existing:

```text
Product update
Inventory item update
```

webhooks aren't required by this v3 workflow.

## Important beta limitations

This build passed JavaScript syntax validation and the generated ZIP passed archive-integrity validation. I could **not complete the full Node automated test suite in this environment because package installation timed out**, so I am not claiming production verification.

There are also two deliberate limitations to understand before putting cancellation through real customer orders.

First, automatic cancellation restore works for **orders processed after this version is deployed**, because v3 needs to capture the pre-sale inventory/status snapshot.

Second, when a reseller customer order is cancelled, v3 currently restores the actual product inventory/status across the stores, but it **does not yet cancel the corresponding ThriftSync-created internal owner order**. That internal order remains tagged:

```text
Dropshipped_Order
```

so it is excluded from ThriftSync ShopifyQL analytics, but it can still remain visible in the owner's Shopify Orders screen. I have intentionally not guessed at refund/cancellation behavior in this beta.

The critical inventory behavior itself is snapshot-based:

```text
Customer Order
      ↓
Read SKU + custom.supplier
      ↓
Identify physical owner
      ↓
Capture pre-sale state
      ↓
Process normal ThriftSync sale
      ↓
Customer order later cancelled
      ↓
Read original snapshot
      ↓
Restore inventory on each linked store
      ↓
Restore previous product status
      ↓
Remove Soldby_[Store]
      ↓
Release ThriftSync claim
```

The new code also uses Shopify's supported product tag-removal mechanism during cancellation. citeturn13view2

## Build status

The package is:

**ThriftSync `3.0.0-beta.1`**

Implemented in this build:

- `orders/create`;
- `orders/cancelled`;
- pre-sale inventory snapshots;
- inventory restoration;
- product-status restoration;
- automatic `Soldby_*` tag removal on cancellation;
- configurable internal dropship discount;
- free internal shipping retained;
- ShopifyQL sales analytics;
- internal-order exclusion from analytics;
- Today / Yesterday / 7 / 30 / 90 / Custom date filters;
- Selling Store filter;
- Owner Store filter;
- Product Type filter;
- Brand filter;
- Product Type/Brand grouping;
- incremental 10,000+ product inventory aggregation;
- Neon analytics caching;
- mobile-first dashboard;
- store scope diagnostics;
- live-mode support.

[Download ThriftSync v3 Analytics + Cancellation Beta](sandbox:/mnt/data/ThriftSync-v3-Analytics-Cancellation-Beta.zip)