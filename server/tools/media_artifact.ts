import dns from 'node:dns/promises';
import { isIP } from 'node:net';
import { Agent as UndiciAgent } from 'undici';

function throwIfMediaDownloadAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  if (signal.reason instanceof Error) throw signal.reason;
  throw new DOMException('Remote media download cancelled', 'AbortError');
}

function waitForMediaOperation<T>(operation: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return operation;
  throwIfMediaDownloadAborted(signal);
  return new Promise<T>((resolve, reject) => {
    const abort = () => {
      try { throwIfMediaDownloadAborted(signal); } catch (error) { reject(error); }
    };
    signal.addEventListener('abort', abort, { once: true });
    operation.then(
      value => {
        signal.removeEventListener('abort', abort);
        resolve(value);
      },
      error => {
        signal.removeEventListener('abort', abort);
        reject(error);
      },
    );
  });
}

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

function isPublicMediaAddress(address: string): boolean {
  const normalized = String(address || '').trim().toLowerCase().replace(/^\[|\]$/g, '').split('%', 1)[0];
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
  if (normalized.startsWith('::ffff:')) return false;
  if (/^(?:fc|fd)/.test(normalized)) return false;
  if (/^fe[89ab]/.test(normalized)) return false;
  if (/^ff/.test(normalized)) return false;
  if (!/^[23]/.test(normalized)) return false;
  if (/^(?:2001:0*:|2002:|3fff:)/.test(normalized)) return false;
  if (/^2001:db8(?::|$)/.test(normalized)) return false;
  return true;
}

interface PublicMediaAddress {
  address: string;
  family: number;
}

async function resolvePublicMediaAddresses(hostname: string, signal?: AbortSignal): Promise<PublicMediaAddress[]> {
  const normalized = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  const literalFamily = isIP(normalized);
  let addresses: PublicMediaAddress[];
  try {
    addresses = literalFamily
      ? [{ address: normalized, family: literalFamily }]
      : await waitForMediaOperation(dns.lookup(normalized, { all: true, verbatim: true }), signal);
  } catch (error) {
    throwIfMediaDownloadAborted(signal);
    throw new Error('Remote media hostname could not be resolved.', { cause: error });
  }
  if (addresses.length === 0 || addresses.some(item => !isPublicMediaAddress(item.address))) {
    throw new Error('Remote media URL resolves to a private, local, or reserved address.');
  }
  return addresses;
}

function createPublicMediaDispatcher(): UndiciAgent {
  return new UndiciAgent({
    connect: {
      lookup: ((hostname: string, options: any, callback: (...args: any[]) => void) => {
        resolvePublicMediaAddresses(hostname)
          .then(addresses => {
            const requestedFamily = typeof options === 'number' ? options : Number(options?.family || 0);
            const matching = requestedFamily
              ? addresses.filter(item => item.family === requestedFamily)
              : addresses;
            if (matching.length === 0) {
              callback(new Error(`Remote media destination has no allowed IPv${requestedFamily || ''} address.`));
              return;
            }
            if (options?.all === true) callback(null, matching);
            else callback(null, matching[0].address, matching[0].family);
          })
          .catch(error => callback(error));
      }) as any,
    },
  });
}

export async function readResponseBytes(response: Response, maxBytes: number, signal?: AbortSignal): Promise<Buffer> {
  throwIfMediaDownloadAborted(signal);
  const declaredLength = Number(response.headers?.get?.('content-length') || 0);
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw new Error(`Remote media exceeds the ${maxBytes} byte limit.`);
  }
  const reader = response.body?.getReader?.();
  if (!reader) {
    const bytes = Buffer.from(await response.arrayBuffer());
    throwIfMediaDownloadAborted(signal);
    if (bytes.length > maxBytes) throw new Error(`Remote media exceeds the ${maxBytes} byte limit.`);
    return bytes;
  }
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    while (true) {
      throwIfMediaDownloadAborted(signal);
      const next = await reader.read();
      throwIfMediaDownloadAborted(signal);
      if (next.done) break;
      const chunk = Buffer.from(next.value);
      total += chunk.length;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new Error(`Remote media exceeds the ${maxBytes} byte limit.`);
      }
      chunks.push(chunk);
    }
  } finally {
    reader.releaseLock?.();
  }
  return Buffer.concat(chunks, total);
}

export async function assertPublicMediaUrl(url: string, signal?: AbortSignal): Promise<URL> {
  throwIfMediaDownloadAborted(signal);
  const parsed = new URL(String(url || '').trim());
  const hostname = parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  const localHostname = hostname === 'localhost'
    || hostname.endsWith('.localhost')
    || hostname.endsWith('.local')
    || hostname.endsWith('.internal')
    || hostname.endsWith('.lan');
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.hash || localHostname) {
    throw new Error('Remote media URL must be an HTTPS public URL.');
  }
  await resolvePublicMediaAddresses(hostname, signal);
  throwIfMediaDownloadAborted(signal);
  return parsed;
}

export async function downloadPublicMedia(
  url: string,
  options: { maxBytes: number; timeoutMs?: number; headers?: Record<string, string>; signal?: AbortSignal },
): Promise<{ bytes: Buffer; contentType: string }> {
  const safeHeaders = Object.fromEntries(
    Object.entries(options.headers || {}).filter(([name]) => !/^(authorization|cookie|proxy-authorization|set-cookie)$/i.test(name)),
  );
  const controller = new AbortController();
  const abort = () => controller.abort(options.signal?.reason);
  if (options.signal?.aborted) abort();
  else options.signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(() => controller.abort(new Error('Remote media download timed out')), options.timeoutMs || 90_000);
  const dispatcher = createPublicMediaDispatcher();
  try {
    throwIfMediaDownloadAborted(controller.signal);
    let current = await assertPublicMediaUrl(url, controller.signal);
    throwIfMediaDownloadAborted(controller.signal);
    for (let redirects = 0; redirects <= 3; redirects += 1) {
      const response = await fetch(current.toString(), {
        headers: safeHeaders,
        signal: controller.signal,
        redirect: 'manual',
        dispatcher,
      } as RequestInit);
      if (response.status >= 300 && response.status < 400) {
        const location = String(response.headers?.get?.('location') || '').trim();
        if (!location) throw new Error('Remote media redirect did not include a destination.');
        if (redirects >= 3) throw new Error('Remote media exceeded the redirect limit.');
        current = await assertPublicMediaUrl(new URL(location, current).toString(), controller.signal);
        continue;
      }
      if (!response.ok) throw new Error(`Remote media download failed: HTTP ${response.status}`);
      return {
        bytes: await readResponseBytes(response, options.maxBytes, controller.signal),
        contentType: String(response.headers?.get?.('content-type') || '').toLowerCase(),
      };
    }
    throw new Error('Remote media exceeded the redirect limit.');
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', abort);
    await dispatcher.close().catch(() => undefined);
  }
}
