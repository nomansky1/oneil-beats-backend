// Backend auth flow that bypasses Supabase Auth (which is currently
// quota-restricted, so signInWithIdToken / signInWithOAuth all 503).
//
// Three endpoints (registered onto the existing Express app):
//
//   POST /auth/apple/verify
//     Body: { identityToken, fullName? }
//     Verifies Apple's JWT signature against https://appleid.apple.com/auth/keys
//     Returns: { user: { id, email, name }, sessionToken }
//
//   GET /auth/google/start?return=<deeplink>
//     Stores `return` in a state cookie, redirects to Google's OAuth screen.
//
//   GET /auth/google/callback?code=...&state=...
//     Exchanges the code for tokens, verifies the Google ID token,
//     mints OUR session token, redirects to <return>?session_token=...&user=...
//
// Session tokens are HMAC-signed JSON (compact JWT-like; not real JWTs to
// keep dependencies down). The shared secret comes from process.env.SESSION_SECRET
// — generate once and put in Vercel env: `openssl rand -hex 32`.

const crypto = require('node:crypto');
const { jwtVerify, createRemoteJWKSet } = require('jose');
const { google } = require('googleapis');

const APPLE_BUNDLE_ID  = process.env.APPLE_BUNDLE_ID  || 'com.oneilbeats.app';
const APPLE_ISSUER     = 'https://appleid.apple.com';
const APPLE_JWKS       = createRemoteJWKSet(new URL('https://appleid.apple.com/auth/keys'));

const GOOGLE_CLIENT_ID     = process.env.GOOGLE_OAUTH_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
const GOOGLE_REDIRECT_URI  = process.env.GOOGLE_AUTH_CALLBACK || 'https://oneilbeats.store/auth/google/callback';

const SESSION_SECRET = process.env.SESSION_SECRET || 'dev-only-fallback-CHANGE-ME';
const SESSION_TTL_DAYS = 30;

// ── Session token helpers (HMAC-signed compact JSON) ────────────────────
function signSession(payload) {
  const exp = Math.floor(Date.now() / 1000) + SESSION_TTL_DAYS * 24 * 60 * 60;
  const body = Buffer.from(JSON.stringify({ ...payload, exp })).toString('base64url');
  const sig = crypto.createHmac('sha256', SESSION_SECRET).update(body).digest('base64url');
  return `${body}.${sig}`;
}
function verifySession(token) {
  if (typeof token !== 'string' || !token.includes('.')) return null;
  const [body, sig] = token.split('.');
  const expected = crypto.createHmac('sha256', SESSION_SECRET).update(body).digest('base64url');
  if (sig !== expected) return null;
  try {
    const obj = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (obj.exp && obj.exp < Math.floor(Date.now() / 1000)) return null;
    return obj;
  } catch { return null; }
}

// ── Apple ID token verification ─────────────────────────────────────────
async function verifyAppleIdToken(idToken) {
  const { payload } = await jwtVerify(idToken, APPLE_JWKS, {
    issuer: APPLE_ISSUER,
    audience: APPLE_BUNDLE_ID,
  });
  return payload; // { sub, email, email_verified, ... }
}

function register(app) {
  // ── POST /auth/apple/verify ──────────────────────────────────────────
  app.post('/auth/apple/verify', async (req, res) => {
    try {
      const { identityToken, fullName } = req.body || {};
      if (!identityToken) return res.status(400).json({ error: 'identityToken required' });

      const payload = await verifyAppleIdToken(identityToken);
      const id = payload.sub;
      const email = payload.email || `${id}@privaterelay.appleid.com`;
      const name = (fullName?.givenName || fullName?.familyName)
        ? `${fullName.givenName || ''} ${fullName.familyName || ''}`.trim()
        : email.split('@')[0];

      const sessionToken = signSession({ sub: id, email, name, provider: 'apple' });
      res.json({ user: { id, email, name, isGuest: false }, sessionToken });
    } catch (e) {
      console.error('apple verify failed:', e.message);
      res.status(401).json({ error: 'Apple identity token invalid: ' + e.message });
    }
  });

  // ── GET /auth/google/start ───────────────────────────────────────────
  app.get('/auth/google/start', (req, res) => {
    if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) {
      return res.status(500).send('Google OAuth not configured on backend.');
    }
    const requested = String(req.query.return || 'oneilbeats://auth/callback');
    // Restrict the post-auth redirect to known surfaces so an attacker
    // can't send a victim through this endpoint and exfiltrate their
    // session token to an arbitrary URL.
    const ALLOWED = [
      /^oneilbeats:\/\//,
      /^https:\/\/oneilbeats\.store(\/|$)/,
      /^https:\/\/www\.oneilbeats\.store(\/|$)/,
      /^https:\/\/[a-z0-9-]+\.vercel\.app(\/|$)/,
      /^http:\/\/localhost(:[0-9]+)?(\/|$)/,
    ];
    const returnTo = ALLOWED.some(re => re.test(requested)) ? requested : 'oneilbeats://auth/callback';
    // State carries the return URL HMAC-signed so the callback can trust it.
    const state = signSession({ returnTo, nonce: crypto.randomBytes(16).toString('hex') });

    const oauth = new google.auth.OAuth2(GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REDIRECT_URI);
    const url = oauth.generateAuthUrl({
      access_type: 'offline',
      prompt: 'select_account',
      scope: ['openid', 'email', 'profile'],
      state,
    });
    res.redirect(url);
  });

  // ── GET /auth/google/callback ────────────────────────────────────────
  app.get('/auth/google/callback', async (req, res) => {
    try {
      const { code, state, error: oauthErr } = req.query || {};
      if (oauthErr) return res.status(400).send(`OAuth error: ${oauthErr}`);
      if (!code || !state) return res.status(400).send('Missing code or state');
      const stateData = verifySession(String(state));
      if (!stateData?.returnTo) return res.status(400).send('Invalid state');

      const oauth = new google.auth.OAuth2(GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REDIRECT_URI);
      const { tokens } = await oauth.getToken(String(code));
      if (!tokens.id_token) return res.status(400).send('No id_token');

      // Verify the id_token (this also confirms audience = our client id).
      const ticket = await oauth.verifyIdToken({ idToken: tokens.id_token, audience: GOOGLE_CLIENT_ID });
      const p = ticket.getPayload();
      const id = p.sub;
      const email = p.email;
      const name = p.name || p.email?.split('@')[0] || 'Google User';

      const sessionToken = signSession({ sub: id, email, name, provider: 'google' });
      const returnUrl = new URL(stateData.returnTo);
      // Use hash fragment so the token isn't sent to any HTTP server hosting the deep link.
      // For a custom-scheme app, query string is fine and easier to parse with URLSearchParams.
      returnUrl.searchParams.set('session_token', sessionToken);
      returnUrl.searchParams.set('user', Buffer.from(JSON.stringify({ id, email, name })).toString('base64url'));

      res.redirect(returnUrl.toString());
    } catch (e) {
      console.error('Google OAuth callback failed:', e.message);
      res.status(500).send(`Sign-in failed: ${e.message}`);
    }
  });

  // ── (optional) GET /auth/me — verify a session token ────────────────
  app.get('/auth/me', (req, res) => {
    const auth = req.headers.authorization || '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
    if (!token) return res.status(401).json({ error: 'No bearer token' });
    const data = verifySession(token);
    if (!data) return res.status(401).json({ error: 'Invalid or expired session' });
    res.json({ user: { id: data.sub, email: data.email, name: data.name, provider: data.provider } });
  });
}

module.exports = { register, signSession, verifySession, verifyAppleIdToken };
