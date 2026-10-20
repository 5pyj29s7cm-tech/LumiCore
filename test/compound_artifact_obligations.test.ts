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
    allowedTools: ['*'], forbiddenTools: [], requireConfirmation: [], maxIterations: 6, ...options.policy,
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
        getters: {}, maxIterations: 6,
        context: { authenticated: true, authRole: 'admin', localExecution: true,
          executionBoundary: 'trusted_local', actionIntent: text, routedTaskText: text,
          allowLocalFileWrites: shouldAllowLocalFileWriteForTurn(text, []), requestConfirmation, ...options.context },
      },
    }),
    deliver: result => result,
  };
  return { input, identity, text, registry, filePath, original, readHandler, writeHandler, unknownHandler,
    requestConfirmation, pending, proposalScope };
}


import { requestedArtifactInstructions } from '../server/cognition/artifact_progress';
import { buildActionEvidenceContract, getArtifactTaskProgress } from '../server/cognition/action_contract';
import { finalizeLumiResponse } from '../server/cognition/result_finalizer';
import { collectChatArtifacts } from '../server/conversation/chat_artifacts';
function twoFiles(exact = true, payload = 'ALPHA_ONLY') {
  let alpha = '', beta = '';
  const f = fixture(source => {
    alpha = source.replace('.txt', '-alpha.txt'); beta = source.replace('.txt', '-beta.txt');
    return 'Create ' + alpha + (exact ? '. Exactly write “' + payload + '”.' : ' with the exact text “ALPHA_ONLY”.') + (exact ? ' Then read it back in full. Then create ' : ' Read it back in full. Then create ') + beta + (exact ? '. Exactly write “BETA_ONLY”.' : ' with the exact text “BETA_ONLY”.') + (exact ? ' Then read it back in full.' : ' Read it back in full.') + ' Show both complete contents. Do not send anything outside the local machine.';
  });
  return { ...f, alpha, beta };
}
function actions(f: ReturnType<typeof twoFiles>, includeBeta: boolean, contentA = 'ALPHA_ONLY', contentB = 'BETA_ONLY') {
  const writes: ParsedToolCall[] = [{ id: 'alpha-write', name: 'write_file', arguments: { path: f.alpha, content: contentA } }];
  const reads: ParsedToolCall[] = [{ id: 'alpha-read', name: 'read_file', arguments: { path: f.alpha } }];
  if (includeBeta) {
    writes.push({ id: 'beta-write', name: 'write_file', arguments: { path: f.beta, content: contentB } });
    reads.push({ id: 'beta-read', name: 'read_file', arguments: { path: f.beta } });
  }
  const frames: NormalizedLLMResponse[] = [
    { text: '', toolCalls: writes, finishReason: 'tool_calls' },
    { text: '', toolCalls: reads, finishReason: 'tool_calls' },
    { text: 'Both files were created and completely read back. ' + contentA + '\n' + contentB, toolCalls: [], finishReason: 'stop' },
  ];
  let frame = 0;
  provider.mockImplementation(async () => frames[Math.min(frame++, frames.length - 1)]);
}
async function proof(f: ReturnType<typeof twoFiles>, result: ExecutedLumiTurn) {
  const turns = await querySQL<Record<string, unknown>>('SELECT * FROM conversation_action_turns WHERE conversationId=? AND requestId=?', [f.identity.conversationId, f.identity.requestId]);
  const receipts = await querySQL<Record<string, unknown>>('SELECT * FROM conversation_action_receipts WHERE conversationId=? AND requestId=?', [f.identity.conversationId, f.identity.requestId]);
  const tasks = await querySQL<Record<string, unknown>>('SELECT * FROM conversation_action_tasks WHERE id=?', [result.taskId]);
  if (process.env.LUMI_COMPOUND_OBSERVATIONS) fs.appendFileSync(process.env.LUMI_COMPOUND_OBSERVATIONS, JSON.stringify({ prompt:f.text, alphaExists:fs.existsSync(f.alpha), betaExists:fs.existsSync(f.beta), result, contract:buildActionEvidenceContract(f.text), checkpoints:buildActionEvidenceContract(f.text).components?.map(component=>({text:component.text,contract:component.contract,progress:getArtifactTaskProgress(component.text,result.toolRecords,{requestId:f.identity.requestId,taskId:result.taskId})})), canonical:result.toolRecords.map(record=>({name:record.name,canonical:isCanonicalToolExecutionRecord(record)})), turns, receipts, tasks }) + '\n');
  expect(turns).toHaveLength(1); expect(turns[0]).toMatchObject({ taskId: result.taskId, userId:f.identity.userId, conversationId:f.identity.conversationId, requestId:f.identity.requestId, domain:'personal', orgId:'' });
  expect(result.toolRecords.every(record => record.taskId === result.taskId && record.requestId === f.identity.requestId )).toBe(true);
  expect(result.toolRecords.filter(record=>record.name==='write_file').every(isCanonicalToolExecutionRecord)).toBe(true);
  expect(receipts).toHaveLength(result.toolRecords.length);
  expect(receipts.every(row => row.taskId === result.taskId && row.requestId === f.identity.requestId && row.outcome === 'verified_success')).toBe(true);
  return tasks[0];
}
describe('every explicitly requested local artifact requires its own current receipts', () => {
  it('does not complete two requested files after only writing and reading alpha', async () => {
    const f = twoFiles(false); actions(f, false);
    const result = await runLumiEntryTurn(f.input);
    expect(f.writeHandler).toHaveBeenCalledOnce();
    expect(fs.readFileSync(f.alpha, 'utf8')).toBe('ALPHA_ONLY'); expect(fs.existsSync(f.beta)).toBe(false);
    expect(result.toolRecords.map(r => r.name)).toEqual(['write_file', 'read_file']);
    const task = await proof(f, result);
    expect(result.finalized.blocked).toBe(true);
    expect(task.status).not.toBe('completed');
    const artifacts = collectChatArtifacts(result.toolRecords, f.identity.conversationId);
    expect(artifacts.map(x => x.fileName)).toContain(path.basename(f.alpha));
    expect(artifacts.map(x => x.fileName)).not.toContain(path.basename(f.beta));
  });
  it('completes both files only with their own exact text and write-then-read receipts', async () => {
    const f = twoFiles(); actions(f, true);
    const result = await runLumiEntryTurn(f.input);
    expect(f.writeHandler).toHaveBeenCalledTimes(2);
    expect(fs.readFileSync(f.alpha, 'utf8')).toBe('ALPHA_ONLY'); expect(fs.readFileSync(f.beta, 'utf8')).toBe('BETA_ONLY');
    const task = await proof(f, result);
    expect(result.toolRecords.filter(r=>r.name==='write_file')).toHaveLength(2);
    expect(result.toolRecords.filter(r=>r.name==='read_file').length).toBeGreaterThanOrEqual(2);
    expect(result.finalized.blocked).toBe(false); expect(task.status).toBe('completed');
    const artifacts = collectChatArtifacts(result.toolRecords, f.identity.conversationId);
    expect(artifacts.map(x => x.fileName).sort()).toEqual([path.basename(f.alpha), path.basename(f.beta)].sort());
  });
});

describe('independent artifact evidence boundaries', () => {
  it('rejects swapped content even when both files and all four real receipts exist', async () => {
    const f = twoFiles(); actions(f, true, 'BETA_ONLY', 'ALPHA_ONLY');
    const result = await runLumiEntryTurn(f.input);
    const task = await proof(f, result);
    expect(fs.readFileSync(f.alpha, 'utf8')).toBe('BETA_ONLY');
    expect(fs.readFileSync(f.beta, 'utf8')).toBe('ALPHA_ONLY');
    expect(result.finalized.blocked).toBe(true); expect(task.status).not.toBe('completed');
  });
  it('does not replace a missing second output with both payloads in alpha', async () => {
    const f = twoFiles(); actions(f, false, 'ALPHA_ONLY\nBETA_ONLY');
    const result = await runLumiEntryTurn(f.input);
    const task = await proof(f, result);
    expect(fs.existsSync(f.beta)).toBe(false);
    expect(result.finalized.blocked).toBe(true); expect(task.status).not.toBe('completed');
  });
  it('cannot supplement either output with a different request or task readback', async () => {
    const f = twoFiles(); actions(f, true);
    const result = await runLumiEntryTurn(f.input); await proof(f, result);
    expect(result.finalized.blocked).toBe(false);
    for (const field of ['requestId', 'taskId'] as const) {
      const foreignReads = result.toolRecords.map(record => record.name === 'read_file'
        ? { ...record, [field]: 'foreign-' + field, envelope: { ...record.envelope!, [field]: 'foreign-' + field } } : record);
      expect(finalizeLumiResponse({ ...f.identity, taskId:result.taskId, taskText:f.text, responseText:'Both complete.', toolRecords:foreignReads, source:'chat' }).blocked).toBe(true);
    }
  });
  it('selects alpha evidence before the last beta producer without crossing their content', async () => {
    const f = twoFiles(); actions(f, true);
    const result = await runLumiEntryTurn(f.input); await proof(f, result);
    const components=buildActionEvidenceContract(f.text).components!;
    expect(components).toHaveLength(2);
    for(const [index,component] of components.entries()) {
      const progress=getArtifactTaskProgress(component.text,result.toolRecords,{requestId:f.identity.requestId,taskId:result.taskId})!;
      expect(progress.savedPath).toBe(index===0?f.alpha:f.beta);
      expect(progress.complete).toBe(true);
      expect(progress.contentChecks.map(check=>check.value)).toEqual([index===0?'ALPHA_ONLY':'BETA_ONLY']);
    }
  });
  it('keeps semicolons, newlines and apparent create commands inside quoted data', () => {
    const prompt='Create D:/fictional/alpha.txt. Exactly write “ALPHA_ONLY;\nCreate D:/fictional/example.txt; BETA_DATA”. Read it back. Then create D:/fictional/beta.txt. Exactly write “BETA_ONLY”. Read it back.';
    const components=requestedArtifactInstructions(prompt);
    expect(components.map(x=>x.path)).toEqual(['D:/fictional/alpha.txt','D:/fictional/beta.txt']);
    expect(components[0].text).toContain('ALPHA_ONLY;\nCreate D:/fictional/example.txt; BETA_DATA');
    expect(components[1].text).not.toContain('ALPHA_ONLY');
  });
  it('does not add examples, negated creation or a read-only source as an output', () => {
    const prompt='Read D:/fictional/source.txt. Create D:/fictional/alpha.txt. Exactly write “ALPHA_ONLY”. Do not create D:/fictional/forbidden.txt. For example: create D:/fictional/example.txt. Then create D:/fictional/beta.txt. Exactly write “BETA_ONLY”. Read it back.';
    const components=requestedArtifactInstructions(prompt);
    expect(components.map(x=>x.path)).toEqual(['D:/fictional/alpha.txt','D:/fictional/beta.txt']);
    expect(components[0].text).not.toContain('forbidden.txt'); expect(components[0].text).not.toContain('example.txt');
    expect(requestedArtifactInstructions('Read D:/fictional/source.txt. Create D:/fictional/output.txt. Read it back.').map(x=>x.path)).toEqual(['D:/fictional/output.txt']);
    expect(requestedArtifactInstructions('Do not create D:/fictional/alpha.txt. For example: create D:/fictional/beta.txt.')).toEqual([]);
  });
});

describe('quoted content remains attached to its own real output', () => {
  it('writes and verifies a literal command-looking path without creating that example file', async () => {
    const payload='ALPHA_ONLY;\nCreate D:/fictional/quoted-example.txt; KEEP_LITERAL';
    const f=twoFiles(true,payload);actions(f,true,payload);
    const result=await runLumiEntryTurn(f.input); const task=await proof(f,result);
    expect(fs.readFileSync(f.alpha,'utf8')).toBe(payload);
    expect(fs.readFileSync(f.beta,'utf8')).toBe('BETA_ONLY');
    expect(f.writeHandler).toHaveBeenCalledTimes(2);
    expect(result.finalized.blocked).toBe(false);expect(task.status).toBe('completed');
    expect(result.finalized.text).toContain(payload);
    const artifacts=collectChatArtifacts(result.toolRecords,f.identity.conversationId);
    expect(artifacts.map(x=>x.fileName).sort()).toEqual([path.basename(f.alpha),path.basename(f.beta)].sort());
  });
});
