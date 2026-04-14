/**
 * Notification Endpoints — Device registration and beat release notifications
 * Manages Expo push tokens and sends new beat notifications to subscribed users
 */

const { getSupabaseClient } = require('./supabaseApi');
const axios = require('axios');

const EXPO_API_URL = 'https://exp.host/--/api/v2/push/send';

// Store device tokens in memory (in production, use database)
// Structure: { [email]: [{ token: string, registeredAt: timestamp }] }
const deviceTokens = {};

/**
 * POST /register-device
 * Register a user's device for push notifications
 * Called on app launch if user enables notifications
 */
async function registerDevice(req, res) {
  try {
    const { expoPushToken, email } = req.body;

    if (!expoPushToken || !email) {
      return res.status(400).json({ error: 'Push token and email required' });
    }

    // Store in memory (for demo) — in production, use Supabase
    if (!deviceTokens[email]) {
      deviceTokens[email] = [];
    }

    // Avoid duplicates
    if (!deviceTokens[email].some(d => d.token === expoPushToken)) {
      deviceTokens[email].push({
        token: expoPushToken,
        registeredAt: new Date().toISOString(),
      });
    }

    console.log(`✓ Device registered for ${email}:`, expoPushToken.slice(0, 20) + '...');

    // Also persist to Supabase (optional, for analytics/debugging)
    const supabase = getSupabaseClient();
    await supabase.from('device_tokens').insert({
      email,
      expo_token: expoPushToken,
      registered_at: new Date().toISOString(),
    }).eq('email', email); // Replace if already exists

    res.json({ success: true, message: 'Device registered' });
  } catch (err) {
    console.error('Device registration error:', err);
    res.status(500).json({ error: err.message });
  }
}

/**
 * POST /unregister-device
 * Unregister a device (user disabled notifications)
 */
async function unregisterDevice(req, res) {
  try {
    const { expoPushToken, email } = req.body;

    if (!expoPushToken) {
      return res.status(400).json({ error: 'Push token required' });
    }

    // Remove from memory
    if (email && deviceTokens[email]) {
      deviceTokens[email] = deviceTokens[email].filter(d => d.token !== expoPushToken);
    }

    // Remove from Supabase
    const supabase = getSupabaseClient();
    if (email) {
      await supabase.from('device_tokens').delete().eq('expo_token', expoPushToken);
    }

    console.log(`✓ Device unregistered:`, expoPushToken.slice(0, 20) + '...');

    res.json({ success: true, message: 'Device unregistered' });
  } catch (err) {
    console.error('Device unregistration error:', err);
    res.status(500).json({ error: err.message });
  }
}

/**
 * POST /notify-beat-release
 * Send push notification to all registered devices about new beat
 * Called by admin when a new beat is published
 * Body: { beatId, beatTitle, artist, genre, coverUrl, releaseNotes }
 */
async function notifyBeatRelease(req, res) {
  try {
    const { beatId, beatTitle, artist, genre, coverUrl, releaseNotes } = req.body;

    // Validate admin access (in production, check auth token)
    const authToken = req.headers['authorization'];
    if (authToken !== `Bearer ${process.env.ADMIN_NOTIFY_TOKEN}`) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    if (!beatId || !beatTitle) {
      return res.status(400).json({ error: 'beatId and beatTitle required' });
    }

    // Get all device tokens
    const allTokens = Object.values(deviceTokens).flat().map(d => d.token);
    if (allTokens.length === 0) {
      return res.json({ success: true, message: 'No devices to notify' });
    }

    // Send notifications via Expo
    const messages = allTokens.map(token => ({
      to: token,
      sound: 'default',
      title: '🎵 New Beat Released!',
      body: `${beatTitle} by ${artist || "O'Neil"}`,
      data: {
        type: 'new_beat',
        beatId,
        beatTitle,
        artist: artist || "O'Neil",
        genre,
        coverUrl,
      },
      badge: 1,
      priority: 'high',
    }));

    // Send in batches (Expo has rate limits)
    const batchSize = 100;
    let successCount = 0;
    let failureCount = 0;

    for (let i = 0; i < messages.length; i += batchSize) {
      const batch = messages.slice(i, i + batchSize);
      try {
        const response = await axios.post(EXPO_API_URL, batch, {
          headers: {
            'Accept': 'application/json',
            'Accept-Encoding': 'gzip, deflate',
            'Content-Type': 'application/json',
          },
        });

        if (response.data) {
          response.data.forEach(result => {
            if (result.status === 'ok') {
              successCount++;
            } else {
              failureCount++;
              console.warn(`Notification failed:`, result);
            }
          });
        }
      } catch (batchErr) {
        console.error(`Batch notification error (${i}-${i + batchSize}):`, batchErr.message);
        failureCount += batch.length;
      }
    }

    console.log(`✓ Notifications sent: ${successCount} success, ${failureCount} failures`);

    res.json({
      success: true,
      message: `Notifications sent to ${successCount} devices`,
      total: allTokens.length,
      success: successCount,
      failures: failureCount,
    });
  } catch (err) {
    console.error('Beat release notification error:', err);
    res.status(500).json({ error: err.message });
  }
}

/**
 * GET /beats?since=timestamp
 * Get beats created since a timestamp (for polling/checking for new beats)
 */
async function getNewBeats(req, res) {
  try {
    const { since } = req.query;
    const since_timestamp = since ? parseInt(since) : Date.now() - 1000 * 60 * 60 * 24; // Default: last 24h

    const { fetchBeatsFromDB } = require('./supabaseApi');
    const allBeats = await fetchBeatsFromDB();

    // Filter beats created after the timestamp
    const newBeats = allBeats.filter(beat => {
      const beatTime = new Date(beat.createdAt).getTime();
      return beatTime > since_timestamp;
    });

    res.json({ success: true, beats: newBeats, count: newBeats.length });
  } catch (err) {
    console.error('Get new beats error:', err);
    res.status(500).json({ error: err.message });
  }
}

/**
 * POST /beats/:id/release
 * Mark a beat as released (published) and notify subscribers
 * Admin only
 */
async function releaseBeat(req, res) {
  try {
    const { id } = req.params;
    const { releaseNotes } = req.body;

    // Validate admin access
    const authToken = req.headers['authorization'];
    if (authToken !== `Bearer ${process.env.ADMIN_NOTIFY_TOKEN}`) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const { updateBeatInDB, fetchBeatsFromDB } = require('./supabaseApi');

    // Update beat as released
    await updateBeatInDB(id, { released: true, released_at: new Date().toISOString() });

    // Fetch beat details
    const allBeats = await fetchBeatsFromDB();
    const beat = allBeats.find(b => b.id === id);

    if (!beat) {
      return res.status(404).json({ error: 'Beat not found' });
    }

    // Send notifications
    await notifyBeatRelease({
      headers: { authorization: `Bearer ${process.env.ADMIN_NOTIFY_TOKEN}` },
      body: {
        beatId: beat.id,
        beatTitle: beat.title,
        artist: beat.artist,
        genre: beat.genre,
        coverUrl: beat.cover_art_url,
        releaseNotes: releaseNotes || '',
      },
    }, res);
  } catch (err) {
    console.error('Release beat error:', err);
    res.status(500).json({ error: err.message });
  }
}

module.exports = {
  registerDevice,
  unregisterDevice,
  notifyBeatRelease,
  getNewBeats,
  releaseBeat,
};
