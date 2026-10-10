import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultDiscountPercent, analyticsCacheMinutes, requiredScopes } from '../src/config.js';
import { processOrder, processCancellation, isInternalOrder } from '../src/engine.js';
import { createSupplierOrder, removeTags, restoreProductState } from '../src/shopify.js';
import { buildShopifyQLQuery, parseShopifyQLRows, resolveDateRange, getCombinedAnalytics } from '../src/analytics.js';

const mockStores = [
  { key: 'A', name: 'ThriftMall', supplier: 'ZIA', domain: 'owner.myshopify.com', ownerEmail: 'owner@mall.com', ownerPhone: '', address: {} },
  { key: 'B', name: 'ThriftShop', supplier: 'HAMZA', domain: 'reseller.myshopify.com', ownerEmail: 'reseller@shop.com', ownerPhone: '03001234567', address: { address1: 'Shop 2', city: 'Lahore', country: 'Pakistan' } }
];

const mockVariant = (sku = 'JACKET-01', supplier = 'ZIA', id = '10', price = '5000') => ({
  id: `gid://shopify/ProductVariant/${id}`,
  sku,
  price,
  product: {
    id: `gid://shopify/Product/${id}`,
    tags: [],
    status: 'ACTIVE',
    metafield: { value: supplier },
    variants: { nodes: [{ id: `gid://shopify/ProductVariant/${id}` }] }
  },
  inventoryItem: {
    id: `gid://shopify/InventoryItem/${id}`,
    tracked: true,
    inventoryLevels: {
      nodes: [
        {
          location: { id: 'gid://shopify/Location/1' },
          quantities: [{ name: 'available', quantity: 1 }]
        }
      ],
      pageInfo: { hasNextPage: false }
    }
  }
});

const mockOrder = {
  id: 8881,
  name: '#8881',
  tags: '',
  line_items: [{ id: 1, variant_id: 10, sku: 'JACKET-01', quantity: 1 }],
  customer: { first_name: 'Bilal', last_name: 'Khan', email: 'bilal@test.com' },
  shipping_address: { address1: 'Street 5', city: 'Lahore', country: 'Pakistan' }
};

test('v3 configuration includes discount, cache, and read_reports scope', () => {
  assert.equal(defaultDiscountPercent, 99);
  assert.equal(analyticsCacheMinutes, 15);
  assert.ok(requiredScopes.includes('read_reports'));
  assert.ok(requiredScopes.includes('read_products'));
  assert.ok(requiredScopes.includes('write_products'));
});

test('configurable dropship discount creates order with custom percentage and code', async () => {
  const origFetch = global.fetch;
  const calls = [];
  global.fetch = async (url, opts) => {
    const body = JSON.parse(opts.body);
    calls.push(body);
    if (body.query.includes('currentAppInstallation')) {
      return { ok: true, status: 200, text: async () => JSON.stringify({ data: { shop: { currencyCode: 'PKR' }, currentAppInstallation: { accessScopes: [] } } }) };
    }
    return { ok: true, status: 200, text: async () => JSON.stringify({ data: { orderCreate: { order: { id: 'gid://shopify/Order/999' }, userErrors: [] } } }) };
  };

  try {
    const customDiscount = 80;
    const gid = await createSupplierOrder(
      { ...mockStores[0], token: 'shpca_mock' },
      mockStores[1],
      mockOrder,
      [{ variantId: 'gid://shopify/ProductVariant/10', quantity: 1, sku: 'JACKET-01' }],
      'TS_test123',
      customDiscount
    );

    assert.equal(gid, 'gid://shopify/Order/999');
    const orderCreateCall = calls.find(c => c.query.includes('orderCreate('));
    assert.ok(orderCreateCall);
    const orderInput = orderCreateCall.variables.order;
    assert.equal(orderInput.discountCode.itemPercentageDiscountCode.percentage, 80);
    assert.equal(orderInput.discountCode.itemPercentageDiscountCode.code, 'THRIFTSYNC_INTERNAL_80');
    assert.ok(orderInput.note.includes('Internal discount: 80%'));
    assert.ok(orderInput.tags.includes('Dropshipped_Order'));
    assert.ok(orderInput.tags.includes('TS_test123'));
  } finally {
    global.fetch = origFetch;
  }
});

test('pre-sale snapshot is saved before making Shopify modifications during order processing', async () => {
  const snapshotsSaved = [];
  const logs = [];
  const updates = [];

  const db = {
    async claimAll() {},
    async log(key, lvl, msg) { logs.push([lvl, msg]); },
    async lookupSupplierOrder() { return null; },
    async saveSupplierOrder() {},
    async saveSnapshots(snapshots) { snapshotsSaved.push(...snapshots); },
    async getSetting() { return '95'; }
  };

  const shopify = {
    async fetchSourceVariant() { return mockVariant(); },
    async findMatchingVariant(s) { return mockVariant('JACKET-01', 'ZIA', s.key === 'A' ? '10' : '20'); },
    referenceTag() { return 'TS_snap1'; },
    async findExistingSupplierOrder() { return null; },
    async createSupplierOrder() { return 'gid://shopify/Order/700'; },
    async markSold(s, v, tag) { updates.push({ store: s.key, tag }); }
  };

  const job = { job_key: 'B:8881', selling_key: 'B', payload: mockOrder };
  const res = await processOrder(job, mockStores, { db, shopify, liveWrites: true });

  assert.equal(res.processed, 1);
  assert.equal(snapshotsSaved.length, 2); // Both Store A (owner) and Store B (seller)
  assert.equal(snapshotsSaved[0].order_id, '8881');
  assert.equal(snapshotsSaved[0].previous_status, 'ACTIVE');
  assert.equal(snapshotsSaved[0].previous_quantities[0].quantity, 1);
  assert.equal(snapshotsSaved[0].sold_tag, 'Soldby_ThriftShop');
});

test('order cancellation restores product status, removes Soldby tag, restores inventory and releases claims', async () => {
  const logs = [];
  const releasedClaims = [];
  const restoredProducts = [];
  const removedTagsList = [];
  const inventorySetList = [];

  const mockSnapshots = [
    {
      id: 1,
      job_key: 'B:8881',
      order_id: '8881',
      selling_key: 'B',
      store_key: 'A',
      product_id: 'gid://shopify/Product/10',
      variant_id: 'gid://shopify/ProductVariant/10',
      sku: 'JACKET-01',
      item_key: 'A:jacket-01',
      previous_status: 'ACTIVE',
      previous_quantities: [{ locationId: 'gid://shopify/Location/1', quantity: 1 }],
      sold_tag: 'Soldby_ThriftShop'
    },
    {
      id: 2,
      job_key: 'B:8881',
      order_id: '8881',
      selling_key: 'B',
      store_key: 'B',
      product_id: 'gid://shopify/Product/20',
      variant_id: 'gid://shopify/ProductVariant/20',
      sku: 'JACKET-01',
      item_key: 'A:jacket-01',
      previous_status: 'ACTIVE',
      previous_quantities: [{ locationId: 'gid://shopify/Location/2', quantity: 1 }],
      sold_tag: 'Soldby_ThriftShop'
    }
  ];

  const db = {
    async getSnapshotsForOrder(orderId) {
      return orderId === '8881' ? mockSnapshots : [];
    },
    async releaseClaims(keys) {
      releasedClaims.push(...keys);
    },
    async log(key, lvl, msg) {
      logs.push([lvl, msg]);
    }
  };

  const origFetch = global.fetch;
  global.fetch = async (url, opts) => {
    const body = JSON.parse(opts.body);
    if (body.query.includes('productUpdate(')) {
      restoredProducts.push(body.variables.product);
      return { ok: true, status: 200, text: async () => JSON.stringify({ data: { productUpdate: { product: { status: 'ACTIVE' }, userErrors: [] } } }) };
    }
    if (body.query.includes('tagsRemove(')) {
      removedTagsList.push({ id: body.variables.id, tags: body.variables.tags });
      return { ok: true, status: 200, text: async () => JSON.stringify({ data: { tagsRemove: { node: { id: body.variables.id }, userErrors: [] } } }) };
    }
    if (body.query.includes('node(id:$id)')) {
      return { ok: true, status: 200, text: async () => JSON.stringify({ data: { node: mockVariant() } }) };
    }
    if (body.query.includes('inventorySetQuantities(')) {
      inventorySetList.push(body.variables);
      return { ok: true, status: 200, text: async () => JSON.stringify({ data: { inventorySetQuantities: { userErrors: [], inventoryAdjustmentGroup: { createdAt: '2026-10-10' } } } }) };
    }
    return { ok: true, status: 200, text: async () => JSON.stringify({ data: {} }) };
  };

  try {
    const cancelJob = { job_key: 'CANCEL:B:8881', order_id: '8881', payload: { id: 8881 } };
    const res = await processCancellation(cancelJob, mockStores, { db, shopify: await import('../src/shopify.js'), liveWrites: true });

    assert.equal(res.cancelled, true);
    assert.equal(res.restored, 2);
    assert.deepEqual(releasedClaims, ['A:jacket-01']);
    assert.equal(restoredProducts.length, 2);
    assert.equal(restoredProducts[0].status, 'ACTIVE');
    assert.equal(removedTagsList.length, 2);
    assert.deepEqual(removedTagsList[0].tags, ['Soldby_ThriftShop']);
  } finally {
    global.fetch = origFetch;
  }
});

test('historical cancellation without pre-sale snapshot safely skips without error', async () => {
  const logs = [];
  const db = {
    async getSnapshotsForOrder() { return []; },
    async log(key, lvl, msg) { logs.push([lvl, msg]); }
  };

  const cancelJob = { job_key: 'CANCEL:B:9999', order_id: '9999', payload: { id: 9999 } };
  const res = await processCancellation(cancelJob, mockStores, { db, shopify: {}, liveWrites: true });

  assert.ok(res.skipped);
  assert.ok(logs.some(l => l[1].includes('historical order')));
});

test('ShopifyQL query builder generates correct query syntax, filters dropship orders, and paginates', () => {
  const q1 = buildShopifyQLQuery({ since: '2026-09-11', until: '2026-10-10', limit: 1000, offset: 0 });
  assert.ok(q1.includes('FROM sales'));
  assert.ok(q1.includes('SHOW net_items_sold, gross_sales, total_sales'));
  assert.ok(q1.includes("WHERE order_tags NOT CONTAINS 'Dropshipped_Order'"));
  assert.ok(q1.includes('GROUP BY product.metafields.custom.supplier,'));
  assert.ok(q1.includes('product_type,'));
  assert.ok(q1.includes('product.metafields.custom.brand'));
  assert.ok(q1.includes('SINCE 2026-09-11 UNTIL 2026-10-10'));
  assert.ok(q1.includes('ORDER BY total_sales DESC'));
  assert.ok(q1.includes('LIMIT 1000 OFFSET 0'));

  const q2 = buildShopifyQLQuery({ since: '2026-10-01', until: '2026-10-10', limit: 1000, offset: 1000 });
  assert.ok(q2.includes('LIMIT 1000 OFFSET 1000'));
});

test('resolveDateRange maps date filters correctly', () => {
  const range7d = resolveDateRange('7d');
  assert.ok(range7d.since <= range7d.until);

  const custom = resolveDateRange('custom', '2026-01-01', '2026-01-31');
  assert.equal(custom.since, '2026-01-01');
  assert.equal(custom.until, '2026-01-31');
});

test('ShopifyQL row parser handles standard columns', () => {
  const columns = [
    { name: 'product.metafields.custom.supplier' },
    { name: 'product_type' },
    { name: 'product.metafields.custom.brand' },
    { name: 'net_items_sold' },
    { name: 'gross_sales' },
    { name: 'total_sales' }
  ];
  const rows = [
    ['ZIA', 'Jackets', 'Nike', 5, 25000, 24500],
    ['HAMZA', 'Shoes', 'Adidas', 2, 16000, 15800]
  ];

  const parsed = parseShopifyQLRows('A', columns, rows);
  assert.equal(parsed.length, 2);
  assert.equal(parsed[0].supplier, 'ZIA');
  assert.equal(parsed[0].product_type, 'Jackets');
  assert.equal(parsed[0].brand, 'Nike');
  assert.equal(parsed[0].net_items_sold, 5);
  assert.equal(parsed[0].total_sales, 24500);
});

test('getCombinedAnalytics calculates KPIs and sell-through percentage correctly', async () => {
  const mockDb = {
    async ensureSchema() {},
    async getCachedAnalytics() { return null; },
    async setCachedAnalytics() {},
    async getInventoryAggregates() {
      return [
        { store_key: 'A', supplier: 'ZIA', product_type: 'Jackets', brand: 'Nike', product_count: 50, available_qty: 40, retail_value: 200000 },
        { store_key: 'A', supplier: 'ZIA', product_type: 'Shirts', brand: 'Puma', product_count: 20, available_qty: 10, retail_value: 30000 }
      ];
    }
  };

  const mockShopify = {
    async queryShopifyQL(store) {
      if (store.key !== 'A') return { tableData: { columns: [], rows: [] } };
      return {
        tableData: {
          columns: [
            { name: 'product.metafields.custom.supplier' },
            { name: 'product_type' },
            { name: 'product.metafields.custom.brand' },
            { name: 'net_items_sold' },
            { name: 'gross_sales' },
            { name: 'total_sales' }
          ],
          rows: [
            ['ZIA', 'Jackets', 'Nike', 10, 50000, 50000],
            ['ZIA', 'Shirts', 'Puma', 10, 30000, 30000]
          ]
        }
      };
    }
  };

  const result = await getCombinedAnalytics(mockStores, { date: '30d', groupBy: 'product_type' }, { db: mockDb, shopify: mockShopify });

  assert.equal(result.kpi.availableNow, 50); // 40 + 10
  assert.equal(result.kpi.inventoryValue, 230000); // 200000 + 30000
  assert.equal(result.kpi.soldQty, 20); // 10 + 10
  assert.equal(result.kpi.totalSales, 80000); // 50000 + 30000
  // Sell through: 20 / (20 + 50) = 20 / 70 = 28.6%
  assert.equal(result.kpi.sellThroughFormatted, '28.6%');
  assert.equal(result.kpi.productsTracked, 70); // 50 + 20

  assert.equal(result.breakdown.length, 2);
  const jacketBreakdown = result.breakdown.find(b => b.group === 'Jackets');
  assert.ok(jacketBreakdown);
  assert.equal(jacketBreakdown.available, 40);
  assert.equal(jacketBreakdown.soldQty, 10);
  // Jackets sell through: 10 / (10 + 40) = 20.0%
  assert.equal(jacketBreakdown.sellThroughFormatted, '20.0%');
});
