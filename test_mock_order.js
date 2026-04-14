// ─── Mock Order Test Script ──────────────────────────────────────────────────
// Simulates a full purchase flow to verify:
//   1. Order creation in Supabase
//   2. Order fulfillment (without actual Stripe payment)
//   3. PDF license generation
//   4. Email delivery with download links
//
// Usage: node test_mock_order.js [email]
// Example: node test_mock_order.js test@example.com

require('dotenv').config();
const { v4: uuidv4 } = require('uuid');
const nodemailer = require('nodemailer');
const {
  fetchBeatsFromDB,
  createOrder,
  fulfillOrder,
  getOrderById,
} = require('./supabaseApi');
const { generateLicensePDF } = require('./licenseGenerator');

const TEST_EMAIL = process.argv[2] || process.env.EMAIL_FROM || 'test@example.com';
const TEST_NAME = 'Test Customer';
const BASE_URL = process.env.APP_URL || 'https://oneil-beats-backend.vercel.app';

const mailer = nodemailer.createTransport({
  service: 'gmail',
  auth: { user: process.env.EMAIL_FROM, pass: process.env.EMAIL_PASS },
});

async function runMockOrder() {
  console.log('\n╔══════════════════════════════════════════════════════╗');
  console.log('║   O\'Neil Beats — Mock Order Test                    ║');
  console.log('╚══════════════════════════════════════════════════════╝\n');
  console.log(`Test email: ${TEST_EMAIL}\n`);

  // 1. Fetch available beats
  console.log('[1/6] Fetching beats from database...');
  const beats = await fetchBeatsFromDB();
  if (beats.length === 0) {
    console.error('❌ No beats in database. Upload some beats first.');
    process.exit(1);
  }
  console.log(`✓ Found ${beats.length} beats\n`);

  // 2. Pick up to 3 beats — one for each license type
  const selectedBeats = beats.slice(0, Math.min(3, beats.length));
  const licenseTypes = ['lease', 'premium', 'stems'];
  const cartItems = selectedBeats.map((beat, i) => ({
    beatId: beat.id,
    beatTitle: beat.title,
    licenseType: licenseTypes[i] || 'lease',
    price: i === 0 ? 29.99 : i === 1 ? 99.99 : 199.99,
  }));

  console.log('[2/6] Cart:');
  cartItems.forEach(item => {
    console.log(`   • ${item.beatTitle} — ${item.licenseType} ($${item.price})`);
  });
  console.log('');

  // 3. Create mock order (bypasses Stripe)
  const orderId = uuidv4();
  const totalAmount = cartItems.reduce((sum, i) => sum + i.price, 0);
  console.log(`[3/6] Creating mock order ${orderId}...`);
  await createOrder({
    orderId,
    customerEmail: TEST_EMAIL,
    cartItems,
    totalAmount,
  });
  console.log(`✓ Order created (total: $${totalAmount.toFixed(2)})\n`);

  // 4. Fulfill order (mark as paid, enrich with file URLs)
  console.log('[4/6] Fulfilling order (enriching items with file URLs)...');
  await fulfillOrder({
    orderId,
    stripeSessionId: `mock_${Date.now()}`,
    customerEmail: TEST_EMAIL,
    customerName: TEST_NAME,
    beats,
  });
  console.log('✓ Order status: paid\n');

  // 5. Test license PDF generation for each item
  console.log('[5/6] Generating license PDFs...');
  for (const item of cartItems) {
    const beat = beats.find(b => b.id === item.beatId);
    try {
      const pdf = await generateLicensePDF({
        orderId,
        licenseType: item.licenseType,
        beat: { title: item.beatTitle, ...beat },
        buyer: { email: TEST_EMAIL, name: TEST_NAME },
      });
      console.log(`   ✓ ${item.beatTitle} (${item.licenseType}) — ${(pdf.length / 1024).toFixed(1)} KB PDF generated`);
    } catch (err) {
      console.error(`   ❌ ${item.beatTitle} — ${err.message}`);
    }
  }
  console.log('');

  // 6. Send test email with download links
  console.log('[6/6] Sending confirmation email...');
  const order = await getOrderById(orderId);
  const items = order?.order_items || [];

  const beatCards = items.map(item => {
    const dlBase = `${BASE_URL}/download/${orderId}/${item.beat_id}`;
    const licBase = `${BASE_URL}/license/${orderId}/${item.beat_id}`;
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
        <h3 style="color:#fff;margin:0;font-size:17px;">${item.beat_title}</h3>
        <span style="display:inline-block;margin-top:6px;padding:3px 10px;background:${tierColor}22;color:${tierColor};border-radius:4px;font-size:11px;font-weight:700;text-transform:uppercase;">${tierLabel}</span>
        <div style="margin-top:12px;">${buttons}</div>
      </div>`;
  }).join('');

  const html = `<!DOCTYPE html><html><body style="margin:0;padding:0;background:#06060a;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
  <div style="max-width:600px;margin:0 auto;padding:32px 20px;">
    <div style="text-align:center;margin-bottom:32px;">
      <div style="font-size:40px;margin-bottom:8px;">🎵</div>
      <h1 style="color:#fff;margin:0 0 8px 0;font-size:28px;background:linear-gradient(90deg,#e63946,#f59e0b);-webkit-background-clip:text;-webkit-text-fill-color:transparent;">Your Beats Are Ready!</h1>
      <p style="color:#888;margin:0;font-size:14px;">Order #${orderId.slice(0,8).toUpperCase()} — MOCK TEST</p>
    </div>
    <p style="color:#ddd;font-size:15px;margin-bottom:24px;">Hey ${TEST_NAME}! 👋<br/>This is a MOCK TEST of the O'Neil Beats order pipeline.</p>
    ${beatCards}
    <div style="text-align:center;margin-top:32px;padding-top:24px;border-top:1px solid #222;">
      <p style="color:#666;font-size:12px;margin:0;">— O'Neil Beats Test Pipeline 🎧</p>
    </div>
  </div>
</body></html>`;

  try {
    await mailer.sendMail({
      from: `"O'Neil Beats TEST" <${process.env.EMAIL_FROM}>`,
      to: TEST_EMAIL,
      subject: `[TEST] 🎵 Your O'Neil Beats Order — ${items.length} beats ready!`,
      html,
      text: `MOCK ORDER TEST\nOrder: ${orderId}\nItems: ${items.length}\nTotal: $${totalAmount.toFixed(2)}\n\nDownload links embedded in HTML email.`,
    });
    console.log(`✓ Test email sent to ${TEST_EMAIL}\n`);
  } catch (err) {
    console.error(`❌ Email send failed: ${err.message}\n`);
  }

  // Summary
  console.log('╔══════════════════════════════════════════════════════╗');
  console.log('║   MOCK ORDER TEST COMPLETE                           ║');
  console.log('╚══════════════════════════════════════════════════════╝');
  console.log(`\nOrder ID: ${orderId}`);
  console.log(`Email: ${TEST_EMAIL}`);
  console.log(`Items: ${items.length} (lease/premium/stems)`);
  console.log(`Total: $${totalAmount.toFixed(2)}`);
  console.log(`\nTest URLs:`);
  console.log(`  Order API: ${BASE_URL}/order/${orderId}`);
  console.log(`  Purchases: ${BASE_URL}/purchases?email=${encodeURIComponent(TEST_EMAIL)}`);
  console.log(`\n✅ Check inbox for test email with download buttons\n`);
}

runMockOrder().catch(err => {
  console.error('\n❌ FATAL ERROR:', err);
  process.exit(1);
});
