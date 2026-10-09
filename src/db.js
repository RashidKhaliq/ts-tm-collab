import pg from 'pg';
export const pool = new pg.Pool({connectionString:process.env.DATABASE_URL,max:5,connectionTimeoutMillis:10000});
export const query = (sql,values=[])=>pool.query(sql,values);
export async function transaction(fn){const client=await pool.connect();try{await client.query('BEGIN');const output=await fn(client);await client.query('COMMIT');return output;}catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();}}
export async function audit(level,kind,message,{itemId=null,storeId=null,details={}}={}){
 await query('INSERT INTO audit(level,kind,message,item_id,store_id,details) VALUES($1,$2,$3,$4,$5,$6)',[level,kind,message,itemId,storeId,JSON.stringify(details)]);
}
