/**
 * Vercel Relay — Audio Streaming Endpoint
 *
 * Gets YouTube audio URLs using youtubei.js (pure JS YouTube client).
 * This bypasses YouTube IP blocks because the request comes from Vercel's IP,
 * not the bot's hosting server.
 *
 * Usage: GET /api/stream?id=VIDEO_ID
 * Returns: { streamUrl: "https://..." }
 *
 * The returned streamUrl can be used directly by the bot for audio streaming.
 */

import { Innertube, UniversalCache } from 'youtubei.js';

const RELAY_KEY = process.env.RELAY_KEY || '';

// Cache Innertube instance to avoid re-initialization
let cachedYT = null;
let cachedYTTime = 0;
const CACHE_TTL = 300000; // 5 minutes

async function getInnertube() {
  const now = Date.now();
  if (cachedYT && now - cachedYTTime < CACHE_TTL) {
    return cachedYT;
  }

  console.log('[relay-stream] initializing Innertube...');
  cachedYT = await Innertube.create({
    cache: new UniversalCache(false),
    generate_session_locally: true,
  });
  cachedYTTime = now;
  console.log('[relay-stream] Innertube initialized');
  return cachedYT;
}

/**
 * Get audio stream URL for a YouTube video using youtubei.js.
 * Returns the direct audio URL or null on failure.
 */
async function getYouTubeAudioUrl(videoId) {
  const yt = await getInnertube();

  const info = await yt.getInfo(videoId);

  // Get streaming data (audio formats)
  const streamingData = info.streaming_data;
  if (!streamingData) {
    throw new Error('No streaming data available');
  }

  // Prefer audio formats (adaptive formats are usually better quality)
  const audioFormats = streamingData.adaptive_formats?.filter(f =>
    f.has_audio && f.url
  ) || [];

  if (audioFormats.length === 0) {
    // Fallback to regular formats
    const regularFormats = streamingData.formats?.filter(f =>
      f.has_audio && f.url
    ) || [];
    if (regularFormats.length === 0) {
      throw new Error('No audio formats available');
    }
    // Pick the first available audio format
    return {
      url: regularFormats[0].url,
      mimeType: regularFormats[0].mime_type,
      bitrate: regularFormats[0].bitrate,
    };
  }

  // Sort by bitrate (prefer higher quality)
  audioFormats.sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));

  // Pick the best audio format
  const best = audioFormats[0];

  return {
    url: best.url,
    mimeType: best.mime_type,
    bitrate: best.bitrate,
  };
}

export default async function handler(req, res) {
  // Basic auth check
  if (RELAY_KEY) {
    const providedKey = req.headers['x-relay-key'];
    if (providedKey !== RELAY_KEY) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
  }

  const videoId = req.query.id;

  console.log(`[relay-stream] videoId="${videoId}"`);

  if (!videoId || typeof videoId !== 'string') {
    return res.status(400).json({ error: 'Missing video ID parameter "id"' });
  }

  // Validate video ID format (11 characters, YouTube video IDs)
  if (!/^[a-zA-Z0-9_-]{11}$/.test(videoId)) {
    return res.status(400).json({ error: 'Invalid video ID format (must be 11 characters)' });
  }

  try {
    // Use youtubei.js to get the audio URL
    const audioInfo = await getYouTubeAudioUrl(videoId);

    console.log(`[relay-stream] got audio URL for ${videoId}`);

    // Return the direct audio URL
    // The bot will stream this URL directly
    // This bypasses IP blocks because youtubei.js runs on Vercel, not the bot's server
    return res.json({
      streamUrl: audioInfo.url,
      mimeType: audioInfo.mimeType || 'audio/mp4',
      bitrate: audioInfo.bitrate,
      source: 'youtube',
    });

  } catch (err) {
    console.error('[relay-stream] error:', err.message);
    return res.status(500).json({ error: err.message });
  }
}
