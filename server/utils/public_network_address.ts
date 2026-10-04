import { isIP } from 'node:net';

function ipv4Number(address: string): number | null {
  const octets = address.split('.');
  if (octets.length !== 4 || octets.some(part => !/^\d{1,3}$/.test(part) || Number(part) > 255)) return null;
  return octets.reduce((value, part) => ((value << 8) | Number(part)) >>> 0, 0);
}

function ipv4InCidr(address: string, network: string, prefix: number): boolean {
  const candidate = ipv4Number(address);
  const base = ipv4Number(network);
  if (candidate === null || base === null) return false;
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return (candidate & mask) === (base & mask);
}

/** Fail-closed address classification shared by public company endpoints and remote media downloads. */
export function isPublicNetworkAddress(address: string): boolean {
  const normalized = String(address || '').trim().toLowerCase().replace(/^\[|\]$/g, '');
  const family = isIP(normalized);
  if (family === 4) {
    return ![
      ['0.0.0.0', 8],
      ['10.0.0.0', 8],
      ['100.64.0.0', 10],
      ['127.0.0.0', 8],
      ['169.254.0.0', 16],
      ['172.16.0.0', 12],
      ['192.0.0.0', 24],
      ['192.0.2.0', 24],
      ['192.168.0.0', 16],
      ['198.18.0.0', 15],
      ['198.51.100.0', 24],
      ['203.0.113.0', 24],
      ['224.0.0.0', 4],
      ['240.0.0.0', 4],
    ].some(([network, prefix]) => ipv4InCidr(normalized, String(network), Number(prefix)));
  }
  if (family !== 6) return false;
  if (normalized === '::' || normalized === '::1') return false;
  if (normalized.startsWith('::ffff:')) return false; // mapped IPv4, including hexadecimal forms
  if (/^(?:fc|fd)/.test(normalized)) return false; // unique-local
  if (/^fe[89ab]/.test(normalized)) return false; // link-local
  if (/^ff/.test(normalized)) return false; // multicast
  if (!/^[23]/.test(normalized)) return false; // only global-unicast space
  if (/^(?:2001:0*:|2002:|3fff:)/.test(normalized)) return false; // transition/documentation ranges
  if (/^2001:db8(?::|$)/.test(normalized)) return false; // documentation
  return true;
}
