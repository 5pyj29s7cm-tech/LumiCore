import './helpers';
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { beforeAll, expect, it } from 'vitest';
import { initDatabase, readDB } from '../db_layer';
import { addMessage, getOrCreateActiveConversation, prepareConversationActionExecution } from '../server/conversation/manager';
import { createConversationReceiptObserver } from '../server/conversation/execution_receipt_archive';
import { executeToolCall, isCanonicalToolExecutionRecord } from '../server/tools/execution_engine';
import { ToolRegistry } from '../server/tools/registry';
import { capabilityContract } from '../server/tools/capability_contracts';
import { prepareChatEvents } from '../server/socket/chat/phases/prepare_chat_events';
import { finalizeLumiResponse } from '../server/cognition/result_finalizer';
import { projectConversationMessageForCustomer } from '../server/routes/conversations';

beforeAll(async () => { await initDatabase(); });
async function fixture() {
  const userId = 'live-retrieval-' + randomUUID(), requestId = randomUUID();
  const conversation = getOrCreateActiveConversation(userId, 'lumi', 'personal', '');
  const conversationId = conversation.id, projectId = 'a590fef2-1d8f-4cea-a2b6-6a3ed5567e6a';
  const text = `请把已有工程 ${projectId} 第23版已经保存的视频作为附件返回这里，不要重新生成。`;
  const identity = { userId, conversationId, requestId, agentId: 'lumi', domain: 'personal' as const, orgId: '' };
  const userMessageId = addMessage({ ...identity, role: 'user', content: text, deferActionPreparation: true });
  const prepared = prepareConversationActionExecution({ conversationId, userId, requestId, userMessageId, userText: text,
    forceTask: true, toolPolicy: { allowedTools: ['*'], forbiddenTools: [], requireConfirmation: [], maxIterations: 2 } });
  if (!prepared.state) throw new Error('No owned task');
  const taskId = prepared.state.taskId;
  const turnRowId = 'turnRowId' in prepared ? prepared.turnRowId : undefined;
  expect(turnRowId).toBeTruthy();
  const outputPath = path.join(String(process.env.LUMI_DATA_DIR), 'live-existing-' + requestId + '.mp4');
  const bytes = Buffer.from('owned existing video fixture; no cloud or media rendering'); fs.writeFileSync(outputPath, bytes);
  const registry = new ToolRegistry();
  registry.register({ name: 'owned_video_read', description: 'Offline owned read-only artifact fixture', permission: 'user', securityLevel: 'safe',
    parameters: { type: 'object', properties: { projectId: { type: 'string' }, revision: { type: 'number' }, includeOutput: { type: 'boolean' } } },
    capability: capabilityContract({ id: 'test.owned_video_read', family: 'test', lane: 'media', operation: 'observe', risk: 'low',
      sideEffects: [{ type: 'local_read', scope: 'owned output', reversible: true }], verification: { strategy: 'state_diff', required: true,
        requiredFields: ['ok', 'verified'], successStatuses: ['retrieved'], successSignals: [], limitations: [] } }),
    handler: async () => JSON.stringify({ ok: true, verified: true, status: 'retrieved', projectId, revision: 23, selectedStyle: 'chat', outputPath,
      artifacts: [{ type: 'video', path: outputPath, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }] }) });
  const observer = createConversationReceiptObserver({ ...identity, taskId, turnRowId }, () => true);
  const record = await executeToolCall({ registry, name: 'owned_video_read', id: 'owned-read-' + requestId, arguments: { projectId, revision: 23, includeOutput: true },
    context: { ...identity, taskId, turnRowId, turnId: requestId, source: 'chat', authenticated: true, authRole: 'admin', localExecution: true,
      executionBoundary: 'trusted_local', actionIntent: text, routedTaskText: text, onToolRecord: observer.onToolRecord,
      toolPolicy: { allowedTools: ['*'], forbiddenTools: [], requireConfirmation: [], maxIterations: 2 } } });
  expect(isCanonicalToolExecutionRecord(record)).toBe(true); expect(record.envelope?.status).toBe('verified_success');
  expect(readDB().conversationActionReceipts.some((row: any) => row.requestId === requestId)).toBe(true);
  expect(readDB().interactions.some((row: any) => row.requestId === requestId && row.role === 'assistant')).toBe(false);
  const finalized = finalizeLumiResponse({ taskText: text, taskId, requestId, source: 'chat', toolRecords: [record], responseText: '' });
  expect(finalized).toMatchObject({ blocked: false, reason: 'artifact_retrieved' });
  let currentTaskId = taskId;
  const context = { uid: userId, requestId, selectedConversationId: conversationId, selectedConversation: conversation,
    visibleUserText: text, resolvedDomain: 'personal', resolvedOrgId: '', eventSource: 'command-center-chat', conversationAgentId: 'lumi',
    get durableTaskId() { return currentTaskId; }, collectRequestTerminalRecords: () => [record] };
  const events = await prepareChatEvents(context as any);
  return { ...identity, text, taskId, outputPath, record, finalized, context, events: events.context!, setTaskId: (value: string) => { currentTaskId = value; } };
}
it('projects the same verified local video into the successful live terminal and later persisted history', async () => {
  const f = await fixture();
  const live = f.events.normalizeAgentPayload('agent:response', { ...f.finalized, finalized: true });
  expect(live.blocked).toBe(false); expect(live.reason).toBe('artifact_retrieved');
  expect(live.fileArtifacts).toHaveLength(1); expect(live.fileArtifacts[0].path).toBe(f.outputPath);
  addMessage({ userId: f.userId, agentId: 'lumi', conversationId: f.conversationId, requestId: f.requestId, domain: 'personal', orgId: '',
    role: 'assistant', content: f.finalized.text, toolCalls: [f.record] });
  const stored = readDB().interactions.find((row: any) => row.requestId === f.requestId && row.role === 'assistant');
  const history = projectConversationMessageForCustomer(stored);
  expect(history.fileArtifacts).toEqual(live.fileArtifacts);
});
it('reads the current task dynamically and rejects wrong task, request, owner and serialized unbranded metadata', async () => {
  const f = await fixture();
  f.setTaskId('other-task');
  expect(f.events.normalizeAgentPayload('agent:response', f.finalized).fileArtifacts).toEqual([]);
  f.setTaskId(f.taskId);
  expect(f.events.normalizeAgentPayload('agent:response', f.finalized).fileArtifacts).toHaveLength(1);
  for (const override of [{ requestId: 'other-request' }, { uid: 'other-user' }, { collectRequestTerminalRecords: () => [JSON.parse(JSON.stringify(f.record))] }]) {
    const events = await prepareChatEvents({ ...f.context, ...override } as any);
    expect(events.context!.normalizeAgentPayload('agent:response', f.finalized).fileArtifacts).toEqual([]);
  }
});
