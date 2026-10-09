// index.js - Automated Dropshipping (Hub Model / Option A) — Vercel Ready & Diagnostic Enhanced
require('dotenv').config();
const express = require('express');
const crypto = require('crypto');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 8000;

// --- IN-MEMORY LOG BUFFER ---
const MAX_LOGS = 200;
const inMemoryLogs = [];
const LOG_FILE = path.join('/tmp', 'activity.log');

function log(level, message) {
  const timestamp = new Date().toISOString();
  const logEntry = { timestamp, level, message };

  inMemoryLogs.push(logEntry);
  if (inMemoryLogs.length > MAX_LOGS) {
    inMemoryLogs.shift();
  }

  const formattedLine = `[${timestamp}] [${level}] ${message}`;
  if (level === 'ERROR') {
    console.error(formattedLine);
  } else {
    console.log(formattedLine);
  }

  try {
    fs.appendFile(LOG_FILE, formattedLine + '\n', () => {});
  } catch (err) {}
}

// Middleware
app.use(express.json({
  verify: (req, res, buf) => { req.rawBody = buf; }
}));

app.use(express.static(path.join(__dirname, 'public')));

app.use((req, res, next) => {
  if (!req.originalUrl.startsWith('/api/logs') && !req.originalUrl.startsWith('/api/status')) {
    log('INFO', `Incoming ${req.method} ${req.originalUrl} from ${req.ip || 'client'}`);
  }
  next();
});

// --- CONFIGURATION ---
function getShopifyConfig() {
  return {
    STORE_A: {
      key: 'STORE_A',
      name: process.env.STORE_A_NAME || "Rashid Store (Store A)",
      url: process.env.STORE_A_URL,
      token: process.env.STORE_A_ACCESS_TOKEN,
      ownerEmail: process.env.STORE_A_OWNER_EMAIL,
      supplierName: process.env.STORE_A_SUPPLIER_NAME || "ZIA",
      webhookSecret: process.env.STORE_A_WEBHOOK_SECRET,
      address: { 
        first_name: "Rashid", 
        last_name: "Khaliq",
        address1: "Township", 
        city: "Lahore", 
        country: "PK", 
        zip: "54000" 
      }
    },
    STORE_B: {
      key: 'STORE_B',
      name: process.env.STORE_B_NAME || "Hamza Store (Store B)",
      url: process.env.STORE_B_URL,
      token: process.env.STORE_B_ACCESS_TOKEN,
      ownerEmail: process.env.STORE_B_OWNER_EMAIL,
      supplierName: process.env.STORE_B_SUPPLIER_NAME || "HAMZA",
      webhookSecret: process.env.STORE_B_WEBHOOK_SECRET,
      address: { 
        first_name: "Hamza", 
        last_name: "Owner",
        address1: "Wapda Town", 
        city: "Lahore", 
        country: "PK", 
        zip: "54000" 
      }
    },
    STORE_C: {
      key: 'STORE_C',
      name: process.env.STORE_C_NAME || "Store C",
      url: process.env.STORE_C_URL,
      token: process.env.STORE_C_ACCESS_TOKEN,
      ownerEmail: process.env.STORE_C_OWNER_EMAIL,
      supplierName: process.env.STORE_C_SUPPLIER_NAME || "Store C",
      webhookSecret: process.env.STORE_C_WEBHOOK_SECRET,
      address: { 
        first_name: "Store", 
        last_name: "C",
        address1: "Main", 
        city: "Lahore", 
        country: "PK", 
        zip: "54000" 
      }
    }
  };
}

const verifyWebhook = (req, secret) => {
  if (!req.rawBody || !secret) return false;
  const hmac = req.get('X-Shopify-Hmac-Sha256');
  const generatedHash = crypto.createHmac('sha256', secret).update(req.rawBody, 'utf8').digest('base64');
  return hmac === generatedHash;
};

// --- Helper: Clean Domain ---
function cleanDomain(url) {
  if (!url) return '';
  return url.replace(/^https?:\/\//i, '').replace(/\/$/, '').trim();
}

// --- Helper: Case & Whitespace Insensitive Tag Match ---
function hasSupplierTag(tagsString, targetSupplierTag) {
  if (!tagsString) return false;
  // E.g. targetSupplierTag = "Supplier: Rashid" -> clean: "supplier:rashid"
  const targetClean = targetSupplierTag.toLowerCase().replace(/\s+/g, '');
  
  // Split tags by comma
  const tagsList = tagsString.split(',').map(t => t.trim().toLowerCase());
  return tagsList.some(tag => {
    const cleanTag = tag.replace(/\s+/g, '');
    return cleanTag === targetClean || cleanTag === targetSupplierTag.toLowerCase();
  });
}

// --- FRONTEND ROUTE ---
app.get('/', (req, res) => {
  const htmlPath = path.join(__dirname, 'public', 'index.html');
  if (fs.existsSync(htmlPath)) {
    res.sendFile(htmlPath);
  } else {
    res.status(200).send('<h1>Shopify Inventory Sync Hub</h1>');
  }
});

// --- DETAILED ENVIRONMENT VARIABLE DIAGNOSTICS API ---
app.get('/api/verify-env', async (req, res) => {
  const config = getShopifyConfig();
  const dbUrl = process.env.DATABASE_URL || process.env.PRISMA_DATABASE_URL || process.env.POSTGRES_URL;
  
  const envCheck = {
    DATABASE_URL: checkEnvVar('DATABASE_URL / POSTGRES_URL', dbUrl, true, false),
    PORT: checkEnvVar('PORT', process.env.PORT, false, false),

    STORE_A_NAME: checkEnvVar('STORE_A_NAME', config.STORE_A.name, false, false),
    STORE_A_URL: checkEnvVar('STORE_A_URL', config.STORE_A.url),
    STORE_A_ACCESS_TOKEN: checkEnvVar('STORE_A_ACCESS_TOKEN', config.STORE_A.token, true),
    STORE_A_OWNER_EMAIL: checkEnvVar('STORE_A_OWNER_EMAIL', config.STORE_A.ownerEmail),
    STORE_A_WEBHOOK_SECRET: checkEnvVar('STORE_A_WEBHOOK_SECRET', config.STORE_A.webhookSecret, true, false),

    STORE_B_NAME: checkEnvVar('STORE_B_NAME', config.STORE_B.name, false, false),
    STORE_B_URL: checkEnvVar('STORE_B_URL', config.STORE_B.url),
    STORE_B_ACCESS_TOKEN: checkEnvVar('STORE_B_ACCESS_TOKEN', config.STORE_B.token, true),
    STORE_B_OWNER_EMAIL: checkEnvVar('STORE_B_OWNER_EMAIL', config.STORE_B.ownerEmail),
    STORE_B_WEBHOOK_SECRET: checkEnvVar('STORE_B_WEBHOOK_SECRET', config.STORE_B.webhookSecret, true, false),

    STORE_C_NAME: checkEnvVar('STORE_C_NAME', config.STORE_C.name, false, false),
    STORE_C_URL: checkEnvVar('STORE_C_URL', config.STORE_C.url, false, false),
    STORE_C_ACCESS_TOKEN: checkEnvVar('STORE_C_ACCESS_TOKEN', config.STORE_C.token, true, false),
    STORE_C_OWNER_EMAIL: checkEnvVar('STORE_C_OWNER_EMAIL', config.STORE_C.ownerEmail, false, false),
    STORE_C_WEBHOOK_SECRET: checkEnvVar('STORE_C_WEBHOOK_SECRET', config.STORE_C.webhookSecret, true, false),
  };

  // Test live Shopify API connections
  const storeATest = await testStoreConnectionDetailed(config.STORE_A);
  const storeBTest = await testStoreConnectionDetailed(config.STORE_B);
  const storeCTest = config.STORE_C.url ? await testStoreConnectionDetailed(config.STORE_C) : { name: config.STORE_C.name, status: 'NOT_CONFIGURED' };

  const allVarsPresent = Object.values(envCheck).every(v => !v.required || v.status === 'OK');
  const allApiConnected = storeATest.status === 'CONNECTED' && storeBTest.status === 'CONNECTED';

  res.json({
    timestamp: new Date().toISOString(),
    overallStatus: (allVarsPresent && allApiConnected) ? 'ALL_SYSTEMS_GO' : 'CONFIGURATION_OR_AUTH_ISSUES',
    envVariables: envCheck,
    storeA: storeATest,
    storeB: storeBTest,
    storeC: storeCTest
  });
});

function checkEnvVar(key, value, isSecret = false, required = true) {
  if (!value || value.trim() === '') {
    return {
      key,
      status: required ? 'MISSING' : 'OPTIONAL_NOT_SET',
      required,
      displayValue: 'Not set'
    };
  }
  let displayValue = value;
  if (isSecret) {
    displayValue = value.length > 8 ? `${value.substring(0, 4)}...${value.substring(value.length - 4)}` : '****';
  }
  return {
    key,
    status: 'OK',
    required,
    displayValue
  };
}

// --- BASIC STATUS API ---
app.get('/api/status', async (req, res) => {
  const config = getShopifyConfig();
  const report = {
    timestamp: new Date().toISOString(),
    overallStatus: 'OK',
    storeA: await testStoreConnectionDetailed(config.STORE_A),
    storeB: await testStoreConnectionDetailed(config.STORE_B),
    storeC: config.STORE_C.url ? await testStoreConnectionDetailed(config.STORE_C) : { name: config.STORE_C.name, status: 'NOT_CONFIGURED' }
  };

  if (report.storeA.status !== 'CONNECTED' || report.storeB.status !== 'CONNECTED') {
    report.overallStatus = 'DEGRADED';
  }
  res.json(report);
});

app.get('/api/logs', (req, res) => {
  res.json(inMemoryLogs);
});

async function testStoreConnectionDetailed(store) {
  const missing = [];
  if (!store.url) missing.push(`${store.key}_URL`);
  if (!store.token) missing.push(`${store.key}_ACCESS_TOKEN`);
  if (!store.ownerEmail) missing.push(`${store.key}_OWNER_EMAIL`);

  if (missing.length > 0) {
    return {
      name: store.name,
      url: store.url || null,
      ownerEmail: store.ownerEmail || null,
      status: 'CONFIG_MISSING',
      missingFields: missing,
      errorDetails: `Missing required env variable(s): ${missing.join(', ')}`
    };
  }

  const domain = cleanDomain(store.url);

  try {
    // 1. Check shop info
    const shopRes = await axios.get(`https://${domain}/admin/api/2024-01/shop.json`, {
      headers: { 'X-Shopify-Access-Token': store.token },
      timeout: 8000
    });

    const shop = shopRes.data?.shop || {};

    // 2. Check read_products permission
    let canReadProducts = false;
    try {
      await axios.get(`https://${domain}/admin/api/2024-01/products.json?limit=1`, {
        headers: { 'X-Shopify-Access-Token': store.token },
        timeout: 5000
      });
      canReadProducts = true;
    } catch (e) {
      log('WARN', `Store ${store.name} token cannot read products: ${e.message}`);
    }

    log('INFO', `Shopify API check SUCCESS for ${store.name} (${shop.name || domain})`);
    return {
      name: store.name,
      url: domain,
      ownerEmail: store.ownerEmail,
      status: 'CONNECTED',
      shopName: shop.name,
      myshopifyDomain: shop.myshopify_domain,
      domain: shop.domain,
      planName: shop.plan_name,
      currency: shop.currency,
      permissions: {
        readShop: true,
        readProducts: canReadProducts
      }
    };
  } catch (err) {
    let errorDetails = err.message;
    if (err.response) {
      if (err.response.status === 401) {
        errorDetails = `HTTP 401 Unauthorized: Invalid Shopify Access Token (${store.key}_ACCESS_TOKEN).`;
      } else if (err.response.status === 404) {
        errorDetails = `HTTP 404 Not Found: Check store URL domain (${store.key}_URL=${domain}).`;
      } else {
        errorDetails = `HTTP ${err.response.status} Error from Shopify: ${JSON.stringify(err.response.data)}`;
      }
    } else if (err.code === 'ENOTFOUND') {
      errorDetails = `DNS Lookup failed for store domain '${domain}'. Verify URL.`;
    }

    log('ERROR', `Shopify API check FAILED for ${store.name}: ${errorDetails}`);
    return {
      name: store.name,
      url: domain,
      ownerEmail: store.ownerEmail,
      status: 'ERROR',
      errorDetails: errorDetails
    };
  }
}

// --- MANUAL TEST SIMULATOR API ---
app.post('/api/test-sync', async (req, res) => {
  const { direction, sku, orderName } = req.body || {};
  const config = getShopifyConfig();

  let sourceStore, targetStore, supplierTag;

  if (direction === 'B_TO_A') {
    sourceStore = config.STORE_B;
    targetStore = config.STORE_A;
    supplierTag = 'Supplier: Rashid';
  } else {
    sourceStore = config.STORE_A;
    targetStore = config.STORE_B;
    supplierTag = 'Supplier: Hamza';
  }

  log('INFO', `🧪 TEST SIMULATION: Testing order sync from ${sourceStore.name} to ${targetStore.name} (SKU: ${sku || 'TEST-SKU'})`);

  const mockOrder = {
    name: orderName || '#TEST-9999',
    email: 'customer@example.com',
    line_items: [
      {
        product_id: 123456789,
        sku: sku || 'TEST-SKU',
        quantity: 1
      }
    ]
  };

  const results = [];
  results.push(`Starting simulation: Order ${mockOrder.name} on ${sourceStore.name}`);

  // Test target variant lookup on supplier store
  const variantId = await findVariantIdBySku(targetStore, mockOrder.line_items[0].sku);
  if (variantId) {
    results.push(`✓ Found SKU '${mockOrder.line_items[0].sku}' on ${targetStore.name} (Variant ID: ${variantId})`);
  } else {
    results.push(`✕ Could not find SKU '${mockOrder.line_items[0].sku}' on ${targetStore.name}. Please ensure SKU exists in ${targetStore.name}.`);
  }

  res.json({
    success: !!variantId,
    direction,
    sku: mockOrder.line_items[0].sku,
    variantIdFound: variantId,
    logTrace: results
  });
});

// --- WEBHOOKS ---

// --- WEBHOOKS ---

// 1. Order Created on RASHID'S STORE (Store A)
app.post('/webhooks/store-a/orders/create', async (req, res) => {
  const config = getShopifyConfig();
  try {
    const secret = config.STORE_A.webhookSecret;
    let verified = true;

    if (secret) {
      verified = verifyWebhook(req, secret);
      if (!verified) {
        log('ERROR', `Store A webhook failed HMAC verification for order ${req.body?.name || 'unknown'}. Check STORE_A_WEBHOOK_SECRET.`);
        return res.status(401).send('Unauthorized HMAC signature');
      }
    } else {
      log('WARN', `Store A webhook received without STORE_A_WEBHOOK_SECRET set (bypassing HMAC verification).`);
    }

    log('INFO', `📦 Webhook Hit: Store A Order Created (${req.body?.name || 'unknown'}, ID: ${req.body?.id})`);
    await processDropship(req.body, config.STORE_A);
    res.status(200).send('Processed');
  } catch (e) {
    log('ERROR', `Store A webhook handler error: ${e.message}`);
    res.status(500).send('Error');
  }
});

// 2. Order Created on HAMZA'S STORE (Store B)
app.post('/webhooks/store-b/orders/create', async (req, res) => {
  const config = getShopifyConfig();
  try {
    const secret = config.STORE_B.webhookSecret;
    let verified = true;

    if (secret) {
      verified = verifyWebhook(req, secret);
      if (!verified) {
        log('ERROR', `Store B webhook failed HMAC verification for order ${req.body?.name || 'unknown'}. Check STORE_B_WEBHOOK_SECRET.`);
        return res.status(401).send('Unauthorized HMAC signature');
      }
    } else {
      log('WARN', `Store B webhook received without STORE_B_WEBHOOK_SECRET set (bypassing HMAC verification).`);
    }

    log('INFO', `📦 Webhook Hit: Store B Order Created (${req.body?.name || 'unknown'}, ID: ${req.body?.id})`);
    await processDropship(req.body, config.STORE_B);
    res.status(200).send('Processed');
  } catch (e) {
    log('ERROR', `Store B webhook handler error: ${e.message}`);
    res.status(500).send('Error');
  }
});

// --- CORE DROPSHIP ENGINE ---

function getStoreByExactSupplierNameInIndex(supplierVal) {
  if (!supplierVal || typeof supplierVal !== 'string' || !supplierVal.trim()) return null;
  const cleanTarget = supplierVal.trim().toLowerCase();
  const config = getShopifyConfig();
  const stores = Object.values(config).filter(s => s && s.url && s.token);

  const matches = stores.filter(s => {
    const sSupplier = (s.supplierName || '').trim().toLowerCase();
    return sSupplier === cleanTarget;
  });

  if (matches.length === 1) return matches[0];
  if (matches.length > 1) {
    log('WARN', `⚠️ Multiple stores configured with supplier name "${supplierVal}". Supplier ownership is not unique.`);
    return null;
  }

  const fallbackMatches = stores.filter(s => {
    const sName = (s.name || '').trim().toLowerCase();
    const sKey = (s.key || '').trim().toLowerCase();
    return sName === cleanTarget || sKey === cleanTarget;
  });

  if (fallbackMatches.length === 1) return fallbackMatches[0];
  if (fallbackMatches.length > 1) {
    log('WARN', `⚠️ Multiple stores matched fallback supplier identifier "${supplierVal}". Supplier ownership is not unique.`);
    return null;
  }

  log('WARN', `⚠️ No store found with configured supplier name matching "${supplierVal}".`);
  return null;
}

async function findVariantBySkuAndSupplierInIndex(store, sku, targetSupplier) {
  const cleanSku = sku.trim();
  const cleanTargetSupplier = targetSupplier.trim().toLowerCase();
  if (!cleanSku || !cleanTargetSupplier || !store || !store.url || !store.token) return null;
  const domain = cleanDomain(store.url);

  const query = `
    query findVariantAndSupplier($query: String!) {
      productVariants(first: 25, query: $query) {
        edges {
          node {
            id
            sku
            product {
              id
              status
              metafield(namespace: "custom", key: "supplier") {
                value
              }
            }
          }
        }
      }
    }
  `;

  try {
    const res = await axios.post(
      `https://${domain}/admin/api/2024-01/graphql.json`,
      { query, variables: { query: `sku:"${cleanSku.replace(/"/g, '\\"')}"` } },
      {
        headers: { 'X-Shopify-Access-Token': store.token },
        timeout: 8000
      }
    );

    const edges = res.data?.data?.productVariants?.edges || [];
    for (const edge of edges) {
      const vNode = edge.node;
      if (!vNode || !vNode.sku) continue;

      if (vNode.sku.trim().toLowerCase() === cleanSku.toLowerCase()) {
        const prod = vNode.product;
        const suppValue = prod?.metafield?.value ? String(prod.metafield.value).trim().toLowerCase() : '';

        if (suppValue === cleanTargetSupplier) {
          const variantGid = vNode.id;
          const productGid = prod?.id;
          return {
            variantId: variantGid ? variantGid.split('/').pop() : null,
            productId: productGid ? productGid.split('/').pop() : null,
            status: prod?.status,
            supplierMetafield: prod?.metafield?.value
          };
        }
      }
    }
  } catch (err) {
    log('WARN', `GraphQL variant + supplier search failed for SKU '${cleanSku}' on ${store.name}: ${err.message}`);
  }

  try {
    const restRes = await axios.get(
      `https://${domain}/admin/api/2024-01/products.json?limit=250&fields=id,status,variants`,
      {
        headers: { 'X-Shopify-Access-Token': store.token },
        timeout: 10000
      }
    );

    const products = restRes.data?.products || [];
    for (const prod of products) {
      const variants = prod.variants || [];
      const hasSku = variants.some(
        v => v.sku && v.sku.trim().toLowerCase() === cleanSku.toLowerCase()
      );

      if (hasSku) {
        const restDetails = await getProductDetails(store, String(prod.id));
        const mfValue = restDetails.metafield ? restDetails.metafield.trim().toLowerCase() : '';

        if (mfValue === cleanTargetSupplier) {
          const matchedVar = variants.find(
            v => v.sku && v.sku.trim().toLowerCase() === cleanSku.toLowerCase()
          );
          return {
            variantId: String(matchedVar.id),
            productId: String(prod.id),
            status: prod.status,
            supplierMetafield: restDetails.metafield || undefined
          };
        }
      }
    }
  } catch (err) {
    log('WARN', `REST variant + supplier fallback failed for SKU '${cleanSku}' on ${store.name}: ${err.message}`);
  }

  return null;
}

async function updateProductStatusToDraftInIndex(store, productId) {
  const domain = cleanDomain(store.url);
  const cleanId = String(productId).replace(/^gid:\/\/shopify\/Product\//, '');
  if (!cleanId) return false;

  const query = `
    mutation productUpdate($input: ProductInput!) {
      productUpdate(input: $input) {
        product {
          id
          status
        }
        userErrors {
          field
          message
        }
      }
    }
  `;

  const variables = {
    input: {
      id: `gid://shopify/Product/${cleanId}`,
      status: "DRAFT"
    }
  };

  try {
    const res = await axios.post(
      `https://${domain}/admin/api/2024-01/graphql.json`,
      { query, variables },
      {
        headers: { 'X-Shopify-Access-Token': store.token },
        timeout: 8000
      }
    );

    const userErrors = res.data?.data?.productUpdate?.userErrors || [];
    if (userErrors.length === 0 && res.data?.data?.productUpdate?.product) {
      return true;
    }
  } catch (err) {
    log('WARN', `GraphQL productUpdate failed for product ${cleanId} on ${store.name}: ${err.message}`);
  }

  try {
    await axios.put(
      `https://${domain}/admin/api/2024-01/products/${cleanId}.json`,
      { product: { id: cleanId, status: 'draft' } },
      {
        headers: { 'X-Shopify-Access-Token': store.token },
        timeout: 8000
      }
    );
    return true;
  } catch (err) {
    log('ERROR', `REST product status update failed for ${cleanId} on ${store.name}: ${err.message}`);
    return false;
  }
}

async function setMatchingProductsToDraftInIndex(excludeKeys, sku, targetSupplier) {
  const config = getShopifyConfig();
  const stores = Object.values(config).filter(s => s && s.url && s.token);
  const cleanExcludes = excludeKeys.map(k => k.toLowerCase());

  for (const store of stores) {
    const storeKey = store.key.toLowerCase();
    const storeDomain = cleanDomain(store.url).toLowerCase();
    if (cleanExcludes.includes(storeKey) || cleanExcludes.includes(storeDomain)) continue;

    try {
      const match = await findVariantBySkuAndSupplierInIndex(store, sku, targetSupplier);
      if (match && match.productId) {
        const success = await updateProductStatusToDraftInIndex(store, match.productId);
        if (success) {
          log('INFO', `📝 Set product status to 'DRAFT' for SKU '${sku}' (custom.supplier='${targetSupplier}', Product ID: ${match.productId}) on connected store '${store.name}'.`);
        }
      } else {
        log('INFO', `ℹ️ No matching product with SKU '${sku}' and custom.supplier='${targetSupplier}' found on '${store.name}'. Status unchanged.`);
      }
    } catch (err) {
      log('ERROR', `Failed to check/update product status for SKU '${sku}' on '${store.name}': ${err.message}`);
    }
  }
}

async function processDropship(order, sourceStore) {
  const orderName = order?.name || `#${order?.order_number || order?.id}`;
  log('INFO', `🔍 Evaluating Order ${orderName} from ${sourceStore.name} for product ownership & routing...`);

  const orderTags = (order?.tags || '').toLowerCase();
  const orderNote = (order?.note || '').toLowerCase();
  if (
    orderTags.includes('automated dropship') ||
    orderTags.includes('soldby') ||
    orderTags.includes('dropshipping') ||
    orderNote.includes('automated supplier order')
  ) {
    log('INFO', `🛑 Loop Protection: Order ${orderName} is a supplier-generated order. Skipping routing.`);
    return;
  }

  const lineItems = order?.line_items || [];
  log('INFO', `Order ${orderName} contains ${lineItems.length} line item(s).`);

  const ownerOrdersMap = new Map();

  for (const item of lineItems) {
    const sku = item.sku ? item.sku.trim() : '';
    if (!sku) {
      log('WARN', `Line item '${item.title}' in order ${orderName} has NO SKU. Skipping.`);
      continue;
    }

    const productInfo = await getProductDetails(sourceStore, item.product_id);
    let customSupplier = productInfo.metafield;

    if (!customSupplier && productInfo.tags) {
      const match = productInfo.tags.match(/^(?:Supplier|supplier)[:_\s]+(.+)$/i);
      if (match && match[1]) customSupplier = match[1].trim();
    }

    log('INFO', `Inspecting line item SKU: '${sku}' -> custom.supplier: "${customSupplier || 'None'}"`);

    if (!customSupplier) {
      log('WARN', `⚠️ Cannot identify supplier ownership for SKU '${sku}': custom.supplier metafield is missing. Skipping automatic routing.`);
      continue;
    }

    const ownerStore = getStoreByExactSupplierNameInIndex(customSupplier);

    if (!ownerStore) {
      log('WARN', `⚠️ Supplier ownership for custom.supplier="${customSupplier}" on SKU '${sku}' cannot be identified uniquely among connected stores. Skipping automatic routing.`);
      continue;
    }

    const isOwnerSale = (cleanDomain(sourceStore.url).toLowerCase() === cleanDomain(ownerStore.url).toLowerCase());

    if (isOwnerSale) {
      log('INFO', `✓ SCENARIO 1 (Owner Sale): Store '${sourceStore.name}' (Supplier: ${sourceStore.supplierName}) sold its own product SKU '${sku}' (custom.supplier='${customSupplier}'). Keeping original order on ${sourceStore.name}. No supplier order created.`);
      await setMatchingProductsToDraftInIndex([sourceStore.key, sourceStore.url], sku, customSupplier);
    } else {
      log('INFO', `⚡ SCENARIO 2 (Non-Owner Sale): Store '${sourceStore.name}' sold SKU '${sku}' belonging to Owner Store '${ownerStore.name}' (custom.supplier='${customSupplier}').`);

      if (!ownerOrdersMap.has(ownerStore.key)) {
        ownerOrdersMap.set(ownerStore.key, { ownerStore, items: [] });
      }
      ownerOrdersMap.get(ownerStore.key).items.push({
        sku,
        quantity: item.quantity || 1,
        title: item.title,
        supplier: customSupplier
      });

      await setMatchingProductsToDraftInIndex([sourceStore.key, sourceStore.url, ownerStore.key, ownerStore.url], sku, customSupplier);
    }
  }

  for (const [ownerKey, { ownerStore, items }] of ownerOrdersMap.entries()) {
    log('INFO', `🚀 Creating Supplier Order on Owner Store '${ownerStore.name}' for ${items.length} item(s)...`);
    await createOrderOnOwnerStoreInIndex(ownerStore, sourceStore, items, orderName, order);
  }
}

async function createOrderOnOwnerStoreInIndex(ownerStore, sellingStore, items, sourceOrderName, originalOrder) {
  const domain = cleanDomain(ownerStore.url);
  const lineItemsPayload = [];

  for (const item of items) {
    const match = await findVariantBySkuAndSupplierInIndex(ownerStore, item.sku, item.supplier);
    if (match && match.variantId) {
      const parsedId = parseInt(match.variantId, 10);
      lineItemsPayload.push({
        variant_id: isNaN(parsedId) ? match.variantId : parsedId,
        quantity: item.quantity
      });
      log('INFO', `✓ Matched SKU '${item.sku}' + custom.supplier='${item.supplier}' on Owner Store ${ownerStore.name} -> Variant ID: ${match.variantId}`);
    } else {
      log('ERROR', `❌ SKU '${item.sku}' with custom.supplier='${item.supplier}' NOT FOUND on Owner Store ${ownerStore.name}.`);
    }
  }

  if (lineItemsPayload.length === 0) {
    log('ERROR', `❌ None of the SKUs matching custom.supplier could be resolved on owner store ${ownerStore.name}.`);
    return;
  }

  const sellerEmail = sellingStore.ownerEmail && sellingStore.ownerEmail.includes('@')
    ? sellingStore.ownerEmail
    : 'seller@dropship-sync.com';

  const sellingStoreName = sellingStore.name || `Store ${sellingStore.supplierName || sellingStore.key}`;

  let soldByTag = `SOLDby${sellingStoreName.replace(/\s+/g, '')}`;
  if (
    sellingStore.key === 'STORE_B' ||
    sellingStoreName.toLowerCase().includes('store b') ||
    (sellingStore.url && sellingStore.url.includes('hamza'))
  ) {
    soldByTag = 'SOLDbyStoreB';
  }

  let shippingAddress = sellingStore.address || {
    first_name: sellingStoreName,
    last_name: "(Selling Store Owner)",
    address1: "Store Address",
    city: "Lahore",
    country: "PK",
    zip: "54000"
  };

  if (originalOrder && originalOrder.shipping_address) {
    shippingAddress = originalOrder.shipping_address;
  }

  const orderPayload = {
    order: {
      line_items: lineItemsPayload,
      customer: {
        first_name: sellingStoreName,
        last_name: "(Selling Store Owner)",
        email: sellerEmail
      },
      email: sellerEmail,
      shipping_address: shippingAddress,
      billing_address: shippingAddress,
      source_name: "Dropshipping",
      tags: `${soldByTag}, Automated Dropship, Dropshipping, Soldby-${sellingStore.supplierName || sellingStoreName}`,
      financial_status: "pending",
      inventory_behaviour: "decrement_obeying_policy",
      note: `Automated supplier order placed by selling store ${sellingStoreName} (${sellingStore.url}) for original order #${sourceOrderName}.`
    }
  };

  try {
    const res = await axios.post(`https://${domain}/admin/api/2024-01/orders.json`, orderPayload, {
      headers: { 'X-Shopify-Access-Token': ownerStore.token },
      timeout: 10000
    });

    const newOrder = res.data?.order;
    const orderName = newOrder?.name || `#${newOrder?.order_number || newOrder?.id}`;
    log('INFO', `🎉 SUCCESS! Created Order ${orderName} (Tag: ${soldByTag}) on Owner Store ${ownerStore.name} for original order #${sourceOrderName}`);
  } catch (e) {
    const detail = e.response ? JSON.stringify(e.response.data) : e.message;
    log('ERROR', `❌ Failed to create order on owner store ${ownerStore.name}: ${detail}`);
  }
}

// Start local server if directly executed
if (require.main === module) {
  app.listen(PORT, () => log('INFO', `Server running on port ${PORT}`));
}

module.exports = app;