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

describe('verified simple playback stops desktop control after the receipt observer settles', () => {
  let sequence = 0;
  const goal = '用爱奇艺播放蜡笔小新第一集';
  const verifiedPlayback = (message = '爱奇艺正在播放蜡笔小新第一集，正片进度00:37。') => JSON.stringify({
    ok: true, status: 'verified', completionVerified: true, observations: 2,
    applicationIdentity: '', applicationMatched: true, message,
  });
  function setup(options: {
    goal?: string; message?: string; controlReceipt?: string; prior?: ToolExecutionRecord[]; missingTaskId?: boolean;
    onToolCall?: (record: ToolExecutionRecord) => unknown;
    isCancelled?: () => boolean; pauseReason?: () => string;
  } = {}) {
    const requestId = `playback-stop-request-${++sequence}`;
    const taskId = options.missingTaskId ? undefined : `playback-stop-task-${sequence}`;
    const instruction = options.goal || goal;
    const registry = new ToolRegistry();
    registerComputerUseTool(registry);
    const click = vi.fn(async () => '{"ok":true}');
    registry.register({ name: 'desktop_mouse_click_at', description: 'Click the requested desktop target',
      parameters: { type: 'object', properties: {} }, permission: 'public', securityLevel: 'safe', handler: click });
    mocks.control.mockReset().mockResolvedValue(options.controlReceipt || verifiedPlayback(options.message));
    mocks.model.mockReset().mockResolvedValue({ text: 'The requested tool steps have finished.' });
    mocks.model.mockResolvedValueOnce({ text: '', toolCalls: [
      { id: 'verified-playback', name: 'computer_use', arguments: { task: instruction, target_application: '爱奇艺', max_steps: 2 } },
      { id: 'next-action', name: 'desktop_mouse_click_at', arguments: { x: 30, y: 30 } },
    ] });
    const desktopRelay = Object.assign(vi.fn(async () => ''), { getControlPauseReason: options.pauseReason || (() => '') });
    const run = () => runWithTools([{ role: 'user' as const, content: instruction }], registry,
      { provider: 'deepseek', model: 'test-model', userId: 'playback-stop-user' }, options.onToolCall, 2, ...getters, undefined,
      { userId: 'playback-stop-user', taskId, requestId, actionIntent: instruction, routedTaskText: instruction,
        desktopRelay, priorToolRecords: options.prior, isCancelled: options.isCancelled,
        llmGetters: { getDeepSeek: () => null, getGemini: () => null, getOpenAI: () => ({}) }, requestConfirmation: async () => true });
    return { run, click, requestId, taskId };
  }

  it('waits for the real tool receipt callback, then omits the extra click and second model call', async () => {
    let entered!: () => void;
    let release!: () => void;
    const observed = new Promise<void>(resolve => { entered = resolve; });
    const persistence = new Promise<void>(resolve => { release = resolve; });
    const onToolCall = vi.fn(async () => { entered(); await persistence; });
    const fixture = setup({ onToolCall });
    const pending = fixture.run();
    await observed;
    expect(fixture.click).not.toHaveBeenCalled();
    let settled = false;
    void pending.then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    release();
    const result = await pending;
    expect(result.text).toBe('');
    expect(result.toolCalls).toHaveLength(1);
    expect(onToolCall).toHaveBeenCalledTimes(1);
    expect(fixture.click).not.toHaveBeenCalled();
    expect(mocks.model).toHaveBeenCalledTimes(1);
    expect(finalizeLumiResponse({ taskText: goal, responseText: result.text, toolRecords: result.toolCalls,
      source: 'chat', requestId: fixture.requestId, taskId: fixture.taskId }).blocked).toBe(false);
  });

  it.each([
    `${goal}。`, `${goal}！`, `${goal}.`,
  ])('allows ordinary sentence-ending punctuation on a simple playback goal: %s', async instruction => {
    const fixture = setup({ goal: instruction });
    const result = await fixture.run();
    expect(result.text).toBe('');
    expect(fixture.click).not.toHaveBeenCalled();
    expect(mocks.model).toHaveBeenCalledTimes(1);
  });

  it.each([
    `${goal}，然后截图`, `${goal}并发送截图给我`, `${goal}，把音量调到30%`,
    `${goal}并全屏`, `${goal}，十分钟后关闭`, `${goal}并下载`,
  ])('does not omit the remaining model-selected step of a compound request: %s', async instruction => {
    const fixture = setup({ goal: instruction });
    await fixture.run();
    expect(fixture.click).toHaveBeenCalledTimes(1);
  });

  it.each([
    '爱奇艺正在播放其他节目第一集。',
    '爱奇艺正在播放蜡笔小新第二集。',
    '爱奇艺正在播放蜡笔小新第一集，当前片前广告。',
  ])('does not stop the batch on the wrong content or advertisement: %s', async message => {
    const fixture = setup({ message });
    await fixture.run();
    expect(fixture.click).toHaveBeenCalledTimes(1);
  });

  it('does not let old verified playback stop a new request through the legacy actuation path', async () => {
    const old = (name: string, result: unknown, args = {}): ToolExecutionRecord => ({
      name, arguments: args, result: JSON.stringify(result), requestId: 'old-request', taskId: 'old-task',
      terminalVerification: { status: 'verified', strategy: 'visual', reason: 'Historical synthetic evidence' },
    });
    const fixture = setup({ controlReceipt: JSON.stringify({ ok: false, status: 'unverified', completionVerified: false,
      observations: 1, message: 'Synthetic current observation unavailable.' }), prior: [
      old('desktop_active_window', { appName: '爱奇艺' }),
      old('keyboard_press', { ok: true }, { key: 'space' }),
      old('desktop_ui_snapshot', { player: '爱奇艺', isPlaying: true, currentMedia: { title: '蜡笔小新', episode: 1 } }),
    ] });
    await fixture.run();
    expect(fixture.click).toHaveBeenCalledTimes(1);
  });

  it('does not use the new early-stop path without an immutable current task identity', async () => {
    const fixture = setup({ missingTaskId: true });
    await fixture.run();
    expect(fixture.click).toHaveBeenCalledTimes(1);
  });

  it('rejects a conflicting original turn identity even when requestId and taskId match', async () => {
    const fixture = setup({ onToolCall: record => { record.turnId = 'different-origin-turn'; } });
    await fixture.run();
    expect(fixture.click).toHaveBeenCalledTimes(1);
  });

  it('gives cancellation received during the receipt callback priority over verified playback', async () => {
    let cancelled = false;
    const fixture = setup({ isCancelled: () => cancelled, onToolCall: async () => { cancelled = true; } });
    const result = await fixture.run();
    expect(result.text).toMatch(/cancelled/iu);
    expect(fixture.click).not.toHaveBeenCalled();
    expect(mocks.model).toHaveBeenCalledTimes(1);
  });

  it('gives physical user takeover received during the receipt callback priority over success', async () => {
    let pause = '';
    const fixture = setup({ pauseReason: () => pause, onToolCall: async () => { pause = 'paused_for_user_activity'; } });
    const result = await fixture.run();
    expect(result.text).not.toBe('');
    expect(fixture.click).not.toHaveBeenCalled();
    expect(mocks.model).toHaveBeenCalledTimes(1);
  });
});
