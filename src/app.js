import express from 'express';
import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import { waitUntil } from '@vercel/functions';
import { defaultDiscountPercent, getStores, liveWrites, requiredScopes } from './config.js';
import * as db from './db.js';
import { testStore } from './shopify.js';
import { isInternalOrder, runQueue } from './engine.js';
import { getCombinedAnalytics, syncAllStoresInventory } from './analytics.js';

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);
const stores = () => getStores();

// Keep the admin dashboard out of Vercel's public/ folder: static files bypass Express authentication.
const dashboardHtml = readFileSync(new URL('../private/dashboard.html', import.meta.url), 'utf8');

export function verifyHmac(raw, secret, header) {
  if (!secret || !header) return false;
  const received = Buffer.from(header, 'base64');
  const calculated = crypto.createHmac('sha256', secret).update(raw).digest();
  return received.length === calculated.length && crypto.timingSafeEqual(received, calculated);
}

function basicAuth(req, res, next) {
  const isApi = req.path.startsWith('/api/');
  const user = process.env.ADMIN_USER, pass = process.env.ADMIN_PASSWORD;
  if (!user || !pass || pass === 'replace-with-a-strong-password') {
    const message = 'ADMIN_USER or ADMIN_PASSWORD missing/placeholder in this Vercel deployment. Set both environment variables and redeploy.';
    return isApi ? res.status(503).json({ error: message }) : res.status(503).type('text').send(message);
  }
  const expected = 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64');
  const supplied = String(req.headers.authorization || '');
  const a = Buffer.from(expected), b = Buffer.from(supplied);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    res.set('WWW-Authenticate', 'Basic realm="ThriftSync"');
    return isApi ? res.status(401).json({ error: 'Admin authentication required. Sign in or refresh browser credentials.' }) : res.status(401).send('Login required');
  }
  next();
}

function cronAuth(req, res, next) {
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers.authorization !== `Bearer ${secret}`) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

function queueWork() {
  const task = runQueue(stores(), 3).catch(err => console.error('ThriftSync worker failed:', err.message));
  try { waitUntil(task); } catch { task.catch(() => {}); } // Local Express: promise continues; Vercel: waitUntil extends lifetime.
}

// Shopify HMAC requires raw, unparsed request bytes. Same endpoint for all stores.
// Processes both orders/create and orders/cancelled
app.post('/api/webhooks', express.raw({ type: '*/*', limit: '2mb' }), async (req, res) => {
  try {
    const domain = String(req.header('X-Shopify-Shop-Domain') || '').toLowerCase();
    const store = stores().find(s => s.domain === domain);
    if (!store) return res.status(401).json({ error: 'Unknown store domain' });
    if (!Buffer.isBuffer(req.body) || !verifyHmac(req.body, store.webhookSecret, req.header('X-Shopify-Hmac-Sha256'))) {
      return res.status(401).json({ error: 'Invalid webhook HMAC; check notification webhook secret' });
    }
    const topic = req.header('X-Shopify-Topic');
    if (topic !== 'orders/create' && topic !== 'orders/cancelled') {
      return res.status(200).json({ ok: true, ignored: topic });
    }
    const payload = JSON.parse(req.body.toString('utf8'));
    if (!payload.id) return res.status(422).json({ error: 'Missing order id' });
    if (isInternalOrder(payload)) return res.status(200).json({ ok: true, ignored: 'internal order' });

    await db.ensureSchema();
    const jobKey = await db.enqueue(store.key, payload, topic);
    res.status(200).json({ ok: true, queued: jobKey, topic });
    queueWork();
  } catch (err) {
    console.error('Webhook error:', err.message);
    if (!res.headersSent) res.status(503).json({ error: 'Could not safely queue webhook' });
  }
});

app.get('/api/worker', cronAuth, async (req, res) => {
  try { res.json({ ok: true, results: await runQueue(stores(), Number(req.query.limit) || 3) }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.use(express.json({ limit: '50kb' }));

app.get('/api/status', basicAuth, async (req, res) => {
  try {
    const status = await Promise.all(stores().map(async s => {
      try {
        const result = await testStore(s);
        return {
          store: s.key, name: s.name, domain: s.domain, supplier: s.supplier, connected: true,
          shop: result.shop?.name,
          missingScopes: requiredScopes.filter(scope => !result.scopes.includes(scope))
        };
      } catch (e) {
        return { store: s.key, name: s.name, domain: s.domain, supplier: s.supplier, connected: false, error: e.message };
      }
    }));
    await db.ensureSchema();
    const discountPercent = Number(await db.getSetting('discount_percent', defaultDiscountPercent));
    const invStatus = await db.getInventorySyncStatus();
    res.json({
      liveWrites,
      discountPercent,
      inventoryStatus: invStatus,
      stores: status,
      ...await db.recent()
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/retry', basicAuth, async (req, res) => {
  try {
    await db.ensureSchema();
    res.json({ retried: await db.retryFailed() });
    queueWork();
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Settings API
app.get('/api/settings', basicAuth, async (req, res) => {
  try {
    await db.ensureSchema();
    const discount = Number(await db.getSetting('discount_percent', defaultDiscountPercent));
    res.json({ ok: true, discountPercent: discount });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/settings', basicAuth, async (req, res) => {
  try {
    await db.ensureSchema();
    const pct = Number(req.body?.discountPercent);
    if (!Number.isFinite(pct) || pct < 0 || pct > 100) {
      return res.status(400).json({ error: 'Discount percent must be a number between 0 and 100' });
    }
    await db.setSetting('discount_percent', Math.round(pct));
    res.json({ ok: true, discountPercent: Math.round(pct) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Analytics API
app.get('/api/analytics', basicAuth, async (req, res) => {
  try {
    const data = await getCombinedAnalytics(stores(), req.query);
    res.json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/analytics/filters', basicAuth, async (req, res) => {
  try {
    await db.ensureSchema();
    const options = await db.getInventoryFilterOptions();
    const storeList = stores().map(s => ({ key: s.key, name: s.name, supplier: s.supplier }));
    res.json({ stores: storeList, ...options });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Inventory Sync API
app.post('/api/inventory/sync', basicAuth, async (req, res) => {
  try {
    const results = await syncAllStoresInventory(stores());
    res.json({ ok: true, results });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/inventory/status', basicAuth, async (req, res) => {
  try {
    await db.ensureSchema();
    const status = await db.getInventorySyncStatus();
    res.json({ ok: true, status });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/', basicAuth, (req, res) => res.status(200).type('html').send(dashboardHtml));
app.get('/health', (req, res) => res.status(200).json({ ok: true, service: 'ThriftSync', version: '3.0.0-beta.1' }));

export default app;
