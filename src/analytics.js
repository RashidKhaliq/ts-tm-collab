import { getStores, norm } from './config.js';
import * as db from './db.js';
import {fetchShopifyQL,fetchCatalogPage,graphql} from './shopify.js';

function day(offset=0) {const d=new Date();d.setUTCDate(d.getUTCDate()+offset);return d.toISOString().slice(0,10);}
export function dateRange(input={}) {
  const preset=String(input.period||'30');
  let from,to;
  if(preset==='today'){from=to=day(0);}
  else if(preset==='yesterday'){from=to=day(-1);}
  else if(preset==='7'){from=day(-6);to=day(0);}
  else if(preset==='90'){from=day(-89);to=day(0);}
  else if(preset==='custom') {from=String(input.from||'');to=String(input.to||'');}
  else if(preset==='365'){from=day(-364);to=day(0);}
  else {from=day(-29);to=day(0);}
  if(!/^\d{4}-\d{2}-\d{2}$/.test(from)||!/^\d{4}-\d{2}-\d{2}$/.test(to)||
  Number.isNaN(Date.parse(from))||Number.isNaN(Date.parse(to))||from>to||from<day(-370)||to>day(0))
    throw new Error('Invalid date range; select dates within the last 12 months');
  return {from,to};
}
export function sqlForSales({from,to},group='type') {
  const dimension=group==='brand'?'product.metafields.custom.brand':'product_type';
  return `FROM sales SHOW total_sales, net_items_sold GROUP BY product.metafields.custom.supplier, ${dimension} WITH TOTALS SINCE ${from} UNTIL ${to} ORDER BY total_sales DESC`;
}
function scalar(o, names) {for(const name of names) if(o?.[name]!==undefined)return o[name];return null;}
function numeric(v) {const n=Number(v);return Number.isFinite(n)?n:0;}
const groupKey=(type,brand,group)=>group==='brand'?(brand||'Unbranded'):(type||'Uncategorized');
function matching(v,filter) {return !filter||filter==='all'||v===filter;}
function snapshotKey(o) {return [norm(o.supplier),norm(o.sku)].join('|');}

export async function syncCatalog(store, pages=2, reset=false) {
  await db.ensureSchema();
  const cursorInfo=await db.getCursor(store.key);
  let cursor=reset?null:cursorInfo.cursor||null;
  let count=0,completed=false;
  for(let page=0;page<Math.min(20,Math.max(1,pages));page++) {
    const batch=await fetchCatalogPage(store,cursor);
    for(const v of batch.nodes) {
      const supplier=v.product?.metafield?.value||'';
      const owner=getStores().find(s=>norm(s.supplier)===norm(supplier));
      await db.inventoryUpsert(store.key,{
        variantId:v.id,sku:v.sku,supplier,ownerKey:owner?.key||'',brand:v.product?.brand?.value||'',
        type:v.product?.productType||'',quantity:Math.max(0,Number(v.inventoryQuantity)||0),
        price:Number(v.price)||0,status:v.product?.status||'ACTIVE'
      }); count++;
    }
    completed=!batch.pageInfo.hasNextPage;
    cursor=completed?null:batch.pageInfo.endCursor;
    await db.saveCursor(store.key,cursor);
    if(completed)break;
  }
  return {store:store.name,processed:count,completed,nextCursor:cursor};
}
// Compact historical backfill: one bounded Shopify request at a time, no full order list in memory.
// This is manually initiated; Shopify may require read_all_orders for >60d history.
export async function backfillOrders(store,cursor=null,months=12) {
  const since=new Date();since.setUTCMonth(since.getUTCMonth()-Math.min(12,Math.max(1,Number(months)||12)));
  const data=await graphql(store,`query($q:String!,$cursor:String){orders(first:25,query:$q,after:$cursor,sortKey:CREATED_AT,reverse:false){
    nodes{id name createdAt cancelledAt currencyCode tags lineItems(first:100){nodes{id quantity originalUnitPriceSet{shopMoney{amount}} sku variant{sku product{productType brand:metafield(namespace:"custom",key:"brand"){value} supplier:metafield(namespace:"custom",key:"supplier"){value}}}}}}
    pageInfo{endCursor hasNextPage}}}`,{q:`created_at:>=${since.toISOString().slice(0,10)}`,cursor});
  const stores=getStores();let imported=0;
  for(const order of data.orders.nodes){
    const internal=order.tags.some(t=>t==='Dropshipped_Order'||t==='StockBridgeInternal'||t.startsWith('TS_'));
    for(const line of order.lineItems.nodes){
      const supplier=line.variant?.product?.supplier?.value||'';
      const owner=stores.find(s=>norm(s.supplier)===norm(supplier));
      await db.upsertSale({storeKey:store.key,orderId:order.id,lineId:line.id,date:order.createdAt,
        sku:line.sku||line.variant?.sku||'',supplier,ownerKey:owner?.key||'',type:line.variant?.product?.productType||'',
        brand:line.variant?.product?.brand?.value||'',qty:line.quantity,value:line.quantity*numeric(line.originalUnitPriceSet?.shopMoney?.amount),
        currency:order.currencyCode,internal,cancelled:!!order.cancelledAt});imported++;
    }
  }
  return {store:store.name,imported,orders:data.orders.nodes.length,completed:!data.orders.pageInfo.hasNextPage,nextCursor:data.orders.pageInfo.endCursor};
}
async function shopReport(store,range,group){
  const key=`shopql:${store.key}:${range.from}:${range.to}:${group}`;
  const ttl=Number(await db.getSetting('analyticsCacheSeconds',900));
  const cached=(await db.query(`SELECT result FROM sb_report_cache WHERE cache_key=$1 AND fetched_at>now()-($2::int*interval '1 second')`,[key,ttl])).rows[0];
  if(cached)return cached.result;
  const data=await fetchShopifyQL(store,sqlForSales(range,group));
  await db.query(`INSERT INTO sb_report_cache(cache_key,result) VALUES($1,$2::jsonb) ON CONFLICT(cache_key)
    DO UPDATE SET result=$2::jsonb,fetched_at=now()`,[key,JSON.stringify(data)]);
  return data;
}
export async function analytics(input={}) {
  await db.ensureSchema();
  const stores=getStores();
  const range=dateRange(input);
  const group=input.group==='brand'?'brand':'type';
  const sellerKey=String(input.selling||'all');const ownerKey=String(input.owner||'all');
  const typeFilter=String(input.type||'all');const brandFilter=String(input.brand||'all');
  const selected=stores.filter(s=>matching(s.key,sellerKey));
  const warnings=[];
  const rows=new Map();
  function record(seller,owner,type,brand,inc) {
    if(!matching(owner,ownerKey)||!matching(type,typeFilter)||!matching(brand,brandFilter))return;
    const key=[seller,owner,groupKey(type,brand,group)].join('|');
    const r=rows.get(key)||{sellingStore:seller,ownerStore:owner,group:groupKey(type,brand,group),available:0,stockValue:0,sold:0,salesValue:0};
    for(const [k,v] of Object.entries(inc))r[k]=(r[k]||0)+numeric(v);
    rows.set(key,r);
  }
  const sales=(await db.query(`SELECT store_key,owner_key,product_type,brand,SUM(quantity) sold,SUM(gross_value) val
     FROM sb_sales WHERE order_date >= $1::date AND order_date < ($2::date + interval '1 day')
       AND NOT cancelled AND NOT is_internal GROUP BY store_key,owner_key,product_type,brand`,[range.from,range.to])).rows;
  const salesByStore=new Map();
  for(const s of sales)salesByStore.set(s.store_key,(salesByStore.get(s.store_key)||0)+1);
  const sources={};
  for(const store of selected) {
    // ShopifyQL is used for a store with no local ledger, otherwise the ledger
    // explicitly excludes synthetic supplier orders and avoids double-counting.
    if(!salesByStore.get(store.key)) {
      try{
        const report=await shopReport(store,range,group);
        let used=0;
        for(const row of report.rows||[]){
          const supplier=scalar(row,['product_metafields_custom_supplier','product.metafields.custom.supplier']);
          const type=group==='type'?String(scalar(row,['product_type'])||''):'';
          const brand=group==='brand'?String(scalar(row,['product_metafields_custom_brand','product.metafields.custom.brand'])||''):'';
          // GROUP TOTALS/TOTALS rows are ignored; adding them double counts.
          if(!supplier||supplier==='TOTAL'||(group==='type'&&!type)||(group==='brand'&&!brand))continue;
          const owner=stores.find(s=>norm(s.supplier)===norm(supplier));
          if(!owner)continue;
          record(store.key,owner.key,type,brand,{sold:numeric(scalar(row,['net_items_sold'])),salesValue:numeric(scalar(row,['total_sales']))});used++;
        }
        sources[store.key]='ShopifyQL';
        if(!used)warnings.push(`${store.name}: ShopifyQL returned no supplier group rows for selected dates`);
      }catch(e){sources[store.key]='Ledger (empty)';warnings.push(`${store.name}: ShopifyQL unavailable: ${e.message}`);}
    }else{
      sources[store.key]='Local order ledger (gross line value)';
      for(const item of sales.filter(x=>x.store_key===store.key))
        record(store.key,item.owner_key||'',item.product_type||'',item.brand||'',{sold:item.sold,salesValue:item.val});
    }
  }
  // Quantity is a CURRENT listing snapshot, not a historical stock as-of snapshot.
  // When selling store=All, count each physical SKU + supplier once from owner store.
  const inventory=(await db.query(`SELECT * FROM sb_inventory WHERE status='ACTIVE' AND quantity>0`,[])).rows;
  const seen=new Set();
  for(const item of inventory){
    if(!selected.some(s=>s.key===item.store_key))continue;
    if(sellerKey==='all') {
      if(item.owner_key!==item.store_key)continue; // never sum shared listings as duplicate physical stock
      const unique=snapshotKey(item);if(seen.has(unique))continue;seen.add(unique);
    }
    record(item.store_key,item.owner_key||'',item.product_type||'',item.brand||'',{available:item.quantity,stockValue:item.quantity*numeric(item.price)});
  }
  const result=[...rows.values()].sort((a,b)=>(b.salesValue+b.stockValue)-(a.salesValue+a.stockValue));
  const totals=result.reduce((a,x)=>({available:a.available+x.available,stockValue:a.stockValue+x.stockValue,sold:a.sold+x.sold,salesValue:a.salesValue+x.salesValue}),{available:0,stockValue:0,sold:0,salesValue:0});
  const filters={types:[...new Set(inventory.map(x=>x.product_type).filter(Boolean))].sort(),brands:[...new Set(inventory.map(x=>x.brand).filter(Boolean))].sort()};
  if(Object.values(sources).some(x=>x==='ShopifyQL')&&Object.values(sources).some(x=>x.includes('Ledger')))warnings.push('Different sales sources use different definitions: ShopifyQL total_sales vs ledger gross line value. Run 12-month backfill on all stores for consistent ledger comparisons.');
  warnings.push('Stock quantity/value are current snapshots, not historical end-of-period inventory. Catalog sync required for accurate stock values.');
  return {range,group,filters,stores:stores.map(s=>({key:s.key,name:s.name})),rows:result,totals,
    sellThrough:totals.sold+totals.available?totals.sold/(totals.sold+totals.available)*100:0,
    sources,warnings};
}
export function csvFromRows(rows){
  const cols=['sellingStore','ownerStore','group','available','stockValue','sold','salesValue'];
  const esc=x=>'"'+String(x??'').replaceAll('"','""')+'"';
  return [cols.join(','),...rows.map(row=>cols.map(c=>esc(row[c])).join(','))].join('\r\n');
}
