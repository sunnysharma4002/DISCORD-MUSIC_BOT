import * as playDL from 'play-dl';

/**
 * Spotify resolution service.
 *
 * Spotify tracks cannot be streamed directly (DRM). This module:
 *   1. Detects Spotify URLs (track / album / playlist)
 *   2. Fetches metadata via play-dl's Spotify module
 *   3. Searches YouTube for each track and returns YouTube track objects
 *
 * Requires Spotify credentials set via play-dl (auto-handled by play-dl
 * for limited usage; for production, set SPOTIFY_CLIENT_ID/SECRET env vars).
 */

const SPOTIFY_REGEX = /^https?:\/\/(?:open\.spotify\.com|spotify\.com)\/(?:track|album|playlist)\/([a-zA-Z0-9]+)/;

export function isSpotifyURL(url) {
  return SPOTIFY_REGEX.test(url);
}

export function isYouTubeURL(url) {
  return /(?:youtube\.com|youtu\.be)/.test(url);
}

/**
 * Resolves a Spotify URL into an array of YouTube track descriptors.
 * Each descriptor has: { title, url (YouTube), source: 'spotify-resolved', ... }
 */
export async function resolveSpotify(url) {
  const match = url.match(SPOTIFY_REGEX);
  if (!match) throw new Error('Invalid Spotify URL');

  const id = match[1];
  const type = url.includes('/track/') ? 'track'
    : url.includes('/album/') ? 'album'
    : url.includes('/playlist/') ? 'playlist'
    : null;

  if (!type) throw new Error('Unsupported Spotify URL type');

  // Ensure play-dl Spotify tokens are available
  await playDL.spotify_validate();

  let tracks = [];

  if (type === 'track') {
    const info = await playDL.spotify(url);
    tracks = [info];
  } else if (type === 'album') {
    const album = await playDL.spalbum(url);
    // fetch all tracks in album
    const details = await album.fetch();
    tracks = details.tracks;
  } else if (type === 'playlist') {
    const playlist = await playDL.playlist(url);
    const details = await playlist.fetch();
    tracks = details.tracks;
  }

  if (!tracks || tracks.length === 0) {
    throw new Error('No tracks found in this Spotify link.');
  }

  // Limit playlist/album to 50 tracks to avoid rate limits
  if (tracks.length > 50) tracks = tracks.slice(0, 50);

  const results = [];
  for (const track of tracks) {
    const query = `${track.name} ${track.artist?.name ?? ''}`.trim();
    const ytResults = await playDL.search(query, { limit: 1, source: { youtube: { limit: 1 } } });

    if (!ytResults || ytResults.length === 0) {
      console.warn(`[Spotify] No YouTube match for: ${query}`);
      continue;
    }

    const yt = ytResults[0];
    results.push({
      title: yt.title,
      url: yt.url,
      duration: yt.durationInSec ? yt.durationInSec * 1000 : 0,
      thumbnail: yt.thumbnail ?? yt.thumbnails?.[0]?.url ?? null,
      isLive: false,
      source: 'spotify-resolved',
      originalTitle: track.name,
      originalArtist: track.artist?.name ?? 'Unknown Artist',
    });
  }

  return results;
}

/**
 * Resolves a YouTube URL or search query into a single track descriptor.
 */
export async function resolveYouTube(query) {
  const isURL = /^https?:\/\//.test(query);

  let video;
  if (isURL) {
    const info = await playDL.search(query, { limit: 1 });
    video = info?.[0];
    if (!video) throw new Error('Could not fetch YouTube video info.');
  } else {
    const results = await playDL.search(query, { limit: 1, source: { youtube: { limit: 1 } } });
    video = results?.[0];
    if (!video) throw new Error('No YouTube results found for your query.');
  }

  return {
    title: video.title,
    url: video.url,
    duration: video.durationInSec ? video.durationInSec * 1000 : 0,
    thumbnail: video.thumbnail ?? video.thumbnails?.[0]?.url ?? null,
    isLive: !!video.isLive,
    source: 'youtube',
  };
}
