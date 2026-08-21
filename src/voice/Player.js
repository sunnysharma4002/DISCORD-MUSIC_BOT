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
import { existsSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
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
  const args = [
    // Use the tv/mobile innertube clients — far less likely to hit the bot wall.
    '--extractor-args', 'youtube:player_client=tv,android,web',
    '--user-agent',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
  ];
  const cookies = resolveCookieFile();
  if (cookies) args.push('--cookies', cookies);
  return args;
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
    this.current = null;
    this.history = [];

    this.connection = null;
    this.voiceChannelId = null;
    this.textChannelId = null;

    this.loop = 'off';        // 'off' | 'track' | 'queue'
    this.autoplay = false;    // auto-search related when queue empties
    this.theme = 'default';   // embed color theme
    this.destroyed = false;

    this._stuckTimer = null;
    this._idleLeaveTimer = null;
    this.emptyChannelTimeout = null;
    this._advancing = false;  // guards against double-advance races

    this.audioPlayer = createAudioPlayer({
      behaviors: { noSubscriber: NoSubscriberBehavior.Pause },
    });

    this.audioPlayer.on(AudioPlayerStatus.Playing, () => this._clearStuckTimer());

    this.audioPlayer.on(AudioPlayerStatus.Idle, () => {
      this._clearStuckTimer();
      this._advance().catch((err) => console.error('[player] advance error:', err));
    });

    this.audioPlayer.on('error', (err) => {
      console.error(`[player] audio error on "${this.current?.title}":`, err.message);
      this._notify(`⚠️ Playback error on **${this.current?.title ?? 'track'}** — skipping.`);
      // 'error' is followed by Idle, which triggers _advance()
    });
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

    // Log every state transition — tells us WHERE it gets stuck.
    //   Signalling → Connecting → Ready   = healthy
    //   stuck in Signalling               = voice server update never arrived (gateway)
    //   stuck in Connecting               = UDP socket couldn't complete (host blocks UDP)
    connection.on('stateChange', (oldState, newState) => {
      if (oldState.status !== newState.status) {
        console.log(`[voice] state: ${oldState.status} → ${newState.status}`);
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
    if (this._idleLeaveTimer) clearTimeout(this._idleLeaveTimer);
    if (this.emptyChannelTimeout) clearTimeout(this.emptyChannelTimeout);

    this.queue = [];
    this.current = null;

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
    if (this.destroyed) return;

    try {
      const resource = await this._createResource(track);
      this.audioPlayer.play(resource);
      this._startStuckTimer(track);
      this._cancelIdleLeave();
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
   * Builds query from artist name + "mix" or title keywords.
   * Returns a youtube-sr Video or null on failure.
   */
  async _searchRelated(finished) {
    try {
      // Build a related query from the finished track's metadata
      let query = '';
      if (finished.author && finished.author !== 'Unknown') {
        query = `${finished.author} mix`;
      } else if (finished.title && finished.title !== 'YouTube video') {
        // Strip common noise words from title for search
        query = finished.title
          .replace(/\(.*?\)|\[.*?\]|Official|Music Video|Lyrics|Audio/gi, '')
          .replace(/\s+/g, ' ')
          .trim()
          .slice(0, 60);
        if (query) query += ' mix';
      }

      if (!query) query = `${finished.title || 'music'} mix`;

      const results = await YouTube.search(query, { limit: 10, type: 'video' });
      if (!Array.isArray(results) || results.length === 0) return null;

      // Pick a random result that isn't the same video
      const candidates = results.filter(v => v?.id && v.id !== finished.videoId);
      if (candidates.length === 0) return null;

      const pick = candidates[Math.floor(Math.random() * candidates.length)];
      return {
        title: pick.title ?? 'Unknown title',
        url: pick.url ?? `https://www.youtube.com/watch?v=${pick.id}`,
        videoId: pick.id,
        duration: (Number(pick.duration) || 0),
        isLive: Boolean(pick.live),
        thumbnail: pick.thumbnail?.url ?? `https://i.ytimg.com/vi/${pick.id}/hqdefault.jpg`,
        author: pick.channel?.name ?? 'Unknown',
        source: 'youtube',
        requestedBy: finished.requestedBy, // keep original requester
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
   */
  async _createResource(track) {
    const url = track.url ?? `https://www.youtube.com/watch?v=${track.videoId}`;

    // Enrich metadata (title/duration/author) if missing — best-effort, non-fatal.
    if (!track.duration || !track.author || track.title === 'YouTube video') {
      try {
        await this._enrichMetadata(track, url);
      } catch (err) {
        console.warn('[player] metadata fetch failed:', err.message);
      }
    }

    const { bin, pre } = ytdlpCmd();
    const args = [
      ...pre,
      '-f', 'bestaudio/best',
      '--no-playlist',
      '--quiet',
      '--no-warnings',
      '-o', '-',              // stream to stdout
      ...antiBotArgs(),
      url,
    ];

    const proc = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });

    let stderr = '';
    proc.stderr.on('data', (d) => { stderr += d.toString(); });

    proc.on('error', (err) => {
      console.error('[player] yt-dlp spawn error:', err.message);
    });

    proc.on('close', (code) => {
      if (code && code !== 0 && !this.destroyed) {
        console.error(`[player] yt-dlp exited ${code}: ${stderr.slice(0, 300)}`);
      }
    });

    // Kill the child when the audio stream ends/aborts to avoid orphaned processes.
    const stream = proc.stdout;
    stream.on('error', (err) => {
      if (err?.message?.includes('aborted') || err?.code === 'EPIPE') return;
      console.error('[player] stream error:', err.message);
    });
    stream.once('close', () => { try { proc.kill('SIGKILL'); } catch {} });
    this._activeProc = proc;

    return createAudioResource(stream, {
      inputType: StreamType.Arbitrary,
      inlineVolume: false,
      metadata: track,
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
    channel.send({ embeds: [embed], components: [row] }).catch(() => {});
  }

  /** Playback control buttons attached to now-playing messages. */
  controlRow() {
    return new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId('player_prev')
        .setLabel('⏮')
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId('player_pause')
        .setLabel(this.isPaused ? '▶' : '⏸')
        .setStyle(this.isPaused ? ButtonStyle.Success : ButtonStyle.Primary),
      new ButtonBuilder()
        .setCustomId('player_skip')
        .setLabel('⏭')
        .setStyle(ButtonStyle.Primary),
      new ButtonBuilder()
        .setCustomId('player_stop')
        .setLabel('⏹')
        .setStyle(ButtonStyle.Danger),
      new ButtonBuilder()
        .setCustomId('player_autoplay')
        .setLabel(this.autoplay ? '🔁 ON' : '🔁 OFF')
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
    } else if (t.duration > 0) {
      embed.addFields({
        name: 'Progress',
        value: `${progressBar(this.playbackMs, t.duration)}\n\`${fmt(this.playbackMs)} / ${fmt(t.duration)}\``,
        inline: false,
      });
    }

    if (t.spotifyTitle) {
      embed.setFooter({ text: `Spotify: ${truncate(t.spotifyTitle, 200)}` });
    }

    if (t.thumbnail) embed.setThumbnail(t.thumbnail);

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
