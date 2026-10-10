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
