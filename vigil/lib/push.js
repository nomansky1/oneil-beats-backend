'use strict';

// Web Push: how Android (and desktop browsers and iPhone home-screen apps)
// deliver notifications when the app is closed. Signed with Vigil's VAPID
// key pair (env VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY).
const webpush = require('web-push');

const configured = () => Boolean(process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY && process.env.VIGIL_CONTACT);

// -> 'sent', 'gone' (the phone dropped the subscription) or 'failed'
async function send(sub, message) {
  if (!configured()) return { status: 'failed', error: 'Push keys not configured' };
  try {
    await webpush.sendNotification(
      { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
      JSON.stringify(message),
      {
        TTL: 12 * 3600,
        urgency: 'high',
        vapidDetails: { subject: process.env.VIGIL_CONTACT, publicKey: process.env.VAPID_PUBLIC_KEY, privateKey: process.env.VAPID_PRIVATE_KEY },
      }
    );
    return { status: 'sent' };
  } catch (err) {
    if (err.statusCode === 404 || err.statusCode === 410) return { status: 'gone' };
    return { status: 'failed', error: `${err.statusCode || ''} ${err.message}`.trim() };
  }
}

module.exports = { send, configured };
