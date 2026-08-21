import {
  joinVoiceChannel,
  getVoiceConnection,
  createAudioPlayer,
  createAudioResource,
  StreamType,
  AudioPlayerStatus,
  VoiceConnectionStatus,
  NoSubscriberBehavior,
  entersState,
} from '@discordjs/voice';
import { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import { spawn } from 'node:child_process';
import { existsSync, writeFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { PassThrough } from 'node:stream';
import { get } from 'node:https';
import { constants as ytdlpConstants } from 'youtube-dl-exec';
import { YouTube } from 'youtube-sr';

// Path to the standalone (python-free) yt-dlp fetched by scripts/setup-ytdlp.mjs.
// Project root is two levels up from src/voice/.
const _projectRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const _vendoredYtdlp = join(_projectRoot, 'vendor', 'yt-dlp');

// yt-dlp binary resolution order:
//   1. YTDLP_CMD env override (e.g. "yt-dlp" or "python -m yt_dlp")
//   2. vendor/yt-dlp — standalone PyInstaller build, no python needed (Railway)
//   3. youtube-dl-exec bundled zipapp — needs python3, fine on Windows/dev
// The bundled zipapp fails on Railway (no python3), hence the vendored fallback.
let _ytdlpLogged = false;
function ytdlpCmd() {
  const override = (process.env.YTDLP_CMD || '').trim();
  let bin, pre;
  if (override) {
    [bin, ...pre] = override.split(/\s+/);
  } else if (existsSync(_vendoredYtdlp)) {
    bin = _vendoredYtdlp;
    pre = [];
  } else {
    bin = ytdlpConstants.YOUTUBE_DL_PATH; // absolute path to bundled binary
    pre = [];
  }

  // Verify binary exists and is accessible
  if (!existsSync(bin)) {
    console.error(`[player] ERROR: yt-dlp binary not found at ${bin}`);
    console.error(`[player] Available paths: vendor/yt-dlp=${existsSync(_vendoredYtdlp)}, bundled=${existsSync(ytdlpConstants.YOUTUBE_DL_PATH)}`);
  } else {
    try {
      const stats = statSync(bin);
      console.log(`[player] yt-dlp binary exists: ${bin} (${stats.size} bytes, mode=${stats.mode})`);
    } catch (e) {
      console.error(`[player] ERROR: cannot stat yt-dlp binary: ${e.message}`);
    }
  }

  if (!_ytdlpLogged) {
    console.log(`[player] using yt-dlp: ${bin}`);
    _ytdlpLogged = true;
  }
  return { bin, pre };
}

// Anti-bot ("Sign in to confirm you're not a bot") mitigation.
// YouTube blocks datacenter IPs (Railway) unless the request carries cookies
// and/or uses a mobile client. These args are appended to every yt-dlp call.
//
// Cookies (best fix — from a logged-in account) via either:
//   YOUTUBE_COOKIE_FILE = absolute path to a Netscape cookies.txt
//   YOUTUBE_COOKIES     = full cookies.txt *contents* (Railway var; written to /tmp)
// Client spoofing helps even without cookies and is always applied.
let _cookieFileCache; // undefined = not resolved, null = none, string = path
function resolveCookieFile() {
  logEnvState();
  if (_cookieFileCache !== undefined) return _cookieFileCache;

  if (process.env.YOUTUBE_COOKIE_FILE && existsSync(process.env.YOUTUBE_COOKIE_FILE)) {
    _cookieFileCache = process.env.YOUTUBE_COOKIE_FILE;
  } else if (process.env.YOUTUBE_COOKIES) {
    try {
      const p = join(tmpdir(), 'yt-cookies.txt');
      let contents = process.env.YOUTUBE_COOKIES;
      // Netscape files must start with this header line or yt-dlp rejects them.
      if (!contents.startsWith('# Netscape') && !contents.startsWith('# HTTP')) {
        contents = '# Netscape HTTP Cookie File\n' + contents;
      }
      writeFileSync(p, contents);
      _cookieFileCache = p;
      console.log('[player] wrote YouTube cookies from env to', p);
    } catch (err) {
      console.warn('[player] failed to write cookies from env:', err.message);
      _cookieFileCache = null;
    }
  } else {
    _cookieFileCache = null;
  }
  return _cookieFileCache;
}

/** Shared yt-dlp args to dodge YouTube's bot check. */
function antiBotArgs() {
  const cookies = resolveCookieFile();
  console.log(`[player] antiBotArgs: cookies=${cookies || 'none (using player_client fallback)'}`);

  const args = [
    // Try multiple player clients — mobile/TV clients are less aggressively checked.
    '--extractor-args', 'youtube:player_client=ios,android,tv_embedded',
    // Skip HLS formats (often require additional auth)
    '--extractor-args', 'youtube:player_skip=hls',
    // Aggressive retries
    '--extractor-retries', '5',
    '--retry-sleep', 'extractor:3',
    // Fake referer to look like embedded player
    '--referer', 'https://www.youtube.com/',
    // Skip certificate verification (helps with some proxy setups)
    '--no-check-certificate',
    // Prefer formats that work better with datacenter IPs
    '--format-sort', 'hasaudiorate,hasvideorate,source,codec:vp9.2,avc1',
    // Add headers to look like a real browser
    '--add-header', 'Origin:https://www.youtube.com',
    '--add-header', 'User-Agent:Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1',
  ];
  if (cookies) {
    args.push('--cookies', cookies);
    console.log('[player] Using cookies for authentication');
  } else {
    console.log('[player] No cookies - relying on player_client spoofing only');
  }
  return args;
}

// Debug: log env var presence on first call
let _envLogged = false;
function logEnvState() {
  if (_envLogged) return;
  _envLogged = true;
  const hasFile = !!process.env.YOUTUBE_COOKIE_FILE;
  const hasCookies = !!process.env.YOUTUBE_COOKIES;
  const cookiesLen = process.env.YOUTUBE_COOKIES?.length || 0;
  console.log(`[player] env check: YOUTUBE_COOKIE_FILE=${hasFile}, YOUTUBE_COOKIES=${hasCookies} (len=${cookiesLen})`);
}

const STUCK_TIMEOUT_MS = 30_000;   // no audio started within this window → skip
const EMPTY_QUEUE_LEAVE_MS = 120_000; // idle with empty queue → leave

/** Embed color themes. */
const THEMES = {
  default: { name: 'Default', color: 0x5865f2 },
  night: { name: 'Night', color: 0x2b2d31 },
  fire: { name: 'Fire', color: 0xff4500 },
  ocean: { name: 'Ocean', color: 0x00b4d8 },
  forest: { name: 'Forest', color: 0x2d6a4f },
  rose: { name: 'Rose', color: 0xff6b9d },
  gold: { name: 'Gold', color: 0xffd700 },
  void: { name: 'Void', color: 0x000000 },
};

/**
 * Per-guild music player.
 *
 * Audio pipeline:
 *   yt-dlp (bestaudio) ──► stdout ──► createAudioResource(StreamType.Arbitrary)
 *                          └─ prism-media + ffmpeg transcode to opus
 *   AudioPlayer ──► VoiceConnection ──► Discord
 */
export class Player {
  constructor(client, guildId) {
    this.client = client;
    this.guildId = guildId;

    this.queue = [];

    // Test yt-dlp on startup
    this._testYtdlp();

    // Test YouTube extraction with cookies
    this._testYouTubeExtraction();
    this.current = null;
    this.history = [];

    this.connection = null;
    this.voiceChannelId = null;
    this.textChannelId = null;

    this.loop = 'off';        // 'off' | 'track' | 'queue'
    this.autoplay = false;    // auto-search related when queue empties
    this.theme = 'default';   // embed color theme
    this.destroyed = false;
    this.controlPanelMessageId = null; // persistent control panel message ID
    this._progressInterval = null; // periodic progress update for control panel

    this._stuckTimer = null;
    this._idleLeaveTimer = null;
    this.emptyChannelTimeout = null;
    this._advancing = false;  // guards against double-advance races

    this.audioPlayer = createAudioPlayer({
      behaviors: { noSubscriber: NoSubscriberBehavior.Play },
    });

    // Log all audio player state changes for debugging
    this.audioPlayer.on('stateChange', (oldState, newState) => {
      console.log(`[audio] state: ${oldState.status} → ${newState.status}`);
    });

    this.audioPlayer.on(AudioPlayerStatus.Playing, () => {
      console.log('[audio] now Playing');
      this._clearStuckTimer();
    });

    this.audioPlayer.on(AudioPlayerStatus.Idle, () => {
      this._clearStuckTimer();
      this._advance().catch((err) => console.error('[player] advance error:', err));
    });

    this.audioPlayer.on('error', (err) => {
      console.error(`[player] audio error on "${this.current?.title}":`, err.message);
      console.error(`[player] connection state: ${this.connection?.state.status ?? 'null'}`);
      console.error(`[player] audioPlayer state: ${this.audioPlayer.state.status}`);
      this._notify(`⚠️ Playback error on **${this.current?.title ?? 'track'}** — skipping.`);
      // 'error' is followed by Idle, which triggers _advance()
    });
  }

  /** Test yt-dlp binary on startup */
  _testYtdlp() {
    const { bin, pre } = ytdlpCmd();
    console.log(`[player] testing yt-dlp binary: ${bin}`);

    const proc = spawn(bin, [...pre, '--version'], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (d) => { stdout += d.toString(); });
    proc.stderr.on('data', (d) => { stderr += d.toString(); });

    proc.on('close', (code) => {
      if (code === 0) {
        console.log(`[player] yt-dlp version: ${stdout.trim()}`);
      } else {
        console.error(`[player] yt-dlp test FAILED (code ${code}): ${stderr.trim() || stdout.trim()}`);
        console.error(`[player] Check that the binary is executable and your host allows outbound connections to YouTube.`);
      }
    });

    proc.on('error', (err) => {
      console.error(`[player] yt-dlp test ERROR: ${err.message}`);
    });

    // Timeout after 5s
    setTimeout(() => {
      try { proc.kill('SIGKILL'); } catch {}
    }, 5000);

    // Test Invidious connectivity
    this._testInvidious();
  }

  /** Test YouTube extraction without cookies */
  _testYouTubeExtraction() {
    const { bin, pre } = ytdlpCmd();
    const cookies = resolveCookieFile();
    const proxies = this._getProxies();

    console.log(`[player] testing YouTube extraction (cookies=${cookies ? 'yes' : 'no'}, proxies=${proxies.length})`);

    const testUrl = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';

    // Test without cookies and without proxy first
    const args = [
      ...pre,
      '-J',
      '--no-playlist',
      '--no-warnings',
      '--extractor-args', 'youtube:player_client=ios,android,tv_embedded',
      '--extractor-retries', '3',
      testUrl,
    ];

    const proc = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (d) => { stdout += d.toString(); });
    proc.stderr.on('data', (d) => { stderr += d.toString(); });

    proc.on('close', (code) => {
      if (code === 0) {
        try {
          const info = JSON.parse(stdout);
          console.log(`[player] ✓ YouTube extraction OK (direct): "${info.title}"`);
        } catch (e) {
          console.log(`[player] ✓ YouTube extraction OK (direct, metadata fetched)`);
        }
      } else {
        console.error(`[player] ✗ YouTube extraction FAILED (direct, code ${code})`);
        console.error(`[player] stderr: ${stderr.trim().substring(0, 300)}`);

        if (stderr.includes('Sign in to confirm') && proxies.length > 0) {
          console.log('[player] YouTube requires authentication. Testing first 3 proxies...');

          // Test first 3 proxies quickly
          let tested = 0;
          for (const proxy of proxies.slice(0, 3)) {
            console.log(`[player] Testing proxy: ${proxy}`);
            const proxyArgs = [...pre, '-J', '--no-playlist', '--no-warnings', '--proxy', proxy, '--extractor-args', 'youtube:player_client=ios', testUrl];
            const proc2 = spawn(bin, proxyArgs, { stdio: ['ignore', 'pipe', 'pipe'] });
            let out2 = '';
            let err2 = '';
            proc2.stdout.on('data', (d) => { out2 += d.toString(); });
            proc2.stderr.on('data', (d) => { err2 += d.toString(); });
            proc2.on('close', (code2) => {
              tested++;
              if (code2 === 0) {
                console.log(`[player] ✓ Proxy ${proxy} WORKS!`);
              } else {
                console.error(`[player] ✗ Proxy ${proxy} FAILED (code ${code2})`);
              }
              if (tested >= 3) {
                console.error('[player] SOLUTION: Set YTDLP_PROXIES env var with working proxies');
                console.error('[player] Format: host:port:username:password,host2:port2:username2:password2');
              }
            });
            setTimeout(() => { try { proc2.kill('SIGKILL'); } catch {} }, 8000);
          }
        } else if (proxies.length === 0) {
          console.error('[player] No proxies configured. Set YTDLP_PROXIES env var.');
          console.error('[player] Format: host:port:username:password,host2:port2:username2:password2');
        }
      }
    });

    proc.on('error', (err) => {
      console.error(`[player] YouTube extraction ERROR: ${err.message}`);
    });

    setTimeout(() => { try { proc.kill('SIGKILL'); } catch {} }, 15000);
  }

  /** Test Invidious instances connectivity */
  _testInvidious() {
    const invidiousInstances = [
      'https://pipedapi.adminforge.de',
      'https://pipedapi.in.projectsegfau.lt',
      'https://pipedapi.drgns.space',
      'https://yewtu.be',
      'https://inv.riverside.rocks',
      'https://invidious.tiekoetter.com',
    ];

    console.log('[player] testing Invidious instances...');
    for (const instance of invidiousInstances) {
      const url = new URL(instance);
      const req = get({
        hostname: url.hostname,
        path: '/api/v1/videos/dQw4w9WgXcQ',
        headers: { 'User-Agent': 'discord-music-bot' },
      }, (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          if (res.statusCode === 200 && data.length > 0) {
            console.log(`[player] Invidious OK: ${instance} (${res.statusCode})`);
          } else {
            console.warn(`[player] Invidious FAIL: ${instance} (${res.statusCode})`);
          }
        });
      });
      req.on('error', (err) => {
        console.warn(`[player] Invidious ERROR: ${instance} - ${err.message}`);
      });
      req.setTimeout(5000, () => {
        console.warn(`[player] Invidious TIMEOUT: ${instance}`);
        req.destroy();
      });
    }
  }

  /* ---------------------------------------------------------------- */
  /* Voice connection                                                  */
  /* ---------------------------------------------------------------- */

  async connect(voiceChannel, textChannel) {
    this.textChannelId = textChannel?.id ?? this.textChannelId;

    if (this.connection && this.voiceChannelId === voiceChannel.id) {
      return this.connection;
    }

    // @discordjs/voice REUSES a tracked connection for the guild — even a broken
    // one left in `Disconnected`. That reuse is a common cause of a permanent
    // "timed out" connect. Force a clean slate before joining.
    const stale = getVoiceConnection(this.guildId);
    if (stale && stale !== this.connection) {
      console.warn('[voice] Found stale tracked connection — destroying it before rejoin.');
      try { stale.destroy(); } catch {}
    }

    const connection = joinVoiceChannel({
      channelId: voiceChannel.id,
      guildId: this.guildId,
      adapterCreator: voiceChannel.guild.voiceAdapterCreator,
      selfDeaf: true,
    });

    this.connection = connection;
    this.voiceChannelId = voiceChannel.id;

    // Capture the REAL reason the connection failed (permission errors, etc.)
    // instead of only reporting a generic timeout.
    this._connectError = null;
    connection.on('error', (err) => {
      this._connectError = err;
      const code = err?.rawError?.code ?? err?.code;
      const msg = err?.rawError?.message ?? err?.message ?? 'unknown error';
      console.error(`[voice] connection error (code ${code ?? '?'}):`, msg);
    });

    connection.subscribe(this.audioPlayer);
    console.log(`[voice] audioPlayer subscribed to connection (guild: ${this.guildId})`);

    // Log every state transition — tells us WHERE it gets stuck.
    //   Signalling → Connecting → Ready   = healthy
    //   stuck in Signalling               = voice server update never arrived (gateway)
    //   stuck in Connecting               = UDP socket couldn't complete (host blocks UDP)
    connection.on('stateChange', (oldState, newState) => {
      if (oldState.status !== newState.status) {
        console.log(`[voice] state: ${oldState.status} → ${newState.status}`);
        // Re-subscribe on Ready to ensure audio pipe is connected
        if (newState.status === VoiceConnectionStatus.Ready) {
          console.log(`[voice] re-subscribing audioPlayer`);
          connection.subscribe(this.audioPlayer);
        }
      }
    });

    // Don't auto-destroy while we're still waiting for the initial Ready state —
    // a transient disconnect during handshake would otherwise nuke the connect.
    let connecting = true;
    connection.on(VoiceConnectionStatus.Disconnected, async () => {
      if (connecting) {
        console.warn('[voice] Disconnected during initial connect — waiting for reconnection.');
        return;
      }
      try {
        // Could be a region move — wait to see if it reconnects
        await Promise.race([
          entersState(connection, VoiceConnectionStatus.Signalling, 5_000),
          entersState(connection, VoiceConnectionStatus.Connecting, 5_000),
        ]);
      } catch {
        this.destroy();
      }
    });

    connection.subscribe(this.audioPlayer);

    try {
      await entersState(connection, VoiceConnectionStatus.Ready, 60_000);
    } catch {
      const lastState = connection.state.status;
      const err = this._connectError;
      this._connectError = null;
      connecting = false;

      console.warn(`[voice] Never reached Ready — last state: ${lastState}`);

      this.destroy();

      if (err) {
        throw new Error(this._friendlyConnectError(err, voiceChannel));
      }
      throw new Error(
        lastState === VoiceConnectionStatus.Connecting || lastState === VoiceConnectionStatus.Signalling
          ? 'Could not connect to the voice channel (stuck while handshaking). This usually means the hosting ' +
            'provider blocks Discord voice traffic — a normal host (not game hosting) is required for a music bot.'
          : 'Could not connect to the voice channel (timed out).',
      );
    }

    connecting = false;
    return connection;
  }

  _friendlyConnectError(err, voiceChannel) {
    const code = err?.rawError?.code ?? err?.code;
    const msg = String(err?.rawError?.message ?? err?.message ?? '');

    if (code === 4004 || code === 4014 || /permission|no permission/i.test(msg)) {
      return (
        `I can't join <#${voiceChannel.id}> — I'm missing the **Connect** permission there. ` +
        'Give the bot `Connect`/`Speak` (or a role with them) for that voice channel, then try again.'
      );
    }
    if (code === 4005 || /not connected/i.test(msg)) {
      return `Voice session got interrupted — try again in a moment.`;
    }
    return (
      `Could not join <#${voiceChannel.id}> (code ${code ?? '?'}: ${msg.slice(0, 120) || 'unknown error'}). ` +
      'Check the bot has `Connect`/`Speak` permissions and the channel isn\'t full.'
    );
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;

    this._clearStuckTimer();
    this._stopProgressUpdates();
    if (this._idleLeaveTimer) clearTimeout(this._idleLeaveTimer);
    if (this.emptyChannelTimeout) clearTimeout(this.emptyChannelTimeout);

    this.queue = [];
    this.current = null;
    this.controlPanelMessageId = null;

    try { this.audioPlayer.stop(true); } catch {}
    try { this._activeProc?.kill('SIGKILL'); } catch {}
    try { this.connection?.destroy(); } catch {}

    this.connection = null;
    this.client.players.delete(this.guildId);
  }

  /* ---------------------------------------------------------------- */
  /* Queue control                                                     */
  /* ---------------------------------------------------------------- */

  get isPlaying() {
    return (
      this.audioPlayer.state.status === AudioPlayerStatus.Playing ||
      this.audioPlayer.state.status === AudioPlayerStatus.Buffering
    );
  }

  get isPaused() {
    return (
      this.audioPlayer.state.status === AudioPlayerStatus.Paused ||
      this.audioPlayer.state.status === AudioPlayerStatus.AutoPaused
    );
  }

  enqueue(tracks) {
    this.queue.push(...tracks);
    this._cancelIdleLeave();
  }

  /** Starts playback if nothing is currently playing. */
  async start() {
    if (this.current || this.isPlaying || this.isPaused) return;
    await this._advance();
  }

  skip() {
    if (!this.current) return false;
    this.audioPlayer.stop(true); // fires Idle → _advance()
    return true;
  }

  stop() {
    this.queue = [];
    this.loop = 'off';
    this.current = null;
    this.audioPlayer.stop(true);
  }

  pause() {
    return this.audioPlayer.pause(true);
  }

  resume() {
    return this.audioPlayer.unpause();
  }

  setLoop(mode) {
    this.loop = mode;
  }

  shuffle() {
    for (let i = this.queue.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [this.queue[i], this.queue[j]] = [this.queue[j], this.queue[i]];
    }
  }

  remove(index) {
    if (index < 0 || index >= this.queue.length) return null;
    return this.queue.splice(index, 1)[0];
  }

  /** Milliseconds of the current track already played. */
  get playbackMs() {
    const state = this.audioPlayer.state;
    return state.status === AudioPlayerStatus.Idle
      ? 0
      : (state.resource?.playbackDuration ?? 0);
  }

  /* ---------------------------------------------------------------- */
  /* Playback                                                          */
  /* ---------------------------------------------------------------- */

  async _advance() {
    if (this.destroyed || this._advancing) return;
    this._advancing = true;

    try {
      const finished = this.current;

      let next;
      if (this.loop === 'track' && finished) {
        next = finished;
      } else {
        if (finished) {
          this.history.push(finished);
          if (this.history.length > 50) this.history.shift();
          if (this.loop === 'queue') this.queue.push(finished);
        }
        next = this.queue.shift() ?? null;
      }

      if (!next) {
        this.current = null;

        // Autoplay: search for a related track when queue is empty
        if (this.autoplay && finished) {
          const related = await this._searchRelated(finished);
          if (related) {
            this.current = null;
            this.enqueue([related]);
            this._cancelIdleLeave();
            this._advancing = false;
            await this._advance();
            return;
          }
        }

        this._scheduleIdleLeave();
        return;
      }

      this.current = next;
      await this._play(next);
    } finally {
      this._advancing = false;
    }
  }

  async _play(track) {
    if (this.destroyed) {
      console.warn('[player] _play called but player is destroyed');
      return;
    }

    // Ensure voice connection is ready before playing
    if (!this.connection || this.connection.state.status !== VoiceConnectionStatus.Ready) {
      console.warn(`[player] connection not ready (status: ${this.connection?.state?.status ?? 'null'}), waiting...`);
      if (this.connection) {
        try {
          await entersState(this.connection, VoiceConnectionStatus.Ready, 10_000);
          console.log('[player] connection ready, proceeding');
        } catch (err) {
          throw new Error('Voice connection not ready — make sure the bot is in a voice channel.');
        }
      } else {
        throw new Error('No voice connection — use /play in a voice channel.');
      }
    }

    try {
      console.log(`[player] creating resource for "${track.title?.substring(0, 50)}"`);
      const resource = await this._createResource(track);
      console.log(`[player] resource created, playing. connection=${!!this.connection} state=${this.connection?.state?.status}`);

      // Re-subscribe right before playing to ensure audio pipe is connected
      if (this.connection) {
        this.connection.subscribe(this.audioPlayer);
        console.log(`[player] re-subscribed audioPlayer to connection`);
      }

      this.audioPlayer.play(resource);
      console.log(`[player] audioPlayer state after play: ${this.audioPlayer.state.status}`);
      this._startStuckTimer(track);
      this._cancelIdleLeave();
      this._startProgressUpdates();
      this._notifyNowPlaying(track);
    } catch (err) {
      console.error(`[player] failed to stream "${track.title}":`, err.message);
      this._notify(
        `❌ Couldn't play **${track.title}** — ${this._friendlyError(err)}` +
        (this.queue.length ? ' Skipping to the next track.' : '')
      );
      // Manually continue since no Idle event will fire
      this.current = null;
      await this._advance();
    }
  }

  /**
   * Searches YouTube for a track related to the finished one (autoplay).
   * Uses history of played songs to find better matches.
   * Returns a youtube-sr Video or null on failure.
   */
  async _searchRelated(finished) {
    try {
      // Build a smarter query using recent history for better recommendations
      const recentTracks = [finished, ...this.history.slice(-5)].filter(t => t);
      const allAuthors = recentTracks.map(t => t.author).filter(a => a && a !== 'Unknown');
      const allGenres = new Set();

      // Detect genre/style from recent tracks
      for (const track of recentTracks) {
        const title = (track.title || '').toLowerCase();
        const author = (track.author || '').toLowerCase();

        // Check for common genre keywords
        const genres = ['rock', 'pop', 'hip hop', 'rap', 'electronic', 'edm', 'dance',
          'country', 'jazz', 'classical', 'metal', 'indie', 'r&b', 'soul', 'funk',
          'reggae', 'blues', 'folk', 'punk', 'alternative', 'lofi', 'chill'];
        for (const g of genres) {
          if (title.includes(g) || author.includes(g)) {
            allGenres.add(g);
          }
        }
      }

      // Build query: prefer artist name + genre if available
      let query = '';
      const mostCommonAuthor = allAuthors.length > 0
        ? allAuthors.sort((a, b) => allAuthors.filter(v => v === a).length - allAuthors.filter(v => v === b).length).pop()
        : null;

      if (mostCommonAuthor && allGenres.size > 0) {
        // Same artist + similar genre
        const genre = [...allGenres][0];
        query = `${mostCommonAuthor} ${genre}`;
      } else if (mostCommonAuthor) {
        // Same artist style
        query = `${mostCommonAuthor} songs`;
      } else if (allGenres.size > 0) {
        // Similar genre mix
        const genre = [...allGenres].slice(0, 2).join(' ');
        query = `${genre} mix 2024`;
      } else if (finished.author && finished.author !== 'Unknown') {
        query = `${finished.author} mix`;
      } else if (finished.title && finished.title !== 'YouTube video') {
        query = finished.title
          .replace(/\(.*?\)|\[.*?\]|Official|Music Video|Lyrics|Audio|Remix|Cover/gi, '')
          .replace(/\s+/g, ' ')
          .trim()
          .slice(0, 60);
        if (query) query += ' songs';
      }

      if (!query) query = 'popular music mix 2024';

      console.log(`[player] autoplay query: "${query}" (from ${recentTracks.length} recent tracks)`);

      const results = await YouTube.search(query, { limit: 15, type: 'video' });
      if (!Array.isArray(results) || results.length === 0) return null;

      // Filter out already played tracks (check last 20 in history + current)
      const playedIds = new Set([
        ...(this.history.slice(-20).map(t => t.videoId)),
        ...(recentTracks.map(t => t.videoId)),
      ]);

      const candidates = results.filter(v => v?.id && !playedIds.has(v.id));
      if (candidates.length === 0) return null;

      // Pick the highest quality result (prefer videos with duration > 2 min)
      const goodCandidates = candidates.filter(v => (v.duration || 0) > 120);
      const pick = goodCandidates.length > 0
        ? goodCandidates[Math.floor(Math.random() * goodCandidates.length)]
        : candidates[Math.floor(Math.random() * candidates.length)];

      return {
        title: pick.title ?? 'Unknown title',
        url: pick.url ?? `https://www.youtube.com/watch?v=${pick.id}`,
        videoId: pick.id,
        duration: (Number(pick.duration) || 0) * 1000, // youtube-sr returns seconds
        isLive: Boolean(pick.live),
        thumbnail: pick.thumbnail?.url ?? `https://i.ytimg.com/vi/${pick.id}/hqdefault.jpg`,
        author: pick.channel?.name ?? 'Unknown',
        source: 'youtube',
        requestedBy: finished.requestedBy,
      };
    } catch (err) {
      console.warn('[player] autoplay search failed:', err.message);
      return null;
    }
  }

  /**
   * Builds an AudioResource for a track by streaming the best audio via yt-dlp.
   * yt-dlp writes the raw audio to stdout; @discordjs/voice + ffmpeg transcode
   * it to opus (StreamType.Arbitrary).
   *
   * Retries with fallback player clients if YouTube returns a bot check.
   */
  async _createResource(track) {
    const url = track.url ?? `https://www.youtube.com/watch?v=${track.videoId}`;
    console.log(`[player] _createResource called: title="${track.title?.substring(0, 50)}" url="${url?.substring(0, 60)}" videoId="${track.videoId}"`);

    // Enrich metadata (title/duration/author) if missing — best-effort, non-fatal.
    if (!track.duration || !track.author || track.title === 'YouTube video') {
      console.log(`[player] enriching metadata for "${track.title}"`);
      try {
        await this._enrichMetadata(track, url);
      } catch (err) {
        console.warn('[player] metadata fetch failed:', err.message);
      }
    }

    const { bin, pre } = ytdlpCmd();
    console.log(`[player] using bin="${bin}" pre=${JSON.stringify(pre)}`);

    // Proxy support: try multiple proxies from env var
    const proxies = this._getProxies();
    console.log(`[player] loaded ${proxies.length} proxies: ${proxies.slice(0, 3).join(', ')}${proxies.length > 3 ? '...' : ''}`);

    // Invidious/Piped instances — alternative YouTube frontends that bypass CDN blocks.
    // Only working instances (tested 2026-08-21):
    const invidiousInstances = [
      // Working Piped instances
      'https://pipedapi.adminforge.de',
      'https://pipedapi.in.projectsegfau.lt',
      'https://pipedapi.drgns.space',
      // Working Invidious instances
      'https://yewtu.be',
      'https://inv.riverside.rocks',
      'https://invidious.tiekoetter.com',
    ];

    // Build extraction order: third-party first (no proxy needed), then YouTube direct
    const allAttempts = [];

    // PHASE 1: Third-party (Invidious/Piped) — bypass YouTube CDN, no proxy needed
    const thirdPartyExtractors = invidiousInstances.map(instance => {
      const url = new URL(instance);
      if (url.hostname.includes('pipedapi')) {
        return ['--extractor-args', `youtube:player_client=web`];
      }
      return ['--extractor-args', `youtube:instance=${instance}`];
    });
    allAttempts.push({
      phase: 'third-party',
      proxy: null,
      extractorSets: thirdPartyExtractors,
      formatSelectors: ['bestaudio/best'],
    });

    // PHASE 2: Direct YouTube with cookies — bypass bot check with auth
    const hasCookies = !!resolveCookieFile();
    if (hasCookies) {
      allAttempts.push({
        phase: 'youtube-cookies',
        proxy: null,
        extractorSets: [
          antiBotArgs(),
        ],
        formatSelectors: ['bestaudio/best'],
      });
    }

    // PHASE 3: Direct YouTube without cookies — try different clients
    const fallbackExtractors = [
      ['--extractor-args', 'youtube:player_client=ios', '--extractor-retries', '5'],
      ['--extractor-args', 'youtube:player_client=android', '--extractor-retries', '5'],
      ['--extractor-args', 'youtube:player_client=tv_embedded', '--extractor-retries', '5'],
    ];
    allAttempts.push({
      phase: 'youtube-no-cookies',
      proxy: null,
      extractorSets: fallbackExtractors,
      formatSelectors: ['bestaudio/best'],
    });

    // PHASE 4: Each proxy with direct YouTube extractors
    for (const proxy of proxies) {
      allAttempts.push({
        phase: 'proxy',
        proxy,
        extractorSets: [
          ['--extractor-args', 'youtube:player_client=ios', '--extractor-retries', '5'],
          ['--extractor-args', 'youtube:player_client=web', '--extractor-retries', '5'],
        ],
        formatSelectors: ['bestaudio/best'],
      });
    }

    for (let attemptIdx = 0; attemptIdx < allAttempts.length; attemptIdx++) {
      const { phase, proxy, extractorSets: sets, formatSelectors } = allAttempts[attemptIdx];
      const proxyArgs = proxy ? ['--proxy', proxy] : [];

      console.log(`[player] === Phase ${attemptIdx+1}/${allAttempts.length}: ${phase}${proxy ? ' (proxy=' + proxy.substring(0, 40) + '...)' : ''} ===`);

      for (let setIdx = 0; setIdx < sets.length; setIdx++) {
        for (const format of formatSelectors) {
          const args = [
            '-f', format,
            '--no-playlist',
            '--quiet',
            '--no-warnings',
            ...proxyArgs,
            '-o', '-',
            ...sets[setIdx],
            url,
          ];
          console.log(`[player] trying format=${format} extractor=${JSON.stringify(sets[setIdx]).substring(0, 60)}...`);
          const result = await this._trySpawnStream(bin, pre, track, url, args);

          if (result) {
            console.log(`[player] SUCCESS in phase: ${phase}!`);
            return result;
          }
        }

        if (setIdx < sets.length - 1) {
          await new Promise(r => setTimeout(r, 500));
        }
      }

      console.log(`[player] phase ${phase} failed, moving to next...`);
    }

    throw new Error('All extraction attempts failed. Try: 1) Add fresh proxies to YTDLP_PROXIES env var, 2) Use fresh YOUTUBE_COOKIES, or 3) Switch hosting provider.');
  }

  /** Try spawning yt-dlp and return the AudioResource, or null on failure. */
  async _trySpawnStream(bin, pre, track, url, args) {
    return new Promise((resolve) => {
      console.log(`[player] spawning: ${bin} ${args.slice(0, 3).join(' ')}...`);
      const proc = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });

      let stderr = '';
      let startTime = Date.now();
      let resourceCreated = false;
      let dataChunks = [];
      let totalBytes = 0;
      const MIN_BYTES = 64 * 1024; // Wait for at least 64KB before creating resource

      proc.stderr.on('data', (d) => {
        stderr += d.toString();
        const line = d.toString().trim();
        // Log all stderr data for debugging
        if (line.length > 0 && line.length < 500) {
          console.log(`[player] yt-dlp (${Date.now() - startTime}ms): ${line.substring(0, 200)}`);
        }
      });

      // Collect initial data, then create resource once we have enough buffered
      const createResource = () => {
        if (resourceCreated) return;
        resourceCreated = true;
        console.log(`[player] creating resource after ${Date.now() - startTime}ms (${totalBytes} bytes buffered)`);

        // Create a pass-through stream from buffered data + remaining stdout
        const pass = new PassThrough({ highWaterMark: 256 * 1024 });

        // Write buffered chunks
        for (const chunk of dataChunks) {
          pass.write(chunk);
        }
        dataChunks = null; // Free memory

        // Pipe remaining stdout data
        proc.stdout.pipe(pass, { end: false });

        pass.on('error', (err) => {
          if (err?.code === 'EPIPE' || err?.message?.includes('aborted')) return;
          console.error('[player] pass-through stream error:', err.message);
        });

        pass.on('end', () => {
          console.log('[player] stream ended');
          try { proc.kill('SIGKILL'); } catch {}
        });

        this._activeProc = proc;
        const resource = createAudioResource(pass, {
          inputType: StreamType.Arbitrary,
          inlineVolume: false,
          metadata: track,
        });
        console.log(`[player] AudioResource created, volume=${resource.volume?.volume ?? 'N/A'}`);
        resolve(resource);
      };

      proc.stdout.on('data', (chunk) => {
        if (resourceCreated) return;
        dataChunks.push(chunk);
        totalBytes += chunk.length;
        if (totalBytes >= MIN_BYTES) {
          createResource();
        }
      });

      // Fallback: if stream ends before we get enough data, still try
      proc.stdout.on('end', () => {
        if (!resourceCreated && totalBytes > 0) {
          createResource();
        }
      });

      proc.on('error', (err) => {
        console.error(`[player] spawn error: ${err.message}`);
        if (!resourceCreated) {
          resourceCreated = true;
          resolve(null);
        }
      });

      proc.on('close', (code) => {
        console.log(`[player] process closed code=${code} resourceCreated=${resourceCreated} elapsed=${Date.now() - startTime}ms`);
        if (!resourceCreated) {
          resourceCreated = true;
          // Process ended without producing data - always log full stderr for debugging
          console.error(`[player] yt-dlp full stderr (${stderr.length} chars):`);
          console.error(stderr);
          const isBotCheck = /sign in to confirm|confirm you.re not a bot|age-restricted/i.test(stderr);
          if (isBotCheck) {
            console.error('[player] Bot check detected in stderr');
          }
          resolve(null);
        }
      });

      // Timeout after 15s per attempt (faster fallback)
      setTimeout(() => {
        if (!resourceCreated) {
          console.warn('[player] timeout waiting for data, killing process');
          resourceCreated = true;
          try { proc.kill('SIGKILL'); } catch {}
          resolve(null);
        }
      }, 15000);
    });
  }

  /** Best-effort metadata fetch via `yt-dlp -J` (single JSON dump). */
  async _enrichMetadata(track, url) {
    const { bin, pre } = ytdlpCmd();
    const info = await new Promise((resolve, reject) => {
      const proc = spawn(
        bin,
        [...pre, '-J', '--no-playlist', '--no-warnings', ...antiBotArgs(), url],
        { stdio: ['ignore', 'pipe', 'pipe'] },
      );
      let out = '';
      let err = '';
      proc.stdout.on('data', (d) => { out += d.toString(); });
      proc.stderr.on('data', (d) => { err += d.toString(); });
      proc.on('error', reject);
      proc.on('close', (code) => {
        if (code !== 0) return reject(new Error(err.slice(0, 200) || `yt-dlp exited ${code}`));
        try { resolve(JSON.parse(out)); } catch (e) { reject(e); }
      });
    });

    if (track.title === 'YouTube video' && info.title) track.title = info.title;
    track.isLive = Boolean(info.is_live);
    if (!track.duration && info.duration) track.duration = info.duration * 1000;
    if (!track.author) track.author = info.uploader ?? info.channel ?? 'Unknown';
    if (!track.thumbnail && info.thumbnail) track.thumbnail = info.thumbnail;
  }

  _friendlyError(err) {
    const msg = String(err?.message ?? '');
    if (/private video/i.test(msg)) return 'the video is private.';
    if (/unavailable/i.test(msg)) return 'the video is unavailable in this region.';
    if (/age.?restrict|confirm your age/i.test(msg)) return 'the video is age-restricted.';
    if (/confirm.*not a bot|sign in to confirm/i.test(msg)) {
      return 'YouTube is blocking the server (bot check). Set the `YOUTUBE_COOKIES` env var with a logged-in cookies.txt — see README.';
    }
    if (/429|rate/i.test(msg)) return 'YouTube is rate-limiting the bot. Try again shortly.';
    if (/no.*format|playable/i.test(msg)) return 'no playable audio stream was found.';
    if (/premium|members/i.test(msg)) return 'the video requires a paid membership.';
    if (/ENOENT/i.test(msg)) return 'yt-dlp is not installed or not on PATH.';
    return msg.slice(0, 150) || 'unknown streaming error.';
  }

  /** Parse proxies from YTDLP_PROXIES env var (comma-separated list). */
  _getProxies() {
    const proxiesStr = (process.env.YTDLP_PROXIES || '').trim();
    if (!proxiesStr) return [];

    const proxies = [];
    const parts = proxiesStr.split(',').map(s => s.trim()).filter(Boolean);

    for (const part of parts) {
      // Format: host:port:username:password or host:port
      const segments = part.split(':');
      if (segments.length >= 2) {
        let proxy;
        if (segments.length >= 4) {
          // With auth: host:port:username:password
          const [host, port, user, pass] = segments;
          proxy = `http://${user}:${pass}@${host}:${port}`;
        } else {
          // Without auth: host:port
          const [host, port] = segments;
          proxy = `http://${host}:${port}`;
        }
        proxies.push(proxy);
      }
    }

    return proxies;
  }

  /* ---------------------------------------------------------------- */
  /* Timers                                                            */
  /* ---------------------------------------------------------------- */

  _startStuckTimer(track) {
    this._clearStuckTimer();
    this._stuckTimer = setTimeout(() => {
      if (this.isPlaying || this.destroyed) return;
      console.warn(`[player] "${track.title}" never started — skipping.`);
      this._notify(`⏭ **${track.title}** wouldn't start playing — skipping.`);
      this.audioPlayer.stop(true);
    }, STUCK_TIMEOUT_MS);
  }

  _clearStuckTimer() {
    if (this._stuckTimer) {
      clearTimeout(this._stuckTimer);
      this._stuckTimer = null;
    }
  }

  _scheduleIdleLeave() {
    this._cancelIdleLeave();
    this._idleLeaveTimer = setTimeout(() => {
      if (this.current || this.queue.length > 0 || this.destroyed) return;
      this._notify('👋 Queue finished — leaving the voice channel.');
      this.destroy();
    }, EMPTY_QUEUE_LEAVE_MS);
  }

  _cancelIdleLeave() {
    if (this._idleLeaveTimer) {
      clearTimeout(this._idleLeaveTimer);
      this._idleLeaveTimer = null;
    }
  }

  /* ---------------------------------------------------------------- */
  /* Messaging                                                         */
  /* ---------------------------------------------------------------- */

  _notify(content) {
    const channel = this.client.channels.cache.get(this.textChannelId);
    if (channel?.isTextBased()) channel.send({ content }).catch(() => {});
  }

  _notifyNowPlaying(track) {
    const channel = this.client.channels.cache.get(this.textChannelId);
    if (!channel?.isTextBased()) return;
    const embed = this.nowPlayingEmbed();
    const row = this.controlRow();

    console.log(`[player] _notifyNowPlaying: "${track?.title?.substring(0, 40)}" controlPanel=${this.controlPanelMessageId}`);

    // Update existing control panel if it exists
    if (this.controlPanelMessageId) {
      channel.messages.edit(this.controlPanelMessageId, {
        content: '## 🎵 **Music Player Dashboard**\nUse the buttons below to control playback.',
        embeds: [embed],
        components: [row],
      }).then(() => {
        console.log(`[player] control panel updated`);
      }).catch((err) => {
        console.warn(`[player] control panel edit failed: ${err.code} ${err.message}`);
        if (err?.code === 10008) {
          this.controlPanelMessageId = null;
        }
      });
    } else {
      // No control panel - send a new message
      channel.send({
        content: '## 🎵 **Music Player Dashboard**\nUse the buttons below to control playback.',
        embeds: [embed],
        components: [row],
      }).then((msg) => {
        this.controlPanelMessageId = msg.id;
        console.log(`[player] control panel sent, id=${msg.id}`);
      }).catch((err) => {
        console.warn(`[player] control panel send failed: ${err.code} ${err.message}`);
      });
    }
  }

  /** Update the control panel with current state (progress, buttons, etc.) */
  async updateControlPanel() {
    if (!this.controlPanelMessageId) return;

    const channel = this.client.channels.cache.get(this.textChannelId);
    if (!channel?.isTextBased()) return;

    const embed = this.nowPlayingEmbed();
    const row = this.controlRow();

    console.log(`[player] updateControlPanel called for message ${this.controlPanelMessageId}`);

    try {
      // Edit the existing message
      await channel.messages.edit(this.controlPanelMessageId, {
        content: '## 🎵 **Music Player Dashboard**\nUse the buttons below to control playback.',
        embeds: [embed],
        components: [row],
      });
      console.log('[player] control panel edit succeeded');
    } catch (err) {
      console.warn(`[player] control panel edit failed: ${err.code} ${err.message}`);
      if (err?.code === 10008) {
        // Message deleted - clear ID
        this.controlPanelMessageId = null;
      }
    }
  }

  /** Start periodic progress updates for the control panel */
  _startProgressUpdates() {
    this._stopProgressUpdates();
    if (!this.controlPanelMessageId) return;

    this._progressInterval = setInterval(() => {
      if (this.destroyed || !this.isPlaying) {
        this._stopProgressUpdates();
        return;
      }
      this.updateControlPanel().catch(() => {});
    }, 30000); // Update every 30 seconds (less spammy)
  }

  /** Stop periodic progress updates */
  _stopProgressUpdates() {
    if (this._progressInterval) {
      clearInterval(this._progressInterval);
      this._progressInterval = null;
    }
  }

  /** Playback control buttons attached to now-playing messages. */
  controlRow() {
    return new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId('player_prev')
        .setLabel('Previous')
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId('player_pause')
        .setLabel(this.isPaused ? 'Play' : 'Pause')
        .setStyle(this.isPaused ? ButtonStyle.Success : ButtonStyle.Primary),
      new ButtonBuilder()
        .setCustomId('player_skip')
        .setLabel('Skip')
        .setStyle(ButtonStyle.Primary),
      new ButtonBuilder()
        .setCustomId('player_stop')
        .setLabel('Stop')
        .setStyle(ButtonStyle.Danger),
      new ButtonBuilder()
        .setCustomId('player_autoplay')
        .setLabel(this.autoplay ? 'Autoplay: ON' : 'Autoplay: OFF')
        .setStyle(this.autoplay ? ButtonStyle.Success : ButtonStyle.Secondary),
    );
  }

  /* ---------------------------------------------------------------- */
  /* Embeds                                                            */
  /* ---------------------------------------------------------------- */

  nowPlayingEmbed() {
    const t = this.current;
    if (!t) {
      return new EmbedBuilder()
        .setColor(0x2b2d31)
        .setDescription('Nothing is playing right now.');
    }

    const themeColor = this.theme ? THEMES[this.theme]?.color ?? 0x5865f2 : 0x5865f2;
    const playback = this.playbackMs;
    const duration = t.duration || 0;

    console.log(`[player] nowPlayingEmbed: title="${t.title?.substring(0, 40)}" duration=${fmt(duration)} playback=${fmt(playback)} thumbnail=${!!t.thumbnail}`);

    const embed = new EmbedBuilder()
      .setColor(themeColor)
      .setAuthor({ name: 'Now playing' })
      .setTitle(truncate(t.title, 250))
      .setURL(t.url)
      .addFields(
        { name: 'Channel', value: truncate(t.author ?? 'Unknown', 100), inline: true },
        { name: 'Requested by', value: t.requestedBy ? `<@${t.requestedBy}>` : 'Unknown', inline: true },
        { name: 'Source', value: t.source === 'spotify' ? 'Spotify → YouTube' : 'YouTube', inline: true },
      );

    if (t.isLive) {
      embed.addFields({ name: 'Duration', value: '🔴 Live', inline: false });
    } else if (duration > 0) {
      const bar = progressBar(playback, duration);
      embed.addFields({
        name: 'Progress',
        value: `${bar}\n\`${fmt(playback)} / ${fmt(duration)}\``,
        inline: false,
      });
      console.log(`[player] progress bar: ${bar} ${fmt(playback)}/${fmt(duration)}`);
    } else {
      console.log(`[player] no duration for progress bar, duration=${duration}`);
    }

    if (t.spotifyTitle) {
      embed.setFooter({ text: `Spotify: ${truncate(t.spotifyTitle, 200)}` });
    }

    if (t.thumbnail) {
      embed.setThumbnail(t.thumbnail);
      console.log(`[player] thumbnail set: ${t.thumbnail.substring(0, 60)}...`);
    }

    return embed;
  }

  queueEmbed(page = 0, pageSize = 10) {
    const embed = new EmbedBuilder().setColor(0x5865f2).setTitle('Queue');

    const lines = [];

    if (this.current) {
      lines.push(
        `**Now playing**\n[${truncate(this.current.title, 70)}](${this.current.url}) · ` +
        `${this.current.isLive ? '🔴 Live' : fmt(this.current.duration)}\n`
      );
    }

    if (this.queue.length === 0) {
      lines.push('*Nothing else queued. Add more with `/play`.*');
      embed.setDescription(lines.join('\n'));
      return embed;
    }

    const totalPages = Math.max(1, Math.ceil(this.queue.length / pageSize));
    const safePage = Math.min(Math.max(page, 0), totalPages - 1);
    const start = safePage * pageSize;
    const slice = this.queue.slice(start, start + pageSize);

    lines.push('**Up next**');
    slice.forEach((t, i) => {
      lines.push(
        `\`${start + i + 1}.\` [${truncate(t.title, 60)}](${t.url}) · ` +
        `${t.isLive ? '🔴 Live' : fmt(t.duration)} · <@${t.requestedBy}>`
      );
    });

    const totalMs = this.queue.reduce((sum, t) => sum + (t.isLive ? 0 : t.duration), 0);
    embed.setDescription(lines.join('\n')).setFooter({
      text:
        `Page ${safePage + 1}/${totalPages} · ${this.queue.length} track${this.queue.length === 1 ? '' : 's'}` +
        ` · ${fmt(totalMs)} remaining` +
        (this.loop !== 'off' ? ` · loop: ${this.loop}` : ''),
    });

    return embed;
  }
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

function fmt(ms) {
  if (!ms || !Number.isFinite(ms) || ms <= 0) return '0:00';
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h > 0
    ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
    : `${m}:${String(s).padStart(2, '0')}`;
}

function progressBar(currentMs, totalMs, width = 18) {
  if (!totalMs || totalMs <= 0) return '─'.repeat(width);
  const ratio = Math.min(Math.max(currentMs / totalMs, 0), 1);
  const pos = Math.round(ratio * (width - 1));
  return '─'.repeat(pos) + '🔵' + '─'.repeat(width - 1 - pos);
}

function truncate(str, max) {
  const s = String(str ?? '');
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}
