import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { pool } from './db.js';
const sql = await readFile(fileURLToPath(new URL('../migrations/001_init.sql', import.meta.url)), 'utf8');
await pool.query(sql);
await pool.end();
console.log('Migration applied');
