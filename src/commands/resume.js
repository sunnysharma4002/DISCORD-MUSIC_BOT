import { SlashCommandBuilder, MessageFlags } from 'discord.js';
import { requireSameVoice } from '../voice/guards.js';

export default {
  data: new SlashCommandBuilder()
    .setName('resume')
    .setDescription('Resume the paused track'),

  async execute(interaction) {
    const player = interaction.client.getPlayer(interaction.guild.id);
    const guard = requireSameVoice(interaction, player);
    if (guard) return interaction.reply({ content: guard, flags: MessageFlags.Ephemeral });

    if (!player.current) {
      return interaction.reply({ content: '❌ Nothing is queued.', flags: MessageFlags.Ephemeral });
    }

    if (!player.isPaused) {
      return interaction.reply({ content: '▶ Already playing.', flags: MessageFlags.Ephemeral });
    }

    if (!player.resume()) {
      return interaction.reply({ content: '❌ Couldn\'t resume playback.', flags: MessageFlags.Ephemeral });
    }

    return interaction.reply(`▶ Resumed **${player.current.title.slice(0, 200)}**.`);
  },
};
