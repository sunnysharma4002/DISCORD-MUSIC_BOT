import { SlashCommandBuilder } from 'discord.js';

export default {
  data: new SlashCommandBuilder()
    .setName('stop')
    .setDescription('Stop playback and leave the voice channel'),

  async execute(interaction) {
    const player = interaction.client.getPlayer(interaction.guild.id);
    if (!player || !player.voice) {
      return interaction.reply({ content: '❌ Not playing anything.', ephemeral: true });
    }

    player.stop();
    player.destroy();

    return interaction.reply({ content: '⏹ Stopped and left the voice channel.' });
  },
};
