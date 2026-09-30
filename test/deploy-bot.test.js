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
