import {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  StreamType,
  AudioPlayerStatus,
  VoiceConnectionStatus,
  NoSubscriberBehavior,
  entersState,
} from '@discordjs/voice';
import { EmbedBuilder } from 'discord.js';
import ytdl from '@distube/ytdl-core';

const STUCK_TIMEOUT_MS = 30_000;   // no audio started within this window → skip
const EMPTY_QUEUE_LEAVE_MS = 120_000; // idle with empty queue → leave

/**
 * Per-guild music player.
 *
 * Audio pipeline:
 *   ytdl-core (opus/webm) ──► createAudioResource(StreamType.WebmOpus)
 *                             └─ no transcoding when webm/opus is available
 *   ytdl-core (other)     ──► createAudioResource(StreamType.Arbitrary)
 *                             └─ prism-media + ffmpeg transcode to opus
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

    const connection = joinVoiceChannel({
      channelId: voiceChannel.id,
      guildId: this.guildId,
      adapterCreator: voiceChannel.guild.voiceAdapterCreator,
      selfDeaf: true,
    });

    this.connection = connection;
    this.voiceChannelId = voiceChannel.id;

    connection.on(VoiceConnectionStatus.Disconnected, async () => {
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
      await entersState(connection, VoiceConnectionStatus.Ready, 20_000);
    } catch {
      this.destroy();
      throw new Error('Could not connect to the voice channel (timed out).');
    }

    return connection;
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
   * Builds an AudioResource for a track.
   * Prefers a native webm/opus stream (zero transcoding, lowest CPU),
   * and falls back to arbitrary audio which prism-media transcodes via ffmpeg.
   */
  async _createResource(track) {
    const url = track.url ?? `https://www.youtube.com/watch?v=${track.videoId}`;

    const info = await ytdl.getInfo(url, {
      requestOptions: {
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
          ...(process.env.YOUTUBE_COOKIE ? { cookie: process.env.YOUTUBE_COOKIE } : {}),
        },
      },
    });

    // Fill in metadata we may not have had from search results
    const details = info.videoDetails;
    if (details) {
      track.title = track.title === 'YouTube video' ? details.title : track.title;
      track.isLive = Boolean(details.isLiveContent && details.isLive);
      if (!track.duration) track.duration = Number(details.lengthSeconds) * 1000 || 0;
      if (!track.author) track.author = details.author?.name ?? 'Unknown';
      if (!track.thumbnail) {
        track.thumbnail = details.thumbnails?.at(-1)?.url ?? null;
      }
    }

    const audioFormats = info.formats.filter((f) => f.hasAudio && !f.hasVideo);
    if (audioFormats.length === 0) {
      throw new Error('no audio-only stream available');
    }

    // Highest-bitrate webm/opus format avoids a transcode entirely
    const opusFormat = audioFormats
      .filter((f) => f.codecs?.includes('opus') && f.container === 'webm')
      .sort((a, b) => (b.audioBitrate ?? 0) - (a.audioBitrate ?? 0))[0];

    const format = opusFormat ?? ytdl.chooseFormat(audioFormats, { quality: 'highestaudio' });

    const stream = ytdl.downloadFromInfo(info, {
      format,
      highWaterMark: 1 << 25,  // 32 MiB read-ahead — smooths network hiccups
      dlChunkSize: 0,          // single request; avoids chunk-boundary stalls
    });

    // Surface stream-level failures on the audio player instead of crashing
    stream.on('error', (err) => {
      if (err?.message?.includes('aborted')) return; // expected on skip
      console.error('[player] stream error:', err.message);
    });

    return createAudioResource(stream, {
      inputType: opusFormat ? StreamType.WebmOpus : StreamType.Arbitrary,
      inlineVolume: false,
      metadata: track,
    });
  }

  _friendlyError(err) {
    const msg = String(err?.message ?? '');
    if (/private video/i.test(msg)) return 'the video is private.';
    if (/unavailable/i.test(msg)) return 'the video is unavailable in this region.';
    if (/age.?restrict|sign in/i.test(msg)) return 'the video is age-restricted.';
    if (/429|rate/i.test(msg)) return 'YouTube is rate-limiting the bot. Try again shortly.';
    if (/no audio-only/i.test(msg)) return 'no playable audio stream was found.';
    if (/premium|members/i.test(msg)) return 'the video requires a paid membership.';
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
    channel.send({ embeds: [this.nowPlayingEmbed()] }).catch(() => {});
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

    const embed = new EmbedBuilder()
      .setColor(0x5865f2)
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
