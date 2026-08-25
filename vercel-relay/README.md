# Vercel Relay

Routes YouTube search and audio streaming through Vercel using `youtubei.js` (pure JS YouTube client).

## What it does

- **Search**: Proxies YouTube search queries through Vercel (bypasses search IP blocks)
- **Streaming**: Gets YouTube audio URLs through Vercel (bypasses streaming IP blocks)
- **Metadata**: Fetches video info through Vercel

All requests to YouTube come from Vercel's IP addresses, not your bot's server IP.

## Deploy

### 1. Deploy to Vercel

```bash
cd vercel-relay
vercel deploy --prod
```

Or use the Vercel dashboard to import this folder.

### 2. Configure environment

In your Vercel project settings, optionally set:
- `RELAY_KEY` — basic auth key (recommended for production)

### 3. Update bot .env

```env
VERCEL_RELAY_URL=https://your-project.vercel.app
VERCEL_RELAY_KEY=your-secret-key
```

## Endpoints

### GET /api/search
Search YouTube videos.

```
?q=Kesariya&limit=5
```

Response:
```json
{
  "results": [
    {
      "id": "videoId",
      "title": "Song Title",
      "url": "https://youtube.com/watch?v=...",
      "duration": 180,
      "thumbnail": "https://...",
      "author": "Artist"
    }
  ]
}
```

### GET /api/video-info
Get video metadata.

```
?id=videoId
```

### GET /api/stream
Get audio stream URL for a video.

```
?id=videoId
```

Response:
```json
{
  "streamUrl": "https://rr5---sn-...",
  "mimeType": "audio/mp4",
  "bitrate": 128000,
  "source": "youtube"
}
```

## How it works

1. Bot requests search/stream through Vercel relay
2. Vercel uses `youtubei.js` (YouTube's own API) to fetch data
3. YouTube sees Vercel's IP, not your bot's IP
4. Bot streams directly using the URL from Vercel

## Why youtubei.js?

- Pure JavaScript — works in Vercel serverless functions
- Uses YouTube's official API (no scraping)
- No child processes needed
- More reliable than yt-dlp on serverless

## Dependencies

- `youtubei.js` — YouTube's internal API client (pure JS)
