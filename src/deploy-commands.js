// Standalone slash-command deployment.
// Usage: npm run deploy
import { Collection } from 'discord.js';
import dotenv from 'dotenv';
import { registerCommands } from './commands/handler.js';

dotenv.config();

const { DISCORD_TOKEN, CLIENT_ID, GUILD_ID } = process.env;

if (!DISCORD_TOKEN || !CLIENT_ID) {
  console.error('[FATAL] Missing DISCORD_TOKEN or CLIENT_ID in .env');
  process.exit(1);
}

if (!GUILD_ID) {
  console.warn('[WARN] GUILD_ID is not set — commands will be registered GLOBALLY.');
  console.warn('[WARN] Global commands can take up to 1 HOUR to appear.');
  console.warn('[WARN] Set GUILD_ID in .env for instant registration in one server.\n');
}

// registerCommands only needs a `commands` collection to populate
const stub = { commands: new Collection() };

try {
  await registerCommands(stub, CLIENT_ID, GUILD_ID, { purgeGlobals: true });
  console.log('✅ Deploy complete.');
  process.exit(0);
} catch (err) {
  console.error('❌ Deploy failed:', err);
  process.exit(1);
}
