import { YouTube } from 'youtube-sr';

const RELAY_KEY = process.env.RELAY_KEY || '';

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

  if (!query) {
    return res.status(400).json({ error: 'Missing query parameter "q"' });
  }

  try {
    const results = await YouTube.search(query, { limit, type: 'video', safeSearch: false });

    if (!Array.isArray(results) || results.length === 0) {
      return res.json({ results: [] });
    }

    const videos = results.map(v => ({
      id: v.id,
      title: v.title,
      url: v.url,
      duration: v.duration,
      thumbnail: v.thumbnail?.url || `https://i.ytimg.com/vi/${v.id}/hqdefault.jpg`,
      author: v.channel?.name || 'Unknown',
      isLive: Boolean(v.live),
    }));

    return res.json({ results: videos });
  } catch (err) {
    console.error('[vercel-relay] search error:', err.message);
    return res.status(500).json({ error: err.message });
  }
}
