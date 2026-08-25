import { SlashCommandBuilder, EmbedBuilder, MessageFlags } from 'discord.js';
import { resolveQuery, isSpotifyURL, isSoundCloudURL, isJioSaavnURL } from '../spotify/resolver.js';

export default {
  data: new SlashCommandBuilder()
    .setName('play')
    .setDescription('Play a track from YouTube or Spotify')
    .addStringOption((opt) =>
      opt
        .setName('query')
        .setDescription('Song name, YouTube link, or Spotify track/album/playlist link')
        .setRequired(true)
        .setMaxLength(500),
    ),

  async execute(interaction) {
    try {
      await interaction.deferReply();
    } catch (err) {
      if (err?.code === 10062 || err?.code === 40060) {
        console.warn(`[play] Interaction already handled or expired: ${err.code}`);
        return;
      }
      throw err;
    }

    // Accept BOTH option names: our fresh command uses `query`, but a stale
    // legacy `/play` (option named `song`) may still be cached in clients.
    const query =
      interaction.options.getString('query') ??
      interaction.options.getString('song');
    if (!query || !query.trim()) {
      console.warn('[play] Empty-query interaction received. Raw payload:', JSON.stringify({
        commandId: interaction.commandId,
        commandName: interaction.commandName,
        guildId: interaction.guildId,
        channelId: interaction.channelId,
        options: interaction.options?.data ?? null,
        resolved: interaction.options?.resolved ?? null,
        rawOptions: interaction.rawOptions ?? null,
      }));
      return interaction.editReply({
        content:
          '❌ Discord sent this command with an empty `query`.\n\n' +
          'This is a **client cache** problem — your Discord app is showing an old `/play` that doesn\'t require a query.\n\n' +
          '**Fix:** fully close and reopen Discord (or press Ctrl/Cmd+R in the desktop app). If you\'re on mobile, force-close and reopen the app.\n\n' +
          'Still stuck? Run `/deploy` in this server (admins only), then reload Discord.',
      });
    }

    /* -- Voice channel + permission checks ------------------------- */
    const voiceChannel = interaction.member?.voice?.channel;
    if (!voiceChannel) {
      return interaction.editReply({
        content: '❌ Join a voice channel first.',
      });
    }

    if (voiceChannel.type === 13) {
      // Stage channels need extra handling (bot must be a speaker) — reject clearly.
      return interaction.editReply({
        content: '❌ I can\'t play music in a **Stage** channel. Use a normal voice channel.',
      });
    }

    const me = interaction.guild.members.me;
    const botVoiceId = me?.voice?.channelId;
    if (botVoiceId && botVoiceId !== voiceChannel.id) {
      return interaction.editReply({
        content: `❌ I'm already playing in <#${botVoiceId}>.`,
      });
    }

    const perms = voiceChannel.permissionsFor(me);
    const missing = [];
    if (!perms?.has('ViewChannel')) missing.push('ViewChannel');
    if (!perms?.has('Connect')) missing.push('Connect');
    if (!perms?.has('Speak')) missing.push('Speak');
    if (missing.length > 0) {
      return interaction.editReply({
        content: `❌ I need the **${missing.join('** and **')}** permission${missing.length > 1 ? 's' : ''} in <#${voiceChannel.id}>.`,
      });
    }

    if (voiceChannel.full && !perms.has('MoveMembers')) {
      return interaction.editReply({
        content: '❌ That voice channel is full.',
      });
    }

    /* -- Resolve + play -------------------------------------------- */
    const player = interaction.client.getPlayer(interaction.guild.id, true);

    try {
      await player.connect(voiceChannel, interaction.channel);
    } catch (err) {
      return interaction.editReply(`❌ ${err.message}`);
    }

    console.log(`[play] resolving query: "${query.substring(0, 100)}" source=${isSpotifyURL(query) ? 'spotify' : isSoundCloudURL(query) ? 'soundcloud' : isJioSaavnURL(query) ? 'jiosaavn' : 'youtube'}`);
    let result;
    try {
      result = await resolveQuery(query, interaction.user.id);
    } catch (err) {
      console.error('[play] resolve failed:', err);
      // Leave voice again if we joined only for this failed request
      if (!player.current && player.queue.length === 0) player.destroy();
      return interaction.editReply(`❌ ${err.message}`);
    }

    const { tracks, playlistName, skipped, truncated } = result;
    const startedEmpty = !player.current && player.queue.length === 0;

    player.enqueue(tracks);

    // Send embed with thumbnail and buttons immediately
    if (startedEmpty) {
      const t = tracks[0];
      const embed = new EmbedBuilder().setColor(0x57f287);
      embed
        .setAuthor({ name: '🎵 Now Playing' })
        .setTitle(`🎶 ${t.title?.slice(0, 250) || 'Unknown track'}`)
        .setURL(t.url)
        .addFields(
          { name: '🎤 Artist', value: t.author || 'Unknown', inline: true },
          { name: '⏱ Duration', value: t.isLive ? '🔴 Live' : fmt(t.duration), inline: true },
          { name: '📍 Position', value: 'Playing now', inline: true },
          { name: '📡 Source', value: isSpotifyURL(query) ? 'Spotify → YouTube' : isSoundCloudURL(query) ? 'SoundCloud → YouTube' : isJioSaavnURL(query) ? 'JioSaavn' : 'YouTube', inline: true },
          { name: '👤 Requested by', value: `<@${interaction.user.id}>`, inline: true },
        );
      if (t.thumbnail && t.thumbnail.startsWith('http')) {
        embed.setThumbnail(t.thumbnail);
      } else if (t.videoId) {
        embed.setThumbnail(`https://i.ytimg.com/vi/${t.videoId}/maxresdefault.jpg`);
      }

      const reply = await interaction.editReply({
        content: '## 🎵 **Now Playing**',
        embeds: [embed],
        components: [player.controlRow(), player.controlRow2()],
      });
      player.controlPanelMessageId = reply.id;
      console.log(`[play] control panel created with buttons, message id=${reply.id}`);
    } else {
      // Added to queue - show queue style embed
      const sourceLabel = isSpotifyURL(query) ? 'Spotify → YouTube' : isSoundCloudURL(query) ? 'SoundCloud → YouTube' : isJioSaavnURL(query) ? 'JioSaavn' : 'YouTube';
      const embed = new EmbedBuilder().setColor(0x57f287);

      if (tracks.length === 1) {
        const t = tracks[0];
        embed
          .setAuthor({ name: '✅ Added to queue' })
          .setTitle(`🎶 ${t.title?.slice(0, 250) || 'Unknown track'}`)
          .setURL(t.url)
          .addFields(
            { name: '🎤 Artist', value: t.author || 'Unknown', inline: true },
            { name: '⏱ Duration', value: t.isLive ? '🔴 Live' : fmt(t.duration), inline: true },
            { name: '📍 Position', value: `#${player.queue.length}`, inline: true },
            { name: '📡 Source', value: sourceLabel, inline: true },
            { name: '👤 Requested by', value: `<@${interaction.user.id}>`, inline: true },
          );
        if (t.thumbnail && t.thumbnail.startsWith('http')) {
          embed.setThumbnail(t.thumbnail);
        } else if (t.videoId) {
          embed.setThumbnail(`https://i.ytimg.com/vi/${t.videoId}/maxresdefault.jpg`);
        }
      } else {
        const totalMs = tracks.reduce((sum, t) => sum + (t.isLive ? 0 : t.duration), 0);
        embed
          .setAuthor({ name: '✅ Added to queue' })
          .setTitle(`📀 ${playlistName ?? 'Playlist'}`.slice(0, 250))
          .setDescription(
            `**${tracks.length}** tracks queued · ${fmt(totalMs)} total\n` +
            `First up: [${tracks[0].title?.slice(0, 80) || 'Unknown'}](${tracks[0].url})`,
          )
          .addFields({ name: '📡 Source', value: sourceLabel, inline: true });
        if (tracks[0].thumbnail && tracks[0].thumbnail.startsWith('http')) {
          embed.setThumbnail(tracks[0].thumbnail);
        } else if (tracks[0].videoId) {
          embed.setThumbnail(`https://i.ytimg.com/vi/${tracks[0].videoId}/maxresdefault.jpg`);
        }
      }

      const notes = [];
      if (skipped > 0) notes.push(`${skipped} track${skipped === 1 ? '' : 's'} couldn't be found on YouTube`);
      if (truncated) notes.push('list truncated to the first 60 tracks');
      if (notes.length > 0) embed.setFooter({ text: notes.join(' · ') });

      await interaction.editReply({ embeds: [embed] });
    }

    try {
      await player.start();
    } catch (err) {
      console.error('[play] start failed:', err);
      return interaction.editReply(`❌ Failed to start playback: ${err.message}`);
    }

    return;
  },
};

function fmt(ms) {
  if (!ms || ms <= 0) return '—';
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h > 0
    ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
    : `${m}:${String(s).padStart(2, '0')}`;
}
