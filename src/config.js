export const apiVersion = process.env.SHOPIFY_API_VERSION || '2026-10';
export const liveWrites = process.env.LIVE_WRITES === 'true';
export const norm = value => String(value ?? '').trim().toLowerCase();
export const normalizeDomain = raw => String(raw || '')
  .trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/$/, '').split('/')[0];
export const soldTag = name => 'Soldby_' + String(name || '')
  .trim().replace(/[^\p{L}\p{N}_-]+/gu, '_').replace(/^_+|_+$/g, '').slice(0, 100);

export function getStores(env = process.env) {
  const keys = Object.keys(env).map(k => k.match(/^STORE_([A-Z0-9]+)_URL$/)?.[1]).filter(Boolean);
  const stores = keys.map(key => {
    const prefix = `STORE_${key}_`;
    const field = name => (env[prefix + name] || '').trim();
    const domain = normalizeDomain(field('URL'));
    if (!/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(domain)) {
      throw new Error(`${prefix}URL must be a valid .myshopify.com domain`);
    }
    return {
      key, name: field('NAME') || `Store ${key}`, domain,
      supplier: field('SUPPLIER_NAME'),
      token: field('ACCESS_TOKEN').replace(/^X-Shopify-Access-Token\s*:\s*/i, ''),
      webhookSecret: field('WEBHOOK_SECRET'),
      ownerEmail: field('OWNER_EMAIL'), ownerPhone: field('OWNER_PHONE'),
      address: {
        address1: field('OWNER_ADDRESS1'), address2: field('OWNER_ADDRESS2'),
        city: field('OWNER_CITY'), province: field('OWNER_PROVINCE'),
        country: field('OWNER_COUNTRY'), zip: field('OWNER_ZIP'),
        firstName: field('OWNER_FIRST_NAME') || field('NAME') || `Store ${key}`,
        lastName: field('OWNER_LAST_NAME')
      }
    };
  }).sort((a, b) => a.key.localeCompare(b.key));
  for (const s of stores) {
    if (!s.supplier) throw new Error(`STORE_${s.key}_SUPPLIER_NAME is required`);
    if (!s.token) throw new Error(`STORE_${s.key}_ACCESS_TOKEN is required`);
    if (!s.webhookSecret) throw new Error(`STORE_${s.key}_WEBHOOK_SECRET is required`);
    if (stores.filter(x => norm(x.supplier) === norm(s.supplier)).length > 1) {
      throw new Error(`Duplicate supplier code: ${s.supplier}`);
    }
    if (stores.filter(x => x.domain === s.domain).length > 1) throw new Error(`Duplicate store domain: ${s.domain}`);
  }
  return stores;
}
