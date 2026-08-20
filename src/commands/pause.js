import { SlashCommandBuilder, MessageFlags } from 'discord.js';
import { requireSameVoice } from '../voice/guards.js';

export default {
  data: new SlashCommandBuilder()
    .setName('pause')
    .setDescription('Pause the current track'),

  async execute(interaction) {
    const player = interaction.client.getPlayer(interaction.guild.id);
    const guard = requireSameVoice(interaction, player);
    if (guard) return interaction.reply({ content: guard, flags: MessageFlags.Ephemeral });

    if (!player.current) {
      return interaction.reply({ content: '❌ Nothing is playing.', flags: MessageFlags.Ephemeral });
    }

    if (player.isPaused) {
      return interaction.reply({ content: '⏸ Already paused.', flags: MessageFlags.Ephemeral });
    }

    if (!player.pause()) {
      return interaction.reply({ content: '❌ Couldn\'t pause playback.', flags: MessageFlags.Ephemeral });
    }

    return interaction.reply(`⏸ Paused **${player.current.title.slice(0, 200)}**.`);
  },
};
