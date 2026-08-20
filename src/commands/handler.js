import { REST, Routes } from 'discord.js';
import { readdirSync } from 'node:fs';
import { basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const commandsDir = fileURLToPath(new URL('./', import.meta.url));

/**
 * Auto-discovers command files in this directory, loads them,
 * and registers all slash commands with Discord (guild-scoped).
 */
export async function registerCommands(client, clientId, guildId) {
  const commandFiles = readdirSync(commandsDir)
    .filter(f => f.endsWith('.js') && basename(f, '.js') !== 'handler');

  const commands = [];
  client.commands = new (await import('discord.js')).Collection();

  for (const file of commandFiles) {
    const { default: cmd } = await import(`./${file}`);
    if (!cmd?.data?.name) {
      console.warn(`[WARN] Skipping ${file} — no command data.`);
      continue;
    }
    client.commands.set(cmd.data.name, cmd);
    commands.push(cmd.data.toJSON());
    console.log(`[CMD]   Loaded: ${cmd.data.name}`);
  }

  const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);

  try {
    console.log(`[INFO]  Registering ${commands.length} slash command(s)...`);

    if (guildId) {
      // Guild-scoped (instant update, good for dev)
      await rest.put(
        Routes.applicationGuildCommands(clientId, guildId),
        { body: commands }
      );
    } else {
      // Global (up to 1h propagation)
      await rest.put(
        Routes.applicationCommands(clientId),
        { body: commands }
      );
    }

    console.log('[INFO]  Commands registered successfully.');
  } catch (err) {
    console.error('[ERROR] Command registration failed:', err);
    throw err;
  }
}
