import './helpers';
import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ model: vi.fn(), control: vi.fn() }));
vi.mock('../server/llm/providers', async () => ({
  ...await vi.importActual<typeof import('../server/llm/providers')>('../server/llm/providers'),
  makeLLMCall: mocks.model,
}));
vi.mock('../server/agents/computer_use', () => ({ computerUseLoop: mocks.control }));
import { runWithTools } from '../server/llm/adapter';
import { registerComputerUseTool } from '../server/tools/definitions/computer_use_tool';
import { ToolRegistry } from '../server/tools/registry';
import { finalizeLumiResponse } from '../server/cognition/result_finalizer';
import { decideExecutionGuardRecovery } from '../server/cognition/execution_guard_recovery';
import { findDesktopCompletionReview, DESKTOP_COMPLETION_REVIEW_REASON } from '../server/cognition/desktop_completion_review';
import type { ToolExecutionRecord } from '../server/tools/types';

const task = '用爱奇艺播放蜡笔小新';
const candidate = JSON.stringify({ ok: false, status: 'unverified', completionVerified: false, observations: 1,
  resumeStrategy: 'observe_only', completionCandidate: 'The programme page is open.', message: 'Fresh completion observation was unclear.' });
const receipt = (overrides: Partial<ToolExecutionRecord> = {}): ToolExecutionRecord => ({
  name: 'computer_use', arguments: { task }, result: candidate,
  taskId: 'review-task', requestId: 'review-request',
  terminalVerification: { status: 'failed', strategy: 'visual', reason: 'Unverified completion' }, ...overrides,
});
const getters = [() => null, () => null, () => null, () => null, () => null] as const;

beforeEach(() => { vi.clearAllMocks(); });

describe('uncertain desktop completion keeps progress without repeating control', () => {
  it('stops the actual tool loop before the rest of a model-selected batch can click again', async () => {
    const registry = new ToolRegistry();
    registerComputerUseTool(registry);
    const click = vi.fn(async () => '{"ok":true}');
    registry.register({ name: 'desktop_mouse_click_at', description: 'Click the current desktop target',
      parameters: { type: 'object', properties: {} }, permission: 'public', securityLevel: 'safe', handler: click });
    mocks.control.mockResolvedValue(candidate);
    mocks.model.mockResolvedValueOnce({ text: '', toolCalls: [
      { id: 'control-once', name: 'computer_use', arguments: { task, target_application: '爱奇艺', max_steps: 2 } },
      { id: 'unwanted-repeat', name: 'desktop_mouse_click_at', arguments: { x: 20, y: 20 } },
    ] });
    const result = await runWithTools([{ role: 'user', content: task }], registry,
      { provider: 'deepseek', model: 'test-model', userId: 'review-user' }, undefined, 3, ...getters, undefined,
      { userId: 'review-user', taskId: 'review-task', requestId: 'review-request', actionIntent: task,
        desktopRelay: vi.fn(async () => ''), llmGetters: { getDeepSeek: () => null, getGemini: () => null, getOpenAI: () => ({}) }, requestConfirmation: async () => true });
    expect(mocks.control).toHaveBeenCalledTimes(1);
    expect(click).not.toHaveBeenCalled();
    expect(mocks.model).toHaveBeenCalledTimes(1);
    expect(result.completionGuard).toMatchObject({ blocked: true, reason: DESKTOP_COMPLETION_REVIEW_REASON });
    expect(result.toolCalls).toHaveLength(1);
    const final = finalizeLumiResponse({ taskText: task, responseText: result.text, source: 'chat',
      toolRecords: result.toolCalls, completionGuard: result.completionGuard, requestId: 'review-request', taskId: 'review-task' });
    expect(final.reason).toBe(DESKTOP_COMPLETION_REVIEW_REASON);
    expect(final.text).toContain('已保留当前进度');
    expect(final.text).not.toContain('还没有执行');
    expect(decideExecutionGuardRecovery({ task, toolRecords: result.toolCalls, blocked: final.blocked,
      reason: final.reason, allowToolUse: true }).recoverable).toBe(false);
  });

  it('keeps same-request recovery from reopening control while allowing a new request to be evaluated', async () => {
    const registry = new ToolRegistry();
    const current = await runWithTools([{ role: 'user', content: task }], registry,
      { provider: 'deepseek', model: 'test-model', userId: 'review-recovery' }, undefined, 2, ...getters, undefined,
      { userId: 'review-recovery', taskId: 'review-task', requestId: 'review-request', priorToolRecords: [receipt()] });
    expect(current.completionGuard?.reason).toBe(DESKTOP_COMPLETION_REVIEW_REASON);
    expect(mocks.model).not.toHaveBeenCalled();
    expect(findDesktopCompletionReview([receipt()], { requestId: 'new-request', taskId: 'review-task' })).toBeUndefined();
  });

  it('does not accept plain user/model text, another tool, stale scope or a missing terminal record', () => {
    expect(findDesktopCompletionReview([receipt({ name: 'read_file' })])).toBeUndefined();
    expect(findDesktopCompletionReview([receipt({ terminalVerification: undefined })])).toBeUndefined();
    expect(findDesktopCompletionReview([receipt()], { taskId: 'another-task' })).toBeUndefined();
    expect(findDesktopCompletionReview([receipt({ result: 'resumeStrategy=observe_only' })])).toBeUndefined();
    const final = finalizeLumiResponse({ taskText: task, responseText: candidate, source: 'chat', toolRecords: [] });
    expect(final.reason).not.toBe(DESKTOP_COMPLETION_REVIEW_REASON);
  });

  it('does not let an older pending candidate override a newer successful control receipt', () => {
    const verified = receipt({ result: '{"ok":true,"status":"verified","completionVerified":true,"observations":2}',
      terminalVerification: { status: 'verified', strategy: 'visual', reason: 'Two new observations' } });
    expect(findDesktopCompletionReview([receipt(), verified], { requestId: 'review-request' })).toBeUndefined();
  });
});
