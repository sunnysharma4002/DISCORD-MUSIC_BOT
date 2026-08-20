import { SlashCommandBuilder, EmbedBuilder } from 'discord.js';
import { resolveSpotify, resolveYouTube, isSpotifyURL } from '../spotify/resolver.js';

export default {
  data: new SlashCommandBuilder()
    .setName('play')
    .setDescription('Play a song from YouTube or Spotify')
    .addStringOption(opt =>
      opt.setName('query')
        .setDescription('YouTube URL, search query, or Spotify link')
        .setRequired(true)
    ),

  async execute(interaction) {
    const query = interaction.options.getString('query');
    const { user } = interaction;

    // Defer reply — resolution can take several seconds
    await interaction.deferReply();

    const guild = interaction.guild;
    const member = interaction.member;

    // ── Voice channel checks ──────────────────────────────────
    const voiceChannel = member?.voice?.channel;
    if (!voiceChannel) {
      return interaction.editReply({
        content: '❌ You must be in a voice channel to use this command.'
      });
    }

    const botMember = guild.members.me;
    if (!botMember?.voice?.channel) {
      // Bot not in voice — will join user's channel
    } else if (botMember.voice.channelId !== voiceChannel.id) {
      return interaction.editReply({
        content: '❌ I\'m already playing in another voice channel.'
      });
    }

    const permissions = voiceChannel.permissionsFor(botMember);
    if (!permissions?.has('Connect') || !permissions?.has('Speak')) {
      return interaction.editReply({
        content: '❌ I need **Connect** and **Speak** permissions in your voice channel.'
      });
    }

    // ── Get or create player ──────────────────────────────────
    let player = interaction.client.getPlayer(guild.id, true);

    // Connect to voice (idempotent)
    try {
      await player.connect(voiceChannel, interaction.channel);
    } catch (err) {
      return interaction.editReply({ content: `❌ Failed to join voice: ${err.message}` });
    }

    // ── Resolve tracks ────────────────────────────────────────
    try {
      let tracks;

      if (isSpotifyURL(query)) {
        tracks = await resolveSpotify(query);
        if (!tracks || tracks.length === 0) {
          return interaction.editReply({ content: '❌ No playable tracks found in that Spotify link.' });
        }
      } else {
        const ytTrack = await resolveYouTube(query);
        tracks = [ytTrack];
      }

      // Attach requester info
      tracks.forEach(t => { t.requestedBy = user.id; });

      const wasEmpty = player.queue.length === 0 && !player.current;
      player.addTracks(tracks);

      if (wasEmpty) {
        // Start playing immediately
        await player.playTrack(player.queue.shift());
      }

      // ── Response embed ──────────────────────────────────────
      const embed = new EmbedBuilder()
        .setColor(0x5865F2)
        .setTimestamp();

      if (tracks.length === 1) {
        const t = tracks[0];
        embed.setTitle('🎵 Added to queue')
          .setDescription(`**${t.title}**`)
          .addFields(
            { name: 'Duration', value: t.isLive ? '🔴 LIVE' : formatDuration(t.duration), inline: true },
            { name: 'Position', value: wasEmpty ? 'Playing now' : `#${player.queue.length}`, inline: true },
            { name: 'Source', value: t.source === 'spotify-resolved' ? 'Spotify → YouTube' : 'YouTube', inline: true }
          )
          .setThumbnail(t.thumbnail);
      } else {
        embed.setTitle('📀 Playlist added')
          .setDescription(`**${tracks.length} tracks** from ${isSpotifyURL(query) ? 'Spotify' : 'YouTube'}`)
          .addFields({ name: 'First track', value: `**${tracks[0].title}**` });
      }

      return interaction.editReply({ content: null, embeds: [embed] });

    } catch (err) {
      console.error('[play] Error:', err);
      return interaction.editReply({ content: `❌ Error: ${err.message}` });
    }
  },
};

function formatDuration(ms) {
  if (!ms || ms === Infinity) return 'LIVE';
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return `${m}:${String(sec).padStart(2, '0')}`;
}
