// lib/shopify.ts - Shopify Admin GraphQL & REST API Client Engine
import crypto from 'crypto';
import axios from 'axios';
import { db } from './db';

export function verifyShopifyHmac(rawBody: string | Buffer, secret: string, hmacHeader: string | null): boolean {
  if (!rawBody || !secret || !hmacHeader) return false;
  try {
    const generatedHash = crypto
      .createHmac('sha256', secret)
      .update(rawBody)
      .digest('base64');
    return crypto.timingSafeEqual(Buffer.from(generatedHash), Buffer.from(hmacHeader));
  } catch (err) {
    return false;
  }
}

export function cleanShopDomain(url: string): string {
  if (!url) return '';
  return url.replace(/^https?:\/\//i, '').replace(/\/$/, '').trim();
}

// Fetch Orders from Shopify REST API for a given store (e.g. created today or all recent)
export async function fetchRecentOrdersREST(shopDomain: string, accessToken: string, createdMin?: string): Promise<any[]> {
  const domain = cleanShopDomain(shopDomain);
  if (!domain || !accessToken) return [];

  try {
    let url = `https://${domain}/admin/api/2024-01/orders.json?status=any&limit=50`;
    if (createdMin) {
      url += `&created_at_min=${encodeURIComponent(createdMin)}`;
    }

    const res = await axios.get(url, {
      headers: { 'X-Shopify-Access-Token': accessToken },
      timeout: 10000
    });

    return res.data?.orders || [];
  } catch (err: any) {
    await db.addLog('ERROR', `Failed to fetch recent orders from Shopify for ${domain}: ${err.message}`, 'orders_fetch', domain);
    return [];
  }
}

export interface LineItemInfo {
  id: string;
  title: string;
  sku: string;
  quantity: number;
  productId: string;
  productTags: string;
  customSupplierMetafield?: string | null;
  vendor?: string | null;
}

export interface ParsedOrder {
  id: string;
  name: string;
  email?: string;
  tags?: string;
  lineItems: LineItemInfo[];
}

// Extract supplier name from custom.supplier metafield, Supplier: Name tags, or line item vendor
export function extractSupplierName(tags?: string | null, metafield?: string | null, vendor?: string | null): string | null {
  // 1. Primary Identifier: custom.supplier metafield
  if (metafield && typeof metafield === 'string' && metafield.trim() !== '') {
    return metafield.trim();
  }

  // 2. Secondary Identifier: Supplier: <Name> tag (case-insensitive) or direct tags
  if (tags && typeof tags === 'string' && tags.trim() !== '') {
    const tagList = tags.split(',').map(t => t.trim());
    for (const tag of tagList) {
      const match = tag.match(/^(?:Supplier|supplier)[:_\s]+(.+)$/i);
      if (match && match[1]) {
        return match[1].trim();
      }
    }
    // Direct tag match (e.g. "Sharry", "OTS", "Hamza", "Vougewing")
    for (const tag of tagList) {
      if (tag && !tag.toLowerCase().startsWith('soldby-') && !tag.toLowerCase().startsWith('automated') && !tag.toLowerCase().includes('discount')) {
        return tag.trim();
      }
    }
  }

  // 3. Fallback: Line item vendor matching Supplier: <Name> or direct vendor string
  if (vendor && typeof vendor === 'string' && vendor.trim() !== '') {
    const cleanVendor = vendor.trim();
    const vendorMatch = cleanVendor.match(/^(?:Supplier|supplier)[:_\s]+(.+)$/i);
    if (vendorMatch && vendorMatch[1]) {
      return vendorMatch[1].trim();
    }
    return cleanVendor;
  }

  return null;
}

// Fetch Product details & custom.supplier Metafield via REST API
export async function getProductDetailsREST(
  shopDomain: string,
  accessToken: string,
  productId: string
): Promise<{ tags: string; vendor: string; supplierMetafield: string | null }> {
  const domain = cleanShopDomain(shopDomain);
  const cleanId = productId.replace(/^gid:\/\/shopify\/Product\//, '');
  if (!cleanId) return { tags: '', vendor: '', supplierMetafield: null };

  let tags = '';
  let vendor = '';
  let supplierMetafield: string | null = null;

  try {
    const res = await axios.get(`https://${domain}/admin/api/2024-01/products/${cleanId}.json`, {
      headers: { 'X-Shopify-Access-Token': accessToken },
      timeout: 8000
    });

    const product = res.data?.product;
    if (product) {
      tags = product.tags || '';
      vendor = product.vendor || '';
    }
  } catch (err: any) {
    await db.addLog('WARN', `Failed to fetch REST product details for product ${cleanId} on ${domain}: ${err.message}`, 'product_fetch', domain);
  }

  // Fetch Metafields for product
  try {
    const mfRes = await axios.get(`https://${domain}/admin/api/2024-01/products/${cleanId}/metafields.json`, {
      headers: { 'X-Shopify-Access-Token': accessToken },
      timeout: 8000
    });

    const metafields = mfRes.data?.metafields || [];
    const suppMf = metafields.find(
      (m: any) => (m.namespace === 'custom' && m.key === 'supplier') || m.key === 'supplier'
    );
    if (suppMf) {
      supplierMetafield = String(suppMf.value);
    }
  } catch (err: any) {
    // Non-critical: ignore metafield fetch errors
  }

  return { tags, vendor, supplierMetafield };
}

// Fetch Order details & line item product tags/metafields via GraphQL API
export async function getOrderDetailsGraphQL(
  shopDomain: string,
  accessToken: string,
  orderId: string
): Promise<ParsedOrder | null> {
  const domain = cleanShopDomain(shopDomain);
  const cleanId = orderId.replace(/^gid:\/\/shopify\/Order\//, '');
  const orderGid = `gid://shopify/Order/${cleanId}`;

  const query = `
    query getOrder($id: ID!) {
      order(id: $id) {
        id
        name
        email
        tags
        lineItems(first: 50) {
          edges {
            node {
              id
              title
              sku
              quantity
              vendor
              variant {
                product {
                  id
                  tags
                  metafield(namespace: "custom", key: "supplier") {
                    value
                  }
                }
              }
            }
          }
        }
      }
    }
  `;

  try {
    const res = await axios.post(
      `https://${domain}/admin/api/2024-01/graphql.json`,
      { query, variables: { id: orderGid } },
      {
        headers: { 'X-Shopify-Access-Token': accessToken },
        timeout: 10000
      }
    );

    const orderData = res.data?.data?.order;
    if (!orderData) return null;

    const lineItems: LineItemInfo[] = (orderData.lineItems?.edges || []).map((edge: any) => {
      const node = edge.node;
      const product = node.variant?.product;
      const tagsArray = product?.tags || [];
      const tagsStr = Array.isArray(tagsArray) ? tagsArray.join(', ') : String(tagsArray);
      const supplierMf = product?.metafield?.value || null;

      return {
        id: String(node.id),
        title: node.title,
        sku: node.sku ? node.sku.trim() : '',
        quantity: node.quantity || 1,
        productId: product?.id ? String(product.id) : '',
        productTags: tagsStr,
        customSupplierMetafield: supplierMf,
        vendor: node.vendor || ''
      };
    });

    return {
      id: String(orderData.id),
      name: orderData.name,
      email: orderData.email,
      tags: Array.isArray(orderData.tags) ? orderData.tags.join(', ') : orderData.tags,
      lineItems
    };
  } catch (err: any) {
    await db.addLog('WARN', `GraphQL order fetch failed for order ${orderId} on ${domain}: ${err.message}`, 'graphql', domain);
    return null;
  }
}

// Find Variant ID by SKU using GraphQL with REST Fallback
export async function findVariantIdBySku(
  shopDomain: string,
  accessToken: string,
  sku: string
): Promise<{ variantId: string; productId?: string; inventoryItemId?: string; availableQuantity?: number; price?: string } | null> {
  const cleanSku = sku.trim();
  if (!cleanSku) return null;
  const domain = cleanShopDomain(shopDomain);

  // 1. GraphQL Variant Lookup
  const query = `
    query findVariant($query: String!) {
      productVariants(first: 20, query: $query) {
        edges {
          node {
            id
            sku
            price
            inventoryQuantity
            inventoryItem {
              id
            }
            product {
              id
            }
          }
        }
      }
    }
  `;

  try {
    const res = await axios.post(
      `https://${domain}/admin/api/2024-01/graphql.json`,
      { query, variables: { query: `sku:"${cleanSku.replace(/"/g, '\\"')}"` } },
      {
        headers: { 'X-Shopify-Access-Token': accessToken },
        timeout: 8000
      }
    );

    const edges = res.data?.data?.productVariants?.edges || [];
    for (const edge of edges) {
      if (edge.node?.sku && edge.node.sku.trim().toLowerCase() === cleanSku.toLowerCase()) {
        const gid = edge.node.id;
        const invGid = edge.node.inventoryItem?.id;
        const prodGid = edge.node.product?.id;
        return {
          variantId: gid ? gid.split('/').pop()! : '',
          productId: prodGid ? prodGid.split('/').pop() : undefined,
          inventoryItemId: invGid ? invGid.split('/').pop() : undefined,
          availableQuantity: edge.node.inventoryQuantity ?? undefined,
          price: edge.node.price ? String(edge.node.price) : undefined
        };
      }
    }
  } catch (err: any) {
    await db.addLog('WARN', `GraphQL variant query failed for SKU '${cleanSku}' on ${domain}: ${err.message}`, 'variant_lookup', domain);
  }

  // 2. REST Fallback via Products List (scanning variants)
  try {
    const restRes = await axios.get(`https://${domain}/admin/api/2024-01/products.json?limit=250&fields=id,title,variants`, {
      headers: { 'X-Shopify-Access-Token': accessToken },
      timeout: 10000
    });

    const products = restRes.data?.products || [];
    for (const prod of products) {
      for (const v of (prod.variants || [])) {
        if (v.sku && v.sku.trim().toLowerCase() === cleanSku.toLowerCase()) {
          return {
            variantId: String(v.id),
            productId: String(prod.id),
            inventoryItemId: String(v.inventory_item_id),
            availableQuantity: v.inventory_quantity,
            price: v.price ? String(v.price) : undefined
          };
        }
      }
    }
  } catch (err: any) {
    await db.addLog('WARN', `REST products search fallback failed for SKU '${cleanSku}' on ${domain}: ${err.message}`, 'variant_lookup', domain);
  }

  return null;
}

// Create B2B Supplier Order on Target Connected Store (Store B sells Store A's product)
export async function createSupplierFulfillmentOrder(
  supplierStore: { shopDomain: string; accessToken: string; ownerEmail: string; name: string },
  retailerStore: { shopDomain: string; name: string; supplierName: string; ownerEmail?: string },
  items: { sku: string; quantity: number }[],
  sourceOrderName: string
): Promise<{ success: boolean; orderId?: string; orderName?: string; error?: string }> {
  const domain = cleanShopDomain(supplierStore.shopDomain);
  const lineItemsPayload: any[] = [];

  for (const item of items) {
    const variant = await findVariantIdBySku(supplierStore.shopDomain, supplierStore.accessToken, item.sku);
    if (variant && variant.variantId) {
      const parsedId = parseInt(variant.variantId, 10);
      const lineItemObj: any = {
        variant_id: isNaN(parsedId) ? variant.variantId : parsedId,
        quantity: item.quantity,
        applied_discounts: [
          {
            title: "70% Inventory Sync Discount",
            description: "70% discount on order placed via Inventory Sync import",
            value: "50.0",
            value_type: "percentage"
          }
        ]
      };

      lineItemsPayload.push(lineItemObj);
    } else {
      await db.addLog('ERROR', `SKU '${item.sku}' not found on supplier store ${supplierStore.name}. Excluded from order.`, 'order_creation', supplierStore.shopDomain);
    }
  }

  if (lineItemsPayload.length === 0) {
    return {
      success: false,
      error: `None of the line item SKUs could be resolved on supplier store ${supplierStore.name}`
    };
  }

  // Set order customer email & name to Seller Store details (Store B)
  const sellerEmail = retailerStore.ownerEmail && retailerStore.ownerEmail.includes('@')
    ? retailerStore.ownerEmail
    : 'seller@dropship-sync.com';

  const sellerStoreName = retailerStore.name || `Store ${retailerStore.supplierName}`;

  const orderPayload = {
    order: {
      line_items: lineItemsPayload,
      customer: {
        first_name: sellerStoreName,
        last_name: "(Seller Store)",
        email: sellerEmail
      },
      email: sellerEmail,
      source_name: "Dropshipping",
      discount_codes: [
        {
          code: "Dropshipping",
          amount: "50.00",
          type: "percentage"
        }
      ],
      tags: `Automated Dropship, Dropshipping, Inventory Sync, Soldby-${retailerStore.supplierName || sellerStoreName}, 70% Discount Applied, Coupon: Dropshipping`,
      financial_status: "pending",
      inventory_behaviour: "decrement_obeying_policy",
      note: `Dropshipping order placed via Inventory Sync import by ${sellerStoreName} (${retailerStore.shopDomain}) for original order #${sourceOrderName}. Coupon code 'Dropshipping' (70% off) applied on each product.`
    }
  };

  try {
    const res = await axios.post(`https://${domain}/admin/api/2024-01/orders.json`, orderPayload, {
      headers: { 'X-Shopify-Access-Token': supplierStore.accessToken },
      timeout: 10000
    });

    const newOrder = res.data?.order;
    const orderName = newOrder?.name || `#${newOrder?.order_number}`;
    await db.addLog(
      'INFO',
      `🎉 Successfully created B2B Dropshipping Order ${orderName} (with 'Dropshipping' 70% coupon code applied) on ${supplierStore.name} (Source Order #${sourceOrderName} from ${sellerStoreName})`,
      'order_creation',
      supplierStore.shopDomain
    );

    return {
      success: true,
      orderId: String(newOrder?.id),
      orderName: orderName
    };
  } catch (err: any) {
    const errorMsg = err.response ? JSON.stringify(err.response.data) : err.message;
    await db.addLog('ERROR', `Failed to create order on supplier store ${supplierStore.name}: ${errorMsg}`, 'order_creation', supplierStore.shopDomain);
    return {
      success: false,
      error: errorMsg
    };
  }
}

// Synchronize / Deduct Inventory Quantities for Matching SKUs across connected stores (> 2 stores)
export async function syncInventoryAcrossStores(
  sourceShopDomain: string,
  sku: string,
  soldQuantity: number = 1,
  explicitNewQuantity?: number
): Promise<void> {
  const stores = await db.getAllStores();
  const cleanSource = cleanShopDomain(sourceShopDomain);
  const syncMode = db.getInventorySyncMode();

  // Deduct inventory across all other connected stores
  for (const store of stores) {
    if (cleanShopDomain(store.shopDomain) === cleanSource || !store.isActive) continue;

    const variant = await findVariantIdBySku(store.shopDomain, store.accessToken, sku);
    if (variant && variant.inventoryItemId) {
      try {
        const domain = cleanShopDomain(store.shopDomain);

        if (syncMode === 'DRAFT_PRODUCT' && variant.productId) {
          // Unpublish/draft product on connected store when sold
          const cleanProductId = variant.productId.split('/').pop();
          await axios.put(
            `https://${domain}/admin/api/2024-01/products/${cleanProductId}.json`,
            { product: { id: cleanProductId, status: 'draft' } },
            {
              headers: { 'X-Shopify-Access-Token': store.accessToken },
              timeout: 8000
            }
          );
          await db.addLog(
            'INFO',
            `📝 Set Product status to 'draft' for SKU '${sku}' on connected store ${store.name}`,
            'inventory_sync',
            store.shopDomain
          );
          continue;
        }

        // Get primary location ID
        const locRes = await axios.get(`https://${domain}/admin/api/2024-01/locations.json`, {
          headers: { 'X-Shopify-Access-Token': store.accessToken },
          timeout: 8000
        });

        const locationId = locRes.data?.locations?.[0]?.id;
        if (!locationId) continue;

        if (explicitNewQuantity !== undefined) {
          // Set exact available quantity
          await axios.post(
            `https://${domain}/admin/api/2024-01/inventory_levels/set.json`,
            {
              location_id: locationId,
              inventory_item_id: variant.inventoryItemId,
              available: explicitNewQuantity
            },
            {
              headers: { 'X-Shopify-Access-Token': store.accessToken },
              timeout: 8000
            }
          );
          await db.addLog(
            'INFO',
            `📉 Inventory Synced for SKU '${sku}' on ${store.name} -> Available set to: ${explicitNewQuantity}`,
            'inventory_sync',
            store.shopDomain
          );
        } else {
          // ALWAYS Adjust inventory level by minus soldQuantity (-1, -2, etc.)
          await axios.post(
            `https://${domain}/admin/api/2024-01/inventory_levels/adjust.json`,
            {
              location_id: locationId,
              inventory_item_id: variant.inventoryItemId,
              available_adjustment: -soldQuantity
            },
            {
              headers: { 'X-Shopify-Access-Token': store.accessToken },
              timeout: 8000
            }
          );
          await db.addLog(
            'INFO',
            `📉 Inventory Deducted (-${soldQuantity}) for SKU '${sku}' on connected store ${store.name}`,
            'inventory_sync',
            store.shopDomain
          );
        }
      } catch (err: any) {
        await db.addLog(
          'ERROR',
          `Failed to adjust inventory for SKU '${sku}' on ${store.name}: ${err.message}`,
          'inventory_sync',
          store.shopDomain
        );
      }
    }
  }
}


// Add Tag of Seller (e.g. Soldby-StoreAName) to Product across connected stores
export async function tagProductWithSellerOnStores(sku: string, sellerName: string): Promise<void> {
  if (!sku || !sellerName) return;
  const stores = await db.getAllStores();
  const sellerTag = `Soldby-${sellerName.replace(/\s+/g, '')}`;

  for (const store of stores) {
    if (!store.isActive || !store.accessToken) continue;

    try {
      const domain = cleanShopDomain(store.shopDomain);

      // Search product by SKU using GraphQL
      const query = `
        query findProductBySku($query: String!) {
          productVariants(first: 5, query: $query) {
            edges {
              node {
                product {
                  id
                  tags
                }
              }
            }
          }
        }
      `;

      const res = await axios.post(
        `https://${domain}/admin/api/2024-01/graphql.json`,
        { query, variables: { query: `sku:"${sku.replace(/"/g, '\\"')}"` } },
        {
          headers: { 'X-Shopify-Access-Token': store.accessToken },
          timeout: 8000
        }
      );

      const pEdges = res.data?.data?.productVariants?.edges || [];
      if (pEdges.length > 0 && pEdges[0].node?.product) {
        const productData = pEdges[0].node.product;
        const productIdRaw = productData.id;
        const cleanProductId = productIdRaw.split('/').pop();
        const existingTags = Array.isArray(productData.tags)
          ? productData.tags
          : (productData.tags ? String(productData.tags).split(',').map((t: string) => t.trim()) : []);

        const hasTag = existingTags.some(
          (t: string) => t.toLowerCase() === sellerTag.toLowerCase()
        );

        if (!hasTag) {
          const updatedTags = [...existingTags, sellerTag].join(', ');
          await axios.put(
            `https://${domain}/admin/api/2024-01/products/${cleanProductId}.json`,
            { product: { id: cleanProductId, tags: updatedTags } },
            {
              headers: { 'X-Shopify-Access-Token': store.accessToken },
              timeout: 8000
            }
          );
          await db.addLog(
            'INFO',
            `🏷️ Added tag '${sellerTag}' to product (SKU '${sku}') on ${store.name}`,
            'product_tag',
            store.shopDomain
          );
        }
      }
    } catch (err: any) {
      await db.addLog(
        'WARN',
        `Could not update product tag '${sellerTag}' for SKU '${sku}' on ${store.name}: ${err.message}`,
        'product_tag',
        store.shopDomain
      );
    }
  }
}


// Find Variant by SKU AND custom.supplier metafield using GraphQL with REST Fallback
export async function findVariantBySkuAndSupplier(
  shopDomain: string,
  accessToken: string,
  sku: string,
  targetSupplier: string
): Promise<{ variantId: string; productId?: string; status?: string; supplierMetafield?: string } | null> {
  const cleanSku = sku.trim();
  const cleanTargetSupplier = targetSupplier.trim().toLowerCase();
  if (!cleanSku || !cleanTargetSupplier) return null;
  const domain = cleanShopDomain(shopDomain);

  // 1. GraphQL Query for variant and product metafield custom.supplier
  const query = `
    query findVariantAndSupplier($query: String!) {
      productVariants(first: 25, query: $query) {
        edges {
          node {
            id
            sku
            product {
              id
              status
              metafield(namespace: "custom", key: "supplier") {
                value
              }
            }
          }
        }
      }
    }
  `;

  try {
    const res = await axios.post(
      `https://${domain}/admin/api/2024-01/graphql.json`,
      { query, variables: { query: `sku:"${cleanSku.replace(/"/g, '\\"')}"` } },
      {
        headers: { 'X-Shopify-Access-Token': accessToken },
        timeout: 8000
      }
    );

    const edges = res.data?.data?.productVariants?.edges || [];
    for (const edge of edges) {
      const vNode = edge.node;
      if (!vNode || !vNode.sku) continue;

      if (vNode.sku.trim().toLowerCase() === cleanSku.toLowerCase()) {
        const prod = vNode.product;
        const suppValue = prod?.metafield?.value ? String(prod.metafield.value).trim().toLowerCase() : '';

        if (suppValue === cleanTargetSupplier) {
          const variantGid = vNode.id;
          const productGid = prod?.id;
          return {
            variantId: variantGid ? variantGid.split('/').pop()! : '',
            productId: productGid ? productGid.split('/').pop()! : undefined,
            status: prod?.status,
            supplierMetafield: prod?.metafield?.value
          };
        }
      }
    }
  } catch (err: any) {
    await db.addLog('WARN', `GraphQL variant + supplier search failed for SKU '${cleanSku}' on ${domain}: ${err.message}`, 'variant_lookup', domain);
  }

  // 2. REST Fallback
  try {
    const restRes = await axios.get(
      `https://${domain}/admin/api/2024-01/products.json?limit=250&fields=id,status,variants`,
      {
        headers: { 'X-Shopify-Access-Token': accessToken },
        timeout: 10000
      }
    );

    const products = restRes.data?.products || [];
    for (const prod of products) {
      const variants = prod.variants || [];
      const hasSku = variants.some(
        (v: any) => v.sku && v.sku.trim().toLowerCase() === cleanSku.toLowerCase()
      );

      if (hasSku) {
        const restDetails = await getProductDetailsREST(domain, accessToken, String(prod.id));
        const mfValue = restDetails.supplierMetafield ? restDetails.supplierMetafield.trim().toLowerCase() : '';

        if (mfValue === cleanTargetSupplier) {
          const matchedVar = variants.find(
            (v: any) => v.sku && v.sku.trim().toLowerCase() === cleanSku.toLowerCase()
          );
          return {
            variantId: String(matchedVar.id),
            productId: String(prod.id),
            status: prod.status,
            supplierMetafield: restDetails.supplierMetafield || undefined
          };
        }
      }
    }
  } catch (err: any) {
    await db.addLog('WARN', `REST variant + supplier fallback failed for SKU '${cleanSku}' on ${domain}: ${err.message}`, 'variant_lookup', domain);
  }

  return null;
}

// Update Product Status to DRAFT using GraphQL with REST Fallback
export async function updateProductStatusToDraft(
  shopDomain: string,
  accessToken: string,
  productId: string
): Promise<boolean> {
  const domain = cleanShopDomain(shopDomain);
  const cleanId = productId.replace(/^gid:\/\/shopify\/Product\//, '');
  if (!cleanId) return false;

  // 1. GraphQL Mutation `productUpdate`
  const query = `
    mutation productUpdate($input: ProductInput!) {
      productUpdate(input: $input) {
        product {
          id
          status
        }
        userErrors {
          field
          message
        }
      }
    }
  `;

  const variables = {
    input: {
      id: `gid://shopify/Product/${cleanId}`,
      status: "DRAFT"
    }
  };

  try {
    const res = await axios.post(
      `https://${domain}/admin/api/2024-01/graphql.json`,
      { query, variables },
      {
        headers: { 'X-Shopify-Access-Token': accessToken },
        timeout: 8000
      }
    );

    const userErrors = res.data?.data?.productUpdate?.userErrors || [];
    if (userErrors.length === 0 && res.data?.data?.productUpdate?.product) {
      return true;
    }
    if (userErrors.length > 0) {
      await db.addLog('WARN', `GraphQL productUpdate userErrors for ${cleanId} on ${domain}: ${JSON.stringify(userErrors)}`, 'product_update', domain);
    }
  } catch (err: any) {
    await db.addLog('WARN', `GraphQL productUpdate failed for product ${cleanId} on ${domain}: ${err.message}`, 'product_update', domain);
  }

  // 2. REST API Fallback
  try {
    await axios.put(
      `https://${domain}/admin/api/2024-01/products/${cleanId}.json`,
      { product: { id: cleanId, status: 'draft' } },
      {
        headers: { 'X-Shopify-Access-Token': accessToken },
        timeout: 8000
      }
    );
    return true;
  } catch (err: any) {
    await db.addLog('ERROR', `REST product update status to draft failed for ${cleanId} on ${domain}: ${err.message}`, 'product_update', domain);
    return false;
  }
}

// Automatically change matching product's status from ACTIVE to DRAFT on connected stores (excluding specified domains) where both SKU and custom.supplier match!
export async function setMatchingProductsToDraft(
  excludeShopDomains: string[],
  sku: string,
  targetSupplier: string
): Promise<void> {
  const stores = await db.getAllStores();
  const cleanExcludes = excludeShopDomains.map(d => cleanShopDomain(d));

  for (const store of stores) {
    const cleanStoreDomain = cleanShopDomain(store.shopDomain);
    if (cleanExcludes.includes(cleanStoreDomain) || !store.isActive || !store.accessToken) {
      continue;
    }

    try {
      // Find variant on target store matching BOTH SKU AND custom.supplier
      const match = await findVariantBySkuAndSupplier(
        store.shopDomain,
        store.accessToken,
        sku,
        targetSupplier
      );

      if (match && match.productId) {
        const draftSuccess = await updateProductStatusToDraft(
          store.shopDomain,
          store.accessToken,
          match.productId
        );

        if (draftSuccess) {
          await db.addLog(
            'INFO',
            `📝 Set product status to 'DRAFT' for SKU '${sku}' (custom.supplier='${targetSupplier}', Product ID: ${match.productId}) on connected store '${store.name}' (${store.shopDomain}).`,
            'product_status_update',
            store.shopDomain
          );
        }
      } else {
        await db.addLog(
          'INFO',
          `ℹ️ No matching product with SKU '${sku}' and custom.supplier='${targetSupplier}' found on '${store.name}'. Status unchanged.`,
          'product_status_update',
          store.shopDomain
        );
      }
    } catch (err: any) {
      await db.addLog(
        'ERROR',
        `Failed to check/update product status to DRAFT for SKU '${sku}' on '${store.name}': ${err.message}`,
        'product_status_update',
        store.shopDomain
      );
    }
  }
}

// Create Order on Owner Store (Scenario 2: Non-owner sells product)
export async function createOrderOnOwnerStore(
  ownerStore: any,
  sellingStore: any,
  items: { sku: string; quantity: number; title: string; supplier: string }[],
  sourceOrderName: string,
  originalOrder?: any
): Promise<{ success: boolean; orderId?: string; orderName?: string; error?: string }> {
  const domain = cleanShopDomain(ownerStore.shopDomain);
  const lineItemsPayload: any[] = [];

  for (const item of items) {
    // Find variant on owner store matching BOTH SKU AND custom.supplier
    const variantMatch = await findVariantBySkuAndSupplier(
      ownerStore.shopDomain,
      ownerStore.accessToken,
      item.sku,
      item.supplier
    );

    if (variantMatch && variantMatch.variantId) {
      const parsedId = parseInt(variantMatch.variantId, 10);
      lineItemsPayload.push({
        variant_id: isNaN(parsedId) ? variantMatch.variantId : parsedId,
        quantity: item.quantity
      });
      await db.addLog(
        'INFO',
        `✓ Matched SKU '${item.sku}' + custom.supplier='${item.supplier}' on Owner Store ${ownerStore.name} -> Variant ID: ${variantMatch.variantId}`,
        'order_creation',
        ownerStore.shopDomain
      );
    } else {
      await db.addLog(
        'ERROR',
        `❌ SKU '${item.sku}' with custom.supplier='${item.supplier}' NOT FOUND on Owner Store ${ownerStore.name}. Excluded from owner order.`,
        'order_creation',
        ownerStore.shopDomain
      );
    }
  }

  if (lineItemsPayload.length === 0) {
    return {
      success: false,
      error: `None of the SKUs matching custom.supplier could be resolved on owner store ${ownerStore.name}`
    };
  }

  const sellerEmail = sellingStore.ownerEmail && sellingStore.ownerEmail.includes('@')
    ? sellingStore.ownerEmail
    : 'seller@dropship-sync.com';

  const sellingStoreName = sellingStore.name || `Store ${sellingStore.supplierName || sellingStore.id}`;

  let soldByTag = `SOLDby${sellingStoreName.replace(/\s+/g, '')}`;
  if (
    sellingStore.id === 'store_b' ||
    sellingStoreName.toLowerCase().includes('store b') ||
    sellingStore.shopDomain.includes('hamza')
  ) {
    soldByTag = 'SOLDbyStoreB';
  }

  let shippingAddress: any = {
    first_name: sellingStoreName,
    last_name: "(Selling Store Owner)",
    address1: "Store Address",
    city: "Lahore",
    country: "PK",
    zip: "54000"
  };

  if (originalOrder?.shipping_address) {
    shippingAddress = originalOrder.shipping_address;
  }

  const orderPayload = {
    order: {
      line_items: lineItemsPayload,
      customer: {
        first_name: sellingStoreName,
        last_name: "(Selling Store Owner)",
        email: sellerEmail
      },
      email: sellerEmail,
      shipping_address: shippingAddress,
      billing_address: shippingAddress,
      source_name: "Dropshipping",
      tags: `${soldByTag}, Automated Dropship, Dropshipping, Soldby-${sellingStore.supplierName || sellingStoreName}`,
      financial_status: "pending",
      inventory_behaviour: "decrement_obeying_policy",
      note: `Automated supplier order placed by selling store ${sellingStoreName} (${sellingStore.shopDomain}) for original order #${sourceOrderName}.`
    }
  };

  try {
    const res = await axios.post(`https://${domain}/admin/api/2024-01/orders.json`, orderPayload, {
      headers: { 'X-Shopify-Access-Token': ownerStore.accessToken },
      timeout: 10000
    });

    const newOrder = res.data?.order;
    const orderName = newOrder?.name || `#${newOrder?.order_number || newOrder?.id}`;
    await db.addLog(
      'INFO',
      `🎉 Successfully created Order ${orderName} (Tag: ${soldByTag}) on Owner Store ${ownerStore.name} for original order #${sourceOrderName} from ${sellingStoreName}!`,
      'order_creation',
      ownerStore.shopDomain
    );

    return {
      success: true,
      orderId: String(newOrder?.id),
      orderName: orderName
    };
  } catch (err: any) {
    const errorMsg = err.response ? JSON.stringify(err.response.data) : err.message;
    await db.addLog('ERROR', `Failed to create order on owner store ${ownerStore.name}: ${errorMsg}`, 'order_creation', ownerStore.shopDomain);
    return {
      success: false,
      error: errorMsg
    };
  }
}

// Process Order Created Webhook Event
export async function processOrderCreatedWebhook(order: any, shopDomain: string, sourceStore: any) {
  const orderName = order.name || `#${order.order_number || order.id}`;
  const orderIdStr = String(order.id || '');

  // 1. Check if already processed (Idempotency)
  if (orderIdStr && orderIdStr !== 'N/A') {
    const alreadySynced = await db.hasOrderBeenSynced(shopDomain, orderIdStr);
    if (alreadySynced) {
      await db.addLog('INFO', `Order ${orderName} (${orderIdStr}) on ${shopDomain} already present in Order History. Skipping duplicate.`, 'orders/create', shopDomain);
      return;
    }
  }

  await db.addLog('INFO', `📦 Webhook Received: Order ${orderName} created on ${shopDomain}`, 'orders/create', shopDomain);

  // 2. Loop Protection & Routing Check
  // Never route supplier-generated orders again!
  const orderTags = Array.isArray(order.tags) ? order.tags.join(', ') : (order.tags || '');
  const orderNote = order.note || '';
  if (
    orderTags.toLowerCase().includes('automated dropship') ||
    orderTags.toLowerCase().includes('soldby') ||
    orderTags.toLowerCase().includes('dropshipping') ||
    orderNote.toLowerCase().includes('automated supplier order')
  ) {
    await db.addLog('INFO', `🛑 Loop Protection: Order ${orderName} is a supplier-generated order (has 'SOLDby' or 'Automated Dropship' tag/note). Skipping routing.`, 'orders/create', shopDomain);
    return;
  }

  const sellingStore = sourceStore || (await db.getStoreByDomain(shopDomain)) || {
    shopDomain,
    name: shopDomain,
    supplierName: shopDomain.split('.')[0],
    ownerEmail: 'retailer@dropship-sync.com'
  };

  // Fetch complete order details using GraphQL API
  const parsedOrder = sellingStore?.accessToken
    ? await getOrderDetailsGraphQL(shopDomain, sellingStore.accessToken, String(order.id))
    : null;

  let lineItems: any[] = parsedOrder?.lineItems || [];

  if (lineItems.length === 0 && Array.isArray(order.line_items)) {
    lineItems = order.line_items.map((li: any) => ({
      id: String(li.id),
      title: li.title,
      sku: li.sku ? li.sku.trim() : '',
      quantity: li.quantity || 1,
      productId: String(li.product_id || ''),
      productTags: '',
      customSupplierMetafield: null,
      vendor: li.vendor || ''
    }));
  }

  if (lineItems.length === 0) {
    await db.addLog('WARN', `Order ${orderName} has no line items. Skipping.`, 'orders/create', shopDomain);
    return;
  }

  // 3. Process each line item independently
  const ownerOrdersMap: Map<string, { ownerStore: any; items: { sku: string; quantity: number; title: string; supplier: string }[] }> = new Map();
  const processedSkus: string[] = [];
  let totalProcessedItems = 0;

  for (const item of lineItems) {
    const sku = item.sku ? item.sku.trim() : '';
    if (!sku) {
      await db.addLog('WARN', `Item '${item.title}' in order ${orderName} has NO SKU. Skipping line item.`, 'orders/create', shopDomain);
      continue;
    }

    processedSkus.push(`${sku} (x${item.quantity})`);

    // Fetch custom.supplier metafield from product if missing
    let customSupplier = item.customSupplierMetafield;
    if (!customSupplier && sellingStore?.accessToken && item.productId) {
      const restProduct = await getProductDetailsREST(shopDomain, sellingStore.accessToken, item.productId);
      if (restProduct.supplierMetafield) customSupplier = restProduct.supplierMetafield;
    }

    if (!customSupplier) {
      customSupplier = extractSupplierName(item.productTags, null, item.vendor);
    }

    await db.addLog(
      'INFO',
      `Line item SKU '${sku}' (Qty: ${item.quantity}) -> custom.supplier: "${customSupplier || 'NONE'}"`,
      'orders/create',
      shopDomain
    );

    if (!customSupplier) {
      await db.addLog(
        'WARN',
        `⚠️ Cannot identify supplier ownership for SKU '${sku}': custom.supplier metafield is missing. Skipping automatic routing for this item.`,
        'orders/create',
        shopDomain
      );
      continue;
    }

    // Match product's custom.supplier value with configured supplier names to determine actual owner store
    const ownerStore = await db.getStoreByExactSupplierName(customSupplier);

    if (!ownerStore) {
      await db.addLog(
        'WARN',
        `⚠️ Supplier ownership for custom.supplier="${customSupplier}" on SKU '${sku}' cannot be identified uniquely among connected stores. Skipping automatic routing for this item.`,
        'orders/create',
        shopDomain
      );
      continue;
    }

    totalProcessedItems++;

    const isOwnerSale = (cleanShopDomain(sellingStore.shopDomain) === cleanShopDomain(ownerStore.shopDomain));

    if (isOwnerSale) {
      // --- SCENARIO 1: Owner Sells Own Product ---
      // Store A (Supplier: ZIA) sells product XYZ-100 with custom.supplier=ZIA
      await db.addLog(
        'INFO',
        `✓ SCENARIO 1 (Owner Sale): Store '${sellingStore.name}' (Supplier: ${sellingStore.supplierName}) sold its own product SKU '${sku}' (custom.supplier='${customSupplier}'). Keeping original order on ${sellingStore.name}. No supplier order created.`,
        'orders/create',
        shopDomain
      );

      // Automatically change matching product's status from ACTIVE to DRAFT on all other connected stores where both SKU and custom.supplier match!
      await setMatchingProductsToDraft(
        [cleanShopDomain(sellingStore.shopDomain)],
        sku,
        customSupplier
      );

      await db.recordOrderSync({
        sourceShopDomain: shopDomain,
        targetShopDomain: shopDomain,
        sourceOrderId: String(order.id || 'N/A'),
        sourceOrderName: orderName,
        targetOrderId: String(order.id || 'N/A'),
        targetOrderName: orderName,
        status: 'SUCCESS',
        skus: `${sku} (x${item.quantity})`,
        error: `Scenario 1: Owner store (${sellingStore.name}) sold own product SKU '${sku}'. Product status set to DRAFT on connected stores.`
      });

    } else {
      // --- SCENARIO 2: Non-Owner Sells Product ---
      // Store B (Supplier: HAMZA) sells product XYZ-100 with custom.supplier=ZIA. Owner Store is Store A (Supplier: ZIA).
      await db.addLog(
        'INFO',
        `⚡ SCENARIO 2 (Non-Owner Sale): Store '${sellingStore.name}' sold SKU '${sku}' belonging to Owner Store '${ownerStore.name}' (custom.supplier='${customSupplier}').`,
        'orders/create',
        shopDomain
      );

      const ownerDomain = cleanShopDomain(ownerStore.shopDomain);
      if (!ownerOrdersMap.has(ownerDomain)) {
        ownerOrdersMap.set(ownerDomain, { ownerStore, items: [] });
      }
      ownerOrdersMap.get(ownerDomain)!.items.push({
        sku,
        quantity: item.quantity,
        title: item.title,
        supplier: customSupplier
      });

      // Change matching product's status from ACTIVE to DRAFT on Store C and any other connected stores, excluding owner and selling stores.
      await setMatchingProductsToDraft(
        [cleanShopDomain(sellingStore.shopDomain), cleanShopDomain(ownerStore.shopDomain)],
        sku,
        customSupplier
      );
    }
  }

  // Create supplier orders on owner stores for Scenario 2
  for (const [ownerDomain, { ownerStore, items }] of ownerOrdersMap.entries()) {
    await db.addLog(
      'INFO',
      `🚀 Creating Supplier Order on Owner Store '${ownerStore.name}' (${ownerDomain}) for ${items.length} item(s) sold by '${sellingStore.name}'...`,
      'orders/create',
      shopDomain
    );

    const result = await createOrderOnOwnerStore(
      ownerStore,
      sellingStore,
      items,
      orderName,
      order
    );

    const skuListStr = items.map(i => `${i.sku} (x${i.quantity})`).join(', ');

    await db.recordOrderSync({
      sourceShopDomain: shopDomain,
      targetShopDomain: ownerDomain,
      sourceOrderId: String(order.id || 'N/A'),
      sourceOrderName: orderName,
      targetOrderId: result.orderId || null,
      targetOrderName: result.orderName || null,
      status: result.success ? 'SUCCESS' : 'FAILED',
      skus: skuListStr,
      error: result.error || null
    });
  }

  if (totalProcessedItems === 0) {
    await db.recordOrderSync({
      sourceShopDomain: shopDomain,
      targetShopDomain: 'N/A',
      sourceOrderId: String(order.id || 'N/A'),
      sourceOrderName: orderName,
      targetOrderId: null,
      targetOrderName: null,
      status: 'SKIPPED',
      skus: processedSkus.join(', ') || 'No SKUs',
      error: 'No line items had valid custom.supplier matching a connected owner store.'
    });
  }
}


