import './helpers';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createLLMRuntime } from '../server/runtime/llm';
import { normalizeOfficialOpenAIErrorResponse } from '../server/llm/official_api';
import { withCloudResilience } from '../server/cloud/resilience';
import { classifyCloudError } from '../server/cloud/core';
import { isCircuitClosed, resetCircuit } from '../server/cloud/circuit_breaker';
import { modelRoutingErrorReason } from '../server/llm/model_routing_receipts';

const freeQuotaDetail = 'Free quota exhausted. To continue accessing the model on a paid basis, please add funds or disable the "use free tier only" mode in the management console.';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  resetCircuit();
});

describe('official SDK error detail boundary', () => {
  it('preserves the actual 403 free-tier detail through the real SDK and records quota without retrying', async () => {
    vi.stubEnv('RELAY_API_KEY', 'isolated-official-key');
    vi.stubEnv('RELAY_BASE_URL', 'https://official-gateway.invalid/v1');
    const fakeFetch = vi.fn(async () => new Response(JSON.stringify({ detail: freeQuotaDetail }), {
      status: 403, headers: { 'content-type': 'application/json', 'x-request-id': 'isolated-request' },
    }));
    vi.stubGlobal('fetch', fakeFetch);
    const client = createLLMRuntime().getRelay()!;
    let failure: any;
    try {
      await withCloudResilience(() => client.chat.completions.create({
        model: 'aliyun/deepseek-v4-flash', messages: [{ role: 'user', content: 'synthetic' }], max_tokens: 512,
      }), { provider: 'relay', model: 'aliyun/deepseek-v4-flash', maxRetries: 3 });
    } catch (error) { failure = error; }
    expect(failure).toMatchObject({ status: 403, cloudCategory: 'quota', requestID: 'isolated-request' });
    expect(failure.message).toContain('Free quota exhausted');
    expect(failure.message).not.toContain('isolated-official-key');
    expect(modelRoutingErrorReason(failure)).toBe('quota_or_billing');
    expect(classifyCloudError(failure)).toMatchObject({ category: 'quota', isRetryable: false });
    expect(fakeFetch).toHaveBeenCalledTimes(1);
    expect(isCircuitClosed('relay', 'aliyun/deepseek-v4-flash')).toBe(false);
  });

  it('retains real authorization failure classification and removes an echoed credential', async () => {
    const key = 'credential-that-must-never-appear';
    const response = await normalizeOfficialOpenAIErrorResponse(new Response(JSON.stringify({
      detail: `Invalid API key: ${key}`,
    }), { status: 403, headers: { 'content-type': 'application/json' } }), key);
    const body = await response.json();
    expect(body.error.message).toContain('[redacted]');
    expect(JSON.stringify(body)).not.toContain(key);
    expect(classifyCloudError(Object.assign(new Error(body.error.message), { status: response.status })))
      .toMatchObject({ category: 'auth', isRetryable: false });
  });

  it('does not consume successful streams, rewrite standard errors or mislabel invalid JSON', async () => {
    for (const response of [
      new Response('data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } }),
      new Response(JSON.stringify({ error: { message: 'standard error' } }), { status: 400, headers: { 'content-type': 'application/json' } }),
      new Response('invalid json', { status: 403, headers: { 'content-type': 'application/json' } }),
    ]) {
      expect(await normalizeOfficialOpenAIErrorResponse(response, 'key')).toBe(response);
      expect(response.bodyUsed).toBe(false);
    }
  });
});
