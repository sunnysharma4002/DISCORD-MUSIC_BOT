import { SlashCommandBuilder, MessageFlags } from 'discord.js';
import { requireSameVoice } from '../voice/guards.js';

export default {
  data: new SlashCommandBuilder()
    .setName('autoplay')
    .setDescription('Toggle autoplay — automatically play related songs when queue empties'),

  async execute(interaction) {
    const player = interaction.client.getPlayer(interaction.guild.id);
    const guard = requireSameVoice(interaction, player);
    if (guard) return interaction.reply({ content: guard, flags: MessageFlags.Ephemeral });

    player.autoplay = !player.autoplay;
    const state = player.autoplay ? 'on' : 'off';
    const msg = player.autoplay
      ? '🔁 Autoplay is now **on** — related songs will play when the queue empties.'
      : '⏹ Autoplay is now **off**.';

    return interaction.reply({ content: msg, flags: MessageFlags.Ephemeral });
  },
};
