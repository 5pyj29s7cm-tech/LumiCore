import { getKey } from "../../config/keys";
import type { LumiExtensionManifest } from './contracts';
import { assertResolvedDestinationAllowed, extensionNetworkFetch } from './runtime_state';

export function authHeaders(manifest: LumiExtensionManifest, channel: 'tool' | 'provider' = 'tool'): Record<string, string> {
  const auth = channel === 'provider' ? manifest.provider?.auth : manifest.auth;
  if (!auth || auth.type === 'none') return {};
  const credential = credentialValue(auth.credentialRef!);
  if (!credential) throw new Error(`Required credentialRef ${auth.credentialRef} is not configured.`);
  return { Authorization: `Bearer ${credential}` };
}

export function credentialValue(name: string): string | undefined {
  return process.env[name] || getKey(name);
}

function abortReason(signal: AbortSignal, fallback: string): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error(fallback);
}

async function waitForAbortable<T>(
  operation: Promise<T>,
  signal: AbortSignal,
  fallback: string,
): Promise<T> {
  if (signal.aborted) throw abortReason(signal, fallback);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortReason(signal, fallback));
    signal.addEventListener('abort', onAbort, { once: true });
    operation.then(
      value => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      error => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

async function readBoundedResponseText(
  response: Response,
  maxBytes: number,
  signal: AbortSignal,
  abort: (reason: Error) => void,
): Promise<string> {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const chunk = await waitForAbortable(
        reader.read(),
        signal,
        'Extension response read was aborted.',
      );
      if (chunk.done) break;
      totalBytes += chunk.value.byteLength;
      if (totalBytes > maxBytes) {
        const error = new Error('Extension response exceeded its declared response-byte budget.');
        abort(error);
        void reader.cancel(error).catch(() => undefined);
        throw error;
      }
      chunks.push(chunk.value);
    }
    return Buffer.concat(chunks.map(chunk => Buffer.from(chunk)), totalBytes).toString('utf8');
  } catch (error) {
    void reader.cancel(error).catch(() => undefined);
    throw error;
  } finally {
    try { reader.releaseLock(); } catch {}
  }
}

export async function boundedFetch(
  manifest: LumiExtensionManifest,
  url: URL,
  init: RequestInit,
): Promise<{ response: Response; text: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(
    new Error('Extension request exceeded its total timeout.'),
  ), manifest.permissions.timeoutMs!);
  const signal = init.signal
    ? AbortSignal.any([init.signal, controller.signal])
    : controller.signal;
  let closeNetwork = async () => undefined;
  try {
    await waitForAbortable(
      assertResolvedDestinationAllowed(url, manifest),
      signal,
      'Extension destination resolution was aborted.',
    );
    const bodyBytes = typeof init.body === 'string' ? Buffer.byteLength(init.body, 'utf8') : 0;
    if (bodyBytes > manifest.permissions.maxRequestBytes!) throw new Error('Extension request exceeds its declared request-byte budget.');
    const pendingNetwork = extensionNetworkFetch(manifest, url, { ...init, signal, redirect: 'error' });
    let secured: Awaited<ReturnType<typeof extensionNetworkFetch>>;
    try {
      secured = await waitForAbortable(
        pendingNetwork,
        signal,
        'Extension connection was aborted.',
      );
    } catch (error) {
      void pendingNetwork.then(result => result.close()).catch(() => undefined);
      throw error;
    }
    closeNetwork = secured.close;
    const response = secured.response;
    const contentLength = Number(response.headers.get('content-length') || 0);
    if (contentLength > manifest.permissions.maxResponseBytes!) throw new Error('Extension response exceeds its declared response-byte budget.');
    const text = await readBoundedResponseText(
      response,
      manifest.permissions.maxResponseBytes!,
      signal,
      reason => controller.abort(reason),
    );
    return { response, text };
  } finally {
    const pendingClose = closeNetwork().catch(() => undefined);
    if (signal.aborted) void pendingClose;
    else await waitForAbortable(pendingClose, signal, 'Extension connection cleanup was aborted.')
      .catch(() => undefined);
    clearTimeout(timer);
  }
}

export function parseJsonObject(text: string, label: string): Record<string, any> {
  let parsed: unknown;
  try { parsed = JSON.parse(text || '{}'); } catch { throw new Error(`${label} returned invalid JSON.`); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(`${label} must return a JSON object.`);
  return parsed as Record<string, any>;
}
