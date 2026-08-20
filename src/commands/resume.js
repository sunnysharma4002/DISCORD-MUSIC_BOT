import { SlashCommandBuilder, EmbedBuilder } from 'discord.js';

export default {
  data: new SlashCommandBuilder()
    .setName('resume')
    .setDescription('Resume the paused track'),

  async execute(interaction) {
    const player = interaction.client.getPlayer(interaction.guild.id);
    if (!player || !player.current) {
      return interaction.reply({ content: '❌ Nothing is playing.', ephemeral: true });
    }

    if (!player.audioPlayer.paused) {
      return interaction.reply({ content: '▶ Already playing.', ephemeral: true });
    }

    player.resume();

    const embed = new EmbedBuilder()
      .setColor(0x57F287)
      .setTitle('▶ Resumed')
      .setDescription(`**${player.current.title}**`)
      .setTimestamp();

    return interaction.reply({ embeds: [embed] });
  },
};
