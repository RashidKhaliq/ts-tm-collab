import pg from 'pg';
const { Pool } = pg;
let pool;
let initialized;

function getPool() {
  if (!pool) {
    const url = process.env.DATABASE_URL || process.env.POSTGRES_URL;
    if (!url) throw new Error('DATABASE_URL or POSTGRES_URL missing. Neon database is required for webhook deduplication.');
    pool = new Pool({ connectionString: url, max: 4, connectionTimeoutMillis: 10000, idleTimeoutMillis: 15000 });
  }
  return pool;
}

export const query = (sql, args = []) => getPool().query(sql, args);

// Each CREATE is a separate prepared statement; safe for Neon pooled URLs.
const schema = [
  `CREATE TABLE IF NOT EXISTS ts_jobs (
    job_key TEXT PRIMARY KEY, selling_key TEXT NOT NULL, order_id TEXT NOT NULL,
    order_name TEXT NOT NULL, payload JSONB NOT NULL,
    state TEXT NOT NULL DEFAULT 'PENDING', attempts INT NOT NULL DEFAULT 0,
    locked_at TIMESTAMPTZ, last_error TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now())`,
  `CREATE INDEX IF NOT EXISTS ts_jobs_pending ON ts_jobs (state, updated_at)`,
  `CREATE TABLE IF NOT EXISTS ts_claims (
    item_key TEXT PRIMARY KEY, job_key TEXT NOT NULL,
    claimed_at TIMESTAMPTZ NOT NULL DEFAULT now())`,
  `CREATE TABLE IF NOT EXISTS ts_supplier_orders (
    job_key TEXT NOT NULL, owner_key TEXT NOT NULL,
    owner_order_gid TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (job_key, owner_key))`,
  `CREATE TABLE IF NOT EXISTS ts_logs (
    id BIGSERIAL PRIMARY KEY, job_key TEXT, level TEXT NOT NULL,
    message TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now())`,
  `CREATE INDEX IF NOT EXISTS ts_logs_recent ON ts_logs (created_at DESC)`,
  `CREATE TABLE IF NOT EXISTS ts_settings (
    key TEXT PRIMARY KEY, value TEXT NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now())`,
  `CREATE TABLE IF NOT EXISTS ts_snapshots (
    id BIGSERIAL PRIMARY KEY,
    job_key TEXT NOT NULL,
    order_id TEXT NOT NULL,
    selling_key TEXT NOT NULL,
    store_key TEXT NOT NULL,
    product_id TEXT NOT NULL,
    variant_id TEXT NOT NULL,
    sku TEXT NOT NULL,
    item_key TEXT NOT NULL,
    previous_status TEXT NOT NULL DEFAULT 'ACTIVE',
    previous_quantities JSONB NOT NULL DEFAULT '[]'::jsonb,
    sold_tag TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now())`,
  `CREATE INDEX IF NOT EXISTS ts_snapshots_order ON ts_snapshots (order_id)`,
  `CREATE INDEX IF NOT EXISTS ts_snapshots_item ON ts_snapshots (item_key)`,
  `CREATE TABLE IF NOT EXISTS ts_inventory_aggregates (
    id BIGSERIAL PRIMARY KEY,
    store_key TEXT NOT NULL,
    supplier TEXT NOT NULL,
    product_type TEXT NOT NULL,
    brand TEXT NOT NULL,
    product_count INT NOT NULL DEFAULT 0,
    available_qty INT NOT NULL DEFAULT 0,
    retail_value NUMERIC(14,2) NOT NULL DEFAULT 0,
    synced_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (store_key, supplier, product_type, brand))`,
  `CREATE INDEX IF NOT EXISTS ts_inv_store ON ts_inventory_aggregates (store_key)`,
  `CREATE INDEX IF NOT EXISTS ts_inv_supplier ON ts_inventory_aggregates (supplier)`,
  `CREATE INDEX IF NOT EXISTS ts_inv_type ON ts_inventory_aggregates (product_type)`,
  `CREATE INDEX IF NOT EXISTS ts_inv_brand ON ts_inventory_aggregates (brand)`,
  `CREATE TABLE IF NOT EXISTS ts_analytics_cache (
    cache_key TEXT PRIMARY KEY,
    data JSONB NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now())`
];

export function ensureSchema() {
  if (!initialized) initialized = (async () => {
    for (const sql of schema) await query(sql);
  })().catch(err => { initialized = null; throw err; });
  return initialized;
}

export async function log(jobKey, level, message) {
  await query(`INSERT INTO ts_logs (job_key,level,message) VALUES ($1,$2,$3)`, [jobKey || null,level,String(message).slice(0,1800)]);
}

export async function enqueue(storeKey, order, topic = 'orders/create') {
  const isCancel = topic === 'orders/cancelled';
  const key = isCancel ? `CANCEL:${storeKey}:${String(order.id)}` : `${storeKey}:${String(order.id)}`;
  const prefix = isCancel ? '[CANCEL] ' : '';
  const orderName = prefix + String(order.name || order.order_number || order.id);
  await query(`INSERT INTO ts_jobs(job_key,selling_key,order_id,order_name,payload)
    VALUES($1,$2,$3,$4,$5::jsonb) ON CONFLICT DO NOTHING`,
    [key,storeKey,String(order.id),orderName,JSON.stringify(order)]);
  return key;
}

export async function takeJob() {
  const r = await query(`UPDATE ts_jobs SET state='PROCESSING', attempts=attempts+1,
    locked_at=now(), updated_at=now() WHERE job_key = (
    SELECT job_key FROM ts_jobs WHERE state='PENDING'
      OR (state='PROCESSING' AND locked_at < now()-interval '3 minutes')
    ORDER BY created_at ASC LIMIT 1 FOR UPDATE SKIP LOCKED)
    RETURNING *`);
  return r.rows[0];
}

export async function finishJob(jobKey, state, error = null) {
  await query(`UPDATE ts_jobs SET state=$2,last_error=$3,locked_at=NULL,updated_at=now() WHERE job_key=$1`,
    [jobKey,state,error?.slice(0,1600) || null]);
}

export async function claim(itemKey, jobKey) {
  const r = await query(`INSERT INTO ts_claims(item_key,job_key) VALUES($1,$2)
    ON CONFLICT DO NOTHING RETURNING job_key`, [itemKey,jobKey]);
  if (r.rowCount) return;
  const old = await query(`SELECT job_key FROM ts_claims WHERE item_key=$1`,[itemKey]);
  if (old.rows[0]?.job_key !== jobKey) throw new Error(`CONFLICT: ${itemKey} already sold via another order ${old.rows[0]?.job_key}`);
}

export async function claimAll(itemKeys, jobKey) {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    for (const itemKey of [...new Set(itemKeys)]) {
      const inserted = await client.query(`INSERT INTO ts_claims(item_key,job_key) VALUES($1,$2) ON CONFLICT DO NOTHING RETURNING job_key`,[itemKey,jobKey]);
      if (!inserted.rowCount) {
        const old = await client.query(`SELECT job_key FROM ts_claims WHERE item_key=$1`,[itemKey]);
        if (old.rows[0]?.job_key !== jobKey) throw new Error(`CONFLICT: ${itemKey} claimed by ${old.rows[0]?.job_key}; both checkouts may already exist`);
      }
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export async function releaseClaims(itemKeys) {
  if (!itemKeys || !itemKeys.length) return;
  const uniqueKeys = [...new Set(itemKeys)];
  await query(`DELETE FROM ts_claims WHERE item_key = ANY($1::text[])`, [uniqueKeys]);
}

export async function saveSnapshots(snapshots) {
  if (!snapshots || !snapshots.length) return;
  for (const s of snapshots) {
    await query(`INSERT INTO ts_snapshots (job_key, order_id, selling_key, store_key, product_id, variant_id, sku, item_key, previous_status, previous_quantities, sold_tag)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11)`,
      [s.job_key, String(s.order_id), s.selling_key, s.store_key, s.product_id, s.variant_id, s.sku, s.item_key, s.previous_status || 'ACTIVE', JSON.stringify(s.previous_quantities || []), s.sold_tag]);
  }
}

export async function getSnapshotsForOrder(orderId) {
  const r = await query(`SELECT * FROM ts_snapshots WHERE order_id = $1 ORDER BY id ASC`, [String(orderId)]);
  return r.rows;
}

export async function lookupSupplierOrder(jobKey, ownerKey) {
  return (await query(`SELECT owner_order_gid FROM ts_supplier_orders WHERE job_key=$1 AND owner_key=$2`, [jobKey,ownerKey])).rows[0]?.owner_order_gid;
}

export async function saveSupplierOrder(jobKey, ownerKey, gid) {
  await query(`INSERT INTO ts_supplier_orders(job_key,owner_key,owner_order_gid) VALUES($1,$2,$3) ON CONFLICT DO NOTHING`, [jobKey,ownerKey,gid]);
}

export async function getSetting(key, defaultValue = null) {
  try {
    const r = await query(`SELECT value FROM ts_settings WHERE key = $1`, [key]);
    return r.rows[0]?.value ?? defaultValue;
  } catch {
    return defaultValue;
  }
}

export async function setSetting(key, value) {
  await query(`INSERT INTO ts_settings (key, value, updated_at) VALUES ($1, $2, now())
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`, [key, String(value)]);
  return value;
}

export async function saveInventoryAggregates(storeKey, rows) {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    await client.query(`DELETE FROM ts_inventory_aggregates WHERE store_key = $1`, [storeKey]);
    for (const r of rows) {
      await client.query(`INSERT INTO ts_inventory_aggregates (store_key, supplier, product_type, brand, product_count, available_qty, retail_value, synced_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, now())`,
        [storeKey, r.supplier || '', r.product_type || 'Uncategorized', r.brand || 'Unbranded', Number(r.product_count) || 0, Number(r.available_qty) || 0, Number(r.retail_value) || 0]);
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export async function getInventoryAggregates(filters = {}) {
  let sql = `SELECT store_key, supplier, product_type, brand, product_count, available_qty, retail_value, synced_at FROM ts_inventory_aggregates WHERE 1=1`;
  const params = [];
  if (filters.storeKey && filters.storeKey !== 'ALL') {
    params.push(filters.storeKey);
    sql += ` AND store_key = $${params.length}`;
  }
  if (filters.supplier && filters.supplier !== 'ALL') {
    params.push(filters.supplier);
    sql += ` AND supplier = $${params.length}`;
  }
  if (filters.productType && filters.productType !== 'ALL') {
    params.push(filters.productType);
    sql += ` AND product_type = $${params.length}`;
  }
  if (filters.brand && filters.brand !== 'ALL') {
    params.push(filters.brand);
    sql += ` AND brand = $${params.length}`;
  }
  const r = await query(sql, params);
  return r.rows;
}

export async function getInventoryFilterOptions() {
  const [types, brands, suppliers, stores] = await Promise.all([
    query(`SELECT DISTINCT product_type FROM ts_inventory_aggregates WHERE product_type <> '' ORDER BY product_type`),
    query(`SELECT DISTINCT brand FROM ts_inventory_aggregates WHERE brand <> '' ORDER BY brand`),
    query(`SELECT DISTINCT supplier FROM ts_inventory_aggregates WHERE supplier <> '' ORDER BY supplier`),
    query(`SELECT DISTINCT store_key FROM ts_inventory_aggregates ORDER BY store_key`)
  ]);
  return {
    productTypes: types.rows.map(r => r.product_type),
    brands: brands.rows.map(r => r.brand),
    suppliers: suppliers.rows.map(r => r.supplier),
    stores: stores.rows.map(r => r.store_key)
  };
}

export async function getInventorySyncStatus() {
  const r = await query(`SELECT COUNT(*)::int as rows_count,
    COALESCE(SUM(product_count), 0)::int as total_products,
    COALESCE(SUM(available_qty), 0)::int as total_qty,
    COALESCE(SUM(retail_value), 0)::numeric as total_retail_value,
    MAX(synced_at) as last_synced_at
    FROM ts_inventory_aggregates`);
  return r.rows[0];
}

export async function getCachedAnalytics(cacheKey) {
  try {
    const r = await query(`SELECT data FROM ts_analytics_cache WHERE cache_key = $1 AND expires_at > now()`, [cacheKey]);
    return r.rows[0]?.data || null;
  } catch {
    return null;
  }
}

export async function setCachedAnalytics(cacheKey, data, ttlMinutes = 15) {
  try {
    await query(`INSERT INTO ts_analytics_cache (cache_key, data, expires_at, created_at)
      VALUES ($1, $2::jsonb, now() + ($3 || ' minutes')::interval, now())
      ON CONFLICT (cache_key) DO UPDATE SET data = EXCLUDED.data, expires_at = EXCLUDED.expires_at, created_at = now()`,
      [cacheKey, JSON.stringify(data), String(ttlMinutes)]);
  } catch (err) {
    console.error('Failed to set analytics cache:', err.message);
  }
}

export async function recent() {
  const [j,l] = await Promise.all([
    query(`SELECT job_key,selling_key,order_name,state,attempts,last_error,created_at,updated_at FROM ts_jobs ORDER BY created_at DESC LIMIT 40`),
    query(`SELECT job_key,level,message,created_at FROM ts_logs ORDER BY id DESC LIMIT 60`)
  ]);
  return { jobs:j.rows, logs:l.rows };
}

export async function retryFailed() {
  const r = await query(`UPDATE ts_jobs SET state='PENDING',last_error=NULL,updated_at=now() WHERE state='ERROR' RETURNING job_key`);
  return r.rowCount;
}
