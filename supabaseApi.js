// ─── Supabase API Helper ─────────────────────────────────────────────────────
// Replaces Google Drive/Sheets with Supabase Storage + Postgres
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://thmqqplnrjwimgqubkhp.supabase.co';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InRobXFxcGxucmp3aW1ncXVia2hwIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzU1NzMxMjgsImV4cCI6MjA5MTE0OTEyOH0.jjnJ9wPNq-vqkku80T1HydTGrqMhKeQsfbJThhHyDi8';
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

// ── BEATS CRUD ──────────────────────────────────────────────────────────────
async function fetchBeatsFromDB() {
  const { data, error } = await supabase.from('beats').select('*').eq('active', true).order('created_at', { ascending: false });
  if (error) throw new Error(`Fetch beats error: ${error.message}`);
  return (data || []).map(beat => ({
    ...beat,
    bpm: beat.bpm || 120,
    lease_price: parseFloat(beat.lease_price || beat.price) || 29.99,
    premium_price: parseFloat(beat.premium_price) || 99.99,
    stems_price: parseFloat(beat.stem_price) || 199.99,
    exclusive_price: beat.exclusive_price ? parseFloat(beat.exclusive_price) : null,
    plays: beat.plays || 0,
    tags: beat.tags ? beat.tags.split(',').map(t => t.trim()) : [],
    audio_url: beat.audio_url || '',
    audio_original_url: beat.audio_original_url || '',
    cover_art_url: beat.cover_url || '',
    wav_url: beat.wav_url || '',
    stems_url: beat.stem_url || '',
    createdAt: beat.created_at,
  }));
}

async function addBeatToDB(beatData) {
  const { data, error } = await supabase.from('beats').insert({
    title: beatData.title || '',
    artist: beatData.artist || "O'Neil",
    genre: beatData.genre || '',
    subgenre: beatData.subgenre || '',
    bpm: parseInt(beatData.bpm) || 120,
    key: beatData.key || '',
    mood: beatData.mood || '',
    price: parseFloat(beatData.lease_price) || 29.99,
    lease_price: parseFloat(beatData.lease_price) || 29.99,
    premium_price: parseFloat(beatData.premium_price) || 99.99,
    stem_price: parseFloat(beatData.stems_price) || 199.99,
    exclusive_price: beatData.exclusive_price ? parseFloat(beatData.exclusive_price) : null,
    tags: Array.isArray(beatData.tags) ? beatData.tags.join(',') : (beatData.tags || ''),
    description: beatData.description || '',
    audio_url: beatData.audio_url || '',
    audio_original_url: beatData.audio_original_url || '',
    cover_url: beatData.cover_url || '',
    wav_url: beatData.wav_url || '',
    stem_url: beatData.stem_url || '',
    plays: 0,
    active: true,
  }).select('id').single();

  if (error) throw new Error(`Add beat error: ${error.message}`);
  return data.id;
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
  const filtered = {};
  for (const [k, v] of Object.entries(updates)) {
    if (v === undefined || v === '') continue;
    const dbKey = keyMap[k] || k;
    if (!allowedDbColumns.has(dbKey)) continue;
    if (['bpm'].includes(dbKey)) filtered[dbKey] = parseInt(v) || null;
    else if (['price', 'lease_price', 'premium_price', 'stem_price', 'exclusive_price'].includes(dbKey)) filtered[dbKey] = parseFloat(v);
    else if (dbKey === 'tags' && Array.isArray(v)) filtered[dbKey] = v.join(',');
    else filtered[dbKey] = v;
  }
  const { error } = await supabase.from('beats').update(filtered).eq('id', beatId);
  if (error) throw new Error(`Update beat error: ${error.message}`);
}

async function deleteBeatInDB(beatId) {
  const { error } = await supabase.from('beats').update({ active: false }).eq('id', beatId);
  if (error) throw new Error(`Delete beat error: ${error.message}`);
}

async function incrementPlayCount(beatId) {
  const { error } = await supabase.rpc('increment', { row_id: beatId });
  if (error) console.warn('Increment play error:', error.message);
}

// ── STORAGE UPLOADS ─────────────────────────────────────────────────────────
async function uploadFileToStorage(buffer, filename, bucket, mimeType) {
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
  const { data, error } = await supabase.from('orders').insert({
    id: orderId,
    customer_email: customerEmail,
    status: 'pending',
    total_amount: totalAmount || 0,
  }).select('id').single();

  if (error) throw new Error(`Create order error: ${error.message}`);

  if (cartItems && cartItems.length > 0) {
    const items = cartItems.map(item => ({
      order_id: orderId,
      beat_id: item.beatId,
      beat_title: item.beatTitle,
      license_type: item.licenseType,
      price: item.price || 0,
    }));
    const { error: itemsErr } = await supabase.from('order_items').insert(items);
    if (itemsErr) throw new Error(`Create order items error: ${itemsErr.message}`);
  }

  return data.id;
}

async function fulfillOrder({ orderId, stripeSessionId, customerEmail, customerName, beats }) {
  const updates = {
    status: 'paid',
    stripe_session_id: stripeSessionId,
    paid_at: new Date().toISOString(),
  };
  if (customerEmail) updates.customer_email = customerEmail;
  if (customerName) updates.customer_name = customerName;

  const { error } = await supabase.from('orders').update(updates).eq('id', orderId);
  if (error) throw new Error(`Fulfill order error: ${error.message}`);

  const order = await getOrderById(orderId);
  if (order?.order_items) {
    for (const item of order.order_items) {
      const beat = beats.find(b => b.id === item.beat_id);
      if (beat) {
        const { error: updateErr } = await supabase.from('order_items').update({
          cover_url: beat.cover_url,
          // Purchased customers get the UNTAGGED original (audio_original_url).
          // Fall back to audio_url for beats uploaded before the tag pipeline.
          mp3_url: beat.audio_original_url || beat.audio_url,
          wav_url: beat.wav_url,
          stems_url: beat.stem_url,
        }).eq('id', item.id);
        if (updateErr) console.warn('Update order item error:', updateErr.message);
      }
    }
  }
}

async function getOrderById(orderId) {
  const { data, error } = await supabase.from('orders').select('*, order_items(*)').eq('id', orderId).single();
  if (error) return null;
  return data;
}

async function getOrdersByEmail(email) {
  const { data, error } = await supabase.from('orders').select('*, order_items(*)').eq('customer_email', email).eq('status', 'paid').order('created_at', { ascending: false });
  if (error) throw new Error(`Fetch orders error: ${error.message}`);
  return data || [];
}

// ── SUPABASE CLIENT ─────────────────────────────────────────────────────────
function getSupabaseClient() {
  return supabase;
}

// ── PUSH NOTIFICATIONS ──────────────────────────────────────────────────────
async function registerPushToken(userId, pushToken, platform = 'mobile') {
  try {
    const { data: existing } = await supabase.from('push_tokens').select('id').eq('user_id', userId).eq('token', pushToken).single();

    if (existing) {
      await supabase.from('push_tokens').update({ last_seen: new Date().toISOString() }).eq('id', existing.id);
      return { success: true, message: 'Token already registered' };
    }

    const { error } = await supabase.from('push_tokens').insert({
      user_id: userId,
      token: pushToken,
      platform: platform,
      created_at: new Date().toISOString(),
      last_seen: new Date().toISOString(),
    });

    if (error) throw new Error(`Register token error: ${error.message}`);
    return { success: true, message: 'Push token registered' };
  } catch (err) {
    console.error('registerPushToken error:', err);
    return { success: false, error: err.message };
  }
}

async function getPushTokens() {
  try {
    const { data, error } = await supabase.from('push_tokens').select('token').gt('last_seen', new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString());
    if (error) throw new Error(`Get tokens error: ${error.message}`);
    return (data || []).map(row => row.token);
  } catch (err) {
    console.error('getPushTokens error:', err);
    return [];
  }
}

async function removePushToken(token) {
  try {
    const { error } = await supabase.from('push_tokens').delete().eq('token', token);
    if (error) throw new Error(`Remove token error: ${error.message}`);
    return { success: true };
  } catch (err) {
    console.error('removePushToken error:', err);
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
};
