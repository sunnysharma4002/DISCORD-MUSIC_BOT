/**
 * Vercel Relay client — routes YouTube HTTP requests through a Vercel deployment
 * so YouTube sees Vercel's edge IPs instead of the bot's hosting IP.
 *
 * Covers: search queries, video metadata lookups.
 * NOT covered: audio streaming (yt-dlp subprocess — use YTDLP_PROXIES for that).
 */

const RELAY_URL = (process.env.VERCEL_RELAY_URL || '').replace(/\/+$/, '');
const RELAY_KEY = process.env.VERCEL_RELAY_KEY || '';
const ENABLED = Boolean(RELAY_URL);

if (ENABLED) {
  console.log(`[relay] Vercel relay enabled: ${RELAY_URL}`);
}

/** Search YouTube via the Vercel relay. Returns array of video objects or null. */
export async function relaySearch(query, limit = 5) {
  if (!ENABLED) return null;

  try {
    const url = new URL(`${RELAY_URL}/api/search`);
    url.searchParams.set('q', query);
    url.searchParams.set('limit', String(limit));

    const headers = { 'Content-Type': 'application/json' };
    if (RELAY_KEY) headers['X-Relay-Key'] = RELAY_KEY;

    const res = await fetch(url.toString(), { headers, signal: AbortSignal.timeout(10_000) });
    if (!res.ok) {
      console.warn(`[relay] search HTTP ${res.status}`);
      return null;
    }

    const data = await res.json();
    if (!data.results || data.results.length === 0) return null;

    console.log(`[relay] search via Vercel: ${data.results.length} results for "${query.substring(0, 40)}"`);
    return data.results;
  } catch (err) {
    console.warn(`[relay] search failed: ${err.message}`);
    return null;
  }
}

/** Fetch video metadata via the Vercel relay. Returns info object or null. */
export async function relayVideoInfo(videoId) {
  if (!ENABLED) return null;

  try {
    const url = new URL(`${RELAY_URL}/api/video-info`);
    url.searchParams.set('id', videoId);

    const headers = { 'Content-Type': 'application/json' };
    if (RELAY_KEY) headers['X-Relay-Key'] = RELAY_KEY;

    const res = await fetch(url.toString(), { headers, signal: AbortSignal.timeout(8_000) });
    if (!res.ok) {
      console.warn(`[relay] video-info HTTP ${res.status}`);
      return null;
    }

    const data = await res.json();
    console.log(`[relay] video-info via Vercel: "${data.title?.substring(0, 50)}"`);
    return data;
  } catch (err) {
    console.warn(`[relay] video-info failed: ${err.message}`);
    return null;
  }
}

export function isRelayEnabled() {
  return ENABLED;
}
