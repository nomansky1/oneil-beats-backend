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
const { generateLicensePDF, LICENSE_TERMS } = require('./licenseGenerator');

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
const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

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

          const htmlEmail = `<!DOCTYPE html><html><body style="background:#06060a;"><div style="max-width:600px;margin:0 auto;padding:32px 20px;"><h1 style="color:#fff;">🎵 Your O'Neil Beats Are Ready!</h1><p style="color:#888;">Order #${orderId.slice(0,8)}</p>${beatCards}<p style="color:#666;font-size:12px;margin-top:20px;">Thank you for your purchase!</p></div></body></html>`;

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
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
