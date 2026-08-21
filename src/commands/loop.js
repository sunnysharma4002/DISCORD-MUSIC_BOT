import { SlashCommandBuilder, MessageFlags } from 'discord.js';
import { requireSameVoice } from '../voice/guards.js';

const MODES = ['off', 'track', 'queue'];
const EMOJIS = { off: '⏹', track: '🔂', queue: '🔁' };
const LABELS = { off: 'Loop off', track: 'Loop track', queue: 'Loop queue' };

export default {
  data: new SlashCommandBuilder()
    .setName('loop')
    .setDescription('Cycle or set loop mode')
    .addStringOption(opt =>
      opt.setName('mode')
        .setDescription('Loop mode: off, track, or queue')
        .addChoices(
          { name: 'Off', value: 'off' },
          { name: 'Track', value: 'track' },
          { name: 'Queue', value: 'queue' },
        )
    ),

  async execute(interaction) {
    const player = interaction.client.getPlayer(interaction.guild.id);
    const guard = requireSameVoice(interaction, player);
    if (guard) return interaction.reply({ content: guard, flags: MessageFlags.Ephemeral });

    const input = interaction.options.getString('mode');

    if (input) {
      if (!MODES.includes(input)) {
        return interaction.reply({ content: '❌ Invalid mode. Choose: off, track, or queue.', flags: MessageFlags.Ephemeral });
      }
      player.loop = input;
    } else {
      // Cycle: off → track → queue → off
      const idx = MODES.indexOf(player.loop);
      player.loop = MODES[(idx + 1) % MODES.length];
    }

    const mode = player.loop;
    return interaction.reply(`${EMOJIS[mode]} **${LABELS[mode]}**.`);
  },
};
