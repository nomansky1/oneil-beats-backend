/**
 * Payment Endpoints — Stripe PaymentIntents for in-app payments
 * Handles /checkout (PaymentIntent creation), webhooks, and order fulfillment
 */

const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { v4: uuidv4 } = require('uuid');
const nodemailer = require('nodemailer');
const { generateLicensePDF, LICENSE_TERMS } = require('./licenseGenerator');
const {
  createOrder,
  fulfillOrder,
  getOrderById,
  fetchBeatsFromDB,
  getSupabaseClient,
} = require('./supabaseApi');

const mailer = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.EMAIL_FROM,
    pass: process.env.EMAIL_PASS,
  },
});

// ═══════════════════════════════════════════════════════════════════════════════
// PAYMENT INTENT ENDPOINTS (for mobile in-app payments)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * POST /checkout
 * Create Stripe PaymentIntent for in-app payment
 * Returns clientSecret + ephemeralKey for Stripe PaymentSheet
 */
async function handleCheckout(req, res) {
  try {
    const { cartItems, customerEmail } = req.body;

    if (!cartItems || cartItems.length === 0) {
      return res.status(400).json({ error: 'Cart is empty' });
    }

    if (!customerEmail) {
      return res.status(400).json({ error: 'Customer email required' });
    }

    const orderId = uuidv4();
    const totalAmount = Math.round(
      cartItems.reduce((sum, i) => sum + (parseFloat(i.price) || 0), 0) * 100
    );

    // Create or get Stripe customer
    let customerId;
    try {
      const existingCustomers = await stripe.customers.list({ email: customerEmail, limit: 1 });
      customerId = existingCustomers.data[0]?.id || (
        await stripe.customers.create({ email: customerEmail })
      ).id;
    } catch (e) {
      customerId = (await stripe.customers.create({ email: customerEmail })).id;
    }

    // Persist order to Supabase BEFORE creating payment intent
    await createOrder({
      orderId,
      customerEmail,
      cartItems,
      totalAmount: totalAmount / 100,
    });

    // Create PaymentIntent
    const paymentIntent = await stripe.paymentIntents.create({
      amount: totalAmount,
      currency: 'usd',
      customer: customerId,
      automatic_payment_methods: { enabled: true },
      description: `O'Neil Beats — ${cartItems.length} beat(s)`,
      metadata: {
        orderId,
        cartItems: JSON.stringify(cartItems),
      },
    });

    // Create ephemeral key for current customer
    const ephemeralKey = await stripe.ephemeralKeys.create(
      { customer: customerId },
      { apiVersion: '2024-04-10' }
    );

    res.json({
      success: true,
      clientSecret: paymentIntent.client_secret,
      ephemeralKey: ephemeralKey.secret,
      customerId,
      orderId,
    });
  } catch (err) {
    console.error('Checkout error:', err);
    res.status(500).json({ error: err.message });
  }
}

/**
 * POST /webhook/stripe
 * Handle Stripe payment_intent.succeeded webhook
 * Fulfills order (generates license PDFs, sends emails, etc.)
 */
async function handleStripeWebhook(req, res) {
  const sig = req.headers['stripe-signature'];
  let event;

  try {
    event = stripe.webhooks.constructEvent(
      req.body,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.error('Webhook signature verification failed:', err);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  try {
    if (event.type === 'payment_intent.succeeded') {
      const paymentIntent = event.data.object;
      const orderId = paymentIntent.metadata.orderId;
      const cartItems = JSON.parse(paymentIntent.metadata.cartItems || '[]');

      console.log(`✓ Payment succeeded for order ${orderId}`);

      // Fetch order from DB
      const order = await getOrderById(orderId);
      if (!order) {
        console.error(`Order ${orderId} not found`);
        return res.json({ received: true });
      }

      // Fetch beats for license generation
      const allBeats = await fetchBeatsFromDB();
      const beats = allBeats.filter(b => cartItems.some(ci => ci.beatId === b.id));

      // Fulfill order (generate PDFs, update DB)
      await fulfillOrder({
        orderId,
        stripeSessionId: paymentIntent.id,
        customerEmail: order.customer_email,
        customerName: order.customer_name,
        beats,
      });

      // Send confirmation email with downloads
      await sendOrderConfirmationEmail({
        order,
        cartItems,
        beats,
        paymentIntentId: paymentIntent.id,
      });

      res.json({ received: true });
    } else {
      console.log(`Unhandled event type: ${event.type}`);
      res.json({ received: true });
    }
  } catch (err) {
    console.error('Webhook handler error:', err);
    res.status(500).json({ error: err.message });
  }
}

/**
 * Send order confirmation email with individual beat license PDFs
 */
async function sendOrderConfirmationEmail({ order, cartItems, beats, paymentIntentId }) {
  try {
    const beatsList = cartItems
      .map(item => {
        const beat = beats.find(b => b.id === item.beatId);
        const licenseInfo = LICENSE_TERMS[item.licenseType];
        return beat
          ? `<li><strong>${beat.title}</strong> — ${licenseInfo?.name || 'License'} ($${item.price})</li>`
          : null;
      })
      .filter(Boolean)
      .join('');

    const downloadLinks = cartItems
      .map((item, i) => {
        const beat = beats.find(b => b.id === item.beatId);
        if (!beat) return null;

        // Build download options based on license type
        const downloads = [];
        if (['lease', 'premium', 'stems'].includes(item.licenseType)) {
          downloads.push(`<a href="${process.env.API_URL}/download/${order.id}/${beat.id}?type=mp3" style="color: #e63946; text-decoration: none; margin-right: 12px;">📥 MP3</a>`);
        }
        if (['premium', 'stems'].includes(item.licenseType)) {
          downloads.push(`<a href="${process.env.API_URL}/download/${order.id}/${beat.id}?type=wav" style="color: #e63946; text-decoration: none; margin-right: 12px;">📥 WAV</a>`);
        }
        if (item.licenseType === 'stems') {
          downloads.push(`<a href="${process.env.API_URL}/download/${order.id}/${beat.id}?type=stems" style="color: #e63946; text-decoration: none; margin-right: 12px;">📥 Stems</a>`);
        }
        downloads.push(`<a href="${process.env.API_URL}/download/${order.id}/${beat.id}?type=pdf" style="color: #e63946; text-decoration: none;">📋 License</a>`);

        return `
          <div style="background: #0f0f14; border: 1px solid #222; border-radius: 8px; padding: 16px; margin-bottom: 12px;">
            <h3 style="color: #fff; margin: 0 0 8px 0;">${beat.title}</h3>
            <p style="color: #999; margin: 0 0 12px 0; font-size: 13px;">${beat.artist || "O'Neil"} • ${beat.genre} • ${beat.bpm} BPM</p>
            <div style="display: flex; gap: 12px; flex-wrap: wrap;">
              ${downloads.join('')}
            </div>
          </div>
        `;
      })
      .filter(Boolean)
      .join('');

    const emailHtml = `
      <div style="background: #06060a; color: #fff; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; padding: 32px;">
        <div style="max-width: 600px; margin: 0 auto;">
          <!-- Header -->
          <div style="text-align: center; margin-bottom: 32px;">
            <h1 style="margin: 0 0 8px 0; font-size: 28px;">🎵 Order Confirmed</h1>
            <p style="color: #999; margin: 0; font-size: 14px;">Order #${order.id.slice(0, 8).toUpperCase()}</p>
          </div>

          <!-- Order Summary -->
          <div style="background: #0f0f14; border: 1px solid #222; border-radius: 12px; padding: 20px; margin-bottom: 24px;">
            <h2 style="color: #e63946; margin: 0 0 16px 0; font-size: 18px;">Your Beats</h2>
            ${downloadLinks}
          </div>

          <!-- Order Details -->
          <div style="background: #0f0f14; border: 1px solid #222; border-radius: 12px; padding: 20px; margin-bottom: 24px;">
            <table style="width: 100%; font-size: 14px;">
              <tr style="border-bottom: 1px solid #222;">
                <td style="color: #999; padding: 8px 0;">Order Date</td>
                <td style="color: #fff; padding: 8px 0; text-align: right;">${new Date(order.created_at).toLocaleDateString()}</td>
              </tr>
              <tr style="border-bottom: 1px solid #222;">
                <td style="color: #999; padding: 8px 0;">Items</td>
                <td style="color: #fff; padding: 8px 0; text-align: right;">${cartItems.length} beat(s)</td>
              </tr>
              <tr>
                <td style="color: #999; padding: 8px 0; font-weight: bold;">Total</td>
                <td style="color: #e63946; padding: 8px 0; text-align: right; font-size: 16px; font-weight: bold;">$${order.total_amount.toFixed(2)}</td>
              </tr>
            </table>
          </div>

          <!-- License Info -->
          <div style="background: #0f0f14; border: 1px solid #222; border-radius: 12px; padding: 20px; margin-bottom: 24px;">
            <h3 style="color: #fff; margin: 0 0 12px 0;">📋 License Information</h3>
            <p style="color: #999; margin: 0; font-size: 13px; line-height: 1.6;">
              Your license terms are detailed in the PDF file attached and available in the downloads above.
              All beats are licensed for use in your projects. License PDFs are encrypted and tied to your email for security.
            </p>
          </div>

          <!-- Footer -->
          <div style="text-align: center; color: #666; font-size: 12px; margin-top: 32px; border-top: 1px solid #222; padding-top: 16px;">
            <p style="margin: 0 0 4px 0;">Thank you for supporting O'Neil Beats! 🙏</p>
            <p style="margin: 0;">Questions? Reply to this email or visit o'neil-beats.com</p>
          </div>
        </div>
      </div>
    `;

    await mailer.sendMail({
      from: process.env.EMAIL_FROM,
      to: order.customer_email,
      subject: `🎵 Your O'Neil Beats Order Confirmed (#${order.id.slice(0, 8).toUpperCase()})`,
      html: emailHtml,
      text: `
Order Confirmed!
Order #${order.id.slice(0, 8).toUpperCase()}

Beats:
${cartItems.map(item => `  • ${item.beatTitle} (${item.licenseType})`).join('\n')}

Total: $${order.total_amount.toFixed(2)}

Download links and license PDFs are available in the O'Neil Beats app under "My Purchases".
Thank you for supporting O'Neil Beats!
      `,
    });

    console.log(`✓ Order confirmation email sent to ${order.customer_email}`);
  } catch (err) {
    console.error('Email send error:', err);
  }
}

/**
 * GET /order/:id
 * Fetch order details (for mobile app to check payment status)
 */
async function getOrderEndpoint(req, res) {
  try {
    const { id } = req.params;
    const email = req.headers['x-customer-email'];

    if (!email) {
      return res.status(401).json({ error: 'Customer email required' });
    }

    const order = await getOrderById(id);
    if (!order || order.customer_email !== email) {
      return res.status(404).json({ error: 'Order not found' });
    }

    res.json({ success: true, order });
  } catch (err) {
    console.error('Get order error:', err);
    res.status(500).json({ error: err.message });
  }
}

module.exports = {
  handleCheckout,
  handleStripeWebhook,
  sendOrderConfirmationEmail,
  getOrderEndpoint,
};
