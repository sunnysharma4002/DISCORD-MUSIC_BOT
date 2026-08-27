import { Innertube, Log, Platform, UniversalCache } from 'youtubei.js';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { getCookieHeader } from './cookies.js';
import { generatePoToken } from './potoken.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = dirname(dirname(__dirname));
const cacheDir = join(projectRoot, '.cache', 'youtubei');

import { existsSync, readdirSync, rmSync } from 'node:fs';

let ytInstance = null;
let ytReady = false;
let _buildPromise = null;
let _refreshTimer = null;
let _refreshing = false;
let _sessionCreatedAt = 0;

/**
 * How often to re-mint the PoToken and rebuild the session.
 * YouTube's tokens last roughly 6 hours; refreshing at 3 keeps us comfortably inside that.
 * Override with YOUTUBE_REFRESH_HOURS.
 */
const SESSION_REFRESH_MS = (() => {
  const hours = Number(process.env.YOUTUBE_REFRESH_HOURS);
  return Number.isFinite(hours) && hours > 0 ? hours * 3_600_000 : 3 * 3_600_000;
})();

/**
 * InnerTube clients to try, in order, when resolving an audio stream.
 * Configurable via YOUTUBE_CLIENTS (comma-separated).
 *
 * Order matters, and it is driven by which clients produce stream URLs that actually SERVE
 * BYTES — not just which ones return metadata. Verified against a real cookie jar:
 *
 *   VISIONOS / IOS / ANDROID_VR → stream URL returns HTTP 206, plays to completion
 *   MWEB / WEB                  → metadata OK, but the stream URL returns HTTP 403 on the
 *                                 ranged chunk fetch (these clients need a PoToken for
 *                                 playback), which truncates long tracks mid-song
 *
 * So mobile clients lead. MWEB/WEB stay as a fallback because they're the only ones that
 * return metadata for age-restricted videos when cookies are present.
 *
 * Valid: VISIONOS, IOS, ANDROID_VR, MWEB, WEB, WEB_CREATOR, ANDROID, TV_EMBEDDED, WEB_EMBEDDED
 */
const STREAM_CLIENTS = (process.env.YOUTUBE_CLIENTS?.trim()
  ? process.env.YOUTUBE_CLIENTS.split(',').map((s) => s.trim()).filter(Boolean)
  : ['VISIONOS', 'IOS', 'ANDROID_VR', 'MWEB', 'WEB', 'WEB_CREATOR']);

/** Kept for the metadata helpers below. */
const NO_POTOKEN_CLIENTS = STREAM_CLIENTS;

/**
 * Playability statuses that mean the video itself is unplayable — no extractor will help.
 *
 * NOTE: LOGIN_REQUIRED is deliberately NOT here. YouTube returns it for two very different
 * reasons and only the reason text tells them apart:
 *   - "Sign in to confirm you're not a bot"  → datacenter IP block, transient, yt-dlp may work
 *   - "Sign in to confirm your age" / private → genuinely gated, nothing will work
 * See isPermanentFailure() below.
 */
const PERMANENT_FAILURES = new Set([
  'AGE_CHECK_REQUIRED',
  'CONTENT_CHECK_REQUIRED',
  'UNPLAYABLE',
  'LIVE_STREAM_OFFLINE',
]);

/** Reason substrings that mean "this is an IP/bot block", not a property of the video. */
const BOT_CHECK_PATTERN = /not a bot|confirm you.re not|unusual traffic/i;

/**
 * Decide whether a playability status is worth giving up on entirely.
 * @param {string} status
 * @param {string} [reason]
 */
function isPermanentFailure(status, reason = '') {
  if (PERMANENT_FAILURES.has(status)) return true;
  if (status === 'LOGIN_REQUIRED') {
    // Bot check → transient (IP-based), let yt-dlp try. Anything else → genuinely gated.
    return !BOT_CHECK_PATTERN.test(reason);
  }
  return false;
}

/**
 * Build a fresh InnerTube client with an auto-minted PoToken.
 *
 * A PoToken must be bound to the visitor_data of the session that uses it, so the order is:
 *   1. create a throwaway client to obtain visitor_data
 *   2. mint a PoToken bound to it
 *   3. create the real client with both
 *
 * If minting fails we still return a usable (token-less) client — better degraded than dead.
 */
async function buildInnertube() {
  const cookie = getCookieHeader();

  // Explicit env values win, so a known-good pair can be pinned if ever needed.
  const envPoToken = process.env.YOUTUBE_PO_TOKEN?.trim() || undefined;
  const envVisitorData = process.env.YOUTUBE_VISITOR_DATA?.trim() || undefined;

  if (envPoToken && envVisitorData) {
    const yt = await Innertube.create({
      cache: new UniversalCache(true, cacheDir),
      cookie,
      po_token: envPoToken,
      visitor_data: envVisitorData,
    });
    console.log('[youtube] using pinned YOUTUBE_PO_TOKEN / YOUTUBE_VISITOR_DATA from env');
    return yt;
  }

  // Step 1 — a bare client just to get session visitor_data.
  const seed = await Innertube.create({
    cache: new UniversalCache(true, cacheDir),
    cookie,
    retrieve_player: false,
  });

  const visitorData = envVisitorData ?? seed.session.context.client.visitorData;
  if (!visitorData) {
    console.warn('[youtube] no visitor_data available; continuing without a PoToken');
    return Innertube.create({ cache: new UniversalCache(true, cacheDir), cookie });
  }

  // Step 2 — mint a PoToken bound to that visitor_data.
  let poToken;
  try {
    const t0 = Date.now();
    poToken = await generatePoToken(visitorData);
    console.log(`[youtube] minted PoToken (${poToken.length} chars) in ${Date.now() - t0}ms`);
  } catch (err) {
    console.warn(`[youtube] PoToken generation failed: ${err.message}`);
    console.warn('[youtube] continuing without a PoToken — expect LOGIN_REQUIRED on some videos');
  }

  // Step 3 — the real client.
  return Innertube.create({
    cache: new UniversalCache(true, cacheDir),
    cookie,
    po_token: poToken,
    visitor_data: visitorData,
  });
}

/**
 * Initialize the YouTube InnerTube client.
 * Cookies are read from the yt-cookies.txt jar (see src/utils/cookies.js), not from env.
 * A PoToken is minted automatically and refreshed on a timer (see startSessionRefresh).
 */
async function getYouTube() {
  if (ytInstance && ytReady) return ytInstance;

  // Concurrent callers during startup must share one build, not race three of them.
  if (_buildPromise) return _buildPromise;

  Log.setLevel(Log.Level.ERROR);

  // youtubei.js needs a JS runtime for signature/n-param deciphering.
  // Provide Node's Function constructor as the eval shim.
  Platform.shim.eval = (data, env = {}) => {
    const names = Object.keys(env);
    const fn = new Function(...names, data.output);
    return fn(...names.map((name) => env[name]));
  };

  _buildPromise = (async () => {
    try {
      const yt = await buildInnertube();
      ytInstance = yt;
      ytReady = true;
      _sessionCreatedAt = Date.now();
      const hasToken = Boolean(yt.session?.po_token);
      console.log(
        `[youtube] InnerTube client ready (cookies=${getCookieHeader() ? 'yes' : 'no'}, ` +
        `poToken=${hasToken ? 'yes' : 'no'}, clients: ${STREAM_CLIENTS.join(' > ')})`,
      );
      startSessionRefresh();
      return yt;
    } finally {
      _buildPromise = null;
    }
  })();

  return _buildPromise;
}

/**
 * Rebuild the session in place with a freshly minted PoToken.
 *
 * Safe to call mid-playback: already-open streams hold their own deciphered URLs and keep
 * running. Only subsequent createStream() calls use the new session. The InnerTube cache is
 * NOT cleared — clearing it forces a player re-download for no benefit.
 */
export async function refreshSession(reason = 'timer') {
  if (_refreshing) {
    console.log('[youtube] refresh already in progress, skipping');
    return ytInstance;
  }
  _refreshing = true;

  try {
    console.log(`[youtube] refreshing session (${reason})...`);
    const next = await buildInnertube();
    ytInstance = next;
    ytReady = true;
    _sessionCreatedAt = Date.now();
    console.log(`[youtube] session refreshed (poToken=${next.session?.po_token ? 'yes' : 'no'})`);
    return next;
  } catch (err) {
    console.error(`[youtube] session refresh failed: ${err.message}`);
    return ytInstance; // keep the old session rather than going dark
  } finally {
    _refreshing = false;
  }
}

/** Starts the periodic refresh timer. Idempotent. */
export function startSessionRefresh() {
  if (_refreshTimer) return;

  _refreshTimer = setInterval(() => {
    refreshSession('scheduled').catch((err) => {
      console.error(`[youtube] scheduled refresh threw: ${err.message}`);
    });
  }, SESSION_REFRESH_MS);

  // Don't hold the event loop open on shutdown.
  if (typeof _refreshTimer.unref === 'function') _refreshTimer.unref();

  const hours = (SESSION_REFRESH_MS / 3_600_000).toFixed(1);
  console.log(`[youtube] session auto-refresh every ${hours}h`);
}

/** Stops the periodic refresh timer. */
export function stopSessionRefresh() {
  if (_refreshTimer) {
    clearInterval(_refreshTimer);
    _refreshTimer = null;
  }
}

/** Age of the current session in milliseconds. */
export function getSessionAgeMs() {
  return _sessionCreatedAt ? Date.now() - _sessionCreatedAt : 0;
}

export async function resetYouTubeSession() {
  console.log('[youtube] resetting youtubei.js session...');
  try { rmSync(cacheDir, { recursive: true, force: true }); } catch {}
  ytInstance = null;
  ytReady = false;
}

/** Search YouTube and return up to `limit` video results. */
export async function search(query, limit = 5) {
  const yt = await getYouTube();

  try {
    const results = await yt.search(query, { type: 'video' });
    const items = results.videos || results.results || [];
    const videos = [];

    for (const item of items) {
      const id = item.id || item.video_id;
      if (!id) continue;
      videos.push({
        id,
        title: item.title?.text || item.title || 'Unknown',
        url: `https://www.youtube.com/watch?v=${id}`,
        duration: item.duration?.seconds || 0,
        thumbnail: item.thumbnails?.[0]?.url || `https://i.ytimg.com/vi/${id}/hqdefault.jpg`,
        author: item.author?.name || item.author?.text || 'Unknown',
        isLive: Boolean(item.is_live),
      });
      if (videos.length >= limit) break;
    }

    if (videos.length > 0) {
      console.log(`[youtube] search OK: ${videos.length} results for "${query.substring(0, 40)}"`);
      return videos;
    }
  } catch (err) {
    console.warn(`[youtube] search failed for "${query.substring(0, 40)}": ${err.message}`);
  }
  return [];
}

/**
 * Get video metadata (title, author, duration, thumbnail).
 * Returns null if the video cannot be loaded.
 */
export async function getVideoInfo(videoId) {
  const yt = await getYouTube();
  let lastError = null;

  for (const client of NO_POTOKEN_CLIENTS) {
    try {
      const info = await yt.getBasicInfo(videoId, { client });
      const basic = info.basic_info ?? {};
      if (!basic.title) continue;

      return {
        id: basic.id ?? videoId,
        title: basic.title,
        author: basic.author ?? basic.channel?.name ?? 'Unknown',
        duration: basic.duration ?? 0,
        thumbnail: basic.thumbnail?.[0]?.url ?? `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
        isLive: Boolean(basic.is_live),
      };
    } catch (err) {
      lastError = err;
    }
  }

  console.warn(`[youtube] getVideoInfo failed for ${videoId}: ${lastError?.message ?? 'all clients failed'}`);
  return null;
}

/**
 * Get a direct audio stream URL for a video.
 * Tries multiple InnerTube clients (no po_token needed) and returns the best audio format URL.
 * Returns null if no stream URL can be obtained.
 */
export async function getStreamUrl(videoId) {
  const yt = await getYouTube();
  let lastError = null;

  for (const client of NO_POTOKEN_CLIENTS) {
    try {
      const info = await yt.getBasicInfo(videoId, { client });

      const status = info.playability_status?.status;
      if (status && status !== 'OK') {
        console.debug(`[youtube] ${client} not playable: ${status}`);
        continue;
      }

      const formats = (info.streaming_data?.adaptive_formats ?? [])
        .filter((f) => f.has_audio && !f.has_video && f.url && !f.drm_families?.length);

      if (formats.length === 0) {
        console.debug(`[youtube] ${client} no audio formats for ${videoId}`);
        continue;
      }

      // Prefer Opus (no transcoding), then highest bitrate
      const opus = formats.filter((f) => /webm/i.test(f.mime_type) && /opus/i.test(f.mime_type));
      const pool = opus.length ? opus : formats;
      const best = pool.sort((a, b) => (b.bitrate ?? 0) - (a.bitrate ?? 0))[0];

      console.log(`[youtube] stream URL via ${client}: ${best.mime_type} ${best.bitrate ? `${Math.round(best.bitrate / 1000)}kbps` : ''}`);
      return best.url;
    } catch (err) {
      lastError = err;
      console.debug(`[youtube] ${client} getBasicInfo failed for ${videoId}: ${err.message}`);
    }
  }

  if (lastError) {
    console.warn(`[youtube] getStreamUrl failed for ${videoId}: ${lastError.message}`);
  }
  return null;
}

/**
 * Builds a diagnostic, single-line description of a streaming error, pulling out the rich
 * detail youtubei.js attaches (`error.info`) that Discord's AudioPlayerError strips away.
 */
export function describeStreamError(error) {
  if (!error) return 'unknown error';
  const info = error.info ?? error.cause?.info ?? {};
  const response = info.response;
  const message = error.message || error.name || String(error);
  const meta = [];
  if (info.error_type) meta.push(info.error_type);
  if (response?.status) meta.push(`HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ''}`);
  return meta.length ? `${message} [${meta.join(', ')}]` : message;
}

/** Human-readable reasons for playability statuses that can never be worked around. */
const PLAYABILITY_MESSAGES = {
  LOGIN_REQUIRED: 'This video requires signing in (age-restricted or private).',
  UNPLAYABLE: 'YouTube reports this video as unplayable.',
  LIVE_STREAM_OFFLINE: 'This live stream is not currently live.',
  CONTENT_CHECK_REQUIRED: 'This video requires a content check the bot cannot complete.',
  AGE_CHECK_REQUIRED: 'This video is age-restricted.',
  ERROR: 'YouTube returned an error for this video.',
};

/**
 * Pick the best audio-only format, preferring Opus (no transcoding) and the original language.
 * Mirrors Redux-Music-Bot's pickAudioFormat.
 */
function pickAudioFormat(info) {
  const formats = (info.streaming_data?.adaptive_formats ?? []).filter(
    (f) => f.has_audio && !f.has_video && !f.drm_families?.length,
  );
  if (!formats.length) return null;

  const originals = formats.filter((f) => f.is_original !== false && !f.is_dubbed && !f.is_descriptive);
  const pool = originals.length ? originals : formats;
  const opus = pool.filter((f) => /webm/i.test(f.mime_type) && /opus/i.test(f.mime_type));
  const chosen = opus.length ? opus : pool;
  const best = chosen.slice().sort((a, b) => (b.bitrate ?? 0) - (a.bitrate ?? 0))[0];
  return Object.assign(best, { isOpus: opus.includes(best) });
}

/**
 * Pull the first chunk from a lazily-fetched web stream so a 403 surfaces here rather than
 * mid-playback, then hand back a Node Readable with that chunk pushed back in front.
 *
 * @param {ReadableStream} webStream
 * @returns {Promise<Readable>}
 */
async function probeReadable(webStream) {
  const reader = webStream.getReader();

  let first;
  try {
    first = await reader.read();
  } catch (err) {
    try { reader.releaseLock(); } catch {}
    try { await webStream.cancel(); } catch {}
    throw err;
  }

  // Rebuild a Node stream: the already-read chunk first, then the rest of the reader.
  const out = new Readable({
    read() {
      reader.read().then(
        ({ done, value }) => {
          this.push(done ? null : value);
        },
        (err) => this.destroy(err),
      );
    },
    destroy(err, cb) {
      reader.cancel().catch(() => {});
      cb(err);
    },
  });

  if (first.done) {
    out.push(null);
  } else {
    out.push(first.value);
  }

  return out;
}

/**
 * Create an audio stream for a video, trying each InnerTube client in turn.
 *
 * YouTube accepts a given client's stream URLs inconsistently (403s vary by client, video and
 * server IP), so we fall through to the next client on any failure. `exclude` lets the caller
 * skip clients that already failed for this track — used to recover mid-playback.
 *
 * If every client reports a bot check, the session's PoToken has gone stale: we re-mint it
 * once and retry immediately rather than waiting for the refresh timer.
 *
 * Returns { stream, isOpus, client, isLive, hlsUrl } or throws a StreamError-like Error with
 * `.permanent = true` when the video can never be played (DRM, login required, etc).
 */
export async function createStream(videoId, { exclude, _retried = false } = {}) {
  const yt = await getYouTube();
  const excluded = exclude instanceof Set ? exclude : new Set(exclude ?? []);
  const clients = STREAM_CLIENTS.filter((c) => !excluded.has(c));
  const failures = [];
  let playability = null;
  let playabilityReason = '';

  for (const client of clients) {
    let info;
    try {
      info = await yt.getBasicInfo(videoId, { client });
    } catch (err) {
      const detail = describeStreamError(err);
      failures.push(`${client}: ${detail}`);
      console.log(`[youtube] ${client} getBasicInfo failed: ${detail}`);
      continue;
    }

    const status = info.playability_status?.status;
    if (status && status !== 'OK') {
      const rawReason = info.playability_status?.reason ?? '';
      if (!playability) {
        playability = status;
        playabilityReason = rawReason;
      }
      const reason = rawReason ? ` (${rawReason})` : '';
      failures.push(`${client}: ${status}${reason}`);
      console.log(`[youtube] ${client} not playable: ${status}${reason}`);
      continue;
    }

    // Live streams: hand the HLS manifest back so the caller can feed ffmpeg.
    if (info.basic_info?.is_live) {
      const hls = info.streaming_data?.hls_manifest_url;
      if (!hls) {
        failures.push(`${client}: live stream without HLS manifest`);
        continue;
      }
      console.log(`[youtube] live stream via ${client} (HLS)`);
      return { stream: null, isOpus: false, client, isLive: true, hlsUrl: hls };
    }

    const format = pickAudioFormat(info);
    if (!format) {
      failures.push(`${client}: no audio formats`);
      continue;
    }

    let webStream;
    try {
      webStream = await info.download({ itag: format.itag, type: 'audio' });
    } catch (err) {
      const detail = describeStreamError(err);
      failures.push(`${client}: ${detail}`);
      console.log(`[youtube] ${client} download() failed: ${detail}`);
      continue;
    }

    // Probe the stream URL before committing to this client.
    //
    // info.download() is lazy: it returns a ReadableStream that only fetches the first
    // ranged chunk when the consumer pulls. Some clients (MWEB/WEB without a PoToken) hand
    // back metadata and a URL that then answers 403. Without this check the failure surfaces
    // mid-playback as a truncated track, and the client fallback loop is already gone —
    // the player just sees a stream that ended early and advances to the next song.
    let probeStream;
    try {
      probeStream = await probeReadable(webStream);
    } catch (err) {
      const detail = describeStreamError(err);
      failures.push(`${client}: ${detail}`);
      console.log(`[youtube] ${client} stream check failed: ${detail}`);
      continue;
    }

    const stream = probeStream;
    // Surface post-commit errors loudly; the player decides whether to recover.
    stream.on('error', (err) => {
      console.warn(`[youtube] stream error (client=${client}, itag=${format.itag}): ${describeStreamError(err)}`);
    });

    console.log(`[youtube] stream via ${client}: ${format.mime_type} ${format.bitrate ? `${Math.round(format.bitrate / 1000)}kbps` : ''}`);
    return { stream, isOpus: format.isOpus, client, isLive: false, hlsUrl: null };
  }

  if (failures.length) {
    console.warn(`[youtube] could not stream ${videoId}: ${failures.join(' | ')}`);
  }

  // Only give up entirely when the video itself is unplayable. A bot-check LOGIN_REQUIRED is an
  // IP-level block, so we return null and let the caller fall back to yt-dlp.
  if (playability && isPermanentFailure(playability, playabilityReason)) {
    const error = new Error(PLAYABILITY_MESSAGES[playability] ?? `YouTube refused this video (${playability}).`);
    error.permanent = true;
    error.playability = playability;
    throw error;
  }

  if (playability === 'LOGIN_REQUIRED' && BOT_CHECK_PATTERN.test(playabilityReason)) {
    // A bot check across every client means our PoToken is stale or absent. Re-mint and retry
    // once before handing off to yt-dlp — this is what keeps the bot alive past the token TTL.
    if (!_retried) {
      console.warn('[youtube] bot check on all clients — re-minting PoToken and retrying');
      await refreshSession('bot-check');
      return createStream(videoId, { exclude, _retried: true });
    }
    console.warn('[youtube] bot check persists after refresh — falling back to yt-dlp');
  }

  return null;
}

/** Number of stream clients available — used to know when every client has been tried. */
export function getStreamClientCount() {
  return STREAM_CLIENTS.length;
}

/**
 * Get a playlist's videos.
 * Returns { title, videos: [{ id, title, url, duration, thumbnail, author }] } or null.
 */
export async function getPlaylist(playlistId, limit = 60) {
  const yt = await getYouTube();

  try {
    const playlist = await yt.getPlaylist(playlistId);
    const items = playlist.items || [];
    const videos = [];

    for (const item of items) {
      const id = item.id || item.video_id;
      if (!id) continue;
      videos.push({
        id,
        title: item.title?.text || item.title || 'Unknown',
        url: `https://www.youtube.com/watch?v=${id}`,
        duration: item.duration?.seconds || 0,
        thumbnail: item.thumbnails?.[0]?.url || `https://i.ytimg.com/vi/${id}/hqdefault.jpg`,
        author: item.author?.name || item.author?.text || 'Unknown',
      });
      if (videos.length >= limit) break;
    }

    // Paginate if needed
    let page = playlist;
    while (videos.length < limit && page.has_continuation) {
      page = await page.getContinuation();
      for (const item of page.items || []) {
        const id = item.id || item.video_id;
        if (!id) continue;
        videos.push({
          id,
          title: item.title?.text || item.title || 'Unknown',
          url: `https://www.youtube.com/watch?v=${id}`,
          duration: item.duration?.seconds || 0,
          thumbnail: item.thumbnails?.[0]?.url || `https://i.ytimg.com/vi/${id}/hqdefault.jpg`,
          author: item.author?.name || item.author?.text || 'Unknown',
        });
        if (videos.length >= limit) break;
      }
    }

    if (videos.length === 0) return null;

    return {
      title: playlist.info?.title ?? 'YouTube playlist',
      videos,
    };
  } catch (err) {
    console.warn(`[youtube] getPlaylist failed for ${playlistId}: ${err.message}`);
    return null;
  }
}

export { getYouTube };
