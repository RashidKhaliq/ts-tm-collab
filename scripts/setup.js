import 'dotenv/config';
import fs from 'node:fs/promises';
import { pool } from '../src/db.js';
await pool.query(await fs.readFile(new URL('../sql/schema.sql',import.meta.url),'utf8'));
console.log('Database tables created.');
await pool.end();
