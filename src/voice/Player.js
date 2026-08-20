import { joinVoiceChannel, createAudioPlayer, createAudioResource, AudioPlayerStatus, VoiceConnectionStatus, entersState } from '@discordjs/voice';
import { EmbedBuilder } from 'discord.js';
import ytdl from '@distube/ytdl-core';
import * as playDL from 'play-dl';
import { resolveSpotify } from '../spotify/resolver.js';

const STREAM_TIMEOUT_MS = 8_000;
const STUCK_TRACK_TIMEOUT_MS = 60_000;

/**
 * Player — per-guild voice + queue manager.
 * Owns the VoiceConnection and AudioPlayer, drives the queue forward
 * via the 'idle' event on the audio player.
 */
export class Player {
  constructor(client, guildId) {
    this.client = client;
    this.guildId = guildId;
    this.queue = [];
    this.current = null;
    this.voice = null;       // { connection, channel }
    this.audioPlayer = createAudioPlayer();
    this.textChannelId = null;
    this.loop = 'off';       // 'off' | 'track' | 'queue'
    this.shuffle = false;
    this.emptyChannelTimeout = null;
    this._stuckTrackTimeout = null;
    this._previousTracks = []; // for queue loop mode

    // When the player goes idle, play the next track
    this.audioPlayer.on(AudioPlayerStatus.Idle, () => this._onIdle());
  }

  // ── Voice connection ───────────────────────────────────────────

  async connect(voiceChannel, textChannel) {
    if (this.voice?.connection) return this.voice.connection;

    const connection = joinVoiceChannel({
      channelId: voiceChannel.id,
      guildId: this.guildId,
      adapterCreator: voiceChannel.guild.voiceAdapterCreator,
      selfDeaf: true,
      selfMute: false,
    });

    this.voice = { connection, channel: voiceChannel };
    this.textChannelId = textChannel.id;

    connection.on(VoiceConnectionStatus.Disconnected, async () => {
      try {
        await Promise.race([
          entersState(connection, VoiceConnectionStatus.Signalling, 5_000),
          entersState(connection, VoiceConnectionStatus.Connecting, 5_000),
        ]);
      } catch {
        this.destroy();
      }
    });

    connection.on(VoiceConnectionStatus.Destroyed, () => {
      this.voice = null;
    });

    this.audioPlayer.on('error', (err) => {
      console.error('[AUDIO ERROR]', err);
    });

    connection.subscribe(this.audioPlayer);
    return connection;
  }

  destroy() {
    if (this.emptyChannelTimeout) clearTimeout(this.emptyChannelTimeout);
    if (this._stuckTrackTimeout) clearTimeout(this._stuckTrackTimeout);
    this.audioPlayer.stop();
    this.voice?.connection?.destroy();
    this.voice = null;
    this.queue = [];
    this.current = null;
    this.client.players.delete(this.guildId);
  }

  // ── Queue operations ──────────────────────────────────────────

  addTrack(track) {
    this.queue.push(track);
  }

  addTracks(tracks) {
    this.queue.push(...tracks);
  }

  skip() {
    if (this._stuckTrackTimeout) {
      clearTimeout(this._stuckTrackTimeout);
      this._stuckTrackTimeout = null;
    }
    this.audioPlayer.stop();
  }

  stop() {
    this.queue = [];
    this.skip();
  }

  pause() {
    this.audioPlayer.pause();
  }

  resume() {
    this.audioPlayer.unpause();
  }

  setLoop(mode) {
    this.loop = mode; // 'off' | 'track' | 'queue'
  }

  toggleShuffle() {
    this.shuffle = !this.shuffle;
    if (this.shuffle && this.queue.length > 1) {
      // Fisher-Yates shuffle
      for (let i = this.queue.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [this.queue[i], this.queue[j]] = [this.queue[j], this.queue[i]];
      }
    }
    return this.shuffle;
  }

  removeTrack(index) {
    if (index < 0 || index >= this.queue.length) return null;
    return this.queue.splice(index, 1)[0];
  }

  clearQueue() {
    this.queue = [];
  }

  // ── Now Playing embed ─────────────────────────────────────────

  nowPlayingEmbed() {
    if (!this.current) return null;
    const t = this.current;
    return new EmbedBuilder()
      .setColor(0x5865F2)
      .setTitle(`🎵 Now Playing`)
      .setURL(t.url)
      .setDescription(`**${t.title}**`)
      .addFields(
        { name: 'Duration', value: t.isLive ? '🔴 LIVE' : formatDuration(t.duration), inline: true },
        { name: 'Requested by', value: t.requestedBy, inline: true },
        { name: 'Source', value: t.source, inline: true }
      )
      .setThumbnail(t.thumbnail)
      .setTimestamp();
  }

  queueEmbed(page = 0, pageSize = 10) {
    const embed = new EmbedBuilder()
      .setColor(0x5865F2)
      .setTitle('📋 Queue')
      .setTimestamp();

    if (this.current) {
      embed.addFields({
        name: '▶ Now Playing',
        value: `**${this.current.title}** (${this.current.isLive ? 'LIVE' : formatDuration(this.current.duration)})`
      });
    }

    if (this.queue.length === 0) {
      embed.setDescription('*No tracks queued.*');
      return embed;
    }

    const start = page * pageSize;
    const end = Math.min(start + pageSize, this.queue.length);
    const slice = this.queue.slice(start, end);

    const lines = slice.map((t, i) =>
      `**${start + i + 1}.** ${t.title} — ${t.isLive ? '🔴' : formatDuration(t.duration)} <@${t.requestedBy}>`
    );

    embed.setDescription(lines.join('\n'));
    embed.setFooter({ text: `Page ${page + 1}/${Math.ceil(this.queue.length / pageSize)} — ${this.queue.length} track(s)` });
    return embed;
  }

  // ── Play a track (resolve stream + feed audio player) ─────────

  async playTrack(track) {
    this.current = track;

    if (!this.voice?.connection) {
      console.error('[Player] No voice connection for playTrack');
      return;
    }

    try {
      const stream = await this._getAudioStream(track);
      const resource = createAudioResource(stream, {
        inputType: track.isLive
          ? undefined /* let voice lib detect */
          : 2 /* Opus */
      });

      this.audioPlayer.play(resource);

      // Stuck-track guard: if no 'playing' state within 60s, auto-skip
      this._stuckTrackTimeout = setTimeout(() => {
        if (this.audioPlayer.state.status === AudioPlayerStatus.Playing) return;
        console.warn(`[Player] Track "${track.title}" stuck — auto-skipping.`);
        this.skip();
        this._stuckTrackTimeout = null;
      }, STUCK_TRACK_TIMEOUT_MS);

    } catch (err) {
      console.error('[Player] playTrack error:', err.message);
      const ch = this.client.channels.cache.get(this.textChannelId);
      if (ch) {
        ch.send({
          content: `❌ Failed to play **${track.title}**: ${err.message.substring(0, 120)}`
        }).catch(() => {});
      }
      this._onIdle(); // try next track
    }
  }

  /**
   * Returns a readable stream for the given track.
   * YouTube → ytdl-core HLS/HTTP stream.
   * Spotify-resolved tracks are already YouTube URLs by this point.
   */
  async _getAudioStream(track) {
    if (track.source === 'youtube' || track.source === 'spotify-resolved') {
      return await this._youtubeStream(track.url, track.isLive);
    }
    throw new Error(`Unsupported source: ${track.source}`);
  }

  async _youtubeStream(url, isLive) {
    // Use @distube/ytdl-core for reliable YouTube streaming
    const info = await ytdl.getInfo(url, { lang: 'en' });
    const format = ytdl.chooseFormat(info.formats, {
      quality: 'audioonly',
      filter: 'audioonly',
    });

    if (!format) throw new Error('No audio-only format found.');

    // For live streams, return the hlsManifestUrl or standard stream
    if (isLive || info.player_response?.streamingData?.hlsManifestUrl) {
      const hls = info.player_response?.streamingData?.hlsManifestUrl;
      if (hls) {
        // undici fetch for HLS — return as web stream compatible with voice
        const { fetch } = await import('undici');
        const resp = await fetch(hls);
        return resp.body; // Web ReadableStream
      }
    }

    // Standard progressive download stream
    return ytdl(url, {
      quality: format.itag,
      highWaterMark: 1 << 20, // 1 MiB buffer
      dlChunkSize: 0,         // disable chunking for stability
    });
  }

  // ── Internal: queue driver ────────────────────────────────────

  async _onIdle() {
    if (this._stuckTrackTimeout) {
      clearTimeout(this._stuckTrackTimeout);
      this._stuckTrackTimeout = null;
    }

    // Handle loop modes
    if (this.loop === 'track' && this.current) {
      await this.playTrack(this.current);
      return;
    }

    if (this.queue.length === 0) {
      if (this.loop === 'queue' && this._previousTracks?.length) {
        this.queue = this._previousTracks;
        this._previousTracks = [];
      } else {
        this.current = null;
        return; // stay in voice, wait for new tracks
      }
    }

    if (this.loop === 'queue' && !this._previousTracks) {
      this._previousTracks = [];
    }

    if (this.current && this.loop === 'queue') {
      this._previousTracks.push(this.current);
    }

    const next = this.queue.shift();
    if (!next) {
      this.current = null;
      return;
    }

    await this.playTrack(next);
  }
}

// ── Helpers ──────────────────────────────────────────────────────

function formatDuration(ms) {
  if (!ms || ms === Infinity) return 'LIVE';
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
}
