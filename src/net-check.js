import { networkInterfaces } from 'node:os';

// Two detection modes:
//  - VPN_SUBNET_PREFIX (preferred): match the VPN's own IPv4 prefix, e.g.
//    "10.151." — the one signal that means the same thing on macOS and
//    Windows regardless of adapter naming.
//  - VPN_IFACE_PATTERN (fallback): match interface names. macOS always has
//    utun0-utun3 up for iCloud/Continuity with fe80:: link-local addresses
//    only, so this only counts IPv4 (or non-link-local IPv6) addresses, and
//    the pattern is anchored (^...) so "tun" doesn't match "Ethernet Tunnel".
export function isVpnConnected({ subnetPrefix, ifacePattern }, interfaces = networkInterfaces()) {
  const addrs = Object.entries(interfaces).flatMap(([name, list]) =>
    (list ?? []).map((a) => ({ name, ...a }))
  );

  if (subnetPrefix) {
    return addrs.some((a) => a.family === 'IPv4' && !a.internal && a.address.startsWith(subnetPrefix));
  }

  const re = new RegExp(ifacePattern, 'i');
  return addrs.some((a) => {
    if (a.internal || !re.test(a.name)) return false;
    if (a.family === 'IPv4') return true;
    return a.family === 'IPv6' && !a.address.startsWith('fe80');
  });
}

// A HEAD request to a real endpoint, not just a DNS lookup — confirms the
// laptop can actually reach the internet, not just resolve a name.
export async function isInternetConnected(url, timeoutMs = 5000) {
  try {
    await fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(timeoutMs) });
    return true;
  } catch {
    return false;
  }
}
