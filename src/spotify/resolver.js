import { YouTube } from 'youtube-sr';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { constants as ytdlpConstants } from 'youtube-dl-exec';

const _projectRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const _vendoredYtdlp = join(_projectRoot, 'vendor', 'yt-dlp');

function getYtdlpBin() {
  const override = (process.env.YTDLP_CMD || '').trim();
  let bin, pre;
  if (override) {
    const parts = override.split(/\s+/);
    bin = parts[0];
    pre = parts.slice(1);
  } else if (existsSync(_vendoredYtdlp)) {
    bin = _vendoredYtdlp;
    pre = [];
  } else {
    bin = ytdlpConstants.YOUTUBE_DL_PATH;
    pre = [];
  }
  return { bin, pre };
}

/**
 * Spotify → YouTube resolution.
 *
 * Spotify audio is DRM-protected and cannot be streamed directly. This module
 * scrapes public metadata from Spotify's embed endpoint (no API key required),
 * then searches YouTube for a matching stream.
 *
 * Embed endpoint returns a JSON blob inside the HTML that contains track
 * names + artists for tracks, albums and playlists.
 */

const SPOTIFY_RE =
  /^https?:\/\/(?:open|play)\.spotify\.com\/(?:intl-[a-z]{2}\/)?(track|album|playlist)\/([a-zA-Z0-9]+)/;

const MAX_PLAYLIST_TRACKS = 60;

export function isSpotifyURL(url) {
  return typeof url === 'string' && SPOTIFY_RE.test(url.trim());
}

export function isYouTubeURL(url) {
  return (
    typeof url === 'string' &&
    /^https?:\/\/(?:www\.|m\.|music\.)?(?:youtube\.com|youtu\.be)\//.test(url.trim())
  );
}

export function isURL(str) {
  return typeof str === 'string' && /^https?:\/\//i.test(str.trim());
}

/* ------------------------------------------------------------------ */
/* Spotify                                                             */
/* ------------------------------------------------------------------ */

/** Fetches the embed page and extracts the JSON state object. */
async function fetchSpotifyEntity(type, id) {
  const url = `https://open.spotify.com/embed/${type}/${id}`;
  const res = await fetch(url, {
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
      'Accept-Language': 'en-US,en;q=0.9',
    },
  });

  if (!res.ok) {
    throw new Error(`Spotify returned HTTP ${res.status} for that link.`);
  }

  const html = await res.text();

  // Spotify embeds a Next.js data payload in a <script id="__NEXT_DATA__"> tag
  const match = html.match(
    /<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/
  );
  if (!match) {
    throw new Error('Could not read Spotify metadata (page format changed).');
  }

  let data;
  try {
    data = JSON.parse(match[1]);
  } catch {
    throw new Error('Could not parse Spotify metadata.');
  }

  const entity =
    data?.props?.pageProps?.state?.data?.entity ??
    data?.props?.pageProps?.entity ??
    null;

  if (!entity) {
    throw new Error('Spotify link contains no readable track data.');
  }

  return entity;
}

/** Normalises one Spotify entity item into { name, artist }. */
function readItem(item) {
  if (!item) return null;

  const name = item.name ?? item.title ?? null;
  if (!name) return null;

  const artists = item.artists ?? item.subtitle ?? null;
  let artist = '';

  if (Array.isArray(artists)) {
    artist = artists
      .map((a) => (typeof a === 'string' ? a : a?.name))
      .filter(Boolean)
      .join(' ');
  } else if (typeof artists === 'string') {
    artist = artists;
  }

  return { name: String(name), artist: String(artist ?? '') };
}

/**
 * Resolves a Spotify URL to an array of playable YouTube tracks.
 * Returns { tracks, playlistName, skipped }.
 */
export async function resolveSpotify(rawUrl, requestedBy) {
  const url = String(rawUrl).trim();
  const match = url.match(SPOTIFY_RE);
  if (!match) throw new Error('That is not a valid Spotify track/album/playlist link.');

  const [, type, id] = match;
  const entity = await fetchSpotifyEntity(type, id);

  /* Collect raw Spotify items ------------------------------------- */
  let items = [];

  if (type === 'track') {
    const single = readItem(entity);
    if (single) items = [single];
  } else {
    const list =
      entity?.trackList ??
      entity?.tracks?.items ??
      entity?.tracks ??
      [];

    for (const raw of list) {
      // playlist entries sometimes nest the track under .track
      const parsed = readItem(raw?.track ?? raw);
      if (parsed) items.push(parsed);
    }
  }

  if (items.length === 0) {
    throw new Error('No tracks found in that Spotify link.');
  }

  const playlistName = entity?.name ?? entity?.title ?? null;
  const truncated = items.length > MAX_PLAYLIST_TRACKS;
  if (truncated) items = items.slice(0, MAX_PLAYLIST_TRACKS);

  /* Search YouTube for each item ---------------------------------- */
  const tracks = [];
  let skipped = 0;

  for (const item of items) {
    const query = `${item.name} ${item.artist}`.replace(/\s+/g, ' ').trim();
    if (!query) {
      skipped++;
      continue;
    }

    try {
      const video = await searchYouTube(query);
      if (!video) {
        skipped++;
        continue;
      }
      tracks.push({
        ...video,
        source: 'spotify',
        // keep the Spotify title for display accuracy
        title: video.title,
        spotifyTitle: `${item.name}${item.artist ? ` — ${item.artist}` : ''}`,
        requestedBy,
      });
    } catch (err) {
      console.warn(`[spotify] search failed for "${query}": ${err.message}`);
      skipped++;
    }
  }

  if (tracks.length === 0) {
    throw new Error('Could not find any of those tracks on YouTube.');
  }

  return { tracks, playlistName, skipped, truncated };
}

/* ------------------------------------------------------------------ */
/* YouTube                                                             */
/* ------------------------------------------------------------------ */

/** Runs a YouTube search and returns the first usable video, or null. */
async function searchYouTube(query) {
  const apiKey = process.env.YOUTUBE_API_KEY?.trim();

  if (apiKey) {
    const video = await searchYouTubeAPI(query, apiKey);
    if (video) return video;
  }

  const results = await YouTube.search(query, { limit: 5, type: 'video', safeSearch: false });
  if (!Array.isArray(results)) return null;

  const video = results.find((v) => v?.id && v?.title && !v?.private);
  if (!video) return null;

  return normaliseVideo(video);
}

/** Searches YouTube via the official Data API v3. */
async function searchYouTubeAPI(query, apiKey) {
  try {
    const url = new URL('https://www.googleapis.com/youtube/v3/search');
    url.searchParams.set('part', 'snippet');
    url.searchParams.set('q', query);
    url.searchParams.set('type', 'video');
    url.searchParams.set('maxResults', '5');
    url.searchParams.set('key', apiKey);

    const res = await fetch(url.toString());
    if (!res.ok) {
      console.warn(`[youtube-api] search returned HTTP ${res.status}`);
      return null;
    }

    const data = await res.json();
    if (!data.items || data.items.length === 0) return null;

    // Fetch full video details (duration, etc.) for the first result
    const videoId = data.items[0].id.videoId;
    const videoUrl = `https://www.googleapis.com/youtube/v3/videos?part=snippet,contentDetails&id=${videoId}&key=${apiKey}`;
    const videoRes = await fetch(videoUrl);
    if (!videoRes.ok) return normaliseSearchResult(data.items[0].snippet);

    const videoData = await videoRes.json();
    if (!videoData.items || videoData.items.length === 0) return normaliseSearchResult(data.items[0].snippet);

    const item = videoData.items[0];
    return {
      title: item.snippet?.title ?? 'Unknown title',
      url: `https://www.youtube.com/watch?v=${videoId}`,
      videoId,
      duration: parseISO8601Duration(item.contentDetails?.duration) * 1000,
      isLive: false,
      thumbnail: item.snippet?.thumbnails?.high?.url ?? item.snippet?.thumbnails?.default?.url ?? `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
      author: item.snippet?.channelTitle ?? 'Unknown',
      source: 'youtube',
    };
  } catch (err) {
    console.warn(`[youtube-api] search error: ${err.message}`);
    return null;
  }
}

function normaliseSearchResult(snippet) {
  if (!snippet) return null;
  const videoId = snippet.resourceId?.videoId;
  if (!videoId) return null;
  return {
    title: snippet.title ?? 'Unknown title',
    url: `https://www.youtube.com/watch?v=${videoId}`,
    videoId,
    duration: 0,
    isLive: false,
    thumbnail: snippet.thumbnails?.high?.url ?? snippet.thumbnails?.default?.url ?? `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
    author: snippet.channelTitle ?? 'Unknown',
    source: 'youtube',
  };
}

function parseISO8601Duration(duration) {
  if (!duration) return 0;
  const match = duration.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  if (!match) return 0;
  const hours = parseInt(match[1] || 0, 10);
  const minutes = parseInt(match[2] || 0, 10);
  const seconds = parseInt(match[3] || 0, 10);
  return hours * 3600 + minutes * 60 + seconds;
}

function normaliseVideo(video) {
  const durationMs = Number(video.duration) || 0;
  return {
    title: video.title ?? 'Unknown title',
    url: video.url ?? `https://www.youtube.com/watch?v=${video.id}`,
    videoId: video.id,
    duration: durationMs,
    isLive: Boolean(video.live) || durationMs === 0,
    thumbnail:
      video.thumbnail?.url ??
      video.thumbnail?.displayThumbnailURL?.() ??
      (video.id ? `https://i.ytimg.com/vi/${video.id}/hqdefault.jpg` : null),
    author: video.channel?.name ?? 'Unknown',
    source: 'youtube',
  };
}

/**
 * Fetches playlist metadata using yt-dlp (more reliable than youtube-sr).
 * Returns { title, entries: [{ title, url, id, duration }] } or null on failure.
 */
async function fetchPlaylistViaYtdlp(url) {
  const { bin, pre } = getYtdlpBin();

  if (!existsSync(bin)) {
    console.warn('[resolver] yt-dlp binary not found, skipping yt-dlp playlist fetch');
    return null;
  }

  return new Promise((resolve) => {
    const args = [
      ...pre,
      '-J',
      '--flat-playlist',
      '--playlist-items', `0:${MAX_PLAYLIST_TRACKS - 1}`,
      '--no-warnings',
      '--extractor-args', 'youtube:player_client=ios,android,tv_embedded',
      url,
    ];

    let stdout = '';
    let stderr = '';
    let timeout;

    const proc = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });

    proc.stdout.on('data', (d) => { stdout += d.toString(); });
    proc.stderr.on('data', (d) => { stderr += d.toString(); });

    proc.on('close', (code) => {
      clearTimeout(timeout);
      if (code !== 0 || !stdout.trim()) {
        console.warn(`[resolver] yt-dlp playlist fetch failed (code ${code}): ${stderr.trim().substring(0, 200)}`);
        return resolve(null);
      }

      try {
        const data = JSON.parse(stdout);
        if (!data || !data.entries || data.entries.length === 0) {
          return resolve(null);
        }

        const entries = data.entries.map((entry) => ({
          title: entry.title || 'Unknown title',
          url: entry.url || `https://www.youtube.com/watch?v=${entry.id}`,
          id: entry.id,
          duration: entry.duration ? entry.duration * 1000 : 0,
        })).filter((e) => e.id);

        resolve({
          title: data.title || 'YouTube playlist',
          videoCount: data.count || entries.length,
          entries,
        });
      } catch (e) {
        console.warn('[resolver] yt-dlp playlist JSON parse failed:', e.message);
        resolve(null);
      }
    });

    proc.on('error', (err) => {
      clearTimeout(timeout);
      console.warn('[resolver] yt-dlp playlist spawn error:', err.message);
      resolve(null);
    });

    timeout = setTimeout(() => {
      try { proc.kill('SIGKILL'); } catch {}
      resolve(null);
    }, 15000);
  });
}

/**
 * Resolves a YouTube URL, a YouTube playlist URL, or a plain search query.
 * Returns { tracks, playlistName }.
 */
export async function resolveYouTube(rawQuery, requestedBy) {
  const query = String(rawQuery ?? '').trim();
  if (!query) throw new Error('Empty search query.');

  /* Playlist URL --------------------------------------------------- */
  if (/[?&]list=/.test(query) && isYouTubeURL(query)) {
    // Try yt-dlp first (more reliable for playlist extraction)
    const ytdlpResult = await fetchPlaylistViaYtdlp(query);
    if (ytdlpResult && ytdlpResult.entries.length > 0) {
      console.log(`[resolver] yt-dlp playlist fetched: ${ytdlpResult.entries.length} tracks from "${ytdlpResult.title}"`);
      return {
        tracks: ytdlpResult.entries.map((e) => ({
          title: e.title,
          url: e.url,
          videoId: e.id,
          duration: e.duration,
          isLive: false,
          thumbnail: `https://i.ytimg.com/vi/${e.id}/hqdefault.jpg`,
          author: 'Unknown',
          source: 'youtube',
          requestedBy,
        })),
        playlistName: ytdlpResult.title,
        skipped: 0,
        truncated: ytdlpResult.videoCount > ytdlpResult.entries.length,
      };
    }

    // Fallback to youtube-sr
    try {
      const playlist = await YouTube.getPlaylist(query, { fetchAll: false });
      const videos = (playlist?.videos ?? []).slice(0, MAX_PLAYLIST_TRACKS);
      if (videos.length > 0) {
        console.log(`[resolver] youtube-sr playlist fallback: ${videos.length} tracks`);
        return {
          tracks: videos.map((v) => ({ ...normaliseVideo(v), requestedBy })),
          playlistName: playlist?.title ?? 'YouTube playlist',
          skipped: 0,
          truncated: (playlist?.videoCount ?? videos.length) > videos.length,
        };
      }
    } catch (err) {
      console.warn(`[youtube] playlist fetch failed, falling back: ${err.message}`);
    }

    // Playlist URL but both methods failed — don't fall through to single-video
    throw new Error('Could not fetch that YouTube playlist. Make sure it\'s public or unlisted.');
  }

  /* Single video URL ---------------------------------------------- */
  if (isYouTubeURL(query)) {
    const id = extractVideoId(query);
    if (!id) throw new Error('Could not read a video ID from that YouTube link.');

    try {
      const video = await YouTube.getVideo(`https://www.youtube.com/watch?v=${id}`);
      if (video) {
        return {
          tracks: [{ ...normaliseVideo(video), requestedBy }],
          playlistName: null,
          skipped: 0,
          truncated: false,
        };
      }
    } catch (err) {
      console.warn(`[youtube] getVideo failed: ${err.message}`);
    }

    // Minimal fallback — let the streamer fetch full info later
    return {
      tracks: [
        {
          title: 'YouTube video',
          url: `https://www.youtube.com/watch?v=${id}`,
          videoId: id,
          duration: 0,
          isLive: false,
          thumbnail: `https://i.ytimg.com/vi/${id}/hqdefault.jpg`,
          author: 'Unknown',
          source: 'youtube',
          requestedBy,
        },
      ],
      playlistName: null,
      skipped: 0,
      truncated: false,
    };
  }

  /* Other URLs are unsupported ------------------------------------ */
  if (isURL(query)) {
    throw new Error('Only YouTube and Spotify links are supported.');
  }

  /* Plain search query ------------------------------------------- */
  const video = await searchYouTube(query);
  if (!video) throw new Error(`No YouTube results for **${query}**.`);

  return {
    tracks: [{ ...video, requestedBy }],
    playlistName: null,
    skipped: 0,
    truncated: false,
  };
}

/** Extracts an 11-character video ID from any common YouTube URL form. */
export function extractVideoId(url) {
  const patterns = [
    /[?&]v=([a-zA-Z0-9_-]{11})/,
    /youtu\.be\/([a-zA-Z0-9_-]{11})/,
    /\/embed\/([a-zA-Z0-9_-]{11})/,
    /\/shorts\/([a-zA-Z0-9_-]{11})/,
    /\/live\/([a-zA-Z0-9_-]{11})/,
  ];
  for (const re of patterns) {
    const m = url.match(re);
    if (m) return m[1];
  }
  return null;
}

/**
 * Single entry point used by /play — routes to the right resolver.
 * Always returns { tracks, playlistName, skipped, truncated }.
 */
export async function resolveQuery(query, requestedBy) {
  const trimmed = String(query ?? '').trim();
  if (!trimmed) throw new Error('You need to provide a song name or link.');

  if (isSpotifyURL(trimmed)) return resolveSpotify(trimmed, requestedBy);
  return resolveYouTube(trimmed, requestedBy);
}
