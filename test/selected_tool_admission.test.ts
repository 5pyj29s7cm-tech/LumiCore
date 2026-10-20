import './helpers';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { initDatabase, querySQL, readDB } from '../db_layer';
import * as dbLayer from '../db_layer';
import { captureRequestAuthorization } from '../server/conversation/lifecycle';
import { getMessages, getOrCreateActiveConversation } from '../server/conversation/manager';
import { runLumiEntryTurn, type ExecutedLumiTurn, type LumiEntryTurnInput } from '../server/cognition/turn_execution';
import { ToolRegistry } from '../server/tools/registry';
import * as loopSetup from '../server/llm/tool_loop/loop_setup';
import { registerClientDiagnosticsTools } from '../server/tools/definitions/client_diagnostics_tools';
import { registerFileOpsTools } from '../server/tools/definitions/file_ops';
import { isCanonicalToolExecutionRecord } from '../server/tools/execution_engine';
import { createTurnConfirmation } from '../server/tools/turn_confirmation';
import { getPendingConfirmation, type PendingToolConfirmation } from '../server/tools/pending_confirmation';
import { ensurePendingConfirmationPersistenceInitialized } from '../server/tools/pending_confirmation_repository';
import type { NormalizedLLMResponse, ParsedToolCall, ToolContext } from '../server/tools/types';
import { shouldAllowLocalFileWriteForTurn } from '../server/socket/chat/attachments';
import { registerSleepTools } from '../server/tools/definitions/sleep_tools';
import { getSleepCycleState } from '../server/memory/dream';
import { getConversationActionTurn } from '../server/conversation/action_turn_ledger';
import { releaseManagerActionTurnLease } from '../server/conversation/action_execution_runtime';
import type { ToolPolicy } from '../server/personality/types';

const provider = vi.hoisted(() => vi.fn());
// Only replace the normalized provider boundary. The entry owner, model/tool
// loop, registry, file handler, canonical records and persistence stay real.
vi.mock('../server/llm/providers', async original => ({
  ...await original<typeof import('../server/llm/providers')>(),
  makeLLMCall: (...args: any[]) => provider(...args),
  makeLLMCallStreaming: (...args: any[]) => provider(...args),
}));

beforeAll(async () => {
  await initDatabase();
  await ensurePendingConfirmationPersistenceInitialized();
});
beforeEach(() => {
  provider.mockReset();
  vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('SELECTED_TOOL_FIXTURE_NETWORK_FORBIDDEN'));
});
afterEach(() => vi.restoreAllMocks());

function scriptProvider(call?: ParsedToolCall, finalText = 'I have no verified action to report.'): void {
  let first = true;
  provider.mockImplementation(async (): Promise<NormalizedLLMResponse> => {
    if (first && call) {
      first = false;
      return { text: '', toolCalls: [call], finishReason: 'tool_calls' };
    }
    first = false;
    return { text: finalText, toolCalls: [], finishReason: 'stop' };
  });
}

function fixture(
  instruction: string | ((filePath: string) => string),
  options: { policy?: Partial<ToolPolicy>; context?: Partial<ToolContext> } = {},
) {
  const userId = 'selected-tool-' + randomUUID();
  const requestId = randomUUID();
  const conversationId = getOrCreateActiveConversation(userId, 'lumi', 'personal', '').id;
  const identity = { userId, conversationId, requestId, agentId: 'lumi', domain: 'personal' as const, orgId: '' };
  const filePath = path.join(String(process.env.LUMI_DATA_DIR), 'selected-document-' + requestId + '.txt');
  const original = 'ISOLATED DOCUMENT\nMember: Fictional Ada\nMember: Fictional Bo\nSOURCE_TAIL_48291';
  fs.writeFileSync(filePath, original);
  const text = typeof instruction === 'function' ? instruction(filePath) : instruction;
  const registry = new ToolRegistry();
  registerFileOpsTools(registry);
  const read = registry.get('read_file')!;
  const write = registry.get('write_file')!;
  const readHandler = vi.fn(read.handler);
  const writeHandler = vi.fn(write.handler);
  read.handler = readHandler;
  write.handler = writeHandler;
  // A provider can label an unclassified effect safe. That declaration must
  // never manufacture the user's exact one-time approval.
  const unknownHandler = vi.fn(async () => JSON.stringify({ ok: true, status: 'completed' }));
  registry.register({
    name: 'fixture_document_operation',
    description: 'Unclassified document operation supplied by an isolated fixture adapter.',
    parameters: { type: 'object', properties: { target: { type: 'string' } }, required: ['target'] },
    permission: 'user', securityLevel: 'safe',
    capability: {
      id: 'fixture.document.unclassified', source: 'adapter', lane: 'general', operation: 'unknown',
      sideEffects: [{ type: 'external_state_change', scope: 'fixture-only state', reversible: false }],
    },
    handler: unknownHandler,
  });
  const pending: PendingToolConfirmation[] = [];
  const authorization = captureRequestAuthorization(() => true, 'Isolated request was revoked');
  const proposalScope = () => {
    const turn = readDB().conversationActionTurns.find((row: any) => row.requestId === requestId
      && row.userId === userId && row.conversationId === conversationId);
    return { domain: 'personal', orgId: '', channelId: conversationId, taskId: turn?.taskId || undefined };
  };
  const requestConfirmation = vi.fn(createTurnConfirmation({
    userId, requestId, source: 'chat', actionIntent: text,
    consumeScope: proposalScope, proposalScope,
    assertCurrent: authorization.assertCurrent,
    onPending: item => pending.push(item),
  }));
  const policy: ToolPolicy = {
    allowedTools: ['*'], forbiddenTools: [], requireConfirmation: [], maxIterations: 3, ...options.policy,
  };
  const input: LumiEntryTurnInput<ExecutedLumiTurn> = {
    entry: { source: 'chat', channel: 'chat', historyLimit: 10,
      failureText: 'The isolated request did not finish.', failureReason: 'selected_tool_fixture_failure' },
    identity, userText: text, authorization, controller: new AbortController(),
    planning: {
      dispatch: { ...identity, text, source: 'chat', channel: 'chat', operationMode: 'assistant', targetIsLumi: true },
      registry, personalityToolPolicy: policy, executionBoundary: 'trusted_local',
    },
    assemble: () => ({
      systemPrompt: 'Use only the current instruction and genuine tool receipts. Never claim an unperformed action.',
      model: {
        registry, config: { provider: 'deepseek', model: 'isolated-normalized-provider', userId, requestId },
        getters: {}, maxIterations: 3,
        context: { authenticated: true, authRole: 'admin', localExecution: true,
          executionBoundary: 'trusted_local', actionIntent: text, routedTaskText: text,
          requestConfirmation, ...options.context },
      },
    }),
    deliver: result => result,
  };
  return { input, identity, text, registry, filePath, original, readHandler, writeHandler, unknownHandler,
    requestConfirmation, pending, proposalScope };
}

function assertNoHandler(f: ReturnType<typeof fixture>): void {
  expect(f.readHandler).not.toHaveBeenCalled();
  expect(f.writeHandler).not.toHaveBeenCalled();
  expect(f.unknownHandler).not.toHaveBeenCalled();
  expect(fs.readFileSync(f.filePath, 'utf8')).toBe(f.original);
}

function declaredNames(): string[] {
  return (provider.mock.calls[0]?.[1] || []).map((item: any) => item.function?.name);
}

describe('actual selected-tool admission after ordinary Lumi intake', () => {
  it('keeps a plain no-tool reply free of task allocation', async () => {
    const f = fixture('Hello, how are you?');
    scriptProvider(undefined, 'I am here and ready to talk.');
    const result = await runLumiEntryTurn(f.input);
    expect(provider).toHaveBeenCalledOnce();
    expect(result.finalized.text).toBe('I am here and ready to talk.');
    expect(result.toolRecords).toEqual([]);
    expect(result.taskId).toBeUndefined();
    expect(readDB().conversationActionTasks.filter((row: any) => row.userId === f.identity.userId)).toHaveLength(0);
    assertNoHandler(f);
  });

  it('admits a selected real read for the original unfamiliar instruction under the same durable request', async () => {
    const f = fixture('Please handle the document with these members.');
    scriptProvider({ id: 'selected-document-read', name: 'read_file', arguments: { path: f.filePath } }, f.original);
    const result = await runLumiEntryTurn(f.input);
    expect(f.input.userText).toBe('Please handle the document with these members.');
    expect(declaredNames()).toContain('read_file');
    expect(f.readHandler).toHaveBeenCalledOnce();
    expect(f.writeHandler).not.toHaveBeenCalled();
    expect(f.unknownHandler).not.toHaveBeenCalled();
    const records = result.toolRecords.filter(record => record.name === 'read_file');
    expect(records).toHaveLength(1);
    const record = records[0];
    expect(isCanonicalToolExecutionRecord(record)).toBe(true);
    expect(record.envelope?.status).toBe('verified_success');
    expect(record.result).toContain(f.original);
    expect(record.requestId).toBe(f.identity.requestId);
    expect(record.taskId).toBeTruthy();
    expect(record.taskId).toBe(result.taskId);
    expect(f.readHandler.mock.calls[0][1]).toMatchObject({ ...f.identity, taskId: record.taskId });
    const task = readDB().conversationActionTasks.find((row: any) => row.id === record.taskId);
    expect(task).toMatchObject({ userId: f.identity.userId, conversationId: f.identity.conversationId,
      activeRequestId: '' });
    expect(result.finalized.blocked).toBe(true);
    const turn = readDB().conversationActionTurns.find((row: any) => row.requestId === f.identity.requestId);
    expect(turn).toMatchObject({ taskId: record.taskId, userId: f.identity.userId, conversationId: f.identity.conversationId });
    const receipts = readDB().conversationActionReceipts.filter((row: any) => row.requestId === f.identity.requestId);
    expect(receipts).toHaveLength(1);
    expect(receipts[0]).toMatchObject({ taskId: record.taskId, conversationId: f.identity.conversationId, toolName: 'read_file' });
    expect(fs.readFileSync(f.filePath, 'utf8')).toBe(f.original);
  });

  it('requires a real pending grant for an unknown effect even when its definition says safe', async () => {
    const f = fixture('Please handle the document with these members.');
    registerClientDiagnosticsTools(f.registry);
    provider.mockResolvedValueOnce({ text: '', finishReason: 'tool_calls', toolCalls: [
      { id: 'discover-unknown-effect', name: 'client_capability_manifest', arguments: { query: 'fixture_document_operation', executableOnly: true } },
    ] }).mockResolvedValueOnce({ text: '', finishReason: 'tool_calls', toolCalls: [
      { id: 'selected-unknown-effect', name: 'fixture_document_operation', arguments: { target: 'fictional-document' } },
    ] }).mockResolvedValue({ text: 'The proposed operation is awaiting exact confirmation.', finishReason: 'stop', toolCalls: [] });
    const result = await runLumiEntryTurn(f.input);
    expect(declaredNames()).toContain('client_capability_manifest');
    expect((provider.mock.calls[1]?.[1] || []).map((item: any) => item.function?.name)).toContain('fixture_document_operation');
    assertNoHandler(f);
    expect(f.requestConfirmation).toHaveBeenCalledOnce();
    expect(f.pending).toHaveLength(1);
    const pending = f.pending[0];
    expect(pending).toMatchObject({ toolName: 'fixture_document_operation', originRequestId: f.identity.requestId,
      taskId: result.taskId, exactArgs: { target: 'fictional-document' } });
    expect(pending.taskId).toBeTruthy();
    expect(getPendingConfirmation(f.identity.userId, f.proposalScope())?.id).toBe(pending.id);
    const rows = await querySQL<any>('SELECT status, taskId, originRequestId FROM pending_tool_confirmations WHERE id = ?', [pending.id]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: 'pending', taskId: result.taskId, originRequestId: f.identity.requestId });
    expect(result.toolRecords.some(record => record.envelope?.status === 'waiting_confirmation')).toBe(true);
    const paused = result.toolRecords.find(record => record.name === 'fixture_document_operation');
    expect(paused?.envelope?.status).toBe('waiting_confirmation');
    expect(paused?.adapterStarted).not.toBe(true);
    expect(paused?.envelope?.requestId).toBe(f.identity.requestId);
    expect(paused?.envelope?.taskId).toBe(result.taskId);
    expect(readDB().conversationActionTasks.find((row: any) => row.id === result.taskId)?.status).toBe('waiting_confirmation');
    expect(readDB().conversationActionTasks.find((row: any) => row.id === result.taskId)?.status).not.toBe('completed');
  });

  it('preserves an explicit whole-turn no-tool instruction against a provider tool call', async () => {
    const f = fixture('不要调用工具，只说说什么是大语言模型。');
    scriptProvider({ id: 'forbidden-by-current-turn', name: 'read_file', arguments: { path: f.filePath } }, '大语言模型根据已有训练和当前上下文生成文本。');
    await runLumiEntryTurn(f.input);
    assertNoHandler(f);
    expect(f.requestConfirmation).not.toHaveBeenCalled();
    expect(f.pending).toEqual([]);
  });

  it('preserves an explicit no-mutation instruction against a provider write call', async () => {
    const f = fixture(file => '读取 ' + file + ' 并告诉我内容，但不要修改文件。');
    scriptProvider({ id: 'forbidden-mutation', name: 'write_file', arguments: { path: f.filePath, content: 'UNAUTHORIZED CHANGE' } });
    await runLumiEntryTurn(f.input);
    assertNoHandler(f);
    expect(f.requestConfirmation).not.toHaveBeenCalled();
    expect(f.pending).toEqual([]);
  });

  it('keeps a personality deny authoritative over the provider selected name', async () => {
    const f = fixture(file => 'Read the file ' + file + ' and show its contents.', { policy: { forbiddenTools: ['read_file'] } });
    scriptProvider({ id: 'personality-denied-read', name: 'read_file', arguments: { path: f.filePath } });
    await runLumiEntryTurn(f.input);
    assertNoHandler(f);
    expect(declaredNames()).not.toContain('read_file');
    expect(f.requestConfirmation).not.toHaveBeenCalled();
  });

  it('does not let a selected user tool bypass request authentication', async () => {
    const f = fixture(file => 'Read the file ' + file + ' and show its contents.', { context: { authenticated: false, authRole: 'user' } });
    scriptProvider({ id: 'unauthenticated-read', name: 'read_file', arguments: { path: f.filePath } });
    await runLumiEntryTurn(f.input);
    assertNoHandler(f);
    expect(f.requestConfirmation).not.toHaveBeenCalled();
  });
});

// Append after the existing seven tests. Do not alter their assertions.
// Required imports are listed separately in required-imports.txt.
const MEMORY_STATUS_QUESTION = '你最近整理记忆的状态怎么样？';

function memoryStatusFixture() {
  const f = fixture(MEMORY_STATUS_QUESTION);
  registerSleepTools(f.registry);
  const status = f.registry.get('lumi_sleep_status')!;
  const cycle = f.registry.get('lumi_sleep_cycle')!;
  // Both schemas, permission/security fields and handlers come directly from
  // the production registerSleepTools definition; no invented memory manifest.
  const statusHandler = vi.fn(status.handler);
  const cycleHandler = vi.fn(cycle.handler);
  status.handler = statusHandler;
  cycle.handler = cycleHandler;
  const beforeState = getSleepCycleState(f.identity.userId, 'personal', '');
  const beforeMemories = JSON.stringify(readDB().memories.filter((row: any) => row.userId === f.identity.userId));
  return { ...f, statusHandler, cycleHandler, beforeState, beforeMemories };
}

function assertMemoryUnchanged(f: ReturnType<typeof memoryStatusFixture>) {
  assertNoHandler(f);
  expect(f.cycleHandler).not.toHaveBeenCalled();
  expect(getSleepCycleState(f.identity.userId, 'personal', '')).toEqual(f.beforeState);
  expect(JSON.stringify(readDB().memories.filter((row: any) => row.userId === f.identity.userId))).toBe(f.beforeMemories);
}

describe('the same memory-status inquiry keeps model choice separate from mutation authority', () => {
  it('does not allocate a task when the memory inquiry receives an ordinary no-tool reply', async () => {
    const f = memoryStatusFixture();
    scriptProvider(undefined, '当前上下文没有提供最近一次记忆整理的记录。');
    const result = await runLumiEntryTurn(f.input);
    expect(f.input.userText).toBe(MEMORY_STATUS_QUESTION);
    expect(provider).toHaveBeenCalledOnce();
    expect(result.taskId).toBeUndefined();
    expect(result.toolRecords).toEqual([]);
    expect(readDB().conversationActionTasks.filter((row: any) => row.userId === f.identity.userId)).toHaveLength(0);
    expect(f.statusHandler).not.toHaveBeenCalled();
    assertMemoryUnchanged(f);
  });

  it('lets the provider select the genuine memory-status observation for the same inquiry', async () => {
    const f = memoryStatusFixture();
    scriptProvider({ id: 'selected-memory-status', name: 'lumi_sleep_status', arguments: {} }, '当前记忆整理状态为 awake，已记录的整理次数为 0。');
    const result = await runLumiEntryTurn(f.input);
    expect(f.input.userText).toBe(MEMORY_STATUS_QUESTION);
    expect(declaredNames()).toContain('lumi_sleep_status');
    expect(declaredNames()).toContain('lumi_sleep_cycle');
    expect(f.statusHandler).toHaveBeenCalledOnce();
    const records = result.toolRecords.filter(record => record.name === 'lumi_sleep_status');
    expect(records).toHaveLength(1);
    expect(isCanonicalToolExecutionRecord(records[0])).toBe(true);
    expect(records[0].requestId).toBe(f.identity.requestId);
    expect(records[0].envelope?.status).toBe('verified_success');
    expect(records[0].capability?.operation).toBe('observe');
    expect(records[0].capability?.sideEffects).toEqual([]);
    expect(JSON.parse(records[0].result)).toMatchObject({ userId: f.identity.userId, status: 'awake', dreamCount: 0 });
    assertMemoryUnchanged(f);
  });

  it('refuses a provider-selected memory mutation for that unchanged status inquiry', async () => {
    const f = memoryStatusFixture();
    scriptProvider({ id: 'not-authorized-memory-cycle', name: 'lumi_sleep_cycle', arguments: { force: true } });
    await runLumiEntryTurn(f.input);
    expect(f.input.userText).toBe(MEMORY_STATUS_QUESTION);
    expect(declaredNames()).toContain('lumi_sleep_cycle');
    expect(f.statusHandler).not.toHaveBeenCalled();
    expect(f.pending).toHaveLength(1);
    expect(f.pending[0]).toMatchObject({ toolName: 'lumi_sleep_cycle', exactArgs: { force: true }, originRequestId: f.identity.requestId });
    assertMemoryUnchanged(f);
  });
});

describe('selected calls cannot revive a cancelled or unowned accepted turn', () => {
  it('does not allocate a task after the real controller aborts before provider tool_calls return', async () => {
    const f = fixture('Please handle the document with these members.');
    provider.mockImplementationOnce(async (): Promise<NormalizedLLMResponse> => {
      expect(readDB().conversationActionTasks.filter((row: any) => row.userId === f.identity.userId)).toHaveLength(0);
      f.input.controller.abort(new DOMException('Fixture cancelled before selected calls returned', 'AbortError'));
      return { text: '', finishReason: 'tool_calls', toolCalls: [
        { id: 'cancelled-selected-read', name: 'read_file', arguments: { path: f.filePath } },
      ] };
    });
    await expect(runLumiEntryTurn(f.input)).rejects.toMatchObject({ name: 'AbortError' });
    expect(provider).toHaveBeenCalledOnce();
    expect(f.input.controller.signal.aborted).toBe(true);
    expect(readDB().conversationActionTasks.filter((row: any) => row.userId === f.identity.userId)).toHaveLength(0);
    expect(readDB().conversationActionReceipts.filter((row: any) => row.requestId === f.identity.requestId)).toHaveLength(0);
    assertNoHandler(f);
  });

  it('does not recreate an audit task after the actual accepted-turn lease is released in the provider', async () => {
    const f = fixture('Please handle the document with these members.');
    let released = false;
    provider.mockImplementationOnce(async (): Promise<NormalizedLLMResponse> => {
      const before = getConversationActionTurn(f.identity);
      expect(before).toMatchObject({ status: 'leased', requestId: f.identity.requestId });
      expect(before?.taskId || '').toBe('');
      releaseManagerActionTurnLease({ ...f.identity, reason: 'Isolated owner was withdrawn before selected calls returned' });
      const after = getConversationActionTurn(f.identity);
      expect(after).toMatchObject({ status: 'accepted', requestId: f.identity.requestId });
      expect(after?.leaseOwnerId || '').toBe('');
      // This is lease invalidation rather than a duplicate of the abort test.
      expect(f.input.controller.signal.aborted).toBe(false);
      released = true;
      return { text: '', finishReason: 'tool_calls', toolCalls: [
        { id: 'unowned-selected-read', name: 'read_file', arguments: { path: f.filePath } },
      ] };
    });
    provider.mockResolvedValue({ text: 'The original accepted owner is unavailable.', toolCalls: [], finishReason: 'stop' });
    const outcome = await runLumiEntryTurn(f.input).then(
      value => ({ kind: 'result' as const, value }),
      error => ({ kind: 'error' as const, error }),
    );
    expect(released).toBe(true);
    assertNoHandler(f);
    expect(readDB().conversationActionTasks.filter((row: any) => row.userId === f.identity.userId)).toHaveLength(0);
    expect(getConversationActionTurn(f.identity)?.taskId || '').toBe('');
    if (outcome.kind === 'result') {
      expect(outcome.value.taskId).toBeUndefined();
      expect(outcome.value.toolRecords).toHaveLength(1);
      expect(outcome.value.toolRecords[0].requestId).toBe(f.identity.requestId);
      expect(outcome.value.toolRecords[0].error).toContain('could not bind its audit task');
      expect(outcome.value.toolRecords[0].terminalVerification?.status).toBe('failed');
      expect(outcome.value.toolRecords[0].envelope?.status).not.toBe('verified_success');
      expect(outcome.value.toolRecords.every(record => record.adapterStarted !== true)).toBe(true);
      expect(outcome.value.finalized.text).toBe('The original accepted owner is unavailable.');
    } else {
      expect(outcome.error).toBeInstanceOf(Error);
    }
  });
});

// Keep this original two-obligation negative separate from selected-call
// admission closure. A green read receipt does not prove a signature happened.
// Do not make it pass by changing the provider prose or adding goal JSON.
describe('whole original request remains authoritative after a verified read', () => {
  it('keeps the original read-plus-sign request blocked when only the source text was returned', async () => {
    const f = fixture(file => 'Read the file ' + file + ' and show its complete contents. Then sign the contract.');
    const originalRequest = 'Read the file ' + f.filePath + ' and show its complete contents. Then sign the contract.';
    scriptProvider({ id: 'read-before-unperformed-signature', name: 'read_file', arguments: { path: f.filePath } }, f.original);
    const result = await runLumiEntryTurn(f.input);
    expect(f.input.userText).toBe(originalRequest);
    const user = getMessages(f.identity.conversationId, 10).find(row => row.role === 'user' && row.requestId === f.identity.requestId);
    expect(user?.message).toBe(originalRequest);
    expect(f.readHandler).toHaveBeenCalledOnce();
    expect(f.writeHandler).not.toHaveBeenCalled();
    expect(f.unknownHandler).not.toHaveBeenCalled();
    const read = result.toolRecords.find(record => record.name === 'read_file');
    expect(read).toBeDefined();
    expect(isCanonicalToolExecutionRecord(read!)).toBe(true);
    expect(read!.envelope?.status).toBe('verified_success');
    expect(read!.result).toContain(f.original);
    expect(result.finalized.text).toContain(f.original);
    expect(result.finalized.blocked).toBe(true);
    expect(readDB().conversationActionTasks.find((row: any) => row.id === result.taskId)?.status).toBe('blocked');
    expect(fs.readFileSync(f.filePath, 'utf8')).toBe(f.original);
  });
});


describe('a current source and a plain continuation keep their existing owners', () => {
  it('returns the requested full source after the unfamiliar instruction names its actual file', async () => {
    const f = fixture(file => 'Please handle the document with these members. The document is ' + file + '. Show its complete contents.');
    const prepareLoop = vi.spyOn(loopSetup, 'prepareToolLoop');
    let modelCalls = 0;
    provider.mockImplementation(async (): Promise<NormalizedLLMResponse> => {
      const state = prepareLoop.mock.results[0]?.value.state;
      expect(state).toBeTruthy();
      if (modelCalls++ === 0) {
        expect(state?.context?.taskId).toBeUndefined();
        expect(state?.context?.currentTurnExecutionRequested).toBeUndefined();
        expect(state?.toolExecutionContext?.taskId).toBeUndefined();
        return { text: '', finishReason: 'tool_calls', toolCalls: [{ id: 'current-source-bound-read', name: 'read_file', arguments: { path: f.filePath } }] };
      }
      expect(state?.context?.taskId).toBeTruthy();
      expect(state?.context?.currentTurnExecutionRequested).toBe(true);
      expect(state?.toolExecutionContext?.taskId).toBe(state?.context?.taskId);
      expect(state?.toolExecutionContext?.currentTurnExecutionRequested).toBe(true);
      return { text: f.original, finishReason: 'stop', toolCalls: [] };
    });
    const result = await runLumiEntryTurn(f.input);
    expect(declaredNames()).toContain('read_file');
    expect(f.readHandler).toHaveBeenCalledOnce();
    expect(f.writeHandler).not.toHaveBeenCalled();
    expect(result.toolRecords.find(record => record.name === 'read_file')?.envelope?.status).toBe('verified_success');
    expect(result.finalized.text).toContain(f.original);
    expect(result.finalized.blocked).toBe(false);
    expect(result.taskId).toBeTruthy();
    expect(readDB().conversationActionTasks.find((row: any) => row.id === result.taskId)?.status).toBe('completed');
    expect(fs.readFileSync(f.filePath, 'utf8')).toBe(f.original);
  });
  it('answers 继续回答 without allocating a tool task or classifying the user again', async () => {
    const f = fixture('继续回答。');
    const answer = '我接着说明：这段对话可以直接继续。';
    scriptProvider(undefined, answer);
    const result = await runLumiEntryTurn(f.input);
    expect(provider).toHaveBeenCalledOnce();
    expect(result.finalized.text).toBe(answer);
    expect(result.finalized.blocked).toBe(false);
    expect(result.taskId).toBeUndefined();
    expect(result.toolRecords).toEqual([]);
    expect(readDB().conversationActionTasks.filter((row: any) => row.userId === f.identity.userId)).toHaveLength(0);
    assertNoHandler(f);
  });
});

// Append independently after the existing suite; do not modify its assertions.
// required-imports2.txt lists the only additional import.
async function assertQuestionSelectedWriteNeedsExactGrant(instruction: string, callId: string) {
  const f = fixture(instruction);
  // This is the same production calculation used by prepareChatRequest.
  // Neither a true/false write flag nor an accepted contract is hand-injected.
  const allowLocalFileWrites = shouldAllowLocalFileWriteForTurn(instruction, []);
  const requestConfirmation = vi.fn(createTurnConfirmation({
    userId: f.identity.userId, requestId: f.identity.requestId, source: 'chat',
    actionIntent: instruction, allowLocalFileWrites,
    consumeScope: f.proposalScope, proposalScope: f.proposalScope,
    assertCurrent: f.input.authorization.assertCurrent,
    onPending: pending => f.pending.push(pending),
  }));
  let acceptedContractKind: string | undefined;
  const originalAssemble = f.input.assemble;
  f.input.assemble = async execution => {
    const assembled = await originalAssemble(execution);
    if ('terminal' in assembled || !('registry' in assembled.model)) {
      throw new Error('This boundary fixture requires the genuine tool session');
    }
    acceptedContractKind = execution.turnIntent.flow.acceptedActionContract?.contract.kind;
    return { ...assembled, model: { ...assembled.model,
      context: { ...assembled.model.context, allowLocalFileWrites, requestConfirmation },
    } };
  };
  const args = { path: f.filePath, content: 'UNAPPROVED_QUESTION_REPORT_CONTENT' };
  scriptProvider({ id: callId, name: 'write_file', arguments: args });
  const result = await runLumiEntryTurn(f.input);
  expect(f.input.userText).toBe(instruction);
  expect(acceptedContractKind).toBe('none');
  expect(declaredNames()).toContain('write_file');
  assertNoHandler(f);
  expect(requestConfirmation).toHaveBeenCalledOnce();
  const call = requestConfirmation.mock.calls[0];
  expect(call[0]).toBe('write_file');
  expect(call[1]).toEqual(args);
  expect(call[3]?.acceptedActionContract?.contract.kind).toBe('none');
  expect(f.pending).toHaveLength(1);
  const pending = f.pending[0];
  expect(pending).toMatchObject({ toolName: 'write_file', originRequestId: f.identity.requestId,
    taskId: result.taskId, exactArgs: args, actionIntent: instruction });
  expect(pending.taskId).toBeTruthy();
  expect(getPendingConfirmation(f.identity.userId, f.proposalScope())?.id).toBe(pending.id);
  const persisted = await querySQL<any>(
    'SELECT status, taskId, originRequestId FROM pending_tool_confirmations WHERE id = ?', [pending.id]);
  expect(persisted).toHaveLength(1);
  expect(persisted[0]).toMatchObject({ status: 'pending', taskId: result.taskId, originRequestId: f.identity.requestId });
  expect(result.toolRecords.some(record => record.name === 'write_file'
    && record.envelope?.status === 'waiting_confirmation')).toBe(true);
  expect(result.finalized.blocked).toBe(true);
  expect(readDB().conversationActionTasks.find((row: any) => row.id === result.taskId)?.status).not.toBe('completed');
  expect(fs.readFileSync(f.filePath, 'utf8')).toBe(f.original);
}

describe('a computed local-write hint cannot authorize a question-selected mutation', () => {
  it('keeps Can Lumi make a report file? at the exact write confirmation boundary', async () => {
    await assertQuestionSelectedWriteNeedsExactGrant('Can Lumi make a report file?', 'capability-question-write');
  });

  it('keeps the original historical incomplete-report question at the exact write confirmation boundary', async () => {
    await assertQuestionSelectedWriteNeedsExactGrant('为什么之前导出的报告内容不全？', 'historical-question-write');
  });
});

// Append to the current selected_tool_admission.test.ts; existing assertions stay intact.
describe('a real old report capsule is evidence, not authority to resume writing', () => {
  it.each([false, true])('does not resume the unfinished report when the unchanged current turn asks why it failed (selected=%s)', async selected => {
    // Create the prior task through the same real entry/model/tool/manager path.
    // The actual writer remains behind its explicit confirmation boundary.
    const f = fixture(file => 'Create a report file at "' + file
      + '" containing "FICTIONAL_PENDING_REPORT". Wait until my confirmation before writing.');
    scriptProvider({ id: 'prior-report-awaiting-grant', name: 'write_file',
      arguments: { path: f.filePath, content: 'FICTIONAL_PENDING_REPORT' } });
    const prior = await runLumiEntryTurn(f.input);
    expect(prior.taskId).toBeTruthy();
    expect(f.pending).toHaveLength(1);
    expect(f.pending[0].taskId).toBe(prior.taskId);
    assertNoHandler(f);
    const oldTask = readDB().conversationActionTasks.find((row: any) => row.id === prior.taskId)!;
    const oldState = JSON.parse(oldTask.context).actionState;
    const oldCapsule = oldState.taskCapsule;
    expect(oldTask.status).not.toBe('completed');
    expect(oldState.unfinished).toBe(true);
    expect(oldCapsule).toMatchObject({ taskId: prior.taskId, unfinished: true });
    expect(oldCapsule.goal).toBe(f.text);
    expect(path.normalize(oldCapsule.target.path)).toBe(path.normalize(f.filePath));

    const question = '上次创建报告为什么没完成';
    const identity = { ...f.identity, requestId: randomUUID() };
    const authorization = captureRequestAuthorization(() => true, 'Status inquiry was revoked');
    const scope = () => {
      const turn = readDB().conversationActionTurns.find((row: any) => row.userId === identity.userId
        && row.conversationId === identity.conversationId && row.requestId === identity.requestId);
      return { domain: 'personal', orgId: '', channelId: identity.conversationId, taskId: turn?.taskId || undefined };
    };
    const allowLocalFileWrites = shouldAllowLocalFileWriteForTurn(question, []);
    const requestConfirmation = vi.fn(createTurnConfirmation({
      userId: identity.userId, requestId: identity.requestId, source: 'chat', actionIntent: question,
      allowLocalFileWrites, consumeScope: scope, proposalScope: scope,
      assertCurrent: authorization.assertCurrent, onPending: () => {},
    }));
    let diagnostic: Record<string, unknown> | undefined;
    const input: LumiEntryTurnInput<ExecutedLumiTurn> = {
      entry: { ...f.input.entry }, identity, userText: question, authorization, controller: new AbortController(),
      planning: {
        dispatch: { ...identity, text: question, source: 'chat', channel: 'chat', operationMode: 'assistant', targetIsLumi: true },
        registry: f.registry, executionBoundary: 'trusted_local',
        personalityToolPolicy: { allowedTools: ['*'], forbiddenTools: [], requireConfirmation: [], maxIterations: 3 },
      },
      assemble: execution => {
        diagnostic = {
          question, oldTaskId: prior.taskId, acceptedActionContract: execution.turnIntent.flow.acceptedActionContract,
          taskRelation: execution.taskRelation, routeText: execution.turnIntent.flow.routeText,
          trustedActionContinuation: execution.trustedActionContinuation, plannedTaskId: execution.taskId,
          modelToolProjection: execution.modelToolProjection, allowLocalFileWrites,
        };
        return { systemPrompt: 'Answer the current question from genuine evidence. A prior pending write is not a new grant.',
          model: { registry: f.registry,
            config: { provider: 'deepseek', model: 'isolated-normalized-provider', userId: identity.userId, requestId: identity.requestId },
            getters: {}, maxIterations: 3,
            context: { authenticated: true, authRole: 'admin', localExecution: true, executionBoundary: 'trusted_local',
              actionIntent: question, routedTaskText: question, allowLocalFileWrites, requestConfirmation },
          } };
      },
      deliver: result => result,
    };
    provider.mockReset();
    scriptProvider(selected ? { id: 'status-question-is-not-report-resume', name: 'write_file',
      arguments: { path: f.filePath, content: 'UNAUTHORIZED_STATUS_RESUME' } } : undefined, '上次报告仍在等待写入确认，当前没有继续写入。');
    const result = await runLumiEntryTurn(input);
    expect(diagnostic?.acceptedActionContract).toMatchObject({ taskText: question, contract: { kind: 'none' } });
    expect(diagnostic?.trustedActionContinuation).toBe(false);
    expect(diagnostic?.plannedTaskId).toBeUndefined();
    expect(input.userText).toBe('上次创建报告为什么没完成');
    expect(declaredNames()).toContain('read_file');
    assertNoHandler(f);
    expect(result.taskId).not.toBe(prior.taskId);
    if (!selected) expect(result.taskId).toBeUndefined();
    const currentTurn = readDB().conversationActionTurns.find((row: any) => row.requestId === identity.requestId);
    expect(currentTurn?.taskId || '').not.toBe(prior.taskId);
    expect(readDB().conversationActionReceipts.filter((row: any) => row.requestId === identity.requestId
      && row.taskId === prior.taskId)).toHaveLength(0);
    const preserved = readDB().conversationActionTasks.find((row: any) => row.id === prior.taskId)!;
    expect(preserved.activeRequestId).toBe('');
    expect(preserved.goal).toBe(f.text);
    expect(preserved.status).not.toBe('completed');
    const preservedCapsule = JSON.parse(preserved.context).actionState.taskCapsule;
    expect(preservedCapsule.goal).toBe(oldCapsule.goal);
    expect(preservedCapsule.target).toEqual(oldCapsule.target);
    expect(fs.readFileSync(f.filePath, 'utf8')).toBe(f.original);
  });
});


describe('selected admission waits for its manager-owned durable acknowledgement', () => {
  it.each([false, true])('starts no adapter before the scoped durable acknowledgement (failure=%s)', async failAcknowledgement => {
    const f = fixture(file => 'Read the file ' + file + ' and show its complete contents.');
    const originalAssemble = f.input.assemble;
    let execution: Parameters<typeof originalAssemble>[0] | undefined;
    f.input.assemble = accepted => { execution = accepted; return originalAssemble(accepted); };
    const originalFlush = dbLayer.flushDBOrThrow;
    let selectedAcknowledgements = 0;
    let acknowledged = false;
    let injectedFailure = false;
    const originalRead = f.readHandler.getMockImplementation()!;
    f.readHandler.mockImplementation(async (...args) => {
      expect(acknowledged).toBe(true);
      return originalRead(...args);
    });
    vi.spyOn(dbLayer, 'flushDBOrThrow').mockImplementation(async () => {
      const turn = readDB().conversationActionTurns.find(row => row.requestId === f.identity.requestId
        && row.userId === f.identity.userId && row.conversationId === f.identity.conversationId);
      if (turn?.taskId && !acknowledged && !injectedFailure) {
        selectedAcknowledgements++;
        expect(f.readHandler).not.toHaveBeenCalled();
        expect(execution?.taskId).toBeUndefined();
        if (failAcknowledgement) {
          injectedFailure = true;
          throw new Error('ISOLATED_SELECTED_AUDIT_ACK_FAILED');
        }
        await originalFlush();
        acknowledged = true;
        return;
      }
      await originalFlush();
    });
    scriptProvider({ id: 'durable-selected-read', name: 'read_file', arguments: { path: f.filePath } },
      failAcknowledgement ? 'The audit acknowledgement failed; the file tool did not run.' : f.original);
    const result = await runLumiEntryTurn(f.input);
    expect(selectedAcknowledgements).toBe(1);
    expect(fs.readFileSync(f.filePath, 'utf8')).toBe(f.original);
    expect(f.writeHandler).not.toHaveBeenCalled();
    expect(f.unknownHandler).not.toHaveBeenCalled();
    const record = result.toolRecords.find(row => row.name === 'read_file');
    expect(record).toBeDefined();
    expect(record!.requestId).toBe(f.identity.requestId);
    if (failAcknowledgement) {
      expect(injectedFailure).toBe(true);
      expect(acknowledged).toBe(false);
      expect(execution?.taskId).toBeUndefined();
      expect(result.taskId).toBeUndefined();
      expect(f.readHandler).not.toHaveBeenCalled();
      expect(record!.error).toContain('ISOLATED_SELECTED_AUDIT_ACK_FAILED');
      expect(record!.adapterStarted).not.toBe(true);
      expect(record!.envelope?.status).not.toBe('verified_success');
      expect(readDB().conversationActionTasks.filter(row => row.userId === f.identity.userId)
        .every(row => row.status !== 'completed')).toBe(true);
    } else {
      expect(acknowledged).toBe(true);
      expect(f.readHandler).toHaveBeenCalledOnce();
      expect(isCanonicalToolExecutionRecord(record!)).toBe(true);
      expect(record!.envelope?.status).toBe('verified_success');
      expect(record!.taskId).toBe(result.taskId);
      expect(result.taskId).toBeTruthy();
      expect(result.finalized.text).toContain(f.original);
      const turn = readDB().conversationActionTurns.find(row => row.requestId === f.identity.requestId);
      expect(turn?.taskId).toBe(result.taskId);
      expect(readDB().conversationActionReceipts.some(row => row.requestId === f.identity.requestId
        && row.taskId === result.taskId)).toBe(true);
    }
  });
});
