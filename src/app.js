import express from 'express';
import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import { waitUntil } from '@vercel/functions';
import { getStores, liveWrites } from './config.js';
import * as db from './db.js';
import { graphql, testStore } from './shopify.js';
import { isInternalOrder, runQueue, runCancellations } from './engine.js';
import { analytics, syncCatalog, backfillOrders, csvFromRows } from './analytics.js';

const app=express();
app.use((req,res,next)=>{res.set('X-Content-Type-Options','nosniff');res.set('X-Frame-Options','DENY');res.set('Referrer-Policy','no-referrer');res.set('Cache-Control','no-store');next();});
app.disable('x-powered-by');
app.set('trust proxy', 1);
const stores=()=>getStores();
// Keep the admin dashboard out of Vercel's public/ folder: static files bypass Express authentication.
const dashboardHtml=readFileSync(new URL('../private/dashboard.html', import.meta.url), 'utf8');

export function verifyHmac(raw, secret, header) {
  if (!secret || !header) return false;
  const received=Buffer.from(header,'base64');
  const calculated=crypto.createHmac('sha256',secret).update(raw).digest();
  return received.length===calculated.length && crypto.timingSafeEqual(received,calculated);
}
function basicAuth(req,res,next) {
  const isApi = req.path.startsWith('/api/');
  const user=process.env.ADMIN_USER, pass=process.env.ADMIN_PASSWORD;
  if (!user || !pass || pass==='replace-with-a-strong-password') {
    const message='ADMIN_USER or ADMIN_PASSWORD missing/placeholder in this Vercel deployment. Set both environment variables and redeploy.';
    return isApi ? res.status(503).json({error:message}) : res.status(503).type('text').send(message);
  }
  const expected='Basic '+Buffer.from(`${user}:${pass}`).toString('base64');
  const supplied=String(req.headers.authorization||'');
  const a=Buffer.from(expected),b=Buffer.from(supplied);
  if (a.length!==b.length || !crypto.timingSafeEqual(a,b)) {
    res.set('WWW-Authenticate','Basic realm="StockBridge"');
    return isApi ? res.status(401).json({error:'Admin authentication required. Sign in or refresh browser credentials.'}) : res.status(401).send('Login required');
  }
  next();
}
function cronAuth(req,res,next) {
  const secret=process.env.CRON_SECRET;
  if (!secret || req.headers.authorization!==`Bearer ${secret}`) return res.status(401).json({error:'Unauthorized'});
  next();
}
function queueWork() {
  const task=(async()=>{await runQueue(stores(),3);await runCancellations(stores(),3);})().catch(err=>console.error('StockBridge worker failed:',err.message));
  try {waitUntil(task);} catch {task.catch(()=>{});} // Local Express: promise continues; Vercel: waitUntil extends lifetime.
}
// Shopify HMAC requires raw, unparsed request bytes. Same endpoint for all stores.
app.post('/api/webhooks',express.raw({type:'*/*',limit:'2mb'}),async(req,res)=>{
  try {
    const domain=String(req.header('X-Shopify-Shop-Domain')||'').toLowerCase();
    const store=stores().find(s=>s.domain===domain);
    if (!store) return res.status(401).json({error:'Unknown store domain'});
    if (!Buffer.isBuffer(req.body) || !verifyHmac(req.body,store.webhookSecret,req.header('X-Shopify-Hmac-Sha256'))) {
      return res.status(401).json({error:'Invalid webhook HMAC; check notification webhook secret'});
    }
    const topic=req.header('X-Shopify-Topic');
    if (!['orders/create','orders/cancelled'].includes(topic)) return res.status(200).json({ok:true,ignored:topic});
    const payload=JSON.parse(req.body.toString('utf8'));
    if (!payload.id) return res.status(422).json({error:'Missing order id'});
    if (isInternalOrder(payload)) return res.status(200).json({ok:true,ignored:'internal order'});
    await db.ensureSchema();
    const jobKey=topic==='orders/cancelled'?
      await db.enqueueCancel(null,store.key,payload):await db.enqueue(store.key,payload);
    res.status(200).json({ok:true,queued:jobKey});
    queueWork();
  } catch(err) {
    console.error('Webhook error:',err.message);
    if (!res.headersSent) res.status(503).json({error:'Could not safely queue webhook'});
  }
});

app.get('/api/worker',cronAuth,async(req,res)=>{
  try {res.json({ok:true,results:await runQueue(stores(),Number(req.query.limit)||3)});}
  catch(e){res.status(500).json({error:e.message});}
});
app.use(express.json({limit:'50kb'}));
function csrf(req,res,next){
  const origin=req.get('origin');
  if(origin){try{if(new URL(origin).host!==req.get('host'))return res.status(403).json({error:'Cross-origin write blocked'});}catch{return res.status(403).json({error:'Invalid origin'});}}
  next();
}
app.get('/api/settings',basicAuth,async(req,res)=>{
  try{res.json({discount:await db.getSetting('supplierDiscountPercent',Number(process.env.DEFAULT_DISCOUNT_PERCENT||99)),
    freeShipping:await db.getSetting('freeInternalShipping',true),
    cacheSeconds:await db.getSetting('analyticsCacheSeconds',900)});}catch(e){res.status(500).json({error:e.message});}
});
app.put('/api/settings',basicAuth,csrf,async(req,res)=>{
  try{
    const {discount,freeShipping,cacheSeconds}=req.body||{};
    if(typeof discount!=='number'||!Number.isFinite(discount)||discount<0||discount>100||
       typeof freeShipping!=='boolean'||!Number.isInteger(cacheSeconds)||cacheSeconds<60||cacheSeconds>86400)
      return res.status(422).json({error:'Discount 0-100, freeShipping boolean, cacheSeconds integer 60-86400 required'});
    await db.setSetting('supplierDiscountPercent',discount);
    await db.setSetting('freeInternalShipping',freeShipping);
    await db.setSetting('analyticsCacheSeconds',cacheSeconds);
    res.json({ok:true,discount,freeShipping,cacheSeconds});
  }catch(e){res.status(500).json({error:e.message});}
});
app.get('/api/analytics',basicAuth,async(req,res)=>{
  try{res.json(await analytics(req.query));}catch(e){res.status(400).json({error:e.message});}
});
app.get('/api/analytics/csv',basicAuth,async(req,res)=>{
  try{const report=await analytics(req.query);res.set('Content-Disposition','attachment; filename="stockbridge-analytics.csv"');res.type('text/csv').send(csvFromRows(report.rows));}
  catch(e){res.status(400).json({error:e.message});}
});
app.post('/api/sync',basicAuth,csrf,async(req,res)=>{
  try{
    const store=stores().find(x=>x.key===req.body?.store);
    if(!store)return res.status(422).json({error:'Select an enabled store'});
    const pages=Math.max(1,Math.min(5,Number(req.body?.pages)||2));
    res.json({ok:true,...await syncCatalog(store,pages,req.body?.reset===true)});
  }catch(e){res.status(500).json({error:e.message});}
});
app.post('/api/backfill',basicAuth,csrf,async(req,res)=>{
  try{
    const store=stores().find(x=>x.key===req.body?.store);
    if(!store)return res.status(422).json({error:'Select an enabled store'});
    if(req.body?.confirm!==true)return res.status(422).json({error:'confirm:true required to run historical import'});
    const cursor=typeof req.body.cursor==='string'&&req.body.cursor.length<2000?req.body.cursor:null;
    res.json({ok:true,...await backfillOrders(store,cursor,12)});
  }catch(e){res.status(500).json({error:e.message});}
});
app.get('/api/cancellations',basicAuth,async(req,res)=>{
  try{await db.ensureSchema();res.json({items:(await db.query('SELECT * FROM sb_cancellations ORDER BY created_at DESC LIMIT 40')).rows});}
  catch(e){res.status(500).json({error:e.message});}
});

app.get('/api/status',basicAuth,async(req,res)=>{
  try {
    const status=await Promise.all(stores().map(async s=>{
      try {
        const result=await testStore(s);
        const required=['read_products','write_products','read_inventory','write_inventory','read_orders','write_orders'];
        return {store:s.key,name:s.name,domain:s.domain,supplier:s.supplier,connected:true,
          shop:result.shop?.name,missingScopes:required.filter(scope=>!result.scopes.includes(scope))};
      } catch(e) {return {store:s.key,name:s.name,domain:s.domain,supplier:s.supplier,connected:false,error:e.message};}
    }));
    await db.ensureSchema();
    res.json({liveWrites,stores:status,...await db.recent()});
  } catch(e){res.status(500).json({error:e.message});}
});
app.post('/api/retry',basicAuth,csrf,async(req,res)=>{
  try {await db.ensureSchema();res.json({retried:(await db.retryFailed())+(await db.retryV3())});queueWork();}
  catch(e){res.status(500).json({error:e.message});}
});
app.get('/',basicAuth,(req,res)=>res.status(200).type('html').send(dashboardHtml));
app.get('/health',(req,res)=>res.status(200).json({ok:true,service:'StockBridge v3'}));
export default app;
