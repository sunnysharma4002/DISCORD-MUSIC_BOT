import { SlashCommandBuilder, EmbedBuilder } from 'discord.js';

export default {
  data: new SlashCommandBuilder()
    .setName('pause')
    .setDescription('Pause the current track'),

  async execute(interaction) {
    const player = interaction.client.getPlayer(interaction.guild.id);
    if (!player || !player.current) {
      return interaction.reply({ content: '❌ Nothing is playing.', ephemeral: true });
    }

    if (player.audioPlayer.paused) {
      return interaction.reply({ content: '⏸ Already paused.', ephemeral: true });
    }

    player.pause();

    const embed = new EmbedBuilder()
      .setColor(0xFAA61A)
      .setTitle('⏸ Paused')
      .setDescription(`**${player.current.title}**`)
      .setTimestamp();

    return interaction.reply({ embeds: [embed] });
  },
};
