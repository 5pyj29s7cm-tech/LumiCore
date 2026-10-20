import './helpers';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import replay from './fixtures/media_unknown_native_20261017.json';
import { finalizeLumiResponse } from '../server/cognition/result_finalizer';
import { mediaContractForRequest } from '../server/cognition/contracts/media_contract';
import { buildForegroundTaskCompletionFeedback } from '../server/cognition/acceptance_evidence';
import { recordsToTaskReceipts, taskCompletionFromReceipts } from '../server/cognition/task_execution_ledger';
import { buildStructuredMediaDeterministicToolRecoveryCall } from '../server/cognition/deterministic_tool_recovery';
import type { LumiTurnFlow } from '../server/cognition/turn_flow';
import type { ToolExecutionRecord } from '../server/tools/types';
import { ToolRegistry } from '../server/tools/registry';
import { runWithTools } from '../server/llm/adapter';

const model = vi.hoisted(() => ({ call: vi.fn(), stream: vi.fn() }));
vi.mock('../server/llm/providers', async original => ({ ...await original<typeof import('../server/llm/providers')>(), makeLLMCall: model.call, makeLLMCallStreaming: model.stream }));
const request = { operation: 'text_to_video' as const, prompt: replay.taskText, size: '1080x1920', duration: 15 };
const contract = mediaContractForRequest(request);
const scope = { requestId: replay.requestId, taskId: replay.taskId };
const flow = { routeText: replay.taskText, structuredMediaRequest: request, acceptedActionContract: { taskText: replay.taskText, contract } } as LumiTurnFlow;
const actual = () => structuredClone(replay.record) as ToolExecutionRecord;
const render = (record = actual(), responseText = '') => finalizeLumiResponse({ taskText: replay.taskText, responseText, source: 'chat', flow, ...scope, toolRecords: [record] });
beforeAll(async () => { await (await import('../db_layer')).initDatabase(); });
beforeEach(() => { vi.clearAllMocks(); model.call.mockRejectedValue(new Error('Unexpected model call')); model.stream.mockRejectedValue(new Error('Unexpected streaming model call')); });

describe('retained unknown media terminal reply', () => {
  it.each([['cancelled','cancelled'],['waiting_confirmation','working'],['persistence_unknown','blocked']] as const)('keeps %s lifecycle priority above retained unknown generation', (status, expected) => {
    const record = actual(); const final = render(record);
    expect(final).toMatchObject({blocked:true,reason:'media_generation_unknown'});
    const feedback = buildForegroundTaskCompletionFeedback({taskId:scope.taskId,taskLabel:replay.taskText,toolRecords:[record],finalization:final,status});
    expect(feedback?.status).toBe(expected);
    expect(feedback?.completed).not.toContain(expect.stringContaining('completed with verified'));
    expect(model.call).not.toHaveBeenCalled();expect(model.stream).not.toHaveBeenCalled();
  });
  it('projects retained unknown only as a queryable result, never completed or retryable generation', () => {
    const record = actual(); const final = render(record);
    const feedback = buildForegroundTaskCompletionFeedback({taskId:scope.taskId,taskLabel:replay.taskText,toolRecords:[record],finalization:final});
    expect(feedback?.status).toBe('unknown');expect(feedback?.completed).toEqual([]);
    expect(feedback?.nextSteps.join(' ')).toContain('查询原任务状态');
    expect(feedback?.nextSteps.join(' ')).toContain('请勿重复生成');
    expect(feedback?.nextSteps.join(' ')).not.toMatch(/重试|retry|regenerate/i);
    expect(taskCompletionFromReceipts(replay.taskText,recordsToTaskReceipts([record]),undefined,scope).complete).toBe(false);
    expect(model.call).not.toHaveBeenCalled();expect(model.stream).not.toHaveBeenCalled();
  });

  it('replays the exact canonical unknown result as a nonempty retained-task explanation', () => {
    const record = actual();
    const unchanged = structuredClone(record);
    const final = render(record);
    expect(final.text).toContain('已提交');
    expect(final.text).toContain('结果尚未取回');
    expect(final.text).toContain('原任务已保留');
    expect(final.text).toContain('请勿重复生成');
    expect(final).toMatchObject({ blocked: true, reason: 'media_generation_unknown' });
    expect(final.text).not.toContain('视频已生成');
    expect(final.text).not.toContain('失败');
    expect(final.text).not.toContain('星光照归路');
    expect(final.text).not.toContain('recoveryId');
    expect(record).toEqual(unchanged);
    expect(buildForegroundTaskCompletionFeedback({ taskId: scope.taskId, taskLabel: replay.taskText, toolRecords: [record], finalization: final })?.status).toBe('unknown');
    expect(taskCompletionFromReceipts(replay.taskText, recordsToTaskReceipts([record]), undefined, scope).complete).toBe(false);
  });
  it('uses controlled text rather than echoing provider reason, prompt or raw fields', () => {
    const record = actual();
    const result = JSON.parse(record.result!);
    result.reason = 'api_key=private; raw_prompt=internal test';
    record.result = JSON.stringify(result);
    const final = render(record, '视频已经完成。');
    expect(final.text).toContain('原任务已保留');
    expect(final.text).not.toMatch(/private|raw_prompt|api_key|视频已经完成/);
  });
  it.each(['requestId', 'taskId'] as const)('does not use a retained task from a different %s', key => {
    const record = actual();
    record[key] = 'other-' + key;
    record.envelope![key] = 'other-' + key;
    expect(render(record).reason).not.toBe('media_generation_unknown');
    expect(render(record).text).not.toContain('已提交');
  });
  it('rejects conflicting host identity and unbound legacy input', () => {
    const record = actual();
    record.envelope!.requestId = 'other-envelope-request';
    expect(render(record).reason).not.toBe('media_generation_unknown');
    expect(finalizeLumiResponse({ taskText: replay.taskText, responseText: '', source: 'chat', flow, toolRecords: [actual()] }).reason).not.toBe('media_generation_unknown');
  });
  it.each(['adapter', 'retained', 'provider-task'] as const)('does not claim an accepted retained provider task without %s proof', dimension => {
    const record = actual();
    const payload = JSON.parse(record.result!);
    if (dimension === 'adapter') record.adapterStarted = false;
    if (dimension === 'retained') payload.automaticResubmissionBlocked = false;
    if (dimension === 'provider-task') payload.taskId = '';
    record.result = JSON.stringify(payload);
    expect(render(record).reason).not.toBe('media_generation_unknown');
    expect(render(record).text).not.toContain('已提交');
  });
  it.each(['safe', 'confirm'] as const)('keeps the deterministic one-invocation loop under %s policy without model calls or resubmission', async securityLevel => {
    const loopScope = {requestId:scope.requestId+'-'+securityLevel,taskId:scope.taskId+'-'+securityLevel};
    const registry = new ToolRegistry();
    const handler = vi.fn(async () => actual().result!);
    registry.register({ name: 'generate_video', description: 'Controlled offline media result', parameters: { type: 'object', properties: {}, required: [] }, permission: 'public', securityLevel,
      capability: { id: 'media.video.generate', family: 'media-generation', lane: 'media', operation: 'create', risk: 'medium', sideEffects: actual().capability!.sideEffects, verification: actual().capability!.verification }, handler });
    const approve = vi.fn(async (_name: string, _args: Record<string, unknown>) => true);
    const context = { userId: 'unknown-media-test', source: 'chat', requestConfirmation: approve, ...loopScope, taskRevision: 1, acceptedActionContract: { taskText: replay.taskText, contract },
      runtimeOwnedDeterministicRecoveryCall: buildStructuredMediaDeterministicToolRecoveryCall(request, { ...loopScope, taskRevision: 1 }) };
    const result = await runWithTools([{ role: 'user', content: replay.taskText }], registry,
      { provider: 'deepseek', model: 'test-only', userId: 'unknown-media-test' }, undefined, 5,
      () => null, () => null, () => null, () => null, () => null, undefined, context);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(approve).toHaveBeenCalledTimes(securityLevel === 'confirm' ? 1 : 0);
    if (securityLevel === 'confirm') expect(approve.mock.calls[0][0]).toBe('generate_video');
    expect(model.call).not.toHaveBeenCalled(); expect(model.stream).not.toHaveBeenCalled();
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0].envelope?.status).toBe('unknown_outcome');
    const final = finalizeLumiResponse({ taskText: replay.taskText, responseText: result.text, source: 'chat', flow, ...loopScope, toolRecords: result.toolCalls });
    expect(final.text).toContain('原任务已保留');
    expect(final.text).toContain('请勿重复生成');
    expect(buildForegroundTaskCompletionFeedback({ taskId: loopScope.taskId, taskLabel: replay.taskText, toolRecords: result.toolCalls, finalization: final })?.status).toBe('unknown');
  });
});
