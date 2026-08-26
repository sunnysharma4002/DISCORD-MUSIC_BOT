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

const scope = GUILD_ID
  ? `guild ${GUILD_ID} (instant)`
  : 'ALL servers globally (up to 1 hour to appear)';

console.log(`\n🔧 Registering commands in ${scope}...\n`);

// registerCommands only needs a `commands` collection to populate
const stub = { commands: new Collection() };

try {
  await registerCommands(stub, CLIENT_ID, GUILD_ID, { purgeGlobals: true });
  console.log('\n✅ Deploy complete.');
  process.exit(0);
} catch (err) {
  console.error('❌ Deploy failed:', err);
  process.exit(1);
}
