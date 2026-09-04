import { afterEach, describe, expect, it, vi } from 'vitest';
import dns from 'node:dns/promises';
import { downloadPublicMedia } from '../server/tools/media_artifact';

function allowPublicTestDns(): void {
  vi.spyOn(dns, 'lookup').mockImplementation(async () => ([{ address: '8.8.8.8', family: 4 }] as any));
}

describe('public media artifact downloads', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('revalidates redirect destinations before a second request', async () => {
    allowPublicTestDns();
    const fetchMock = vi.fn(async (..._request: Parameters<typeof fetch>): Promise<Response> => new Response(null, {
      status: 302,
      headers: { location: 'https://127.0.0.1/private-media' },
    }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(downloadPublicMedia('https://media.example.test/output.png', {
      maxBytes: 1024,
    })).rejects.toThrow(/public URL|private|local|reserved/i);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ redirect: 'manual' });
  });

  it('propagates caller cancellation to an active remote download', async () => {
    allowPublicTestDns();
    const caller = new AbortController();
    let requestSignal: AbortSignal | undefined;
    const fetchMock = vi.fn(async (...request: Parameters<typeof fetch>): Promise<Response> => {
      requestSignal = request[1]?.signal || undefined;
      return new Promise<Response>((_resolve, reject) => {
        const rejectOnAbort = () => reject(requestSignal?.reason || new DOMException('cancelled', 'AbortError'));
        if (requestSignal?.aborted) rejectOnAbort();
        else requestSignal?.addEventListener('abort', rejectOnAbort, { once: true });
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    const pending = downloadPublicMedia('https://media.example.test/output.png', {
      maxBytes: 1024,
      signal: caller.signal,
    });
    const outcome = pending.then(
      () => null,
      error => error as Error,
    );
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    caller.abort(new DOMException('test media cancellation', 'AbortError'));

    const error = await outcome;
    expect(error).toBeInstanceOf(Error);
    expect(error?.message).toMatch(/test media cancellation/i);
    expect(requestSignal?.aborted).toBe(true);
  });

  it('rejects IPv4-mapped IPv6 loopback URLs before fetch', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(downloadPublicMedia('https://[::ffff:127.0.0.1]/private-media', {
      maxBytes: 1024,
    })).rejects.toThrow(/private|local|reserved|public/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('fails closed when a remote media hostname cannot be resolved', async () => {
    vi.spyOn(dns, 'lookup').mockRejectedValue(new Error('test DNS failure'));
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(downloadPublicMedia('https://unresolved.example.test/output.png', {
      maxBytes: 1024,
    })).rejects.toThrow(/could not be resolved/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
