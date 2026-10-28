import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nextMark } from '../src/scheduler.js';
import { DATE_RE, today } from '../src/git-deploy.js';
import { parseEnvContent } from '../src/env-parse.js';
import { isVpnConnected } from '../src/net-check.js';

test('nextMark rounds up to the next :00/:20/:40', () => {
  assert.equal(nextMark(new Date('2026-09-29T12:05:00')).getMinutes(), 20);
  assert.equal(nextMark(new Date('2026-09-29T12:25:00')).getMinutes(), 40);
  assert.equal(nextMark(new Date('2026-09-29T12:45:00')).getHours(), 13);
  assert.equal(nextMark(new Date('2026-09-29T12:45:00')).getMinutes(), 0);
});

test('DATE_RE only accepts YYYYMMDD', () => {
  assert.ok(DATE_RE.test('20260929'));
  assert.ok(!DATE_RE.test('2026-09-29'));
  assert.ok(!DATE_RE.test('; rm -rf /'));
});

test('today() uses local date fields, not UTC', () => {
  assert.equal(today(new Date(2026, 0, 5)), '20260105'); // month is 0-indexed in the Date constructor
});

test('parseEnvContent: quotes, comments, blank lines', () => {
  const parsed = parseEnvContent([
    '# a comment',
    '',
    'TG_TOKEN=abc123',
    'PUSH_REMOTE=ups  # inline comment',
    "QUOTED='has a # inside'",
  ].join('\n'));
  assert.deepEqual(parsed, {
    TG_TOKEN: 'abc123',
    PUSH_REMOTE: 'ups',
    QUOTED: 'has a # inside',
  });
});

test('isVpnConnected: subnet prefix match, ignores link-local IPv6', () => {
  const interfaces = {
    utun0: [{ family: 'IPv6', address: 'fe80::1', internal: false }], // always up on macOS, not a VPN
    en0: [{ family: 'IPv4', address: '10.151.4.2', internal: false }],
  };
  assert.equal(isVpnConnected({ subnetPrefix: '10.151.' }, interfaces), true);
  assert.equal(isVpnConnected({ subnetPrefix: '10.99.' }, interfaces), false);
});

test('isVpnConnected: iface pattern is anchored and IPv4-only by default', () => {
  const interfaces = {
    utun0: [{ family: 'IPv6', address: 'fe80::1', internal: false }],
    'Ethernet Tunnel': [{ family: 'IPv4', address: '192.168.1.5', internal: false }],
  };
  // "Ethernet Tunnel" contains "tun" but the default pattern is anchored to the start
  assert.equal(isVpnConnected({ ifacePattern: '^(utun|tun|wg|ppp|tap)' }, interfaces), false);
});

test('pullIfBehind: fast-forwards on new remote commits, refuses on dirty tree', async () => {
  const { execFileSync } = await import('node:child_process');
  const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const { pullIfBehind } = await import('../src/git-deploy.js');

  const root = mkdtempSync(join(tmpdir(), 'phirelease-'));
  const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, stdio: 'pipe' }).toString().trim();
  try {
    git(root, 'init', '-q', '--bare', '-b', 'phi-dev', 'remote.git');
    git(root, 'clone', '-q', 'remote.git', 'dev');
    git(join(root, 'dev'), 'commit', '-q', '--allow-empty', '-m', 'base');
    git(join(root, 'dev'), 'push', '-q', 'origin', 'phi-dev');
    git(root, 'clone', '-q', 'remote.git', 'laptop');
    const laptop = join(root, 'laptop');

    assert.equal(await pullIfBehind({ repoDir: laptop, watchRef: 'origin/phi-dev' }), null);

    git(join(root, 'dev'), 'commit', '-q', '--allow-empty', '-m', 'Merge pull request #1');
    git(join(root, 'dev'), 'push', '-q', 'origin', 'phi-dev');
    writeFileSync(join(laptop, 'junk.txt'), 'x');
    await assert.rejects(pullIfBehind({ repoDir: laptop, watchRef: 'origin/phi-dev' }), /dirty/);

    rmSync(join(laptop, 'junk.txt'));
    assert.match(await pullIfBehind({ repoDir: laptop, watchRef: 'origin/phi-dev' }), /Merge pull request #1/);
    assert.equal(git(laptop, 'rev-parse', 'HEAD'), git(join(root, 'dev'), 'rev-parse', 'HEAD'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('sendViaDumbpipe: pipes text to `dumbpipe connect <ticket>`, false on failure', { skip: process.platform === 'win32' }, async () => {
  const { mkdtempSync, writeFileSync, readFileSync, chmodSync, rmSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const { sendViaDumbpipe } = await import('../src/notify.js');

  const dir = mkdtempSync(join(tmpdir(), 'phirelease-'));
  try {
    const fake = join(dir, 'dumbpipe');
    writeFileSync(fake, `#!/bin/sh\necho "$1 $2" > "${dir}/args"; cat > "${dir}/got"\n`);
    chmodSync(fake, 0o755);
    assert.equal(await sendViaDumbpipe(fake, 'TICKET', '⚠️ VPN down'), true);
    assert.equal(readFileSync(join(dir, 'args'), 'utf8').trim(), 'connect TICKET');
    assert.equal(readFileSync(join(dir, 'got'), 'utf8'), '⚠️ VPN down\n');
    assert.equal(await sendViaDumbpipe(join(dir, 'missing'), 'TICKET', 'x'), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('telegram-relay: forwards to Telegram, acks (clean close) only on success', async () => {
  const { createServer: httpServer } = await import('node:http');
  const { connect } = await import('node:net');
  const { spawn } = await import('node:child_process');

  let telegramOk = true;
  const received = [];
  const tg = httpServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      received.push({ url: req.url, body: JSON.parse(body) });
      res.writeHead(telegramOk ? 200 : 500).end('{}');
    });
  });
  await new Promise((r) => tg.listen(0, '127.0.0.1', r));

  const port = String(20000 + Math.floor(Math.random() * 20000));
  const relay = spawn(process.execPath, ['relay/telegram-relay.js'], {
    env: { ...process.env, TG_TOKEN: 'T', TG_CHAT_ID: '42', PORT: port, TG_API: `http://127.0.0.1:${tg.address().port}` },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  await new Promise((r) => relay.stdout.once('data', r)); // "telegram relay on ..."

  // Mimics `dumbpipe connect`: write, half-close, then see how the relay closes.
  const deliver = (text) => new Promise((resolve) => {
    const s = connect(Number(port), '127.0.0.1', () => s.end(text));
    s.on('error', () => resolve('reset'));
    s.on('close', (hadError) => resolve(hadError ? 'reset' : 'acked'));
    s.resume();
  });

  try {
    assert.equal(await deliver('⚠️ VPN down\n'), 'acked');
    assert.deepEqual(received[0], { url: '/botT/sendMessage', body: { chat_id: '42', text: '⚠️ VPN down' } });
    telegramOk = false;
    assert.equal(await deliver('second'), 'reset');
  } finally {
    relay.kill();
    tg.close();
  }
});
