// Writes VPN_SUBNET_PREFIX into .env.
//   npm run vpn-set-prefix -- 10.151.     (direct)
//   npm run vpn-set-prefix                (interactive: pick from detected addresses)
import { readFileSync, writeFileSync, existsSync, copyFileSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { networkInterfaces } from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('..', import.meta.url));
const envPath = path.join(root, '.env');
const examplePath = path.join(root, '.env.example');

if (!existsSync(envPath)) {
  copyFileSync(examplePath, envPath);
  console.log('created .env from .env.example');
}

function setPrefix(prefix) {
  const lines = readFileSync(envPath, 'utf8').split('\n');
  const idx = lines.findIndex((l) => /^VPN_SUBNET_PREFIX=/.test(l));
  const line = `VPN_SUBNET_PREFIX=${prefix}`;
  if (idx === -1) lines.push(line);
  else lines[idx] = line;
  writeFileSync(envPath, lines.join('\n'));
  console.log(`.env updated: ${line}`);
}

const argPrefix = process.argv[2];
if (argPrefix) {
  setPrefix(argPrefix.endsWith('.') ? argPrefix : `${argPrefix}.`);
  process.exit(0);
}

const candidates = Object.entries(networkInterfaces())
  .flatMap(([name, addrs]) => (addrs ?? []).map((a) => ({ name, ...a })))
  .filter((a) => a.family === 'IPv4' && !a.internal);

if (candidates.length === 0) {
  console.log('no non-internal IPv4 addresses found — connect the VPN first, or pass a prefix directly:');
  console.log('  npm run vpn-set-prefix -- 10.151.');
  process.exit(1);
}

console.log('candidate addresses (connect the VPN first if you have not):\n');
candidates.forEach((c, i) => console.log(`  ${i + 1}. ${c.name}  ${c.address}`));

const rl = createInterface({ input: process.stdin, output: process.stdout });
const answer = await rl.question('\npick a number (the VPN one): ');
rl.close();

const chosen = candidates[Number(answer) - 1];
if (!chosen) {
  console.error('invalid choice');
  process.exit(1);
}

setPrefix(`${chosen.address.split('.').slice(0, 3).join('.')}.`);
