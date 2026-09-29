// prisma/seed.js - PostgreSQL Database Seeder for Shopify Connected Stores
require('dotenv').config();
const { PrismaClient } = require('@prisma/client');

// Fallback DATABASE_URL mapping for Vercel / Neon Postgres
if (!process.env.DATABASE_URL) {
  if (process.env.PRISMA_DATABASE_URL) {
    process.env.DATABASE_URL = process.env.PRISMA_DATABASE_URL;
  } else if (process.env.POSTGRES_URL) {
    process.env.DATABASE_URL = process.env.POSTGRES_URL;
  }
}

const prisma = new PrismaClient();

async function main() {
  console.log('🌱 Seeding Shopify connected stores into PostgreSQL Database from Environment Variables...');

  const storesToSeed = [
    {
      key: 'STORE_A',
      name: process.env.STORE_A_NAME || 'Store A',
      url: process.env.STORE_A_URL,
      token: process.env.STORE_A_ACCESS_TOKEN || '',
      email: process.env.STORE_A_OWNER_EMAIL || '',
      supplier: process.env.STORE_A_SUPPLIER_NAME || (process.env.STORE_A_NAME ? process.env.STORE_A_NAME.replace(/store|\(|\)/gi, '').trim() || 'Store A' : 'Store A'),
      secret: process.env.STORE_A_WEBHOOK_SECRET || null,
    },
    {
      key: 'STORE_B',
      name: process.env.STORE_B_NAME || 'Store B',
      url: process.env.STORE_B_URL,
      token: process.env.STORE_B_ACCESS_TOKEN || '',
      email: process.env.STORE_B_OWNER_EMAIL || '',
      supplier: process.env.STORE_B_SUPPLIER_NAME || (process.env.STORE_B_NAME ? process.env.STORE_B_NAME.replace(/store|\(|\)/gi, '').trim() || 'Store B' : 'Store B'),
      secret: process.env.STORE_B_WEBHOOK_SECRET || null,
    },
    {
      key: 'STORE_C',
      name: process.env.STORE_C_NAME || 'Store C',
      url: process.env.STORE_C_URL,
      token: process.env.STORE_C_ACCESS_TOKEN || '',
      email: process.env.STORE_C_OWNER_EMAIL || '',
      supplier: process.env.STORE_C_SUPPLIER_NAME || (process.env.STORE_C_NAME ? process.env.STORE_C_NAME.replace(/store|\(|\)/gi, '').trim() || 'Store C' : 'Store C'),
      secret: process.env.STORE_C_WEBHOOK_SECRET || null,
    },
  ];

  let seededCount = 0;

  for (const item of storesToSeed) {
    if (!item.url) {
      console.log(`⚠️ ${item.key} URL not provided in environment variables. Skipping.`);
      continue;
    }

    const cleanDomain = item.url.replace(/^https?:\/\//i, '').replace(/\/$/, '').trim();

    const store = await prisma.store.upsert({
      where: { shopDomain: cleanDomain },
      update: {
        name: item.name,
        accessToken: item.token,
        ownerEmail: item.email,
        supplierName: item.supplier,
        webhookSecret: item.secret,
        isActive: true,
      },
      create: {
        shopDomain: cleanDomain,
        name: item.name,
        accessToken: item.token,
        ownerEmail: item.email,
        supplierName: item.supplier,
        webhookSecret: item.secret,
        isActive: true,
      },
    });

    console.log(`✅ Seeded ${item.key} (${store.name}) -> ${cleanDomain}`);
    seededCount++;
  }

  console.log(`🎉 Database seeding finished successfully. (${seededCount} stores seeded)`);
}

main()
  .catch((e) => {
    console.error('❌ Error during Prisma DB seed:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
