import { spawn } from 'node:child_process';

// Delivers one alert over iroh: `dumbpipe connect <ticket>` with the text on
// stdin. The relay (relay/telegram-relay.js) closes cleanly only once
// Telegram accepted it, so dumbpipe exits 0 on delivery. Resolves false on any failure (no dumbpipe,
// unreachable peer, timeout) so the caller's outbox keeps it for a retry.
export function sendViaDumbpipe(dumbpipe, ticket, text, timeoutMs = 30_000) {
  return new Promise((resolve) => {
    const p = spawn(dumbpipe, ['connect', ticket], { stdio: ['pipe', 'ignore', 'ignore'] });
    const timer = setTimeout(() => p.kill(), timeoutMs);
    const done = (ok) => {
      clearTimeout(timer);
      resolve(ok);
    };
    p.on('error', () => done(false));
    p.on('exit', (code) => done(code === 0));
    p.stdin.on('error', () => {});
    p.stdin.end(`${text}\n`);
  });
}
