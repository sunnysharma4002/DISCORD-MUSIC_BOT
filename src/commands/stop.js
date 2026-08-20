import { SlashCommandBuilder, MessageFlags } from 'discord.js';
import { requireSameVoice } from '../voice/guards.js';

export default {
  data: new SlashCommandBuilder()
    .setName('stop')
    .setDescription('Stop playback, clear the queue, and leave the voice channel'),

  async execute(interaction) {
    const player = interaction.client.getPlayer(interaction.guild.id);
    const guard = requireSameVoice(interaction, player);
    if (guard) return interaction.reply({ content: guard, flags: MessageFlags.Ephemeral });

    const cleared = player.queue.length;
    player.stop();
    player.destroy();

    return interaction.reply(
      `⏹ Stopped and left the voice channel.` +
      (cleared > 0 ? ` Cleared **${cleared}** queued track${cleared === 1 ? '' : 's'}.` : ''),
    );
  },
};
