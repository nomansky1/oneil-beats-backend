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
} = require('./supabaseApi');
const { generateLicensePDF, LICENSE_TERMS } = require('./licenseGenerator');
const {
  createResumableUpload,
  finalizeUpload,
  getDriveStreamUrl,
  getDriveDownloadUrl,
  getDriveImageUrl,
  uploadFileToDrive,
} = require('./googleApi');

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

// Orders now persisted in Supabase (orders + order_items tables)

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
    const totalAmount = cartItems.reduce((sum, i) => sum + (parseFloat(i.price) || 0), 0);

    // Persist order to Supabase
    await createOrder({ orderId, customerEmail, cartItems, totalAmount });

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: lineItems,
      mode: 'payment',
      customer_email: customerEmail,
      allow_promotion_codes: true,
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
  try {
    const order = await getOrderById(req.params.orderId);
    if (!order) return res.status(404).json({ error: 'Order not found' });
    res.json(order);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /download/:orderId/:beatId — download beat file
app.get('/download/:orderId/:beatId', async (req, res) => {
  try {
    const order = await getOrderById(req.params.orderId);
    if (!order || order.status !== 'paid') {
      return res.status(403).json({ error: 'Access denied — order not paid' });
    }

    const item = (order.order_items || []).find(i => i.beat_id === req.params.beatId);
    if (!item) return res.status(404).json({ error: 'Beat not found in order' });

    const fmt = req.query.format; // ?format=stems|wav|mp3
    let downloadUrl;

    if (fmt === 'stems' && item.stems_url) {
      downloadUrl = item.stems_url;
    } else if (fmt === 'wav' && item.wav_url) {
      downloadUrl = item.wav_url;
    } else if (fmt === 'mp3') {
      downloadUrl = item.mp3_url;
    } else if (item.license_type === 'stems' && item.stems_url) {
      downloadUrl = item.stems_url;
    } else if ((item.license_type === 'premium' || item.license_type === 'stems') && item.wav_url) {
      downloadUrl = item.wav_url;
    } else {
      downloadUrl = item.mp3_url;
    }

    if (!downloadUrl) return res.status(404).json({ error: 'No file available' });
    res.redirect(downloadUrl);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /license/:orderId/:beatId — download license PDF
app.get('/license/:orderId/:beatId', async (req, res) => {
  try {
    const order = await getOrderById(req.params.orderId);
    if (!order || order.status !== 'paid') {
      return res.status(403).json({ error: 'Access denied — order not paid' });
    }

    const item = (order.order_items || []).find(i => i.beat_id === req.params.beatId);
    if (!item) return res.status(404).json({ error: 'Beat not found in order' });

    // Fetch beat metadata for the license
    const beats = await fetchBeatsFromDB();
    const beat = beats.find(b => b.id === item.beat_id) || {};

    const pdf = await generateLicensePDF({
      orderId: order.id,
      licenseType: item.license_type,
      beat: { title: item.beat_title, ...beat },
      buyer: { email: order.customer_email, name: order.customer_name || '' },
    });

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="OBLicense_${item.beat_title.replace(/\s+/g, '_')}.pdf"`);
    res.send(pdf);
  } catch (err) {
    res.status(500).json({ error: 'Failed to generate license', detail: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// POST-CHECKOUT PAGES — /success and /cancel (rendered as HTML)
// ═══════════════════════════════════════════════════════════════════════════════

app.get('/success', (req, res) => {
  const { order, session } = req.query;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>Order Confirmed — O'Neil Beats</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      background: linear-gradient(135deg, #06060a 0%, #1a0a14 50%, #06060a 100%);
      color: #fff; min-height: 100vh;
      display: flex; align-items: center; justify-content: center;
      padding: 20px;
    }
    .card {
      max-width: 480px; width: 100%;
      background: rgba(15, 15, 20, 0.9);
      border: 1px solid rgba(230, 57, 70, 0.3);
      border-radius: 20px; padding: 40px 28px;
      text-align: center;
      box-shadow: 0 20px 60px rgba(230, 57, 70, 0.15);
    }
    .icon {
      width: 80px; height: 80px; margin: 0 auto 20px;
      background: linear-gradient(135deg, #e63946, #f59e0b);
      border-radius: 50%;
      display: flex; align-items: center; justify-content: center;
      font-size: 40px;
    }
    h1 {
      font-size: 28px; margin-bottom: 12px;
      background: linear-gradient(90deg, #e63946, #f59e0b);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
    }
    p { color: #aaa; line-height: 1.6; margin-bottom: 20px; font-size: 15px; }
    .order-id {
      background: rgba(230, 57, 70, 0.1);
      border: 1px solid rgba(230, 57, 70, 0.3);
      padding: 12px; border-radius: 10px;
      font-family: monospace; font-size: 13px;
      color: #e63946; margin-bottom: 24px;
      word-break: break-all;
    }
    .steps {
      text-align: left; background: rgba(255,255,255,0.03);
      border-radius: 12px; padding: 16px; margin-bottom: 24px;
    }
    .steps-title {
      font-size: 12px; text-transform: uppercase; letter-spacing: 1px;
      color: #f59e0b; margin-bottom: 10px; font-weight: 700;
    }
    .step { color: #ddd; font-size: 13px; padding: 4px 0; }
    .step:before { content: "✓ "; color: #10b981; font-weight: bold; }
    .cta {
      display: inline-block; padding: 14px 28px;
      background: linear-gradient(135deg, #e63946, #f59e0b);
      color: #000; text-decoration: none;
      font-weight: 900; border-radius: 10px;
      transition: transform 0.2s;
    }
    .cta:hover { transform: translateY(-2px); }
    .close-hint {
      margin-top: 20px; font-size: 12px; color: #666;
    }
  </style>
</head>
<body>
  <div class="card">
    <div class="icon">🎵</div>
    <h1>Payment Successful!</h1>
    <p>Your O'Neil Beats order has been confirmed. Check your email for download links.</p>
    ${order ? `<div class="order-id">Order: ${order}</div>` : ''}
    <div class="steps">
      <div class="steps-title">What's Next</div>
      <div class="step">Email with your download links (may take 1-2 minutes)</div>
      <div class="step">License PDF attached for each beat</div>
      <div class="step">Access anytime in "My Purchases" in the app</div>
    </div>
    <a href="oneilbeats://purchases" class="cta">Open App</a>
    <div class="close-hint">You can safely close this tab.</div>
  </div>
  <script>
    // Try to auto-close if opened from the app
    setTimeout(() => {
      window.location.href = 'oneilbeats://purchases';
    }, 2000);
  </script>
</body>
</html>`);
});

app.get('/cancel', (req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>Payment Cancelled — O'Neil Beats</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      background: #06060a; color: #fff; min-height: 100vh;
      display: flex; align-items: center; justify-content: center;
      padding: 20px;
    }
    .card {
      max-width: 400px; background: #0f0f14;
      border: 1px solid #222; border-radius: 16px;
      padding: 36px 24px; text-align: center;
    }
    .icon { font-size: 48px; margin-bottom: 16px; }
    h1 { font-size: 22px; margin-bottom: 10px; }
    p { color: #888; margin-bottom: 20px; font-size: 14px; }
    .cta {
      display: inline-block; padding: 12px 24px;
      background: #e63946; color: #000;
      text-decoration: none; font-weight: 900;
      border-radius: 8px;
    }
  </style>
</head>
<body>
  <div class="card">
    <div class="icon">🛒</div>
    <h1>Payment Cancelled</h1>
    <p>No worries! Your cart is saved. Go back to the app to try again.</p>
    <a href="oneilbeats://" class="cta">Back to App</a>
  </div>
</body>
</html>`);
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

    if (orderId) {
      try {
        // Fetch beats for enrichment
        const beats = await fetchBeatsFromDB();
        const customerEmail = session.customer_email || '';
        const customerName = session.customer_details?.name || '';

        // Fulfill order in Supabase (updates status, enriches items with file URLs)
        await fulfillOrder({
          orderId,
          stripeSessionId: session.id,
          customerEmail,
          customerName,
          beats,
        });

        // Fetch the fulfilled order for email
        const order = await getOrderById(orderId);
        const items = order?.order_items || [];

        // Send download email (HTML + plain text)
        if (customerEmail && items.length > 0) {
          const baseUrl = process.env.APP_URL || 'https://oneil-beats-backend.vercel.app';

          // Build HTML beat cards with download buttons
          const beatCards = items.map(item => {
            const dlBase = `${baseUrl}/download/${orderId}/${item.beat_id}`;
            const licBase = `${baseUrl}/license/${orderId}/${item.beat_id}`;
            const tierColor = item.license_type === 'stems' ? '#10b981' : item.license_type === 'premium' ? '#8b5cf6' : '#e63946';
            const tierLabel = item.license_type === 'stems' ? 'Stems License' : item.license_type === 'premium' ? 'Premium License' : 'Basic Lease';

            let buttons = `<a href="${dlBase}?format=mp3" style="display:inline-block;padding:10px 18px;margin:4px 6px 4px 0;background:#e63946;color:#000;text-decoration:none;border-radius:6px;font-weight:700;font-size:13px;">MP3 Download</a>`;
            if (item.license_type === 'premium' || item.license_type === 'stems') {
              buttons += `<a href="${dlBase}?format=wav" style="display:inline-block;padding:10px 18px;margin:4px 6px 4px 0;background:#8b5cf6;color:#fff;text-decoration:none;border-radius:6px;font-weight:700;font-size:13px;">WAV Download</a>`;
            }
            if (item.license_type === 'stems') {
              buttons += `<a href="${dlBase}?format=stems" style="display:inline-block;padding:10px 18px;margin:4px 6px 4px 0;background:#10b981;color:#000;text-decoration:none;border-radius:6px;font-weight:700;font-size:13px;">Stems ZIP</a>`;
            }
            buttons += `<a href="${licBase}" style="display:inline-block;padding:10px 18px;margin:4px 6px 4px 0;background:#f59e0b;color:#000;text-decoration:none;border-radius:6px;font-weight:700;font-size:13px;">📄 License PDF</a>`;

            return `
              <div style="background:#0f0f14;border:1px solid #222;border-radius:12px;padding:20px;margin-bottom:14px;">
                <div style="display:flex;align-items:center;gap:12px;margin-bottom:10px;">
                  <div style="flex:1;">
                    <h3 style="color:#fff;margin:0;font-size:17px;">${item.beat_title}</h3>
                    <span style="display:inline-block;margin-top:6px;padding:3px 10px;background:${tierColor}22;color:${tierColor};border-radius:4px;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.5px;">${tierLabel}</span>
                  </div>
                </div>
                <div style="margin-top:12px;">${buttons}</div>
              </div>`;
          }).join('');

          // Plain text fallback
          const textLinks = items.map(item => {
            const dlBase = `${baseUrl}/download/${orderId}/${item.beat_id}`;
            const licBase = `${baseUrl}/license/${orderId}/${item.beat_id}`;
            let t = `• ${item.beat_title} (${item.license_type})\n  MP3: ${dlBase}?format=mp3`;
            if (item.license_type === 'premium' || item.license_type === 'stems') t += `\n  WAV: ${dlBase}?format=wav`;
            if (item.license_type === 'stems') t += `\n  Stems ZIP: ${dlBase}?format=stems`;
            t += `\n  License PDF: ${licBase}`;
            return t;
          }).join('\n\n');

          const htmlEmail = `<!DOCTYPE html><html><body style="margin:0;padding:0;background:#06060a;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
  <div style="max-width:600px;margin:0 auto;padding:32px 20px;">
    <div style="text-align:center;margin-bottom:32px;">
      <div style="font-size:40px;margin-bottom:8px;">🎵</div>
      <h1 style="color:#fff;margin:0 0 8px 0;font-size:28px;background:linear-gradient(90deg,#e63946,#f59e0b);-webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text;">Your Beats Are Ready!</h1>
      <p style="color:#888;margin:0;font-size:14px;">Order #${orderId.slice(0,8).toUpperCase()}</p>
    </div>

    <p style="color:#ddd;font-size:15px;line-height:1.6;margin-bottom:24px;">Hey ${customerName || 'there'}! 👋<br/>Thanks for supporting O'Neil Beats. Your ${items.length} beat${items.length > 1 ? 's are' : ' is'} ready to download below.</p>

    ${beatCards}

    <div style="background:rgba(245,158,11,0.08);border:1px solid rgba(245,158,11,0.3);border-radius:10px;padding:14px;margin-top:16px;">
      <div style="color:#f59e0b;font-weight:700;font-size:13px;margin-bottom:4px;">📋 License Information</div>
      <div style="color:#aaa;font-size:12px;line-height:1.5;">Each beat includes a signed license PDF with your usage rights. Keep these for your records. License types: <b>Basic Lease</b> (non-exclusive, up to 10K streams), <b>Premium</b> (WAV, up to 100K streams), <b>Stems</b> (full stems + unlimited streams).</div>
    </div>

    <div style="text-align:center;margin-top:32px;padding-top:24px;border-top:1px solid #222;">
      <p style="color:#666;font-size:12px;margin:0 0 4px 0;">Need help? Reply to this email.</p>
      <p style="color:#666;font-size:12px;margin:0;">— O'Neil Beats 🎧</p>
    </div>
  </div>
</body></html>`;

          try {
            await mailer.sendMail({
              from: `"O'Neil Beats" <${process.env.EMAIL_FROM}>`,
              to: customerEmail,
              subject: `🎵 Your O'Neil Beats Order — ${items.length} beat${items.length > 1 ? 's' : ''} ready!`,
              text: `Hey ${customerName || 'there'}!\n\nThanks for your purchase! Here are your download links:\n\n${textLinks}\n\nYou can also view your purchases in the O'Neil Beats app.\n\nEnjoy the beats!\n— O'Neil Beats`,
              html: htmlEmail,
            });
            console.log(`✓ Download email sent to ${customerEmail} for order ${orderId}`);
          } catch (emailErr) {
            console.error('Email send error:', emailErr.message);
          }
        }
      } catch (fulfillErr) {
        console.error('Order fulfillment error:', fulfillErr);
      }
    }
  }

  res.json({ received: true });
});

// ═══════════════════════════════════════════════════════════════════════════════
// ═══════════════════════════════════════════════════════════════════════════════
// FAVORITES — per-user beat favorites synced to Supabase
// ═══════════════════════════════════════════════════════════════════════════════

// GET /favorites?userId=... — get user's favorite beat IDs
app.get('/favorites', async (req, res) => {
  try {
    const { userId } = req.query;
    if (!userId) return res.status(400).json({ error: 'userId required' });
    const supabase = getSupabaseClient();
    const { data, error } = await supabase
      .from('favorites')
      .select('beat_id, created_at')
      .eq('user_id', userId)
      .order('created_at', { ascending: false });
    if (error) throw error;
    res.json({ success: true, favorites: data.map(f => f.beat_id) });
  } catch (err) {
    console.error('Get favorites error:', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /favorites — add a beat to favorites
app.post('/favorites', async (req, res) => {
  try {
    const { userId, beatId } = req.body;
    if (!userId || !beatId) return res.status(400).json({ error: 'userId and beatId required' });
    const supabase = getSupabaseClient();
    const { error } = await supabase
      .from('favorites')
      .upsert({ user_id: userId, beat_id: beatId }, { onConflict: 'user_id,beat_id' });
    if (error) throw error;
    res.json({ success: true });
  } catch (err) {
    console.error('Add favorite error:', err);
    res.status(500).json({ error: err.message });
  }
});

// DELETE /favorites — remove a beat from favorites
app.delete('/favorites', async (req, res) => {
  try {
    const { userId, beatId } = req.body;
    if (!userId || !beatId) return res.status(400).json({ error: 'userId and beatId required' });
    const supabase = getSupabaseClient();
    const { error } = await supabase
      .from('favorites')
      .delete()
      .eq('user_id', userId)
      .eq('beat_id', beatId);
    if (error) throw error;
    res.json({ success: true });
  } catch (err) {
    console.error('Remove favorite error:', err);
    res.status(500).json({ error: err.message });
  }
});

// CUSTOMER PURCHASES — fetch purchase history + download/license links
// ═══════════════════════════════════════════════════════════════════════════════

// GET /purchases?email=... — get all paid orders for a customer
app.get('/purchases', async (req, res) => {
  try {
    const email = req.query.email;
    if (!email) return res.status(400).json({ error: 'email query param required' });

    const orders = await getOrdersByEmail(email);
    const baseUrl = process.env.APP_URL || 'https://oneil-beats-backend.vercel.app';

    // Enrich with download and license URLs
    const enriched = orders.map(order => ({
      orderId: order.id,
      status: order.status,
      customerEmail: order.customer_email,
      customerName: order.customer_name,
      totalAmount: order.total_amount,
      paidAt: order.paid_at,
      items: (order.order_items || []).map(item => {
        const downloads = {};
        // Always include MP3 for all tiers
        downloads.mp3 = item.mp3_url ? `${baseUrl}/download/${order.id}/${item.beat_id}?format=mp3` : null;
        // WAV for premium and stems
        if (item.license_type === 'premium' || item.license_type === 'stems') {
          downloads.wav = item.wav_url ? `${baseUrl}/download/${order.id}/${item.beat_id}?format=wav` : null;
        }
        // Stems for stems tier
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

// POST /upload/proxy-image — fetch a remote image and return it as a blob
// Used as fallback when browser CORS blocks direct fetch of AI-generated covers
app.post('/upload/proxy-image', requireAdminKey, async (req, res) => {
  try {
    const { url } = req.body;
    if (!url) return res.status(400).json({ error: 'url required' });

    // Use global fetch (Node 18+) or fallback to node-fetch if needed
    const fetchFn = typeof fetch !== 'undefined' ? fetch : (await import('node-fetch')).default;
    const response = await fetchFn(url, { redirect: 'follow' });
    if (!response.ok) return res.status(response.status).json({ error: `remote fetch ${response.status}` });

    const contentType = response.headers.get('content-type') || 'image/jpeg';
    const buffer = Buffer.from(await response.arrayBuffer());
    res.set('Content-Type', contentType);
    res.set('Cache-Control', 'no-store');
    res.send(buffer);
  } catch (err) {
    console.error('Proxy image error:', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /upload/cover-from-url — server-side download + upload to Supabase
// Bulletproof fallback for AI cover uploads when client-side paths fail
app.post('/upload/cover-from-url', requireAdminKey, async (req, res) => {
  try {
    const { imageUrl, filename } = req.body;
    if (!imageUrl) return res.status(400).json({ error: 'imageUrl required' });

    const fetchFn = typeof fetch !== 'undefined' ? fetch : (await import('node-fetch')).default;
    const response = await fetchFn(imageUrl, { redirect: 'follow' });
    if (!response.ok) throw new Error(`Remote fetch failed: ${response.status}`);

    const mimeType = response.headers.get('content-type') || 'image/jpeg';
    const buffer = Buffer.from(await response.arrayBuffer());
    if (!buffer.length) throw new Error('empty image body');

    const ext = mimeType.includes('png') ? 'png' : 'jpg';
    const safeName = filename || `cover_${Date.now()}.${ext}`;

    const publicUrl = await uploadFileToStorage(buffer, safeName, 'cover-art', mimeType);
    res.json({ success: true, url: publicUrl });
  } catch (err) {
    console.error('Cover-from-url error:', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /upload/file — direct file upload via multipart (bypasses bucket MIME restrictions)
// Used for stems ZIP, WAV, or any file the signed URL approach rejects
app.post('/upload/file', requireAdminKey, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file provided' });

    const bucket = req.body.bucket || 'beats';
    const mimeType = req.file.mimetype || 'application/octet-stream';
    const filename = req.file.originalname || `upload_${Date.now()}`;

    console.log(`[Upload/file] ${filename} (${(req.file.size/1024/1024).toFixed(1)}MB) → bucket=${bucket} mime=${mimeType}`);

    const publicUrl = await uploadFileToStorage(req.file.buffer, filename, bucket, mimeType);
    res.json({ success: true, url: publicUrl, bucket });
  } catch (err) {
    console.error('File upload error:', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /upload/beat-metadata — register beat with pre-uploaded file URLs
app.post('/upload/beat-metadata', requireAdminKey, async (req, res) => {
  try {
    const {
      title, genre, subgenre, bpm, key, mood, tags,
      lease_price, premium_price, stems_price,
      audio_url, cover_url,
      wav_url, stem_url,
    } = req.body;

    if (!audio_url) {
      return res.status(400).json({ error: 'audio_url required' });
    }

    const beatId = await addBeatToDB({
      title, genre, subgenre, bpm, key, mood,
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

    // Try to create signed URL — if bucket doesn't exist, auto-create it
    let data, error;
    ({ data, error } = await supabase.storage
      .from(targetBucket)
      .createSignedUploadUrl(safeName));

    // If bucket not found, try creating it then retry
    if (error && (error.message.includes('not found') || error.message.includes('Bucket not found') || error.statusCode === 404)) {
      console.log(`Bucket "${targetBucket}" not found, creating...`);
      const { error: createErr } = await supabase.storage.createBucket(targetBucket, {
        public: true,
        fileSizeLimit: 524288000, // 500MB for stems
      });
      if (createErr && !createErr.message.includes('already exists')) {
        console.warn(`Could not create bucket "${targetBucket}":`, createErr.message);
      }
      // Retry signed URL
      ({ data, error } = await supabase.storage
        .from(targetBucket)
        .createSignedUploadUrl(safeName));
    }

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
// GOOGLE DRIVE UPLOAD — Direct to Google Drive (no storage costs, no file size limits)
// ═══════════════════════════════════════════════════════════════════════════════

// POST /upload/drive-resumable — get a resumable upload URL for Google Drive
// Client sends the file directly to Google's servers — bypasses Vercel 4.5MB limit
app.post('/upload/drive-resumable', requireAdminKey, async (req, res) => {
  try {
    const { filename, mimeType, folder } = req.body;
    if (!filename) return res.status(400).json({ error: 'filename required' });

    const result = await createResumableUpload(
      filename,
      mimeType || 'application/octet-stream',
      folder || null
    );

    res.json({
      success: true,
      uploadUrl: result.uploadUrl,
      folderId: result.folderId,
    });
  } catch (err) {
    console.error('Drive resumable URL error:', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /upload/drive-finalize — after upload completes, set permissions and get URLs
app.post('/upload/drive-finalize', requireAdminKey, async (req, res) => {
  try {
    const { fileId, type } = req.body;
    if (!fileId) return res.status(400).json({ error: 'fileId required' });

    const urls = await finalizeUpload(fileId);

    // Return appropriate URL based on type
    let publicUrl;
    if (type === 'cover') {
      publicUrl = urls.imageUrl;
    } else if (type === 'stems' || type === 'wav') {
      publicUrl = urls.downloadUrl;
    } else {
      publicUrl = urls.streamUrl; // MP3 audio — streamable
    }

    res.json({
      success: true,
      fileId: urls.fileId,
      publicUrl,
      streamUrl: urls.streamUrl,
      downloadUrl: urls.downloadUrl,
      imageUrl: urls.imageUrl,
    });
  } catch (err) {
    console.error('Drive finalize error:', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /upload/drive-proxy — proxy file upload through backend to Google Drive
// Solves CORS issue: browser can't PUT directly to googleapis.com
// Accepts chunked uploads (max ~4MB per chunk) for Vercel compatibility
// Client flow: 1) POST /drive-proxy-init → get uploadUrl  2) PUT /drive-proxy-chunk with each chunk  3) POST /drive-finalize
app.post('/upload/drive-proxy-init', requireAdminKey, async (req, res) => {
  try {
    const { filename, mimeType, fileSize, folder } = req.body;
    if (!filename) return res.status(400).json({ error: 'filename required' });

    const result = await createResumableUpload(
      filename,
      mimeType || 'application/octet-stream',
      folder || null
    );

    res.json({
      success: true,
      uploadUrl: result.uploadUrl,
      folderId: result.folderId,
    });
  } catch (err) {
    console.error('Drive proxy init error:', err);
    res.status(500).json({ error: err.message });
  }
});

// PUT /upload/drive-proxy-chunk — forward a chunk to Google's resumable upload URL
app.put('/upload/drive-proxy-chunk', requireAdminKey, express.raw({ type: '*/*', limit: '4.5mb' }), async (req, res) => {
  try {
    const uploadUrl = req.headers['x-upload-url'];
    const contentRange = req.headers['x-content-range'];
    const contentType = req.headers['x-content-type'] || 'application/octet-stream';

    if (!uploadUrl) return res.status(400).json({ error: 'x-upload-url header required' });

    const headers = {
      'Content-Type': contentType,
      'Content-Length': req.body.length.toString(),
    };
    if (contentRange) headers['Content-Range'] = contentRange;

    const gRes = await fetch(uploadUrl, {
      method: 'PUT',
      headers,
      body: req.body,
    });

    // 308 = Resume Incomplete (chunk received, send more)
    // 200/201 = Upload complete
    if (gRes.status === 308) {
      const range = gRes.headers.get('range');
      return res.json({ success: true, status: 308, range });
    }

    if (gRes.ok) {
      const data = await gRes.json();
      return res.json({ success: true, status: gRes.status, fileId: data.id, name: data.name });
    }

    const errText = await gRes.text();
    res.status(gRes.status).json({ error: `Google returned ${gRes.status}: ${errText}` });
  } catch (err) {
    console.error('Drive proxy chunk error:', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /upload/drive-proxy-small — upload small files (<4MB) in one shot through backend
// For cover art, small MP3s, etc.
app.post('/upload/drive-proxy-small', requireAdminKey, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file provided' });
    const fileType = req.body.type || 'mp3';
    const mimeType = req.file.mimetype || 'application/octet-stream';
    const safeName = `${Date.now()}_${(req.file.originalname || 'file').replace(/[^a-zA-Z0-9._-]/g, '_')}`;

    // Upload directly to Google Drive from server
    const fileId = await uploadFileToDrive(req.file.buffer, safeName, mimeType);
    const urls = await finalizeUpload(fileId);

    let publicUrl;
    if (fileType === 'cover') publicUrl = urls.imageUrl;
    else if (fileType === 'stems' || fileType === 'wav') publicUrl = urls.downloadUrl;
    else publicUrl = urls.streamUrl;

    res.json({ success: true, fileId, publicUrl, streamUrl: urls.streamUrl, downloadUrl: urls.downloadUrl, imageUrl: urls.imageUrl });
  } catch (err) {
    console.error('Drive proxy small upload error:', err);
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
    const { mood, title, genre, tags, key: beatKey, seed: clientSeed, variation } = req.body;
    if (!mood) return res.status(400).json({ error: 'mood required' });

    const theme = COVER_THEMES[mood] || COVER_THEMES['Dark'];
    // Use seed/variation for deterministic but varied prompt selection
    const seedValue = parseInt(clientSeed || variation || Date.now());
    const promptIndex = Math.abs(seedValue) % theme.prompts.length;
    const prompt = theme.prompts[promptIndex];

    // Build a richer prompt using tags and key for context
    // Add variation-specific style modifiers for visual diversity
    const styleModifiers = [
      'photorealistic detailed lighting',
      'artistic stylized illustration',
      'cinematic wide composition',
      'minimalist bold composition',
      'vintage film aesthetic',
      'modern vibrant digital art',
    ];
    const styleMod = styleModifiers[Math.abs(seedValue) % styleModifiers.length];
    const tagContext = tags ? `, ${tags} aesthetic` : '';
    const toneContext = beatKey && beatKey.includes('Minor') ? ', moody dark tones' : beatKey ? ', bright warm tones' : '';
    const fullPrompt = `${prompt}, ${styleMod}, ${genre || 'hip hop'} music album cover${tagContext}${toneContext}, square format, high quality, no text no words no letters`;

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
    // Use client-provided seed if available for reproducible variations
    const seed = parseInt(clientSeed || variation || Date.now());
    const pollinationsUrl = `https://image.pollinations.ai/prompt/${encodeURIComponent(fullPrompt)}?width=1024&height=1024&seed=${seed}&nologo=true`;

    try {
      // Pollinations.ai can be slow — extended timeout + retry for .exe reliability
      const imgRes = await fetch(pollinationsUrl, { signal: AbortSignal.timeout(75000) });
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

// ── Coupon / Promo Code Management (synced to Stripe) ────────────────────────

// GET /admin/coupons — list all Stripe coupons + promo codes
app.get('/admin/coupons', requireAdminKey, async (req, res) => {
  try {
    const coupons = await stripe.coupons.list({ limit: 50 });
    // For each coupon, fetch its promotion codes
    const enriched = await Promise.all(coupons.data.map(async (c) => {
      const promos = await stripe.promotionCodes.list({ coupon: c.id, limit: 10 });
      return {
        id: c.id,
        name: c.name || c.id,
        percent_off: c.percent_off,
        amount_off: c.amount_off,
        currency: c.currency,
        duration: c.duration,
        duration_in_months: c.duration_in_months,
        max_redemptions: c.max_redemptions,
        times_redeemed: c.times_redeemed,
        valid: c.valid,
        created: c.created,
        promotion_codes: promos.data.map(p => ({
          id: p.id,
          code: p.code,
          active: p.active,
          times_redeemed: p.times_redeemed,
          max_redemptions: p.max_redemptions,
        })),
      };
    }));
    res.json({ success: true, coupons: enriched });
  } catch (err) {
    console.error('List coupons error:', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /admin/coupons — create a new Stripe coupon + optional promo code
app.post('/admin/coupons', requireAdminKey, async (req, res) => {
  try {
    const { name, percent_off, amount_off, currency, duration, duration_in_months, max_redemptions, promo_code } = req.body;
    const couponParams = { name: name || 'Discount', duration: duration || 'once' };
    if (percent_off) couponParams.percent_off = parseFloat(percent_off);
    else if (amount_off) { couponParams.amount_off = Math.round(parseFloat(amount_off) * 100); couponParams.currency = currency || 'usd'; }
    if (duration_in_months) couponParams.duration_in_months = parseInt(duration_in_months);
    if (max_redemptions) couponParams.max_redemptions = parseInt(max_redemptions);

    const coupon = await stripe.coupons.create(couponParams);

    // Create a promotion code if provided
    let promoCode = null;
    if (promo_code) {
      promoCode = await stripe.promotionCodes.create({
        coupon: coupon.id,
        code: promo_code.toUpperCase(),
      });
    }

    res.json({ success: true, coupon, promoCode });
  } catch (err) {
    console.error('Create coupon error:', err);
    res.status(500).json({ error: err.message });
  }
});

// DELETE /admin/coupons/:id — delete a Stripe coupon
app.delete('/admin/coupons/:id', requireAdminKey, async (req, res) => {
  try {
    await stripe.coupons.del(req.params.id);
    res.json({ success: true, message: 'Coupon deleted' });
  } catch (err) {
    console.error('Delete coupon error:', err);
    res.status(500).json({ error: err.message });
  }
});

// PUT /admin/coupons/:promoId/toggle — activate/deactivate a promotion code
app.put('/admin/coupons/:promoId/toggle', requireAdminKey, async (req, res) => {
  try {
    const { active } = req.body;
    const promo = await stripe.promotionCodes.update(req.params.promoId, { active: !!active });
    res.json({ success: true, promo });
  } catch (err) {
    console.error('Toggle promo error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Export for Vercel serverless
module.exports = app;

// Start listening if run directly (non-Vercel / local)
if (require.main === module) {
  const PORT = process.env.PORT || 3001;
  app.listen(PORT, () => {
    console.log('Backend listening on port ' + PORT);
  });
}
