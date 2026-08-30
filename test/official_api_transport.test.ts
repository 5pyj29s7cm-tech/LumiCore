import { afterEach, describe, expect, it } from 'vitest';
import {
  officialApiBinary,
  officialApiWebSocketUrl,
  officialApiPath,
  officialApiRequest,
  officialApiUrl,
  listOfficialApiModels,
} from '../server/llm/official_api';

const originalRelayKey = process.env.RELAY_API_KEY;
const originalRelayBase = process.env.RELAY_BASE_URL;
const originalRerankPath = process.env.RELAY_RERANK_PATH;
const originalEmbeddingsPath = process.env.RELAY_EMBEDDINGS_PATH;
const originalLegacyEmbeddingPath = process.env.RELAY_EMBEDDING_PATH;

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
  if (originalEmbeddingsPath === undefined) delete process.env.RELAY_EMBEDDINGS_PATH;
  else process.env.RELAY_EMBEDDINGS_PATH = originalEmbeddingsPath;
  if (originalLegacyEmbeddingPath === undefined) delete process.env.RELAY_EMBEDDING_PATH;
  else process.env.RELAY_EMBEDDING_PATH = originalLegacyEmbeddingPath;
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

  it('builds the documented official WebSocket route with a provider-qualified model', () => {
    process.env.RELAY_API_KEY = 'test-relay-key';
    process.env.RELAY_BASE_URL = 'https://relay.example.test/v1';
    expect(officialApiWebSocketUrl('/audio/transcriptions/stream', 'aliyun/qwen-audio-3.0-asr-flash-streaming'))
      .toBe('wss://relay.example.test/v1/audio/transcriptions/stream?model=aliyun%2Fqwen-audio-3.0-asr-flash-streaming');
  });

  it('normalizes the live catalog into role-scoped model options', async () => {
    process.env.RELAY_API_KEY = 'test-relay-key';
    process.env.RELAY_BASE_URL = 'https://relay.example.test/v1';
    const catalog = await listOfficialApiModels({
      fetchImpl: async () => jsonResponse({
        object: 'list',
        data: [
          { id: 'aliyun/qwen-plus', capability: 'chat', endpoint: '/chat/completions', owned_by: 'Qwen' },
          { id: 'aliyun/qwen3-vl-plus', capability: 'multimodal_chat', endpoint: '/chat/completions' },
          { id: 'aliyun/qwen-audio-3.0-asr-flash-streaming', capability: 'speech_recognition', endpoint: '/api-ws/v1/inference' },
          { id: 'invalid-unqualified-model', capability: 'chat' },
        ],
      }),
    });
    expect(catalog.models.map(model => model.id)).toEqual([
      'aliyun/qwen-audio-3.0-asr-flash-streaming',
      'aliyun/qwen-plus',
      'aliyun/qwen3-vl-plus',
    ]);
    expect(catalog.byRole.reasoning).toEqual(['aliyun/qwen-plus']);
    expect(catalog.byRole.vision).toEqual(['aliyun/qwen3-vl-plus']);
    expect(catalog.byRole.world).toEqual(['aliyun/qwen3-vl-plus']);
    expect(catalog.byRole.speech_recognition).toEqual(['aliyun/qwen-audio-3.0-asr-flash-streaming']);
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

  it('prefers the canonical embeddings path while accepting the legacy singular name', () => {
    delete process.env.RELAY_EMBEDDINGS_PATH;
    process.env.RELAY_EMBEDDING_PATH = '/legacy-embeddings';
    expect(officialApiPath(
      ['RELAY_EMBEDDINGS_PATH', 'RELAY_EMBEDDING_PATH'],
      '/embeddings',
    )).toBe('/legacy-embeddings');

    process.env.RELAY_EMBEDDINGS_PATH = '/embeddings';
    expect(officialApiPath(
      ['RELAY_EMBEDDINGS_PATH', 'RELAY_EMBEDDING_PATH'],
      '/fallback',
    )).toBe('/embeddings');
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
