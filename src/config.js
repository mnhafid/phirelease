import { readFileSync, existsSync } from 'node:fs';
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
loadEnvFile(fileURLToPath(new URL('../.env', import.meta.url)));

function required(key) {
  const value = process.env[key];
  if (!value) throw new Error(`missing required env var ${key} (see .env.example)`);
  return value;
}

export const config = {
  tgToken: required('TG_TOKEN'),
  tgChatId: required('TG_CHAT_ID'),
  repoDir: required('REPO_DIR'),
  releaseRemote: process.env.RELEASE_REMOTE || 'origin',
  pushRemote: process.env.PUSH_REMOTE || 'ups',
  // ponytail: whitespace split, no quote-aware parsing — EF_ARGS paths must not contain spaces (documented in .env.example).
  efArgs: (process.env.EF_ARGS || '').split(/\s+/).filter(Boolean),
  vpnSubnetPrefix: process.env.VPN_SUBNET_PREFIX || '',
  vpnIfacePattern: process.env.VPN_IFACE_PATTERN || '^(utun|tun|wg|ppp|tap)',
  internetCheckUrl: process.env.INTERNET_CHECK_URL || 'https://api.telegram.org',
};

// Fail at startup, not silently on every 20-minute tick, if the pattern is broken.
try {
  new RegExp(config.vpnIfacePattern);
} catch (err) {
  throw new Error(`bad VPN_IFACE_PATTERN "${config.vpnIfacePattern}": ${err.message}`);
}
