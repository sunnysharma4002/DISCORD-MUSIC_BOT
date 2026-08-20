import { SlashCommandBuilder, EmbedBuilder, MessageFlags } from 'discord.js';
import { resolveQuery, isSpotifyURL } from '../spotify/resolver.js';

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
    // Defensive: never use required=true here. Stale slash-command caches
    // (Discord not yet showing the newest definition) can send the interaction
    // without the option — that used to crash with "Required option not found".
    const query = interaction.options.getString('query');
    if (!query || !query.trim()) {
      return interaction.reply({
        content: '❌ You need to provide a song name or link.\n\n> Tip: if you see this despite typing something, your Discord client is showing a **stale command** — re-run `npm run deploy` (or `/deploy` on the bot) to force an update.',
        flags: MessageFlags.Ephemeral,
      });
    }

    /* -- Voice channel + permission checks (before deferring) ------ */
    const voiceChannel = interaction.member?.voice?.channel;
    if (!voiceChannel) {
      return interaction.reply({
        content: '❌ Join a voice channel first.',
        flags: MessageFlags.Ephemeral,
      });
    }

    const me = interaction.guild.members.me;
    const botVoiceId = me?.voice?.channelId;
    if (botVoiceId && botVoiceId !== voiceChannel.id) {
      return interaction.reply({
        content: `❌ I'm already playing in <#${botVoiceId}>.`,
        flags: MessageFlags.Ephemeral,
      });
    }

    const perms = voiceChannel.permissionsFor(me);
    const missing = [];
    if (!perms?.has('Connect')) missing.push('Connect');
    if (!perms?.has('Speak')) missing.push('Speak');
    if (missing.length > 0) {
      return interaction.reply({
        content: `❌ I need the **${missing.join('** and **')}** permission${missing.length > 1 ? 's' : ''} in <#${voiceChannel.id}>.`,
        flags: MessageFlags.Ephemeral,
      });
    }

    if (voiceChannel.full && !perms.has('MoveMembers')) {
      return interaction.reply({
        content: '❌ That voice channel is full.',
        flags: MessageFlags.Ephemeral,
      });
    }

    /* -- Resolve + play -------------------------------------------- */
    await interaction.deferReply();

    const player = interaction.client.getPlayer(interaction.guild.id, true);

    try {
      await player.connect(voiceChannel, interaction.channel);
    } catch (err) {
      return interaction.editReply(`❌ ${err.message}`);
    }

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

    try {
      await player.start();
    } catch (err) {
      console.error('[play] start failed:', err);
      return interaction.editReply(`❌ Failed to start playback: ${err.message}`);
    }

    /* -- Confirmation embed ---------------------------------------- */
    const sourceLabel = isSpotifyURL(query) ? 'Spotify → YouTube' : 'YouTube';
    const embed = new EmbedBuilder().setColor(0x57f287);

    if (tracks.length === 1) {
      const t = tracks[0];
      embed
        .setAuthor({ name: startedEmpty ? 'Playing now' : 'Added to queue' })
        .setTitle(t.title.slice(0, 250))
        .setURL(t.url)
        .addFields(
          { name: 'Duration', value: t.isLive ? '🔴 Live' : fmt(t.duration), inline: true },
          {
            name: 'Position',
            value: startedEmpty ? 'Playing now' : `#${player.queue.length}`,
            inline: true,
          },
          { name: 'Source', value: sourceLabel, inline: true },
        );
      if (t.thumbnail) embed.setThumbnail(t.thumbnail);
    } else {
      const totalMs = tracks.reduce((sum, t) => sum + (t.isLive ? 0 : t.duration), 0);
      embed
        .setAuthor({ name: 'Added to queue' })
        .setTitle((playlistName ?? 'Playlist').slice(0, 250))
        .setDescription(
          `**${tracks.length}** tracks queued · ${fmt(totalMs)} total\n` +
          `First up: [${tracks[0].title.slice(0, 80)}](${tracks[0].url})`,
        )
        .addFields({ name: 'Source', value: sourceLabel, inline: true });
      if (tracks[0].thumbnail) embed.setThumbnail(tracks[0].thumbnail);
    }

    const notes = [];
    if (skipped > 0) notes.push(`${skipped} track${skipped === 1 ? '' : 's'} couldn't be found on YouTube`);
    if (truncated) notes.push('list truncated to the first 60 tracks');
    if (notes.length > 0) embed.setFooter({ text: notes.join(' · ') });

    return interaction.editReply({ embeds: [embed] });
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
