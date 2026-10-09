import {query,transaction,audit} from './db.js';
import {checkListing,draftAndTag,restoreStatus,removeTags,createSupplierOrder,findOrderByReference} from './shopify.js';
const live=()=>process.env.LIVE_WRITES==='true';
const sellerTag=(s)=>'Soldby_'+s.replace(/[^a-zA-Z0-9_-]/g,'_');
async function getLinks(itemId){return (await query(`SELECT l.*,s.name,s.domain,s.encrypted_token,s.active,s.supplier_code FROM listings l JOIN stores s ON s.id=l.store_id WHERE l.item_id=$1 ORDER BY l.store_id`,[itemId])).rows;}
async function loadStore(id){return (await query('SELECT * FROM stores WHERE id=$1 AND active=true',[id])).rows[0];}
async function applySale(sale,sourceOrder){
 const links=await getLinks(sale.item_id);const seller=await loadStore(sale.selling_store_id);const item=(await query('SELECT * FROM items WHERE id=$1',[sale.item_id])).rows[0];const owner=await loadStore(item.owner_store_id);
 if(!seller||!owner)throw new Error('Store disconnected');
 // Always make linked products unavailable, even when supplier order fails. Retries are idempotent.
 let syncErrors=[];
 for(const link of links){
  if(link.sync_state==='DRAFTED')continue;
  try{if(live())await draftAndTag(link,link.product_gid,seller.name);
   await query('UPDATE listings SET sync_state=$2,last_error=NULL WHERE id=$1',[link.id,live()?'DRAFTED':'DRY_RUN']);
  }catch(e){syncErrors.push(`${link.name}: ${e.message}`);await query('UPDATE listings SET sync_state=$2,last_error=$3 WHERE id=$1',[link.id,'FAILED',e.message.slice(0,600)]);}
 }
 if(syncErrors.length)throw new Error('Draft failures: '+syncErrors.join('; '));
 if(owner.id!==seller.id){
  const supplierListing=links.find(l=>l.store_id===owner.id);
  if(!supplierListing)throw new Error('Owner listing missing');
  const reference=`TS_${sale.id.replace(/-/g,'')}`;
  const existing=sale.owner_order_gid?{id:sale.owner_order_gid}: (live()?await findOrderByReference(owner,reference):null);
  if(existing?.id){await query('UPDATE sales SET owner_order_gid=$2 WHERE id=$1',[sale.id,existing.id]);}
  else if(live()){
   const order=await createSupplierOrder(owner,supplierListing.variant_gid,sourceOrder,seller,reference);
   await query('UPDATE sales SET owner_order_gid=$2 WHERE id=$1',[sale.id,order.id]);
  }
 }
 await query('UPDATE sales SET workflow_state=$2,workflow_error=NULL WHERE id=$1',[sale.id,live()?'DONE':'DRY_RUN']);
 await query('UPDATE items SET status=$2,updated_at=now() WHERE id=$1',[sale.item_id,live()?'SOLD':'RESERVED']);
 await audit('INFO','ORDER_SYNC',live()?'Sale processed':'Dry-run: sale reserved; no Shopify writes',{itemId:sale.item_id,storeId:seller.id,details:{sale_id:sale.id}});
}
async function reserve(itemId,sellerId,order,line){
 return transaction(async db=>{
  const {rows:[item]}=await db.query('SELECT * FROM items WHERE id=$1 FOR UPDATE',[itemId]);if(!item)throw new Error('Physical item not found');
  const existing=(await db.query('SELECT * FROM sales WHERE selling_store_id=$1 AND source_order_id=$2 AND source_line_id=$3',[sellerId,String(order.id),String(line.id)])).rows[0];
  if(existing)return {sale:existing,reused:true};
  if(item.status!=='AVAILABLE')return {rejected:true,reason:`Already ${item.status}`,item};
  const {rows:[sale]}=await db.query(`INSERT INTO sales(item_id,selling_store_id,source_order_id,source_order_name,source_line_id) VALUES($1,$2,$3,$4,$5) RETURNING *`,[itemId,sellerId,String(order.id),String(order.name||order.id),String(line.id)]);
  await db.query(`UPDATE items SET status='RESERVED',reserved_by=$2,source_order_key=$3,reservation_at=now(),updated_at=now() WHERE id=$1`,[itemId,sellerId,`${sellerId}:${order.id}`]);
  return {sale,reused:false};
 });
}
export async function onOrderCreated(store,event){
 if(String(event.tags||'').split(',').some(t=>t.trim()==='Dropshipped_Order'))return;
 for(const line of event.line_items||[]){
  const link=(await query('SELECT * FROM listings WHERE store_id=$1 AND variant_gid=$2',[store.id,`gid://shopify/ProductVariant/${line.variant_id}`])).rows[0];
  if(!link)continue;
  const {sale,rejected,reused,reason}=await reserve(link.item_id,store.id,event,line);
  if(rejected){await audit('ERROR','OVERSALE','Conflicting checkout: '+reason,{itemId:link.item_id,storeId:store.id,details:{source_order_id:event.id,line_id:line.id}});continue;}
  if(reused&&sale.workflow_state==='DONE')continue;
  try{await applySale(sale,event);}catch(e){await query("UPDATE sales SET workflow_state='FAILED',workflow_error=$2 WHERE id=$1",[sale.id,e.message.slice(0,1200)]);throw e;}
 }
}
export async function onOrderCancelled(store,event){
 const sales=(await query('SELECT * FROM sales WHERE selling_store_id=$1 AND source_order_id=$2',[store.id,String(event.id)])).rows;
 for(const sale of sales){
  const prior=await transaction(async db=>{
   const {rows:[item]}=await db.query('SELECT * FROM items WHERE id=$1 FOR UPDATE',[sale.item_id]);
   if(item.source_order_key!==`${store.id}:${event.id}`||!['SOLD','RESERVED'].includes(item.status))return false;
   await db.query("UPDATE items SET status='REVIEW',updated_at=now() WHERE id=$1",[item.id]);return true;
  });if(!prior)continue;
  // Do not automatically restore: supplier order may already be shipped or fulfilled.
  await query("UPDATE sales SET workflow_state='CANCEL_REVIEW' WHERE id=$1",[sale.id]);
  await audit('WARN','CANCEL_REVIEW','Original order cancelled. Manual verification required before relisting or cancelling supplier order.',{itemId:sale.item_id,storeId:store.id,details:{order_id:event.id,sale_id:sale.id}});
 }
}
export async function handleEvent(event){
 const store=await loadStore(event.store_id);if(!store)throw new Error('Store missing/disconnected');
 switch(event.topic){case 'orders/create':return onOrderCreated(store,event.payload);case 'orders/cancelled':return onOrderCancelled(store,event.payload);default:return;}
}
export async function runWorker(limit=10){
 const results=[];
 for(let i=0;i<Math.min(limit,30);i++){
  const record=await transaction(async db=>{
   const {rows:[event]}=await db.query(`SELECT * FROM incoming_events WHERE (state IN ('PENDING','FAILED') AND retry_at<=now() OR state='PROCESSING' AND locked_at<now()-interval '5 minutes') AND attempts<8 ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1`);
   if(!event)return null;
   await db.query("UPDATE incoming_events SET state='PROCESSING',attempts=attempts+1,locked_at=now() WHERE id=$1",[event.id]);return event;
  });if(!record)break;
  try{await handleEvent(record);await query("UPDATE incoming_events SET state='DONE',last_error=NULL WHERE id=$1",[record.id]);results.push({id:record.id,state:'DONE'});}
  catch(e){const attempts=record.attempts+1;const minutes=Math.min(60,2**Math.min(attempts,6));await query("UPDATE incoming_events SET state='FAILED',last_error=$2,retry_at=now()+($3||' minutes')::interval WHERE id=$1",[record.id,e.message.slice(0,1200),minutes]);await audit('ERROR','WORKER',e.message,{storeId:record.store_id,details:{event_id:record.id}});results.push({id:record.id,state:'FAILED',error:e.message});}
 }
 return results;
}
export async function retrySale(saleId){
 const sale=(await query('SELECT * FROM sales WHERE id=$1',[saleId])).rows[0];if(!sale)throw new Error('Sale not found');
 if(!['FAILED','RESERVED','DRY_RUN'].includes(sale.workflow_state))throw new Error('Sale is not retryable');
 const store=await loadStore(sale.selling_store_id);
 const events=(await query("SELECT payload FROM incoming_events WHERE store_id=$1 AND topic='orders/create' AND payload->>'id'=$2 ORDER BY created_at DESC LIMIT 1",[store.id,sale.source_order_id])).rows;
 if(!events.length)throw new Error('Original order payload unavailable');
 await applySale(sale,events[0].payload);
}
export async function approveRestore(itemId){
 const item=(await query('SELECT * FROM items WHERE id=$1',[itemId])).rows[0];if(!item||item.status!=='REVIEW')throw new Error('Item not awaiting review');
 const links=await getLinks(itemId);const seller=await loadStore(item.reserved_by);
 for(const link of links){
  if(live()){await restoreStatus(link,link.product_gid,link.original_status);if(seller)await removeTags(link,link.product_gid,[sellerTag(seller.name)]);}
  await query('UPDATE listings SET sync_state=$2,last_error=NULL WHERE id=$1',[link.id,live()?'RESTORED':'DRY_RUN']);
 }
 if(live()){await query("UPDATE items SET status='AVAILABLE',source_order_key=NULL,reserved_by=NULL,sold_by=NULL,reservation_at=NULL,updated_at=now() WHERE id=$1",[itemId]);}
 await audit('WARN','MANUAL_RESTORE',live()?'Admin restored linked listings':'Dry run: manual restoration',{itemId});
}
