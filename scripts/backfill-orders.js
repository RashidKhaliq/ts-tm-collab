import 'dotenv/config';
import {getStores} from '../src/config.js';
import {backfillOrders} from '../src/analytics.js';
const store=getStores().find(s=>s.key===String(process.env.STORE_KEY||'A'));
if(!store){console.error('STORE_KEY is not enabled');process.exit(1)}
let cursor=null;
try {
  for(let page=0;page<2000;page++){
    const result=await backfillOrders(store,cursor,12);
    console.log({page,imported:result.imported,orders:result.orders,completed:result.completed});
    if(result.completed)process.exit(0);
    if(!result.nextCursor)throw new Error('Shopify missing next cursor; refusing infinite loop');
    cursor=result.nextCursor;
  }
  throw new Error('Order backfill page cap reached');
}catch(err){console.error(err.message);process.exit(1)}
