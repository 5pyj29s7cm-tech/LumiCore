import './helpers';
import fs from 'node:fs';
import path from 'node:path';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const model = vi.hoisted(() => ({ call: vi.fn() }));
vi.mock('../server/llm/providers', async importOriginal => ({
  ...await importOriginal<typeof import('../server/llm/providers')>(), makeLLMCall: model.call,
}));

import { flushDBOrThrow, initDatabase } from '../db_layer';
import { addMessage, getMessages, getOrCreateActiveConversation } from '../server/conversation/manager';
import { buildLumiExecutionPipeline } from '../server/cognition/execution_pipeline';
import { finalizeLumiResponse } from '../server/cognition/result_finalizer';
import { runWithTools } from '../server/llm/adapter';
import { ToolRegistry } from '../server/tools/registry';
import { registerFileOpsTools } from '../server/tools/definitions/file_ops';
import { LUMI_OFFICIAL_DEFAULT_MODELS } from '../shared/model_provider_capabilities';
import type { ToolContext, ToolExecutionRecord } from '../server/tools/types';

beforeAll(() => initDatabase());
beforeEach(() => model.call.mockReset());
let serial = 0;
const noClient = [() => null, () => null, () => null, () => null, () => null] as const;

async function fixture(channel: 'chat' | 'voice', quantity = 2) {
  const number = ++serial;
  const userId = `shared-loop-target-${number}`;
  const registry = new ToolRegistry();
  registerFileOpsTools(registry);
  const directory = fs.mkdtempSync(path.join(String(process.env.LUMI_DATA_DIR), 'shared-loop-source-'));
  const filePath = path.join(directory, 'orders.csv');
  const csv = `item,quantity,price\nA,${quantity},10\nB,${quantity * 2},5\n`;
  fs.writeFileSync(filePath, csv);
  const otherPath = path.join(directory, 'other.csv');
  fs.writeFileSync(otherPath, 'item,quantity,price\nA,99,99\nB,99,99\n');
  const conversation = getOrCreateActiveConversation(userId, 'lumi', 'personal', '');
  const plan = `我要处理 ${filePath}，按数量乘单价计算每项金额和总额。现在只说明计划，不要读取文件，也不要执行操作。`;
  const personalityToolPolicy = { allowedTools: ['*'], requireConfirmation: [], forbiddenTools: [], maxIterations: 5 };
  const planPipeline = buildLumiExecutionPipeline({
    dispatch: { userId, text: plan, channel, source: channel, domain: 'personal', operationMode: 'assistant', targetIsLumi: true },
    registry, personalityToolPolicy,
  });
  expect(planPipeline.executionRequested).toBe(false);
  const priorMessageId = addMessage({ userId, conversationId: conversation.id, role: 'user', content: plan, domain: 'personal', source: channel, requestId: `plan-${number}`, deferActionPreparation: true });
  await flushDBOrThrow();
  const persistedHistory = getMessages(conversation.id);
  const text = '现在执行刚才的读取和计算，把每项金额和总额告诉我，不修改原文件。';
  const pipeline = buildLumiExecutionPipeline({
    dispatch: { userId, text, channel, source: channel, domain: 'personal', operationMode: 'assistant', targetIsLumi: true },
    registry, personalityToolPolicy, persistedConversationHistory: persistedHistory,
  });
  expect(pipeline.executionRequested).toBe(true);
  expect(pipeline.turnIntent.flow.acceptedTaskTarget?.sourceId).toBe(priorMessageId);
  expect(pipeline.authorizationPolicy.forbiddenTools).toContain('write_file');
  const context: ToolContext = {
    userId, authenticated: true, authRole: 'admin', domain: 'personal', localExecution: true, executionBoundary: 'trusted_local', source: channel,
    taskId: `task-${number}`, requestId: `execute-${number}`, conversationId: conversation.id,
    actionIntent: text, routedTaskText: pipeline.turnIntent.flow.routeText,
    acceptedTaskTarget: pipeline.turnIntent.flow.acceptedTaskTarget,
    trustedActionContinuation: pipeline.trustedActionContinuation,
    currentTurnExecutionRequested: pipeline.executionRequested,
    toolPolicy: pipeline.authorizationPolicy, modelToolProjection: pipeline.modelToolProjection,
  };
  const messages = [...persistedHistory.map(item => ({ role: item.role as 'user', content: item.message })), { role: 'user' as const, content: text }];
  return { registry, context, messages, pipeline, text, filePath, otherPath, csv };
}

async function run(value: Awaited<ReturnType<typeof fixture>>, onToolCall?: (record: ToolExecutionRecord) => void) {
  return runWithTools(value.messages, value.registry,
    { provider: 'relay', model: LUMI_OFFICIAL_DEFAULT_MODELS.reasoning, requestId: value.context.requestId },
    onToolCall, 5, ...noClient, undefined, value.context);
}

describe('persisted plan target through the complete shared tool loop', () => {
  it.each([
    { channel: 'chat' as const, quantity: 2, expected: 40 },
    { channel: 'voice' as const, quantity: 3, expected: 60 },
  ])('reads the real file and returns $expected through $channel after an unrelated read is rejected', async ({ channel, quantity, expected }) => {
    const value = await fixture(channel, quantity);
    model.call.mockResolvedValueOnce({ text: '', toolCalls: [
      { id: 'wrong-input', name: 'read_file', arguments: { path: value.otherPath } },
      { id: 'right-input', name: 'read_file', arguments: { path: value.filePath } },
    ] }).mockImplementationOnce(async (messages: Array<{ role: string; name?: string; content: unknown }>) => {
      const actualRead = [...messages].reverse().find(item => item.role === 'tool' && item.name === 'read_file');
      expect(String(actualRead?.content)).toContain(value.csv.trim());
      const returnedCsv = String(actualRead?.content).match(/item,quantity,price\r?\n(?:[AB],\d+,\d+\r?\n?){2}/)?.[0];
      expect(returnedCsv).toBeTruthy();
      const amounts = returnedCsv!.trim().split(/\r?\n/).slice(1).map(row => { const [item, quantity, price] = row.split(','); return { item, amount: Number(quantity) * Number(price) }; });
      return { text: `${amounts.map(item => `${item.item}金额${item.amount}`).join('，')}，总额${amounts.reduce((sum, item) => sum + item.amount, 0)}。`, toolCalls: [] };
    });
    const result = await run(value);
    expect(result.toolCalls).toHaveLength(2);
    expect(result.toolCalls[0].error).toMatch(/target|目标|anchored/i);
    expect(result.toolCalls[0].adapterStarted).not.toBe(true);
    expect(result.toolCalls[1].error).toBeUndefined();
    expect(result.toolCalls[1].terminalVerification?.status).toBe('verified');
    expect(result.toolCalls[1].result).toContain(value.csv.trim());
    expect(result.text).toContain(`总额${expected}`);
    expect(result.completionGuard?.blocked).not.toBe(true);
    // A previous failed auxiliary read must not reopen recovery after the
    // accepted input has been read and the model returned its calculation.
    expect(model.call).toHaveBeenCalledTimes(2);
    expect(fs.readFileSync(value.filePath, 'utf8')).toBe(value.csv);
    const final = await finalizeLumiResponse({ taskText: value.text, responseText: result.text, toolRecords: result.toolCalls, source: channel, taskId: value.context.taskId, requestId: value.context.requestId, flow: value.pipeline.turnIntent.flow });
    expect(final.blocked).toBe(false);
    expect(final.text).toContain(`总额${expected}`);
  });

  it('still stops on cancellation after the actual accepted read', async () => {
    const value = await fixture('chat');
    let cancelled = false;
    value.context.isCancelled = () => cancelled;
    model.call.mockResolvedValueOnce({ text: '', toolCalls: [{ id: 'read', name: 'read_file', arguments: { path: value.filePath } }] });
    const result = await run(value, record => { if (!record.error) cancelled = true; });
    expect(result.toolCalls[0].terminalVerification?.status).toBe('verified');
    expect(result.text).toMatch(/cancelled/i);
    expect(model.call).toHaveBeenCalledTimes(1);
  });
});
