import './helpers';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { initDatabase } from '../db_layer';
import { makeLLMCallStreaming } from '../server/llm/providers';
import { upsertUserPreferredLLM } from '../server/llm/user_preferences';
import { resetCircuit } from '../server/cloud/circuit_breaker';
import { runWithTools } from '../server/llm/adapter';
import { ToolRegistry } from '../server/tools/registry';
import { capabilityContract, capabilityEvidence } from '../server/tools/capability_contracts';

vi.mock('../server/llm/local_models', async importOriginal => {
  const actual = await importOriginal<typeof import('../server/llm/local_models')>();
  return {
    ...actual,
    resolveAutoLocalModelCandidates: vi.fn(async () => [{ provider: 'ollama', model: 'audit-local' }]),
    ensureLocalModelReady: vi.fn(async (_provider: string, model: string) => model),
    runLocalModelInference: vi.fn(async (_provider: string, execute: () => Promise<unknown>) => execute()),
  };
});

const timeout = { requestMs: 1000, firstByteMs: 1000, semanticContentMs: 1000, idleMs: 1000, absoluteMs: 3000 };
const declarations = [{ type: 'function' as const, function: { name: 'audit_read', description: 'Read a synthetic fixture', parameters: { type: 'object', properties: {} } } }];

async function invoke(mode: 'auto' | 'ordered_fallback', localFails: boolean, buffered = true) {
  const userId = `audit9-routing-${mode}-${localFails}`;
  upsertUserPreferredLLM(userId, {
    provider: mode === 'auto' ? 'auto' : 'ollama', model: 'audit-local', selectionMode: mode,
    autoFallbackProvider: 'deepseek', autoFallbackModel: 'audit-cloud',
    fallbackCandidates: [{ provider: 'deepseek', model: 'audit-cloud' }], allowCloudFallback: true,
  });
  const localCreate = vi.fn(async () => (async function* () {
    yield { choices: [{ delta: { content: localFails ? 'UNVERIFIED PARTIAL PLAN' : 'healthy local reply' } }] };
    if (localFails) throw new Error('ECONNRESET deterministic synthetic stream failure');
  })());
  const cloudCreate = vi.fn(async () => (async function* () {
    yield { choices: [{ delta: { content: 'healthy fallback reply' } }] };
  })());
  const local = { chat: { completions: { create: localCreate } } };
  const cloud = { chat: { completions: { create: cloudCreate } } };
  const visible: string[] = [];
  let result: any;
  let error: any;
  try {
    result = await makeLLMCallStreaming(
      [{ role: 'user', content: 'Read the synthetic fixture and report only a verified result.' }], declarations,
      { provider: mode === 'auto' ? 'auto' : 'ollama', model: 'audit-local', userId, selectionMode: mode,
        fallbackCandidates: [{ provider: 'deepseek', model: 'audit-cloud' }], allowCloudFallback: true,
        bufferStreamUntilCandidateSuccess: buffered, protectedToolNames: ['audit_read'], localRequiredToolNames: ['audit_read'],
        attemptTimeouts: timeout },
      chunk => visible.push(chunk), () => cloud, () => null, undefined, undefined, undefined, () => local,
    );
  } catch (caught) { error = caught; }
  return { result, error, visible, localCreate, cloudCreate };
}

describe('automatic model routing request contracts', () => {
  beforeAll(async () => { await initDatabase(); });
  afterEach(() => { resetCircuit(); vi.clearAllMocks(); });

  it('control: auto succeeds on a healthy local stream', async () => {
    const run = await invoke('auto', false);
    expect(run.error).toBeUndefined();
    expect(run.result.text).toBe('healthy local reply');
    expect(run.visible).toEqual(['healthy local reply']);
    expect(run.cloudCreate).not.toHaveBeenCalled();
  });

  it('control: ordered fallback buffers failed planning output and reaches the healthy fallback', async () => {
    const run = await invoke('ordered_fallback', true);
    expect(run.error).toBeUndefined();
    expect(run.result.text).toBe('healthy fallback reply');
    expect(run.visible).toEqual(['healthy fallback reply']);
    expect(run.cloudCreate).toHaveBeenCalledOnce();
  });

  it('auto buffers a failed planning stream and reaches the healthy fallback', async () => {
    const run = await invoke('auto', true);
    expect(run.error).toBeUndefined();
    expect(run.result.text).toBe('healthy fallback reply');
    expect(run.visible).toEqual(['healthy fallback reply']);
    expect(run.cloudCreate).toHaveBeenCalledOnce();
    expect(run.result.routing.attempts[0]).toMatchObject({ provider: 'ollama', status: 'failed', visibleOutputCommitted: false });
  });

  it('does not mix a fallback reply after a caller intentionally exposes streaming output', async () => {
    const run = await invoke('auto', true, false);
    expect(run.error?.message).toContain('ECONNRESET');
    expect(run.visible).toEqual(['UNVERIFIED PARTIAL PLAN']);
    expect(run.cloudCreate).not.toHaveBeenCalled();
  });

  it('fails closed when the automatic route cannot preserve a required tool schema', async () => {
    const create = vi.fn(async () => (async function* () {
      yield { choices: [{ delta: { content: 'must not execute without the required schema' } }] };
    })());
    const client = { chat: { completions: { create } } };
    const largeTool = [{ type: 'function' as const, function: {
      name: 'required_recovery', description: 'Mandatory recovery capability.',
      parameters: { type: 'object', properties: { choice: { type: 'string', enum: Array.from({ length: 2000 }, (_, i) => `required-choice-${i}`) } } },
    } }];
    await expect(makeLLMCallStreaming(
      [{ role: 'user', content: 'Continue the task.' }], largeTool,
      { provider: 'auto', model: 'audit-local', inputTokenBudget: 2048,
        protectedToolNames: ['required_recovery'], localRequiredToolNames: ['required_recovery'],
        allowCloudFallback: true, bufferStreamUntilCandidateSuccess: true, attemptTimeouts: timeout },
      () => {}, () => client, () => null, undefined, undefined, undefined, () => client,
    )).rejects.toThrow('protected tool declarations');
    expect(create).not.toHaveBeenCalled();
  });

  it('discards buffered planning text and does not call a fallback after cancellation', async () => {
    const controller = new AbortController();
    const fallback = vi.fn();
    const localCreate = vi.fn(async () => (async function* () {
      yield { choices: [{ delta: { content: 'unverified cancelled plan' } }] };
      controller.abort(new Error('cancelled by synthetic caller'));
      throw controller.signal.reason;
    })());
    const visible: string[] = [];
    await expect(makeLLMCallStreaming(
      [{ role: 'user', content: 'Run the synthetic task.' }], declarations,
      { provider: 'auto', model: 'audit-local', signal: controller.signal,
        bufferStreamUntilCandidateSuccess: true, allowCloudFallback: true, attemptTimeouts: timeout },
      chunk => visible.push(chunk), () => ({ chat: { completions: { create: fallback } } }), () => null,
      undefined, undefined, undefined, () => ({ chat: { completions: { create: localCreate } } }),
    )).rejects.toThrow();
    expect(visible).toEqual([]);
    expect(fallback).not.toHaveBeenCalled();
  });

  it.each(['auto', 'ordered_fallback'] as const)('real tool-loop control and failure comparison: %s', async mode => {
    const userId = `audit9-loop-${mode}`;
    const taskId = `task-${userId}`;
    const requestId = `request-${userId}`;
    upsertUserPreferredLLM(userId, {
      provider: mode === 'auto' ? 'auto' : 'ollama', model: 'audit-local', selectionMode: mode,
      autoFallbackProvider: 'deepseek', autoFallbackModel: 'audit-cloud',
      fallbackCandidates: [{ provider: 'deepseek', model: 'audit-cloud' }], allowCloudFallback: true,
    });
    const handler = vi.fn(async () => JSON.stringify({ ok: true, status: 'verified', value: 'synthetic fixture value' }));
    const registry = new ToolRegistry();
    registry.register({
      name: 'audit_read', description: 'Read the isolated synthetic audit value.',
      parameters: { type: 'object', properties: {} }, handler, permission: 'public', securityLevel: 'safe',
      capability: capabilityContract({
        id: 'test.audit9.read', family: 'test', lane: 'files', operation: 'test', risk: 'low',
        sideEffects: [{ type: 'local_read', scope: 'isolated synthetic data', reversible: true }],
        verification: { strategy: 'terminal_receipt', required: true,
          requiredFields: ['ok', 'status', 'value'], requiredValues: { ok: true, status: 'verified' },
          successStatuses: ['verified'], successSignals: ['synthetic value returned'], limitations: ['audit fixture only'] },
      }),
      evidence: capabilityEvidence({ id: 'test.audit9.read', operation: 'test' }),
    });
    const localCreate = vi.fn(async () => (async function* () {
      yield { choices: [{ delta: { content: 'UNVERIFIED PARTIAL PLAN' } }] };
      throw new Error('ECONNRESET deterministic synthetic stream failure');
    })());
    let cloudCalls = 0;
    const cloudCreate = vi.fn(async () => (async function* () {
      cloudCalls += 1;
      yield { choices: [{ delta: cloudCalls === 1
        ? { content: 'I am reading it now.', tool_calls: [{ index: 0, id: `call-${userId}`, function: { name: 'audit_read', arguments: '{}' } }] }
        : { content: 'Verified synthetic fixture value.' } }] };
    })());
    const visible: string[] = [];
    let result: any;
    let error: any;
    try {
      result = await runWithTools(
        [{ role: 'user', content: 'Run audit_read once and report its exact verified value.' }], registry,
        { provider: mode === 'auto' ? 'auto' : 'ollama', model: 'audit-local', userId,
          selectionMode: mode, fallbackCandidates: [{ provider: 'deepseek', model: 'audit-cloud' }], allowCloudFallback: true,
          attemptTimeouts: timeout, modelWaitBudgetMs: 4000, requestId },
        undefined, 3,
        () => ({ chat: { completions: { create: cloudCreate } } }), () => null, () => null, () => null, () => null,
        chunk => visible.push(chunk),
        { userId, authenticated: true, authRole: 'admin', localExecution: true, executionBoundary: 'trusted_local',
          taskId, turnId: requestId, requestId, domain: 'personal', orgId: '', source: 'chat',
          actionIntent: 'Run audit_read once.', routedTaskText: 'Run audit_read once and report its exact verified value.',
          toolPolicy: { allowedTools: ['audit_read'], requireConfirmation: [], forbiddenTools: [], maxIterations: 3 },
          modelToolProjection: { toolNames: ['audit_read'], maxTools: 1, allowDynamicDiscovery: false } },
        () => ({ chat: { completions: { create: localCreate } } }),
      );
    } catch (caught) { error = caught; }
    expect(error).toBeUndefined();
    expect(result.text).toBe('Verified synthetic fixture value.');
    expect(visible).toEqual(['Verified synthetic fixture value.']);
    expect(handler).toHaveBeenCalledOnce();
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0]).toMatchObject({ name: 'audit_read', terminalVerification: { status: 'verified' } });
  });
});
