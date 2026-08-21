import { SlashCommandBuilder, MessageFlags, EmbedBuilder } from 'discord.js';

const THEMES = {
  default: { name: 'Default', color: 0x5865f2, emoji: '🔵' },
  night: { name: 'Night', color: 0x2b2d31, emoji: '🌙' },
  fire: { name: 'Fire', color: 0xff4500, emoji: '🔥' },
  ocean: { name: 'Ocean', color: 0x00b4d8, emoji: '🌊' },
  forest: { name: 'Forest', color: 0x2d6a4f, emoji: '🌿' },
  rose: { name: 'Rose', color: 0xff6b9d, emoji: '🌹' },
  gold: { name: 'Gold', color: 0xffd700, emoji: '✨' },
  void: { name: 'Void', color: 0x000000, emoji: '🕳️' },
};

export default {
  data: new SlashCommandBuilder()
    .setName('theme')
    .setDescription('Change the embed color theme')
    .addStringOption(opt =>
      opt.setName('theme')
        .setDescription('Theme to use')
        .setRequired(true)
        .addChoices(
          Object.entries(THEMES).map(([key, t]) => ({ name: `${t.emoji} ${t.name}`, value: key }))
        )
    ),

  async execute(interaction) {
    const key = interaction.options.getString('theme');
    const theme = THEMES[key];
    if (!theme) {
      return interaction.reply({
        content: `❌ Unknown theme. Available: ${Object.keys(THEMES).join(', ')}`,
        flags: MessageFlags.Ephemeral,
      });
    }

    const player = interaction.client.getPlayer(interaction.guild.id, true);
    player.theme = key;

    const embed = new EmbedBuilder()
      .setColor(theme.color)
      .setTitle(`${theme.emoji} Theme: ${theme.name}`)
      .setDescription(`Embeds will now use the **${theme.name}** color scheme.`)
      .addFields({ name: 'Color', value: `#${theme.color.toString(16).padStart(6, '0')}`, inline: true });

    return interaction.reply({ embeds: [embed] });
  },
};
