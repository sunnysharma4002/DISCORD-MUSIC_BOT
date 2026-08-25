# Discord Music Bot

A modular Discord music bot built with Discord.js v14, supporting YouTube, Spotify, and SoundCloud sources.

## Features

- **Slash Commands**: `/play`, `/skip`, `/stop`, `/pause`, `/resume`, `/queue`, `/nowplaying`
- **YouTube**: URL playback and search queries via `@distube/ytdl-core` + `play-dl`
- **Spotify**: Track, album, and playlist links — auto-resolved to YouTube streams
- **SoundCloud**: Track and playlist links — auto-resolved to YouTube streams
- **JioSaavn**: Track, album, and search — direct streaming (no YouTube needed)
- **Per-server queue**: Independent queue per guild with pagination
- **Loop modes**: off / track / queue (via code — extendable to slash command)
- **Auto-leave**: Leaves voice channel 30s after all humans depart
- **Stuck-track guard**: Auto-skips tracks that fail to start within 60s

## Required npm Dependencies

```
@discordjs/voice   — Discord voice connection & audio pipeline
@distube/ytdl-core — Reliable YouTube audio streaming (fork of ytdl-core)
discord.js         — Discord API wrapper (v14)
dotenv             — Environment variable management
play-dl            — YouTube search + Spotify metadata resolution
undici             — HTTP client for HLS live streams
```

## Setup Instructions

### 1. Prerequisites

- Node.js >= 20.18.1 (Node 22 LTS recommended). **Node 18 will not work** — the dependency stack requires Node 20+.
- A Discord application with a bot user
- Bot must have these permissions in your test server:
  - `Connect`, `Speak`, `Use Voice Activity` (voice)
  - `Send Messages`, `Embed Links` (text)
  - `Use Application Commands` (slash commands)

> **Hosting panel:** in Pterodactyl / Bot-Hosting, set the Node.js version in the **Startup** tab to `20` or `22` (Node 18 is EOL). If the bot crashes on boot with `ReferenceError: File is not defined` or `undici` errors, the panel is running Node 18 — change the version there.

### 2. Create Discord Bot & Get Credentials

1. Go to https://discord.com/developers/applications
2. Create a new application → Bot → Reset Token → Copy token
3. OAuth2 → Copy the **Client ID**
4. Go to your Discord server → right-click server name → Copy Server ID (this is GUILD_ID)
   - If you don't see "Copy Server ID", enable Developer Mode in User Settings → Advanced

### 3. Invite Bot to Server

Visit this URL (replace CLIENT_ID):
```
https://discord.com/api/oauth2/authorize?client_id=CLIENT_ID&permissions=3169280&scope=bot%20applications.commands
```

### 4. Install & Configure

```bash
cd "D:\Downloads\Discord music bot"
npm install

# Copy and fill environment variables
copy .env.example .env
# Edit .env and paste your DISCORD_TOKEN, CLIENT_ID, and GUILD_ID
```

### 5. Deploy Slash Commands

```bash
npm run deploy
```

This registers the slash commands once. If `GUILD_ID` is set in `.env`, commands appear instantly in that server. Without it, global registration takes up to 1 hour.

> **Note:** The bot also auto-registers commands on startup as a fallback.

**Stuck with stale commands?** The bot includes a `/deploy` command (server admins only). Once any command is registered, run `/deploy` in your server to force a refresh without touching the console. If the old behavior persists, restart your Discord client (Ctrl/Cmd + R).

### 6. Start the Bot

```bash
npm start
```

You should see:
```
[READY] YourBot#1234 is online.
[INFO]  Connected to 1 guild(s).
[INFO]  Slash commands registered.
```

### 7. (Optional) Spotify API Credentials

For more reliable Spotify metadata resolution, add Spotify API credentials:
1. Go to https://developer.spotify.com/dashboard
2. Create a new app
3. Copy the Client ID and Client Secret into `.env`:
```
SPOTIFY_CLIENT_ID=your_client_id
SPOTIFY_CLIENT_SECRET=your_client_secret
```
Without these, Spotify links fall back to embed-page scraping (still works, but less reliable).

### 8. (Optional) Vercel Relay — Bypass YouTube IP Blocks

If YouTube blocks your hosting IP, deploy the Vercel relay to route requests through Vercel's edge network:

1. **Deploy to Vercel:**
```bash
cd vercel-relay
vercel deploy --prod
```

2. **Update `.env`:**
```env
VERCEL_RELAY_URL=https://your-project.vercel.app
VERCEL_RELAY_KEY=your-secret-key  # optional
```

3. **What it covers:**
- YouTube search queries (bypasses search blocks)
- YouTube audio streaming (bypasses streaming blocks)
- Video metadata lookups

The relay uses `youtubei.js` (YouTube's official API client) to fetch data from Vercel's IP instead of your bot's IP.

### 9. (Optional) JioSaavn Support

JioSaavn is an Indian music streaming service. The bot can search and play songs directly from JioSaavn:
- **Search**: `/play <song name>` will search JioSaavn if no YouTube results are found
- **Direct URL**: Paste a JioSaavn song or album URL directly
- **No API key needed** — uses the public JioSaavn API

Example JioSaavn URLs:
- Song: `https://www.jiosaavn.com/song/kesariya/AgIAQyBeWlI`
- Album: `https://www.jiosaavn.com/album/brahmastra/xq4v9ZFC9iA_`

### 10. (Optional) YouTube Cookies

To avoid YouTube rate limits, generate cookies:
1. Log into YouTube in your browser
2. Open DevTools → Application → Cookies → copy the `youtube.com` cookies
3. Paste into `.env` as `YOUTUBE_COOKIES` (JSON format)

See: https://github.com/play-dl/play_dl/blob/master/play-dl/YouTube/README.md#using-cookies

## Audio Pipeline

```
User runs /play <query>
       │
        ├─ Spotify URL? ──► resolveSpotify() ──► fetch metadata ──► search YouTube per track
        │
        ├─ SoundCloud URL? ──► resolveSoundCloud() ──► yt-dlp metadata ──► search YouTube per track
        │
        ├─ JioSaavn URL / query? ──► resolveJioSaavn() ──► JioSaavn API ──► direct stream
        │
        └─ YouTube URL / text query ──► resolveYouTube() ──► play-dl search
                                       │
                                       ▼
                            Track object: { title, url, duration, thumbnail, isLive, source }
                                       │
                                       ▼
                            Player.playTrack(track)
                                       │
                    ┌──────────────────┴──────────────────┐
                    │                                     │
              YouTube stream                        Spotify-resolved
              via @distube/ytdl-core                (same — YouTube URL)
                    │                                     │
                    └──────────────────┬──────────────────┘
                                       ▼
                            createAudioResource(stream)
                                       │
                                       ▼
                            audioPlayer.play(resource)
                                       │
                                       ▼
                            VoiceConnection → Discord voice channel
                                       │
                            On AudioPlayerStatus.Idle ──► play next in queue
```

## Project Structure

```
index.js                  — Root entry (hosting panels start here)
src/
├── index.js              — Bot client, intents, voice cleanup, interaction dispatch
├── deploy-commands.js    — One-time slash command registration
├── commands/
│   ├── handler.js        — Auto-discovers and registers slash commands
│   ├── play.js           — /play command (YouTube + Spotify)
│   ├── skip.js / stop.js / pause.js / resume.js
│   ├── queue.js          — Paginated queue embed
│   └── nowplaying.js     — /nowplaying
├── voice/
│   └── Player.js         — Per-guild voice connection + queue manager
└── spotify/
    └── resolver.js       — Spotify → YouTube resolution service
.env.example              — Template for environment variables
package.json
```

## Troubleshooting

| Issue | Solution |
|-------|----------|
| `Required option "query" not found` / "You need to provide a song name or link" | Stale slash commands — set `GUILD_ID` in `.env`, run `npm run deploy`, then run `/deploy` in your server (or restart Discord) |
| "Nothing is playing" | Ensure bot is in the same voice channel as you |
| Commands not appearing | Run `npm run deploy` and check `GUILD_ID` is correct |
| YouTube rate limit (HTTP 429) | Add a `YOUTUBE_COOKIE` to `.env` |
| Spotify tracks not found | The embed scraper is rate-limited; wait a few seconds between requests |
| Bot leaves immediately | Check `Connect`/`Speak` permissions in the voice channel |
| No audio (bot joins but silent) | Run the bot once and check the `@discordjs/voice` dependency report at startup — `opusscript` and `libsodium-wrappers` must be present |

> **Global vs guild commands:** If `GUILD_ID` is empty, commands register **globally** and can take up to 1 hour to appear. Set `GUILD_ID` to a test server for instant registration.
