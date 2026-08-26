import { describe, expect, it, vi } from 'vitest';
import { makeApp, JWT_SECRET } from './helpers';

describe('local deterministic model failover probe', () => {
  it('forces only the synthetic primary to fail, uses a live alternate, and preserves configuration', async () => {
    const app = await makeApp();
    try {
      const jwt = await import('jsonwebtoken');
      const { mountSystemRoutes } = await import('../server/routes/system_routes');
      const {
        getUserPreferredLLM,
        upsertUserPreferredLLM,
      } = await import('../server/llm/user_preferences');
      const { listModelRoutingReceipts } = await import('../server/llm/model_routing_receipts');
      const userId = 'forced-failover-probe-user';
      upsertUserPreferredLLM(userId, {
        provider: 'deepseek',
        model: 'uncontacted-real-primary',
        selectionMode: 'ordered_fallback',
        fallbackCandidates: [{ provider: 'openai', model: 'live-test-fallback' }],
        allowCloudFallback: true,
      });
      const before = getUserPreferredLLM(userId);
      const fallbackCreate = vi.fn(async () => ({
        choices: [{ message: { role: 'assistant', content: 'OK' } }],
      }));
      mountSystemRoutes(app.apiRouter, JWT_SECRET, undefined, {
        getDeepSeek: () => null,
        getGemini: () => null,
        getOpenAI: () => ({ chat: { completions: { create: fallbackCreate } } }),
        getAnthropic: () => null,
        getQwen: () => null,
        getOllama: () => null,
        getLmStudio: () => null,
        getArk: () => null,
        getXiaomi: () => null,
        getKimi: () => null,
        getGlm: () => null,
        getRelay: () => null,
      });
      const token = jwt.default.sign({ uid: userId, username: 'admin', role: 'admin' }, JWT_SECRET);
      const response = await fetch(`${app.url}/api/llm/route/test`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ probe: 'forced_primary_failure' }),
        signal: AbortSignal.timeout(5_000),
      });
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body).toMatchObject({
        ok: true,
        verification: 'live_forced_primary_failure_failover',
        provider: 'openai',
        model: 'live-test-fallback',
        fallbackReason: 'unsupported_provider_or_model',
        attempts: [
          {
            provider: '__lumi_forced_unavailable_primary__',
            status: 'failed',
            reason: 'unsupported_provider_or_model',
          },
          { provider: 'openai', model: 'live-test-fallback', status: 'succeeded' },
        ],
      });
      expect(fallbackCreate).toHaveBeenCalledTimes(1);
      expect(getUserPreferredLLM(userId)).toEqual(before);
      expect(listModelRoutingReceipts(userId, 10)).toEqual([]);
      expect(JSON.stringify(body)).not.toMatch(/(?:api[_-]?key|bearer|token)/i);
    } finally {
      app.cleanup();
    }
  });
});
