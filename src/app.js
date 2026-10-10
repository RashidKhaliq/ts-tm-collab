import express from 'express';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { waitUntil } from '@vercel/functions';
import { getStores, liveWrites } from './config.js';
import * as db from './db.js';
import { graphql, testStore } from './shopify.js';
import { isInternalOrder, runQueue } from './engine.js';

const app=express();
app.disable('x-powered-by');
app.set('trust proxy', 1);
const stores=()=>getStores();
const publicPath=path.join(path.dirname(fileURLToPath(import.meta.url)),'../public');

export function verifyHmac(raw, secret, header) {
  if (!secret || !header) return false;
  const received=Buffer.from(header,'base64');
  const calculated=crypto.createHmac('sha256',secret).update(raw).digest();
  return received.length===calculated.length && crypto.timingSafeEqual(received,calculated);
}
function basicAuth(req,res,next) {
  const user=process.env.ADMIN_USER, pass=process.env.ADMIN_PASSWORD;
  if (!user || !pass || pass==='replace-with-a-strong-password') return res.status(503).send('Configure ADMIN_USER and ADMIN_PASSWORD');
  const expected='Basic '+Buffer.from(`${user}:${pass}`).toString('base64');
  const supplied=String(req.headers.authorization||'');
  const a=Buffer.from(expected),b=Buffer.from(supplied);
  if (a.length!==b.length || !crypto.timingSafeEqual(a,b)) {
    res.set('WWW-Authenticate','Basic realm="ThriftSync"');
    return res.status(401).send('Login required');
  }
  next();
}
function cronAuth(req,res,next) {
  const secret=process.env.CRON_SECRET;
  if (!secret || req.headers.authorization!==`Bearer ${secret}`) return res.status(401).json({error:'Unauthorized'});
  next();
}
function queueWork() {
  const task=runQueue(stores(),3).catch(err=>console.error('ThriftSync worker failed:',err.message));
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
    if (topic!=='orders/create') return res.status(200).json({ok:true,ignored:topic});
    const payload=JSON.parse(req.body.toString('utf8'));
    if (!payload.id) return res.status(422).json({error:'Missing order id'});
    if (isInternalOrder(payload)) return res.status(200).json({ok:true,ignored:'internal order'});
    await db.ensureSchema();
    const jobKey=await db.enqueue(store.key,payload);
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
app.post('/api/retry',basicAuth,async(req,res)=>{
  try {await db.ensureSchema();res.json({retried:await db.retryFailed()});queueWork();}
  catch(e){res.status(500).json({error:e.message});}
});
app.get('/',basicAuth,(req,res)=>res.sendFile(path.join(publicPath,'index.html')));
app.get('/health',(req,res)=>res.status(200).json({ok:true,service:'ThriftSync'}));
export default app;
