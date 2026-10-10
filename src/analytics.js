import { analyticsCacheMinutes, norm } from './config.js';
import * as db from './db.js';
import * as shopify from './shopify.js';

export function resolveDateRange(filter = '30d', customStart = null, customEnd = null) {
  const now = new Date();
  const format = d => d.toISOString().slice(0, 10);
  const end = customEnd ? customEnd : format(now);

  if (filter === 'custom' && customStart) {
    return { since: customStart, until: end };
  }

  const d = new Date(now);
  switch (filter) {
    case 'today':
      return { since: format(d), until: format(d) };
    case 'yesterday': {
      d.setDate(d.getDate() - 1);
      const y = format(d);
      return { since: y, until: y };
    }
    case '7d':
    case 'last_7_days': {
      d.setDate(d.getDate() - 7);
      return { since: format(d), until: format(now) };
    }
    case '90d':
    case 'last_90_days': {
      d.setDate(d.getDate() - 90);
      return { since: format(d), until: format(now) };
    }
    case '30d':
    case 'last_30_days':
    default: {
      d.setDate(d.getDate() - 30);
      return { since: format(d), until: format(now) };
    }
  }
}

export function buildShopifyQLQuery({ since, until, limit = 1000, offset = 0 }) {
  return [
    'FROM sales',
    'SHOW net_items_sold, gross_sales, total_sales',
    "WHERE order_tags NOT CONTAINS 'Dropshipped_Order'",
    'GROUP BY product.metafields.custom.supplier,',
    '  product_type,',
    '  product.metafields.custom.brand',
    `SINCE ${since} UNTIL ${until}`,
    'ORDER BY total_sales DESC',
    `LIMIT ${limit} OFFSET ${offset}`
  ].join('\n');
}

export async function fetchStoreSalesShopifyQL(store, { since, until, maxPages = 10 }, deps = { shopify }) {
  const allRows = [];
  let warnings = [];
  let columns = [];

  for (let page = 0; page < maxPages; page++) {
    const offset = page * 1000;
    const q = buildShopifyQLQuery({ since, until, limit: 1000, offset });
    try {
      const result = await deps.shopify.queryShopifyQL(store, q);
      if (result?.parseErrors?.length) {
        warnings.push({
          store: store.key,
          errors: result.parseErrors.map(e => e.message || e.code)
        });
        break;
      }
      const table = result?.tableData;
      if (!table || !Array.isArray(table.rows)) break;
      if (!columns.length && table.columns) columns = table.columns;
      allRows.push(...table.rows);
      if (table.rows.length < 1000) break;
    } catch (err) {
      warnings.push({ store: store.key, error: err.message });
      break;
    }
  }

  return { store: store.key, columns, rows: allRows, warnings };
}

export function parseShopifyQLRows(storeKey, columns, rawRows) {
  if (!rawRows || !rawRows.length) return [];
  const colNames = (columns || []).map(c => String(c.name || '').toLowerCase());

  const findIdx = patterns => colNames.findIndex(c => patterns.some(p => c.includes(p)));

  const supplierIdx = findIdx(['supplier', 'custom.supplier']);
  const productTypeIdx = findIdx(['product_type', 'type']);
  const brandIdx = findIdx(['brand', 'custom.brand']);
  const netSoldIdx = findIdx(['net_items_sold', 'items_sold']);
  const grossSalesIdx = findIdx(['gross_sales']);
  const totalSalesIdx = findIdx(['total_sales']);

  return rawRows.map(row => {
    return {
      store_key: storeKey,
      supplier: supplierIdx >= 0 ? String(row[supplierIdx] ?? '').trim() : '',
      product_type: productTypeIdx >= 0 ? String(row[productTypeIdx] ?? '').trim() || 'Uncategorized' : 'Uncategorized',
      brand: brandIdx >= 0 ? String(row[brandIdx] ?? '').trim() || 'Unbranded' : 'Unbranded',
      net_items_sold: netSoldIdx >= 0 ? Number(row[netSoldIdx]) || 0 : 0,
      gross_sales: grossSalesIdx >= 0 ? Number(row[grossSalesIdx]) || 0 : 0,
      total_sales: totalSalesIdx >= 0 ? Number(row[totalSalesIdx]) || 0 : 0
    };
  });
}

export async function syncStoreInventory(store, deps = { shopify, db }) {
  const aggregates = new Map();
  let cursor = null;
  let totalProductsCount = 0;
  const maxPages = 500; // supports up to 25,000 products

  for (let p = 0; p < maxPages; p++) {
    const catalog = await deps.shopify.fetchCatalogPage(store, cursor, 50);
    if (!catalog || !catalog.nodes) break;

    for (const product of catalog.nodes) {
      totalProductsCount++;
      const supplier = String(product.supplier?.value || store.supplier || '').trim();
      const productType = String(product.productType || '').trim() || 'Uncategorized';
      const brand = String(product.brand?.value || product.vendor || '').trim() || 'Unbranded';
      const key = `${supplier}||${productType}||${brand}`;

      if (!aggregates.has(key)) {
        aggregates.set(key, {
          supplier,
          product_type: productType,
          brand,
          product_count: 0,
          available_qty: 0,
          retail_value: 0
        });
      }
      const agg = aggregates.get(key);
      agg.product_count += 1;

      for (const v of product.variants?.nodes || []) {
        const price = Number(v.price) || 0;
        const avail = (v.inventoryItem?.inventoryLevels?.nodes || []).reduce((sum, lvl) => {
          const q = lvl.quantities?.find(item => item.name === 'available')?.quantity ?? 0;
          return sum + (Number(q) || 0);
        }, 0);
        agg.available_qty += avail;
        agg.retail_value += (avail * price);
      }
    }

    if (!catalog.pageInfo?.hasNextPage) break;
    cursor = catalog.pageInfo.endCursor;
  }

  const rows = Array.from(aggregates.values());
  await deps.db.saveInventoryAggregates(store.key, rows);

  return {
    store: store.key,
    productsProcessed: totalProductsCount,
    distinctAggregates: rows.length
  };
}

export async function syncAllStoresInventory(stores, deps = { shopify, db }) {
  await deps.db.ensureSchema();
  const results = [];
  for (const store of stores) {
    try {
      const res = await syncStoreInventory(store, deps);
      results.push({ store: store.key, ok: true, ...res });
    } catch (err) {
      results.push({ store: store.key, ok: false, error: err.message });
    }
  }
  return results;
}

export async function getCombinedAnalytics(stores, filters = {}, deps = { shopify, db }) {
  await deps.db.ensureSchema();

  const dateFilter = filters.date || '30d';
  const customStart = filters.startDate || null;
  const customEnd = filters.endDate || null;
  const sellingStore = filters.sellingStore || 'ALL';
  const ownerStore = filters.ownerStore || 'ALL';
  const productType = filters.productType || 'ALL';
  const brand = filters.brand || 'ALL';
  const groupBy = filters.groupBy === 'brand' ? 'brand' : 'product_type';
  const forceRefresh = Boolean(filters.refresh);

  const { since, until } = resolveDateRange(dateFilter, customStart, customEnd);

  const cacheKey = `analytics:${dateFilter}:${since}:${until}:${sellingStore}:${ownerStore}:${productType}:${brand}:${groupBy}`;

  if (!forceRefresh && deps.db.getCachedAnalytics) {
    const cached = await deps.db.getCachedAnalytics(cacheKey);
    if (cached) return { ...cached, cached: true };
  }

  // 1. Fetch Sales data via ShopifyQL
  let storesToQuery = stores;
  if (sellingStore !== 'ALL') {
    storesToQuery = stores.filter(s => s.key === sellingStore);
  }

  const salesRows = [];
  const warnings = [];

  for (const store of storesToQuery) {
    const salesData = await fetchStoreSalesShopifyQL(store, { since, until }, deps);
    if (salesData.warnings?.length) warnings.push(...salesData.warnings);
    const parsed = parseShopifyQLRows(store.key, salesData.columns, salesData.rows);
    salesRows.push(...parsed);
  }

  // 2. Fetch Inventory Aggregates from DB
  const invFilters = {};
  if (ownerStore !== 'ALL') {
    const owner = stores.find(s => s.key === ownerStore);
    if (owner?.supplier) invFilters.supplier = owner.supplier;
  }
  if (productType !== 'ALL') invFilters.productType = productType;
  if (brand !== 'ALL') invFilters.brand = brand;

  const inventoryRows = await deps.db.getInventoryAggregates(invFilters);

  // 3. Filter Sales rows by owner/productType/brand if specified
  const filteredSales = salesRows.filter(row => {
    if (ownerStore !== 'ALL') {
      const owner = stores.find(s => s.key === ownerStore);
      if (owner && norm(row.supplier) !== norm(owner.supplier)) return false;
    }
    if (productType !== 'ALL' && norm(row.product_type) !== norm(productType)) return false;
    if (brand !== 'ALL' && norm(row.brand) !== norm(brand)) return false;
    return true;
  });

  // 4. Combine and Group
  const groupMap = new Map();

  const getGroupVal = item => {
    if (groupBy === 'brand') return item.brand || 'Unbranded';
    return item.product_type || 'Uncategorized';
  };

  // Populate from inventory
  for (const inv of inventoryRows) {
    const gKey = getGroupVal(inv);
    if (!groupMap.has(gKey)) {
      groupMap.set(gKey, {
        groupKey: gKey,
        available: 0,
        inventory_value: 0,
        sold_qty: 0,
        gross_sales: 0,
        total_sales: 0,
        products_tracked: 0
      });
    }
    const g = groupMap.get(gKey);
    g.available += Number(inv.available_qty) || 0;
    g.inventory_value += Number(inv.retail_value) || 0;
    g.products_tracked += Number(inv.product_count) || 0;
  }

  // Populate from sales
  for (const sale of filteredSales) {
    const gKey = getGroupVal(sale);
    if (!groupMap.has(gKey)) {
      groupMap.set(gKey, {
        groupKey: gKey,
        available: 0,
        inventory_value: 0,
        sold_qty: 0,
        gross_sales: 0,
        total_sales: 0,
        products_tracked: 0
      });
    }
    const g = groupMap.get(gKey);
    g.sold_qty += Number(sale.net_items_sold) || 0;
    g.gross_sales += Number(sale.gross_sales) || 0;
    g.total_sales += Number(sale.total_sales) || 0;
  }

  // Calculate sell-through and format breakdown table
  const breakdown = Array.from(groupMap.values()).map(item => {
    const totalPotential = item.sold_qty + item.available;
    const sellThrough = totalPotential > 0 ? (item.sold_qty / totalPotential) * 100 : 0;
    return {
      group: item.groupKey,
      available: item.available,
      inventoryValue: Math.round(item.inventory_value * 100) / 100,
      soldQty: item.sold_qty,
      grossSales: Math.round(item.gross_sales * 100) / 100,
      totalSales: Math.round(item.total_sales * 100) / 100,
      sellThroughPercent: Math.round(sellThrough * 10) / 10,
      sellThroughFormatted: (Math.round(sellThrough * 10) / 10).toFixed(1) + '%',
      productsTracked: item.products_tracked
    };
  }).sort((a, b) => b.totalSales - a.totalSales || b.available - a.available);

  // Overall KPIs
  const totalAvailable = breakdown.reduce((sum, b) => sum + b.available, 0);
  const totalInventoryValue = breakdown.reduce((sum, b) => sum + b.inventoryValue, 0);
  const totalSold = breakdown.reduce((sum, b) => sum + b.soldQty, 0);
  const totalGross = breakdown.reduce((sum, b) => sum + b.grossSales, 0);
  const totalSales = breakdown.reduce((sum, b) => sum + b.totalSales, 0);
  const totalProducts = breakdown.reduce((sum, b) => sum + b.productsTracked, 0);

  const overallSellThrough = (totalSold + totalAvailable) > 0
    ? (totalSold / (totalSold + totalAvailable)) * 100
    : 0;

  const result = {
    cached: false,
    filters: {
      date: dateFilter,
      since,
      until,
      sellingStore,
      ownerStore,
      productType,
      brand,
      groupBy
    },
    kpi: {
      availableNow: totalAvailable,
      inventoryValue: Math.round(totalInventoryValue * 100) / 100,
      soldQty: totalSold,
      grossSales: Math.round(totalGross * 100) / 100,
      totalSales: Math.round(totalSales * 100) / 100,
      sellThroughPercent: Math.round(overallSellThrough * 10) / 10,
      sellThroughFormatted: (Math.round(overallSellThrough * 10) / 10).toFixed(1) + '%',
      productsTracked: totalProducts
    },
    breakdown,
    warnings
  };

  if (deps.db.setCachedAnalytics) {
    await deps.db.setCachedAnalytics(cacheKey, result, analyticsCacheMinutes);
  }

  return result;
}
