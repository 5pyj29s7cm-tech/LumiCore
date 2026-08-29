import './helpers';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { resetCircuit } from '../server/cloud/circuit_breaker';

vi.mock('../server/llm/local_models', async importOriginal => {
  const actual = await importOriginal<typeof import('../server/llm/local_models')>();
  return {
    ...actual,
    ensureLocalModelReady: vi.fn(async (_provider: string, model: string) => model),
    runLocalModelInference: vi.fn(async (
      _provider: string,
      execute: () => Promise<unknown>,
    ) => execute()),
  };
});

describe('autonomous task generator model routing', () => {
  beforeAll(async () => {
    const { initDatabase } = await import('../db_layer');
    await initDatabase();
  });

  afterEach(() => {
    resetCircuit();
    vi.clearAllMocks();
  });

  it('preserves the full getter chain and records ordered fallback to LM Studio', async () => {
    const userId = `autonomous-routing-${Date.now()}`;
    const { saveGateConfig } = await import('../server/autonomy/safety_gate');
    const { ensureLearningWorkflow } = await import('../server/autonomy/workflows');
    const { generateAutonomousTasks } = await import('../server/autonomy/task_generator');
    const { upsertUserPreferredLLM } = await import('../server/llm/user_preferences');
    const { listModelRoutingReceipts } = await import('../server/llm/model_routing_receipts');

    saveGateConfig({ autonomyLevel: 'full', alwaysOnline: true }, userId);
    ensureLearningWorkflow(userId);
    upsertUserPreferredLLM(userId, {
      provider: 'deepseek',
      model: 'deepseek-v4-flash',
      selectionMode: 'ordered_fallback',
      fallbackCandidates: [{ provider: 'lmstudio', model: 'qwen2.5-7b-instruct' }],
      allowCloudFallback: true,
    });

    const deepSeekCreate = vi.fn(async () => {
      throw new Error('402 Payment Required: insufficient balance');
    });
    const lmStudioCreate = vi.fn(async () => ({
      choices: [{ message: { role: 'assistant', content: '[]' } }],
    }));
    await generateAutonomousTasks(userId, {
      getDeepSeek: () => ({ chat: { completions: { create: deepSeekCreate } } }),
      getGemini: () => null,
      getOpenAI: () => null,
      getAnthropic: () => null,
      getQwen: () => null,
      getOllama: () => null,
      getLmStudio: () => ({ chat: { completions: { create: lmStudioCreate } } }),
      getArk: () => null,
      getXiaomi: () => null,
      getKimi: () => null,
      getGlm: () => null,
      getRelay: () => null,
    });

    expect(deepSeekCreate).toHaveBeenCalled();
    expect(lmStudioCreate).toHaveBeenCalledTimes(1);
    const receipt = listModelRoutingReceipts(userId, 10)[0];
    expect(receipt).toMatchObject({
      status: 'succeeded',
      source: 'autonomous_task_generation',
      domain: 'personal',
      selectedProvider: 'lmstudio',
      selectedModel: 'qwen2.5-7b-instruct',
      fallbackReason: 'quota_or_billing',
      attempts: [
        expect.objectContaining({ provider: 'deepseek', status: 'failed', reason: 'quota_or_billing' }),
        expect.objectContaining({ provider: 'lmstudio', status: 'succeeded' }),
      ],
    });
    expect(receipt.requestId).toMatch(/^autonomous_task_generation_[0-9a-f-]{36}$/i);
    expect(receipt.interactionId).toBe(receipt.requestId);
  });

  it('does not place Memory Avatar seed text in Lumi task-generation context', async () => {
    const userId = `autonomous-avatar-isolation-${Date.now()}`;
    const { readDB, writeDB } = await import('../db_layer');
    const { saveGateConfig } = await import('../server/autonomy/safety_gate');
    const { ensureLearningWorkflow } = await import('../server/autonomy/workflows');
    const { generateAutonomousTasks } = await import('../server/autonomy/task_generator');

    saveGateConfig({ autonomyLevel: 'full', alwaysOnline: true }, userId);
    ensureLearningWorkflow(userId);
    const db = readDB();
    db.memories = [
      ...(db.memories || []),
      {
        id: `lumi-context-${userId}`,
        userId,
        type: 'fact',
        content: 'LUMI_VISIBLE_CONTEXT_MEMORY',
        keywords: [],
        confidence: 0.9,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        agentId: '',
      },
      {
        id: `avatar-context-${userId}`,
        userId,
        type: 'fact',
        content: 'SECRET_AVATAR_CONTEXT_MUST_NOT_REACH_TASK_GENERATOR',
        keywords: [],
        confidence: 0.99,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        agentId: 'memory_avatar_task_isolation',
      },
    ];
    writeDB(db);

    const create = vi.fn(async () => ({
      choices: [{ message: { role: 'assistant', content: '[]' } }],
    }));
    await generateAutonomousTasks(userId, {
      getDeepSeek: () => ({ chat: { completions: { create } } }),
      getGemini: () => null,
      getOpenAI: () => null,
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

    expect(create).toHaveBeenCalled();
    const prompt = JSON.stringify((create.mock.calls as any[])[0]?.[0] || '');
    expect(prompt).toContain('LUMI_VISIBLE_CONTEXT_MEMORY');
    expect(prompt).not.toContain('SECRET_AVATAR_CONTEXT_MUST_NOT_REACH_TASK_GENERATOR');
  });
});
