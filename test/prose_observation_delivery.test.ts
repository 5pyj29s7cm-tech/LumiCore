import './helpers';
import { describe, expect, it } from 'vitest';
import { finalizeLumiResponse } from '../server/cognition/result_finalizer';
import { guardCompletionClaims } from '../server/work_product/completion_guard';
import { isCompletedObservationOnlyDelivery } from '../server/conversation/manager/terminal_disposition';
import { compactRecordForPrompt } from '../server/conversation/manager/message_history';
import type { MessageRecord } from '../server/conversation/manager/contracts';
import { buildActionContract } from '../server/cognition/action_contract';
import type { ToolExecutionRecord } from '../server/tools/types';

const requestId = 'prose-observation-current';
const taskId = 'prose-observation-task';
const taskText = '请解释给出的材料，在聊天中回答。';
const observation: ToolExecutionRecord = {
  name: 'url_fetch', arguments: { url: 'https://example.org/reference' }, requestId, taskId,
  result: 'A reference returned for comparison.',
  terminalVerification: { status: 'verified', strategy: 'terminal_receipt', reason: 'Current source returned.' },
  capability: { capabilityId: 'url_fetch', lane: 'general', operation: 'observe', risk: 'low',
    sideEffects: [{ type: 'network_read', scope: 'external', reversible: true }], verification: { strategy: 'terminal_receipt', required: true,
      requiredFields: [], successSignals: ['returned'], limitations: [] } },
};

describe('native analysis does not become an action from reply vocabulary', () => {
  it.each([
    ['third-party information', '机构已经删除其公开页面中的个人信息。'],
    ['operation log', '日志表明管理员已经删除备份文件。'],
    ['historical archive', '该档案已经保存多年。'],
    ['past communication', '记录显示通知已经发送给各参与方。'],
    ['past opening', '资料记载该网站已经打开公众讨论。'],
    ['English narrative', 'The archive was saved, and the old copy was deleted.'],
    ['technical prose', '管理员运行了 `fictional_command`，这是一段历史记录。'],
    ['prior diagnostic record', '之前的记录显示系统已经进行了健康检查。'],
    ['handbook state wording', '手册中的描述是已验证客户端状态。'],
    ['status text being explained', '记录中的状态短语如下。\n正在执行——'],
  ])('preserves %s with only a current read-only observation', (_label, responseText) => {
    expect(buildActionContract(taskText).applies).toBe(false);
    const input = { taskText, responseText, source: 'chat', requestId, taskId, toolRecords: [observation] };
    expect(finalizeLumiResponse(input)).toMatchObject({ text: responseText, blocked: false });
    expect(guardCompletionClaims({ task: taskText, response: responseText, requestId, taskId,
      toolCalls: [observation] })).toMatchObject({ text: responseText, blocked: false });
    expect(isCompletedObservationOnlyDelivery({ taskText, assistantText: responseText,
      requestId, taskId, toolRecords: [observation],
      completionFeedback: { status: 'completed', incomplete: [], blockers: [] } })).toBe(true);
  });

  it('preserves unverified historical narrative bytes instead of substituting a fixed reply', () => {
    const message = '  机构已经删除其旧记录，以下是历史说明。\n';
    const record = { id: 'historical-prose', role: 'assistant', message, response: '', toolCalls: [] } as unknown as MessageRecord;
    expect(compactRecordForPrompt(record, { preserveText: true }).message).toBe(message);
  });

  it('preserves supplied restatement prose instead of deleting reminder vocabulary', () => {
    const task = '请原样复述所给材料。';
    const responseText = '收到材料。我们把这一天记在日程里。';
    expect(finalizeLumiResponse({ taskText: task, responseText, source: 'chat', requestId, taskId, toolRecords: [] }))
      .toMatchObject({ text: responseText, blocked: false });
  });

  it.each([
    ['read', '请读取 D:/synthetic/input.docx 的完整正文，在聊天中返回。', 'artifact_work'],
    ['write', '请把下面内容写入 D:/synthetic/output.txt：summary', 'artifact_work'],
    ['send', '给 Alice 发微信消息：确认收到。', 'messaging_send'],
    ['open', '请打开记事本。', 'desktop_operation'],
  ])('still requires actual %s evidence from the existing user action contract', (_label, task, kind) => {
    expect(buildActionContract(task).kind).toBe(kind);
    const result = finalizeLumiResponse({ taskText: task, responseText: '说明如下。', source: 'chat',
      requestId, taskId, toolRecords: [observation] });
    expect(result.blocked).toBe(true);
    expect(result.reason).toMatch(/Missing core evidence|Missing desktop evidence/);
    expect(isCompletedObservationOnlyDelivery({ taskText: task, assistantText: '说明如下。',
      requestId, taskId, toolRecords: [observation],
      completionFeedback: { status: 'completed', incomplete: [], blockers: [] } })).toBe(false);
  });

  it('retains a blocked final disposition instead of completing a real write with an unknown outcome', () => {
    const task = '请把下面内容写入 D:/synthetic/output.txt：summary';
    const record = { ...observation, name: 'write_file', arguments: { path: 'D:/synthetic/output.txt', content: 'summary' },
      error: 'Connection ended before the write result was confirmed.',
      capability: { ...observation.capability!, operation: 'mutate' as const, sideEffects: [{ type: 'local_write' as const, scope: 'filesystem', reversible: true }] },
      envelope: { version: 1, status: 'unknown_outcome', requestId, taskId,
        toolName: 'write_file', turnId: requestId, idempotencyKey: 'fixture-unknown-write', targetIdentity: 'D:/synthetic/output.txt',
        completedAt: '2026-01-01T00:00:00Z', verification: { status: 'unverified', basis: 'terminal_verification', reason: 'Not confirmed.' } },
    } as ToolExecutionRecord;
    expect(finalizeLumiResponse({ taskText: task, responseText: '说明如下。', source: 'chat',
      requestId, taskId, toolRecords: [record] }).blocked).toBe(true);
    expect(isCompletedObservationOnlyDelivery({ taskText, assistantText: '说明如下。',
      requestId, taskId, toolRecords: [record],
      completionFeedback: { status: 'completed', incomplete: [], blockers: [] } })).toBe(false);
  });
});
