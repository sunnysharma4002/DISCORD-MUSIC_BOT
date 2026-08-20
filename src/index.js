import { Client, GatewayIntentBits, Collection, ActivityType, MessageFlags } from 'discord.js';
import { generateDependencyReport } from '@discordjs/voice';
import { Player } from './voice/Player.js';
import { registerCommands } from './commands/handler.js';
import dotenv from 'dotenv';

dotenv.config();

const { DISCORD_TOKEN, CLIENT_ID, GUILD_ID } = process.env;

if (!DISCORD_TOKEN || !CLIENT_ID) {
  console.error('[FATAL] Missing DISCORD_TOKEN or CLIENT_ID. Set them in .env or your host\'s environment variables.');
  process.exit(1);
}

// Print the voice dependency report once — invaluable for diagnosing
// "connects but no audio" issues (missing opus/sodium/ffmpeg).
console.log(generateDependencyReport());

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
});

/* One Player per guild ------------------------------------------------ */
client.players = new Collection();

client.getPlayer = (guildId, create = false) => {
  let player = client.players.get(guildId);
  if (player?.destroyed) {
    client.players.delete(guildId);
    player = undefined;
  }
  if (!player && create) {
    player = new Player(client, guildId);
    client.players.set(guildId, player);
  }
  return player;
};

/* Ready --------------------------------------------------------------- */
client.once('clientReady', onReady);
client.once('ready', onReady); // fallback for discord.js < 14.19

let readyHandled = false;
async function onReady() {
  if (readyHandled) return;
  readyHandled = true;

  console.log(`[READY] ${client.user.tag} online in ${client.guilds.cache.size} guild(s).`);

  client.user.setPresence({
    activities: [{ name: '/play', type: ActivityType.Listening }],
    status: 'online',
  });

  try {
    await registerCommands(client, CLIENT_ID, GUILD_ID);
  } catch (err) {
    console.error('[ERROR] Command registration failed:', err);
  }
}

/* Command dispatch ---------------------------------------------------- */
client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  if (!interaction.inGuild()) {
    return interaction.reply({
      content: '❌ Music commands only work inside a server.',
      flags: MessageFlags.Ephemeral,
    });
  }

  const command = client.commands?.get(interaction.commandName);
  if (!command) return;

  try {
    await command.execute(interaction);
  } catch (err) {
    console.error(`[CMD ERROR] /${interaction.commandName}:`, err);

    const payload = {
      content: `❌ Something went wrong: ${String(err?.message ?? 'unknown error').slice(0, 300)}`,
    };

    // Stale command cache → option missing → tell the user how to fix it
    if (err?.code === 'CommandInteractionOptionNotFound' || /Required option .* not found/.test(String(err?.message ?? ''))) {
      payload.content =
        '❌ Stale slash command detected — Discord is using an outdated command definition.\n\n' +
        '**Fix:** run `npm run deploy` in the host console (sets `GUILD_ID` in `.env` first), then **restart Discord** or wait ~1 minute for the cache to refresh.';
    }

    try {
      if (interaction.deferred) await interaction.editReply(payload);
      else if (interaction.replied) await interaction.followUp({ ...payload, flags: MessageFlags.Ephemeral });
      else await interaction.reply({ ...payload, flags: MessageFlags.Ephemeral });
    } catch {
      /* interaction token expired — nothing to do */
    }
  }
});

/* Auto-leave when the voice channel empties ---------------------------- */
const EMPTY_LEAVE_MS = 30_000;

client.on('voiceStateUpdate', (oldState, newState) => {
  const guildId = (oldState.guild ?? newState.guild)?.id;
  const player = client.players.get(guildId);
  if (!player || player.destroyed) return;

  // The bot itself was disconnected or moved by someone else
  if (oldState.id === client.user.id) {
    if (!newState.channelId) {
      player.destroy();
      return;
    }
    player.voiceChannelId = newState.channelId;
  }

  const channel = newState.guild.channels.cache.get(player.voiceChannelId);
  if (!channel) return;

  const humans = channel.members.filter((m) => !m.user.bot).size;

  if (humans === 0) {
    if (player.emptyChannelTimeout) return;
    player.emptyChannelTimeout = setTimeout(() => {
      player.emptyChannelTimeout = null;
      const stillEmpty =
        client.channels.cache.get(player.voiceChannelId)?.members.filter((m) => !m.user.bot).size === 0;
      if (stillEmpty && !player.destroyed) {
        player._notify('👋 Everyone left — disconnecting.');
        player.destroy();
      }
    }, EMPTY_LEAVE_MS);
  } else if (player.emptyChannelTimeout) {
    clearTimeout(player.emptyChannelTimeout);
    player.emptyChannelTimeout = null;
  }
});

/* Process-level safety nets ------------------------------------------- */
client.on('error', (err) => console.error('[CLIENT ERROR]', err));
client.on('warn', (msg) => console.warn('[CLIENT WARN]', msg));

process.on('unhandledRejection', (reason) => {
  console.error('[UNHANDLED REJECTION]', reason);
});

process.on('uncaughtException', (err) => {
  console.error('[UNCAUGHT EXCEPTION]', err);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    console.log(`[SHUTDOWN] ${signal} received — cleaning up.`);
    for (const player of client.players.values()) {
      try { player.destroy(); } catch {}
    }
    client.destroy();
    process.exit(0);
  });
}

client.login(DISCORD_TOKEN).catch((err) => {
  console.error('[FATAL] Login failed:', err.message);
  process.exit(1);
});
