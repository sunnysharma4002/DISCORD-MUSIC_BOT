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
 * Cloudflare: forwards to target via x-relay-target header
 * Vercel: direct endpoint calls
 */
async function relayRequest(target, path, options = {}) {
  if (IS_CLOUDFLARE) {
    // Cloudflare relay: generic proxy
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
  } else {
    // Vercel relay: direct endpoint
    const url = `${RELAY_URL}${path}`;
    return fetch(url, {
      ...options,
      headers: buildRelayHeaders(),
    });
  }
}

/** Search YouTube via the relay. Returns array of video objects or null. */
export async function relaySearch(query, limit = 5) {
  if (!ENABLED) return null;

  try {
    if (IS_CLOUDFLARE) {
      // Cloudflare: proxy to YouTube search
      const targetUrl = 'https://www.youtube.com';
      const path = `/results?search_query=${encodeURIComponent(query)}&sp=EgIQAQ%253D%253D`;

      const res = await relayRequest(targetUrl, path, {
        signal: AbortSignal.timeout(10_000),
      });

      if (!res.ok) {
        const text = await res.text().catch(() => 'unknown');
        console.warn(`[relay] search HTTP ${res.status}: ${text.substring(0, 200)}`);
        return null;
      }

      const html = await res.text();
      const results = parseYouTubeSearchHTML(html);

      if (results.length === 0) {
        console.log('[relay] no search results found');
        return null;
      }

      console.log(`[relay] search via ${RELAY_TYPE}: ${results.length} results for "${query.substring(0, 40)}"`);
      return results.slice(0, limit);
    } else {
      // Vercel: direct endpoint
      const url = new URL(`${RELAY_URL}/api/search`);
      url.searchParams.set('q', query);
      url.searchParams.set('limit', String(limit));

      const res = await fetch(url.toString(), {
        headers: buildRelayHeaders(),
        signal: AbortSignal.timeout(10_000),
      });

      if (!res.ok) {
        const text = await res.text().catch(() => 'unknown');
        console.warn(`[relay] search HTTP ${res.status}: ${text.substring(0, 200)}`);
        return null;
      }

      const data = await res.json();
      if (!data.results || data.results.length === 0) return null;

      console.log(`[relay] search via ${RELAY_TYPE}: ${data.results.length} results for "${query.substring(0, 40)}"`);
      return data.results;
    }
  } catch (err) {
    console.warn(`[relay] search failed: ${err.message}`);
    return null;
  }
}

/** Fetch video metadata via the relay. Returns info object or null. */
export async function relayVideoInfo(videoId) {
  if (!ENABLED) return null;

  try {
    if (IS_CLOUDFLARE) {
      const targetUrl = 'https://www.youtube.com';
      const path = `/watch?v=${videoId}`;

      const res = await relayRequest(targetUrl, path, {
        signal: AbortSignal.timeout(8_000),
      });

      if (!res.ok) {
        const text = await res.text().catch(() => 'unknown');
        console.warn(`[relay] video-info HTTP ${res.status}: ${text.substring(0, 200)}`);
        return null;
      }

      const html = await res.text();
      const title = parseYouTubeTitle(html);
      const author = parseYouTubeAuthor(html);

      console.log(`[relay] video-info via ${RELAY_TYPE}: "${title?.substring(0, 50)}"`);
      return { title, author };
    } else {
      const url = new URL(`${RELAY_URL}/api/video-info`);
      url.searchParams.set('id', videoId);

      const res = await fetch(url.toString(), {
        headers: buildRelayHeaders(),
        signal: AbortSignal.timeout(8_000),
      });

      if (!res.ok) {
        const text = await res.text().catch(() => 'unknown');
        console.warn(`[relay] video-info HTTP ${res.status}: ${text.substring(0, 200)}`);
        return null;
      }

      const data = await res.json();
      console.log(`[relay] video-info via ${RELAY_TYPE}: "${data.title?.substring(0, 50)}"`);
      return data;
    }
  } catch (err) {
    console.warn(`[relay] video-info failed: ${err.message}`);
    return null;
  }
}

/**
 * Get a proxied audio stream URL from the relay.
 * Cloudflare: uses Invidious instances
 * Vercel: uses youtubei.js endpoint
 */
export async function relayAudioStream(videoId) {
  if (!ENABLED) return null;

  try {
    if (IS_CLOUDFLARE) {
      return await getStreamViaInvidious(videoId);
    } else {
      const url = new URL(`${RELAY_URL}/api/stream`);
      url.searchParams.set('id', videoId);
      url.searchParams.set('format', 'audio');

      const res = await fetch(url.toString(), {
        headers: buildRelayHeaders(),
        signal: AbortSignal.timeout(15_000),
      });

      if (!res.ok) {
        const text = await res.text().catch(() => 'unknown');
        console.warn(`[relay] stream HTTP ${res.status}: ${text.substring(0, 300)}`);
        return null;
      }

      const data = await res.json();
      if (!data.streamUrl) {
        console.warn(`[relay] no streamUrl in response: ${JSON.stringify(data).substring(0, 200)}`);
        return null;
      }

      console.log(`[relay] got stream URL for ${videoId} via ${RELAY_TYPE}`);
      return data.streamUrl;
    }
  } catch (err) {
    console.warn(`[relay] stream URL fetch failed: ${err.message}`);
    return null;
  }
}

/**
 * Get audio stream URL via Invidious instances (for Cloudflare relay).
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

      const audioFormats = (data.adaptiveFormats || data.formatStreams || [])
        .filter(f => f.type?.includes('audio') && f.url);

      if (audioFormats.length > 0) {
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
