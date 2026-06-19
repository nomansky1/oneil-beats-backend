// Apply the coverloop_data_points migration over the DIRECT Postgres pooler the
// backend already uses (reads DATABASE_URL from backend/.env). Idempotent.
//   cd backend && node scripts/apply-coverloop-data-migration.mjs
import 'dotenv/config';
import { readFileSync } from 'fs';
import pg from 'pg';

const url = process.env.DATABASE_URL;
if (!url) { console.error('✗ Set DATABASE_URL (the same one the backend uses).'); process.exit(1); }

const sql = readFileSync(new URL('../migrations/coverloop_data.sql', import.meta.url), 'utf8');
const pool = new pg.Pool({ connectionString: url, ssl: { rejectUnauthorized: false } });
try {
  await pool.query(sql);
  const { rows } = await pool.query("SELECT to_regclass('public.coverloop_data_points') AS t");
  if (rows[0] && rows[0].t) console.log('✓ coverloop_data_points table is ready. /coverloop/analytics + /coverloop/data will work once deployed.');
  else { console.error('✗ table still missing after running the migration.'); process.exit(1); }
} catch (e) {
  console.error('✗ migration failed:', e.message); process.exit(1);
} finally { await pool.end(); }
