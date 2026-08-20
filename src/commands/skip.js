import { SlashCommandBuilder, MessageFlags } from 'discord.js';
import { requireSameVoice } from '../voice/guards.js';

export default {
  data: new SlashCommandBuilder()
    .setName('skip')
    .setDescription('Skip the current track'),

  async execute(interaction) {
    const player = interaction.client.getPlayer(interaction.guild.id);
    const guard = requireSameVoice(interaction, player);
    if (guard) return interaction.reply({ content: guard, flags: MessageFlags.Ephemeral });

    if (!player.current) {
      return interaction.reply({ content: '❌ Nothing is playing.', flags: MessageFlags.Ephemeral });
    }

    const title = player.current.title;
    const hasNext = player.queue.length > 0 || player.loop !== 'off';
    player.skip();

    return interaction.reply(
      `⏭ Skipped **${title.slice(0, 200)}**.` +
      (hasNext ? '' : ' Queue is now empty.'),
    );
  },
};
