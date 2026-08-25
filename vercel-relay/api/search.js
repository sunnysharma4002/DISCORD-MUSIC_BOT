/**
 * Vercel Relay — Search Endpoint
 *
 * Searches YouTube using youtubei.js (pure JS YouTube client).
 * This bypasses YouTube IP blocks because the request comes from Vercel's IP,
 * not the bot's hosting server.
 *
 * Usage: GET /api/search?q=QUERY&limit=N
 * Returns: { results: [{ id, title, url, duration, thumbnail, author }] }
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

  console.log('[relay-search] initializing Innertube...');
  cachedYT = await Innertube.create({
    cache: new UniversalCache(false),
    generate_session_locally: true,
  });
  cachedYTTime = now;
  console.log('[relay-search] Innertube initialized');
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

  const query = req.query.q;
  const limit = parseInt(req.query.limit) || 5;

  console.log(`[relay-search] query="${query}" limit=${limit}`);

  if (!query || typeof query !== 'string') {
    return res.status(400).json({ error: 'Missing or invalid query parameter "q"' });
  }

  if (limit < 1 || limit > 20) {
    return res.status(400).json({ error: 'Limit must be between 1 and 20' });
  }

  try {
    const yt = await getInnertube();
    const results = await yt.search(query);

    if (!results.results || results.results.length === 0) {
      console.log('[relay-search] no results');
      return res.json({ results: [] });
    }

    const videos = results.results
      .filter(r => r.type === 'Video')
      .slice(0, limit)
      .map(v => ({
        id: v.id,
        title: v.title?.text || 'Unknown',
        url: `https://www.youtube.com/watch?v=${v.id}`,
        duration: v.duration?.seconds || 0,
        thumbnail: v.thumbnails?.[0]?.url || `https://i.ytimg.com/vi/${v.id}/hqdefault.jpg`,
        author: v.author?.name || 'Unknown',
        isLive: Boolean(v.is_live),
      }));

    console.log(`[relay-search] found ${videos.length} results`);
    return res.json({ results: videos });
  } catch (err) {
    console.error('[relay-search] error:', err.message);
    return res.status(500).json({ error: err.message });
  }
}
