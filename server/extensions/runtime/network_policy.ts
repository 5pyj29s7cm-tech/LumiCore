import net from "node:net";
import type { LumiExtensionManifest } from './contracts';

export function isLoopbackHost(hostname: string): boolean {
  const lower = hostname.toLowerCase();
  if (lower === 'localhost' || lower.endsWith('.localhost')) return true;
  const family = net.isIP(lower);
  if (family === 4) return lower.startsWith('127.');
  if (family === 6) return lower === '::1' || lower === '0:0:0:0:0:0:0:1';
  return false;
}

export function isPrivateAddress(address: string): boolean {
  const normalized = String(address || '').trim().toLowerCase().split('%', 1)[0];
  let ipv4 = net.isIPv4(normalized) ? normalized : '';
  if (!ipv4 && normalized.startsWith('::ffff:')) {
    const mapped = normalized.slice('::ffff:'.length);
    if (net.isIPv4(mapped)) {
      ipv4 = mapped;
    } else if (/^[0-9a-f]{1,4}:[0-9a-f]{1,4}$/i.test(mapped)) {
      const [high, low] = mapped.split(':').map(part => Number.parseInt(part, 16));
      ipv4 = `${high >>> 8}.${high & 0xff}.${low >>> 8}.${low & 0xff}`;
    }
  }
  if (ipv4) {
    const octets = ipv4.split('.').map(Number);
    return octets[0] === 0
      || octets[0] === 10
      || (octets[0] === 100 && octets[1] >= 64 && octets[1] <= 127)
      || octets[0] === 127
      || (octets[0] === 169 && octets[1] === 254)
      || (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31)
      || (octets[0] === 192 && octets[1] === 0 && octets[2] === 0)
      || (octets[0] === 192 && octets[1] === 0 && octets[2] === 2)
      || (octets[0] === 192 && octets[1] === 168)
      || (octets[0] === 198 && octets[1] >= 18 && octets[1] <= 19)
      || (octets[0] === 198 && octets[1] === 51 && octets[2] === 100)
      || (octets[0] === 203 && octets[1] === 0 && octets[2] === 113)
      || octets[0] >= 224;
  }
  if (net.isIPv6(normalized)) {
    return normalized === '::'
      || normalized === '::1'
      || normalized.startsWith('fc')
      || normalized.startsWith('fd')
      || /^fe[89ab][0-9a-f]:/i.test(normalized)
      || normalized.startsWith('ff')
      || normalized.startsWith('2001:db8:');
  }
  return true;
}

export function normalizeOrigin(value: unknown): string {
  const raw = String(value || '').trim();
  let url: URL;
  try { url = new URL(raw); } catch { throw new Error(`Invalid extension network origin: ${raw}`); }
  if (url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error(`Extension network origin must contain only scheme, host, and optional port: ${raw}`);
  }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error(`Unsupported extension network protocol: ${url.protocol}`);
  if (url.protocol !== 'https:' && !isLoopbackHost(url.hostname)) {
    throw new Error('Non-local extension network origins must use HTTPS.');
  }
  return url.origin;
}

export function normalizeBaseUrl(value: unknown): URL {
  const raw = String(value || '').trim();
  let url: URL;
  try { url = new URL(raw); } catch { throw new Error('Provider baseUrl must be a valid absolute URL.'); }
  if (url.username || url.password || url.search || url.hash) throw new Error('Provider baseUrl cannot contain credentials, query parameters, or fragments.');
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Provider baseUrl must use HTTP or HTTPS.');
  if (url.protocol !== 'https:' && !isLoopbackHost(url.hostname)) throw new Error('Non-local providers must use HTTPS.');
  url.pathname = url.pathname.replace(/\/+$/, '');
  return url;
}

export function normalizeEndpointPath(value: unknown, field: string): string {
  const raw = String(value || '').trim();
  if (!raw.startsWith('/') || raw.startsWith('//') || raw.includes('..') || raw.includes('?') || raw.includes('#') || raw.length > 300) {
    throw new Error(`${field} must be a fixed absolute path without traversal, query, or fragment.`);
  }
  return raw;
}

function sourceBaseUrl(manifest: LumiExtensionManifest): URL {
  if (manifest.provider) return new URL(manifest.provider.baseUrl);
  return new URL(manifest.permissions.networkOrigins[0]);
}

export function endpointUrl(manifest: LumiExtensionManifest, endpointPath: string): URL {
  const base = sourceBaseUrl(manifest);
  const basePath = base.pathname.replace(/\/$/, '');
  const url = new URL(base.origin);
  url.pathname = `${basePath}${endpointPath}`.replace(/\/{2,}/g, '/');
  if (!manifest.permissions.networkOrigins.includes(url.origin)) throw new Error('Extension endpoint escaped its declared network origin.');
  return url;
}
