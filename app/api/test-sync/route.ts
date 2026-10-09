// app/api/test-sync/route.ts - Dropship Test Simulator Endpoint
import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { cleanShopDomain, processOrderCreatedWebhook } from '@/lib/shopify';

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { sourceDomain, sku, supplier, orderName } = body || {};

    if (!sourceDomain || !sku) {
      return NextResponse.json(
        { error: 'Missing required parameters: sourceDomain, sku' },
        { status: 400 }
      );
    }

    const cleanSource = cleanShopDomain(sourceDomain);
    const cleanSku = sku.trim();
    const testOrderName = orderName || `#TEST-ORDER-${Math.floor(1000 + Math.random() * 9000)}`;
    const sourceStore = await db.getStoreByDomain(cleanSource);

    const mockOrder = {
      id: `SIM-${Date.now()}`,
      name: testOrderName,
      email: 'customer-test@example.com',
      line_items: [
        {
          id: `line_${Date.now()}`,
          title: `Test Product (${cleanSku})`,
          sku: cleanSku,
          quantity: 1,
          vendor: supplier || null,
          productTags: supplier ? `Supplier: ${supplier}` : '',
          customSupplierMetafield: supplier || null
        }
      ]
    };

    await processOrderCreatedWebhook(mockOrder, cleanSource, sourceStore);

    const logs = await db.getRecentLogs(10);
    return NextResponse.json({
      success: true,
      sku: cleanSku,
      supplier: supplier || 'Auto-detecting from product metafield',
      testOrderName,
      recentLogs: logs.slice(0, 5)
    });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
