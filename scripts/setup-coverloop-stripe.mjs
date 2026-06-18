// One-time Stripe setup for CoverLoop Pro.
//
// Creates (idempotently — safe to re-run) a "CoverLoop Pro" product + a $19/mo
// recurring price in YOUR Stripe account, then prints the price id to set as
// COVERLOOP_PRICE_ID on Vercel. Nothing here charges anyone; it only defines the
// product you sell.
//
//   cd backend
//   STRIPE_SECRET_KEY=sk_live_xxx node scripts/setup-coverloop-stripe.mjs
//
// (Use your TEST key sk_test_... first to dry-run, then the live key.)

import Stripe from 'stripe';

const key = process.env.STRIPE_SECRET_KEY;
if (!key) { console.error('✗ Set STRIPE_SECRET_KEY first (sk_test_… or sk_live_…).'); process.exit(1); }
const stripe = new Stripe(key);

const PRODUCT_NAME = 'CoverLoop Pro';
const AMOUNT = 1900;          // $19.00 — change here to reprice
const CURRENCY = 'usd';
const INTERVAL = 'month';

async function main() {
  const mode = key.startsWith('sk_live') ? 'LIVE' : 'TEST';
  console.log(`Stripe mode: ${mode}\n`);

  // 1) Product — reuse if one tagged app=coverloop (or named the same) exists.
  const prods = await stripe.products.list({ active: true, limit: 100 });
  let product = prods.data.find((p) => p.metadata?.app === 'coverloop') || prods.data.find((p) => p.name === PRODUCT_NAME);
  if (!product) {
    product = await stripe.products.create({
      name: PRODUCT_NAME,
      description: 'Unlimited renders, batch render, scheduled auto-publishing, and cloud AI video.',
      metadata: { app: 'coverloop' },
    });
    console.log('✓ Created product   ', product.id);
  } else {
    console.log('• Using product     ', product.id, `(“${product.name}”)`);
  }

  // 2) Price — reuse a matching active recurring price, else create one.
  const prices = await stripe.prices.list({ product: product.id, active: true, limit: 100 });
  let price = prices.data.find((p) => p.recurring?.interval === INTERVAL && p.unit_amount === AMOUNT && p.currency === CURRENCY);
  if (!price) {
    price = await stripe.prices.create({
      product: product.id, unit_amount: AMOUNT, currency: CURRENCY,
      recurring: { interval: INTERVAL }, metadata: { app: 'coverloop' },
    });
    console.log('✓ Created price     ', price.id, `($${(AMOUNT / 100).toFixed(2)}/${INTERVAL})`);
  } else {
    console.log('• Using price       ', price.id, `($${(price.unit_amount / 100).toFixed(2)}/${price.recurring.interval})`);
  }

  console.log('\n=== NEXT: set this on Vercel (Project → Settings → Environment Variables) ===');
  console.log('  COVERLOOP_PRICE_ID=' + price.id);
  console.log('\nThen redeploy the backend so /coverloop/checkout can see it.');
}

main().catch((e) => { console.error('✗ ERROR', e.message); process.exit(1); });
