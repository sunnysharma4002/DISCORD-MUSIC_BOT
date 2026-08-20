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

// registerCommands only needs a `commands` collection to populate
const stub = { commands: new Collection() };

try {
  await registerCommands(stub, CLIENT_ID, GUILD_ID);
  console.log('✅ Deploy complete.');
  process.exit(0);
} catch (err) {
  console.error('❌ Deploy failed:', err);
  process.exit(1);
}
