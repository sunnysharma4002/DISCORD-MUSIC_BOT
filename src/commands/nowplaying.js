import { SlashCommandBuilder, MessageFlags } from 'discord.js';

export default {
  data: new SlashCommandBuilder()
    .setName('nowplaying')
    .setDescription('Show the currently playing track'),

  async execute(interaction) {
    const player = interaction.client.getPlayer(interaction.guild.id);

    if (!player || !player.current) {
      return interaction.reply({
        content: '❌ Nothing is playing right now.',
        flags: MessageFlags.Ephemeral,
      });
    }

    return interaction.reply({ embeds: [player.nowPlayingEmbed()] });
  },
};
