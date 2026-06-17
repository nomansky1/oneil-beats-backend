// Apply the coverloop_subscriptions migration over the DIRECT Postgres pooler
// connection the backend already uses — no Supabase console / SQL Editor needed.
//
//   cd backend
//   DATABASE_URL='postgresql://…pooler…:6543/postgres' node scripts/apply-coverloop-migration.mjs
//
// Idempotent (CREATE TABLE IF NOT EXISTS): safe to re-run. Reads the same
// DATABASE_URL your backend reads, so it hits the same DB — wherever it's hosted.
import 'dotenv/config';   // pick up DATABASE_URL from backend/.env if present
import { readFileSync } from 'fs';
import pg from 'pg';

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('✗ Set DATABASE_URL first — the SAME one your backend uses (Vercel → Settings → Environment Variables).');
  process.exit(1);
}

const sql = readFileSync(new URL('../migrations/coverloop_subscriptions.sql', import.meta.url), 'utf8');
const pool = new pg.Pool({ connectionString: url, ssl: { rejectUnauthorized: false } });

try {
  await pool.query(sql);
  const { rows } = await pool.query("SELECT to_regclass('public.coverloop_subscriptions') AS t");
  if (rows[0] && rows[0].t) {
    console.log('✓ coverloop_subscriptions table is ready. /coverloop/subscription will now work.');
  } else {
    console.error('✗ table still missing after running the migration — check the output above.');
    process.exit(1);
  }
} catch (e) {
  console.error('✗ migration failed:', e.message);
  process.exit(1);
} finally {
  await pool.end();
}
