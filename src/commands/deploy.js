import { SlashCommandBuilder, PermissionFlagsBits, MessageFlags } from 'discord.js';
import { registerCommands } from './handler.js';

export default {
  data: new SlashCommandBuilder()
    .setName('deploy')
    .setDescription('Re-register all slash commands in this server (server admins only)')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  async execute(interaction) {
    try {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    } catch (err) {
      if (err?.code === 10062 || err?.code === 40060) {
        console.warn(`[deploy] Interaction already handled or expired: ${err.code}`);
        return;
      }
      throw err;
    }

    const clientId = process.env.CLIENT_ID;
    if (!clientId) {
      return interaction.editReply(
        '❌ `CLIENT_ID` is not set in the bot\'s environment variables.',
      );
    }

    try {
      await registerCommands(interaction.client, clientId, interaction.guild.id, { purgeGlobals: true });
      return interaction.editReply(
        '✅ Commands re-registered in this server (stale global commands removed).\n' +
        'They should refresh within a few seconds — if you still see the old behavior, ' +
        'restart your Discord client (**Ctrl/Cmd + R**) to clear the command cache.',
      );
    } catch (err) {
      console.error('[deploy]', err);
      return interaction.editReply(
        `❌ Failed to re-register commands: ${String(err?.message ?? err).slice(0, 250)}`,
      );
    }
  },
};