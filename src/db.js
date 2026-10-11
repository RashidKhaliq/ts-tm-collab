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
  `CREATE INDEX IF NOT EXISTS ts_logs_recent ON ts_logs (created_at DESC)`
  ,`CREATE TABLE IF NOT EXISTS sb_snapshots (
    job_key TEXT NOT NULL, item_key TEXT NOT NULL, store_key TEXT NOT NULL,
    snapshot JSONB NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY(job_key,item_key,store_key))`
  ,`CREATE TABLE IF NOT EXISTS sb_cancellations (
    job_key TEXT PRIMARY KEY, state TEXT NOT NULL DEFAULT 'PENDING',
    attempts INT NOT NULL DEFAULT 0, locked_at TIMESTAMPTZ,
    last_error TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now())`
  ,`CREATE TABLE IF NOT EXISTS sb_settings (
    key TEXT PRIMARY KEY, value JSONB NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT now())`
  ,`CREATE TABLE IF NOT EXISTS sb_sales (
    store_key TEXT NOT NULL, order_id TEXT NOT NULL, line_id TEXT NOT NULL,
    order_date TIMESTAMPTZ NOT NULL, sku TEXT NOT NULL DEFAULT '',
    supplier TEXT, owner_key TEXT, brand TEXT, product_type TEXT,
    quantity INT NOT NULL DEFAULT 0, gross_value NUMERIC(18,2) NOT NULL DEFAULT 0,
    currency TEXT NOT NULL DEFAULT 'PKR', cancelled BOOLEAN NOT NULL DEFAULT false,
    is_internal BOOLEAN NOT NULL DEFAULT false,
    PRIMARY KEY(store_key,order_id,line_id))`
  ,`CREATE INDEX IF NOT EXISTS sb_sales_date ON sb_sales (order_date,store_key,owner_key)`
  ,`CREATE TABLE IF NOT EXISTS sb_inventory (
    store_key TEXT NOT NULL, variant_id TEXT NOT NULL,
    sku TEXT NOT NULL DEFAULT '', supplier TEXT, owner_key TEXT, brand TEXT,
    product_type TEXT, quantity INT NOT NULL DEFAULT 0,
    price NUMERIC(18,2) NOT NULL DEFAULT 0, currency TEXT NOT NULL DEFAULT 'PKR',
    status TEXT NOT NULL DEFAULT 'ACTIVE', synced_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY(store_key,variant_id))`
  ,`CREATE INDEX IF NOT EXISTS sb_inventory_identity ON sb_inventory (supplier,sku,owner_key)`
  ,`CREATE TABLE IF NOT EXISTS sb_sync (
    store_key TEXT PRIMARY KEY, cursor TEXT, synced_at TIMESTAMPTZ,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now())`
  ,`CREATE TABLE IF NOT EXISTS sb_report_cache (
    cache_key TEXT PRIMARY KEY, result JSONB NOT NULL,
    fetched_at TIMESTAMPTZ NOT NULL DEFAULT now())`

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
export async function enqueue(storeKey, order) {
  const key = `${storeKey}:${String(order.id)}`;
  await query(`INSERT INTO ts_jobs(job_key,selling_key,order_id,order_name,payload)
    VALUES($1,$2,$3,$4,$5::jsonb) ON CONFLICT DO NOTHING`,
    [key,storeKey,String(order.id),String(order.name || order.order_number || order.id),JSON.stringify(order)]);
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
export async function lookupSupplierOrder(jobKey, ownerKey) {
  return (await query(`SELECT owner_order_gid FROM ts_supplier_orders WHERE job_key=$1 AND owner_key=$2`, [jobKey,ownerKey])).rows[0]?.owner_order_gid;
}
export async function saveSupplierOrder(jobKey, ownerKey, gid) {
  await query(`INSERT INTO ts_supplier_orders(job_key,owner_key,owner_order_gid) VALUES($1,$2,$3) ON CONFLICT DO NOTHING`, [jobKey,ownerKey,gid]);
}
export async function recent() {
  const [j,l] = await Promise.all([
    query(`SELECT job_key,selling_key,order_name,state,attempts,last_error,created_at,updated_at FROM ts_jobs ORDER BY created_at DESC LIMIT 40`),
    query(`SELECT job_key,level,message,created_at FROM ts_logs ORDER BY id DESC LIMIT 60`)
  ]);
  return { jobs:j.rows, logs:l.rows };
}
export async function retryFailed() {
  const r=await query(`UPDATE ts_jobs SET state='PENDING',last_error=NULL,updated_at=now() WHERE state='ERROR' RETURNING job_key`);
  return r.rowCount;
}
export async function claimAll(itemKeys, jobKey) {
  const client=await getPool().connect();
  try {
    await client.query('BEGIN');
    for (const itemKey of [...new Set(itemKeys)]) {
      const inserted=await client.query(`INSERT INTO ts_claims(item_key,job_key) VALUES($1,$2) ON CONFLICT DO NOTHING RETURNING job_key`,[itemKey,jobKey]);
      if (!inserted.rowCount) {
        const old=await client.query(`SELECT job_key FROM ts_claims WHERE item_key=$1`,[itemKey]);
        if (old.rows[0]?.job_key!==jobKey) throw new Error(`CONFLICT: ${itemKey} claimed by ${old.rows[0]?.job_key}; both checkouts may already exist`);
      }
    }
    await client.query('COMMIT');
  } catch(err) { await client.query('ROLLBACK'); throw err; }
  finally {client.release();}
}

// v3 supplementary persistence (all writes persist across serverless invocations).
export async function getSetting(key, fallback) {
  await ensureSchema();
  const r=await query('SELECT value FROM sb_settings WHERE key=$1',[key]);
  return r.rows.length ? r.rows[0].value : fallback;
}
export async function setSetting(key,value) {
  await ensureSchema();
  await query(`INSERT INTO sb_settings(key,value) VALUES($1,$2::jsonb)
    ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value,updated_at=now()`,[key,JSON.stringify(value)]);
}
export async function saveSnapshot(jobKey,itemKey,storeKey,snapshot) {
  await ensureSchema();
  await query(`INSERT INTO sb_snapshots(job_key,item_key,store_key,snapshot)
    VALUES($1,$2,$3,$4::jsonb) ON CONFLICT DO NOTHING`,
    [jobKey,itemKey,storeKey,JSON.stringify(snapshot)]);
}
export async function snapshots(jobKey) {
  await ensureSchema();
  return (await query('SELECT * FROM sb_snapshots WHERE job_key=$1 ORDER BY item_key,store_key',[jobKey])).rows;
}
export async function enqueueCancel(key, storeKey, order) {
  await ensureSchema();
  const jobKey=`${storeKey}:${String(order.id)}`;
  await query(`INSERT INTO sb_cancellations(job_key) VALUES($1) ON CONFLICT DO NOTHING`,[jobKey]);
  return jobKey;
}
export async function takeCancel() {
  const r=await query(`UPDATE sb_cancellations SET state='PROCESSING',attempts=attempts+1,
    locked_at=now(),updated_at=now() WHERE job_key=(
      SELECT job_key FROM sb_cancellations WHERE state='PENDING'
       OR (state='PROCESSING' AND locked_at < now()-interval '3 minutes')
       OR (state='WAITING' AND updated_at < now()-interval '90 seconds')
       ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED)
    RETURNING *`);
  return r.rows[0];
}
export async function finishCancel(key,state,error=null) {
  await query(`UPDATE sb_cancellations SET state=$2,last_error=$3,locked_at=NULL,
  updated_at=now() WHERE job_key=$1`,[key,state,error?.slice(0,1500)||null]);
}
export async function cancelledOrPending(jobKey) {
  const r=await query('SELECT state FROM sb_cancellations WHERE job_key=$1',[jobKey]);
  return r.rows.length>0;
}
export async function releaseClaims(jobKey) {
  await query('DELETE FROM ts_claims WHERE job_key=$1',[jobKey]);
}
export async function lookupSupplierOrders(jobKey) {
  return (await query('SELECT owner_key,owner_order_gid FROM ts_supplier_orders WHERE job_key=$1',[jobKey])).rows;
}
export async function markSaleCancelled(storeKey,orderId) {
  await query('UPDATE sb_sales SET cancelled=true WHERE store_key=$1 AND order_id=$2',[storeKey,String(orderId)]);
}
export async function upsertSale(record) {
  await ensureSchema();
  await query(`INSERT INTO sb_sales(store_key,order_id,line_id,order_date,sku,supplier,owner_key,brand,product_type,quantity,gross_value,currency,cancelled,is_internal)
  VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
  ON CONFLICT(store_key,order_id,line_id) DO UPDATE SET
    supplier=EXCLUDED.supplier,owner_key=EXCLUDED.owner_key,brand=EXCLUDED.brand,
    product_type=EXCLUDED.product_type,quantity=EXCLUDED.quantity,
    gross_value=EXCLUDED.gross_value,currency=EXCLUDED.currency,
    cancelled=sb_sales.cancelled OR EXCLUDED.cancelled,is_internal=EXCLUDED.is_internal`,
    [record.storeKey,String(record.orderId),String(record.lineId),record.date,record.sku||'',record.supplier||'',record.ownerKey||'',record.brand||'',record.type||'',record.qty||0,record.value||0,record.currency||'PKR',!!record.cancelled,!!record.internal]);
}
export async function inventoryUpsert(storeKey,v) {
  await ensureSchema();
  await query(`INSERT INTO sb_inventory(store_key,variant_id,sku,supplier,owner_key,brand,product_type,quantity,price,currency,status)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT(store_key,variant_id)
    DO UPDATE SET sku=EXCLUDED.sku,supplier=EXCLUDED.supplier,owner_key=EXCLUDED.owner_key,
    brand=EXCLUDED.brand,product_type=EXCLUDED.product_type,quantity=EXCLUDED.quantity,
    price=EXCLUDED.price,currency=EXCLUDED.currency,status=EXCLUDED.status,synced_at=now()`,
    [storeKey,v.variantId,v.sku||'',v.supplier||'',v.ownerKey||'',v.brand||'',v.type||'',v.quantity||0,v.price||0,v.currency||'PKR',v.status||'ACTIVE']);
}
export async function getCursor(storeKey) {
  return (await query('SELECT cursor,synced_at FROM sb_sync WHERE store_key=$1',[storeKey])).rows[0]||{};
}
export async function saveCursor(storeKey,cursor) {
  await query(`INSERT INTO sb_sync(store_key,cursor,synced_at) VALUES($1,$2,now())
    ON CONFLICT(store_key) DO UPDATE SET cursor=$2,synced_at=now(),updated_at=now()`,[storeKey,cursor]);
}
export async function retryV3() {
  const result=await query(`UPDATE sb_cancellations SET state='PENDING',last_error=NULL,updated_at=now() WHERE state='ERROR' RETURNING job_key`);
  return result.rowCount;
}
