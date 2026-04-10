// ─── O'Neil Beats Backend Server ──────────────────────────────────────────────
// Express API: Google Drive/Sheets catalog + Stripe checkout + license delivery

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { v4: uuidv4 } = require('uuid');
const nodemailer = require('nodemailer');

const {
  fetchBeatsFromSheet,
  addBeatToSheet,
  updateBeatInSheet,
  deleteBeatInSheet,
  incrementPlayCount,
  uploadFileToDrive,
  getDriveDownloadUrl,
} = require('./googleApi');
const { generateLicensePDF, LICENSE_TERMS } = require('./licenseGenerator');

const app = express();
const PORT = process.env.PORT || 3001;

// ── Middleware ─────────────────────────────────────────────────────────────────
app.use(cors({ origin: '*' }));

// Stripe webhooks need raw body — must be before express.json()
app.use('/webhook', express.raw({ type: 'application/json' }));
app.use(express.json());

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
const orders = new Map(); // orderId -> orderData

// ═══════════════════════════════════════════════════════════════════════════════
// BEATS CATALOG ENDPOINTS
// ═══════════════════════════════════════════════════════════════════════════════

// GET /beats — fetch all active beats from Google Sheet
app.get('/beats', async (req, res) => {
  try {
    const beats = await fetchBeatsFromSheet();
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

// POST /checkout — create Stripe checkout session
// Body: { cartItems: [{ beatId, beatTitle, licenseType, price }], customerEmail }
app.post('/checkout', async (req, res) => {
  try {
    const { cartItems, customerEmail } = req.body;

    if (!cartItems || cartItems.length === 0) {
      return res.status(400).json({ error: 'Cart is empty' });
    }

    // Build Stripe line items
    const lineItems = cartItems.map(item => ({
      price_data: {
        currency: 'usd',
        product_data: {
          name: `${item.beatTitle}`,
          description: `${LICENSE_TERMS[item.licenseType]?.name || 'License'} — O'Neil Beats`,
          metadata: { beatId: item.beatId, licenseType: item.licenseType },
        },
        unit_amount: Math.round(item.price * 100), // cents
      },
      quantity: 1,
    }));

    // Store pending order
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
      success_url: `${process.env.APP_URL}/success?order=${orderId}&session={CHECKOUT_SESSION_ID}`,
      cancel_url: `${process.env.APP_URL}/cancel`,
      metadata: { orderId },
    });

    res.json({ url: session.url, sessionId: session.id, orderId });
  } catch (err) {
    console.error('Checkout error:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /order/:orderId — check order status and get download links
app.get('/order/:orderId', async (req, res) => {
  const order = orders.get(req.params.orderId);
  if (!order) return res.status(404).json({ error: 'Order not found' });
  res.json(order);
});

// GET /download/:orderId/:beatId — stream beat download + license PDF
app.get('/download/:orderId/:beatId', async (req, res) => {
  const order = orders.get(req.params.orderId);
  if (!order || order.status !== 'paid') {
    return res.status(403).json({ error: 'Access denied — order not paid' });
  }

  const item = order.cartItems.find(i => i.beatId === req.params.beatId);
  if (!item) return res.status(404).json({ error: 'Beat not found in order' });

  // Redirect to Google Drive download
  const downloadUrl = getDriveDownloadUrl(item.audioFileId);
  res.redirect(downloadUrl);
});

// GET /license/:orderId/:beatId — download the license PDF
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

      // Fetch beat metadata to include in email
      try {
        const beats = await fetchBeatsFromSheet();
        const enrichedItems = order.cartItems.map(item => {
          const beat = beats.find(b => b.id === item.beatId) || {};
          return { ...item, beatMeta: beat, audioFileId: beat.audio_file_id };
        });
        order.cartItems = enrichedItems;
        orders.set(orderId, order);

        // Send confirmation email with download links
        await sendOrderEmail(order);
      } catch (emailErr) {
        console.error('Email send error:', emailErr);
      }
    }
  }

  res.json({ received: true });
});

// ─── Send order confirmation email ────────────────────────────────────────────
async function sendOrderEmail(order) {
  const appUrl = process.env.APP_URL;

  const downloadLinks = order.cartItems.map(item => `
    <tr>
      <td style="padding:12px;border-bottom:1px solid #eee;">
        <strong>${item.beatTitle}</strong><br>
        <span style="color:#666;font-size:12px;">${LICENSE_TERMS[item.licenseType]?.name || 'License'}</span>
      </td>
      <td style="padding:12px;border-bottom:1px solid #eee;text-align:right;">
        <a href="${appUrl}/download/${order.orderId}/${item.beatId}"
           style="background:#f59e0b;color:#000;padding:8px 16px;border-radius:6px;text-decoration:none;font-weight:bold;margin-right:8px;">
          Download Beat
        </a>
        <a href="${appUrl}/license/${order.orderId}/${item.beatId}"
           style="background:#1a1a2e;color:#fff;padding:8px 16px;border-radius:6px;text-decoration:none;font-weight:bold;">
          Get License PDF
        </a>
      </td>
    </tr>
  `).join('');

  const html = `
    <!DOCTYPE html>
    <html>
    <body style="font-family:Arial,sans-serif;background:#f5f5f5;margin:0;padding:20px;">
      <div style="max-width:600px;margin:0 auto;background:#fff;border-radius:12px;overflow:hidden;">
        <div style="background:#1a1a2e;padding:30px;text-align:center;">
          <h1 style="color:#f59e0b;font-size:28px;margin:0;letter-spacing:4px;">O'NEIL BEATS</h1>
          <p style="color:#888;margin:8px 0 0;">Your purchase is confirmed 🎶</p>
        </div>
        <div style="padding:30px;">
          <p>Hey ${order.customerName || 'there'}! Thanks for your purchase.</p>
          <p>Your beats and license agreements are ready to download below:</p>
          <table style="width:100%;border-collapse:collapse;margin:20px 0;">
            ${downloadLinks}
          </table>
          <div style="background:#f8f9fa;border-radius:8px;padding:16px;margin-top:20px;">
            <p style="margin:0;font-size:13px;color:#666;">
              <strong>Order #${order.orderId}</strong><br>
              Download links are active for 30 days.<br>
              Make sure to credit <strong>Prod. by O'Neil Beats</strong> in your release.
            </p>
          </div>
        </div>
        <div style="background:#1a1a2e;padding:16px;text-align:center;">
          <p style="color:#666;font-size:12px;margin:0;">
            Questions? Email <a href="mailto:produceroneil@gmail.com" style="color:#f59e0b;">produceroneil@gmail.com</a>
          </p>
        </div>
      </div>
    </body>
    </html>
  `;

  await mailer.sendMail({
    from: `O'Neil Beats <${process.env.EMAIL_FROM}>`,
    to: order.customerEmail,
    subject: "Your O'Neil Beats Purchase — Downloads Ready 🎵",
    html,
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// PRODUCER UPLOAD ENDPOINTS (protected by admin key)
// ═══════════════════════════════════════════════════════════════════════════════

function requireAdminKey(req, res, next) {
  const key = req.headers['x-admin-key'] || req.query.adminKey;
  if (key !== process.env.ADMIN_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

// POST /upload/beat — upload audio + cover art, add to catalog
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

      // Upload audio to Google Drive
      const audioFileId = await uploadFileToDrive(
        audioFile.buffer,
        `${title || 'beat'}_${Date.now()}.mp3`,
        audioFile.mimetype
      );

      // Upload cover art if provided
      let coverArtId = '';
      if (coverFile) {
        coverArtId = await uploadFileToDrive(
          coverFile.buffer,
          `${title || 'beat'}_cover_${Date.now()}.jpg`,
          coverFile.mimetype
        );
      }

      // Add to Google Sheet
      const beatId = await addBeatToSheet({
        title, genre, bpm, key, mood,
        tags: tags ? tags.split(',') : [],
        lease_price, premium_price, stems_price,
        audio_file_id: audioFileId,
        cover_art_id: coverArtId,
      });

      res.json({
        success: true,
        beatId,
        audioFileId,
        coverArtId,
        message: `Beat "${title}" uploaded successfully!`,
      });
    } catch (err) {
      console.error('Upload error:', err);
      res.status(500).json({ error: err.message });
    }
  }
);

// GET /upload/status — check server + credentials status
app.get('/upload/status', requireAdminKey, async (req, res) => {
  try {
    const beats = await fetchBeatsFromSheet();
    res.json({ success: true, beatCount: beats.length, message: 'Server healthy' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// ADMIN BEAT MANAGEMENT (edit + delete)
// ═════════════════════════════