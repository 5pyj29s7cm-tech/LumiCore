import './helpers';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { initDatabase } from '../db_layer';
import { saveKeys } from '../server/config/keys';
import { upsertUserRetrievalModelPreferences } from '../server/llm/retrieval_model_preferences';
import {
  addMemory,
  getUnconsolidatedEpisodic,
  queryMemories,
  queryMemoriesVector,
} from '../server/memory/store';

function addTraceProbeMemories(
  userId: string,
  token: string,
  embedding?: number[],
) {
  const common = {
    userId,
    type: 'knowledge' as const,
    keywords: [token],
    confidence: 0.9,
    embedding,
  };

  const normal = addMemory({
    ...common,
    content: `${token} normal user knowledge about espresso preferences`,
    sourceInteractionId: `direct_${token}`,
  }, { source: 'import' });
  const sourceTaggedTrace = addMemory({
    ...common,
    content: `${token} raw executor receipt with repeated tool results`,
    sourceInteractionId: `orch_${token}`,
  }, { source: 'import' });
  const contentTaggedTrace = addMemory({
    ...common,
    content: `[Orchestrated Workflow] ${token} synthesized worker receipt`,
    sourceInteractionId: `legacy_${token}`,
  }, { source: 'import' });

  return { normal, sourceTaggedTrace, contentTaggedTrace };
}

describe('operational memory trace filtering', () => {
  beforeAll(async () => {
    await initDatabase();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    saveKeys({ SILICONFLOW_API_KEY: '' });
  });

  it('excludes legacy execution traces from keyword and consolidation recall by default', () => {
    const token = `tracekeyword${Date.now()}${Math.random().toString(36).slice(2)}`;
    const userId = `memory-${token}`;
    const { normal, sourceTaggedTrace, contentTaggedTrace } = addTraceProbeMemories(userId, token);

    const defaultResults = queryMemories({ userId, query: token, limit: 10 });
    expect(defaultResults.map(memory => memory.id)).toEqual([normal.id]);

    const explicitResults = queryMemories({
      userId,
      query: token,
      limit: 10,
      includeOperationalTraces: true,
    });
    expect(new Set(explicitResults.map(memory => memory.id))).toEqual(new Set([
      normal.id,
      sourceTaggedTrace.id,
      contentTaggedTrace.id,
    ]));

    expect(getUnconsolidatedEpisodic(userId).map(memory => memory.id)).toEqual([normal.id]);
    expect(new Set(getUnconsolidatedEpisodic(userId, undefined, undefined, true).map(memory => memory.id)))
      .toEqual(new Set([normal.id, sourceTaggedTrace.id, contentTaggedTrace.id]));
  });

  it('applies the same default and explicit behavior to vector recall', async () => {
    const token = `tracevector${Date.now()}${Math.random().toString(36).slice(2)}`;
    const userId = `memory-${token}`;
    const { normal, sourceTaggedTrace, contentTaggedTrace } = addTraceProbeMemories(
      userId,
      token,
      [1, 0, 0],
    );

    saveKeys({ SILICONFLOW_API_KEY: 'siliconflow-test-key' });
    upsertUserRetrievalModelPreferences(userId, {
      embedding: {
        provider: 'siliconflow',
        model: 'Qwen/Qwen3-Embedding-0.6B',
        fallbackProvider: '',
      },
      rerank: { enabled: false },
    });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ data: [{ embedding: [1, 0, 0] }] }),
    }));

    const defaultResults = await queryMemoriesVector({
      userId,
      query: `semantic lookup ${token}`,
      limit: 10,
      useVector: true,
    });
    expect(defaultResults.map(memory => memory.id)).toEqual([normal.id]);

    const explicitResults = await queryMemoriesVector({
      userId,
      query: `semantic lookup ${token}`,
      limit: 10,
      useVector: true,
      includeOperationalTraces: true,
    });
    expect(new Set(explicitResults.map(memory => memory.id))).toEqual(new Set([
      normal.id,
      sourceTaggedTrace.id,
      contentTaggedTrace.id,
    ]));
  });
});
