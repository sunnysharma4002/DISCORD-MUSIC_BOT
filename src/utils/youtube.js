import path from 'node:path';
import { Innertube, Log, Platform, UniversalCache } from 'youtubei.js';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = dirname(dirname(__dirname));
const cacheDir = join(projectRoot, '.cache', 'youtubei');

let ytInstance = null;
let ytReady = false;

/**
 * Initialize the YouTube InnerTube client.
 * Called lazily on first use.
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

  const cookie = process.env.YOUTUBE_COOKIE?.trim() || undefined;
  const poToken = process.env.YOUTUBE_PO_TOKEN?.trim() || undefined;
  const visitorData = process.env.YOUTUBE_VISITOR_DATA?.trim() || undefined;

  ytInstance = await Innertube.create({
    cache: new UniversalCache(true, cacheDir),
    cookie,
    po_token: poToken,
    visitor_data: visitorData,
  });

  ytReady = true;
  console.log('[youtube] InnerTube client ready');
  return ytInstance;
}

/** Search YouTube and return up to `limit` video results. */
export async function search(query, limit = 5) {
  const yt = await getYouTube();
  const clients = ['IOS', 'WEB', 'MWEB', 'ANDROID_VR'];
  let lastError = null;

  for (const client of clients) {
    try {
      const results = await yt.search(query, { type: 'video', client });
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
        console.log(`[youtube] search OK via ${client}: ${videos.length} results for "${query.substring(0, 40)}"`);
        return videos;
      }
    } catch (err) {
      lastError = err;
      console.debug(`[youtube] search via ${client} failed: ${err.message}`);
    }
  }

  if (lastError) {
    console.warn(`[youtube] search failed for "${query.substring(0, 40)}": ${lastError.message}`);
  }
  return [];
}

/**
 * Get video metadata (title, author, duration, thumbnail).
 * Returns null if the video cannot be loaded.
 */
export async function getVideoInfo(videoId) {
  const yt = await getYouTube();
  const clients = ['IOS', 'WEB', 'MWEB', 'ANDROID_VR'];
  let lastError = null;

  for (const client of clients) {
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
 * Tries multiple InnerTube clients and returns the best audio format URL.
 * Returns null if no stream URL can be obtained.
 */
export async function getStreamUrl(videoId) {
  const yt = await getYouTube();
  const clients = ['IOS', 'WEB', 'MWEB', 'ANDROID_VR'];
  let lastError = null;

  for (const client of clients) {
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
