/**
 * Vercel Relay — Audio Streaming Endpoint
 *
 * Proxies YouTube audio streams through Vercel's edge network.
 * Uses Invidious instances to bypass YouTube IP blocks.
 *
 * Usage: GET /api/stream?id=VIDEO_ID
 * Returns: { streamUrl: "https://..." }
 *
 * The returned streamUrl can be used directly by the bot for audio streaming.
 */

// List of public Invidious instances (YouTube frontends that bypass IP blocks)
const INVIDIOUS_INSTANCES = [
  'https://invidious.fdn.fr',
  'https://invidious.io.lol',
  'https://yewtu.be',
  'https://inv.tux.pizza',
  'https://vid.puffyan.us',
  'https://invidious.flokinet.to',
];

const RELAY_KEY = process.env.RELAY_KEY || '';

export default async function handler(req, res) {
  // Basic auth check
  if (RELAY_KEY) {
    const providedKey = req.headers['x-relay-key'];
    if (providedKey !== RELAY_KEY) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
  }

  const videoId = req.query.id;

  if (!videoId) {
    return res.status(400).json({ error: 'Missing video ID' });
  }

  // Validate video ID format (11 characters)
  if (!/^[a-zA-Z0-9_-]{11}$/.test(videoId)) {
    return res.status(400).json({ error: 'Invalid video ID' });
  }

  try {
    // Try each Invidious instance until one works
    let streamData = null;
    let lastError = null;

    for (const instance of INVIDIOUS_INSTANCES) {
      try {
        const url = `${instance}/api/v1/videos/${videoId}`;
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 8000);

        const response = await fetch(url, {
          signal: controller.signal,
          headers: { 'User-Agent': 'Mozilla/5.0' },
        });

        clearTimeout(timeout);

        if (!response.ok) continue;

        const data = await response.json();

        // Find the best audio format (prefer mp4 audio, then webm)
        const formatStreams = data.formatStreams || [];
        const adaptiveFormats = data.adaptiveFormats || [];

        // Look for audio-only streams (no video)
        const audioStream = adaptiveFormats.find(f =>
          f.type?.includes('audio') && f.url
        ) || formatStreams.find(f =>
          f.type?.includes('audio') && f.url
        );

        if (audioStream && audioStream.url) {
          streamData = audioStream;
          console.log(`[relay] found audio stream via ${instance}`);
          break;
        }
      } catch (err) {
        lastError = err.message;
        continue;
      }
    }

    if (!streamData) {
      return res.status(404).json({
        error: 'Could not find audio stream',
        details: lastError || 'All Invidious instances failed'
      });
    }

    // Return the stream URL - the bot will use this directly
    // Invidious URLs are not IP-restricted like YouTube's
    return res.json({
      streamUrl: streamData.url,
      mimeType: streamData.type || 'audio/mp4',
      bitrate: streamData.bitrate,
      container: streamData.container,
      source: 'invidious',
    });

  } catch (err) {
    console.error('[relay] stream error:', err.message);
    return res.status(500).json({ error: err.message });
  }
}
