// ─── O'Neil Beats Backend Server v3 ──────────────────────────────────────────
// Express API: Supabase DB/Storage + Stripe checkout + license delivery
// Migrated from Google Drive/Sheets to Supabase for reliable file uploads

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { v4: uuidv4 } = require('uuid');
const nodemailer = require('nodemailer');

const {
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
} = require('./supabaseApi');
const { generateLicensePDF, generateSplitSheetPDF, LICENSE_TERMS } = require('./licenseGenerator');

// ── AI Cover Art — mood-to-prompt mapping ─────────────────────────────────────
const COVER_THEMES = {
  'Aggressive': {
    prompts: [
      'dark recording studio with red neon lights and smoke, urban gritty atmosphere, music culture',
      'burning microphone in dark studio, fire and embers, intense red and black tones',
      'underground hip hop studio with graffiti walls, red lighting, raw energy',
    ],
  },
  'Energetic': {
    prompts: [
      'vibrant music studio with gold and neon lights, dynamic energy, city skyline through window',
      'DJ turntable with golden sparks flying, electric energy, concert atmosphere',
      'recording booth with colorful LED strips, headphones floating, burst of energy',
    ],
  },
  'Dark': {
    prompts: [
      'moody purple-lit recording booth, vintage vinyl records, mysterious shadows, noir style',
      'foggy dark alley with music notes floating, purple haze, cinematic atmosphere',
      'silhouette of producer at mixing console, deep purple and blue tones, atmospheric',
    ],
  },
  'Uplifting': {
    prompts: [
      'golden hour light streaming through studio windows, warm tones, inspirational vibes',
      'sunrise over city with music waves in the sky, warm orange and gold palette',
      'open air recording session at sunset, acoustic guitar, peaceful and warm',
    ],
  },
  'Melancholic': {
    prompts: [
      'rainy window with reflections of city lights, vintage microphone, blue tones, emotional',
      'lone piano in dimly lit room, rain drops on window, melancholy atmosphere',
      'empty recording studio at night, single blue light, abandoned headphones on console',
    ],
  },
  'Smooth': {
    prompts: [
      'jazz club atmosphere, warm amber lighting, saxophone silhouette, velvet curtains',
      'smooth R&B studio lounge with leather chair, warm wood tones, soft golden light',
      'intimate concert venue with candles, acoustic instruments, cozy warm atmosphere',
    ],
  },
  'Chill': {
    prompts: [
      'cozy lo-fi bedroom studio with plants, sunset through window, headphones on desk, aesthetic',
      'rooftop music session at dusk, city skyline, string lights, relaxed vibes',
      'vinyl record player in cozy room, warm lamp light, books and plants, peaceful',
    ],
  },
  'Dreamy': {
    prompts: [
      'ethereal clouds with floating music notes, pastel pink and purple, surreal dreamscape',
      'underwater recording studio, bioluminescent lights, floating instruments, magical',
      'starry night sky with constellation forming a treble clef, cosmic purple palette',
    ],
  },
};

// ── Email Setup ────────────────────────────────────────────────────────────────
const mailer = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.EMAIL_FROM,
    pass: process.env.EMAIL_PASS,
  },
});

// ── Push Notification Helper ──────────────────────────────────────
async function sendPushNotification(expoPushTokens, title, body, data = {}) {
  const notificationPayloads = expoPushTokens.map(token => ({
    to: token,
    sound: 'default',
    title,
    body,
    data,
  }));

  try {
    const response = await fetch('https://exp.host/--/api/v2/push/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(notificationPayloads),
    });
    const result = await response.json();
    return result;
  } catch (err) {
    console.error('Push notification error:', err);
    throw err;
  }
}

// ── Express Setup ────────────────────────────────────────────────────────────
const path = require('path');
const app = express();
app.use(cors({
  origin: ['https://oneilbeats.store', 'https://www.oneilbeats.store', /localhost/, /\.vercel\.app$/],
  credentials: true,
}));
app.use(express.static(path.join(__dirname, 'public')));
// Skip JSON body parsing for raw-body routes (webhook + chunked upload)
app.use((req, res, next) => {
  if (req.path === '/webhook' || req.path === '/upload/drive-proxy-chunk') return next();
  express.json({ limit: '50mb' })(req, res, next);
});
app.use((req, res, next) => {
  if (req.path === '/webhook' || req.path === '/upload/drive-proxy-chunk') return next();
  express.urlencoded({ limit: '50mb', extended: true })(req, res, next);
});

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 100 * 1024 * 1024 } });

// ── Admin Key Middleware ─────────────────────────────────────────────────────
function requireAdminKey(req, res, next) {
  const key = req.headers['x-admin-key'] || req.query.adminKey;
  if (key !== process.env.ADMIN_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

// ──────────────────────────────────────────────────────────────────────────────
// HEALTH / STATUS
// ──────────────────────────────────────────────────────────────────────────────

// GET /health — quick sanity check on environment config & Stripe live/test mode.
// Does NOT leak secrets; only reports booleans and non-sensitive prefixes.
app.get('/health', async (req, res) => {
  const stripeKey = process.env.STRIPE_SECRET_KEY || '';
  const stripeMode = stripeKey.startsWith('sk_live_') ? 'live'
                   : stripeKey.startsWith('sk_test_') ? 'test'
                   : 'missing';
  const webhookConfigured = !!process.env.STRIPE_WEBHOOK_SECRET;
  const emailConfigured = !!(process.env.EMAIL_FROM && process.env.EMAIL_PASS);
  const supabaseConfigured = !!(process.env.SUPABASE_URL && (process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY));

  let stripeConnected = false;
  let stripeAccountId = null;
  try {
    if (stripeMode !== 'missing') {
      const acct = await stripe.accounts.retrieve();
      stripeConnected = true;
      stripeAccountId = acct.id;
    }
  } catch (e) {
    // Stripe call failed — still return but mark not connected
  }

  res.json({
    ok: true,
    stripeMode,
    stripeConnected,
    stripeAccountId,
    webhookConfigured,
    emailConfigured,
    supabaseConfigured,
    appUrl: process.env.APP_URL || null,
    serverTime: new Date().toISOString(),
  });
});

// GET /upload/status — OB Uploader uses this to authenticate admin sessions
app.get('/upload/status', requireAdminKey, (req, res) => {
  res.json({ success: true, message: 'Authenticated', serverTime: new Date().toISOString() });
});

// POST /beat-request — custom beat request from customer app
app.post('/beat-request', async (req, res) => {
  try {
    const { email, name, genre, bpm, key, mood, description } = req.body;
    if (!email || !description) {
      return res.status(400).json({ error: 'Email and description are required' });
    }

    // Store in Supabase
    const supabase = getSupabaseClient();
    const { error: dbError } = await supabase
      .from('beat_requests')
      .insert([{ email, name: name || 'Anonymous', genre, bpm, key_signature: key, mood, description, status: 'pending', created_at: new Date().toISOString() }]);

    if (dbError) console.error('beat_requests insert error (table may not exist, falling back to email):', dbError.message);

    // Always send email notification to producer
    if (process.env.EMAIL_FROM && process.env.EMAIL_PASS) {
      try {
        await mailer.sendMail({
          from: process.env.EMAIL_FROM,
          to: process.env.EMAIL_FROM, // send to yourself
          replyTo: email,
          subject: '🎹 Beat Request from ' + (name || email),
          html: buildColoredEmail({
            type: 'request',
            title: 'Custom Beat Request',
            bodyHtml: `
              <p style="color:#ccc;margin:0 0 8px;"><b style="color:#fff;">From:</b> ${name || 'Anonymous'} (${email})</p>
              <p style="color:#ccc;margin:0 0 4px;"><b style="color:#fff;">Genre:</b> ${genre || 'Not specified'}</p>
              <p style="color:#ccc;margin:0 0 4px;"><b style="color:#fff;">BPM:</b> ${bpm || 'Any'}</p>
              <p style="color:#ccc;margin:0 0 4px;"><b style="color:#fff;">Key:</b> ${key || 'Any'}</p>
              <p style="color:#ccc;margin:0 0 8px;"><b style="color:#fff;">Mood:</b> ${mood || 'Not specified'}</p>
              <p style="color:#fff;margin:12px 0 4px;font-weight:700;">Description:</p>
              <p style="background:#111;color:#fff;padding:12px;border-radius:8px;">${description}</p>
              <p style="color:#888;margin:12px 0 0;font-size:12px;">Reply directly to this email to respond to the customer.</p>`,
          }),
        });
      } catch (emailErr) {
        console.error('Beat request email failed:', emailErr.message);
      }
    }

    res.json({ success: true, message: 'Your beat request has been submitted! We\'ll get back to you soon.' });
  } catch (err) {
    console.error('Beat request error:', err);
    res.status(500).json({ error: 'Failed to submit request' });
  }
});

// ──────────────────────────────────────────────────────────────────────────────
// EXCLUSIVE OFFER SUBMISSION
// ──────────────────────────────────────────────────────────────────────────────

// Email color coding by type
const EMAIL_COLORS = {
  offer:    { bg: '#dc2626', label: 'EXCLUSIVE OFFER',   badge: '#dc2626', accent: '#fca5a5' },
  purchase: { bg: '#16a34a', label: 'PURCHASE',          badge: '#16a34a', accent: '#86efac' },
  request:  { bg: '#f59e0b', label: 'BEAT REQUEST',      badge: '#f59e0b', accent: '#fde68a' },
  system:   { bg: '#6366f1', label: 'SYSTEM',            badge: '#6366f1', accent: '#a5b4fc' },
};

function buildColoredEmail({ type, title, bodyHtml }) {
  const c = EMAIL_COLORS[type] || EMAIL_COLORS.system;
  return `<!DOCTYPE html><html><body style="background:#06060a;margin:0;padding:0;">
<div style="max-width:600px;margin:0 auto;padding:32px 20px;">
  <div style="background:${c.bg};color:#fff;display:inline-block;padding:5px 14px;border-radius:6px;font-size:11px;font-weight:800;letter-spacing:1.5px;margin-bottom:16px;">${c.label}</div>
  <h1 style="color:#fff;margin:0 0 6px;">${title}</h1>
  <div style="border-left:4px solid ${c.bg};padding-left:16px;margin:16px 0;">
    ${bodyHtml}
  </div>
  <p style="color:#444;font-size:11px;margin-top:24px;">O'Neil Beats App Notification</p>
</div></body></html>`;
}

// POST /offer — customer submits an offer on an exclusive beat
app.post('/offer', async (req, res) => {
  try {
    const { email, name, beatId, beatTitle, offerAmount, message } = req.body;
    if (!email || !beatId || !offerAmount) {
      return res.status(400).json({ error: 'Email, beatId, and offerAmount are required' });
    }

    const amount = parseFloat(offerAmount);
    if (isNaN(amount) || amount <= 0) {
      return res.status(400).json({ error: 'Offer amount must be a positive number' });
    }

    // Store offer in Supabase (table may not exist yet — graceful fallback)
    const supabase = getSupabaseClient();
    const { error: dbError } = await supabase
      .from('exclusive_offers')
      .insert([{
        email,
        name: name || 'Anonymous',
        beat_id: beatId,
        beat_title: beatTitle || '',
        offer_amount: amount,
        message: message || '',
        status: 'pending',
        created_at: new Date().toISOString(),
      }]);
    if (dbError) console.error('exclusive_offers insert error (table may not exist):', dbError.message);

    // Email to producer — red color-coded EXCLUSIVE OFFER
    if (process.env.EMAIL_FROM && process.env.EMAIL_PASS) {
      try {
        const bodyHtml = `
          <p style="color:#ccc;margin:0 0 8px;"><b style="color:#fff;">From:</b> ${name || 'Anonymous'} (${email})</p>
          <p style="color:#ccc;margin:0 0 8px;"><b style="color:#fff;">Beat:</b> ${beatTitle || beatId}</p>
          <p style="color:#fff;margin:0 0 8px;font-size:28px;font-weight:900;">$${amount.toFixed(2)}</p>
          ${message ? `<p style="color:#ccc;margin:12px 0 0;"><b style="color:#fff;">Message:</b></p><p style="background:#111;color:#fff;padding:12px;border-radius:8px;">${message}</p>` : ''}
          <p style="color:#888;margin:12px 0 0;font-size:12px;">Reply directly to this email to respond to the buyer.</p>`;

        await mailer.sendMail({
          from: `"O'Neil Beats" <${process.env.EMAIL_FROM}>`,
          to: process.env.EMAIL_FROM,
          replyTo: email,
          subject: `🔥 Exclusive Offer: $${amount.toFixed(2)} for "${beatTitle || 'Beat'}"`,
          html: buildColoredEmail({ type: 'offer', title: `Exclusive Offer — $${amount.toFixed(2)}`, bodyHtml }),
        });
      } catch (emailErr) {
        console.error('Offer email failed:', emailErr.message);
      }
    }

    res.json({ success: true, message: 'Your offer has been submitted! The producer will review and respond via email.' });
  } catch (err) {
    console.error('Offer submission error:', err);
    res.status(500).json({ error: 'Failed to submit offer' });
  }
});

// ──────────────────────────────────────────────────────────────────────────────
// BEATS API
// ──────────────────────────────────────────────────────────────────────────────

// GET /beats — fetch all active beats
app.get('/beats', async (req, res) => {
  try {
    const beats = await fetchBeatsFromDB();
    res.json({ success: true, beats });
  } catch (err) {
    console.error('Fetch beats error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ──────────────────────────────────────────────────────────────────────────────
// CUSTOMER ANALYTICS / REGISTRATION / FAVORITES / PROMO
// ──────────────────────────────────────────────────────────────────────────────

// POST /customer/track — customer behavior event logging
// Body: { userId?, action, data? }
// Always returns 200 so analytics failures never break the customer app flow.
app.post('/customer/track', async (req, res) => {
  try {
    const { userId, action, data } = req.body || {};
    if (!action) return res.json({ success: true, skipped: 'no action' });
    try {
      const supabase = getSupabaseClient();
      await supabase.from('customer_events').insert([{
        user_id: userId || null,
        action,
        event_data: data || {},
        created_at: new Date().toISOString(),
      }]);
    } catch (dbErr) {
      console.warn('customer_events insert skipped:', dbErr.message);
    }
    res.json({ success: true });
  } catch (err) {
    res.json({ success: true, error: err.message });
  }
});

// POST /customer/register — upsert customer profile row
// Body: { id, email?, name?, phone?, expoPushToken? }
app.post('/customer/register', async (req, res) => {
  try {
    const { id, email, name, phone, expoPushToken } = req.body || {};
    if (!id && !email) return res.status(400).json({ error: 'id or email required' });
    const supabase = getSupabaseClient();
    const row = {
      id: id || undefined,
      email: email || null,
      name: name || null,
      phone: phone || null,
      last_seen: new Date().toISOString(),
    };
    Object.keys(row).forEach(k => row[k] === undefined && delete row[k]);
    try {
      await supabase.from('customers').upsert(row, { onConflict: id ? 'id' : 'email' });
    } catch (dbErr) {
      console.warn('customers upsert skipped:', dbErr.message);
    }
    if (expoPushToken && id) {
      try { await registerPushToken(id, expoPushToken, 'mobile'); } catch (_) {}
    }
    res.json({ success: true });
  } catch (err) {
    console.error('Customer register error:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /favorites?userId=... — list favorited beat IDs
app.get('/favorites', async (req, res) => {
  try {
    const userId = req.query.userId;
    if (!userId) return res.json({ success: true, favorites: [] });
    const supabase = getSupabaseClient();
    const { data, error } = await supabase.from('favorites').select('beat_id').eq('user_id', userId);
    if (error) {
      console.warn('favorites fetch skipped:', error.message);
      return res.json({ success: true, favorites: [] });
    }
    res.json({ success: true, favorites: (data || []).map(r => r.beat_id) });
  } catch (err) {
    res.json({ success: true, favorites: [], error: err.message });
  }
});

// POST /favorites — toggle favorite: { userId, beatId, favorited }
app.post('/favorites', async (req, res) => {
  try {
    const { userId, beatId, favorited } = req.body || {};
    if (!userId || !beatId) return res.status(400).json({ error: 'userId and beatId required' });
    const supabase = getSupabaseClient();
    try {
      if (favorited === false) {
        await supabase.from('favorites').delete().eq('user_id', userId).eq('beat_id', beatId);
      } else {
        await supabase.from('favorites').upsert({
          user_id: userId,
          beat_id: beatId,
          created_at: new Date().toISOString(),
        }, { onConflict: 'user_id,beat_id' });
      }
    } catch (dbErr) {
      console.warn('favorites write skipped:', dbErr.message);
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET/POST /promo/check-first-purchase — email via query or body
// Returns { eligible, firstTime, paidOrders, promoCode }
async function checkFirstPurchaseHandler(req, res) {
  try {
    const email = (req.body && req.body.email) || req.query.email;
    if (!email) return res.json({ eligible: true, firstTime: true, promoCode: 'FIRST10' });
    const orders = await getOrdersByEmail(email);
    const count = (orders || []).length;
    const firstTime = count === 0;
    res.json({ eligible: firstTime, firstTime, paidOrders: count, promoCode: 'FIRST10' });
  } catch (err) {
    res.json({ eligible: true, firstTime: true, promoCode: 'FIRST10', error: err.message });
  }
}
app.get('/promo/check-first-purchase', checkFirstPurchaseHandler);
app.post('/promo/check-first-purchase', checkFirstPurchaseHandler);

// ──────────────────────────────────────────────────────────────────────────────
// ADMIN BEAT CRUD + LICENSE TERMS
// ──────────────────────────────────────────────────────────────────────────────

// PUT /admin/beat/:id — update beat metadata
app.put('/admin/beat/:id', requireAdminKey, async (req, res) => {
  try {
    const { id } = req.params;
    if (!id) return res.status(400).json({ error: 'Beat ID required' });
    await updateBeatInDB(id, req.body || {});
    res.json({ success: true });
  } catch (err) {
    console.error('Admin beat update error:', err);
    res.status(500).json({ error: err.message });
  }
});

// DELETE /admin/beat/:id — soft-delete beat (sets active=false)
app.delete('/admin/beat/:id', requireAdminKey, async (req, res) => {
  try {
    const { id } = req.params;
    if (!id) return res.status(400).json({ error: 'Beat ID required' });
    await deleteBeatInDB(id);
    res.json({ success: true });
  } catch (err) {
    console.error('Admin beat delete error:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /admin/licenses — returns { licenses: {lease, premium, stems, exclusive} }
// Reads a single-row JSON blob from license_terms table; falls back to defaults.
app.get('/admin/licenses', requireAdminKey, async (req, res) => {
  try {
    const supabase = getSupabaseClient();
    const { data } = await supabase.from('license_terms').select('terms').eq('id', 1).maybeSingle();
    const licenses = (data && data.terms) ? data.terms : LICENSE_TERMS;
    res.json({ success: true, licenses });
  } catch (err) {
    res.json({ success: true, licenses: LICENSE_TERMS, warning: err.message });
  }
});

// GET /admin/offers?status=pending — list exclusive-rights offers
app.get('/admin/offers', requireAdminKey, async (req, res) => {
  try {
    const supabase = getSupabaseClient();
    let query = supabase.from('exclusive_offers').select('*').order('created_at', { ascending: false }).limit(200);
    if (req.query.status) query = query.eq('status', req.query.status);
    const { data, error } = await query;
    if (error) {
      console.warn('exclusive_offers list warning:', error.message);
      return res.json({ success: true, offers: [] });
    }
    res.json({ success: true, offers: data || [] });
  } catch (err) {
    res.json({ success: true, offers: [], error: err.message });
  }
});

// PATCH /admin/offers/:id — update status (accepted | declined | archived)
app.patch('/admin/offers/:id', requireAdminKey, async (req, res) => {
  try {
    const { id } = req.params;
    const { status, note } = req.body || {};
    if (!id) return res.status(400).json({ error: 'id required' });
    if (!status) return res.status(400).json({ error: 'status required' });
    if (!['pending', 'accepted', 'declined', 'archived'].includes(status)) {
      return res.status(400).json({ error: 'invalid status' });
    }
    const supabase = getSupabaseClient();
    const patch = { status, updated_at: new Date().toISOString() };
    if (note) patch.admin_note = note;
    const { error } = await supabase.from('exclusive_offers').update(patch).eq('id', id);
    if (error) throw new Error(error.message);
    res.json({ success: true });
  } catch (err) {
    console.error('Admin offer update error:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /admin/analytics?days=30 — real analytics from customer_events + favorites + orders
app.get('/admin/analytics', requireAdminKey, async (req, res) => {
  try {
    const days = Math.max(1, Math.min(180, parseInt(req.query.days, 10) || 30));
    const since = new Date(Date.now() - days * 86400000).toISOString();
    const supabase = getSupabaseClient();
    const [evtsRes, favsRes, ordersRes] = await Promise.all([
      supabase.from('customer_events').select('user_id, action, event_data, created_at').gte('created_at', since).limit(50000),
      supabase.from('favorites').select('beat_id, user_id, created_at').gte('created_at', since).limit(20000),
      supabase.from('orders').select('id, customer_email, total_amount, created_at').gte('created_at', since).limit(10000),
    ]);
    const evts = evtsRes.data || [];
    const favs = favsRes.data || [];
    const orders = ordersRes.data || [];

    const playsByBeat = {};
    const actionCounts = {};
    const uniqueUsers = new Set();
    const dailyPlays = {};
    evts.forEach(e => {
      actionCounts[e.action] = (actionCounts[e.action] || 0) + 1;
      if (e.user_id) uniqueUsers.add(e.user_id);
      if (e.action === 'play') {
        const bid = e.event_data?.beatId || e.event_data?.beat_id;
        if (bid) playsByBeat[bid] = (playsByBeat[bid] || 0) + 1;
        const d = (e.created_at || '').slice(0, 10);
        if (d) dailyPlays[d] = (dailyPlays[d] || 0) + 1;
      }
    });

    const favsByBeat = {};
    favs.forEach(f => { favsByBeat[f.beat_id] = (favsByBeat[f.beat_id] || 0) + 1; });

    const revenue = orders.reduce((s, o) => s + (parseFloat(o.total_amount) || 0), 0);

    const topBeats = Object.entries(playsByBeat)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 20)
      .map(([beatId, plays]) => ({ beatId, plays, favorites: favsByBeat[beatId] || 0 }));

    const series = [];
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10);
      series.push({ date: d, plays: dailyPlays[d] || 0 });
    }

    res.json({
      success: true,
      windowDays: days,
      totals: {
        events: evts.length,
        plays: actionCounts.play || 0,
        favorites: favs.length,
        orders: orders.length,
        revenue: +revenue.toFixed(2),
        uniqueUsers: uniqueUsers.size,
      },
      actionCounts,
      topBeats,
      series,
    });
  } catch (err) {
    res.json({ success: true, totals: {}, topBeats: [], series: [], error: err.message });
  }
});

// Reusable fulfillment email (webhook + admin resend).
async function sendFulfillmentEmail(order, orderId, items) {
  const baseUrl = process.env.APP_URL || 'https://oneil-beats-backend.vercel.app';
  const beatCards = items.map(item => {
    const dlBase = `${baseUrl}/download/${orderId}/${item.beat_id}`;
    const licBase = `${baseUrl}/license/${orderId}/${item.beat_id}`;
    let buttons = `<a href="${dlBase}?format=mp3" style="display:inline-block;padding:10px 18px;margin:4px 6px 4px 0;background:#e63946;color:#000;text-decoration:none;border-radius:6px;font-weight:700;font-size:13px;">MP3</a>`;
    if (item.license_type === 'premium' || item.license_type === 'stems') {
      buttons += `<a href="${dlBase}?format=wav" style="display:inline-block;padding:10px 18px;margin:4px 6px 4px 0;background:#8b5cf6;color:#fff;text-decoration:none;border-radius:6px;font-weight:700;font-size:13px;">WAV</a>`;
    }
    if (item.license_type === 'stems') {
      buttons += `<a href="${dlBase}?format=stems" style="display:inline-block;padding:10px 18px;margin:4px 6px 4px 0;background:#10b981;color:#000;text-decoration:none;border-radius:6px;font-weight:700;font-size:13px;">Stems</a>`;
    }
    buttons += `<a href="${licBase}" style="display:inline-block;padding:10px 18px;margin:4px 6px 4px 0;background:#f59e0b;color:#000;text-decoration:none;border-radius:6px;font-weight:700;font-size:13px;">License PDF</a>`;
    return `<div style="background:#0f0f14;border:1px solid #222;border-radius:12px;padding:20px;margin-bottom:14px;"><h3 style="color:#fff;margin:0;font-size:17px;">${item.beat_title}</h3><div style="margin-top:12px;">${buttons}</div></div>`;
  }).join('');

  const textLinks = items.map(item => {
    const dlBase = `${baseUrl}/download/${orderId}/${item.beat_id}`;
    const licBase = `${baseUrl}/license/${orderId}/${item.beat_id}`;
    return `• ${item.beat_title}\n  MP3: ${dlBase}?format=mp3\n  License: ${licBase}`;
  }).join('\n\n');

  const htmlEmail = buildColoredEmail({
    type: 'purchase',
    title: '🎵 Your O\'Neil Beats Are Ready!',
    bodyHtml: `<p style="color:#888;margin:0 0 12px;">Order #${orderId.slice(0,8)}</p>${beatCards}<p style="color:#666;font-size:12px;margin-top:20px;">Thank you for your purchase!</p>`,
  });

  const attachments = [];
  for (const item of items) {
    try {
      const pdfBuffer = await generateLicensePDF({
        beatTitle: item.beat_title,
        licenseType: item.license_type,
        customerName: order.customer_name || 'Customer',
        customerEmail: order.customer_email,
        orderDate: new Date().toLocaleDateString(),
        licenseTerms: LICENSE_TERMS[item.license_type] || LICENSE_TERMS.lease,
      });
      attachments.push({
        filename: `${item.beat_title.replace(/[^a-z0-9]/gi, '_').toLowerCase()}_license.pdf`,
        content: pdfBuffer,
        contentType: 'application/pdf',
      });
      const splitBuffer = await generateSplitSheetPDF({
        beat: { title: item.beat_title, genre: item.genre || '', bpm: item.bpm || '', key: item.key || '' },
        buyer: { name: order.customer_name || 'Artist', email: order.customer_email },
        orderId,
        licenseType: item.license_type,
      });
      attachments.push({
        filename: `${item.beat_title.replace(/[^a-z0-9]/gi, '_').toLowerCase()}_split_sheet.pdf`,
        content: splitBuffer,
        contentType: 'application/pdf',
      });
    } catch (pdfErr) {
      console.error(`Error generating PDF for beat ${item.beat_title}:`, pdfErr);
    }
  }

  await mailer.sendMail({
    from: `"O'Neil Beats" <${process.env.EMAIL_FROM}>`,
    to: order.customer_email,
    subject: `🎵 Your O'Neil Beats Order Ready!`,
    text: `Thanks for your purchase!\n\n${textLinks}\n\nEnjoy!`,
    html: htmlEmail,
    attachments: attachments.length > 0 ? attachments : undefined,
  });
}

// GET /admin/orders — list recent orders (for Orders inbox)
app.get('/admin/orders', requireAdminKey, async (req, res) => {
  try {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase
      .from('orders')
      .select('id, customer_email, customer_name, total_amount, status, created_at, order_items(beat_id, beat_title, license_type)')
      .order('created_at', { ascending: false })
      .limit(200);
    if (error) throw new Error(error.message);
    res.json({ success: true, orders: data || [] });
  } catch (err) {
    res.json({ success: true, orders: [], error: err.message });
  }
});

// POST /admin/order/:id/resend — re-send the fulfillment email
app.post('/admin/order/:id/resend', requireAdminKey, async (req, res) => {
  try {
    const { id } = req.params;
    const order = await getOrderById(id);
    if (!order) return res.status(404).json({ error: 'Order not found' });
    if (!order.customer_email) return res.status(400).json({ error: 'Order has no customer_email' });
    const items = order.order_items || [];
    if (items.length === 0) return res.status(400).json({ error: 'Order has no items' });
    await sendFulfillmentEmail(order, id, items);
    res.json({ success: true, email: order.customer_email, items: items.length });
  } catch (err) {
    console.error('Order resend error:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /admin/customers — real customer list with play/favorite/order aggregates
app.get('/admin/customers', requireAdminKey, async (req, res) => {
  try {
    const supabase = getSupabaseClient();
    const { data: customers, error: cErr } = await supabase
      .from('customers')
      .select('*')
      .order('last_seen', { ascending: false })
      .limit(500);
    if (cErr) {
      console.warn('customers fetch skipped:', cErr.message);
      return res.json({ success: true, customers: [] });
    }
    const rows = customers || [];
    const ids = rows.map(c => c.id).filter(Boolean);
    const playMap = {};
    const favMap = {};
    if (ids.length) {
      try {
        const { data: evts } = await supabase
          .from('customer_events')
          .select('user_id, action')
          .in('user_id', ids)
          .limit(20000);
        (evts || []).forEach(e => {
          if (e.action === 'play') playMap[e.user_id] = (playMap[e.user_id] || 0) + 1;
        });
      } catch (_) {}
      try {
        const { data: favs } = await supabase
          .from('favorites')
          .select('user_id')
          .in('user_id', ids);
        (favs || []).forEach(f => { favMap[f.user_id] = (favMap[f.user_id] || 0) + 1; });
      } catch (_) {}
    }
    const out = rows.map(c => ({
      id: c.id,
      email: c.email || '',
      name: c.name || '',
      phone: c.phone || '',
      joined: c.created_at || null,
      lastActive: c.last_seen || null,
      plays: playMap[c.id] || 0,
      favorites: favMap[c.id] || 0,
    }));
    res.json({ success: true, customers: out });
  } catch (err) {
    res.json({ success: true, customers: [], error: err.message });
  }
});

// PUT /admin/licenses — body: { licenses: {lease, premium, stems, exclusive} }
app.put('/admin/licenses', requireAdminKey, async (req, res) => {
  try {
    const { licenses } = req.body || {};
    if (!licenses || typeof licenses !== 'object') {
      return res.status(400).json({ error: 'licenses object required' });
    }
    const supabase = getSupabaseClient();
    const { error } = await supabase.from('license_terms').upsert({
      id: 1,
      terms: licenses,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'id' });
    if (error) throw new Error(error.message);
    res.json({ success: true });
  } catch (err) {
    console.error('Admin licenses update error:', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /upload/beat — multipart upload (audio + optional cover)
app.post('/upload/beat',
  requireAdminKey,
  upload.fields([
    { name: 'audio', maxCount: 1 },
    { name: 'cover', maxCount: 1 },
  ]),
  async (req, res) => {
    try {
      const { title, genre, bpm, key, mood, tags, lease_price, premium_price, stems_price } = req.body;

      if (!req.files?.audio?.[0]) {
        return res.status(400).json({ error: 'Audio file required' });
      }

      const audioFile = req.files.audio[0];
      const coverFile = req.files.cover?.[0];

      const audioUrl = await uploadAudioToStorage(
        audioFile.buffer,
        `${title || 'beat'}_${Date.now()}.mp3`,
        audioFile.mimetype
      );

      let coverUrl = '';
      if (coverFile) {
        coverUrl = await uploadCoverToStorage(
          coverFile.buffer,
          `${title || 'beat'}_cover_${Date.now()}.jpg`,
          coverFile.mimetype
        );
      }

      const beatId = await addBeatToDB({
        title, genre, bpm, key, mood,
        tags: tags ? tags.split(',') : [],
        lease_price, premium_price, stems_price,
        audio_url: audioUrl,
        cover_url: coverUrl,
      });

      // Send push notification to all customers about the new beat
      try {
        const tokens = await getPushTokens();
        if (tokens.length > 0) {
          sendPushNotification(
            tokens,
            '🎵 New Beat Released!',
            `Check out "${title}" — ${genre} · ${bpm} BPM`,
            { beatId, beatTitle: title, genre, bpm }
          ).catch(err => console.error('Push notification send error:', err));
        }
      } catch (notifErr) {
        console.error('Error sending push notifications:', notifErr);
      }

      res.json({ success: true, beatId, audioUrl, coverUrl, message: `Beat "${title}" uploaded!` });
    } catch (err) {
      console.error('Upload error:', err);
      res.status(500).json({ error: err.message });
    }
  }
);

// ──────────────────────────────────────────────────────────────────────────────
// FILE UPLOAD PROXY (for OB Uploader mobile app)
// Routes: drive-proxy-small, drive-proxy-init, drive-proxy-chunk, drive-finalize, beat-metadata
// ──────────────────────────────────────────────────────────────────────────────

// Map file type to Supabase bucket + path prefix
function _bucketForType(type) {
  if (type === 'cover') return { bucket: 'cover-art', prefix: 'covers' };
  if (type === 'wav')   return { bucket: 'beats', prefix: 'wav' };
  if (type === 'stems') return { bucket: 'beats', prefix: 'stems' };
  return { bucket: 'beats', prefix: 'mp3' };
}

// POST /upload/drive-proxy-small — single-shot file upload via FormData
app.post('/upload/drive-proxy-small', requireAdminKey, upload.single('file'), async (req, res) => {
  try {
    const fileType = req.body.type || 'mp3';
    const { bucket, prefix } = _bucketForType(fileType);
    const file = req.file;
    if (!file) return res.status(400).json({ error: 'No file provided' });

    const safeName = `${prefix}/${Date.now()}_${Math.random().toString(36).slice(2,6)}_${(file.originalname || 'file').replace(/[^a-zA-Z0-9._-]/g, '_')}`;
    const supabase = getSupabaseClient();
    const { data, error } = await supabase.storage.from(bucket).upload(safeName, file.buffer, {
      contentType: file.mimetype || 'application/octet-stream',
      upsert: true,
    });
    if (error) throw new Error(`Storage upload error: ${error.message}`);
    const publicUrl = supabase.storage.from(bucket).getPublicUrl(safeName).data.publicUrl;
    res.json({ success: true, publicUrl, path: safeName });
  } catch (err) {
    console.error('drive-proxy-small error:', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /upload/drive-proxy-init — init direct-to-Supabase upload
// Returns a Supabase signed upload URL; client PUTs the WHOLE file in one request
// (Supabase signed upload URLs are one-shot — do NOT send chunks, you'll get 409 Duplicate)
app.post('/upload/drive-proxy-init', requireAdminKey, async (req, res) => {
  try {
    const { filename, mimeType, fileSize, type } = req.body;
    if (!filename) return res.status(400).json({ error: 'filename required' });
    const fileType = type || 'mp3';
    const { bucket, prefix } = _bucketForType(fileType);
    const cleanName = String(filename).replace(/[^a-zA-Z0-9._-]/g, '_');
    const safeName = `${prefix}/${Date.now()}_${Math.random().toString(36).slice(2,6)}_${cleanName}`;
    const supabase = getSupabaseClient();
    const { data, error } = await supabase.storage.from(bucket).createSignedUploadUrl(safeName);
    if (error) throw new Error(`Signed URL error: ${error.message}`);
    const publicUrl = supabase.storage.from(bucket).getPublicUrl(safeName).data.publicUrl;
    res.json({ success: true, uploadUrl: data.signedUrl, path: safeName, bucket, publicUrl, token: data.token });
  } catch (err) {
    console.error('drive-proxy-init error:', err);
    res.status(500).json({ error: err.message });
  }
});

// PUT /upload/drive-proxy-chunk — proxy a chunk to Supabase Storage
// On serverless (Vercel), each chunk goes directly through to Supabase
app.put('/upload/drive-proxy-chunk', requireAdminKey, express.raw({ type: '*/*', limit: '10mb' }), async (req, res) => {
  try {
    const uploadUrl = req.headers['x-upload-url'];
    const contentRange = req.headers['x-content-range'] || '';
    const contentType = req.headers['x-content-type'] || 'application/octet-stream';
    const chunkBuf = Buffer.isBuffer(req.body) ? req.body : Buffer.from(req.body);

    // If uploadUrl is a Supabase signed URL, proxy the chunk directly
    if (uploadUrl && uploadUrl.startsWith('http')) {
            const proxyRes = await fetch(uploadUrl, {
        method: 'PUT',
        headers: {
          'Content-Type': contentType,
          'Content-Range': contentRange,
          'x-upsert': 'true',
        },
        body: chunkBuf,
      });
      if (proxyRes.ok) {
        const data = await proxyRes.json().catch(() => ({}));
        return res.json({ success: true, fileId: data.Key || uploadUrl, status: 200, done: true });
      }
      // If 308, chunk was received
      if (proxyRes.status === 308) {
        return res.json({ success: true, status: 308, done: false });
      }
      const errText = await proxyRes.text().catch(() => '');
      throw new Error(`Supabase chunk upload failed (${proxyRes.status}): ${errText.substring(0, 200)}`);
    }

    // Fallback: upload the chunk as a complete file to Supabase
    const safeName = `uploads/chunk_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const supabase = getSupabaseClient();
    const { error } = await supabase.storage.from('beats').upload(safeName, chunkBuf, {
      contentType, upsert: true,
    });
    if (error) throw new Error(`Chunk upload error: ${error.message}`);
    const publicUrl = supabase.storage.from('beats').getPublicUrl(safeName).data.publicUrl;
    return res.json({ success: true, fileId: safeName, publicUrl, done: true });
  } catch (err) {
    console.error('drive-proxy-chunk error:', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /upload/drive-finalize — finalize upload, return public URL
app.post('/upload/drive-finalize', requireAdminKey, async (req, res) => {
  try {
    const { fileId, path, bucket: bucketParam, type } = req.body;
    const storagePath = path || fileId;
    if (!storagePath) return res.status(400).json({ error: 'path or fileId required' });
    const bucket = bucketParam || _bucketForType(type).bucket;
    const supabase = getSupabaseClient();
    const cleanPath = String(storagePath).includes('/object/')
      ? String(storagePath).split('/object/')[1] || storagePath
      : storagePath;
    const publicUrl = supabase.storage.from(bucket).getPublicUrl(cleanPath).data.publicUrl;
    res.json({ success: true, publicUrl });
  } catch (err) {
    console.error('drive-finalize error:', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /upload/get-signed-url — generate a signed upload URL for direct client-to-Supabase upload
app.post('/upload/get-signed-url', requireAdminKey, async (req, res) => {
  try {
    const { filename, bucket } = req.body;
    if (!filename) return res.status(400).json({ error: 'filename required' });
    const targetBucket = bucket || 'beats';
    const safeName = `${Date.now()}_${filename.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
    const supabase = getSupabaseClient();
    const { data, error } = await supabase.storage.from(targetBucket).createSignedUploadUrl(safeName);
    if (error) throw new Error(`Signed URL error: ${error.message}`);
    const publicUrl = supabase.storage.from(targetBucket).getPublicUrl(safeName).data.publicUrl;
    res.json({ success: true, signedUrl: data.signedUrl, publicUrl, path: safeName });
  } catch (err) {
    console.error('get-signed-url error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Filename-based BPM/key fallback for when spectral analysis isn't available (MP3 on serverless).
function _filenameDetect(filename) {
  const name = String(filename || '').replace(/\.[^.]+$/, '').replace(/[-_]/g, ' ');
  let bpm = null, key = null;
  const bpmMatch = name.match(/(\d{2,3})\s*bpm/i);
  if (bpmMatch) {
    const v = parseInt(bpmMatch[1], 10);
    if (v >= 50 && v <= 250) bpm = v;
  }
  const keyPatterns = [
    { re: /\b([A-G])\s*sharp\s*(minor|major|min|maj)\b/i, fn: m => `${m[1]}# ${m[2].toLowerCase().startsWith('min') ? 'Minor' : 'Major'}` },
    { re: /\b([A-G])\s*flat\s*(minor|major|min|maj)\b/i, fn: m => `${m[1]}b ${m[2].toLowerCase().startsWith('min') ? 'Minor' : 'Major'}` },
    { re: /\b([A-G][b#]?)\s*(minor|major|min|maj)\b/i, fn: m => `${m[1]} ${m[2].toLowerCase().startsWith('min') ? 'Minor' : 'Major'}` },
    { re: /\b([A-G][b#]?)m\b/, fn: m => `${m[1]} Minor` },
    { re: /\b([A-G][b#])\b/, fn: m => `${m[1]} Major` },
  ];
  for (const { re, fn } of keyPatterns) {
    const m = name.match(re);
    if (m) { key = fn(m); break; }
  }
  return { bpm, key };
}

function _moodFrom(bpm, key) {
  if (!bpm || !key) return null;
  const isMinor = key.includes('Minor');
  if (bpm >= 140 && isMinor) return 'Aggressive';
  if (bpm >= 140) return 'Energetic';
  if (bpm >= 110 && isMinor) return 'Dark';
  if (bpm >= 110) return 'Uplifting';
  if (bpm >= 85 && isMinor) return 'Melancholic';
  if (bpm >= 85) return 'Smooth';
  return isMinor ? 'Chill' : 'Dreamy';
}

// POST /upload/analyze-audio — BPM + key detection from uploaded audio file
// Strategy: spectral analysis on WAVs, filename parsing as fallback/complement for MP3
app.post('/upload/analyze-audio', requireAdminKey, upload.single('audio'), async (req, res) => {
  try {
    const file = req.file;
    if (!file) return res.status(400).json({ error: 'No audio file provided' });

    const fromName = _filenameDetect(file.originalname || '');

    const MusicTempo = require('music-tempo');
    const fftJs = require('fft-js');
    const fft = fftJs.fft;
    const fftMag = fftJs.util.fftMag;

    let pcmData = null, sampleRate = null;
    const isWav = (file.originalname || '').toLowerCase().endsWith('.wav') ||
                  (file.mimetype || '').includes('wav');
    try {
      const wavDecoder = require('wav-decoder');
      const decoded = await wavDecoder.decode(file.buffer);
      pcmData = decoded.channelData[0];
      sampleRate = decoded.sampleRate;
    } catch (_) { /* MP3 or undecodable — fall back to filename */ }

    if (!pcmData) {
      const key = fromName.key;
      const bpm = fromName.bpm;
      return res.json({
        success: true, bpm, key, mood: _moodFrom(bpm, key),
        source: 'filename',
        note: isWav ? null : 'Upload WAV for spectral analysis',
      });
    }

    // Limit analysis to first 30 seconds for speed
    const maxSamples = sampleRate * 30;
    const samples = pcmData.length > maxSamples ? pcmData.slice(0, maxSamples) : pcmData;

    // ── BPM Detection ──
    let bpm = null;
    try {
      const mt = new MusicTempo(Array.from(samples));
      bpm = Math.round(mt.tempo);
    } catch (e) {
      console.warn('BPM detection failed:', e.message);
    }

    // ── Key Detection via Chromagram + Krumhansl-Kessler profiles ──
    let key = null;
    try {
      const N = 4096;
      const hop = 2048;
      const chroma = new Float64Array(12);
      const numFrames = Math.floor((samples.length - N) / hop);
      const limit = Math.min(numFrames, 300);

      for (let frame = 0; frame < limit; frame++) {
        const start = frame * hop;
        const windowed = [];
        for (let i = 0; i < N; i++) {
          const w = 0.5 * (1 - Math.cos(2 * Math.PI * i / (N - 1)));
          windowed.push([(samples[start + i] || 0) * w, 0]);
        }
        const spectrum = fft(windowed);
        const mags = fftMag(spectrum);

        const minBin = Math.floor(50 * N / sampleRate);
        const maxBin = Math.floor(2000 * N / sampleRate);
        for (let k = minBin; k <= maxBin; k++) {
          const freq = k * sampleRate / N;
          const midiNote = 12 * Math.log2(freq / 440) + 69;
          const pitchClass = ((Math.round(midiNote) % 12) + 12) % 12;
          chroma[pitchClass] += mags[k] * mags[k];
        }
      }

      const maxC = Math.max(...chroma);
      if (maxC > 0) for (let i = 0; i < 12; i++) chroma[i] /= maxC;

      const majorProfile = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
      const minorProfile = [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];
      const noteNames = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'];

      let bestCorr = -Infinity;
      let bestKey = 'C Major';
      for (let shift = 0; shift < 12; shift++) {
        let corrMaj = 0, corrMin = 0;
        for (let i = 0; i < 12; i++) {
          const idx = (i + shift) % 12;
          corrMaj += chroma[idx] * majorProfile[i];
          corrMin += chroma[idx] * minorProfile[i];
        }
        if (corrMaj > bestCorr) { bestCorr = corrMaj; bestKey = noteNames[shift] + ' Major'; }
        if (corrMin > bestCorr) { bestCorr = corrMin; bestKey = noteNames[shift] + ' Minor'; }
      }
      key = bestKey;
    } catch (e) {
      console.warn('Key detection failed:', e.message);
    }

    // Merge spectral results with filename hints (filename fills gaps only)
    const finalBpm = bpm || fromName.bpm;
    const finalKey = key || fromName.key;
    res.json({
      success: true,
      bpm: finalBpm,
      key: finalKey,
      mood: _moodFrom(finalBpm, finalKey),
      source: bpm || key ? 'spectral' : 'filename',
    });
  } catch (err) {
    console.error('analyze-audio error:', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /upload/proxy-image — fetch an image URL and return it (for CORS-blocked images)
app.post('/upload/proxy-image', requireAdminKey, async (req, res) => {
  try {
    const { url } = req.body;
    if (!url) return res.status(400).json({ error: 'url required' });
        const imgRes = await fetch(url, { signal: AbortSignal.timeout(15000) });
    if (!imgRes.ok) throw new Error(`Image fetch failed (${imgRes.status})`);
    const buffer = Buffer.from(await imgRes.arrayBuffer());
    const contentType = imgRes.headers.get('content-type') || 'image/jpeg';
    res.set('Content-Type', contentType);
    res.send(buffer);
  } catch (err) {
    console.error('proxy-image error:', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /upload/cover-from-url — fetch image from URL and upload to Supabase Storage
app.post('/upload/cover-from-url', requireAdminKey, async (req, res) => {
  try {
    const { imageUrl, filename } = req.body;
    if (!imageUrl) return res.status(400).json({ error: 'imageUrl required' });
        const imgRes = await fetch(imageUrl, { signal: AbortSignal.timeout(15000) });
    if (!imgRes.ok) throw new Error(`Image fetch failed (${imgRes.status})`);
    const buffer = Buffer.from(await imgRes.arrayBuffer());
    const contentType = imgRes.headers.get('content-type') || 'image/jpeg';
    const safeName = `covers/${filename || `cover_${Date.now()}.jpg`}`;
    const supabase = getSupabaseClient();
    const { error } = await supabase.storage.from('cover-art').upload(safeName, buffer, {
      contentType, upsert: false,
    });
    if (error) throw new Error(`Cover upload error: ${error.message}`);
    const publicUrl = supabase.storage.from('cover-art').getPublicUrl(safeName).data.publicUrl;
    res.json({ success: true, url: publicUrl });
  } catch (err) {
    console.error('cover-from-url error:', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /upload/beat-metadata — register beat in DB (no file upload, just metadata + URLs)
app.post('/upload/beat-metadata', requireAdminKey, async (req, res) => {
  try {
    const { title, genre, subgenre, bpm, key, mood, tags, lease_price, premium_price, stems_price, exclusive_price, audio_url, wav_url, stem_url, cover_url, announce, announce_title, announce_body } = req.body;
    if (!title) return res.status(400).json({ error: 'Title is required' });

    const beatId = await addBeatToDB({
      title, genre: genre || '', subgenre: subgenre || '',
      bpm: bpm || '120', key: key || '', mood: mood || '',
      tags: tags ? (Array.isArray(tags) ? tags : tags.split(',')) : [],
      lease_price: lease_price || 29.99,
      premium_price: premium_price || 99.99,
      stems_price: stems_price || 199.99,
      exclusive_price: exclusive_price || null,
      audio_url: audio_url || '', wav_url: wav_url || '', stem_url: stem_url || '',
      cover_url: cover_url || '',
    });

    // Push broadcast on new beat — opt-in. Uploader sends announce:false to skip
    // (e.g. reuploads / test uploads). Custom title/body optional.
    if (announce !== false) {
      try {
        const tokens = await getPushTokens();
        if (tokens.length > 0) {
          const pTitle = (typeof announce_title === 'string' && announce_title.trim()) || '🎵 New Beat Released!';
          const pBody = (typeof announce_body === 'string' && announce_body.trim()) ||
            `Check out "${title}" — ${genre || 'New'} · ${bpm || '?'} BPM`;
          sendPushNotification(
            tokens,
            pTitle,
            pBody,
            { beatId, beatTitle: title, genre, bpm }
          ).catch(err => console.error('Push notification send error:', err));
        }
      } catch (notifErr) {
        console.error('Error sending push notifications:', notifErr);
      }
    }

    res.json({ success: true, beatId, message: `Beat "${title}" is live!` });
  } catch (err) {
    console.error('beat-metadata error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ──────────────────────────────────────────────────────────────────────────────
// AI COVER ART GENERATION
// ──────────────────────────────────────────────────────────────────────────────

// POST /upload/generate-cover — generate AI cover art via Pollinations.ai
app.post('/upload/generate-cover', requireAdminKey, async (req, res) => {
  try {
    const { mood, title, genre, tags, key: beatKey, seed: clientSeed, prompt: clientPrompt } = req.body;
    if (!mood) return res.status(400).json({ error: 'mood required' });

    let fullPrompt;
    if (clientPrompt && typeof clientPrompt === 'string' && clientPrompt.length < 1000) {
      fullPrompt = clientPrompt;
    } else {
      const theme = COVER_THEMES[mood] || COVER_THEMES['Dark'];
      const prompt = theme.prompts[Math.floor(Math.random() * theme.prompts.length)];
      const tagContext = tags ? `, ${tags} aesthetic` : '';
      const toneContext = beatKey && beatKey.includes('Minor') ? ', moody dark tones' : beatKey ? ', bright warm tones' : '';
      fullPrompt = `${prompt}, ${genre || 'hip hop'} music album cover${tagContext}${toneContext}, square format, cinematic, high quality, no text no words no letters`;
    }

    const seed = clientSeed || Date.now();
    const pollinationsUrl = `https://image.pollinations.ai/prompt/${encodeURIComponent(fullPrompt)}?width=1024&height=1024&seed=${seed}&nologo=true`;

    try {
      const imgRes = await fetch(pollinationsUrl, { signal: AbortSignal.timeout(60000) });
      if (!imgRes.ok) throw new Error(`Pollinations returned ${imgRes.status}`);
      const imgBuffer = Buffer.from(await imgRes.arrayBuffer());
      const coverUrl = await uploadCoverToStorage(
        imgBuffer,
        `ai_cover_${seed}.png`,
        'image/png'
      );
      res.json({
        success: true,
        image_url: coverUrl,
        source: 'pollinations',
        mood,
        prompt: fullPrompt,
        seed,
      });
    } catch (pollErr) {
      console.warn('Pollinations fetch/upload failed, returning direct URL:', pollErr.message);
      res.json({
        success: true,
        image_url: pollinationsUrl,
        source: 'pollinations-direct',
        mood,
        prompt: fullPrompt,
        seed,
      });
    }
  } catch (err) {
    console.error('Cover generation error:', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /upload/generate-covers — return N (default 10) Pollinations preview URLs
// Body: { mood, title?, genre?, tags?, key?, count? }
// Previews are NOT persisted — user picks one and re-calls /upload/generate-cover
// with the chosen seed + prompt to store the final image in Supabase.
app.post('/upload/generate-covers', requireAdminKey, async (req, res) => {
  try {
    const { mood, title, genre, tags, key: beatKey, count } = req.body || {};
    if (!mood) return res.status(400).json({ error: 'mood required' });

    const theme = COVER_THEMES[mood] || COVER_THEMES['Dark'];
    const prompts = theme.prompts;
    const tagContext = tags ? `, ${tags} aesthetic` : '';
    const toneContext = beatKey && beatKey.includes('Minor') ? ', moody dark tones' : beatKey ? ', bright warm tones' : '';
    const total = Math.min(Math.max(parseInt(count) || 10, 1), 10);

    const previews = [];
    for (let i = 0; i < total; i++) {
      const prompt = prompts[i % prompts.length];
      const fullPrompt = `${prompt}, ${genre || 'hip hop'} music album cover${tagContext}${toneContext}, square format, cinematic, high quality, no text no words no letters`;
      const seed = Date.now() + i * 1013 + Math.floor(Math.random() * 997);
      const url = `https://image.pollinations.ai/prompt/${encodeURIComponent(fullPrompt)}?width=1024&height=1024&seed=${seed}&nologo=true`;
      previews.push({ id: `preview_${seed}`, url, seed, prompt: fullPrompt });
    }

    res.json({ success: true, previews, mood, count: total });
  } catch (err) {
    console.error('Covers generation error:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /upload/cover-library — list saved AI covers from Supabase storage
app.get('/upload/cover-library', requireAdminKey, async (req, res) => {
  try {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase.storage.from('cover-art').list('', {
      limit: 100,
      sortBy: { column: 'created_at', order: 'desc' },
    });
    if (error) throw error;
    const covers = (data || [])
      .filter(f => f.name.startsWith('ai_cover_'))
      .map(f => {
        const { data: urlData } = supabase.storage.from('cover-art').getPublicUrl(f.name);
        return { name: f.name, url: urlData.publicUrl, created: f.created_at };
      });
    res.json({ success: true, covers });
  } catch (err) {
    console.error('Cover library error:', err);
    res.status(500).json({ error: err.message });
  }
});

// (duplicate /upload/analyze-audio endpoint removed — see definition above)

// ──────────────────────────────────────────────────────────────────────────────
// STRIPE CHECKOUT
// ──────────────────────────────────────────────────────────────────────────────

// POST /checkout — create a Stripe checkout session for the cart items.
// Body: { customerEmail, cartItems: [{ beatId, beatTitle, licenseType, price }] }
// Returns: { url } — Stripe hosted checkout URL to redirect the customer to.
app.post('/checkout', async (req, res) => {
  try {
    const { customerEmail, cartItems } = req.body;

    if (!customerEmail || !Array.isArray(cartItems) || cartItems.length === 0) {
      return res.status(400).json({ error: 'customerEmail and cartItems required' });
    }

    // Validate prices server-side by re-fetching from the DB (never trust client prices).
    const allBeats = await fetchBeatsFromDB();
    const beatById = new Map(allBeats.map(b => [b.id, b]));

    const validatedItems = [];
    for (const item of cartItems) {
      const beat = beatById.get(item.beatId);
      if (!beat) {
        return res.status(400).json({ error: `Beat ${item.beatId} not found or inactive` });
      }
      const priceKey =
        item.licenseType === 'exclusive' ? 'exclusive_price' :
        item.licenseType === 'premium' ? 'premium_price' :
        item.licenseType === 'stems'   ? 'stems_price'   :
                                         'lease_price';
      const serverPrice = parseFloat(beat[priceKey]);
      if (!serverPrice || isNaN(serverPrice) || serverPrice <= 0) {
        return res.status(400).json({ error: `Invalid price for ${beat.title} (${item.licenseType})` });
      }
      validatedItems.push({
        beatId: beat.id,
        beatTitle: beat.title,
        licenseType: item.licenseType,
        price: serverPrice,
        coverUrl: beat.cover_url || beat.cover_art_url || '',
      });
    }

    const totalAmount = validatedItems.reduce((sum, it) => sum + it.price, 0);
    const orderId = uuidv4();

    // Create pending order in Supabase
    await createOrder({
      orderId,
      customerEmail,
      cartItems: validatedItems,
      totalAmount,
    });

    // Build Stripe line items
    const line_items = validatedItems.map(item => {
      const tierLabel =
        item.licenseType === 'exclusive' ? 'Exclusive Rights (Full Buyout)' :
        item.licenseType === 'premium' ? 'Premium License (MP3 + WAV)' :
        item.licenseType === 'stems'   ? 'Stems License (MP3 + WAV + Track Stems)' :
                                         'Lease License (MP3)';
      return {
        price_data: {
          currency: 'usd',
          product_data: {
            name: `${item.beatTitle} — ${tierLabel}`,
            description: `Prod. O'Neil — ${tierLabel}`,
            images: item.coverUrl ? [item.coverUrl] : undefined,
          },
          unit_amount: Math.round(item.price * 100), // cents
        },
        quantity: 1,
      };
    });

    const appUrl = process.env.APP_URL || 'https://oneil-beats-backend.vercel.app';

    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      payment_method_types: ['card'],
      line_items,
      customer_email: customerEmail,
      client_reference_id: orderId,
      metadata: { orderId },
      success_url: `${appUrl}/success?orderId=${orderId}&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${appUrl}/cancel?orderId=${orderId}`,
      payment_intent_data: {
        metadata: { orderId },
        description: `O'Neil Beats Order #${orderId.slice(0, 8)}`,
      },
      allow_promotion_codes: true,
    });

    return res.json({ url: session.url, sessionId: session.id, orderId });
  } catch (err) {
    console.error('Checkout error:', err);
    return res.status(500).json({ error: err.message || 'Checkout failed' });
  }
});

// GET /success — simple success landing page after Stripe redirects back
app.get('/success', (req, res) => {
  const orderId = req.query.orderId || '';
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(`<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Payment Successful — O'Neil Beats</title></head>
<body style="background:#06060a;color:#fff;font-family:-apple-system,Segoe UI,Roboto,sans-serif;padding:40px 20px;text-align:center;">
<div style="max-width:520px;margin:40px auto;background:#0f0f14;border:1px solid #222;border-radius:20px;padding:36px 24px;">
<div style="font-size:56px;margin-bottom:8px;">🎵</div>
<h1 style="color:#e63946;margin:0 0 8px;">Payment Successful!</h1>
<p style="color:#888;margin:8px 0 20px;font-size:14px;">Order #${orderId.slice(0,8)}</p>
<p style="line-height:1.5;">Thanks for your purchase! Your download links and PDF license have been emailed to you.</p>
<p style="color:#888;font-size:13px;margin-top:20px;">You can close this tab and return to the app.</p>
</div></body></html>`);
});

// GET /cancel — simple cancel landing page
app.get('/cancel', (req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(`<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Payment Canceled</title></head>
<body style="background:#06060a;color:#fff;font-family:-apple-system,Segoe UI,Roboto,sans-serif;padding:40px 20px;text-align:center;">
<div style="max-width:520px;margin:40px auto;background:#0f0f14;border:1px solid #222;border-radius:20px;padding:36px 24px;">
<h1 style="color:#f59e0b;margin:0 0 8px;">Payment Canceled</h1>
<p style="line-height:1.5;">Your cart is still saved. You can return to the app and try again.</p>
</div></body></html>`);
});

// ──────────────────────────────────────────────────────────────────────────────
// PURCHASES & ORDERS
// ──────────────────────────────────────────────────────────────────────────────

// GET /purchases?email=... — get all paid orders for a customer
app.get('/purchases', async (req, res) => {
  try {
    const email = req.query.email;
    if (!email) return res.status(400).json({ error: 'email query param required' });

    const orders = await getOrdersByEmail(email);
    const baseUrl = process.env.APP_URL || 'https://oneil-beats-backend.vercel.app';

    const enriched = orders.map(order => ({
      orderId: order.id,
      status: order.status,
      customerEmail: order.customer_email,
      customerName: order.customer_name,
      totalAmount: order.total_amount,
      paidAt: order.paid_at,
      items: (order.order_items || []).map(item => {
        const downloads = {};
        downloads.mp3 = item.mp3_url ? `${baseUrl}/download/${order.id}/${item.beat_id}?format=mp3` : null;
        if (item.license_type === 'premium' || item.license_type === 'stems') {
          downloads.wav = item.wav_url ? `${baseUrl}/download/${order.id}/${item.beat_id}?format=wav` : null;
        }
        if (item.license_type === 'stems') {
          downloads.stems = item.stems_url ? `${baseUrl}/download/${order.id}/${item.beat_id}?format=stems` : null;
        }
        return {
          beatId: item.beat_id,
          beatTitle: item.beat_title,
          licenseType: item.license_type,
          price: item.price,
          coverUrl: item.cover_url,
          downloads,
          licenseUrl: `${baseUrl}/license/${order.id}/${item.beat_id}`,
        };
      }),
    }));

    res.json({ success: true, purchases: enriched });
  } catch (err) {
    console.error('Fetch purchases error:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /orders/lookup — public order history lookup by email (used by storefront)
app.get('/orders/lookup', async (req, res) => {
  try {
    const email = req.query.email;
    if (!email) return res.status(400).json({ error: 'email query param required' });

    const orders = await getOrdersByEmail(email);
    const baseUrl = process.env.APP_URL || 'https://oneil-beats-backend.vercel.app';

    const result = orders.map(order => ({
      orderId: order.id,
      status: order.status,
      paidAt: order.paid_at,
      totalAmount: order.total_amount,
      items: (order.order_items || []).map(item => ({
        beatTitle: item.beat_title,
        licenseType: item.license_type,
        price: item.price,
        coverUrl: item.cover_url,
        downloadUrl: item.mp3_url ? `${baseUrl}/download/${order.id}/${item.beat_id}?format=mp3` : null,
        licenseUrl: `${baseUrl}/license/${order.id}/${item.beat_id}`,
      })),
    }));

    res.json({ success: true, orders: result });
  } catch (err) {
    console.error('Order lookup error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ──────────────────────────────────────────────────────────────────────────────
// FILE DOWNLOADS & LICENSE
// ──────────────────────────────────────────────────────────────────────────────

// GET /download/:orderId/:beatId — download beat files (mp3, wav, stems)
app.get('/download/:orderId/:beatId', async (req, res) => {
  try {
    const { orderId, beatId } = req.params;
    const format = req.query.format || 'mp3';

    const order = await getOrderById(orderId);
    if (!order) return res.status(404).json({ error: 'Order not found' });

    const item = order.order_items?.find(i => i.beat_id === beatId);
    if (!item) return res.status(404).json({ error: 'Beat not found in order' });

    let downloadUrl = null;
    if (format === 'mp3') downloadUrl = item.mp3_url;
    else if (format === 'wav' && (item.license_type === 'premium' || item.license_type === 'stems')) downloadUrl = item.wav_url;
    else if (format === 'stems' && item.license_type === 'stems') downloadUrl = item.stems_url;

    if (!downloadUrl) {
      return res.status(400).json({ error: `${format.toUpperCase()} not available for this license type` });
    }

    res.redirect(downloadUrl);
  } catch (err) {
    console.error('Download error:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /license/:orderId/:beatId — generate and return license PDF
app.get('/license/:orderId/:beatId', async (req, res) => {
  try {
    const { orderId, beatId } = req.params;

    const order = await getOrderById(orderId);
    if (!order) return res.status(404).json({ error: 'Order not found' });

    const item = order.order_items?.find(i => i.beat_id === beatId);
    if (!item) return res.status(404).json({ error: 'Beat not found in order' });

    const pdfBuffer = await generateLicensePDF({
      beatTitle: item.beat_title,
      licenseType: item.license_type,
      customerName: order.customer_name || 'Customer',
      customerEmail: order.customer_email,
      orderDate: new Date(order.paid_at).toLocaleDateString(),
      licenseTerms: LICENSE_TERMS[item.license_type] || LICENSE_TERMS.lease,
    });

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${item.beat_title.replace(/[^a-z0-9]/gi, '_').toLowerCase()}_license.pdf"`);
    res.send(pdfBuffer);
  } catch (err) {
    console.error('License PDF error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ──────────────────────────────────────────────────────────────────────────────
// PUSH NOTIFICATIONS
// ──────────────────────────────────────────────────────────────────────────────

// POST /notification/register-token
app.post('/notification/register-token', async (req, res) => {
  try {
    const { userId, pushToken, platform } = req.body;
    if (!userId || !pushToken) {
      return res.status(400).json({ error: 'userId and pushToken required' });
    }

    const result = await registerPushToken(userId, pushToken, platform || 'mobile');
    res.json(result);
  } catch (err) {
    console.error('Register push token error:', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /notification/unregister-token
app.post('/notification/unregister-token', async (req, res) => {
  try {
    const { pushToken } = req.body;
    if (!pushToken) return res.status(400).json({ error: 'pushToken required' });

    const result = await removePushToken(pushToken);
    res.json(result);
  } catch (err) {
    console.error('Unregister push token error:', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /notification/send
app.post('/notification/send', requireAdminKey, async (req, res) => {
  try {
    const { title, body, data } = req.body;
    if (!title || !body) {
      return res.status(400).json({ error: 'title and body required' });
    }

    const tokens = await getPushTokens();
    if (tokens.length === 0) {
      return res.json({ success: true, message: 'No active tokens to notify', sentCount: 0 });
    }

    const result = await sendPushNotification(tokens, title, body, data);
    res.json({ success: true, message: 'Notifications sent', sentCount: tokens.length, result });
  } catch (err) {
    console.error('Send notifications error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─�
// ──────────────────────────────────────────────────────────────────────────────
// STRIPE WEBHOOK
// ──────────────────────────────────────────────────────────────────────────────

app.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;

  try {
    event = stripe.webhooks.constructEvent(
      req.body,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.error('Webhook signature verification failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const orderId = session.metadata?.orderId || session.client_reference_id;

    if (orderId) {
      try {
        // Fetch all beats so fulfillOrder can populate download URLs on order_items.
        const beats = await fetchBeatsFromDB();

        // Mark the order paid and stamp mp3/wav/stems urls onto each order item.
        await fulfillOrder({
          orderId,
          stripeSessionId: session.id,
          customerEmail: session.customer_details?.email || session.customer_email,
          customerName: session.customer_details?.name || '',
          beats,
        });

        const order = await getOrderById(orderId);
        const items = order?.order_items || [];

        if (order && order.customer_email && items.length > 0) {
          await sendFulfillmentEmail(order, orderId, items);
        }
      } catch (fulfillErr) {
        console.error('Order fulfillment error:', fulfillErr);
      }
    }
  }

  res.json({ received: true });
});

// ──────────────────────────────────────────────────────────────────────────────
// START SERVER
// ──────────────────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;
if (!process.env.VERCEL) {
  app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
}
module.exports = app;
