import {decrypt,numericGid} from './security.js';
const version=()=>process.env.SHOPIFY_API_VERSION||'2026-07';
export async function graphql(store,query,variables={}){
 const controller=new AbortController();const timeout=setTimeout(()=>controller.abort(),20000);
 try{
  const response=await fetch(`https://${store.domain}/admin/api/${version()}/graphql.json`,{
   method:'POST',signal:controller.signal,headers:{'Content-Type':'application/json','X-Shopify-Access-Token':decrypt(store.encrypted_token)},body:JSON.stringify({query,variables})});
  const body=await response.json();if(!response.ok||body.errors?.length)throw new Error(`Shopify ${response.status}: ${JSON.stringify(body.errors||body).slice(0,700)}`);return body.data;
 }finally{clearTimeout(timeout);}
}
export async function checkListing(store,productGid,variantGid){
 const data=await graphql(store,`query($id:ID!){product(id:$id){id status tags metafield(namespace:"custom",key:"supplier"){value} variants(first:100){nodes{id sku inventoryItem{id} inventoryQuantity}}}}`,{id:productGid});
 const p=data.product;if(!p)throw new Error('Shopify product not found');const variant=p.variants.nodes.find(v=>v.id===variantGid);if(!variant)throw new Error('Shopify product variant not found');return {product:p,variant};
}
export async function draftAndTag(store,productGid,sellerName){
 const tag=`Soldby_${String(sellerName).replace(/[^a-zA-Z0-9_-]/g,'_')}`;
 const tags=await graphql(store,`mutation($id:ID!,$tags:[String!]!){tagsAdd(id:$id,tags:$tags){userErrors{message}}}`,{id:productGid,tags:[tag]});
 const errors=tags.tagsAdd.userErrors;if(errors.length)throw new Error(errors.map(x=>x.message).join('; '));
 const result=await graphql(store,`mutation($product:ProductUpdateInput!){productUpdate(product:$product){product{id status} userErrors{message}}}`,{product:{id:productGid,status:'DRAFT'}});
 if(result.productUpdate.userErrors.length)throw new Error(result.productUpdate.userErrors.map(x=>x.message).join('; '));
}
export async function restoreStatus(store,productGid,status){
 const result=await graphql(store,`mutation($product:ProductUpdateInput!){productUpdate(product:$product){userErrors{message}}}`,{product:{id:productGid,status}});
 if(result.productUpdate.userErrors.length)throw new Error(result.productUpdate.userErrors.map(x=>x.message).join('; '));
}
export async function addTags(store,productGid,tags){const data=await graphql(store,`mutation($id:ID!,$tags:[String!]!){tagsAdd(id:$id,tags:$tags){userErrors{message}}}`,{id:productGid,tags});if(data.tagsAdd.userErrors.length)throw new Error(data.tagsAdd.userErrors[0].message);}
export async function removeTags(store,productGid,tags){const data=await graphql(store,`mutation($id:ID!,$tags:[String!]!){tagsRemove(id:$id,tags:$tags){userErrors{message}}}`,{id:productGid,tags});if(data.tagsRemove.userErrors.length)throw new Error(data.tagsRemove.userErrors[0].message);}
export async function findOrderByReference(store,reference){
 const search=String(reference).replace(/["\\]/g,'');
 const d=await graphql(store,`query($q:String!){orders(first:10,query:$q){nodes{id name tags note}}}`,{q:`tag:Dropshipped_Order ${search}`});
 return d.orders.nodes.find(o=>(o.note||'').includes(reference))||null;
}
export async function createSupplierOrder(store,variantGid,sourceOrder,sellingStore,reference){
 const addr=sourceOrder.shipping_address||{};const customerName=[sourceOrder.customer?.first_name||addr.first_name,sourceOrder.customer?.last_name||addr.last_name].filter(Boolean).join(' ');
 const note=[`ThriftSync reference: ${reference}`,`Sold by: ${sellingStore.name}`,`Original order: ${sourceOrder.name||sourceOrder.id}`,`Customer name: ${customerName||'-'}`,`Customer email: ${sourceOrder.email||'-'}`,`Customer phone: ${sourceOrder.phone||addr.phone||'-'}`,`Customer address: ${[addr.address1,addr.address2,addr.city,addr.province,addr.zip,addr.country].filter(Boolean).join(', ')||'-'}`].join('\n');
 const order={lineItems:[{variantId:variantGid,quantity:1}],email:sellingStore.owner_email||undefined,phone:sellingStore.owner_phone||undefined,note,tags:['Dropshipped_Order',`Soldby_${sellingStore.name.replace(/[^a-zA-Z0-9_-]/g,'_')}`,reference],discountCode:{itemPercentageDiscountCode:{percentage:99,code:'INTERNAL_99_PERCENT'}},shippingLines:[{title:'Free shipping',priceSet:{shopMoney:{amount:0,currencyCode:store.currency||'PKR'}}}]};
 if(sellingStore.owner_address && Object.keys(sellingStore.owner_address).length){
  const a=sellingStore.owner_address;const parts=String(sellingStore.owner_name||sellingStore.name).trim().split(/\s+/);
  order.shippingAddress={firstName:parts[0]||sellingStore.name,lastName:parts.slice(1).join(' ')||'',address1:a.address1||'',address2:a.address2||'',city:a.city||'',province:a.province||'',zip:a.zip||'',country:a.country||'',phone:sellingStore.owner_phone||''};
 }
 // orderCreate's shipping currency uses the owner's currency; set it via shop query.
 const shop=await graphql(store,'query{shop{currencyCode}}');order.shippingLines[0].priceSet.shopMoney.currencyCode=shop.shop.currencyCode;
 const data=await graphql(store,`mutation($order:OrderCreateOrderInput!,$options:OrderCreateOptionsInput){orderCreate(order:$order,options:$options){order{id name} userErrors{field message}}}`,{order,options:{sendReceipt:false,sendFulfillmentReceipt:false,inventoryBehaviour:"DECREMENT_IGNORING_POLICY"}});
 if(data.orderCreate.userErrors?.length)throw new Error('Order creation: '+data.orderCreate.userErrors.map(x=>x.message).join('; '));return data.orderCreate.order;
}
export const productGid=x=>numericGid('Product',x);
export const variantGid=x=>numericGid('ProductVariant',x);
