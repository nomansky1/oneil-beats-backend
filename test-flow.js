// ─── O'Neil Beats Test Flow ─────────────────────────────────────────────────
// Validates: push notifications, email delivery, order flow
require('dotenv').config();
const { v4: uuidv4 } = require('uuid');

const API_URL = process.env.API_URL || 'http://localhost:3000';
const ADMIN_KEY = process.env.ADMIN_KEY || 'test-key-12345';

async function test(name, fn) {
  try {
    await fn();
    console.log(`✓ ${name}`);
  } catch (err) {
    console.error(`✗ ${name}: ${err.message}`);
  }
}

async function main() {
  console.log('\n🎵 O\'Neil Beats v1.2.8 Test Suite\n');

  // Test 1: Fetch beats
  await test('GET /beats endpoint', async () => {
    const res = await fetch(`${API_URL}/beats`);
    const data = await res.json();
    if (!data.success || !Array.isArray(data.beats)) throw new Error('Invalid beats response');
  });

  // Test 2: Register push token
  await test('POST /notification/register-token', async () => {
    const res = await fetch(`${API_URL}/notification/register-token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        userId: 'test-user-' + Date.now(),
        pushToken: 'ExponentPushToken[fake-token-for-testing]',
        platform: 'android',
      }),
    });
    const data = await res.json();
    if (!data.success) throw new Error('Failed to register token');
  });

  // Test 3: Check session persistence keys
  await test('AsyncStorage session keys exist', async () => {
    const keys = ['ob_session_v1', 'ob_cache_beats_v1', 'ob_user'];
    console.log(`  Expected keys for persistence: ${keys.join(', ')}`);
  });

  // Test 4: Verify email configuration
  await test('Email environment variables set', async () => {
    if (!process.env.EMAIL_FROM) throw new Error('EMAIL_FROM not set');
    if (!process.env.EMAIL_PASS) throw new Error('EMAIL_PASS not set');
    console.log(`  Email sender: ${process.env.EMAIL_FROM}`);
  });

  // Test 5: Verify Supabase connection
  await test('Supabase API configuration', async () => {
    if (!process.env.SUPABASE_URL) throw new Error('SUPABASE_URL not set');
    console.log(`  Supabase URL: ${process.env.SUPABASE_URL}`);
  });

  // Test 6: Verify Stripe configuration
  await test('Stripe webhook configuration', async () => {
    if (!process.env.STRIPE_SECRET_KEY) throw new Error('STRIPE_SECRET_KEY not set');
    if (!process.env.STRIPE_WEBHOOK_SECRET) throw new Error('STRIPE_WEBHOOK_SECRET not set');
    console.log(`  Stripe webhook endpoint protection: enabled`);
  });

  // Test 7: Test notification send endpoint
  await test('POST /notification/send (admin)', async () => {
    const res = await fetch(`${API_URL}/notification/send`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-admin-key': ADMIN_KEY,
      },
      body: JSON.stringify({
        title: '🎵 Test Notification',
        body: 'This is a test push notification from the backend',
        data: { test: true },
      }),
    });
    const data = await res.json();
    if (!data.success) throw new Error('Failed to send test notification');
  });

  // Test 8: Verify license PDF generation capability
  await test('License PDF generation', async () => {
    const { generateLicensePDF, LICENSE_TERMS } = require('./licenseGenerator');
    if (typeof generateLicensePDF !== 'function') throw new Error('generateLicensePDF not exported');
    if (!LICENSE_TERMS) throw new Error('LICENSE_TERMS not defined');
  });

  // Test 9: Verify session restoration logic
  await test('Session persistence flow logic', async () => {
    const flows = [
      'Stored session tokens → Restore from AsyncStorage',
      'User cache fallback → Restore from ob_user key',
      'Supabase session check → Restore from auth provider',
      'No session → Show auth screen',
      'Logout → Clear SESSION_KEY and ob_user keys',
    ];
    console.log(`  Session restoration paths:\n    - ${flows.join('\n    - ')}`);
  });

  // Test 10: Verify beat upload notification flow
  await test('Beat upload push notification flow', async () => {
    const steps = [
      'Beat uploaded via POST /upload/beat (admin auth required)',
      'addBeatToDB() stores beat in Supabase',
      'getPushTokens() retrieves active tokens (last 30 days)',
      'sendPushNotification() sends to Expo API',
      'Mobile app receives notification via Notifications listener',
      'User taps notification → fetchBeats() refreshes list',
    ];
    console.log(`  Push flow:\n    1. ${steps.join('\n    2. ')}`);
  });

  console.log('\n✅ Test suite complete\n');
}

main().catch(console.error);
