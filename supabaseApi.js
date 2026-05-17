// ─── Supabase API Helper ─────────────────────────────────────────────────────
//
// 2026-05-08: refactored to bypass Supabase's PostgREST/Storage quota gate by
// connecting **directly to Postgres via the Supavisor pooler** (IPv4-compatible,
// what Vercel needs). The Postgres database itself is not gated by the
// "exceed_egress_quota" / "exceed_storage_size_quota" restrictions — those
// only block PostgREST + Storage public APIs. Direct pg connections still work
// even when the project is "Services restricted", which is what brought the
// site back online without paying for Supabase Pro.
//
// Function signatures are unchanged so callers in server.js don't need edits.
// Storage (Supabase storage.*) operations stay on the supabase-js client; new
// uploads route to GCS when GCS_BUCKET is set anyway. The legacy supabase-js
// client is still exported via getSupabaseClient() for the few places that
// need `.storage.*` or auth APIs.

require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const { Pool } = require('pg');

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://thmqqplnrjwimgqubkhp.supabase.co';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InRobXFxcGxucmp3aW1ncXVia2hwIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzU1NzMxMjgsImV4cCI6MjA5MTE0OTEyOH0.jjnJ9wPNq-vqkku80T1HydTGrqMhKeQsfbJThhHyDi8';
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

// ── Direct Postgres pool via Supavisor (IPv4 transaction pooler) ───────────
// DATABASE_URL must be set in the environment. Format:
//   postgresql://postgres.{project_ref}:{password}@aws-1-{region}.pooler.supabase.com:6543/postgres
// Vercel serverless functions reuse pool connections across invocations within
// the same lambda warm window; transaction pool mode handles spikes safely.
const DATABASE_URL = process.env.DATABASE_URL;
const pool = DATABASE_URL
  ? new Pool({
      connectionString: DATABASE_URL,
      ssl: { rejectUnauthorized: false },
      max: 5,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
    })
  : null;

if (!pool) {
  console.warn('[supabaseApi] DATABASE_URL not set — direct pg disabled, falling back to PostgREST (which may be quota-blocked).');
}

async function pgQuery(text, params = []) {
  if (!pool) throw new Error('DATABASE_URL not configured');
  const client = await pool.connect();
  try {
    const result = await client.query(text, params);
    return result;
  } finally {
    client.release();
  }
}

// ── BEATS CRUD ──────────────────────────────────────────────────────────────
// Map DB row shape → API response shape. Extracted so the post-migration
// and legacy queries share normalization without duplicating 12 lines.
function _mapBeatRow(beat) {
  return {
    ...beat,
    bpm: beat.bpm || 120,
    lease_price: parseFloat(beat.lease_price || beat.price) || 29.99,
    premium_price: parseFloat(beat.premium_price) || 99.99,
    stems_price: parseFloat(beat.stem_price) || 199.99,
    exclusive_price: beat.exclusive_price ? parseFloat(beat.exclusive_price) : null,
    plays: beat.plays || 0,
    tags: beat.tags ? String(beat.tags).split(',').map(t => t.trim()) : [],
    audio_url: beat.audio_url || '',
    audio_original_url: beat.audio_original_url || '',
    cover_art_url: beat.cover_url || '',
    wav_url: beat.wav_url || '',
    stems_url: beat.stem_url || '',
    createdAt: beat.created_at,
  };
}

// Public read filter:
//   • active=true                                    → beat is published
//   • scheduled_for IS NULL OR scheduled_for <= now() → not a future-scheduled
//     drop that hasn't matured yet. The cron /cron/publish-scheduled flips
//     active=true once the timestamp passes; until then beats are hidden from
//     customer apps, storefront, and DistroKid pulls.
//
// 2026-05-17 incident recovery: a Vercel deploy of #63 went live before the
// scheduled_for migration was run, so the post-migration query 500'd the
// storefront for ~minutes. The try/catch below detects the specific Postgres
// "column does not exist" code (42703) and falls back to the legacy query so
// future "code-before-migration" merges degrade gracefully instead of
// nuking the catalog. The fallback path logs loudly so the missing migration
// stays visible in Vercel logs and gets run ASAP.
async function fetchBeatsFromDB() {
  try {
    const { rows } = await pgQuery(
      `SELECT * FROM beats
       WHERE active = true
         AND (scheduled_for IS NULL OR scheduled_for <= now())
       ORDER BY created_at DESC NULLS LAST`
    );
    return rows.map(_mapBeatRow);
  } catch (e) {
    // 42703 = undefined_column. If the migration that adds scheduled_for
    // hasn't been applied to this database, fall back to the pre-migration
    // query. ALL OTHER errors re-throw so genuine bugs aren't masked.
    if (e && e.code === '42703') {
      console.warn(
        '[fetchBeatsFromDB] scheduled_for column missing — falling back to legacy query. ' +
        'Run migrations/scheduled_uploads.sql in Supabase SQL editor to enable scheduled uploads.'
      );
      const { rows } = await pgQuery(
        `SELECT * FROM beats WHERE active = true ORDER BY created_at DESC NULLS LAST`
      );
      return rows.map(_mapBeatRow);
    }
    throw e;
  }
}

async function addBeatToDB(beatData) {
  // Scheduled upload: scheduled_for in the future flips active=false so the
  // beat stays hidden until /cron/publish-scheduled flips it live. Null /
  // past values are treated as "publish now" (the existing behavior).
  let scheduledForTs = null;
  let isActive = true;
  if (beatData.scheduled_for) {
    const d = new Date(beatData.scheduled_for);
    if (!isNaN(d.getTime()) && d.getTime() > Date.now()) {
      scheduledForTs = d.toISOString();
      isActive = false;
    }
  }

  const cols = [
    'title', 'artist', 'genre', 'subgenre', 'bpm', 'key', 'mood', 'price',
    'lease_price', 'premium_price', 'stem_price', 'exclusive_price', 'tags',
    'description', 'audio_url', 'audio_original_url', 'cover_url', 'wav_url',
    'stem_url', 'plays', 'active', 'scheduled_for',
  ];
  const values = [
    beatData.title || '',
    beatData.artist || "O'Neil",
    beatData.genre || '',
    beatData.subgenre || '',
    parseInt(beatData.bpm) || 120,
    beatData.key || '',
    beatData.mood || '',
    parseFloat(beatData.lease_price) || 29.99,
    parseFloat(beatData.lease_price) || 29.99,
    parseFloat(beatData.premium_price) || 99.99,
    parseFloat(beatData.stems_price) || 199.99,
    beatData.exclusive_price ? parseFloat(beatData.exclusive_price) : null,
    Array.isArray(beatData.tags) ? beatData.tags.join(',') : (beatData.tags || ''),
    beatData.description || '',
    beatData.audio_url || '',
    beatData.audio_original_url || '',
    beatData.cover_url || '',
    beatData.wav_url || '',
    beatData.stem_url || '',
    0,
    isActive,
    scheduledForTs,
  ];
  const placeholders = cols.map((_, i) => `$${i + 1}`).join(', ');
  const { rows } = await pgQuery(
    `INSERT INTO beats (${cols.join(', ')}) VALUES (${placeholders}) RETURNING id`,
    values
  );
  return rows[0].id;
}

async function updateBeatInDB(beatId, updates) {
  // Frontend uses plural/verbose names; DB uses singular. Remap before writing.
  const keyMap = {
    stems_price: 'stem_price',
    cover_art_url: 'cover_url',
    stems_url: 'stem_url',
  };
  const allowedDbColumns = new Set([
    'title', 'genre', 'subgenre', 'bpm', 'key', 'mood', 'price',
    'lease_price', 'premium_price', 'stem_price', 'exclusive_price',
    'tags', 'description', 'audio_url', 'audio_original_url', 'cover_url', 'wav_url', 'stem_url', 'active',
  ]);
  const setParts = [];
  const values = [];
  for (const [k, v] of Object.entries(updates)) {
    if (v === undefined || v === '') continue;
    const dbKey = keyMap[k] || k;
    if (!allowedDbColumns.has(dbKey)) continue;
    let val = v;
    if (dbKey === 'bpm') val = parseInt(v) || null;
    else if (['price', 'lease_price', 'premium_price', 'stem_price', 'exclusive_price'].includes(dbKey)) val = parseFloat(v);
    else if (dbKey === 'tags' && Array.isArray(v)) val = v.join(',');
    values.push(val);
    setParts.push(`"${dbKey}" = $${values.length}`);
  }
  if (setParts.length === 0) return;
  values.push(beatId);
  await pgQuery(
    `UPDATE beats SET ${setParts.join(', ')} WHERE id = $${values.length}`,
    values
  );
}

async function deleteBeatInDB(beatId) {
  await pgQuery('UPDATE beats SET active = false WHERE id = $1', [beatId]);
}

async function incrementPlayCount(beatId) {
  try {
    await pgQuery('UPDATE beats SET plays = COALESCE(plays, 0) + 1 WHERE id = $1', [beatId]);
  } catch (err) {
    console.warn('Increment play error:', err.message);
  }
}

// ── STORAGE UPLOADS ─────────────────────────────────────────────────────────
// 2026-05-05 — when GCS_BUCKET env var is set, all NEW uploads route to
// Google Cloud Storage instead of Supabase. Supabase storage stays usable for
// legacy reads but is currently quota-blocked, so all writes should land on
// GCS via the gcsApi module. The mobile apps don't care which domain they
// load from, so this swap is transparent to them.
let _gcs = null;
function getGCS() {
  if (_gcs) return _gcs;
  try { _gcs = require('./gcsApi'); } catch (e) { _gcs = null; }
  return _gcs;
}
function gcsEnabled() {
  const m = getGCS();
  return !!(m && m.isGCSEnabled && m.isGCSEnabled());
}

async function uploadFileToStorage(buffer, filename, bucket, mimeType) {
  if (gcsEnabled()) {
    return getGCS().uploadFileToStorage(buffer, filename, bucket, mimeType);
  }
  const { data, error } = await supabase.storage.from(bucket).upload(filename, buffer, { contentType: mimeType, upsert: false });
  if (error) throw new Error(`Upload error: ${error.message}`);
  return supabase.storage.from(bucket).getPublicUrl(filename).data.publicUrl;
}

async function uploadAudioToStorage(buffer, filename, mimeType) {
  return uploadFileToStorage(buffer, filename, 'beats', mimeType);
}

async function uploadCoverToStorage(buffer, filename, mimeType) {
  return uploadFileToStorage(buffer, filename, 'cover-art', mimeType);
}

async function uploadBase64ToStorage(base64Data, filename, bucket, mimeType) {
  const buffer = Buffer.from(base64Data, 'base64');
  return uploadFileToStorage(buffer, filename, bucket, mimeType);
}

// ── ORDERS ──────────────────────────────────────────────────────────────────
async function createOrder({ orderId, customerEmail, cartItems, totalAmount }) {
  const { rows } = await pgQuery(
    `INSERT INTO orders (id, customer_email, status, total_amount)
     VALUES ($1, $2, 'pending', $3) RETURNING id`,
    [orderId, customerEmail, totalAmount || 0]
  );

  if (cartItems && cartItems.length > 0) {
    // Bulk insert: build a multi-row VALUES list
    const placeholders = [];
    const values = [];
    for (const item of cartItems) {
      const idx = values.length;
      placeholders.push(`($${idx + 1}, $${idx + 2}, $${idx + 3}, $${idx + 4}, $${idx + 5})`);
      values.push(orderId, item.beatId, item.beatTitle, item.licenseType, item.price || 0);
    }
    await pgQuery(
      `INSERT INTO order_items (order_id, beat_id, beat_title, license_type, price)
       VALUES ${placeholders.join(', ')}`,
      values
    );
  }

  return rows[0].id;
}

async function fulfillOrder({ orderId, stripeSessionId, customerEmail, customerName, beats }) {
  const setParts = [`status = 'paid'`, `stripe_session_id = $2`, `paid_at = now()`];
  const values = [orderId, stripeSessionId];
  if (customerEmail) { values.push(customerEmail); setParts.push(`customer_email = $${values.length}`); }
  if (customerName)  { values.push(customerName);  setParts.push(`customer_name  = $${values.length}`); }
  await pgQuery(`UPDATE orders SET ${setParts.join(', ')} WHERE id = $1`, values);

  const order = await getOrderById(orderId);
  if (order?.order_items) {
    for (const item of order.order_items) {
      const beat = beats.find(b => b.id === item.beat_id);
      if (!beat) continue;
      try {
        await pgQuery(
          `UPDATE order_items SET cover_url = $1, mp3_url = $2, wav_url = $3, stems_url = $4 WHERE id = $5`,
          [
            beat.cover_url,
            // Purchased customers get the UNTAGGED original (audio_original_url).
            // Fall back to audio_url for beats uploaded before the tag pipeline.
            beat.audio_original_url || beat.audio_url,
            beat.wav_url,
            beat.stem_url,
            item.id,
          ]
        );
      } catch (err) {
        console.warn('Update order item error:', err.message);
      }
    }
  }
}

async function getOrderById(orderId) {
  try {
    const { rows: orderRows } = await pgQuery(
      'SELECT * FROM orders WHERE id = $1 LIMIT 1', [orderId]
    );
    if (orderRows.length === 0) return null;
    const order = orderRows[0];
    const { rows: items } = await pgQuery(
      'SELECT * FROM order_items WHERE order_id = $1', [orderId]
    );
    order.order_items = items;
    return order;
  } catch (err) {
    console.warn('getOrderById:', err.message);
    return null;
  }
}

async function getOrdersByEmail(email) {
  const { rows: orderRows } = await pgQuery(
    `SELECT * FROM orders WHERE customer_email = $1 AND status = 'paid'
     ORDER BY created_at DESC NULLS LAST`,
    [email]
  );
  if (orderRows.length === 0) return [];
  const ids = orderRows.map(o => o.id);
  // order_items.order_id may be uuid or text depending on schema age — cast both
  // sides to text so the comparison works regardless.
  const { rows: items } = await pgQuery(
    `SELECT * FROM order_items WHERE order_id::text = ANY($1::text[])`,
    [ids.map(String)]
  );
  const itemsByOrder = items.reduce((acc, it) => {
    (acc[it.order_id] = acc[it.order_id] || []).push(it);
    return acc;
  }, {});
  return orderRows.map(o => ({ ...o, order_items: itemsByOrder[o.id] || [] }));
}

// ── SUPABASE CLIENT ─────────────────────────────────────────────────────────
function getSupabaseClient() {
  return supabase;
}

// ── PUSH NOTIFICATIONS ──────────────────────────────────────────────────────
// One physical device = one row. If the same Expo push token re-registers
// (e.g. user signs in after browsing as a guest), the existing row is updated
// to point at the new user_id rather than duplicating, so the device only
// receives one push per broadcast.
async function registerPushToken(userId, pushToken, platform = 'mobile') {
  try {
    await pgQuery(
      `INSERT INTO push_tokens (user_id, token, platform, created_at, last_seen)
       VALUES ($1, $2, $3, now(), now())
       ON CONFLICT (token) DO UPDATE
          SET user_id   = excluded.user_id,
              platform  = excluded.platform,
              last_seen = excluded.last_seen`,
      [userId, pushToken, platform]
    );
    return { success: true, message: 'Push token registered' };
  } catch (err) {
    console.error('registerPushToken error:', err.message);
    return { success: false, error: err.message };
  }
}

async function getPushTokens() {
  try {
    const { rows } = await pgQuery(
      `SELECT token FROM push_tokens
       WHERE last_seen > now() - interval '30 days'`
    );
    return rows.map(r => r.token);
  } catch (err) {
    console.error('getPushTokens error:', err.message);
    return [];
  }
}

async function removePushToken(token) {
  try {
    await pgQuery('DELETE FROM push_tokens WHERE token = $1', [token]);
    return { success: true };
  } catch (err) {
    console.error('removePushToken error:', err.message);
    return { success: false, error: err.message };
  }
}

module.exports = {
  fetchBeatsFromDB,
  addBeatToDB,
  updateBeatInDB,
  deleteBeatInDB,
  incrementPlayCount,
  uploadFileToStorage,
  uploadAudioToStorage,
  uploadCoverToStorage,
  uploadBase64ToStorage,
  createOrder,
  fulfillOrder,
  getOrderById,
  getOrdersByEmail,
  getSupabaseClient,
  SUPABASE_URL,
  registerPushToken,
  getPushTokens,
  removePushToken,
  // New: expose the pool for ad-hoc queries elsewhere in the backend that
  // can't easily be lifted off supabase-js (e.g. /admin/customers, reviews).
  pgQuery,
  pool,
};
