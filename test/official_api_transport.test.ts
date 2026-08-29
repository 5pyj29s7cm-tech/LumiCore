import { afterEach, describe, expect, it } from 'vitest';
import {
  officialApiBinary,
  officialApiPath,
  officialApiRequest,
  officialApiUrl,
} from '../server/llm/official_api';

const originalRelayKey = process.env.RELAY_API_KEY;
const originalRelayBase = process.env.RELAY_BASE_URL;
const originalRerankPath = process.env.RELAY_RERANK_PATH;

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

afterEach(() => {
  if (originalRelayKey === undefined) delete process.env.RELAY_API_KEY;
  else process.env.RELAY_API_KEY = originalRelayKey;
  if (originalRelayBase === undefined) delete process.env.RELAY_BASE_URL;
  else process.env.RELAY_BASE_URL = originalRelayBase;
  if (originalRerankPath === undefined) delete process.env.RELAY_RERANK_PATH;
  else process.env.RELAY_RERANK_PATH = originalRerankPath;
});

describe('official API transport', () => {
  it('normalizes a host-only relay URL to the conventional /v1 root', () => {
    process.env.RELAY_API_KEY = 'test-relay-key';
    process.env.RELAY_BASE_URL = 'https://relay.example.test';
    expect(officialApiUrl('/rerank')).toBe('https://relay.example.test/v1/rerank');
  });

  it('does not duplicate /v1 when the relay base already includes it', () => {
    process.env.RELAY_API_KEY = 'test-relay-key';
    process.env.RELAY_BASE_URL = 'https://relay.example.test/v1';
    expect(officialApiUrl('/rerank')).toBe('https://relay.example.test/v1/rerank');
  });

  it('preserves a rooted /api/v1 rerank override against a /v1 base', async () => {
    process.env.RELAY_API_KEY = 'test-relay-key';
    process.env.RELAY_BASE_URL = 'https://relay.example.test/v1';
    process.env.RELAY_RERANK_PATH = '/api/v1/rerank';
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const result = await officialApiRequest(officialApiPath('RELAY_RERANK_PATH', '/rerank'), {
      method: 'POST',
      body: JSON.stringify({ query: 'q', documents: ['d'] }),
      fetchImpl: async (url, init) => {
        calls.push({ url: String(url), init });
        return jsonResponse({ results: [] });
      },
    });
    expect(result.body).toEqual({ results: [] });
    expect(calls[0].url).toBe('https://relay.example.test/api/v1/rerank');
    expect((calls[0].init?.headers as Record<string, string>).Authorization).toBe('Bearer test-relay-key');
  });

  it('does not forward relay credentials to an absolute media URL', async () => {
    process.env.RELAY_API_KEY = 'test-relay-key';
    process.env.RELAY_BASE_URL = 'https://relay.example.test/v1';
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const response = await officialApiBinary('https://cdn.example.test/video.mp4', {
      fetchImpl: async (url, init) => {
        calls.push({ url: String(url), init });
        return new Response(new Uint8Array([0, 1, 2]), { status: 200, headers: { 'content-type': 'video/mp4' } });
      },
    });
    expect(response.status).toBe(200);
    expect(calls[0].url).toBe('https://cdn.example.test/video.mp4');
    const headers = calls[0].init?.headers as Record<string, string>;
    expect(headers?.Authorization).toBeUndefined();
  });
});
