import { SlashCommandBuilder } from 'discord.js';

export default {
  data: new SlashCommandBuilder()
    .setName('queue')
    .setDescription('Show the current music queue')
    .addIntegerOption(opt =>
      opt.setName('page')
        .setDescription('Page number (default: 1)')
        .setMinValue(1)
    ),

  async execute(interaction) {
    const player = interaction.client.getPlayer(interaction.guild.id);
    if (!player || (!player.current && player.queue.length === 0)) {
      return interaction.reply({ content: '❌ The queue is empty.', ephemeral: true });
    }

    const page = Math.max(0, (interaction.options.getInteger('page') ?? 1) - 1);
    const embed = player.queueEmbed(page);

    return interaction.reply({ embeds: [embed] });
  },
};
