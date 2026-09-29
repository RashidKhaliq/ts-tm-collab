// lib/db.ts - Serverless Prisma Client Singleton with Persistent Storage Fallback
import { PrismaClient } from '@prisma/client';
import fs from 'fs';
import path from 'path';

// Automatically set DATABASE_URL from Vercel Postgres environment variables if available
if (!process.env.DATABASE_URL) {
  if (process.env.PRISMA_DATABASE_URL) {
    process.env.DATABASE_URL = process.env.PRISMA_DATABASE_URL;
  } else if (process.env.POSTGRES_URL) {
    process.env.DATABASE_URL = process.env.POSTGRES_URL;
  }
}

const globalForPrisma = global as unknown as { prisma: PrismaClient };

export const prisma =
  globalForPrisma.prisma ||
  new PrismaClient({
    log: process.env.NODE_ENV === 'development' ? ['query', 'error', 'warn'] : ['error'],
  });

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = prisma;

export interface MockStore {
  id: string;
  shopDomain: string;
  name: string;
  accessToken: string;
  ownerEmail: string;
  supplierName: string;
  webhookSecret?: string | null;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface MockSyncLog {
  id: string;
  level: string;
  topic?: string | null;
  shopDomain?: string | null;
  message: string;
  details?: string | null;
  createdAt: Date;
}

export interface MockOrderSync {
  id: string;
  sourceShopDomain: string;
  targetShopDomain: string;
  sourceOrderId: string;
  sourceOrderName: string;
  targetOrderId?: string | null;
  targetOrderName?: string | null;
  status: string;
  skus: string;
  error?: string | null;
  createdAt: Date;
}

function getStorageFilePath(): string {
  try {
    const dataDir = path.join(process.cwd(), '.data');
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }
    return path.join(dataDir, 'order_sync_db.json');
  } catch (e) {
    return path.join('/tmp', 'order_sync_db.json');
  }
}

// In-Memory & Persistent Fallback Storage if DATABASE_URL is not yet configured
class InMemoryDatabase {
  public stores: Map<string, MockStore> = new Map();
  public processedWebhooks: Set<string> = new Set();
  public logs: MockSyncLog[] = [];
  public orderSyncs: MockOrderSync[] = [];
  public inventorySyncMode: 'MINUS_INVENTORY' | 'DRAFT_PRODUCT' = 'DRAFT_PRODUCT';
  public dashboardPassword?: string;
  public inventorySummary?: any = null;
  private isSyncedWithDb = false;

  constructor() {
    this.seedDefaultStores();
    this.loadFromDisk();
  }

  private seedDefaultStores() {
    // Store A
    if (process.env.STORE_A_URL) {
      const domainA = process.env.STORE_A_URL.replace(/^https?:\/\//, '').replace(/\/$/, '').trim();
      const nameA = process.env.STORE_A_NAME || 'Store A';
      const supplierA = process.env.STORE_A_SUPPLIER_NAME || (process.env.STORE_A_NAME ? process.env.STORE_A_NAME.replace(/store|\(|\)/gi, '').trim() || 'Store A' : 'Store A');
      this.stores.set(domainA, {
        id: 'store_a',
        shopDomain: domainA,
        name: nameA,
        accessToken: process.env.STORE_A_ACCESS_TOKEN || '',
        ownerEmail: process.env.STORE_A_OWNER_EMAIL || '',
        supplierName: supplierA,
        webhookSecret: process.env.STORE_A_WEBHOOK_SECRET || null,
        isActive: true,
        createdAt: new Date(),
        updatedAt: new Date()
      });
    }

    // Store B
    if (process.env.STORE_B_URL) {
      const domainB = process.env.STORE_B_URL.replace(/^https?:\/\//, '').replace(/\/$/, '').trim();
      const nameB = process.env.STORE_B_NAME || 'Store B';
      const supplierB = process.env.STORE_B_SUPPLIER_NAME || (process.env.STORE_B_NAME ? process.env.STORE_B_NAME.replace(/store|\(|\)/gi, '').trim() || 'Store B' : 'Store B');
      this.stores.set(domainB, {
        id: 'store_b',
        shopDomain: domainB,
        name: nameB,
        accessToken: process.env.STORE_B_ACCESS_TOKEN || '',
        ownerEmail: process.env.STORE_B_OWNER_EMAIL || '',
        supplierName: supplierB,
        webhookSecret: process.env.STORE_B_WEBHOOK_SECRET || null,
        isActive: true,
        createdAt: new Date(),
        updatedAt: new Date()
      });
    }

    // Store C
    if (process.env.STORE_C_URL) {
      const domainC = process.env.STORE_C_URL.replace(/^https?:\/\//, '').replace(/\/$/, '').trim();
      const nameC = process.env.STORE_C_NAME || 'Store C';
      const supplierC = process.env.STORE_C_SUPPLIER_NAME || (process.env.STORE_C_NAME ? process.env.STORE_C_NAME.replace(/store|\(|\)/gi, '').trim() || 'Store C' : 'Store C');
      this.stores.set(domainC, {
        id: 'store_c',
        shopDomain: domainC,
        name: nameC,
        accessToken: process.env.STORE_C_ACCESS_TOKEN || '',
        ownerEmail: process.env.STORE_C_OWNER_EMAIL || '',
        supplierName: supplierC,
        webhookSecret: process.env.STORE_C_WEBHOOK_SECRET || null,
        isActive: true,
        createdAt: new Date(),
        updatedAt: new Date()
      });
    }
  }

  public async syncEnvStoresToDatabase(): Promise<void> {
    if (!process.env.DATABASE_URL) return;
    try {
      const envStores = [
        {
          key: 'store_a',
          url: process.env.STORE_A_URL,
          name: process.env.STORE_A_NAME || 'Store A',
          token: process.env.STORE_A_ACCESS_TOKEN || '',
          email: process.env.STORE_A_OWNER_EMAIL || '',
          supplier: process.env.STORE_A_SUPPLIER_NAME || (process.env.STORE_A_NAME ? process.env.STORE_A_NAME.replace(/store|\(|\)/gi, '').trim() || 'Store A' : 'Store A'),
          secret: process.env.STORE_A_WEBHOOK_SECRET || null,
        },
        {
          key: 'store_b',
          url: process.env.STORE_B_URL,
          name: process.env.STORE_B_NAME || 'Store B',
          token: process.env.STORE_B_ACCESS_TOKEN || '',
          email: process.env.STORE_B_OWNER_EMAIL || '',
          supplier: process.env.STORE_B_SUPPLIER_NAME || (process.env.STORE_B_NAME ? process.env.STORE_B_NAME.replace(/store|\(|\)/gi, '').trim() || 'Store B' : 'Store B'),
          secret: process.env.STORE_B_WEBHOOK_SECRET || null,
        },
        {
          key: 'store_c',
          url: process.env.STORE_C_URL,
          name: process.env.STORE_C_NAME || 'Store C',
          token: process.env.STORE_C_ACCESS_TOKEN || '',
          email: process.env.STORE_C_OWNER_EMAIL || '',
          supplier: process.env.STORE_C_SUPPLIER_NAME || (process.env.STORE_C_NAME ? process.env.STORE_C_NAME.replace(/store|\(|\)/gi, '').trim() || 'Store C' : 'Store C'),
          secret: process.env.STORE_C_WEBHOOK_SECRET || null,
        },
      ];

      for (const st of envStores) {
        if (!st.url) continue;
        const cleanDomain = st.url.replace(/^https?:\/\//, '').replace(/\/$/, '').trim();
        await prisma.store.upsert({
          where: { shopDomain: cleanDomain },
          update: {
            name: st.name,
            accessToken: st.token,
            ownerEmail: st.email,
            supplierName: st.supplier,
            webhookSecret: st.secret,
            isActive: true,
          },
          create: {
            shopDomain: cleanDomain,
            name: st.name,
            accessToken: st.token,
            ownerEmail: st.email,
            supplierName: st.supplier,
            webhookSecret: st.secret,
            isActive: true,
          },
        });
      }
      this.isSyncedWithDb = true;
    } catch (err) {
      console.warn('Error syncing environment stores to PostgreSQL DB:', err);
    }
  }

  private loadFromDisk() {
    try {
      const filePath = getStorageFilePath();
      if (fs.existsSync(filePath)) {
        const raw = fs.readFileSync(filePath, 'utf-8');
        const data = JSON.parse(raw);
        if (Array.isArray(data.stores)) {
          for (const s of data.stores) {
            this.stores.set(s.shopDomain, { ...s, createdAt: new Date(s.createdAt), updatedAt: new Date(s.updatedAt) });
          }
        }
        if (Array.isArray(data.orderSyncs)) {
          this.orderSyncs = data.orderSyncs.map((s: any) => ({ ...s, createdAt: new Date(s.createdAt) }));
        }
        if (Array.isArray(data.logs)) {
          this.logs = data.logs.map((l: any) => ({ ...l, createdAt: new Date(l.createdAt) }));
        }
        if (Array.isArray(data.processedWebhooks)) {
          this.processedWebhooks = new Set(data.processedWebhooks);
        }
        if (data.inventorySyncMode === 'DRAFT_PRODUCT' || data.inventorySyncMode === 'MINUS_INVENTORY') {
          this.inventorySyncMode = data.inventorySyncMode;
        }
        if (data.dashboardPassword) {
          this.dashboardPassword = data.dashboardPassword;
        }
        if (data.inventorySummary) {
          this.inventorySummary = data.inventorySummary;
        }
      }
    } catch (e) {
      console.warn('Error reading db fallback storage from disk:', e);
    }
  }

  private saveToDisk() {
    try {
      const filePath = getStorageFilePath();
      const payload = {
        stores: Array.from(this.stores.values()),
        orderSyncs: this.orderSyncs,
        logs: this.logs,
        processedWebhooks: Array.from(this.processedWebhooks),
        inventorySyncMode: this.inventorySyncMode,
        dashboardPassword: this.dashboardPassword,
        inventorySummary: this.inventorySummary
      };
      fs.writeFileSync(filePath, JSON.stringify(payload, null, 2), 'utf-8');
    } catch (e) {
      console.warn('Error saving db fallback storage to disk:', e);
    }
  }

  public getInventorySyncMode(): 'MINUS_INVENTORY' | 'DRAFT_PRODUCT' {
    return this.inventorySyncMode;
  }

  public setInventorySyncMode(mode: 'MINUS_INVENTORY' | 'DRAFT_PRODUCT'): void {
    this.inventorySyncMode = mode;
    this.saveToDisk();
  }

  public getDashboardPassword(): string {
    return this.dashboardPassword || process.env.DASHBOARD_PASSWORD || 'abc12345';
  }

  public setDashboardPassword(newPassword: string): void {
    this.dashboardPassword = newPassword;
    this.saveToDisk();
  }

  public getInventorySummary(): any {
    return this.inventorySummary || null;
  }

  public saveInventorySummary(summary: any): void {
    this.inventorySummary = summary;
    this.saveToDisk();
  }


  private matchesStoreSupplier(store: MockStore, targetName: string): boolean {
    if (!targetName || !targetName.trim()) return false;
    const cleanTarget = targetName.trim().toLowerCase().replace(/\s+/g, '');

    const sSupplier = store.supplierName ? store.supplierName.trim().toLowerCase().replace(/\s+/g, '') : '';
    const sName = store.name ? store.name.trim().toLowerCase().replace(/\s+/g, '') : '';
    const sDomain = store.shopDomain ? store.shopDomain.trim().toLowerCase().replace(/\s+/g, '') : '';
    const sEmail = store.ownerEmail ? store.ownerEmail.trim().toLowerCase().replace(/\s+/g, '') : '';

    if (sSupplier === cleanTarget || sName === cleanTarget || sDomain === cleanTarget || sEmail === cleanTarget) {
      return true;
    }

    if ((sName && sName.includes(cleanTarget)) || (sSupplier && cleanTarget.includes(sSupplier)) || (sName && cleanTarget.includes(sName))) {
      return true;
    }

    const stripWords = (str: string) => str.replace(/store|shop|supplier|\(|\)/gi, '');
    const strippedTarget = stripWords(cleanTarget);
    const strippedSupplier = stripWords(sSupplier);
    const strippedName = stripWords(sName);

    if (strippedTarget && ((strippedSupplier && strippedSupplier.includes(strippedTarget)) || (strippedName && strippedName.includes(strippedTarget)) || (strippedSupplier && strippedTarget.includes(strippedSupplier)))) {
      return true;
    }

    return false;
  }

  public async getStoreByDomain(domain: string): Promise<MockStore | null> {
    const cleanDomain = domain.replace(/^https?:\/\//, '').replace(/\/$/, '').trim();
    if (process.env.DATABASE_URL) {
      try {
        if (!this.isSyncedWithDb) {
          await this.syncEnvStoresToDatabase();
        }
        const store = await prisma.store.findUnique({ where: { shopDomain: cleanDomain } });
        if (store) return store;
      } catch (err) {
        console.warn('Prisma DB error, falling back to memory:', err);
      }
    }
    return this.stores.get(cleanDomain) || null;
  }

  public async getStoreBySupplierName(supplierName: string): Promise<MockStore | null> {
    const stores = await this.getAllStores();
    for (const store of stores) {
      if (this.matchesStoreSupplier(store, supplierName)) {
        return store;
      }
    }
    return null;
  }

  public async getAllStores(): Promise<MockStore[]> {
    let stores: MockStore[] = [];
    if (process.env.DATABASE_URL) {
      try {
        if (!this.isSyncedWithDb) {
          await this.syncEnvStoresToDatabase();
        }
        stores = await prisma.store.findMany({ orderBy: { createdAt: 'desc' } });
      } catch (err) {
        console.warn('Prisma DB error, falling back to memory:', err);
      }
    }
    if (stores.length === 0) {
      stores = Array.from(this.stores.values());
    }
    return stores;
  }

  public async saveStore(storeData: Omit<MockStore, 'id' | 'createdAt' | 'updatedAt'>): Promise<MockStore> {
    const cleanDomain = storeData.shopDomain.replace(/^https?:\/\//, '').replace(/\/$/, '').trim();
    if (process.env.DATABASE_URL) {
      try {
        const saved = await prisma.store.upsert({
          where: { shopDomain: cleanDomain },
          update: { ...storeData, shopDomain: cleanDomain },
          create: { ...storeData, shopDomain: cleanDomain },
        });
        return saved;
      } catch (err) {
        console.warn('Prisma DB save error:', err);
      }
    }
    const store: MockStore = {
      id: `store_${Date.now()}`,
      ...storeData,
      shopDomain: cleanDomain,
      createdAt: new Date(),
      updatedAt: new Date()
    };
    this.stores.set(cleanDomain, store);
    this.saveToDisk();
    return store;
  }

  public async isWebhookProcessed(webhookId: string): Promise<boolean> {
    if (!webhookId) return false;
    if (process.env.DATABASE_URL) {
      try {
        const found = await prisma.processedWebhook.findUnique({ where: { webhookId } });
        return !!found;
      } catch (err) {
        console.warn('Prisma DB error:', err);
      }
    }
    return this.processedWebhooks.has(webhookId);
  }

  public async recordWebhookProcessed(webhookId: string, topic: string, shopDomain: string): Promise<void> {
    if (!webhookId) return;
    if (process.env.DATABASE_URL) {
      try {
        await prisma.processedWebhook.create({
          data: { webhookId, topic, shopDomain }
        });
        return;
      } catch (err) {
        console.warn('Prisma record webhook error:', err);
      }
    }
    this.processedWebhooks.add(webhookId);
    this.saveToDisk();
  }

  public async addLog(level: string, message: string, topic?: string, shopDomain?: string, details?: string): Promise<void> {
    const entry: MockSyncLog = {
      id: `log_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
      level,
      message,
      topic: topic || null,
      shopDomain: shopDomain || null,
      details: details || null,
      createdAt: new Date()
    };

    console.log(`[${entry.createdAt.toISOString()}] [${level}] ${message}`);

    if (process.env.DATABASE_URL) {
      try {
        await prisma.syncLog.create({
          data: { level, message, topic, shopDomain, details }
        });
        return;
      } catch (err) {
        console.warn('Prisma addLog error:', err);
      }
    }

    this.logs.unshift(entry);
    if (this.logs.length > 200) this.logs.pop();
    this.saveToDisk();
  }

  public async getRecentLogs(limit = 100): Promise<MockSyncLog[]> {
    if (process.env.DATABASE_URL) {
      try {
        const logs = await prisma.syncLog.findMany({
          take: limit,
          orderBy: { createdAt: 'desc' }
        });
        if (logs && logs.length > 0) return logs;
      } catch (err) {
        console.warn('Prisma getRecentLogs error:', err);
      }
    }
    return this.logs.slice(0, limit);
  }

  public async recordOrderSync(syncData: Omit<MockOrderSync, 'id' | 'createdAt'>): Promise<void> {
    const record: MockOrderSync = {
      id: `sync_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
      ...syncData,
      createdAt: new Date()
    };

    // Save to memory and disk first for immediate consistency
    this.orderSyncs.unshift(record);
    if (this.orderSyncs.length > 200) this.orderSyncs.pop();
    this.saveToDisk();

    if (process.env.DATABASE_URL) {
      try {
        await prisma.orderSync.create({ data: syncData });
      } catch (err) {
        console.warn('Prisma recordOrderSync error:', err);
      }
    }
  }

  public async hasOrderBeenSynced(sourceShopDomain: string, sourceOrderId: string): Promise<boolean> {
    if (!sourceOrderId || sourceOrderId === 'N/A') return false;
    const cleanDomain = sourceShopDomain.replace(/^https?:\/\//, '').replace(/\/$/, '').trim();

    if (process.env.DATABASE_URL) {
      try {
        const found = await prisma.orderSync.findFirst({
          where: { sourceShopDomain: cleanDomain, sourceOrderId }
        });
        if (found) return true;
      } catch (err) {
        console.warn('Prisma DB error:', err);
      }
    }

    return this.orderSyncs.some(s => s.sourceShopDomain === cleanDomain && s.sourceOrderId === sourceOrderId);
  }

  public async getOrderSyncs(limit = 100): Promise<MockOrderSync[]> {
    if (process.env.DATABASE_URL) {
      try {
        const records = await prisma.orderSync.findMany({
          take: limit,
          orderBy: { createdAt: 'desc' }
        });
        if (records && records.length > 0) return records;
      } catch (err) {
        console.warn('Prisma getOrderSyncs error:', err);
      }
    }
    return this.orderSyncs.slice(0, limit);
  }
}

export const db = new InMemoryDatabase();

