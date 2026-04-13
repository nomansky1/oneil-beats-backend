// ─── Supabase API Helper ─────────────────────────────────────────────────────
// Replaces Google Drive/Sheets with Supabase Storage + Postgres
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

// Supabase credentials — anon key is safe to embed (RLS policies control access)
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://thmqqplnrjwimgqubkhp.supabase.co';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY
  || process.env.SUPABASE_ANON_KEY
  || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InRobXFxcGxucmp3aW1ncXVia2hwIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzU1NzMxMjgsImV4cCI6MjA5MTE0OTEyOH0.jjnJ9wPNq-vqkku80T1HydTGrqMhKeQsfbJThhHyDi8';

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

// ── Beats CRUD ───────────────────────────────────────────────────────────────

async function fetchBeatsFromDB() {
  const { data, error } = await supabase
    .from('beats')
    .select('*')
    .eq('active', true)
    .order('created_at', { ascending: false });

  if (error) throw new Error(`Fetch beats error: ${error.message}`);

  return (data || []).map(beat => ({
    ...beat,
    // Normalize field names for customer app compatibility
    bpm: beat.bpm || 120,
    lease_price: parseFloat(beat.lease_price || beat.price) || 29.99,
    premium_price: parseFloat(beat.premium_price) || 99.99,
    stems_price: parseFloat(beat.stem_price) || 199.99,
    plays: beat.plays || 0,
    tags: beat.tags ? beat.tags.split(',').map(t => t.trim()) : [],
    audio_url: beat.audio_url || '',
    cover_art_url: beat.cover_url || '',
    wav_url: beat.wav_url || '',
    stems_url: beat.stem_url || '',
    createdAt: beat.created_at,
  }));
}

async function addBeatToDB(beatData) {
  const { data, error } = await supabase
    .from('beats')
    .insert({
      title: beatData.title || '',
      artist: beatData.artist || "O'Neil",
      genre: beatData.genre || '',
      bpm: parseInt(beatData.bpm) || 120,
      key: beatData.key || '',
      mood: beatData.mood || '',
      price: parseFloat(beatData.lease_price) || 29.99,
      lease_price: parseFloat(beatData.lease_price) || 29.99,
      premium_price: parseFloat(beatData.premium_price) || 99.99,
      stem_price: parseFloat(beatData.stems_price) || 199.99,
      tags: Array.isArray(beatData.tags) ? beatData.tags.join(',') : (beatData.tags || ''),
      audio_url: beatData.audio_url || '',
      cover_url: beatData.cover_url || '',
      wav_url: beatData.wav_url || '',
      stem_url: beatData.stem_url || '',
      plays: 0,
      active: true,
    })
    .select('id')
    .single();

  if (error) throw new Error(`Add beat error: ${error.message}`);
  return data.id;
}

async function updateBeatInDB(beatId, updates) {
  const allowedFields = ['title', 'genre', 'subgenre', 'bpm', 'key', 'mood', 'price',
    'lease_price', 'premium_price', 'stems_price', 'stem_price', 'tags', 'audio_url',
    'cover_url', 'cover_art_url', 'wav_url', 'stem_url', 'active'];

  const filtered = {};
  for (const [k, v] of Object.entries(updates)) {
    if (allowedFields.includes(k) && v !== undefined) filtered[k] = v;
  }

  // Sync lease_price ↔ price
  if (filtered.lease_price && !filtered.price) filtered.price = filtered.lease_price;
  if (filtered.price && !filtered.lease_price) filtered.lease_price = filtered.price;

  const { error } = await supabase
    .from('beats')
    .update(filtered)
    .eq('id', beatId);

  if (error) throw new Error(`Update beat error: ${error.message}`);
}

async function deleteBeatInDB(beatId) {
  const { error } = await supabase
    .from('beats')
    .update({ active: false })
    .eq('id', beatId);

  if (error) throw new Error(`Delete beat error: ${error.message}`);
}

async function incrementPlayCount(beatId) {
  // Use RPC or a simple read-then-write
  const { data: beat, error: readErr } = await supabase
    .from('beats')
    .select('plays')
    .eq('id', beatId)
    .single();

  if (readErr) return; // silently fail for play counts

  const { error } = await supabase
    .from('beats')
    .update({ plays: (beat.plays || 0) + 1 })
    .eq('id', beatId);

  if (error) console.error('Play count error:', error.message);
}

// ── Ensure Storage Buckets Accept All File Types ─────────────────────────────
let _bucketsInitialized = false;
async function ensureBuckets() {
  if (_bucketsInitialized) return;
  _bucketsInitialized = true;
  try {
    // Update 'beats' bucket to accept ALL file types (mp3, wav, zip, etc.)
    const { error: updateErr } = await supabase.storage.updateBucket('beats', {
      public: true,
      allowedMimeTypes: null, // null = allow ALL mime types
      fileSizeLimit: 524288000, // 500MB
    });
    if (updateErr) console.warn('Could not update beats bucket:', updateErr.message);
    else console.log('Beats bucket updated: all MIME types allowed, 500MB limit');

    // Ensure 'cover-art' bucket exists
    const { error: coverErr } = await supabase.storage.updateBucket('cover-art', {
      public: true,
      allowedMimeTypes: ['image/jpeg', 'image/png', 'image/webp', 'image/gif'],
      fileSizeLimit: 10485760, // 10MB
    });
    if (coverErr) console.warn('Could not update cover-art bucket:', coverErr.message);
  } catch (e) {
    console.warn('Bucket init error:', e.message);
  }
}

// Run on module load
ensureBuckets();

// ── Storage Upload ───────────────────────────────────────────────────────────

async function uploadFileToStorage(buffer, filename, bucket, mimeType) {
  const safeName = `${Date.now()}_${filename.replace(/[^a-zA-Z0-9._-]/g, '_')}`;

  const { data, error } = await supabase.storage
    .from(bucket)
    .upload(safeName, buffer, {
      contentType: mimeType || 'application/octet-stream',
      upsert: false,
    });

  if (error) throw new Error(`Storage upload error (${bucket}): ${error.message}`);

  // Get public URL
  const { data: urlData } = supabase.storage
    .from(bucket)
    .getPublicUrl(data.path);

  return urlData.publicUrl;
}

async function uploadAudioToStorage(buffer, filename, mimeType) {
  return uploadFileToStorage(buffer, filename, 'beats', mimeType || 'audio/mpeg');
}

async function uploadCoverToStorage(buffer, filename, mimeType) {
  return uploadFileToStorage(buffer, filename, 'cover-art', mimeType || 'image/jpeg');
}

// Upload from base64
async function uploadBase64ToStorage(base64Data, filename, bucket, mimeType) {
  const buffer = Buffer.from(base64Data, 'base64');
  return uploadFileToStorage(buffer, filename, bucket, mimeType);
}

// ── Supabase client getter (for direct use in server.js if needed) ──────────
function getSupabaseClient() {
  return supabase;
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
  getSupabaseClient,
  SUPABASE_URL,
};
