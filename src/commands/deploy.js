import { SlashCommandBuilder, PermissionFlagsBits, MessageFlags } from 'discord.js';
import { registerCommands } from './handler.js';

export default {
  data: new SlashCommandBuilder()
    .setName('deploy')
    .setDescription('Re-register all slash commands globally (server admins only)')
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
      // Register globally (all servers), not just this guild
      await registerCommands(interaction.client, clientId, null, { purgeGlobals: true });
      return interaction.editReply(
        '✅ Commands re-registered **globally** in all servers.\n' +
        'This can take up to **1 hour** to appear everywhere. ' +
        'If you still see old commands, restart Discord (**Ctrl/Cmd + R**) to clear the cache.',
      );
    } catch (err) {
      console.error('[deploy]', err);
      return interaction.editReply(
        `❌ Failed to re-register commands: ${String(err?.message ?? err).slice(0, 250)}`,
      );
    }
  },
};
