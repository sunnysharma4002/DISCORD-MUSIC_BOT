process.env.DEBUG = 'discord-voice*';

import dns from 'node:dns';
try {
  dns.setDefaultResultOrder('ipv4first');
} catch {}

import { Client, GatewayIntentBits, Collection, ActivityType, MessageFlags } from 'discord.js';
import { generateDependencyReport, AudioPlayerStatus } from '@discordjs/voice';
import { Player } from './voice/Player.js';
import { registerCommands } from './commands/handler.js';
import dotenv from 'dotenv';
import { writeFileSync, existsSync, unlinkSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

dotenv.config();

const { DISCORD_TOKEN, CLIENT_ID, GUILD_ID } = process.env;

if (!DISCORD_TOKEN || !CLIENT_ID) {
  console.error('[FATAL] Missing DISCORD_TOKEN or CLIENT_ID. Set them in .env or your host\'s environment variables.');
  process.exit(1);
}

/* Single-instance lock ------------------------------------------------ */
// Prevents two node processes from running the same bot token — the #1 cause
// of "Unknown interaction" (10062) errors when both answer the same command.
const LOCK_FILE = join(process.cwd(), '.bot.lock');

function acquireLock() {
  if (existsSync(LOCK_FILE)) {
    try {
      const pid = Number(readFileSync(LOCK_FILE, 'utf8'));
      if (pid && pid !== process.pid) {
        try {
          process.kill(pid, 0); // alive → duplicate instance
          console.error(`[FATAL] Another bot instance (PID ${pid}) is already running.`);
          console.error('        Stop the duplicate process (or restart the server) and try again.');
          process.exit(1);
        } catch (err) {
          if (err?.code !== 'ESRCH') {
            console.error(`[FATAL] Another bot instance (PID ${pid}) appears to be running.`);
            process.exit(1);
          }
          // stale lock (process died) → take over
          unlinkSync(LOCK_FILE);
        }
      }
    } catch { /* unreadable lock → treat as stale */ }
  }
  writeFileSync(LOCK_FILE, String(process.pid));
}

function releaseLock() {
  try {
    if (Number(readFileSync(LOCK_FILE, 'utf8')) === process.pid) unlinkSync(LOCK_FILE);
  } catch {}
}

acquireLock();

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

let readyHandled = false;
async function onReady() {
  if (readyHandled) return;
  readyHandled = true;

  console.log(`[READY] ${client.user.tag} online in ${client.guilds.cache.size} guild(s).`);

  if (!GUILD_ID) {
    console.error('[WARNING] GUILD_ID is not set in .env!');
    console.error('          Commands will register GLOBALLY and can take up to 1 HOUR');
    console.error('          to appear — stale commands will keep failing in the meantime.');
    console.error('          Set GUILD_ID to your server ID and restart, or use /deploy in a');
    console.error('          server once this bot has any commands.');
  }

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

/* Button handler ------------------------------------------------------ */
async function handleButton(interaction) {
  if (!interaction.inGuild()) return;

  const player = interaction.client.getPlayer(interaction.guild.id);
  if (!player || player.destroyed) return;

  const id = interaction.customId;

  switch (id) {
    case 'player_prev':
      // Restart current track or go to previous in history
      if (player.playbackMs > 3000) {
        player.audioPlayer.stop(true);
      } else if (player.history.length > 0) {
        const prev = player.history.pop();
        if (prev) {
          player.queue.unshift(prev);
          if (player.current) player.audioPlayer.stop(true);
        }
      }
      await interaction.deferUpdate();
      break;

    case 'player_pause':
      if (!player.current) {
        await interaction.reply({ content: '❌ Nothing playing.', flags: MessageFlags.Ephemeral });
        return;
      }
      if (player.isPaused) {
        player.resume();
      } else {
        player.pause();
      }
      await interaction.deferUpdate();
      break;

    case 'player_skip':
      if (!player.current) {
        await interaction.reply({ content: '❌ Nothing playing.', flags: MessageFlags.Ephemeral });
        return;
      }
      player.skip();
      await interaction.deferUpdate();
      break;

    case 'player_stop':
      player.stop();
      await interaction.deferUpdate();
      break;

    case 'player_autoplay':
      player.autoplay = !player.autoplay;
      console.log(`[player] autoplay toggled: ${player.autoplay}`);
      await interaction.deferUpdate();
      await player.updateControlPanel();
      break;

    case 'player_loop':
      // Cycle: off → track → queue → off
      if (player.loop === 'off') {
        player.loop = 'track';
      } else if (player.loop === 'track') {
        player.loop = 'queue';
      } else {
        player.loop = 'off';
      }
      console.log(`[player] loop set to: ${player.loop}`);
      await interaction.deferUpdate();
      await player.updateControlPanel();
      break;

    case 'player_shuffle':
      if (player.queue.length < 2) {
        await interaction.reply({ content: '❌ Need at least 2 tracks in queue to shuffle.', flags: MessageFlags.Ephemeral });
        return;
      }
      player.shuffle();
      console.log('[player] queue shuffled');
      await interaction.deferUpdate();
      await player.updateControlPanel();
      break;

    case 'player_queue':
      await interaction.deferUpdate();
      // Send queue embed as ephemeral reply
      const queueEmbed = player.queueEmbed(0, 10);
      await interaction.followUp({ embeds: [queueEmbed], flags: MessageFlags.Ephemeral });
      break;

    case 'player_volume_up':
      if (player.audioPlayer.state.status === AudioPlayerStatus.Playing) {
        const vol = player.audioPlayer.state.resource.volume?.volume ?? 1;
        const newVol = Math.min(vol + 0.1, 2);
        player.audioPlayer.state.resource.volume?.setVolume(newVol);
        console.log(`[player] volume up: ${Math.round(newVol * 100)}%`);
        await interaction.deferUpdate();
        await player.updateControlPanel();
      } else {
        await interaction.reply({ content: '❌ Nothing playing.', flags: MessageFlags.Ephemeral });
      }
      break;

    case 'player_volume_down':
      if (player.audioPlayer.state.status === AudioPlayerStatus.Playing) {
        const vol = player.audioPlayer.state.resource.volume?.volume ?? 1;
        const newVol = Math.max(vol - 0.1, 0.1);
        player.audioPlayer.state.resource.volume?.setVolume(newVol);
        console.log(`[player] volume down: ${Math.round(newVol * 100)}%`);
        await interaction.deferUpdate();
        await player.updateControlPanel();
      } else {
        await interaction.reply({ content: '❌ Nothing playing.', flags: MessageFlags.Ephemeral });
      }
      break;

    default:
      break;
  }

  // Update button states after a delay to reflect the new player state
  // Wait longer for skip/prev since _advance() needs time to fetch the next track
  const updateDelay = (id === 'player_skip' || id === 'player_prev') ? 2000 : 500;

  setTimeout(async () => {
    if (player.destroyed) return;

    // Update the control panel if it exists
    if (player.controlPanelMessageId && player.current) {
      await player.updateControlPanel();
    }
  }, updateDelay);
}

/* Command dispatch ---------------------------------------------------- */
client.on('interactionCreate', async (interaction) => {
  // Button interactions
  if (interaction.isButton()) {
    return handleButton(interaction);
  }

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

// Another instance logged in with the same token — this session is now stale.
// Shut down so we don't fight the newer instance over the same interactions.
client.on('invalidated', () => {
  console.error('[FATAL] Gateway session invalidated — another instance logged in with this token.');
  console.error('        Shutting down to avoid duplicate command handling.');
  releaseLock();
  process.exit(0);
});

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
    releaseLock();
    process.exit(0);
  });
}

client.login(DISCORD_TOKEN).catch((err) => {
  console.error('[FATAL] Login failed:', err.message);
  process.exit(1);
});
