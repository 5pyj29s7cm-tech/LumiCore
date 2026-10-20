import './helpers';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { initDatabase, readDB, flushDBOrThrow } from '../db_layer';
import { getOrCreateActiveConversation, addMessageIdempotent } from '../server/conversation/manager';
import { preparePlannedConversationExecution } from '../server/conversation/planned_execution';
import { persistConversationExecutionPlan } from '../server/conversation/manager/execution_preparation';
import { createConversationReceiptObserver } from '../server/conversation/execution_receipt_archive';
import { buildLumiExecutionPipeline } from '../server/cognition/execution_pipeline';
import { buildCapabilityExecutionPlan } from '../server/cognition/capability_execution_plan';
import { finalizeLumiResponse, tryFinalizeVerifiedBoundedAction } from '../server/cognition/result_finalizer';
import { ToolRegistry } from '../server/tools/registry';
import { executeToolCall, isCanonicalToolExecutionRecord } from '../server/tools/execution_engine';
import { registerFileOpsTools } from '../server/tools/definitions/file_ops';
import type { ToolContext } from '../server/tools/types';

beforeAll(() => initDatabase());
beforeEach(() => { vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('NETWORK_FORBIDDEN_IN_SEMANTIC_FIXTURE')); });
function registry() {
  const value = new ToolRegistry();
  registerFileOpsTools(value);
  return value;
}
async function accepted(task: string, tools: ToolRegistry) {
  const userId = 'deduction-owner-' + randomUUID();
  const conversationId = getOrCreateActiveConversation(userId, 'lumi', 'personal', '').id;
  const requestId = 'deduction-' + randomUUID();
  const userMessageId = addMessageIdempotent({ userId, conversationId, agentId: 'lumi', requestId,
    source: 'semantic-deduction-fixture', channel: 'chat', domain: 'personal', orgId: '',
    role: 'user', content: task, deferActionPreparation: true });
  await flushDBOrThrow();
  const execution = buildLumiExecutionPipeline({ requestId, registry: tools,
    dispatch: { userId, text: task, channel: 'chat', source: 'command-center-chat', domain: 'personal', orgId: '' } });
  const prepared = preparePlannedConversationExecution({ execution, conversationId, userId, requestId, userMessageId, userText: task });
  if ('bindingFailure' in prepared || !prepared.state?.taskId) throw new Error('Exact fixture turn did not acquire its accepted task');
  const taskId = prepared.state.taskId;
  const observer = createConversationReceiptObserver({ userId, conversationId, taskId, requestId, turnRowId: prepared.turnRowId, domain: 'personal', orgId: '' }, () => true);
  const context: ToolContext = { userId, conversationId, taskId, requestId, turnId: requestId, turnRowId: prepared.turnRowId,
    authRole: 'admin', authenticated: true, localExecution: true, userConfirmed: true, domain: 'personal', orgId: '',
    source: 'command-center-chat', actionIntent: task, routedTaskText: task, toolPolicy: execution.authorizationPolicy };
  const call = async (name: string, args: Record<string, unknown>) => {
    const record = await executeToolCall({ registry: tools, id: requestId + ':' + name, name, arguments: args, context });
    expect(isCanonicalToolExecutionRecord(record)).toBe(true);
    const capability = tools.getCapabilityManifestEntry(name)!;
    const plan = buildCapabilityExecutionPlan({ record, capability, taskId });
    expect(persistConversationExecutionPlan({ conversationId, userId, plan })).toBe(true);
    await observer.onToolRecord(record);
    await flushDBOrThrow();
    expect(readDB().conversationActionReceipts.some((receipt: any) => receipt.taskId === taskId && receipt.requestId === requestId && receipt.toolName === name)).toBe(true);
    expect(JSON.parse(readDB().conversationActionTasks.find((row: any) => row.id === taskId)!.context).executionPlan.planId).toBe(plan.planId);
    return record;
  };
  return { userId, conversationId, taskId, requestId, context, call, execution, userMessageId };
}

// A source read is preparation for a requested report, not the report itself.
describe('partial public text cannot be upgraded by a raw-source formatter', () => {
  it.each(['', '原文已经读取，分析报告仍未生成。'])('keeps the full source-to-report request incomplete for response %s', async responseText => {
    const tools = registry();
    const marker = 'RAW_SOURCE_ONLY_' + randomUUID();
    const source = path.join(String(process.env.LUMI_DATA_DIR), 'input-' + randomUUID() + '.txt');
    const output = path.join(String(process.env.LUMI_DATA_DIR), 'analysis-' + randomUUID() + '.txt');
    fs.writeFileSync(source, marker + '\n单价12，数量2。');
    const task = '读取 ' + source + '，并在 ' + output + ' 生成完整分析报告。';
    const f = await accepted(task, tools);
    const record = await f.call('read_file', { path: source });
    expect(record.envelope?.status).toBe('verified_success');
    expect(record.result).toContain(marker);
    expect(fs.existsSync(output)).toBe(false);
    const input = { taskText: task, responseText, source: 'chat', requestId: f.requestId, taskId: f.taskId, toolRecords: [record] };
    expect(tryFinalizeVerifiedBoundedAction(input)).toBeNull();
    const final = finalizeLumiResponse(input);
    expect(final.blocked).toBe(true);
    expect(final.text.trim()).not.toBe('');
    expect(final.text).not.toContain(marker);
    expect(final.text).toMatch(/未|缺|待|尚|incomplete|pending/i);
    expect(readDB().conversationActionTasks.find((row: any) => row.id === f.taskId)?.goal).toBe(task);
  });
});

describe('source literal text is preserved after real whole-task evidence', () => {
 it('delivers the complete canonical source including a quoted incomplete phrase', async () => {
   const tools = registry();
   const source = path.join(String(process.env.LUMI_DATA_DIR), 'complete-source-'+randomUUID()+'.txt');
   const original = 'COMPLETE_CANONICAL_SOURCE_BEGIN\nQuoted phrase: not complete\nCOMPLETE_CANONICAL_SOURCE_TAIL';
   fs.writeFileSync(source,original);
   const task = 'Read the file '+source+' and show its complete contents.';
   const f = await accepted(task,tools);
   const record = await f.call('read_file',{path:source});
   expect(record.envelope?.status).toBe('verified_success');
   const result = finalizeLumiResponse({taskText:task,responseText:original,source:'chat',requestId:f.requestId,taskId:f.taskId,toolRecords:[record]});
   expect(result.blocked).toBe(false);
   expect(result.text).toBe(original);
   expect(result.text).toContain('COMPLETE_CANONICAL_SOURCE_TAIL');
 });
});
