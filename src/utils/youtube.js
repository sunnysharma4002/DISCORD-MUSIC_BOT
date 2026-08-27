import { Innertube, Log, Platform, UniversalCache } from 'youtubei.js';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = dirname(dirname(__dirname));
const cacheDir = join(projectRoot, '.cache', 'youtubei');

import { existsSync, readdirSync, rmSync } from 'node:fs';

let ytInstance = null;
let ytReady = false;

/**
 * InnerTube clients to try, in order, when resolving an audio stream.
 * Configurable via YOUTUBE_CLIENTS (comma-separated). Matches Redux-Music-Bot defaults.
 * Valid: VISIONOS, IOS, MWEB, ANDROID_VR, WEB, ANDROID, TV_EMBEDDED, WEB_EMBEDDED
 */
const STREAM_CLIENTS = (process.env.YOUTUBE_CLIENTS?.trim()
  ? process.env.YOUTUBE_CLIENTS.split(',').map((s) => s.trim()).filter(Boolean)
  : ['VISIONOS', 'IOS', 'MWEB', 'ANDROID_VR', 'TV_EMBEDDED', 'WEB_EMBEDDED']);

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
 * Parse Netscape cookie file format into a Cookie header string for youtubei.js.
 * Also handles simple "name=value; name=value" format.
 */
function parseCookieString(raw) {
  if (!raw) return undefined;
  const trimmed = raw.trim();

  // Already in header format: "name=value; name=value"
  if (trimmed.includes('=') && !trimmed.includes('\t')) {
    return trimmed;
  }

  // Netscape format: extract name and value columns
  const pairs = [];
  for (const line of trimmed.split('\n')) {
    if (line.startsWith('#') || !line.trim()) continue;
    const parts = line.split('\t');
    if (parts.length >= 7) {
      const name = parts[5];
      const value = parts[6];
      if (name && value !== undefined) {
        pairs.push(`${name}=${value.trim()}`);
      }
    }
  }
  return pairs.length > 0 ? pairs.join('; ') : undefined;
}

/**
 * Initialize the YouTube InnerTube client.
 * Automatically generates visitor data and session — no manual config needed.
 * If YOUTUBE_COOKIE is set, it's used for age-restricted videos.
 */
async function getYouTube() {
  if (ytInstance && ytReady) return ytInstance;

  Log.setLevel(Log.Level.ERROR);

  // youtubei.js needs a JS runtime for signature/n-param deciphering.
  // Provide Node's Function constructor as the eval shim.
  Platform.shim.eval = (data, env = {}) => {
    const names = Object.keys(env);
    const fn = new Function(...names, data.output);
    return fn(...names.map((name) => env[name]));
  };

  const cookie = parseCookieString(process.env.YOUTUBE_COOKIE);
  // Only use manual tokens if explicitly set and non-empty.
  // Otherwise let youtubei.js auto-generate visitor_data and po_token.
  const poToken = (process.env.YOUTUBE_PO_TOKEN?.trim()?.length > 0) ? process.env.YOUTUBE_PO_TOKEN.trim() : undefined;
  const visitorData = (process.env.YOUTUBE_VISITOR_DATA?.trim()?.length > 0) ? process.env.YOUTUBE_VISITOR_DATA.trim() : undefined;

  ytInstance = await Innertube.create({
    cache: new UniversalCache(true, cacheDir),
    cookie,
    po_token: poToken,
    visitor_data: visitorData,
  });

  ytReady = true;
  console.log(`[youtube] InnerTube client ready (clients: ${STREAM_CLIENTS.join(' > ')})`);
  return ytInstance;
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
 * Create an audio stream for a video, trying each InnerTube client in turn.
 *
 * YouTube accepts a given client's stream URLs inconsistently (403s vary by client, video and
 * server IP), so we fall through to the next client on any failure. `exclude` lets the caller
 * skip clients that already failed for this track — used to recover mid-playback.
 *
 * Returns { stream, isOpus, client, isLive, hlsUrl } or throws a StreamError-like Error with
 * `.permanent = true` when the video can never be played (DRM, login required, etc).
 */
export async function createStream(videoId, { exclude } = {}) {
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

    const stream = Readable.fromWeb(webStream);
    // Prevent unhandled 'error' before the resource is committed; the player logs real errors.
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
    console.warn('[youtube] bot check on this IP — falling back to yt-dlp');
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
