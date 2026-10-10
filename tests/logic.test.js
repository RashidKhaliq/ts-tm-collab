import test from 'node:test';
import assert from 'node:assert/strict';
import { getStores, soldTag } from '../src/config.js';
import { getOwner, physicalKey, isInternalOrder, processOrder } from '../src/engine.js';
import { createSupplierOrder, makeVariantSearch, markSold, graphql } from '../src/shopify.js';

const stores=[
  {key:'A',name:'Owner Store',supplier:'ZIA',domain:'a.myshopify.com',ownerEmail:'owner@a.com',ownerPhone:'',address:{}},
  {key:'B',name:'Selling Store',supplier:'HAMZA',domain:'b.myshopify.com',ownerEmail:'owner@b.com',ownerPhone:'03001234567',address:{address1:'Shop 2',city:'Lahore',country:'Pakistan'}}
];
const variant=(sku='ABC-100',supplier='ZIA',id='1')=>({id:`gid://shopify/ProductVariant/${id}`,sku,
  product:{id:`gid://shopify/Product/${id}`,tags:[],status:'ACTIVE',metafield:{value:supplier}},
  inventoryItem:{tracked:true,inventoryLevels:{nodes:[{quantities:[{name:'available',quantity:1}],location:{id:'gid://shopify/Location/1'}}],pageInfo:{hasNextPage:false}}}
});
const sourceOrder={id:101,name:'#101',tags:'',line_items:[{id:2,variant_id:123,sku:'ABC-100',quantity:1}],
  customer:{first_name:'Real',last_name:'Buyer',email:'buyer@example.com'},email:'buyer@example.com',
  shipping_address:{address1:'Customer address',city:'Karachi',country:'Pakistan'},phone:'03111234567'};

function fakeDeps(storeKey,live=true) {
  const updates=[],created=[],logs=[],suppliers=new Map();
  const db={
    async claimAll(keys,key){logs.push(['claimed',keys,key]);},
    async log(key,level,msg){logs.push([key,level,msg]);},
    async lookupSupplierOrder(key,owner){return suppliers.get(key+owner);},
    async saveSupplierOrder(key,owner,id){suppliers.set(key+owner,id);}
  };
  const shopify={
    async fetchSourceVariant(){return variant('ABC-100','ZIA',storeKey==='A'?'1':'2');},
    async findMatchingVariant(s){return variant('ABC-100','ZIA',s.key==='A'?'1':'2');},
    referenceTag(){return 'TS_fake'},
    async findExistingSupplierOrder(){return null;},
    async createSupplierOrder(owner,seller,order,lines){created.push({owner,seller,order,lines});return 'gid://shopify/Order/50';},
    async markSold(s,v,tag){updates.push({store:s.key,tag});}
  };
  return {deps:{db,shopify,liveWrites:live},updates,created,logs};
}

test('store configuration loads dynamic stores and identifies owner without trusting SKU alone',()=>{
  const env={STORE_A_URL:'a.myshopify.com',STORE_A_SUPPLIER_NAME:'ZIA',STORE_A_ACCESS_TOKEN:'shpca_abc',STORE_A_WEBHOOK_SECRET:'secret',
    STORE_B_URL:'https://b.myshopify.com/',STORE_B_SUPPLIER_NAME:'HAMZA',STORE_B_ACCESS_TOKEN:'shpca_xyz',STORE_B_WEBHOOK_SECRET:'secret2'};
  const result=getStores(env);
  assert.equal(result.length,2);
  assert.equal(result[1].domain,'b.myshopify.com');
  assert.equal(getOwner(stores,'zia').key,'A');
  assert.notEqual(physicalKey(stores[0],'ABC-100'),physicalKey(stores[1],'ABC-100'));
  assert.equal(soldTag('Store B / Lahore'),'Soldby_Store_B_Lahore');
});
test('internal supplier orders ignored',()=>{
  assert.equal(isInternalOrder({tags:'Dropshipped_Order, TS_abcd'}),true);
  assert.equal(isInternalOrder({tags:'Online Sale'}),false);
});
test('owner sale drafts linked listings but creates no internal order',async()=>{
  const {deps,updates,created}=fakeDeps('A');
  const job={job_key:'A:101',selling_key:'A',payload:sourceOrder};
  const result=await processOrder(job,stores,deps);
  assert.equal(result.processed,1);
  assert.equal(created.length,0);
  assert.deepEqual(updates.map(x=>x.store),['A','B']);
  assert.equal(updates[0].tag,'Soldby_Owner_Store');
});
test('reseller sale creates supplier order once, then drafts all linked listings',async()=>{
  const {deps,updates,created}=fakeDeps('B');
  const job={job_key:'B:101',selling_key:'B',payload:sourceOrder};
  await processOrder(job,stores,deps);
  await processOrder(job,stores,deps);
  assert.equal(created.length,1);
  assert.equal(created[0].owner.key,'A');
  assert.equal(created[0].seller.key,'B');
  assert.equal(created[0].lines[0].variantId,'gid://shopify/ProductVariant/1');
  assert.deepEqual(updates.map(x=>x.store),['A','B','A','A','B','A']);
  assert.ok(updates.every(x=>x.tag==='Soldby_Selling_Store'));
});
test('dry-run never claims inventory or writes to Shopify',async()=>{
  const {deps,updates,created,logs}=fakeDeps('B',false);
  const result=await processOrder({job_key:'B:101',selling_key:'B',payload:sourceOrder},stores,deps);
  assert.equal(result.dryRun,true);
  assert.equal(updates.length,0);
  assert.equal(created.length,0);
  assert.equal(logs.filter(l=>l[0]==='claimed').length,0);
});
test('no duplicate SKU + supplier is accepted within one customer order',async()=>{
  const {deps}=fakeDeps('B');
  const order={...sourceOrder,line_items:[...sourceOrder.line_items,{id:3,variant_id:222,sku:'ABC-100',quantity:1}]};
  await assert.rejects(processOrder({job_key:'B:202',selling_key:'B',payload:order},stores,deps),/repeats same physical/);
});
test('GraphQL order input includes 99% discount, free shipping, seller email and buyer notes',async()=>{
  const orig=global.fetch;
  const calls=[];
  global.fetch=async (url,opts)=>{
    const body=JSON.parse(opts.body);calls.push(body);
    return {ok:true,status:200,text:async()=>JSON.stringify({data:body.query.includes('currentAppInstallation')?
      {shop:{currencyCode:'PKR'},currentAppInstallation:{accessScopes:[]}}:
      {orderCreate:{order:{id:'gid://shopify/Order/777'},userErrors:[]}}})};
  };
  try {
    const gid=await createSupplierOrder({...stores[0],token:'shpca_mock'},stores[1],sourceOrder,[{variantId:'gid://shopify/ProductVariant/1',quantity:1,sku:'ABC-100'}],'TS_ref');
    assert.equal(gid,'gid://shopify/Order/777');
    const create=calls.at(-1);
    assert.equal(create.variables.order.email,'owner@b.com');
    assert.equal(create.variables.order.discountCode.itemPercentageDiscountCode.percentage,99);
    assert.equal(create.variables.order.shippingLines[0].priceSet.shopMoney.amount,'0.00');
    assert.equal(create.variables.options.inventoryBehaviour,'DECREMENT_OBEYING_POLICY');
    assert.ok(create.variables.order.note.includes('buyer@example.com'));
    assert.ok(create.variables.order.note.includes('#101'));
    assert.ok(create.variables.order.tags.includes('Dropshipped_Order'));
  } finally {global.fetch=orig;}
});
test('inventory mutation includes idempotent directive and zero quantity, product drafts first',async()=>{
  const old=global.fetch,actions=[];
  global.fetch=async(url,opts)=>{
    const obj=JSON.parse(opts.body); actions.push(obj);
    let data={};
    if(obj.query.includes('productUpdate(')) data={productUpdate:{product:{status:'DRAFT'},userErrors:[]}};
    if(obj.query.includes('tagsAdd(')) data={tagsAdd:{node:{id:'abc'},userErrors:[]}};
    if(obj.query.includes('inventorySetQuantities(')) data={inventorySetQuantities:{userErrors:[],inventoryAdjustmentGroup:{createdAt:'2026-10-10'}}};
    return {ok:true,status:200,text:async()=>JSON.stringify({data})};
  };
  try{
    await markSold({...stores[0],token:'shpca_mock'},variant(),'Soldby_Selling_Store','job1');
    assert.equal(actions.length,3);
    assert.ok(actions[0].query.includes('productUpdate('));
    assert.equal(actions[0].variables.product.status,'DRAFT');
    assert.equal(actions[2].variables.input.quantities[0].quantity,0);
    assert.equal(actions[2].variables.input.quantities[0].changeFromQuantity,1);
    assert.ok(actions[2].query.includes('@idempotent'));
  } finally{global.fetch=old;}
});
test('missing supplier stops workflow before any modifications',async()=>{
  const {deps,updates,created}=fakeDeps('B');
  deps.shopify.fetchSourceVariant=async()=>variant('ABC-100','');
  await assert.rejects(processOrder({job_key:'B:101',selling_key:'B',payload:sourceOrder},stores,deps),/Missing product metafield/);
  assert.equal(updates.length,0);assert.equal(created.length,0);
});
test('missing owner listing blocks writes rather than matching SKU alone',async()=>{
  const {deps,updates,created}=fakeDeps('B');
  deps.shopify.findMatchingVariant=async(store)=>store.key==='A'?null:variant();
  await assert.rejects(processOrder({job_key:'B:101',selling_key:'B',payload:sourceOrder},stores,deps),/does not have matching SKU/);
  assert.equal(updates.length,0);assert.equal(created.length,0);
});
