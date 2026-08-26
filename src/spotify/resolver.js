import { YouTube } from 'youtube-sr';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { constants as ytdlpConstants } from 'youtube-dl-exec';
import { search as ytSearch } from '../utils/youtube.js';

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

const JIOSAAVN_API_BASE = 'https://jiosaavn-api.sharmaofficial.workers.dev/api';

/**
 * JioSaavn URL patterns.
 */
const JIOSAAVN_SONG_RE = /^https?:\/\/www\.jiosaavn\.com\/song\/[^/]+\/([a-zA-Z0-9]+)/;
const JIOSAAVN_ALBUM_RE = /^https?:\/\/www\.jiosaavn\.com\/album\/[^/]+\/([a-zA-Z0-9_-]+)/;

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

export function isSoundCloudURL(url) {
  return typeof url === 'string' && /^https?:\/\/(www\.)?soundcloud\.com\//i.test(url.trim());
}

export function isJioSaavnURL(url) {
  return typeof url === 'string' && /^https?:\/\/www\.jiosaavn\.com\//i.test(url.trim());
}

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

/**
 * Spotify API access token cache.
 * Tokens last 1 hour; we refresh at 50 minutes to be safe.
 */
let _spotifyToken = null;
let _spotifyTokenExpiry = 0;

/**
 * Gets a Spotify API access token using client credentials.
 * Returns null if credentials are not configured.
 */
async function getSpotifyToken() {
  const clientId = process.env.SPOTIFY_CLIENT_ID?.trim();
  const clientSecret = process.env.SPOTIFY_CLIENT_SECRET?.trim();

  if (!clientId || !clientSecret) return null;

  const now = Date.now();
  if (_spotifyToken && now < _spotifyTokenExpiry) {
    return _spotifyToken;
  }

  try {
    const res = await fetch('https://accounts.spotify.com/api/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Authorization': 'Basic ' + Buffer.from(`${clientId}:${clientSecret}`).toString('base64'),
      },
      body: 'grant_type=client_credentials',
    });

    if (!res.ok) {
      console.warn(`[spotify-api] token request failed: HTTP ${res.status}`);
      return null;
    }

    const data = await res.json();
    _spotifyToken = data.access_token;
    _spotifyTokenExpiry = now + (data.expires_in - 300) * 1000;
    console.log('[spotify-api] obtained access token');
    return _spotifyToken;
  } catch (err) {
    console.warn(`[spotify-api] token error: ${err.message}`);
    return null;
  }
}

/** Fetches track/album/playlist data from the Spotify Web API. */
async function fetchSpotifyAPI(type, id, token) {
  const url = `https://api.spotify.com/v1/${type}/${id}`;
  const res = await fetch(url, {
    headers: { 'Authorization': `Bearer ${token}` },
  });

  if (!res.ok) {
    throw new Error(`Spotify API returned HTTP ${res.status} for that ${type}.`);
  }

  return res.json();
}

/** Fetches playlist tracks (paginated) from the Spotify Web API. */
async function fetchPlaylistTracksAPI(playlistId, token) {
  const tracks = [];
  let url = `https://api.spotify.com/v1/playlists/${playlistId}/tracks?limit=100&fields=items(track(name,artists)),next`;

  while (url) {
    const res = await fetch(url, {
      headers: { 'Authorization': `Bearer ${token}` },
    });

    if (!res.ok) {
      throw new Error(`Spotify API returned HTTP ${res.status} for playlist tracks.`);
    }

    const data = await res.json();
    for (const item of data.items ?? []) {
      if (item.track) tracks.push(item.track);
    }

    url = data.next;
  }

  return tracks;
}

/** Normalises one Spotify API track into { name, artist }. */
function readAPIItem(track) {
  if (!track) return null;
  const name = track.name ?? null;
  if (!name) return null;

  const artists = track.artists ?? [];
  const artist = Array.isArray(artists)
    ? artists.map(a => a?.name ?? '').filter(Boolean).join(', ')
    : '';

  return { name: String(name), artist: String(artist ?? '') };
}

/** Fetches the embed page and extracts the JSON state object (fallback). */
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
 * Returns { tracks, playlistName, skipped, truncated }.
 */
export async function resolveSpotify(rawUrl, requestedBy) {
  const url = String(rawUrl).trim();
  const match = url.match(SPOTIFY_RE);
  if (!match) throw new Error('That is not a valid Spotify track/album/playlist link.');

  const [, type, id] = match;

  /* Try Spotify API first (if credentials are set) ------------------ */
  const token = await getSpotifyToken();
  let items = [];
  let playlistName = null;

  if (token) {
    try {
      const entity = await fetchSpotifyAPI(type, id, token);

      if (type === 'track') {
        const single = readAPIItem(entity);
        if (single) items = [single];
      } else if (type === 'album') {
        playlistName = entity?.name ?? null;
        const albumTracks = entity?.tracks?.items ?? [];
        for (const raw of albumTracks) {
          const parsed = readAPIItem(raw);
          if (parsed) items.push(parsed);
        }
      } else if (type === 'playlist') {
        playlistName = entity?.name ?? null;
        const playlistTracks = await fetchPlaylistTracksAPI(id, token);
        for (const raw of playlistTracks) {
          const parsed = readAPIItem(raw);
          if (parsed) items.push(parsed);
        }
      }
    } catch (err) {
      // 410 = playlist no longer accessible via API (private, deleted, or format changed)
      // Silently fall back to embed scraper - this is expected behavior
      console.log(`[spotify-api] using embed scraper for ${type} (API: ${err.message})`);
    }
  }

  /* Fall back to embed page scraping (no API key) ------------------ */
  if (items.length === 0) {
    console.log(`[spotify] fetching ${type} metadata via embed page...`);
    const entity = await fetchSpotifyEntity(type, id);

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

    if (!playlistName) {
      playlistName = entity?.name ?? entity?.title ?? null;
    }
    console.log(`[spotify] embed scraper found ${items.length} tracks in "${playlistName ?? 'unknown'}"`);
  }

  if (items.length === 0) {
    throw new Error('No tracks found in that Spotify link.');
  }

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

  console.log(`[spotify] resolved ${tracks.length}/${items.length} tracks to YouTube (skipped: ${skipped})`);
  return { tracks, playlistName, skipped, truncated };
}

/* ------------------------------------------------------------------ */
/* JioSaavn                                                            */
/* ------------------------------------------------------------------ */

/**
 * Resolves a JioSaavn URL or search query to playable tracks.
 * JioSaavn provides direct audio URLs (no DRM), so we can stream directly.
 * Returns { tracks, playlistName, skipped, truncated }.
 */
export async function resolveJioSaavn(rawQuery, requestedBy) {
  const query = String(rawQuery ?? '').trim();
  if (!query) throw new Error('Empty search query.');

  /* JioSaavn song URL - extract song name and search ---------------- */
  const songMatch = query.match(JIOSAAVN_SONG_RE);
  if (songMatch) {
    const songName = decodeURIComponent(songMatch[0].split('/song/')[1].split('/')[0]);
    console.log(`[jiosaavn] song URL detected, searching for: "${songName}"`);
    return resolveJioSaavnSearch(songName, requestedBy);
  }

  /* JioSaavn album URL - extract album name and search --------------- */
  const albumMatch = query.match(JIOSAAVN_ALBUM_RE);
  if (albumMatch) {
    const albumName = decodeURIComponent(albumMatch[0].split('/album/')[1].split('/')[0]);
    console.log(`[jiosaavn] album URL detected, searching for: "${albumName}"`);
    // Search for the album and get its ID
    const searchData = await fetchJioSaavn(`search?query=${encodeURIComponent(albumName)}&limit=5`);
    const albums = searchData?.albums?.results ?? [];
    if (albums.length === 0) {
      throw new Error(`Could not find album "${albumName}" on JioSaavn.`);
    }
    return resolveJioSaavnAlbum(albums[0].id, requestedBy);
  }

  /* Plain search query or JioSaavn URL without match ----------------- */
  if (isJioSaavnURL(query)) {
    throw new Error('Could not parse that JioSaavn link. Make sure it\'s a valid song or album URL.');
  }

  return resolveJioSaavnSearch(query, requestedBy);
}

/** Searches JioSaavn API and returns the first matching song as a playable track. */
async function resolveJioSaavnSearch(query, requestedBy) {
  const data = await fetchJioSaavn(`search?query=${encodeURIComponent(query)}&limit=5`);

  const songs = data?.songs?.results ?? data?.topQuery?.results ?? [];
  if (!Array.isArray(songs) || songs.length === 0) {
    throw new Error(`No JioSaavn results for **${query}**.`);
  }

  // Get the first song's full details including download URL
  const song = await fetchJioSaavnSongDetails(songs[0].id);
  if (!song) {
    throw new Error(`Could not fetch details for "${songs[0].title}".`);
  }

  const track = jioSaavnToTrack(song, requestedBy);
  return { tracks: [track], playlistName: null, skipped: 0, truncated: false };
}

/** Resolves a JioSaavn song ID to a playable track. */
async function resolveJioSaavnSong(songId, requestedBy) {
  const song = await fetchJioSaavnSongDetails(songId);
  if (!song) {
    throw new Error('Could not fetch that JioSaavn song.');
  }

  const track = jioSaavnToTrack(song, requestedBy);
  return { tracks: [track], playlistName: null, skipped: 0, truncated: false };
}

/** Resolves a JioSaavn album ID to playable tracks. */
async function resolveJioSaavnAlbum(albumId, requestedBy) {
  const data = await fetchJioSaavn(`albums?id=${encodeURIComponent(albumId)}`);
  if (!data) {
    throw new Error('Could not fetch that JioSaavn album.');
  }

  const playlistName = data.name ?? 'JioSaavn album';
  const songs = data.songs ?? [];
  if (songs.length === 0) {
    throw new Error('No tracks found in that JioSaavn album.');
  }

  const truncated = songs.length > MAX_PLAYLIST_TRACKS;
  const slice = truncated ? songs.slice(0, MAX_PLAYLIST_TRACKS) : songs;

  const tracks = [];
  let skipped = 0;

  // Album API already returns full song data including downloadUrl
  // No need for individual API calls - much faster
  for (const song of slice) {
    try {
      const track = jioSaavnToTrack(song, requestedBy);
      if (track.audioUrl) {
        tracks.push(track);
      } else {
        skipped++;
      }
    } catch (err) {
      console.warn(`[jiosaavn] failed to process song ${song.id}: ${err.message}`);
      skipped++;
    }
  }

  if (tracks.length === 0) {
    throw new Error('Could not fetch any tracks from that JioSaavn album.');
  }

  return { tracks, playlistName, skipped, truncated };
}

/** Fetches a JioSaavn API endpoint and returns parsed JSON. */
async function fetchJioSaavn(path) {
  const url = `${JIOSAAVN_API_BASE}/${path}`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`JioSaavn API returned HTTP ${res.status}`);
  }
  const data = await res.json();
  if (!data.success) {
    throw new Error(data.message ?? 'JioSaavn API error');
  }
  return data.data;
}

/** Fetches full song details (including download URL) by song ID. */
async function fetchJioSaavnSongDetails(songId) {
  try {
    const data = await fetchJioSaavn(`songs/${encodeURIComponent(songId)}`);
    if (Array.isArray(data) && data.length > 0) return data[0];
    return data;
  } catch (err) {
    console.warn(`[jiosaavn] song details failed for ${songId}: ${err.message}`);
    return null;
  }
}

/** Converts a JioSaavn song object to a playable track. */
function jioSaavnToTrack(song, requestedBy) {
  const downloadUrls = song.downloadUrl ?? [];
  // Prefer 320kbps, fallback to 160kbps, then any available
  const bestUrl = downloadUrls.find(d => d.quality === '320kbps')
    ?? downloadUrls.find(d => d.quality === '160kbps')
    ?? downloadUrls[0];

  const primaryArtists = song.artists?.primary ?? [];
  const author = primaryArtists.map(a => a.name).filter(Boolean).join(', ') || 'Unknown';

  const image = song.image ?? [];
  const thumbnail = image.find(i => i.quality === '500x500')?.url
    ?? image.find(i => i.quality === '150x150')?.url
    ?? null;

  return {
    title: song.name ?? song.title ?? 'Unknown',
    url: song.url ?? `https://www.jiosaavn.com/song/${song.id}`,
    videoId: song.id,
    duration: (song.duration ?? 0) * 1000,
    isLive: false,
    thumbnail,
    author,
    source: 'jiosaavn',
    audioUrl: bestUrl?.url ?? null,
    requestedBy,
  };
}

/* ------------------------------------------------------------------ */
/* SoundCloud                                                          */
/* ------------------------------------------------------------------ */

const SOUNDCLOUD_RE = /^https?:\/\/(www\.)?soundcloud\.com\/(.+)/;

/**
 * Resolves a SoundCloud URL to an array of playable YouTube tracks.
 * Uses yt-dlp to extract SoundCloud metadata (no API key needed),
 * then searches YouTube for matching streams.
 * Returns { tracks, playlistName, skipped, truncated }.
 */
export async function resolveSoundCloud(rawUrl, requestedBy) {
  const url = String(rawUrl).trim();
  const match = url.match(SOUNDCLOUD_RE);
  if (!match) throw new Error('That is not a valid SoundCloud link.');

  const { bin, pre } = getYtdlpBin();
  if (!existsSync(bin)) {
    throw new Error('yt-dlp is not installed — required for SoundCloud support.');
  }

  // Fetch metadata via yt-dlp
  const metadata = await new Promise((resolve, reject) => {
    const args = [
      ...pre,
      '-J',
      '--no-playlist',
      '--flat-playlist',
      '--dump-json',
      '--no-warnings',
      '--extractor-retries', '3',
      url,
    ];

    let stdout = '';
    let stderr = '';
    const proc = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });

    proc.stdout.on('data', (d) => { stdout += d.toString(); });
    proc.stderr.on('data', (d) => { stderr += d.toString(); });

    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code !== 0 || !stdout.trim()) {
        reject(new Error(stderr.trim().slice(0, 200) || `yt-dlp exited ${code}`));
        return;
      }
      try { resolve(JSON.parse(stdout)); } catch (e) { reject(e); }
    });

    setTimeout(() => {
      try { proc.kill('SIGKILL'); } catch {}
      reject(new Error('SoundCloud metadata fetch timed out after 15s.'));
    }, 15000);
  });

  /* Collect items ------------------------------------------------ */
  let items = [];
  let playlistName = null;

  if (metadata.entries && Array.isArray(metadata.entries)) {
    // Playlist or album
    playlistName = metadata.title ?? 'SoundCloud playlist';
    for (const entry of metadata.entries) {
      const parsed = readSoundCloudItem(entry);
      if (parsed) items.push(parsed);
    }
  } else if (metadata.title) {
    // Single track
    const parsed = readSoundCloudItem(metadata);
    if (parsed) items = [parsed];
  }

  if (items.length === 0) {
    throw new Error('No tracks found in that SoundCloud link.');
  }

  const truncated = items.length > MAX_PLAYLIST_TRACKS;
  if (truncated) items = items.slice(0, MAX_PLAYLIST_TRACKS);

  /* Search YouTube for each item --------------------------------- */
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
        source: 'soundcloud',
        title: video.title,
        soundcloudTitle: `${item.name}${item.artist ? ` — ${item.artist}` : ''}`,
        soundcloudUrl: item.url,
        requestedBy,
      });
    } catch (err) {
      console.warn(`[soundcloud] search failed for "${query}": ${err.message}`);
      skipped++;
    }
  }

  if (tracks.length === 0) {
    throw new Error('Could not find any of those tracks on YouTube.');
  }

  return { tracks, playlistName, skipped, truncated };
}

/** Normalises one SoundCloud entity into { name, artist, url }. */
function readSoundCloudItem(item) {
  if (!item) return null;
  const name = item.title ?? item.track?.title ?? null;
  if (!name) return null;

  const artist = item.uploader ?? item.artist ?? item.creator ?? item.channel ?? item.subtitle ?? '';
  const trackUrl = item.url ?? (item.webpage_url ? item.webpage_url : null);

  return {
    name: String(name).trim(),
    artist: String(artist || '').trim(),
    url: trackUrl,
  };
}

/* ------------------------------------------------------------------ */
/* YouTube                                                             */
/* ------------------------------------------------------------------ */

/** Runs a YouTube search and returns the first usable video, or null. */
async function searchYouTube(query) {
  const apiKey = process.env.YOUTUBE_API_KEY?.trim();
  console.log(`[resolver] searchYouTube: query="${query.substring(0, 50)}" apiKey=${apiKey ? 'set' : 'missing'}`);

  // Strategy 1: youtubei.js (direct, no relay)
  const ytResults = await ytSearch(query, 5);
  if (ytResults && ytResults.length > 0) {
    const video = ytResults[0];
    console.log(`[resolver] youtubei.js search found: "${video.title?.substring(0, 50)}"`);
    return {
      title: video.title || 'Unknown title',
      url: video.url || `https://www.youtube.com/watch?v=${video.id}`,
      videoId: video.id,
      duration: (Number(video.duration) || 0) * 1000,
      isLive: Boolean(video.isLive),
      thumbnail: video.thumbnail || `https://i.ytimg.com/vi/${video.id}/hqdefault.jpg`,
      author: video.author || 'Unknown',
      source: 'youtube',
    };
  }
  console.log('[resolver] youtubei.js search returned no results');

  // Strategy 2: YouTube Data API v3
  if (apiKey) {
    const video = await searchYouTubeAPI(query, apiKey);
    if (video) {
      console.log(`[resolver] API search found: "${video.title.substring(0, 50)}" thumbnail=${video.thumbnail?.substring(0, 60)}`);
      return video;
    }
    console.log('[resolver] API search returned no results');
  }

  // Strategy 3: youtube-sr (direct, may be blocked)
  console.log('[resolver] falling back to youtube-sr');
  const results = await YouTube.search(query, { limit: 5, type: 'video', safeSearch: false });
  if (!Array.isArray(results)) return null;

  const video = results.find((v) => v?.id && v?.title && !v?.private);
  if (!video) return null;

  const result = normaliseVideo(video);
  console.log(`[resolver] youtube-sr found: "${result.title.substring(0, 50)}" thumbnail=${result.thumbnail?.substring(0, 60)}`);
  return result;
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
    const title = item.snippet?.title?.trim() || 'Unknown title';
    // Use clean thumbnail URL without query parameters for Discord compatibility
    const thumbnail = `https://i.ytimg.com/vi/${videoId}/maxresdefault.jpg`;
    const author = item.snippet?.channelTitle?.trim() || 'Unknown';

    return {
      title,
      url: `https://www.youtube.com/watch?v=${videoId}`,
      videoId,
      duration: parseISO8601Duration(item.contentDetails?.duration) * 1000,
      isLive: false,
      thumbnail,
      author,
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

  const title = snippet.title?.trim() || 'Unknown title';
  // Use clean thumbnail URL without query parameters for Discord compatibility
  const thumbnail = `https://i.ytimg.com/vi/${videoId}/maxresdefault.jpg`;
  const author = snippet.channelTitle?.trim() || 'Unknown';

  return {
    title,
    url: `https://www.youtube.com/watch?v=${videoId}`,
    videoId,
    duration: 0,
    isLive: false,
    thumbnail,
    author,
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
  const durationMs = (Number(video.duration) || 0) * 1000;
  const title = video.title?.trim() || 'Unknown title';
  // Use clean thumbnail URL without query parameters for Discord compatibility
  const videoId = video.id;
  const thumbnail = videoId ? `https://i.ytimg.com/vi/${videoId}/maxresdefault.jpg` : null;
  const author = video.channel?.name?.trim() || 'Unknown';

  console.log(`[resolver] normaliseVideo: title="${title}" author="${author}" thumbnail=${thumbnail?.substring(0, 60)} videoId=${videoId}`);

  return {
    title,
    url: video.url || `https://www.youtube.com/watch?v=${videoId}`,
    videoId,
    duration: durationMs,
    isLive: Boolean(video.live) || durationMs === 0,
    thumbnail,
    author,
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
          thumbnail: `https://i.ytimg.com/vi/${entry.id}/maxresdefault.jpg`,
          author: entry.channel || entry.uploader || 'Unknown',
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
          thumbnail: e.thumbnail || `https://i.ytimg.com/vi/${e.id}/hqdefault.jpg`,
          author: e.author || 'Unknown',
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
    throw new Error('Only YouTube, Spotify, SoundCloud, and JioSaavn links are supported.');
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
  if (isSoundCloudURL(trimmed)) return resolveSoundCloud(trimmed, requestedBy);
  if (isJioSaavnURL(trimmed)) return resolveJioSaavn(trimmed, requestedBy);
  return resolveYouTube(trimmed, requestedBy);
}
