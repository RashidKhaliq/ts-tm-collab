import { defaultDiscountPercent, liveWrites, norm, soldTag } from './config.js';
import * as shopify from './shopify.js';
import * as db from './db.js';

export function isInternalOrder(order) {
  const tags=String(order.tags||'').split(',').map(s=>s.trim());
  return tags.includes('Dropshipped_Order') || tags.some(s=>s.startsWith('TS_'));
}

export function getOwner(stores, supplier) {
  const owner=stores.find(s=>norm(s.supplier)===norm(supplier));
  if (!owner) throw new Error(`No owner configured for custom.supplier=${supplier}`);
  return owner;
}

export function physicalKey(owner, sku) {
  return `${owner.key}:${norm(sku)}`;
}

export async function processOrder(job, stores, deps={db,shopify,liveWrites}) {
  const database=deps.db, api=deps.shopify, live=deps.liveWrites;
  const seller=stores.find(s=>s.key===job.selling_key);
  if (!seller) throw new Error(`Selling store ${job.selling_key} not configured`);
  const order=job.payload;
  if (isInternalOrder(order)) return {skipped:'Internal dropship order ignored'};
  const originalLines=(order.line_items||[]).filter(line=>line.variant_id && line.sku);
  if (!originalLines.length) return {skipped:'No physical Shopify line items with SKU'};

  // Search only the SKUs in this order, on demand. Never import entire catalog.
  const entries=[];
  for (const line of originalLines) {
    const soldVariant=await api.fetchSourceVariant(seller,line.variant_id);
    if (!soldVariant) throw new Error(`Source variant ${line.variant_id} missing in store ${seller.key}`);
    if (norm(soldVariant.sku)!==norm(line.sku)) throw new Error(`SKU mismatch between order and source variant: ${line.sku}`);
    const supplier=soldVariant.product?.metafield?.value;
    if (!supplier) throw new Error(`Missing product metafield custom.supplier for SKU ${line.sku} on ${seller.key}`);
    const owner=getOwner(stores,supplier);
    if (Number(line.quantity)!==1) throw new Error(`Item ${line.sku}: expected thrift quantity 1; got ${line.quantity}`);
    const variants=new Map();
    for (const store of stores) {
      if (store.key===seller.key) { variants.set(store.key,soldVariant); continue; }
      const found=await api.findMatchingVariant(store,line.sku,supplier);
      if (found) variants.set(store.key,found);
    }
    if (!variants.has(owner.key)) throw new Error(`Original owner store ${owner.key} does not have matching SKU ${line.sku} + supplier ${supplier}`);
    entries.push({line,owner,sku:line.sku,variants,key:physicalKey(owner,line.sku)});
  }
  if (!live) {
    for (const entry of entries) await database.log(job.job_key,'INFO',`DRY RUN ${entry.sku}: owner ${entry.owner.key}; linked ${[...entry.variants.keys()].join(', ')}`);
    return {dryRun:true, items:entries.length};
  }
  if (new Set(entries.map(x=>x.key)).size!==entries.length) throw new Error('Order repeats same physical SKU + supplier; manual review required');
  await database.claimAll(entries.map(x=>x.key),job.job_key);

  const saleTag=soldTag(seller.name);

  // Capture pre-sale state before making Shopify changes
  const snapshots=[];
  for (const entry of entries) {
    for (const store of stores) {
      if (!entry.variants.has(store.key)) continue;
      const v=entry.variants.get(store.key);
      const prevQuantities=(v.inventoryItem?.inventoryLevels?.nodes||[]).map(lvl=>({
        locationId:lvl.location?.id,
        quantity:lvl.quantities?.find(q=>q.name==='available')?.quantity??0
      })).filter(q=>q.locationId);
      snapshots.push({
        job_key:job.job_key,
        order_id:String(order.id),
        selling_key:seller.key,
        store_key:store.key,
        product_id:v.product.id,
        variant_id:v.id,
        sku:entry.sku,
        item_key:entry.key,
        previous_status:v.product.status||'ACTIVE',
        previous_quantities:prevQuantities,
        sold_tag:saleTag
      });
    }
  }
  if (database.saveSnapshots) {
    await database.saveSnapshots(snapshots);
  }

  // Immediately prevent a second sale. For cross-store items, keep owner inventory
  // unchanged until orderCreate claims it. Product can be drafted first.
  for (const entry of entries) {
    for (const store of stores) {
      if (!entry.variants.has(store.key)) continue;
      const current=await api.findMatchingVariant(store,entry.sku,entry.owner.supplier);
      if (!current) throw new Error(`Linked product disappeared from ${store.key}: ${entry.sku}`);
      const draftOnly=entry.owner.key!==seller.key && store.key===entry.owner.key;
      await api.markSold(store,current,saleTag,`${job.job_key}|${entry.key}`,{draftOnly});
      await database.log(job.job_key,'OK',`${store.key} ${entry.sku} + ${entry.owner.supplier}: DRAFT / ${saleTag} / ${draftOnly?'owner stock held for orderCreate':'Qty 0'}`);
    }
  }

  // Configurable dropship discount percentage
  const configuredDiscount=database.getSetting ? await database.getSetting('discount_percent') : null;
  const discountPercent=(configuredDiscount!==null && configuredDiscount!==undefined && configuredDiscount!=='')
    ? Number(configuredDiscount)
    : defaultDiscountPercent;

  // One supplier order per owner, with all of that owner's items.
  const owners=[...new Set(entries.filter(e=>e.owner.key!==seller.key).map(e=>e.owner.key))];
  for (const ownerKey of owners) {
    const owner=stores.find(s=>s.key===ownerKey);
    const lines=entries.filter(e=>e.owner.key===ownerKey);
    const tag=api.referenceTag(seller.key,order.id,ownerKey);
    let supplierOrder=await database.lookupSupplierOrder(job.job_key,ownerKey);
    if (!supplierOrder) {
      supplierOrder=await api.findExistingSupplierOrder(owner,tag);
      if (supplierOrder) await database.saveSupplierOrder(job.job_key,ownerKey,supplierOrder);
    }
    if (!supplierOrder) {
      for (const e of lines) {
        const v=await api.findMatchingVariant(owner,e.sku,owner.supplier);
        if (!v) throw new Error(`Owner item not found: ${owner.key}/${e.sku}`);
        const onHand=(v.inventoryItem?.inventoryLevels?.nodes||[]).reduce((n,x)=>n+(x.quantities.find(q=>q.name==='available')?.quantity||0),0);
        if (v.inventoryItem?.tracked && onHand<1) throw new Error(`Owner ${owner.key} SKU ${e.sku} has no stock; refusing supplier order`);
      }
      supplierOrder=await api.createSupplierOrder(owner,seller,order,lines.map(e=>({
        variantId:e.variants.get(owner.key).id,quantity:1,sku:e.sku
      })),tag,discountPercent);
      await database.saveSupplierOrder(job.job_key,ownerKey,supplierOrder);
      await database.log(job.job_key,'OK',`Owner ${owner.key}: supplier order ${supplierOrder} created (${discountPercent}% + free shipping)`);
    }
    // Owner order has now decremented inventory. Force any remaining available qty to 0.
    for (const e of lines) {
      const current=await api.findMatchingVariant(owner,e.sku,owner.supplier);
      if (!current) throw new Error(`Owner product disappeared after supplier order: ${e.sku}`);
      await api.markSold(owner,current,saleTag,`${job.job_key}|${e.key}`);
    }
  }
  return {processed:entries.length,tag:saleTag};
}

export async function processCancellation(job, stores, deps={db,shopify,liveWrites}) {
  const database=deps.db, api=deps.shopify, live=deps.liveWrites;
  const order=job.payload;
  if (isInternalOrder(order)) return {skipped:'Internal dropship order ignored'};

  const orderId=String(job.order_id || order.id);
  const snapshots=database.getSnapshotsForOrder ? await database.getSnapshotsForOrder(orderId) : [];

  if (!snapshots || !snapshots.length) {
    const msg=`No pre-sale snapshot found for cancelled order ${orderId}; historical orders cannot be safely auto-restored.`;
    await database.log(job.job_key,'INFO',msg);
    return {skipped:msg};
  }

  if (!live) {
    await database.log(job.job_key,'INFO',`DRY RUN: Cancellation for order ${orderId}; would restore ${snapshots.length} listings across stores`);
    return {dryRun:true,restored:snapshots.length};
  }

  for (const snapshot of snapshots) {
    const store=stores.find(s=>s.key===snapshot.store_key);
    if (!store) {
      await database.log(job.job_key,'WARN',`Store ${snapshot.store_key} not configured; skipping restore for SKU ${snapshot.sku}`);
      continue;
    }
    await api.restoreProductState(store,snapshot,`${job.job_key}|${snapshot.id || snapshot.item_key}`);
    await database.log(job.job_key,'OK',`Restored ${store.key} ${snapshot.sku}: status ${snapshot.previous_status}, removed ${snapshot.sold_tag}, restored inventory`);
  }

  const itemKeys=[...new Set(snapshots.map(s=>s.item_key).filter(Boolean))];
  if (database.releaseClaims) {
    await database.releaseClaims(itemKeys);
    await database.log(job.job_key,'OK',`Released internal claims for: ${itemKeys.join(', ')}`);
  }

  return {cancelled:true,restored:snapshots.length,orderId};
}

export async function runQueue(stores, limit=3) {
  await db.ensureSchema();
  const results=[];
  for (let i=0;i<Math.min(limit,10);i++) {
    const job=await db.takeJob();
    if (!job) break;
    const isCancel=job.job_key.startsWith('CANCEL:') || (job.order_name && job.order_name.startsWith('[CANCEL]'));
    try {
      if (isCancel) {
        const result=await processCancellation(job,stores);
        await db.finishJob(job.job_key,result.dryRun?'DRY_RUN':'CANCELLED');
        await db.log(job.job_key,'OK',JSON.stringify(result));
        results.push({job:job.job_key,result});
      } else {
        const result=await processOrder(job,stores);
        await db.finishJob(job.job_key,result.dryRun?'DRY_RUN':'DONE');
        await db.log(job.job_key,'OK',JSON.stringify(result));
        results.push({job:job.job_key,result});
      }
    } catch(e) {
      await db.finishJob(job.job_key,'ERROR',e.message);
      await db.log(job.job_key,'ERROR',e.message);
      results.push({job:job.job_key,error:e.message});
    }
  }
  return results;
}
