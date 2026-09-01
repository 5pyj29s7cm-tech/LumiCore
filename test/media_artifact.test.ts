import { afterEach, describe, expect, it, vi } from 'vitest';
import { downloadPublicMedia } from '../server/tools/media_artifact';

describe('public media artifact downloads', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('revalidates redirect destinations before a second request', async () => {
    const fetchMock = vi.fn(async (..._request: Parameters<typeof fetch>): Promise<Response> => new Response(null, {
      status: 302,
      headers: { location: 'https://127.0.0.1/private-media' },
    }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(downloadPublicMedia('https://media.example.test/output.png', {
      maxBytes: 1024,
    })).rejects.toThrow(/public URL|private or local/i);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ redirect: 'manual' });
  });
});
