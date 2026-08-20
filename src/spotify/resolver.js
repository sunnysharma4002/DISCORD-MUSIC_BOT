import { YouTube } from 'youtube-sr';

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
  const results = await YouTube.search(query, { limit: 5, type: 'video', safeSearch: false });
  if (!Array.isArray(results)) return null;

  const video = results.find((v) => v?.id && v?.title && !v?.private);
  if (!video) return null;

  return normaliseVideo(video);
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
 * Resolves a YouTube URL, a YouTube playlist URL, or a plain search query.
 * Returns { tracks, playlistName }.
 */
export async function resolveYouTube(rawQuery, requestedBy) {
  const query = String(rawQuery ?? '').trim();
  if (!query) throw new Error('Empty search query.');

  /* Playlist URL --------------------------------------------------- */
  if (/[?&]list=/.test(query) && isYouTubeURL(query)) {
    try {
      const playlist = await YouTube.getPlaylist(query, { fetchAll: false });
      const videos = (playlist?.videos ?? []).slice(0, MAX_PLAYLIST_TRACKS);
      if (videos.length > 0) {
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
    // fall through to single-video handling
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
