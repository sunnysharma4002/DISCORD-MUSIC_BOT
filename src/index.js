import { Client, GatewayIntentBits, Collection, ActivityType } from 'discord.js';
import { Player } from './voice/Player.js';
import { registerCommands } from './commands/handler.js';
import dotenv from 'dotenv';

dotenv.config();

const { DISCORD_TOKEN, CLIENT_ID } = process.env;

if (!DISCORD_TOKEN || !CLIENT_ID) {
  console.error('[FATAL] Missing DISCORD_TOKEN or CLIENT_ID in .env file.');
  process.exit(1);
}

// Initialize Discord client with required intents
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

// One Player instance per guild — manages voice connection + queue
client.players = new Collection();

client.getPlayer = (guildId, create = false) => {
  let player = client.players.get(guildId);
  if (!player && create) {
    player = new Player(client, guildId);
    client.players.set(guildId, player);
  }
  return player;
};

client.once('ready', async () => {
  console.log(`[READY] ${client.user.tag} is online.`);
  console.log(`[INFO]  Connected to ${client.guilds.cache.size} guild(s).`);

  // Set bot status
  client.user.setPresence({
    activities: [{ name: '/play to start music', type: ActivityType.Listening }],
    status: 'online',
  });

  // Register slash commands (guild-scoped for fast updates during dev)
  try {
    await registerCommands(client, CLIENT_ID, process.env.GUILD_ID);
    console.log('[INFO]  Slash commands registered.');
  } catch (err) {
    console.error('[ERROR] Failed to register commands:', err);
  }
});

// Handle voice state updates — clean up player when bot is alone
client.on('voiceStateUpdate', async (oldState, newState) => {
  const player = client.players.get(newState.guild.id);
  if (!player) return;

  const botMember = newState.guild.members.me;
  if (!botMember?.voice.channelId) {
    player.destroy();
    return;
  }

  const othersInChannel = newState.channel?.members.filter(
    (m) => m.id !== botMember.id && !m.user.bot
  ).size;

  if (othersInChannel === 0 && player.emptyChannelTimeout === null) {
    // No humans left — auto-leave after 30s
    player.emptyChannelTimeout = setTimeout(() => {
      const current = player.voice?.connection?.joinConfig.channelId;
      const stillEmpty = current &&
        newState.guild.members.me?.voice.channelId === current &&
        newState.channel?.members.filter(m => m.id !== botMember.id && !m.user.bot).size === 0;
      if (stillEmpty) {
        player.stop();
        player.destroy();
        const ch = newState.guild.channels.cache.get(player.textChannelId);
        if (ch) ch.send({ content: '⏹ Left voice channel — no listeners.' }).catch(() => {});
      }
      player.emptyChannelTimeout = null;
    }, 30_000);
  } else if (othersInChannel > 0 && player.emptyChannelTimeout) {
    clearTimeout(player.emptyChannelTimeout);
    player.emptyChannelTimeout = null;
  }
});

client.on('error', (err) => console.error('[CLIENT ERROR]', err));
client.on('warn', (warn) => console.warn('[CLIENT WARN]', warn));

// Dispatch slash commands to their handlers
client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  const command = client.commands?.get(interaction.commandName);
  if (!command) return;

  try {
    await command.execute(interaction);
  } catch (err) {
    console.error(`[CMD ERROR] ${interaction.commandName}:`, err);
    const reply = { content: '❌ An error occurred while executing that command.', ephemeral: true };
    if (interaction.replied || interaction.deferred) {
      await interaction.followUp(reply).catch(() => {});
    } else {
      await interaction.reply(reply).catch(() => {});
    }
  }
});

client.login(DISCORD_TOKEN);
