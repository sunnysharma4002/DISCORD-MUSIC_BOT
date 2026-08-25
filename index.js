import dns from 'node:dns';
try {
  dns.setDefaultResultOrder('ipv4first');
} catch {}

const nodeMajor = Number(process.versions.node.split('.')[0]);

if (nodeMajor < 20) {
  console.error('==============================================================');
  console.error(`[FATAL] Detected Node.js ${process.versions.node}`);
  console.error('        This bot requires Node.js 20 or newer.');
  console.error('        Node 18 cannot run the current dependencies');
  console.error('        (undici/discord.js need the global "File" API, Node 20+).');
  console.error('==============================================================');
  console.error('  HOW TO FIX:');
  console.error('  1. Open your hosting panel (Pterodactyl / Bot-Hosting).');
  console.error('  2. Go to the Startup / Egg settings for this server.');
  console.error('  3. Change the Node.js version to 20 or 22 (LTS).');
  console.error('  4. Restart the server.');
  console.error('==============================================================');
  process.exit(1);
}

await import('./src/index.js');