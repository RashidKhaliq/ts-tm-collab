import 'dotenv/config';
import express from 'express';
import {readFile} from 'node:fs/promises';
import {query,audit,transaction} from './db.js';
import {adminAuth,workerAuth,encrypt,decrypt,verifyWebhook,validDomain,numericGid} from './security.js';
import {checkListing} from './shopify.js';
import {runWorker,retrySale,approveRestore} from './engine.js';
const app=express();app.disable('x-powered-by');
const route=(fn)=>(req,res,next)=>Promise.resolve(fn(req,res,next)).catch(next);
app.get('/health',(req,res)=>res.json({status:'ok',live_writes:process.env.LIVE_WRITES==='true'}));
app.post('/api/webhooks/shopify',express.raw({type:'application/json',limit:'2mb'}),route(async(req,res)=>{
 const domain=String(req.get('x-shopify-shop-domain')||'').toLowerCase();const topic=req.get('x-shopify-topic')||'';const id=req.get('x-shopify-webhook-id');
 if(!validDomain(domain)||!id||!['orders/create','orders/cancelled'].includes(topic))return res.status(400).json({error:'Invalid webhook'});
 const store=(await query('SELECT * FROM stores WHERE domain=$1 AND active=true',[domain])).rows[0];if(!store)return res.status(401).json({error:'Unknown store'});
 if(!verifyWebhook(req.body,decrypt(store.encrypted_webhook_secret),req.get('x-shopify-hmac-sha256')))return res.status(401).json({error:'Bad signature'});
 let payload;try{payload=JSON.parse(req.body.toString());}catch{return res.status(400).json({error:'Bad JSON'});}
 await query('INSERT INTO incoming_events(store_id,webhook_id,topic,payload) VALUES($1,$2,$3,$4) ON CONFLICT(store_id,webhook_id) DO NOTHING',[store.id,id,topic,JSON.stringify(payload)]);
 res.status(200).json({accepted:true});
}));
app.use(express.json({limit:'256kb'}));
app.post('/api/worker/run',workerAuth,route(async(req,res)=>res.json({events:await runWorker(10)})));
app.get('/',adminAuth,route(async(req,res)=>{res.type('html').send(await readFile(new URL('../public/index.html',import.meta.url),'utf8'));}));
app.use('/api/admin',adminAuth);
app.get('/api/admin/summary',route(async(req,res)=>{
 const {rows:[counts]}=await query(`SELECT (SELECT count(*) FROM stores) stores,(SELECT count(*) FROM items) items,(SELECT count(*) FROM items WHERE status='AVAILABLE') available,(SELECT count(*) FROM items WHERE status='RESERVED') reserved,(SELECT count(*) FROM items WHERE status='SOLD') sold,(SELECT count(*) FROM items WHERE status='REVIEW') review,(SELECT count(*) FROM incoming_events WHERE state='FAILED') failed_events`);
 res.json({counts,live:process.env.LIVE_WRITES==='true'});
}));
app.get('/api/admin/stores',route(async(req,res)=>res.json((await query('SELECT id,name,domain,supplier_code,owner_name,owner_email,owner_phone,owner_address,active,created_at FROM stores ORDER BY created_at')).rows)));
app.post('/api/admin/stores',route(async(req,res)=>{
 const {name,domain,supplier_code,owner_name='',owner_email='',owner_phone='',owner_address={},access_token,webhook_secret}=req.body;
 if(!name||!validDomain(domain)||!supplier_code||!access_token||!webhook_secret) return res.status(400).json({error:'Missing required fields / bad domain'});
 if(!/^[A-Za-z0-9_-]{2,48}$/.test(supplier_code))return res.status(400).json({error:'Invalid supplier code'});
 const {rows:[store]}=await query(`INSERT INTO stores(name,domain,supplier_code,owner_name,owner_email,owner_phone,owner_address,encrypted_token,encrypted_webhook_secret) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id,name,domain,supplier_code`,[name,domain.toLowerCase(),supplier_code,owner_name,owner_email,owner_phone,JSON.stringify(owner_address),encrypt(access_token),encrypt(webhook_secret)]);
 await audit('INFO','STORE','Store connected',{storeId:store.id});res.status(201).json(store);
}));
app.patch('/api/admin/stores/:id',route(async(req,res)=>{
 if(typeof req.body.active!=='boolean')return res.status(400).json({error:'active must be boolean'});
 await query('UPDATE stores SET active=$2 WHERE id=$1',[req.params.id,req.body.active]);res.json({ok:true});
}));
app.get('/api/admin/items',route(async(req,res)=>res.json((await query(`SELECT i.*,s.name owner_name,(SELECT count(*) FROM listings l WHERE l.item_id=i.id) listing_count FROM items i JOIN stores s ON s.id=i.owner_store_id ORDER BY i.updated_at DESC LIMIT 500`)).rows)));
app.post('/api/admin/items',route(async(req,res)=>{
 const {owner_store_id,sku}=req.body;const store=(await query('SELECT * FROM stores WHERE id=$1',[owner_store_id])).rows[0];if(!store||!sku||String(sku).length>100)return res.status(400).json({error:'Invalid owner or SKU'});
 const {rows:[item]}=await query('INSERT INTO items(owner_store_id,owner_sku,supplier_code) VALUES($1,$2,$3) RETURNING *',[store.id,sku,store.supplier_code]);res.status(201).json(item);
}));
app.post('/api/admin/items/:id/listings',route(async(req,res)=>{
 const {store_id,product_id,variant_id}=req.body;const item=(await query('SELECT * FROM items WHERE id=$1',[req.params.id])).rows[0];const store=(await query('SELECT * FROM stores WHERE id=$1 AND active=true',[store_id])).rows[0];if(!item||!store)return res.status(400).json({error:'Bad item/store'});
 const product=numericGid('Product',product_id),variant=numericGid('ProductVariant',variant_id);
 const actual=await checkListing(store,product,variant);
 const supplier=actual.product.metafield?.value?.trim();
 if(supplier!==item.supplier_code)return res.status(409).json({error:`custom.supplier must be ${item.supplier_code}; received ${supplier||'(missing)'}`});
 if(item.status!=='AVAILABLE')return res.status(409).json({error:'Cannot attach listing to unavailable item'});
 const {rows:[listing]}=await query(`INSERT INTO listings(item_id,store_id,product_gid,variant_gid,inventory_gid,sku,original_status) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *`,[item.id,store.id,product,variant,actual.variant.inventoryItem.id,actual.variant.sku,actual.product.status]);
 res.status(201).json(listing);
}));
app.get('/api/admin/listings',route(async(req,res)=>res.json((await query('SELECT l.*,s.name store_name FROM listings l JOIN stores s ON s.id=l.store_id ORDER BY l.item_id LIMIT 1000')).rows)));
app.get('/api/admin/sales',route(async(req,res)=>res.json((await query('SELECT * FROM sales ORDER BY created_at DESC LIMIT 300')).rows)));
app.get('/api/admin/events',route(async(req,res)=>res.json((await query('SELECT id,store_id,topic,state,attempts,last_error,created_at FROM incoming_events ORDER BY created_at DESC LIMIT 300')).rows)));
app.get('/api/admin/audit',route(async(req,res)=>res.json((await query('SELECT * FROM audit ORDER BY created_at DESC LIMIT 300')).rows)));
app.post('/api/admin/sales/:id/retry',route(async(req,res)=>{await retrySale(req.params.id);res.json({ok:true});}));
app.post('/api/admin/items/:id/restore',route(async(req,res)=>{if(req.body.confirm!=='RESTORE')return res.status(400).json({error:'Explicit confirmation required'});await approveRestore(req.params.id);res.json({ok:true});}));
app.use((err,req,res,next)=>{console.error(err.message);res.status(500).json({error:err.message});});
export default app;
