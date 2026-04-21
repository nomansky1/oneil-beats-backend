#!/usr/bin/env node
// Smoke-test the YouTube auth path end-to-end.
// Run:  node backend/auto-upload/scripts/smoke-test-youtube.js
//
// What this checks:
//   1. Env vars are present (GOOGLE_OAUTH_* or YT_*)
//   2. googleapis can mint an access_token from the refresh_token
//   3. The token actually has YouTube read access (channels.list mine=true)
//      → proves `youtube` scope is granted, which is the prerequisite for
//        `youtube.upload` working on the real upload call.
//
// Cost: 1 YouTube Data API quota unit (out of your 10,000 daily default).

require('dotenv').config({ path: require('path').resolve(__dirname, '../../.env') });
const { google } = require('googleapis');

const CLIENT_ID     = process.env.YT_CLIENT_ID     || process.env.GOOGLE_OAUTH_CLIENT_ID;
const CLIENT_SECRET = process.env.YT_CLIENT_SECRET || process.env.GOOGLE_OAUTH_CLIENT_SECRET;
const REFRESH_TOKEN = process.env.YT_REFRESH_TOKEN || process.env.GOOGLE_OAUTH_REFRESH_TOKEN;

if (!CLIENT_ID || !CLIENT_SECRET || !REFRESH_TOKEN) {
  console.error('❌ Missing env var(s). Set YT_* or GOOGLE_OAUTH_* in backend/.env');
  process.exit(1);
}

(async () => {
  const oauth2 = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET);
  oauth2.setCredentials({ refresh_token: REFRESH_TOKEN });

  // Step 1: Mint an access token. This will fail with invalid_grant if the
  // refresh token is revoked/expired, or wrong client.
  let accessToken;
  try {
    const t = await oauth2.getAccessToken();
    accessToken = t.token;
    if (!accessToken) throw new Error('empty access_token');
    console.log('✅ Access token minted (starts', accessToken.slice(0, 6) + '...)');
  } catch (e) {
    console.error('❌ Access token mint failed:', e.message);
    console.error('   → Your refresh token may be wrong, revoked, or for the wrong OAuth client.');
    process.exit(2);
  }

  // Step 2: Call channels.list mine=true. Requires `youtube` or
  // `youtube.readonly` scope. If the scope is missing you get a 403 with
  // "Request had insufficient authentication scopes."
  const yt = google.youtube({ version: 'v3', auth: oauth2 });
  try {
    const res = await yt.channels.list({ part: ['snippet', 'contentDetails', 'statistics'], mine: true });
    const ch = res.data.items && res.data.items[0];
    if (!ch) {
      console.error('❌ channels.list returned no channel. Is this account a YouTube creator?');
      process.exit(3);
    }
    console.log('✅ Channel:', ch.snippet.title, `(id=${ch.id})`);
    console.log('   Subscribers:', ch.statistics.subscriberCount);
    console.log('   Videos:     ', ch.statistics.videoCount);
    console.log('   Views:      ', ch.statistics.viewCount);
    console.log('');
    console.log('🎉 YouTube auth works. You are cleared to upload.');
  } catch (e) {
    console.error('❌ channels.list failed:', e.message);
    if (/insufficient authentication scopes/i.test(e.message || '')) {
      console.error('   → Your refresh token does NOT have youtube scope. Re-run the OAuth Playground');
      console.error('     step and make sure youtube + youtube.upload scopes are both granted.');
    }
    process.exit(4);
  }
})();
