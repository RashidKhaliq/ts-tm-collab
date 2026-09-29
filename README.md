# Shopify Multi-Store Inventory & Dropship Sync Engine

A production-ready solution for **automated B2B dropshipping fulfillment** and **real-time multi-store inventory synchronization** across independent Shopify stores. 

Built with **Next.js 14 App Router**, **TypeScript**, **Prisma ORM**, **Shopify GraphQL & REST Admin APIs**, and an **Express standalone script runner**.

---

## 💡 Why & When to Use This App

### The Problem
When operating multiple Shopify stores (e.g. a brand store and reseller/partner stores):
- Retailers (Store B) sell products supplied by an owner store (Store A).
- Manual order placement on supplier stores leads to fulfillment delays, human error, and missing tracking information.
- Inventory is disconnected: when Store B sells 1 unit of Store A's item, other connected stores don't know, leading to **overselling and stockouts**.

### The Solution
This application automates the entire cross-store dropshipping and inventory sync workflow in real time:
1. **Detects product ownership** via structured product metafields (`custom.supplier`) or tags (`Supplier: Name`).
2. **Automates B2B order creation** on the supplier store when a reseller sells their product.
3. **Synchronizes inventory instantly** across **all connected stores** (> 2 stores) whenever any item is sold or updated.
4. **Maintains a 100% complete Order Sync History audit trail** for every single sync attempt (SUCCESS, FAILED, SKIPPED, SELF_SALE).

---

## 🛠 Core Functionality & Scenarios

### 1. Product Ownership Identification
Product ownership is assigned using either:
- **Shopify Product Metafield (Primary & Preferred)**:
  ```
  custom.supplier = "Sharry"
  ```
  *Structured, precise, and less likely to mix with normal product tags.*
- **Product Tag (Secondary / Fallback)**:
  ```
  Supplier: Sharry
  ```
  *Case-insensitive matching (e.g. `Supplier: Sharry`, `supplier: sharry`).*

If Store A (Sharry Store (OTS)) has the supplier identifier `Sharry`, any product tagged with `custom.supplier = "Sharry"` or `Supplier: Sharry` is recognized as belonging to Store A.

---

### 2. Scenario 1: Store B sells Store A's product (Cross-Store Dropshipping)
When **Store B** (Reseller) sells a product owned by **Store A** (Supplier):

1. **Ownership Detection**: The app identifies that the sold SKU belongs to Store A based on `custom.supplier` or `Supplier: Sharry`.
2. **B2B Order Creation on Store A**:
   - The order is created on Store A under **Store B's owner/store name and email** (`retailerStore.name`, `retailerStore.ownerEmail`), representing a wholesale/B2B transaction placed by Store B with a **70% discount on each product**.
   - **Order Comments / Notes**: Includes Store B's original order number and specifies that it is a dropshipping order with 70% discount:
     ```
     Dropshipping order placed by Hamza Store (Vougewing) (hamzastore.myshopify.com) for original order #1001. 70% discount applied on each product.
     ```
   - **Shopify Sales Channel / Source**: Set to `"Dropshipping"`.
   - **Order Tags**: Added `Automated Dropship`, `Dropshipping`, `Soldby-Hamza`, `70% Discount Applied`.
3. **Multi-Store Inventory Sync (> 2 Stores)**:
   - If connected stores are more than 2 (3 or more stores connected), the app immediately deducts/syncs the updated available product inventory across **all connected stores**, ensuring the sold product cannot remain available in other stores.
4. **Order Sync Audit Log**:
   - Recorded in **Order Sync History** as `SUCCESS` with details of source order `#1001` and created supplier order `#1002`.

---

### 3. Scenario 2: Store A sells its own product (Self-Sale)
When **Store A** sells a product that Store A owns:

1. **Ownership Detection**: The app identifies Store A as the product owner (`custom.supplier = "Sharry"` matches Store A).
2. **No Dropshipping Order**: Since Store A is selling its own product, no B2B dropshipping order is created on another store.
3. **Inventory Sync Across All Other Stores**:
   - The sold quantity is deducted and synchronized across **all other connected stores** (Store B, Store C, etc.).
4. **Order Tag & Recording**:
   - Tagged `Soldby-Sharry` (Store A's name/identifier).
   - Logged in **Order Sync History** as `SUCCESS` (Self Sale) with full SKU details.

---

### 4. Comprehensive Order Sync History
**Every single order sync attempt** is captured in the dashboard Order Sync History tab:
- **`SUCCESS`**: B2B dropshipping order created or self-sale inventory synced successfully.
- **`FAILED`**: Detailed error message (e.g. SKU missing on supplier store or missing access token).
- **`SKIPPED`**: Logged when no dropship SKUs or supplier rules matched.

#### Persistence Layer
- **PostgreSQL / Supabase**: Saved via Prisma ORM when `DATABASE_URL` is set.
- **Local Persistent JSON Storage**: Automatic fallback to `.data/order_sync_db.json` when running locally or in serverless environments, guaranteeing zero loss of history across server restarts or cold starts.

---

## 📋 Requirements & Prerequisites

1. **Node.js**: `v18.x` or higher.
2. **Shopify Admin Access**:
   - Access to connected stores' Shopify Admin.
   - Admin API Access Tokens (`shpat_...`).
   - Required Shopify API Scopes:
     ```
     read_products, write_products, read_orders, write_orders, read_inventory, write_inventory
     ```

---

## 🚀 Setup & Execution Guide

### Option A: Next.js App Router & Web Dashboard (Recommended)

1. **Clone & Install Dependencies**:
   ```bash
   git clone https://github.com/RashidKhaliq/shopi-inventory-collab.git
   cd shopi-inventory-collab
   npm install
   ```

2. **Configure Environment Variables (`.env`)**:
   Create a `.env` file in the root directory:
   ```env
   # PostgreSQL Database (Optional - persistent JSON fallback used if omitted)
   DATABASE_URL="postgresql://postgres:PASSWORD@db.xxxx.supabase.co:5432/postgres"

   # Store A Configuration (Production)
   STORE_A_NAME="Thrift Shop"
   STORE_A_URL="store-a.myshopify.com"
   STORE_A_ACCESS_TOKEN="shpat_xxxxxxxxxxxxxxxx"
   STORE_A_OWNER_EMAIL="owner-a@example.com"
   STORE_A_SUPPLIER_NAME="ZIA"
   STORE_A_SOLDBY_TAG="Soldby-ZIA"
   STORE_A_WEBHOOK_SECRET="shpss_aaaaaaaaaaaaaaaa"

   # Store B Configuration (Production)
   STORE_B_NAME="Thrift Mall"
   STORE_B_URL="store-b.myshopify.com"
   STORE_B_ACCESS_TOKEN="shpat_yyyyyyyyyyyyyyyy"
   STORE_B_OWNER_EMAIL="owner-b@example.com"
   STORE_B_SUPPLIER_NAME="SALAM"
   STORE_B_SOLDBY_TAG="Soldby-SALAM"
   STORE_B_WEBHOOK_SECRET="shpss_bbbbbbbbbbbbbbbb"
   ```

3. **Initialize Database (Optional)**:
   ```bash
   npx prisma generate
   npx prisma db push
   ```

4. **Run Development Server**:
   ```bash
   npm run dev
   ```
   Open `http://localhost:3000` in your browser.

5. **Deploy to Vercel**:
   ```bash
   git push origin main
   ```
   Import into Vercel, configure your `.env` variables under **Project Settings > Environment Variables**, and deploy!

---

### Option B: Express Standalone Script Runner

If you prefer running a single Node.js Express process:

```bash
node index.js
```
The server will start on port `8000` (or `process.env.PORT`).

---

## ⚡ Webhook Registration

Register the serverless webhook URL in each connected store's Shopify Admin (**Settings > Notifications > Webhooks**):

- **Webhook URL**: `https://your-app.vercel.app/api/webhooks/shopify`
- **Events to Subscribe (Format: JSON)**:
  - `orders/create` (Triggers B2B dropshipping fulfillment & inventory sync)
  - `inventory_levels/update` (Triggers real-time SKU inventory level sync)
  - `orders/fulfilled` (Fulfillment status & tracking sync)

---

## 🧪 SKU Simulator & Diagnostics

Use the built-in **🧪 SKU Simulator** on the admin dashboard to test SKU matching and B2B order creation without placing live orders:
1. Select **Source Selling Store** and **Target Supplier Store**.
2. Enter product **SKU** (e.g. `jacket-001`).
3. Click **Execute Test Sync**. The trace log will report whether the variant was matched, inventory items retrieved, and B2B order created.

To verify system connection status and API keys, visit:
```
GET /api/verify-env
```

---

## 📁 Repository Structure

```
├── app/
│   ├── api/
│   │   ├── logs/             # Live log stream endpoint
│   │   ├── orders/           # Order sync history & manual today's sync API
│   │   ├── status/           # System connection status API
│   │   ├── stores/           # Connected stores management API
│   │   ├── test-sync/        # SKU simulator endpoint
│   │   └── webhooks/shopify/ # Core Shopify webhook receiver
│   ├── globals.css
│   ├── layout.tsx
│   └── page.tsx              # Vercel Geist Admin Dashboard UI
├── lib/
│   ├── db.ts                 # Database singleton with JSON file persistence fallback
│   └── shopify.ts            # Shopify Admin GraphQL & REST engine
├── prisma/
│   └── schema.prisma         # Prisma ORM PostgreSQL schema
├── index.js                  # Standalone Express script runner
├── package.json
└── README.md
```

---

## 🛡 License & Support

Maintained for multi-store Shopify collaborations. For questions or setup assistance, consult the diagnostic logs on the Admin Dashboard.
