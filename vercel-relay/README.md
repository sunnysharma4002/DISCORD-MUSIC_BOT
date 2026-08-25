# Vercel Relay

Routes YouTube search and audio streaming through Vercel's edge network to bypass IP blocks.

## What it does

- **Search**: Proxies YouTube search queries through Vercel (bypasses search IP blocks)
- **Streaming**: Gets audio stream URLs from Invidious instances (bypasses streaming IP blocks)
- **Metadata**: Fetches video info through Vercel

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
?query=Kesariya&limit=5
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
?id=videoId&format=audio
```

Response:
```json
{
  "streamUrl": "https://invidious-instance.com/api/manifest/...",
  "mimeType": "audio/mp4",
  "bitrate": 128000,
  "source": "invidious"
}
```

## How it works

1. Bot requests search/stream through Vercel relay
2. Vercel uses Invidious instances (YouTube frontends) to fetch data
3. Invidious URLs are not IP-restricted like YouTube's direct URLs
4. Bot streams through Vercel/Invidious instead of YouTube directly

## Invidious instances

The relay tries multiple public Invidious instances:
- invidious.fdn.fr
- invidious.io.lol
- yewtu.be
- inv.tux.pizza
- vid.puffyan.us
- invidious.flokinet.to

If one is down, it falls back to the next.
