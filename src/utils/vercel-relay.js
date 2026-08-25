/**
 * Cloudflare Relay client — routes YouTube HTTP requests through Cloudflare Workers
 * so YouTube sees Cloudflare's edge IPs instead of the bot's hosting IP.
 *
 * Uses the 9router pattern: generic proxy relay with x-relay-target header.
 * Covers: search queries, video metadata, AND audio streaming.
 */

const RELAY_URL = (process.env.CLOUDFLARE_RELAY_URL || '').replace(/\/+$/, '');
const RELAY_KEY = process.env.CLOUDFLARE_RELAY_KEY || '';
const ENABLED = Boolean(RELAY_URL);

if (ENABLED) {
  console.log(`[relay] Cloudflare relay enabled: ${RELAY_URL}`);
} else {
  console.log('[relay] Cloudflare relay disabled (set CLOUDFLARE_RELAY_URL to enable)');
}

/** Build relay request headers. */
function buildRelayHeaders() {
  const headers = { 'Content-Type': 'application/json' };
  if (RELAY_KEY) headers['X-Relay-Key'] = RELAY_KEY;
  return headers;
}

/** Search YouTube via the Cloudflare relay. Returns array of video objects or null. */
export async function relaySearch(query, limit = 5) {
  if (!ENABLED) return null;

  try {
    const targetUrl = 'https://www.youtube.com';
    const path = `/results?search_query=${encodeURIComponent(query)}&sp=EgIQAQ%3D%3D`;

    const res = await fetch(`${RELAY_URL}${path}`, {
      headers: {
        ...buildRelayHeaders(),
        'x-relay-target': targetUrl,
        'x-relay-path': path,
      },
      signal: AbortSignal.timeout(10_000),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => 'unknown');
      console.warn(`[relay] search HTTP ${res.status}: ${text.substring(0, 200)}`);
      return null;
    }

    // Parse YouTube search results from HTML
    const html = await res.text();
    const results = parseYouTubeSearchHTML(html);

    if (results.length === 0) {
      console.log('[relay] no search results found');
      return null;
    }

    console.log(`[relay] search via Cloudflare: ${results.length} results for "${query.substring(0, 40)}"`);
    return results.slice(0, limit);
  } catch (err) {
    console.warn(`[relay] search failed: ${err.message}`);
    return null;
  }
}

/** Fetch video metadata via the Cloudflare relay. Returns info object or null. */
export async function relayVideoInfo(videoId) {
  if (!ENABLED) return null;

  try {
    const targetUrl = 'https://www.youtube.com';
    const path = `/watch?v=${videoId}`;

    const res = await fetch(`${RELAY_URL}${path}`, {
      headers: {
        ...buildRelayHeaders(),
        'x-relay-target': targetUrl,
        'x-relay-path': path,
      },
      signal: AbortSignal.timeout(8_000),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => 'unknown');
      console.warn(`[relay] video-info HTTP ${res.status}: ${text.substring(0, 200)}`);
      return null;
    }

    // Parse basic info from HTML
    const html = await res.text();
    const title = parseYouTubeTitle(html);
    const author = parseYouTubeAuthor(html);

    console.log(`[relay] video-info via Cloudflare: "${title?.substring(0, 50)}"`);
    return { title, author };
  } catch (err) {
    console.warn(`[relay] video-info failed: ${err.message}`);
    return null;
  }
}

/**
 * Get a proxied audio stream URL from the Cloudflare relay.
 * Uses Invidious instances to get direct audio URLs.
 */
export async function relayAudioStream(videoId) {
  if (!ENABLED) return null;

  try {
    return await getStreamViaInvidious(videoId);
  } catch (err) {
    console.warn(`[relay] stream URL fetch failed: ${err.message}`);
    return null;
  }
}

/**
 * Get audio stream URL via Invidious instances.
 * Invidious is a privacy frontend for YouTube that provides direct stream URLs.
 */
async function getStreamViaInvidious(videoId) {
  const instances = [
    'https://invidious.fdn.fr',
    'https://yewtu.be',
    'https://inv.tux.pizza',
    'https://vid.puffyan.us',
    'https://invidious.privacydev.net',
    'https://iv.ggtyler.dev',
  ];

  for (const instance of instances) {
    try {
      const url = `${instance}/api/v1/videos/${videoId}`;
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5000);

      const res = await fetch(url, {
        signal: controller.signal,
        headers: { 'User-Agent': 'Mozilla/5.0' },
      });

      clearTimeout(timeout);

      if (!res.ok) continue;

      const data = await res.json();

      if (data.error) continue;

      // Find audio format
      const audioFormats = (data.adaptiveFormats || data.formatStreams || [])
        .filter(f => f.type?.includes('audio') && f.url);

      if (audioFormats.length > 0) {
        // Sort by bitrate
        audioFormats.sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));
        const best = audioFormats[0];

        console.log(`[relay] got Invidious stream via ${instance}`);
        return best.url;
      }
    } catch (err) {
      continue;
    }
  }

  console.warn('[relay] all Invidious instances failed');
  return null;
}

/** Parse YouTube search results from HTML (basic extraction). */
function parseYouTubeSearchHTML(html) {
  const results = [];

  // Extract video data from ytInitialData
  const dataMatch = html.match(/var ytInitialData\s*=\s*({.+?});<\/script>/);
  if (!dataMatch) return results;

  try {
    const data = JSON.parse(dataMatch[1]);
    const contents = data?.contents?.twoColumnSearchResultsRenderer?.primaryContents?.sectionListRenderer?.contents;

    if (!contents) return results;

    for (const section of contents) {
      const items = section?.itemSectionRenderer?.contents || [];
      for (const item of items) {
        const video = item?.videoRenderer;
        if (!video) continue;

        const videoId = video?.videoId;
        if (!videoId) continue;

        results.push({
          id: videoId,
          title: video?.title?.runs?.[0]?.text || 'Unknown',
          url: `https://www.youtube.com/watch?v=${videoId}`,
          duration: video?.lengthText?.simpleText || 0,
          thumbnail: video?.thumbnail?.thumbnails?.[0]?.url || `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
          author: video?.ownerText?.runs?.[0]?.text || 'Unknown',
          isLive: Boolean(video?.badges?.some(b => b?.liveBadgeText)),
        });
      }
    }
  } catch (e) {
    console.warn('[relay] failed to parse YouTube search HTML:', e.message);
  }

  return results;
}

/** Parse video title from YouTube watch page HTML. */
function parseYouTubeTitle(html) {
  const match = html.match(/"title":\s*{"runs":\[{"text":"([^"]+)"/);
  if (match) return match[1];

  const altMatch = html.match(/<title>([^<]+)- YouTube/);
  if (altMatch) return altMatch[1].trim();

  return null;
}

/** Parse video author from YouTube watch page HTML. */
function parseYouTubeAuthor(html) {
  const match = html.match(/"ownerText":\s*{"runs":\[{"text":"([^"]+)"/);
  if (match) return match[1];

  return null;
}

export function isRelayEnabled() {
  return ENABLED;
}

export function getRelayType() {
  return 'cloudflare';
}
