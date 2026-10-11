import 'dotenv/config';
import {getStores} from '../src/config.js';
import {syncCatalog} from '../src/analytics.js';
const store=getStores().find(s=>s.key===String(process.env.STORE_KEY||'A'));
if(!store){console.error('STORE_KEY is not an enabled Store A/B/C/D');process.exit(1)}
try {
  let result, pages=0;
  do {
    result=await syncCatalog(store,10,pages===0&&process.env.SYNC_RESET==='true');
    pages+=10;console.log(result);
    if(pages>=1000)throw new Error('Hit local safety limit: rerun to continue cursor');
  }while(!result.completed);
  console.log('Store catalog sync complete');process.exit(0);
}catch(err){console.error(err.message);process.exit(1)}
