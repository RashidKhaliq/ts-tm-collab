import crypto from 'node:crypto';
import { apiVersion, norm } from './config.js';

const VARIANT_FIELDS = `
  id sku
  product {
    id status tags title
    metafield(namespace:"custom",key:"supplier") { value }
    variants(first:2) { nodes { id } }
  }
  inventoryItem {
    id tracked
    inventoryLevels(first:100) {
      nodes { location { id } quantities(names:["available"]) { name quantity } }
      pageInfo { hasNextPage }
    }
  }
`;

export class ShopifyError extends Error {
  constructor(shop, status, msg) { super(`${shop} Shopify ${status}: ${msg}`); this.name='ShopifyError'; this.status=status; }
}

export async function graphql(store, gql, variables={}) {
  const url = `https://${store.domain}/admin/api/${apiVersion}/graphql.json`;
  let res;
  try {
    res = await fetch(url, {
      method:'POST', headers:{
        'Content-Type':'application/json',
        'X-Shopify-Access-Token':store.token
      }, body:JSON.stringify({query:gql, variables}),
      signal:AbortSignal.timeout(18000)
    });
  } catch (err) { throw new ShopifyError(store.key, 'network', err.message); }
  const text=await res.text();
  let body;
  try {body=JSON.parse(text);} catch {throw new ShopifyError(store.key,res.status,text.slice(0,400));}
  if (!res.ok) {
    const hint=res.status===401 ? 'Token invalid, expired, wrong shop domain, or missing offline authorization. Check .myshopify.com and token.' : '';
    throw new ShopifyError(store.key,res.status,`${hint} ${JSON.stringify(body.errors||body).slice(0,450)}`);
  }
  if (body.errors?.length) throw new ShopifyError(store.key,'GraphQL',body.errors.map(e=>e.message).join('; '));
  return body.data;
}
export function assertNoUserErrors(payload, label) {
  if (payload?.userErrors?.length) throw new Error(`${label}: ` + payload.userErrors.map(e=>e.message).join('; '));
}
export async function testStore(store) {
  const data=await graphql(store,`query { shop { name myshopifyDomain currencyCode } currentAppInstallation { accessScopes { handle } } }`);
  return {
    shop:data.shop, scopes:(data.currentAppInstallation?.accessScopes||[]).map(s=>s.handle)
  };
}
export async function fetchSourceVariant(store, variantId) {
  const id=`gid://shopify/ProductVariant/${String(variantId).replace(/^gid:\/\/shopify\/ProductVariant\//,'')}`;
  const data=await graphql(store,`query($id:ID!){ node(id:$id){ ... on ProductVariant { ${VARIANT_FIELDS} } } }`,{id});
  return data.node?.sku ? data.node : null;
}
function normalizedVariant(v) {
  return { ...v, supplier:norm(v.product?.metafield?.value) };
}
export function makeVariantSearch(sku) {
  // Shopify search grammar: quote and escape for exact SKU matching in JS afterward.
  const val=String(sku).replace(/[\\"]/g,'\\$&');
  return `sku:"${val}"`;
}
export async function findMatchingVariant(store, sku, supplier) {
  const matches=[];
  let cursor=null;
  for (let p=0; p<10; p++) {
    const data=await graphql(store,`query($q:String!,$cursor:String) {
      productVariants(first:100,query:$q,after:$cursor) {
        nodes { ${VARIANT_FIELDS} }
        pageInfo { hasNextPage endCursor }
      }
    }`,{q:makeVariantSearch(sku),cursor});
    const result=data.productVariants;
    for (const v of result.nodes) {
      if (norm(v.sku)===norm(sku) && norm(v.product?.metafield?.value)===norm(supplier)) {
        matches.push(normalizedVariant(v));
        if (matches.length>1) throw new Error(`${store.key}: Ambiguous SKU + supplier ${sku}/${supplier}; no product will be edited`);
      }
    }
    if (!result.pageInfo.hasNextPage) return matches[0]||null;
    cursor=result.pageInfo.endCursor;
  }
  throw new Error(`${store.key}: Variant search pagination limit exceeded for ${sku}; refusing unsafe match`);
}
export async function markSold(store, variant, saleTag, key, options={}) {
  const product=variant.product;
  if (product.status!=='DRAFT') {
    const data=await graphql(store,`mutation($product:ProductUpdateInput!){productUpdate(product:$product){product{id status} userErrors{message}}}`,{
      product:{id:product.id,status:'DRAFT'}
    });
    assertNoUserErrors(data.productUpdate,'Draft product');
  }
  if (!product.tags.includes(saleTag)) {
    const data=await graphql(store,`mutation($id:ID!,$tags:[String!]!){tagsAdd(id:$id,tags:$tags){node{id} userErrors{message}}}`,{
      id:product.id,tags:[saleTag]
    });
    assertNoUserErrors(data.tagsAdd,'Add Soldby tag');
  }
  if (options.draftOnly) return {status:'DRAFT',quantity:'deferred until supplier order'};
  const item=variant.inventoryItem;
  if (!item?.tracked) return {status:'DRAFT',quantity:'inventory untracked'};
  if (item.inventoryLevels.pageInfo.hasNextPage) throw new Error(`${store.key}: Over 100 inventory locations; safely stopped after drafting product`);
  const qtys = item.inventoryLevels.nodes.map(level => ({
    inventoryItemId:item.id, locationId:level.location.id,
    quantity:0, changeFromQuantity:level.quantities.find(x=>x.name==='available')?.quantity||0
  })).filter(x=>x.changeFromQuantity!==0);
  if (!qtys.length) return {status:'DRAFT',quantity:0};
  // Shopify 2026-10 requires an idempotency key for inventorySetQuantities.
  const mutation=`mutation($input:InventorySetQuantitiesInput!,$idempotencyKey:String!){
    inventorySetQuantities(input:$input) @idempotent(key:$idempotencyKey) {
      userErrors { code message } inventoryAdjustmentGroup { createdAt }
    }
  }`;
  for (const q of qtys) {
    const hashed=crypto.createHash('sha256').update(`${key}|${store.key}|${q.inventoryItemId}|${q.locationId}|${q.changeFromQuantity}`).digest('hex');
    const uuid=`${hashed.slice(0,8)}-${hashed.slice(8,12)}-4${hashed.slice(13,16)}-a${hashed.slice(17,20)}-${hashed.slice(20,32)}`;
    const input={name:'available',reason:'correction',referenceDocumentUri:`gid://thriftsync/Sale/${hashed.slice(0,24)}`,quantities:[q]};
    const data=await graphql(store,mutation,{input,idempotencyKey:uuid});
    assertNoUserErrors(data.inventorySetQuantities,'Set inventory zero');
  }
  return {status:'DRAFT',quantity:0};
}

export function referenceTag(storeKey,orderId,ownerKey) {
  return 'TS_' + crypto.createHash('sha256').update(`${storeKey}:${orderId}:${ownerKey}`).digest('hex').slice(0,20);
}
export async function findExistingSupplierOrder(store, reference) {
  const result=await graphql(store,`query($q:String!){orders(first:2,query:$q){nodes{id tags}}}`,{q:`tag:${reference}`});
  return result.orders.nodes.find(o=>o.tags.includes(reference))?.id||null;
}
function noteForOrder(seller, originalOrder, ownerKey, lines) {
  const c=originalOrder.customer||{};
  const a=originalOrder.shipping_address||originalOrder.billing_address||{};
  const name=[c.first_name||a.first_name,c.last_name||a.last_name].filter(Boolean).join(' ');
  return [
    'ThriftSync Internal Dropshipping Order',
    `Sold by store: ${seller.name} (${seller.domain})`,
    `Original selling store order: ${originalOrder.name||originalOrder.order_number||originalOrder.id}`,
    `Original order ID: ${originalOrder.id}`,
    `Original customer name: ${name||'Not provided'}`,
    `Original customer email: ${originalOrder.email||c.email||'Not provided'}`,
    `Original customer phone: ${originalOrder.phone||a.phone||c.phone||'Not provided'}`,
    `Original customer address: ${[a.address1,a.address2,a.city,a.province,a.zip,a.country].filter(Boolean).join(', ')||'Not provided'}`,
    `Customer order items: ${lines.map(l=>`${l.sku} x ${l.quantity}`).join(', ')}`,
    `Owner supplier: ${ownerKey}`,
    'Internal discount: 99%',
    'Internal shipping: FREE (0)',
    'Owner supplies item to selling store. Selling store handles buyer delivery.'
  ].join('\n').slice(0,5000);
}
export async function createSupplierOrder(owner, seller, originalOrder, lines, ref) {
  const shop=await testStore(owner);
  const money={amount:'0.00',currencyCode:shop.shop.currencyCode};
  const addr=Object.fromEntries(Object.entries(seller.address).filter(([,value])=>Boolean(value)));
  const input={
    lineItems:lines.map(({variantId,quantity})=>({variantId,quantity})),
    note:noteForOrder(seller,originalOrder,owner.key,lines),
    tags:['Dropshipped_Order',ref],
    sourceIdentifier:`${seller.domain}:${originalOrder.id}`,
    discountCode:{itemPercentageDiscountCode:{percentage:99,code:'THRIFTSYNC_INTERNAL_99'}},
    shippingLines:[{title:'Free Internal Shipping',priceSet:{shopMoney:money}}],
    financialStatus:'PENDING'
  };
  if (seller.ownerEmail) input.email=seller.ownerEmail;
  if (seller.ownerPhone) input.phone=seller.ownerPhone;
  if (addr.address1 && addr.city && addr.country) input.shippingAddress=addr;
  const data=await graphql(owner,`mutation($order:OrderCreateOrderInput!,$options:OrderCreateOptionsInput){
    orderCreate(order:$order,options:$options){order{id name} userErrors{message field}}
  }`,{order:input,options:{inventoryBehaviour:'DECREMENT_OBEYING_POLICY',sendReceipt:false,sendFulfillmentReceipt:false}});
  assertNoUserErrors(data.orderCreate,'Create dropship order');
  if (!data.orderCreate.order?.id) throw new Error('Shopify did not return supplier order ID');
  return data.orderCreate.order.id;
}
