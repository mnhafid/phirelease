// Run once with the VPN connected, once without, and compare — the address
// that only shows up connected is your VPN's. Cross-platform (os.networkInterfaces),
// so this replaces reaching for ifconfig on macOS vs ipconfig on Windows.
import { networkInterfaces } from 'node:os';

const ifaces = networkInterfaces();
console.log('interface'.padEnd(20), 'family'.padEnd(6), 'address'.padEnd(40), 'internal');
for (const [name, addrs] of Object.entries(ifaces)) {
  for (const a of addrs ?? []) {
    console.log(name.padEnd(20), a.family.padEnd(6), a.address.padEnd(40), a.internal);
  }
}

console.log('\nPick the address that only appears while the VPN is connected, then set:');
console.log('  VPN_SUBNET_PREFIX=<its first two or three octets, with a trailing dot>');

try {
  const { config } = await import('../src/config.js');
  const { isVpnConnected } = await import('../src/net-check.js');
  const ok = isVpnConnected({ subnetPrefix: config.vpnSubnetPrefix, ifacePattern: config.vpnIfacePattern });
  console.log(`\nWith current .env settings, isVpnConnected() = ${ok}`);
} catch {
  console.log('\n(.env not set up yet — showing raw interfaces only)');
}
