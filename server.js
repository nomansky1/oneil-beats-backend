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
  uploadAudioToStorage,
  uploadCoverToStorage,
  uploadBase64ToStorage,
  getSupabaseClient,
  SUPABASE_URL,
} = require('./supabaseApi');
const { generateLicensePDF, LICENSE_TERMS } = require('./licenseGenerator');

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

const app = express();
const PORT = process.env.PORT || 3001;

// ── Middleware ─────────────────────────────────────────────────────────────────
app.use(cors({ origin: '*' }));

// Stripe webhooks need raw body — must be before express.json()
app.use('/webhook', express.raw({ type: 'application/json' }));
app.use(express.json({ limit: '50mb' }));

// File upload handler (for producer upload tool)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 200 * 1024 * 1024 }, // 200MB max
});

// ── Email Setup ────────────────────────────────────────────────────────────────
const mailer = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.EMAIL_FROM,
    pass: process.env.EMAIL_PASS,
  },
});

// ── In-memory order store (replace with DB for production) ────────────────────
const orders = new Map();

// ═══════════════════════════════════════════════════════════════════════════════
// BEATS CATALOG ENDPOINTS
// ═══════════════════════════════════════════════════════════════════════════════

// GET /beats — fetch all active beats
app.get('/beats', async (req, res) => {
  try {
    const beats = await fetchBeatsFromDB();
    res.json({ success: true, beats });
  } catch (err) {
    console.error('Fetch beats error:', err);
    res.status(500).json({ error: 'Failed to fetch beats', detail: err.message });
  }
});

// POST /beats/:id/play — increment play count
app.post('/beats/:id/play', async (req, res) => {
  try {
    await incrementPlayCount(req.params.id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// CHECKOUT ENDPOINTS
// ═══════════════════════════════════════════════════════════════════════════════

app.post('/checkout', async (req, res) => {
  try {
    const { cartItems, customerEmail } = req.body;
    if (!cartItems || cartItems.length === 0) {
      return res.status(400).json({ error: 'Cart is empty' });
    }

    const lineItems = cartItems.map(item => ({
      price_data: {
        currency: 'usd',
        product_data: {
          name: `${item.beatTitle}`,
          description: `${LICENSE_TERMS[item.licenseType]?.name || 'License'} — O'Neil Beats`,
          metadata: { beatId: item.beatId, licenseType: item.licenseType },
        },
        unit_amount: Math.round(item.price * 100),
      },
      quantity: 1,
    }));

    const orderId = uuidv4();
    orders.set(orderId, {
      orderId,
      status: 'pending',
      customerEmail,
      cartItems,
      createdAt: new Date().toISOString(),
    });

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: lineItems,
      mode: 'payment',
      customer_email: customerEmail,
      success_url: `${process.env.APP_URL || 'https://oneil-beats-backend.vercel.app'}/success?order=${orderId}&session={CHECKOUT_SESSION_ID}`,
      cancel_url: `${process.env.APP_URL || 'https://oneil-beats-backend.vercel.app'}/cancel`,
      metadata: { orderId },
    });

    res.json({ url: session.url, sessionId: session.id, orderId });
  } catch (err) {
    console.error('Checkout error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/order/:orderId', async (req, res) => {
  const order = orders.get(req.params.orderId);
  if (!order) return res.status(404).json({ error: 'Order not found' });
  res.json(order);
});

// GET /download/:orderId/:beatId — download beat file
app.get('/download/:orderId/:beatId', async (req, res) => {
  const order = orders.get(req.params.orderId);
  if (!order || order.status !== 'paid') {
    return res.status(403).json({ error: 'Access denied — order not paid' });
  }

  const item = order.cartItems.find(i => i.beatId === req.params.beatId);
  if (!item) return res.status(404).json({ error: 'Beat not found in order' });

  // Serve correct file based on license type
  let downloadUrl;
  if (item.licenseType === 'stems' && item.beatMeta?.stem_url) {
    downloadUrl = item.beatMeta.stem_url;
  } else if ((item.licenseType === 'premium' || item.licenseType === 'stems') && item.beatMeta?.wav_url) {
    downloadUrl = item.beatMeta.wav_url;
  } else {
    downloadUrl = item.beatMeta?.audio_url || item.audioUrl;
  }

  if (!downloadUrl) return res.status(404).json({ error: 'No file available' });
  res.redirect(downloadUrl);
});

// GET /license/:orderId/:beatId — download license PDF
app.get('/license/:orderId/:beatId', async (req, res) => {
  const order = orders.get(req.params.orderId);
  if (!order || order.status !== 'paid') {
    return res.status(403).json({ error: 'Access denied — order not paid' });
  }

  const item = order.cartItems.find(i => i.beatId === req.params.beatId);
  if (!item) return res.status(404).json({ error: 'Beat not found in order' });

  try {
    const pdf = await generateLicensePDF({
      orderId: order.orderId,
      licenseType: item.licenseType,
      beat: { title: item.beatTitle, ...item.beatMeta },
      buyer: { email: order.customerEmail, name: order.customerName || '' },
    });

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="OBLicense_${item.beatTitle.replace(/\s+/g, '_')}.pdf"`);
    res.send(pdf);
  } catch (err) {
    res.status(500).json({ error: 'Failed to generate license', detail: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// STRIPE WEBHOOK — fulfills orders after payment
// ═══════════════════════════════════════════════════════════════════════════════
app.post('/webhook', async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;

  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('Webhook signature error:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const orderId = session.metadata?.orderId;

    if (orderId && orders.has(orderId)) {
      const order = orders.get(orderId);
      order.status = 'paid';
      order.stripeSessionId = session.id;
      order.customerEmail = session.customer_email || order.customerEmail;
      order.customerName = session.customer_details?.name || '';
      orders.set(orderId, order);

      // Enrich order items with full beat metadata
      try {
        const beats = await fetchBeatsFromDB();
        const enrichedItems = order.cartItems.map(item => {
          const beat = beats.find(b => b.id === item.beatId) || {};
          return { ...item, beatMeta: beat, audioUrl: beat.audio_url };
        });
        order.cartItems = enrichedItems;
        orders.set(orderId, order);

        // Send download email
        if (order.customerEmail) {
          const downloadLinks = enrichedItems.map(item =>
            `• ${item.beatTitle} (${item.licenseType})\n  Download: ${process.env.APP_URL || 'https://oneil-beats-backend.vercel.app'}/download/${orderId}/${item.beatId}\n  License: ${process.env.APP_URL || 'https://oneil-beats-backend.vercel.app'}/license/${orderId}/${item.beatId}`
          ).join('\n\n');

          try {
            await mailer.sendMail({
              from: `"O'Neil Beats" <${process.env.EMAIL_FROM}>`,
              to: order.customerEmail,
              subject: `Your O'Neil Beats Order — ${enrichedItems.length} beat(s) ready!`,
              text: `Hey ${order.customerName || 'there'}!\n\nThanks for your purchase! Here are your download links:\n\n${downloadLinks}\n\nEnjoy the beats!\n— O'Neil Beats`,
            });
          } catch (emailErr) {
            console.error('Email send error:', emailErr.message);
          }
        }
      } catch (enrichErr) {
        console.error('Order enrichment error:', enrichErr);
      }
    }
  }

  res.json({ received: true });
});

// ═══════════════════════════════════════════════════════════════════════════════
// ADMIN AUTH
// ═══════════════════════════════════════════════════════════════════════════════
function requireAdminKey(req, res, next) {
  const key = req.headers['x-admin-key'] || req.query.adminKey;
  if (key !== process.env.ADMIN_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

// ═══════════════════════════════════════════════════════════════════════════════
// PRODUCER UPLOAD ENDPOINTS (v3 — Supabase Storage)
// ═══════════════════════════════════════════════════════════════════════════════

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

      res.json({ success: true, beatId, audioUrl, coverUrl, message: `Beat "${title}" uploaded!` });
    } catch (err) {
      console.error('Upload error:', err);
      res.status(500).json({ error: err.message });
    }
  }
);

// GET /upload/status — check server health
app.get('/upload/status', requireAdminKey, async (req, res) => {
  try {
    const beats = await fetchBeatsFromDB();
    res.json({ success: true, beatCount: beats.length, message: 'Server healthy', storage: 'supabase' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /upload/base64 — upload a file as base64 to Supabase Storage
app.post('/upload/base64', requireAdminKey, async (req, res) => {
  try {
    const { base64, filename, mimeType, bucket } = req.body;
    if (!base64 || !filename) return res.status(400).json({ error: 'base64 and filename required' });

    // Determine bucket: 'beats' for audio, 'cover-art' for images
    const targetBucket = bucket || (mimeType?.startsWith('image/') ? 'cover-art' : 'beats');
    const publicUrl = await uploadBase64ToStorage(base64, filename, targetBucket, mimeType || 'application/octet-stream');

    res.json({ success: true, url: publicUrl, bucket: targetBucket });
  } catch (err) {
    console.error('Base64 upload error:', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /upload/beat-metadata — register beat with pre-uploaded file URLs
app.post('/upload/beat-metadata', requireAdminKey, async (req, res) => {
  try {
    const {
      title, genre, bpm, key, mood, tags,
      lease_price, premium_price, stems_price,
      audio_url, cover_url,
      wav_url, stem_url,
    } = req.body;

    if (!audio_url) {
      return res.status(400).json({ error: 'audio_url required' });
    }

    const beatId = await addBeatToDB({
      title, genre, bpm, key, mood,
      tags: tags ? (Array.isArray(tags) ? tags : tags.split(',')) : [],
      lease_price, premium_price, stems_price,
      audio_url,
      cover_url: cover_url || '',
      wav_url: wav_url || '',
      stem_url: stem_url || '',
    });

    res.json({
      success: true,
      beatId,
      message: `Beat "${title}" uploaded successfully!`,
    });
  } catch (err) {
    console.error('Beat metadata error:', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /upload/get-signed-url — get a signed upload URL for direct upload to Supabase Storage
// The app uploads directly to Supabase (no body size limit through our server)
app.post('/upload/get-signed-url', requireAdminKey, async (req, res) => {
  try {
    const { filename, bucket } = req.body;
    if (!filename) return res.status(400).json({ error: 'filename required' });

    const targetBucket = bucket || 'beats';
    const safeName = `${Date.now()}_${filename.replace(/[^a-zA-Z0-9._-]/g, '_')}`;

    const supabase = getSupabaseClient();
    const { data, error } = await supabase.storage
      .from(targetBucket)
      .createSignedUploadUrl(safeName);

    if (error) throw new Error(`Signed URL error: ${error.message}`);

    // Also return the eventual public URL
    const { data: urlData } = supabase.storage
      .from(targetBucket)
      .getPublicUrl(safeName);

    res.json({
      success: true,
      signedUrl: data.signedUrl,
      token: data.token,
      path: safeName,
      publicUrl: urlData.publicUrl,
      bucket: targetBucket,
    });
  } catch (err) {
    console.error('Signed URL error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// AI COVER ART GENERATION
// ═══════════════════════════════════════════════════════════════════════════════

// POST /upload/generate-cover — generate AI cover art
// Supports FastSD CPU (self-hosted) with Pollinations.ai as fallback
app.post('/upload/generate-cover', requireAdminKey, async (req, res) => {
  try {
    const { mood, title, genre, tags, key: beatKey } = req.body;
    if (!mood) return res.status(400).json({ error: 'mood required' });

    const theme = COVER_THEMES[mood] || COVER_THEMES['Dark'];
    const prompt = theme.prompts[Math.floor(Math.random() * theme.prompts.length)];

    // Build a richer prompt using tags and key for context
    const tagContext = tags ? `, ${tags} aesthetic` : '';
    const toneContext = beatKey && beatKey.includes('Minor') ? ', moody dark tones' : beatKey ? ', bright warm tones' : '';
    const fullPrompt = `${prompt}, ${genre || 'hip hop'} music album cover${tagContext}${toneContext}, square format, cinematic, high quality, no text no words no letters`;

    // Try FastSD CPU if configured
    const fastsdUrl = process.env.FASTSD_URL;
    if (fastsdUrl) {
      try {
        const sdRes = await fetch(`${fastsdUrl}/api/generate`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            prompt: fullPrompt,
            negative_prompt: 'text, words, letters, watermark, blurry, low quality',
            width: 512,
            height: 512,
            num_inference_steps: 4,
            guidance_scale: 1.0,
          }),
          signal: AbortSignal.timeout(30000), // 30s timeout
        });

        if (sdRes.ok) {
          const sdData = await sdRes.json();
          if (sdData.images && sdData.images.length > 0) {
            // Upload the generated image to Supabase Storage
            const imgBuffer = Buffer.from(sdData.images[0], 'base64');
            const coverUrl = await uploadCoverToStorage(
              imgBuffer,
              `ai_cover_${Date.now()}.png`,
              'image/png'
            );

            return res.json({
              success: true,
              image_url: coverUrl,
              source: 'fastsd',
              mood,
              prompt: fullPrompt,
            });
          }
        }
        console.warn('FastSD failed, falling back to Pollinations');
      } catch (sdErr) {
        console.warn('FastSD error, falling back to Pollinations:', sdErr.message);
      }
    }

    // Fallback: Pollinations.ai (free, no API key)
    // Fetch the image, upload to Supabase, return permanent URL
    const seed = Date.now();
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
      // Last resort: return the direct Pollinations URL (may be slow to load)
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

// ═══════════════════════════════════════════════════════════════════════════════
// ADMIN ENDPOINTS
// ═══════════════════════════════════════════════════════════════════════════════

// PUT /admin/beat/:id — update beat metadata
app.put('/admin/beat/:id', requireAdminKey, async (req, res) => {
  try {
    await updateBeatInDB(req.params.id, req.body);
    res.json({ success: true, message: 'Beat updated' });
  } catch (err) {
    console.error('Update beat error:', err);
    res.status(500).json({ error: err.message });
  }
});

// DELETE /admin/beat/:id — soft-delete
app.delete('/admin/beat/:id', requireAdminKey, async (req, res) => {
  try {
    await deleteBeatInDB(req.params.id);
    res.json({ success: true, message: 'Beat deactivated' });
  } catch (err) {
    console.error('Delete beat error:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /admin/licenses — get license terms
app.get('/admin/licenses', requireAdminKey, async (req, res) => {
  res.json({ success: true, licenses: LICENSE_TERMS });
});

// PUT /admin/licenses — update license terms
app.put('/admin/licenses', requireAdminKey, async (req, res) => {
  try {
    const { licenses } = req.body;
    if (!licenses) return res.status(400).json({ error: 'licenses object required' });
    Object.assign(LICENSE_TERMS, licenses);
    res.json({ success: true, message: 'License terms updated' });
  } catch (err) {
    console.error('License update error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Serve admin dashboard
const path = require('path');
app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'admin', 'dashboard.html'));
});

// Health check
app.get('/', (req, res) => {
  res.json({ name: "O'Neil Beats API", version: '3.0.0', status: 'ok', storage: 'supabase' });
});

// Start server locally
if (process.env.NODE_ENV !== 'production' || !process.env.VERCEL) {
  app.listen(PORT, () => {
    console.log("O'Neil Beats API running on port " + PORT);
  });
}

// Export for Vercel serverless
module.exports = app;
