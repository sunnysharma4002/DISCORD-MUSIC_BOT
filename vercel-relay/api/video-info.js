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

  const videoId = req.query.id;

  if (!videoId) {
    return res.status(400).json({ error: 'Missing query parameter "id"' });
  }

  try {
    const video = await YouTube.getVideo(`https://www.youtube.com/watch?v=${videoId}`);

    if (!video) {
      return res.status(404).json({ error: 'Video not found' });
    }

    return res.json({
      id: video.id,
      title: video.title,
      url: video.url,
      duration: video.duration,
      thumbnail: video.thumbnail?.url || `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
      author: video.channel?.name || 'Unknown',
      isLive: Boolean(video.live),
    });
  } catch (err) {
    console.error('[vercel-relay] video-info error:', err.message);
    return res.status(500).json({ error: err.message });
  }
}
