/**
 * Vercel Relay — Video Info Endpoint
 *
 * Gets video metadata using youtubei.js (pure JS YouTube client).
 *
 * Usage: GET /api/video-info?id=VIDEO_ID
 * Returns: { id, title, url, duration, thumbnail, author }
 */

import { Innertube, UniversalCache } from 'youtubei.js';

const RELAY_KEY = process.env.RELAY_KEY || '';

// Cache Innertube instance
let cachedYT = null;
let cachedYTTime = 0;
const CACHE_TTL = 300000; // 5 minutes

async function getInnertube() {
  const now = Date.now();
  if (cachedYT && now - cachedYTTime < CACHE_TTL) {
    return cachedYT;
  }

  console.log('[relay-video-info] initializing Innertube...');
  cachedYT = await Innertube.create({
    cache: new UniversalCache(false),
    generate_session_locally: true,
  });
  cachedYTTime = now;
  return cachedYT;
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

  if (!videoId) {
    return res.status(400).json({ error: 'Missing video ID parameter "id"' });
  }

  if (!/^[a-zA-Z0-9_-]{11}$/.test(videoId)) {
    return res.status(400).json({ error: 'Invalid video ID format' });
  }

  try {
    const yt = await getInnertube();
    const info = await yt.getInfo(videoId);

    return res.json({
      id: videoId,
      title: info.basic_info?.title || 'Unknown',
      url: `https://www.youtube.com/watch?v=${videoId}`,
      duration: info.basic_info?.duration || 0,
      thumbnail: info.basic_info?.thumbnail?.[0]?.url || `https://i.ytimg.com/vi/${videoId}/maxresdefault.jpg`,
      author: info.basic_info?.channel || 'Unknown',
      isLive: info.basic_info?.is_live || false,
    });
  } catch (err) {
    console.error('[relay-video-info] error:', err.message);
    return res.status(500).json({ error: err.message });
  }
}
