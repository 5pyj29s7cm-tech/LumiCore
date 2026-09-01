import dns from 'node:dns/promises';

function isPrivateOrLocalAddress(address: string): boolean {
  const value = String(address || '').trim().toLowerCase();
  if (!value) return true;
  if (value === '::1' || value === '0.0.0.0' || value === '::' || value === 'localhost') return true;
  if (/^127(?:\.\d{1,3}){3}$/.test(value)) return true;
  if (/^10(?:\.\d{1,3}){3}$/.test(value)) return true;
  if (/^192\.168(?:\.\d{1,3}){2}$/.test(value)) return true;
  if (/^169\.254(?:\.\d{1,3}){2}$/.test(value)) return true;
  if (/^172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2}$/.test(value)) return true;
  if (/^(?:fc|fd)[0-9a-f]{2}:/i.test(value)) return true;
  if (/^fe80:/i.test(value)) return true;
  return false;
}

export async function readResponseBytes(response: Response, maxBytes: number): Promise<Buffer> {
  const declaredLength = Number(response.headers?.get?.('content-length') || 0);
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw new Error(`Remote media exceeds the ${maxBytes} byte limit.`);
  }
  const reader = response.body?.getReader?.();
  if (!reader) {
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > maxBytes) throw new Error(`Remote media exceeds the ${maxBytes} byte limit.`);
    return bytes;
  }
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
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

export async function assertPublicMediaUrl(url: string): Promise<URL> {
  const parsed = new URL(String(url || '').trim());
  const hostname = parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  const literalPrivate = hostname === 'localhost'
    || hostname.endsWith('.localhost')
    || isPrivateOrLocalAddress(hostname);
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.hash || literalPrivate) {
    throw new Error('Remote media URL must be an HTTPS public URL.');
  }
  try {
    const answers = await dns.lookup(hostname, { all: true, verbatim: true });
    if (answers.some(answer => isPrivateOrLocalAddress(answer.address))) {
      throw new Error('Remote media URL resolves to a private or local address.');
    }
  } catch (error: any) {
    if (String(error?.message || '').includes('private or local')) throw error;
  }
  return parsed;
}

export async function downloadPublicMedia(
  url: string,
  options: { maxBytes: number; timeoutMs?: number; headers?: Record<string, string> },
): Promise<{ bytes: Buffer; contentType: string }> {
  const safeHeaders = Object.fromEntries(
    Object.entries(options.headers || {}).filter(([name]) => !/^(authorization|cookie|proxy-authorization|set-cookie)$/i.test(name)),
  );
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs || 90_000);
  try {
    let current = await assertPublicMediaUrl(url);
    for (let redirects = 0; redirects <= 3; redirects += 1) {
      const response = await fetch(current.toString(), {
        headers: safeHeaders,
        signal: controller.signal,
        redirect: 'manual',
      });
      if (response.status >= 300 && response.status < 400) {
        const location = String(response.headers?.get?.('location') || '').trim();
        if (!location) throw new Error('Remote media redirect did not include a destination.');
        if (redirects >= 3) throw new Error('Remote media exceeded the redirect limit.');
        current = await assertPublicMediaUrl(new URL(location, current).toString());
        continue;
      }
      if (!response.ok) throw new Error(`Remote media download failed: HTTP ${response.status}`);
      return {
        bytes: await readResponseBytes(response, options.maxBytes),
        contentType: String(response.headers?.get?.('content-type') || '').toLowerCase(),
      };
    }
    throw new Error('Remote media exceeded the redirect limit.');
  } finally {
    clearTimeout(timer);
  }
}
