import { REST, Routes, Collection } from 'discord.js';
import { readdirSync } from 'node:fs';
import { basename } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { join } from 'node:path';

const commandsDir = fileURLToPath(new URL('./', import.meta.url));
const EXCLUDED = new Set(['handler']);

/** Loads every command module in this folder into client.commands. */
export async function loadCommands(client) {
  const files = readdirSync(commandsDir).filter(
    (f) => f.endsWith('.js') && !EXCLUDED.has(basename(f, '.js')),
  );

  client.commands = new Collection();
  const payload = [];

  for (const file of files) {
    // pathToFileURL keeps Windows paths valid as ESM specifiers
    const mod = await import(pathToFileURL(join(commandsDir, file)).href);
    const cmd = mod.default;

    if (!cmd?.data?.name || typeof cmd.execute !== 'function') {
      console.warn(`[WARN] ${file} is not a valid command — skipped.`);
      continue;
    }

    client.commands.set(cmd.data.name, cmd);
    payload.push(cmd.data.toJSON());
    console.log(`[CMD]  /${cmd.data.name}`);
  }

  return payload;
}

/** Deletes ALL globally-registered commands for this application. */
export async function clearGlobalCommands(clientId) {
  const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
  try {
    const existing = await rest.get(Routes.applicationCommands(clientId));
    if (existing.length > 0) {
      // Putting an empty array removes every global command.
      await rest.put(Routes.applicationCommands(clientId), { body: [] });
      console.log(`[PURGE] Removed ${existing.length} stale global command(s):`);
      for (const c of existing) console.log(`[PURGE]   - /${c.name}`);
    }
  } catch (err) {
    console.warn('[WARN] Could not clear global commands:', err?.message ?? err);
  }
}

/** Loads commands and registers them with Discord. */
export async function registerCommands(client, clientId, guildId, { purgeGlobals = false } = {}) {
  const payload = await loadCommands(client);
  if (payload.length === 0) {
    console.warn('[WARN] No commands to register.');
    return;
  }

  const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);

  // If GUILD_ID is set, try guild-scoped registration first
  if (guildId) {
    if (purgeGlobals) {
      await clearGlobalCommands(clientId);
    }

    try {
      await rest.put(Routes.applicationGuildCommands(clientId, guildId), { body: payload });
      console.log(`[INFO] Registered ${payload.length} command(s) in guild ${guildId}.`);
      await verifyCommands(rest, clientId, Routes.applicationGuildCommands(clientId, guildId));
      return;
    } catch (err) {
      // Guild registration failed (bot not in guild, wrong permissions, etc.)
      // Fall back to global registration instead of crashing
      console.warn(`[WARN] Could not register in guild ${guildId}: ${err?.message ?? err}`);
      console.warn('[WARN] Falling back to GLOBAL command registration (all servers).');
    }
  }

  // Global registration (all servers)
  const route = Routes.applicationCommands(clientId);
  await rest.put(route, { body: payload });
  console.log(`[INFO] Registered ${payload.length} command(s) globally (may take up to 1 hour to appear).`);
  await verifyCommands(rest, clientId, route);
}

/** Fetch back registered commands and log them for verification. */
async function verifyCommands(rest, clientId, route) {
  try {
    const registered = await rest.get(route);
    console.log('[VERIFY] Commands now live on Discord:');
    for (const cmd of registered) {
      const opts = (cmd.options ?? [])
        .map((o) => `${o.name}${o.required ? ' (required)' : ''}`)
        .join(', ') || '(no options)';
      console.log(`[VERIFY]   /${cmd.name}: ${opts}`);
    }
  } catch (err) {
    console.warn('[WARN] Could not verify registered commands:', err?.message ?? err);
  }
}
