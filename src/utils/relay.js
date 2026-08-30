/**
 * Unified Relay client — routes YouTube HTTP requests through Cloudflare or Vercel
 * so YouTube sees the relay's edge IPs instead of the bot's hosting IP.
 *
 * Uses the 9router pattern: generic proxy relay with x-relay-target header.
 * Covers: search queries, video metadata, AND audio streaming.
 */

const CLOUDFLARE_RELAY_URL = (process.env.CLOUDFLARE_RELAY_URL || '').replace(/\/+$/, '');
const CLOUDFLARE_RELAY_KEY = process.env.CLOUDFLARE_RELAY_KEY || '';
const VERCEL_RELAY_URL = (process.env.VERCEL_RELAY_URL || '').replace(/\/+$/, '');
const VERCEL_RELAY_KEY = process.env.VERCEL_RELAY_KEY || '';

// Prefer Cloudflare, fallback to Vercel
const RELAY_URL = CLOUDFLARE_RELAY_URL || VERCEL_RELAY_URL;
const RELAY_KEY = CLOUDFLARE_RELAY_KEY || VERCEL_RELAY_KEY;
const RELAY_TYPE = CLOUDFLARE_RELAY_URL ? 'cloudflare' : VERCEL_RELAY_URL ? 'vercel' : 'none';
const IS_CLOUDFLARE = Boolean(CLOUDFLARE_RELAY_URL);
const ENABLED = Boolean(RELAY_URL);

if (ENABLED) {
  console.log(`[relay] ${RELAY_TYPE} relay enabled: ${RELAY_URL}`);
} else {
  console.log('[relay] relay disabled (set CLOUDFLARE_RELAY_URL or VERCEL_RELAY_URL to enable)');
}

/** Build relay request headers. */
function buildRelayHeaders() {
  const headers = { 'Content-Type': 'application/json' };
  if (RELAY_KEY) headers['X-Relay-Key'] = RELAY_KEY;
  return headers;
}

/**
 * Make a relay request.
 * Both Cloudflare and Vercel relays use the generic proxy pattern with x-relay-target header.
 */
async function relayRequest(target, path, options = {}) {
  const url = `${RELAY_URL}${path}`;
  const res = await fetch(url, {
    ...options,
    headers: {
      ...buildRelayHeaders(),
      'x-relay-target': target,
      'x-relay-path': path,
    },
  });
  return res;
}

/** Search YouTube via the relay. Returns array of video objects or null. */
export async function relaySearch(query, limit = 5) {
  if (!ENABLED) return null;

  try {
    // Generic proxy relay: forward to YouTube search page
    const targetUrl = 'https://www.youtube.com';
    const path = `/results?search_query=${encodeURIComponent(query)}&sp=EgIQAQ%253D%253D`;

    const pRes = await relayRequest(targetUrl, path, {
      signal: AbortSignal.timeout(10_000),
    });

    if (pRes.ok) {
      const html = await pRes.text();
      const results = parseYouTubeSearchHTML(html);
      if (results.length > 0) {
        console.log(`[relay] search via ${RELAY_TYPE}: ${results.length} results for "${query.substring(0, 40)}"`);
        return results.slice(0, limit);
      }
    } else {
      const text = await pRes.text().catch(() => 'unknown');
      console.warn(`[relay] search HTTP ${pRes.status}: ${text.substring(0, 200)}`);
    }

    return null;
  } catch (err) {
    console.warn(`[relay] search failed: ${err.message}`);
    return null;
  }
}

/** Fetch video metadata via the relay. Returns info object or null. */
export async function relayVideoInfo(videoId) {
  if (!ENABLED) return null;

  try {
    const targetUrl = 'https://www.youtube.com';
    const path = `/watch?v=${videoId}`;

    const pRes = await relayRequest(targetUrl, path, {
      signal: AbortSignal.timeout(8_000),
    });

    if (pRes.ok) {
      const html = await pRes.text();
      const title = parseYouTubeTitle(html);
      const author = parseYouTubeAuthor(html);
      console.log(`[relay] video-info via ${RELAY_TYPE}: "${title?.substring(0, 50)}"`);
      return { id: videoId, title, author };
    } else {
      const text = await pRes.text().catch(() => 'unknown');
      console.warn(`[relay] video-info HTTP ${pRes.status}: ${text.substring(0, 200)}`);
    }

    return null;
  } catch (err) {
    console.warn(`[relay] video-info failed: ${err.message}`);
    return null;
  }
}

/**
 * Get a proxied audio stream URL from the relay.
 * Uses the generic proxy pattern with x-relay-target header.
 * Forwards Innertube player API POST requests through the relay.
 */
export async function relayAudioStream(videoId) {
  if (!ENABLED) return null;

  try {
    const targetUrl = 'https://www.youtube.com';
    const path = `/youtubei/v1/player`;

    const playerRequestBody = {
      context: {
        client: {
          clientName: 'WEB',
          clientVersion: '2.20240111.09.00',
        },
      },
      videoId: videoId,
    };

    const pRes = await relayRequest(targetUrl, path, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-relay-target': targetUrl,
        'x-relay-path': path,
      },
      body: JSON.stringify(playerRequestBody),
      signal: AbortSignal.timeout(15_000),
    });

    if (!pRes.ok) {
      const text = await pRes.text().catch(() => 'unknown');
      console.warn(`[relay] stream HTTP ${pRes.status}: ${text.substring(0, 300)}`);
      return null;
    }

    const data = await pRes.json();
    const formats = data?.streamingData?.adaptiveFormats || [];
    const audioFormats = formats.filter((f) => f.audioQuality && f.url);

    if (audioFormats.length === 0) {
      console.warn(`[relay] no audio formats in response for ${videoId}`);
      return null;
    }

    // Prefer Opus, then highest bitrate
    const opus = audioFormats.filter((f) => /opus/i.test(f.mimeType));
    const best = (opus.length ? opus : audioFormats).sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0))[0];

    console.log(`[relay] got stream URL for ${videoId} via ${RELAY_TYPE}: ${best.mimeType || 'audio'} ${best.bitrate ? `${Math.round(best.bitrate/1000)}kbps` : ''}`);
    return best.url;
  } catch (err) {
    console.warn(`[relay] stream URL fetch failed: ${err.message}`);
    return null;
  }
}

/** Parse YouTube search results from HTML. */
function parseYouTubeSearchHTML(html) {
  const results = [];

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
  return RELAY_TYPE;
}
