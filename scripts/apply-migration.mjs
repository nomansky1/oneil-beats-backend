// Generic migration runner over the direct Postgres pooler the backend uses
// (reads DATABASE_URL from backend/.env). Idempotent SQL only.
//   cd backend && node scripts/apply-migration.mjs <file.sql>
import 'dotenv/config';
import { readFileSync } from 'fs';
import pg from 'pg';

const file = process.argv[2];
if (!file) { console.error('usage: node scripts/apply-migration.mjs <file.sql>'); process.exit(1); }
const url = process.env.DATABASE_URL;
if (!url) { console.error('✗ Set DATABASE_URL (the same one the backend uses).'); process.exit(1); }

const sql = readFileSync(new URL('../migrations/' + file, import.meta.url), 'utf8');
const pool = new pg.Pool({ connectionString: url, ssl: { rejectUnauthorized: false } });
try {
  await pool.query(sql);
  console.log('✓ applied ' + file);
} catch (e) {
  console.error('✗ migration failed:', e.message); process.exit(1);
} finally { await pool.end(); }
