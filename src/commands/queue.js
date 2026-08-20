import { SlashCommandBuilder, MessageFlags } from 'discord.js';

export default {
  data: new SlashCommandBuilder()
    .setName('queue')
    .setDescription('Show the current queue')
    .addIntegerOption((opt) =>
      opt.setName('page').setDescription('Page number').setMinValue(1),
    ),

  async execute(interaction) {
    const player = interaction.client.getPlayer(interaction.guild.id);

    if (!player || (!player.current && player.queue.length === 0)) {
      return interaction.reply({
        content: '📭 The queue is empty. Add something with `/play`.',
        flags: MessageFlags.Ephemeral,
      });
    }

    const page = (interaction.options.getInteger('page') ?? 1) - 1;
    return interaction.reply({ embeds: [player.queueEmbed(page)] });
  },
};
