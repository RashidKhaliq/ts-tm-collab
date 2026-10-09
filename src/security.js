import crypto from 'node:crypto';
const constantEq=(a,b)=>{const aa=Buffer.from(String(a)),bb=Buffer.from(String(b));return aa.length===bb.length && crypto.timingSafeEqual(aa,bb);};
export function adminAuth(req,res,next){
 const hdr=req.headers.authorization||'';let user='',pass='';
 if(hdr.startsWith('Basic ')){try{[user,pass]=Buffer.from(hdr.slice(6),'base64').toString().split(/:(.*)/s).slice(0,2);}catch{}}
 if(!process.env.ADMIN_USER||!process.env.ADMIN_PASSWORD||!constantEq(user,process.env.ADMIN_USER)||!constantEq(pass,process.env.ADMIN_PASSWORD)){
  res.set('WWW-Authenticate','Basic realm="ThriftSync"');return res.status(401).send('Authentication required');
 }next();
}
export function workerAuth(req,res,next){const secret=req.get('x-worker-secret')||(req.get('authorization')||'').replace(/^Bearer /,'');if(!process.env.WORKER_SECRET||!constantEq(secret,process.env.WORKER_SECRET))return res.status(401).json({error:'Unauthorized'});next();}
const key=()=>{if(!/^[a-f0-9]{64}$/i.test(process.env.STORE_ENCRYPTION_KEY||''))throw new Error('STORE_ENCRYPTION_KEY must be 64 hex chars');return Buffer.from(process.env.STORE_ENCRYPTION_KEY,'hex');};
export function encrypt(value){const iv=crypto.randomBytes(12);const cipher=crypto.createCipheriv('aes-256-gcm',key(),iv);const data=Buffer.concat([cipher.update(value,'utf8'),cipher.final()]);return Buffer.concat([iv,cipher.getAuthTag(),data]).toString('base64');}
export function decrypt(value){const buf=Buffer.from(value,'base64');const decipher=crypto.createDecipheriv('aes-256-gcm',key(),buf.subarray(0,12));decipher.setAuthTag(buf.subarray(12,28));return Buffer.concat([decipher.update(buf.subarray(28)),decipher.final()]).toString();}
export function verifyWebhook(raw,secret,digest){if(!digest)return false;const expected=crypto.createHmac('sha256',secret).update(raw).digest('base64');return constantEq(expected,digest);}
export function validDomain(d){return /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/i.test(d||'');}
export function numericGid(type,value){const s=String(value||'');if(new RegExp(`^gid://shopify/${type}/\\d+$`).test(s))return s;if(/^\d+$/.test(s))return `gid://shopify/${type}/${s}`;throw new Error(`Invalid ${type} ID`);}
