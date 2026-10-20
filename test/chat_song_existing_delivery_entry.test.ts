import './helpers';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import sharp from 'sharp';
import { CHAT_SONG_TEMPLATE } from '../shared/chat_song_layout';
import { collectChatArtifacts, publicChatArtifactDelivery } from '../server/conversation/chat_artifacts';
import { beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { initDatabase, readDB, querySQL, readDatabaseTables, commitDatabaseTables, flushDBOrThrow } from '../db_layer';
import { captureRequestAuthorization } from '../server/conversation/lifecycle';
import { getOrCreateActiveConversation } from '../server/conversation/manager';
import { runLumiEntryTurn, type LumiEntryTurnInput, type ExecutedLumiTurn } from '../server/cognition/turn_execution';
import { ToolRegistry, getToolExecutionTimeoutMs } from '../server/tools/registry';
import { registerChatSongTools } from '../server/tools/definitions/chat_song_tools';
import { executeToolCall, isCanonicalToolExecutionRecord } from '../server/tools/execution_engine';
import { createTurnConfirmation } from '../server/tools/turn_confirmation';
import { clearAllPendingConfirmationsForTests } from '../server/tools/pending_confirmation';
import { ensurePendingConfirmationPersistenceInitialized } from '../server/tools/pending_confirmation_repository';
import { generatedKnowledgeDirectory } from '../server/files/knowledge_directory';
import { registerGeneratedKnowledgeFile } from '../server/files/generated_archive';
import { getChatSongProject, saveChatSongRender, chatSongRenderInputSha } from '../server/creative/chat_song';
import { upsertUserPreferredLLM } from '../server/llm/user_preferences';
import type { ToolContext } from '../server/tools/types';
import type { ChatSongProject } from '../shared/chat_song';
const mock = vi.hoisted(() => ({ llm: vi.fn(), media: vi.fn() }));
vi.mock('../server/llm/providers', async original => ({ ...await original<typeof import('../server/llm/providers')>(), makeLLMCall: (...args: any[]) => mock.llm(...args), makeLLMCallStreaming: (...args: any[]) => mock.llm(...args) }));
vi.mock('../server/media/process', () => ({ runMediaProcess: (...args: any[]) => mock.media(...args) }));
const uid = 'synthetic-chat-song-tools-owner';
const lines = [{ role: 'A', text: '星光落在我的窗前', group: 1, reaction: '' }, { role: 'B', text: '我把晚风唱成明天', group: 1, reaction: '' }];
const registry = new ToolRegistry();
registerChatSongTools(registry);
const getters = { getDeepSeek: () => null, getGemini: () => null, getRelay: () => null };
const ctx = (extra: Partial<ToolContext> = {}): ToolContext => ({ userId: uid, authenticated: true, authRole: 'user', localExecution: true, executionBoundary: 'trusted_local', domain: 'personal', requestId: randomUUID(), taskId: randomUUID(), currentTurnExecutionRequested: true, allowLocalFileWrites: true, llmGetters: getters, requestConfirmation: createTurnConfirmation({ userId: uid, source: 'chat', requestId: randomUUID(), actionIntent: 'Create the requested project deliverable.', consumeScope: () => undefined, proposalScope: () => undefined, onPending: () => undefined }), ...extra });
async function call(name: string, args: any, extra: Partial<ToolContext> = {}) { return JSON.parse(await registry.execute(name, args, ctx(extra))); }
async function project(): Promise<ChatSongProject> {
  let p = (await call('chat_song_project', { action: 'create', projectId: randomUUID(), title: 'Synthetic singing project' })).project;
  p = (await call('chat_song_project', { action: 'save', projectId: p.id, revision: p.revision, value: { title: p.title, brief: p.brief, lines } })).project;
  p = (await call('chat_song_project', { action: 'lock-script', projectId: p.id, revision: p.revision })).project;
  return (await call('chat_song_project', { action: 'select-song', projectId: p.id, revision: p.revision, value: { fileId: 'tool-song.wav' } })).project;
}

beforeAll(async () => { await initDatabase(); await ensurePendingConfirmationPersistenceInitialized(); upsertUserPreferredLLM(uid, { provider: 'relay', model: 'relay-synthetic' }); });
beforeEach(() => {
  clearAllPendingConfirmationsForTests();
  fs.writeFileSync(path.join(generatedKnowledgeDirectory({ userId: uid, domain: 'personal' }), 'tool-song.wav'), 'Synthetic audio bytes; ffprobe is mocked, this suite does not certify singing.');
  mock.llm.mockReset().mockResolvedValue({ text: JSON.stringify({ lines }), finishReason: 'stop' });
  mock.media.mockReset().mockResolvedValue(JSON.stringify({ streams: [{ codec_type: 'audio' }], format: { duration: '15' } }));
});


async function cachedVideo(withImage = false) {
  let p = await project();
  p = (await call('chat_song_project', { action: 'set-timings', projectId: p.id, revision: p.revision, value: [{ lineId: '01', start: 1, end: 5 }, { lineId: '02', start: 6, end: 10 }] })).project;
  const directory = generatedKnowledgeDirectory({ userId: uid, domain: 'personal' });
  if (withImage) {
    fs.writeFileSync(path.join(directory, 'retrieval-avatar.png'), await (sharp as any)({ create: { width: 8, height: 8, channels: 3, background: '#4c6470' } }).png().toBuffer());
    p = (await call('chat_song_project', { action: 'attach-asset', projectId: p.id, revision: p.revision, value: { kind: 'avatarA', fileId: 'retrieval-avatar.png' } })).project;
  }
  const fileId = 'retrieval-' + randomUUID() + '.mp4', filePath = path.join(directory, fileId);
  fs.writeFileSync(filePath, 'Synthetic existing video; retrieval tests prove owner/hash binding, not audio or visual quality.');
  const render = { fileId, sha256: createHash('sha256').update(fs.readFileSync(filePath)).digest('hex'), sourceRevision: p.revision, sourceInputsSha256: chatSongRenderInputSha(p), templateVersion: CHAT_SONG_TEMPLATE.version, duration: 15, width: 1080, height: 1440, createdAt: new Date().toISOString(), warnings: [] };
  saveChatSongRender(uid, p.id, render);
  await registerGeneratedKnowledgeFile({ userId: uid, domain: 'personal' }, fileId);
  mock.media.mockClear(); return { p: p as ChatSongProject, render, filePath, directory };
}

async function deliverExistingVideoThroughChat(p: ChatSongProject, language: 'en' | 'zh' = 'en') {
  const requestId = randomUUID(), conversationId = getOrCreateActiveConversation(uid, 'lumi', 'personal', '').id;
  const identity = { userId: uid, requestId, conversationId, agentId: 'lumi', domain: 'personal' as const, orgId: '' };
  const text = language === 'en' ? 'Return the existing video for chat-song project ' + p.id + ', revision ' + p.revision + ', as an attachment. Do not regenerate or modify any file.'
    : '请取回聊天唱歌工程 ' + p.id + ' 第 ' + p.revision + ' 版已有成片，作为视频附件返回。不要重新生成或修改任何文件。';
  const authorization = captureRequestAuthorization(() => true, 'Synthetic request is no longer current'); let diagnostic: unknown;
  mock.llm.mockReset().mockImplementation(async (messages: Array<{ promptBlock?: { id: string; fields?: Record<string, unknown> } }>, declarations: Array<{ function: { name: string } }>, config: { responseFormat?: string }) => {
    const fields = messages.find(message => message.promptBlock?.id === 'current-execution-authorization')?.promptBlock?.fields;
    if (mock.llm.mock.calls.length === 1) {
      expect(declarations.map(item => item.function.name), JSON.stringify(diagnostic)).toContain('chat_song_read');
      return { text: '', finishReason: 'tool_calls', toolCalls: [{ id: 'accepted-existing-song-read', name: 'chat_song_read', arguments: { projectId: p.id, revision: p.revision, includeOutput: true } }] };
    }
    const evidence = fields?.completionEvidence as Array<{ id: string; operation: string; effects: unknown[] }>;
    return { text: config.responseFormat === 'json_object' ? JSON.stringify({ answer: 'Here is the selected existing video.', goals: [{ text, operation: evidence[0].operation, effects: evidence[0].effects, status: 'completed', evidenceIds: [evidence[0].id] }] }) : 'Here is the selected existing video.', finishReason: 'stop', toolCalls: [] };
  });
  const input: LumiEntryTurnInput<ExecutedLumiTurn> = {
    entry: { source: 'chat', channel: 'chat', historyLimit: 10, failureText: 'Synthetic existing video request did not finish.', failureReason: 'existing_song_fixture' },
    identity, userText: text, authorization, controller: new AbortController(),
    planning: { dispatch: { ...identity, text, source: 'chat', channel: 'chat', operationMode: 'assistant', targetIsLumi: true }, registry,
      personalityToolPolicy: { allowedTools: ['chat_song_read'], forbiddenTools: ['chat_song_render', 'chat_song_project', 'chat_song_draft_dialogue'], requireConfirmation: [], maxIterations: 3 }, executionBoundary: 'trusted_local' },
    assemble: execution => {
      diagnostic = { flow: { mode: execution.turnIntent.flow.effectiveOperationMode, tools: execution.turnIntent.flow.allowToolUseForTurn, selfRepair: execution.turnIntent.flow.selfRepairTurn, clientOnly: execution.turnIntent.flow.clientActionOnlyTurn }, requested: execution.executionRequested, execution: execution.execution, projection: execution.modelToolProjection,
        scopedManifest: registry.getCapabilityManifest(undefined, { context: { ...identity, source: 'chat', autonomous: false } }).map(item => ({ name: item.toolName, executable: item.executable, modes: item.modes })) };
      return { systemPrompt: 'Return the requested existing video from a genuine current receipt, without rendering.', model: { registry, config: { provider: 'deepseek', model: 'offline-existing-song', userId: uid, requestId }, getters: {}, maxIterations: 3,
        context: ctx({ allowLocalFileWrites: false, actionIntent: text, routedTaskText: text }) } };
    }, deliver: result => result,
  };
  const result = await runLumiEntryTurn(input); return { result, identity, text, diagnostic };
}

it.each(['en', 'zh'] as const)('delivers an explicitly requested existing video through a canonical read-only receipt and the normal chat attachment collector (%s)', async language => {
  const { p, render, filePath, directory } = await cachedVideo();
  const before = fs.readdirSync(directory), original = structuredClone(getChatSongProject(uid, p.id));
  const ordinary = await call('chat_song_read', { projectId: p.id });
  expect(ordinary).toMatchObject({ status: 'read', project: original, render });
  expect(ordinary.artifacts).toBeUndefined(); expect(ordinary.outputPath).toBeUndefined(); expect(ordinary.library).toBeUndefined(); expect(ordinary.handoff).toBeUndefined();
  const entry = await deliverExistingVideoThroughChat(p, language);
  expect(entry.result.toolRecords, JSON.stringify(entry.diagnostic)).toHaveLength(1);
  const record = entry.result.toolRecords[0];
  expect(record.error).toBeFalsy(); expect(record.terminalVerification?.status).toBe('verified');
  expect(isCanonicalToolExecutionRecord(record)).toBe(true);
  expect(record).toMatchObject({ requestId: entry.identity.requestId, taskId: entry.result.taskId });
  expect(entry.result.finalized.blocked, JSON.stringify({ blocked: entry.result.finalized.blocked, reason: entry.result.finalized.reason })).toBe(false);
  expect(readDB().conversationActionTasks.find(row => row.id === entry.result.taskId)?.status).toBe('completed');
  const durable = await querySQL<{ taskId: string; requestId: string; toolName: string }>('SELECT taskId, requestId, toolName FROM conversation_action_receipts WHERE requestId = ?', [entry.identity.requestId]);
  expect(durable).toEqual([{ taskId: entry.result.taskId, requestId: entry.identity.requestId, toolName: 'chat_song_read' }]);
  const result = JSON.parse(record.result!);
  expect(result).toMatchObject({ ok: true, verified: true, status: 'retrieved', selectedStyle: 'chat', outputPath: filePath, artifacts: [{ type: 'video', path: filePath, sha256: render.sha256, size: fs.statSync(filePath).size }] });
  expect(result.project).toBeUndefined(); expect(result.library).toBeUndefined(); expect(result.handoff).toBeUndefined();
  expect(fs.readdirSync(directory)).toEqual(before);
  const artifacts = collectChatArtifacts([record]); expect(artifacts).toHaveLength(1); expect(artifacts[0].kind).toBe('video'); expect(artifacts[0].fileName).toBe(render.fileId);
  expect(registry.getCapabilityManifestEntry('chat_song_read')).toMatchObject({ operation: 'observe', sideEffects: [{ type: 'local_read' }] });
  expect(mock.media).not.toHaveBeenCalled(); expect(mock.llm).toHaveBeenCalledTimes(2); expect(mock.llm.mock.calls.every(args => args[2].model === 'offline-existing-song')).toBe(true); expect(fs.readdirSync(directory)).toEqual(before); expect(getChatSongProject(uid, p.id)).toEqual(original); expect(original.song?.confirmed).toBe(false);
});


it('does not expose an unpersisted canonical existing-output read as a public attachment', async () => {
  const { p } = await cachedVideo();
  const record = await executeToolCall({ registry, name: 'chat_song_read', arguments: { projectId: p.id, revision: p.revision, includeOutput: true }, executionOrigin: 'model_selected', context: ctx({ allowLocalFileWrites: false, toolPolicy: { allowedTools: ['chat_song_read'], forbiddenTools: [], requireConfirmation: [], maxIterations: 3 } }) });
  expect(record.error).toBeFalsy(); expect(isCanonicalToolExecutionRecord(record)).toBe(true);
  expect(collectChatArtifacts([record])).toEqual([]);
});

it('preserves the public owner boundary and rebuilds only the durable selected artifact', async () => {
  const { p, filePath } = await cachedVideo(); const entry = await deliverExistingVideoThroughChat(p);
  const context = { ...entry.identity, taskId: entry.result.taskId };
  expect(collectChatArtifacts(entry.result.toolRecords, entry.identity.conversationId)).toHaveLength(1);
  for (const invalid of [{ userId: 'another-owner' }, { domain: 'work' as const }, { orgId: 'another-organization' }]) {
    expect(publicChatArtifactDelivery(entry.result.toolRecords, entry.identity.conversationId, { ...context, ...invalid }).artifacts).toEqual([]);
  }
  const record = entry.result.toolRecords[0];
  const forged = { ...record, id: randomUUID(), taskId: randomUUID(), requestId: randomUUID() };
  expect(collectChatArtifacts([forged], entry.identity.conversationId)).toEqual([]);
  const altered = { ...record, result: JSON.stringify({ ok: true, verified: true, status: 'retrieved', outputPath: filePath + '.forged.mp4', artifacts: [{ type: 'video', path: filePath + '.forged.mp4' }] }) };
  const rebuilt = collectChatArtifacts([altered], entry.identity.conversationId);
  expect(rebuilt).toHaveLength(1); expect(rebuilt[0].path).toBe(filePath);
});

it.each(['missing-receipt', 'turn-user', 'turn-domain', 'turn-org'] as const)('withholds the existing video when %s no longer proves accepted durable ownership', async kind => {
  const { p } = await cachedVideo(); const entry = await deliverExistingVideoThroughChat(p);
  expect(collectChatArtifacts(entry.result.toolRecords, entry.identity.conversationId)).toHaveLength(1);
  const tables = readDatabaseTables(['conversationActionReceipts', 'conversationActionTurns']);
  const savedReceipts = structuredClone(tables.conversationActionReceipts), savedTurns = structuredClone(tables.conversationActionTurns);
  if (kind === 'missing-receipt') tables.conversationActionReceipts = tables.conversationActionReceipts.filter((row: { requestId: string }) => row.requestId !== entry.identity.requestId);
  else {
    const turn = tables.conversationActionTurns.find((row: { requestId: string }) => row.requestId === entry.identity.requestId)!;
    if (kind === 'turn-user') turn.userId = 'another-owner'; if (kind === 'turn-domain') turn.domain = 'work'; if (kind === 'turn-org') turn.orgId = 'another-organization';
  }
  commitDatabaseTables(tables); await flushDBOrThrow();
  try { expect(collectChatArtifacts(entry.result.toolRecords, entry.identity.conversationId)).toEqual([]); }
  finally { const restore = readDatabaseTables(['conversationActionReceipts', 'conversationActionTurns']); restore.conversationActionReceipts = savedReceipts; restore.conversationActionTurns = savedTurns; commitDatabaseTables(restore); await flushDBOrThrow(); }
});
