import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnvContent } from './env-parse.js';

function loadEnvFile(path) {
  if (!existsSync(path)) return;
  for (const [key, value] of Object.entries(parseEnvContent(readFileSync(path, 'utf8')))) {
    if (!(key in process.env)) process.env[key] = value;
  }
}

// import.meta.url -> URL.pathname is `/C:/...` (percent-encoded) on Windows,
// which existsSync/readFileSync silently fail to find. fileURLToPath handles
// both OSes and paths containing spaces.
const root = fileURLToPath(new URL('..', import.meta.url));
loadEnvFile(join(root, '.env'));

function required(key) {
  const value = process.env[key];
  if (!value) throw new Error(`missing required env var ${key} (see .env.example)`);
  return value;
}

export const config = {
  // Telegram is optional: blank TG_TOKEN = no /deploy, alerts go to the log only.
  tgToken: process.env.TG_TOKEN || '',
  tgChatId: process.env.TG_TOKEN ? required('TG_CHAT_ID') : '',
  repoDir: required('REPO_DIR'),
  releaseRemote: process.env.RELEASE_REMOTE || 'origin',
  pushRemote: process.env.PUSH_REMOTE || 'ups',
  // ponytail: whitespace split, no quote-aware parsing — EF_ARGS paths must not contain spaces (documented in .env.example).
  efArgs: (process.env.EF_ARGS || '').split(/\s+/).filter(Boolean),
  vpnSubnetPrefix: process.env.VPN_SUBNET_PREFIX || '',
  vpnIfacePattern: process.env.VPN_IFACE_PATTERN || '^(utun|tun|wg|ppp|tap)',
  internetCheckUrl: process.env.INTERNET_CHECK_URL || 'https://api.telegram.org',
  watchRef: process.env.WATCH_REF || '', // e.g. origin/phi-dev; blank = auto-pull off
  watchIntervalMin: Number(process.env.WATCH_INTERVAL_MIN) || 1,
  syncTarget: process.env.SYNC_TARGET || '', // e.g. ups/ict-dev; force-pushed to WATCH_REF's commit. blank = no push
  // Alerts over iroh to the Telegram relay container (relay/). Blank = log only.
  notifyTicket: process.env.NOTIFY_TICKET || '',
  dumbpipe: process.env.DUMBPIPE || (existsSync(join(root, 'dumbpipe.exe')) ? join(root, 'dumbpipe.exe') : 'dumbpipe'),
};

for (const key of ['watchRef', 'syncTarget']) {
  if (config[key] && !/^[\w.-]+\/[\w./-]+$/.test(config[key])) {
    throw new Error(`bad ${key} "${config[key]}", expected <remote>/<branch> e.g. origin/phi-dev`);
  }
}
if (config.syncTarget && !config.watchRef) {
  throw new Error('SYNC_TARGET needs WATCH_REF set');
}

// Fail at startup, not silently on every 20-minute tick, if the pattern is broken.
try {
  new RegExp(config.vpnIfacePattern);
} catch (err) {
  throw new Error(`bad VPN_IFACE_PATTERN "${config.vpnIfacePattern}": ${err.message}`);
}
