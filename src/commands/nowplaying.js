import { SlashCommandBuilder, MessageFlags } from 'discord.js';

export default {
  data: new SlashCommandBuilder()
    .setName('nowplaying')
    .setDescription('Show the currently playing track with controls'),

  async execute(interaction) {
    const player = interaction.client.getPlayer(interaction.guild.id);

    if (!player || !player.current) {
      return interaction.reply({
        content: '❌ Nothing is playing right now.',
        flags: MessageFlags.Ephemeral,
      });
    }

    const embed = player.nowPlayingEmbed();
    const row = player.controlRow();

    return interaction.reply({
      content: '## 🎵 **Now Playing**',
      embeds: [embed],
      components: [row],
    });
  },
};
