import { SlashCommandBuilder, EmbedBuilder } from 'discord.js';

export default {
  data: new SlashCommandBuilder()
    .setName('skip')
    .setDescription('Skip the current track'),

  async execute(interaction) {
    const player = interaction.client.getPlayer(interaction.guild.id);
    if (!player || !player.current) {
      return interaction.reply({ content: '❌ Nothing is playing right now.', ephemeral: true });
    }

    const previous = player.current;
    player.skip();

    const embed = new EmbedBuilder()
      .setColor(0x5865F2)
      .setTitle('⏭ Skipped')
      .setDescription(`**${previous.title}**`)
      .setTimestamp();

    return interaction.reply({ embeds: [embed] });
  },
};
