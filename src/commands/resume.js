import { SlashCommandBuilder } from 'discord.js';
import { requireSameVoice } from '../voice/guards.js';

export default {
  data: new SlashCommandBuilder()
    .setName('resume')
    .setDescription('Resume the paused track'),

  async execute(interaction) {
    const player = interaction.client.getPlayer(interaction.guild.id);
    const guard = requireSameVoice(interaction, player);
    if (guard) return interaction.reply({ content: guard, ephemeral: true });

    if (!player.current) {
      return interaction.reply({ content: '❌ Nothing is queued.', ephemeral: true });
    }

    if (!player.isPaused) {
      return interaction.reply({ content: '▶ Already playing.', ephemeral: true });
    }

    if (!player.resume()) {
      return interaction.reply({ content: '❌ Couldn\'t resume playback.', ephemeral: true });
    }

    return interaction.reply(`▶ Resumed **${player.current.title.slice(0, 200)}**.`);
  },
};
