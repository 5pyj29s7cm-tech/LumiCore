import './helpers';
import { describe, expect, it } from 'vitest';
import { classifyExternalCliIntent } from '../server/cognition/external_cli_intent';
import { normalizeActionIntent } from '../server/cognition/normalized_action_intent';
import { buildActionContract, hasCoreActionEvidence } from '../server/cognition/action_contract';
import { routeToolsForTurn } from '../server/cognition/tool_router';
import { hasExplicitToolIntent } from '../server/cognition/tool_intent';
import { classifyRecentActionFollowupIntent } from '../server/cognition/action_continuation';
import { finalizeLumiResponse, tryFinalizeVerifiedBoundedAction } from '../server/cognition/result_finalizer';
import { recordsToTaskReceipts, taskCompletionFromReceipts } from '../server/cognition/task_execution_ledger';
import { buildForegroundTaskCompletionFeedback } from '../server/cognition/acceptance_evidence';
import { executeExternalCli } from '../server/external_agents/cli_runtime';
import { getRecentWorkflows, recordWorkflow, workflowCaptureBlocker } from '../server/skills/worklog';
import type { ToolExecutionRecord } from '../server/tools/types';

const task = '你能控制codexcli吗';
const turn = { requestId: 'cli-status-request', taskId: 'cli-status-task' };
const target = { provider: 'codex', installed: true, ready: true, status: 'ready', version: 'codex-cli 0.154.0' };
function receipt(patch: Partial<ToolExecutionRecord> = {}): ToolExecutionRecord {
  return { id: 'cli-status', name: 'external_cli_status', arguments: {}, ...turn,
    result: JSON.stringify({ ok: true, status: 'completed', targets: [target] }),
    terminalVerification: { status: 'verified', strategy: 'terminal_receipt', reason: 'Local status checked.' }, ...patch };
}
const tools = ['external_cli_run', 'external_cli_status', 'external_cli_get_run', 'desktop_ai_ask', 'computer_use', 'read_file']
  .map(name => ({ type: 'function' as const, function: { name, description: name, parameters: { type: 'object', properties: {} } } }));

describe('CLI inquiry versus delegation', () => {
  it.each([task, '你能运行 Codex CLI 吗？', 'Can you run Codex CLI?', '检查 Codex CLI 是否安装', '查看 Claude Code 的运行状态', 'Codex CLI 和 Claude Code CLI 能用吗'])('checks local status without exposing submission: %s', text => {
    expect(classifyExternalCliIntent(text)).toBe('inspect');
    expect(normalizeActionIntent(text)).toMatchObject({ kind: 'external_cli_status', operation: 'read', sideEffectClass: 'none' });
    expect(hasExplicitToolIntent(text)).toBe(true);
    expect(classifyRecentActionFollowupIntent(text)).toBe('none');
    const route = routeToolsForTurn(text, tools);
    expect(route.toolNames).toContain('external_cli_status');
    expect(route.toolNames).not.toContain('external_cli_run');
    expect(route.toolNames).not.toContain('external_cli_get_run');
    expect(route.toolNames).not.toContain('desktop_ai_ask');
  });
  it.each(['你能用 Codex CLI 修复 D:/project 里的问题吗？', 'Can you use Codex CLI to fix this project?', '检查 Codex CLI 是否可用，然后让它修改代码', '让 Codex 检查这个项目', '调用 Codex CLI', '继续 Codex CLI 的任务'])('preserves concrete execution: %s', text => {
    expect(classifyExternalCliIntent(text)).toBe('delegate');
    expect(buildActionContract(text).preferredTools[0]).toBe('external_cli_run');
    expect(tryFinalizeVerifiedBoundedAction({ taskText: text, responseText: '', toolRecords: [receipt()], source: 'chat', ...turn })).toBeNull();
  });
  it.each(['Codex CLI 是什么', '如何使用 Claude Code 修改文件', 'How does Codex CLI run tasks?'])('does not turn explanation into execution: %s', text => {
    expect(classifyExternalCliIntent(text)).toBe('explain');
  });
  it('rejects model-invented submission after a capability question before spawning a process', async () => {
    await expect(executeExternalCli({ provider: 'codex', prompt: 'unrequested work', cwd: 'D:/lumiOS' }, {
      userId: 'cli-inquiry-test', authenticated: true, executionBoundary: 'trusted_local', localExecution: true,
      conversationId: 'cli-inquiry', ...turn, actionIntent: task,
    }, { resolveLaunch: () => { throw new Error('must not spawn'); } })).rejects.toThrow('has not requested external CLI delegation');
  });
});

describe('one CLI receipt verdict across loop, transcript, feedback and ledger', () => {
  it.each(['chat', 'voice'])('corrects the observed false failure in %s', source => {
    const records = [receipt()];
    const input = { taskText: task, responseText: '刚才没有完成，我没有拿到能确认结果的反馈。', toolRecords: records, source, ...turn };
    const final = finalizeLumiResponse(input);
    expect(final).toMatchObject({ blocked: false, reason: 'verified_external_cli_status' });
    expect(final.text).toContain('0.154.0'); expect(final.text).toContain('没有验证模型额度');
    expect(tryFinalizeVerifiedBoundedAction(input)).toEqual(final);
    expect(taskCompletionFromReceipts(task, recordsToTaskReceipts(records), undefined, turn).complete).toBe(true);
    expect(buildForegroundTaskCompletionFeedback({ taskId: turn.taskId, taskLabel: task, toolRecords: records, blocked: final.blocked })?.status).toBe('completed');
  });
  it.each([
    { requestId: 'old-request' }, { taskId: 'other-task' }, { error: 'inspection failed' },
    { result: '{"ok":true,"status":"completed","targets":[]}' },
    { result: JSON.stringify({ ok: true, status: 'completed', targets: [{ ...target, provider: 'claude' }] }) },
    { terminalVerification: { status: 'unverified', strategy: 'terminal_receipt', reason: 'missing check' } },
  ] as Partial<ToolExecutionRecord>[])('rejects incomplete, wrong-provider and stale status receipts: %j', patch => {
    const records = [receipt(patch)];
    const final = finalizeLumiResponse({ taskText: task, responseText: '可以，已经完成。', toolRecords: records, source: 'chat', ...turn });
    expect(final.blocked).toBe(true);
    expect(taskCompletionFromReceipts(task, recordsToTaskReceipts(records), undefined, turn).complete).toBe(false);
    expect(buildForegroundTaskCompletionFeedback({ taskId: turn.taskId, taskLabel: task, toolRecords: records, blocked: final.blocked })?.status).toBe('blocked');
  });
  it('reports unavailable CLI truthfully while completing the inspection', () => {
    const records = [receipt({ result: JSON.stringify({ ok: true, status: 'completed', targets: [{ ...target, installed: false, ready: false, status: 'not_installed' }] }) })];
    const result = finalizeLumiResponse({ taskText: task, responseText: '可以', toolRecords: records, source: 'chat', ...turn });
    expect(result.blocked).toBe(false); expect(result.text).toContain('尚未检测到'); expect(result.text).not.toContain('可以通过');
    expect(taskCompletionFromReceipts(task, recordsToTaskReceipts(records), undefined, turn).complete).toBe(true);
  });
  it('does not let installation prove task completion or the wrong provider prove delegation', () => {
    const goal = '让 Codex CLI 检查这个项目';
    expect(hasCoreActionEvidence(buildActionContract(goal), [receipt()], goal, undefined, turn)).toBe(false);
    expect(buildForegroundTaskCompletionFeedback({ taskId: turn.taskId, taskLabel: goal, toolRecords: [receipt()] })?.status).toBe('blocked');
    const wrong = receipt({ name: 'external_cli_run', result: JSON.stringify({ ok: true, status: 'completed', provider: 'claude', runId: 'wrong-provider', exitCode: 0, response: 'done' }) });
    expect(hasCoreActionEvidence(buildActionContract(goal), [wrong], goal, undefined, turn)).toBe(false);
  });
  it('does not learn status or receipt inspection, and preserves genuine read/compute workflows', () => {
    const base = { userId: 'cli-worklog-isolation', conversationId: 'cli-worklog', taskId: 'metadata', userIntent: task, conversationExcerpt: task };
    const pure = recordWorkflow({ ...base, toolSequence: ['external_cli_status', 'external_cli_get_run'].map(name => ({ name, args: {}, resultSummary: 'checked', verified: true })) });
    expect(getRecentWorkflows(base.userId)).toEqual([]);
    expect(workflowCaptureBlocker({ ...pure, toolSequence: [{ name: 'external_cli_status', args: {}, resultSummary: '', verified: true }] })).toContain('discovery');
    const business = recordWorkflow({ ...base, taskId: 'calculation', toolSequence: ['external_cli_status', 'read_file', 'code_execution'].map(name => ({ name, args: {}, resultSummary: 'checked', verified: true })) });
    expect(business.toolSequence.map(step => step.name)).toEqual(['read_file', 'code_execution']);
    expect(getRecentWorkflows(base.userId)).toHaveLength(1);
  });
});
