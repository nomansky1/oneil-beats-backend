#!/usr/bin/env node
/**
 * One-time Google Search Console OAuth re-auth.
 *
 * Why: the existing GOOGLE_OAUTH_REFRESH_TOKEN was issued for Drive scopes
 * only, so Search Console API calls return 403. This script runs a fresh
 * OAuth flow with `webmasters.readonly` and prints a new refresh token to
 * save as GOOGLE_GSC_REFRESH_TOKEN. We do NOT overwrite the Drive token —
 * Drive flows keep working as-is.
 *
 * Usage:
 *   1. Make sure GOOGLE_OAUTH_CLIENT_ID + GOOGLE_OAUTH_CLIENT_SECRET are in .env
 *   2. In Google Cloud Console for the same OAuth client, add this redirect URI:
 *        http://localhost:53682/oauth2callback
 *   3. node scripts/gsc-reauth.js
 *   4. A browser opens. Sign in with the Google account that owns the GSC property.
 *   5. The script prints `GOOGLE_GSC_REFRESH_TOKEN=...` — paste into .env (and Vercel).
 *
 * Required Google Cloud APIs (enable in same project as the OAuth client):
 *   - Search Console API (https://console.cloud.google.com/apis/library/searchconsole.googleapis.com)
 */
require('dotenv').config();
const http = require('http');
const url = require('url');
const { google } = require('googleapis');
const { exec } = require('child_process');

const CLIENT_ID = process.env.GOOGLE_OAUTH_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
const PORT = 53682;
const REDIRECT = `http://localhost:${PORT}/oauth2callback`;
const SCOPES = ['https://www.googleapis.com/auth/webmasters.readonly'];

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error('ERROR: GOOGLE_OAUTH_CLIENT_ID / GOOGLE_OAUTH_CLIENT_SECRET missing in .env');
  process.exit(1);
}

const oauth2Client = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, REDIRECT);
const authUrl = oauth2Client.generateAuthUrl({
  access_type: 'offline',
  prompt: 'consent', // force refresh-token issuance even if previously consented
  scope: SCOPES,
});

const server = http.createServer(async (req, res) => {
  const parsed = url.parse(req.url, true);
  if (parsed.pathname !== '/oauth2callback') {
    res.writeHead(404).end('not found');
    return;
  }
  const code = parsed.query.code;
  if (!code) {
    res.writeHead(400).end('no code');
    return;
  }
  try {
    const { tokens } = await oauth2Client.getToken(code);
    res.writeHead(200, { 'Content-Type': 'text/html' }).end(
      `<h2>OK — Search Console scope granted.</h2><p>Check your terminal for the refresh token. You can close this tab.</p>`
    );
    console.log('\n✓ Got tokens. Save THIS line in your .env (and Vercel env vars):\n');
    console.log(`GOOGLE_GSC_REFRESH_TOKEN=${tokens.refresh_token}\n`);
    if (!tokens.refresh_token) {
      console.warn('WARNING: no refresh_token returned. Revoke prior consent at https://myaccount.google.com/permissions and re-run.');
    }
    setTimeout(() => process.exit(0), 500);
  } catch (e) {
    res.writeHead(500).end('error: ' + e.message);
    console.error('TOKEN EXCHANGE FAILED:', e.message);
    process.exit(1);
  }
});

server.listen(PORT, () => {
  console.log(`Listening on ${REDIRECT}`);
  console.log('\nOpen this URL in your browser if it doesn\'t open automatically:\n');
  console.log(authUrl + '\n');
  // best-effort auto-open on Windows / mac / linux
  const opener = process.platform === 'win32' ? `start "" "${authUrl}"`
                : process.platform === 'darwin' ? `open "${authUrl}"`
                : `xdg-open "${authUrl}"`;
  exec(opener, () => {});
});
