import './helpers';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { beforeAll, expect, it, vi } from 'vitest';
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


// The original input remains a read-only file; only an explicit current-chat
// handoff may add it beside a separately created output.
async function sourceHandoffFixture(options: { handoff?: string; reader?: 'unverified' | 'wrong-path'; desktop?: boolean; body?: string } = {}) {
  const userId = 'source-handoff-' + randomUUID(), requestId = randomUUID();
  const conversationId = getOrCreateActiveConversation(userId, 'lumi', 'personal', '').id;
  const identity = { userId, conversationId, requestId, agentId: 'lumi', domain: 'personal' as const, orgId: '' };
  const dir = options.desktop ? path.join(os.homedir(), 'Desktop') : path.join(String(process.env.LUMI_DATA_DIR), 'source-handoff-' + requestId);
  fs.mkdirSync(dir, { recursive: true });
  const source = path.join(dir, options.desktop ? '共同验收修订.docx' : 'original.docx'), output = path.join(dir, options.desktop ? '共同验收修订.pdf' : 'converted.pdf'), unrelated = path.join(dir, 'unrelated.docx');
  fs.writeFileSync(source, options.body || 'SOURCE_BODY: title, blue 3, orange 9');
  fs.writeFileSync(output, '%PDF-OFFLINE-FIXTURE');
  fs.writeFileSync(unrelated, 'UNRELATED_PRIVATE_FILE');
  const text = (options.desktop ? '读取桌面的“共同验收修订.docx”，将全部文字制作成桌面的“共同验收修订.pdf”，保留标题和两条内容，不修改原Word。'
    : '读取“' + source + '”，将全部文字制作成“' + output + '”，保留标题和两条内容，不修改原Word。')
    + (options.handoff || '核对PDF文字后，把原Word和PDF两个文件都发到当前聊天。');
  const userMessageId = addMessage({ ...identity, role: 'user', content: text, deferActionPreparation: true });
  const prepared = prepareConversationActionExecution({ conversationId, userId, requestId, userMessageId, userText: text,
    forceTask: true, toolPolicy: { allowedTools: ['*'], forbiddenTools: [], requireConfirmation: [], maxIterations: 3 } });
  if (!prepared.state) throw new Error('No source handoff task');
  const taskId = prepared.state.taskId, turnRowId = 'turnRowId' in prepared ? prepared.turnRowId : undefined;
  const registry = new ToolRegistry();
  registry.register({ name: 'read_docx', description: 'Offline exact-source read fixture', permission: 'user', securityLevel: 'safe',
    parameters: { type: 'object', properties: { filePath: { type: 'string' } }, required: ['filePath'] },
    capability: capabilityContract({ id: 'test.source.docx.read', family: 'test', lane: 'office', operation: 'observe', risk: 'low',
      sideEffects: [{ type: 'local_read', scope: 'the exact source', reversible: true }], verification: { strategy: 'terminal_receipt', required: true,
        requiredFields: options.reader === 'unverified' ? ['verifiedBody'] : [], successSignals: [], limitations: [] } }),
    handler: async () => options.body || 'SOURCE_BODY: title, blue 3, orange 9' });
  registry.register({ name: 'create_pdf', description: 'Offline existing-output receipt fixture', permission: 'user', securityLevel: 'safe',
    parameters: { type: 'object', properties: { outputPath: { type: 'string' }, content: { type: 'string' } }, required: ['outputPath'] },
    capability: capabilityContract({ id: 'test.source.pdf.create', family: 'test', lane: 'office', operation: 'create', risk: 'low',
      sideEffects: [{ type: 'local_write', scope: 'the named output', reversible: true }], verification: { strategy: 'artifact', required: true,
        requiredFields: ['ok', 'status', 'path'], requiredValues: { ok: true }, successStatuses: ['created'], requiredArtifacts: ['path'], successSignals: [], limitations: [] } }),
    handler: async () => JSON.stringify({ ok: true, status: 'created', path: output, size: fs.statSync(output).size }) });
  if (options.desktop) registry.register({ name: 'desktop_path_info', description: 'Offline exact-path metadata fixture', permission: 'user', securityLevel: 'safe',
    parameters: { type: 'object', properties: { target: { type: 'string' } }, required: ['target'] },
    handler: async ({ target }) => JSON.stringify({ exists: true, path: target, name: path.basename(String(target)), is_directory: false, size: fs.statSync(String(target)).size }) });
  const observer = createConversationReceiptObserver({ ...identity, taskId, turnRowId }, () => true);
  const context = { ...identity, taskId, turnRowId, turnId: requestId, source: 'chat', authenticated: true, authRole: 'admin' as const,
    localExecution: true, executionBoundary: 'trusted_local' as const, actionIntent: text, routedTaskText: text,
    allowLocalFileWrites: true, onToolRecord: observer.onToolRecord,
    toolPolicy: { allowedTools: ['*'], forbiddenTools: [], requireConfirmation: [], maxIterations: 3 } };
  if (options.desktop) {
    const metadata = await executeToolCall({ registry, name: 'desktop_path_info', id: 'source-path-' + requestId, arguments: { target: source }, context });
    expect(metadata.envelope?.status, metadata.error).toBe('verified_success');
  }
  const sourceRead = await executeToolCall({ registry, name: 'read_docx', id: 'source-read-' + requestId,
    arguments: { filePath: options.reader === 'wrong-path' ? unrelated : source }, context });
  const producer = await executeToolCall({ registry, name: 'create_pdf', id: 'pdf-output-' + requestId,
    arguments: { outputPath: output, content: 'SOURCE_BODY' }, context });
  expect(producer.envelope?.status).toBe('verified_success');
  if (!options.reader) expect(sourceRead.envelope?.status, sourceRead.error).toBe('verified_success');
  else expect(sourceRead.terminalVerification?.status).not.toBe('verified');
  addMessage({ ...identity, role: 'assistant', content: 'Offline attachment projection.', toolCalls: [sourceRead, producer] });
  return { ...identity, taskId, text, source, output, unrelated, records: [sourceRead, producer] };
}

it('attaches the requested original Word and PDF through live/history projection and the download authorization owner', async () => {
  const { publicChatArtifactDelivery } = await import('../server/conversation/chat_artifacts');
  const { resolveGeneratedDownloadPath } = await import('../server/files/knowledge/paths');
  const f = await sourceHandoffFixture();
  const live = publicChatArtifactDelivery(f.records, f.conversationId, f);
  expect(live.artifacts.map(file => file.path).sort()).toEqual([f.source, f.output].sort());
  const stored = readDB().interactions.find((row: any) => row.requestId === f.requestId && row.role === 'assistant');
  const history = projectConversationMessageForCustomer(stored);
  expect(history.fileArtifacts.map((file: any) => file.path).sort()).toEqual([f.source, f.output].sort());
  const req = { user: { uid: f.userId, role: 'admin' }, query: { conversationId: f.conversationId } } as any;
  for (const file of [f.source, f.output]) expect(resolveGeneratedDownloadPath(file, req)).toBe(fs.realpathSync.native(file));
  expect(() => resolveGeneratedDownloadPath(f.unrelated, req)).toThrow();
  expect(() => resolveGeneratedDownloadPath(f.source, { ...req, user: { uid: 'different-owner', role: 'admin' } } as any)).toThrow();
});

it.each([
  '只把PDF发到当前聊天。',
  '把PDF发到当前聊天，不要把原Word发到当前聊天。',
  '如果需要，把原Word和PDF两个文件都发到当前聊天。',
  '只解释“把原Word和PDF两个文件都发到当前聊天”的意思。',
  '例如，把原Word和PDF两个文件都发到当前聊天。',
  '备注中原样引用这句文字：“把原Word和PDF两个文件都发到当前聊天”。只把PDF发到当前聊天。',
  '把原Word和PDF两个文件都发到当前聊天，但最后只把PDF发到当前聊天。',
  '把原Word和PDF两个文件都发到当前聊天。不要把原Word发到当前聊天。',
  '把原Word和PDF两个文件都发到当前聊天，但原Word不用发，只发PDF。',
])('does not attach the original for an absent, forbidden, hypothetical or quoted handoff: %s', async handoff => {
  const { publicChatArtifactDelivery } = await import('../server/conversation/chat_artifacts');
  const { resolveGeneratedDownloadPath } = await import('../server/files/knowledge/paths');
  const f = await sourceHandoffFixture({ handoff });
  expect(publicChatArtifactDelivery(f.records, f.conversationId, f).artifacts.map(file => file.path)).toEqual([f.output]);
  const req = { user: { uid: f.userId, role: 'admin' }, query: { conversationId: f.conversationId } } as any;
  expect(() => resolveGeneratedDownloadPath(f.source, req)).toThrow();
});

it.each(['unverified', 'wrong-path'] as const)('does not expose the source when its exact current read is %s', async reader => {
  const { publicChatArtifactDelivery } = await import('../server/conversation/chat_artifacts');
  const { resolveGeneratedDownloadPath } = await import('../server/files/knowledge/paths');
  const f = await sourceHandoffFixture({ reader });
  expect(publicChatArtifactDelivery(f.records, f.conversationId, f).artifacts.map(file => file.path)).toEqual([f.output]);
  const req = { user: { uid: f.userId, role: 'admin' }, query: { conversationId: f.conversationId } } as any;
  expect(() => resolveGeneratedDownloadPath(f.source, req)).toThrow();
  expect(() => resolveGeneratedDownloadPath(f.unrelated, req)).toThrow();
});

it('requires server-owned request/task scope and does not use client prose to attach a neighboring file', async () => {
  const { publicChatArtifactDelivery } = await import('../server/conversation/chat_artifacts');
  const { projectRequestedSourceArtifactHandoff } = await import('../server/cognition/artifact_progress');
  const f = await sourceHandoffFixture();
  for (const override of [{ requestId: 'old-request' }, { taskId: 'old-task' }]) {
    expect(publicChatArtifactDelivery(f.records, f.conversationId, { ...f, ...override }).artifacts).toEqual([]);
    expect(projectRequestedSourceArtifactHandoff(f.text, f.records, { requestId: f.requestId, taskId: f.taskId, ...override }).paths).toEqual([]);
  }
  const noOriginal = await sourceHandoffFixture({ handoff: '只把PDF发到当前聊天。' });
  const forgedText = '读取“' + noOriginal.source + '”，把原Word发到当前聊天。';
  const projection = publicChatArtifactDelivery(noOriginal.records, noOriginal.conversationId, { ...noOriginal, originalText: [forgedText] });
  expect(projection.artifacts.map(file => file.path)).toEqual([noOriginal.output]);
});

it('resolves the actual desktop-basename prompt in an isolated home and keeps a missing current source read pending', async () => {
  const { publicChatArtifactDelivery } = await import('../server/conversation/chat_artifacts');
  const { projectRequestedSourceArtifactHandoff } = await import('../server/cognition/artifact_progress');
  const home = path.join(String(process.env.LUMI_DATA_DIR), 'desktop-source-home-' + randomUUID());
  const homedir = vi.spyOn(os, 'homedir').mockReturnValue(home);
  try {
    const f = await sourceHandoffFixture({ desktop: true });
    expect(f.source).toBe(path.join(home, 'Desktop', '共同验收修订.docx'));
    const ready = projectRequestedSourceArtifactHandoff(f.text, f.records, f);
    expect(ready).toEqual({ required: true, sourcePath: f.source, paths: [f.source], missing: false });
    expect(publicChatArtifactDelivery(f.records, f.conversationId, f).artifacts.map(file => file.path).sort()).toEqual([f.source, f.output].sort());
    const pending = projectRequestedSourceArtifactHandoff(f.text, f.records.filter(record => record.name !== 'read_docx'), f);
    expect(pending).toEqual({ required: true, sourcePath: f.source, paths: [], missing: true });
  } finally { homedir.mockRestore(); }
});


async function attachmentNarrationProjection(f: Awaited<ReturnType<typeof sourceHandoffFixture>>, text: string, override: Record<string, unknown> = {}) {
  const { projectPublicArtifactPayload } = await import('../server/conversation/chat_artifacts');
  const live = projectPublicArtifactPayload({ text, blocked: false }, f.records, f.conversationId, { ...f, ...override });
  addMessage({ userId: f.userId, agentId: 'lumi', conversationId: f.conversationId, requestId: f.requestId,
    domain: 'personal', orgId: '', role: 'assistant', content: text, toolCalls: f.records });
  const stored = readDB().interactions.filter((row: any) => row.requestId === f.requestId && row.role === 'assistant').at(-1);
  const history = projectConversationMessageForCustomer(stored);
  expect(stored.message).toBe(text);
  return { live, history };
}

it.each([
  '我当前可用的工具里没有把任意 .pdf 文件作为附件直接推送到这个聊天窗口的能力。文件已在桌面上，你可以打开；或告诉我改用其他方式，我再继续。\n\n如果你希望我用 '+String.fromCharCode(96)+'desktop_open'+String.fromCharCode(96)+' 打开这份文件，也可以说一声。',
  '我无法将 converted.pdf 作为附件发到当前聊天。',
  'I cannot attach converted.pdf to this chat.',
])('reconciles a current public attachment denial in both live and saved-history projections: %s', async denial => {
  const f = await sourceHandoffFixture();
  const body = '报告已保存。\n数量分别为7和5，相差2。';
  const { live, history } = await attachmentNarrationProjection(f, body+'\n\n'+denial);
  expect(live.fileArtifacts.map(file => file.path)).toContain(f.output);
  expect(live.blocked).toBe(false); expect(live.text).toBe(body);
  expect(history.message).toBe(live.text); expect(history.fileArtifacts).toEqual(live.fileArtifacts);
});

it('keeps independent external and different-file failures beside the publicly delivered output', async () => {
  const f = await sourceHandoffFixture();
  const failures = '微信发送失败。邮件尚未发送。\n我无法把 missing.docx 作为附件发到当前聊天。';
  const { live, history } = await attachmentNarrationProjection(f, '报告已保存。\n我无法将 converted.pdf 作为附件发到当前聊天。\n'+failures);
  expect(live.text).toBe('报告已保存。\n\n'+failures); expect(history.message).toBe(live.text);
});

it('preserves quoted source, user quotations, code and blockquotes while correcting only assistant narration', async () => {
  const sourceBody = '我不能把文件作为附件发送到当前聊天。\n\n\n如果你希望我用 '+String.fromCharCode(96)+'desktop_open'+String.fromCharCode(96)+' 打开文件，也可以说一声。\n';
  const f = await sourceHandoffFixture({ body: sourceBody });
  const quoted = '用户原话：“我无法将 converted.pdf 作为附件发到当前聊天。”\n'+String.fromCharCode(96).repeat(3)+'text\n我不能把文件作为附件发送到当前聊天。\n'+String.fromCharCode(96).repeat(3)+'\n> 我不能把文件作为附件发送到当前聊天。';
  const meaningful = '原文：\n'+sourceBody+'\n\n'+quoted;
  const { live, history } = await attachmentNarrationProjection(f, meaningful+'\n\n我无法将 converted.pdf 作为附件发到当前聊天。');
  expect(live.text).toBe(meaningful); expect(history.message).toBe(meaningful);
  const { projectPublicArtifactPayload } = await import('../server/conversation/chat_artifacts');
  expect(projectPublicArtifactPayload({ text: meaningful+'\n' }, f.records, f.conversationId, f).text).toBe(meaningful+'\n');
});

it('does not turn a request without same-chat handoff into delivery narration', async () => {
  const f = await sourceHandoffFixture({ handoff: '保留文件，不要发到当前聊天。' });
  const text = '我无法将 converted.pdf 作为附件发到当前聊天。';
  const { live, history } = await attachmentNarrationProjection(f, text);
  expect(live.text).toBe(text); expect(history.message).toBe(text);
});

it.each(['missing', 'withheld', 'foreign', 'unverified', 'no-artifact'] as const)('keeps the original denial when the current output is %s', async invalid => {
  const f = await sourceHandoffFixture();
  const { projectPublicArtifactPayload } = await import('../server/conversation/chat_artifacts');
  const text = '我无法将 converted.pdf 作为附件发到当前聊天。';
  if (invalid === 'missing') fs.unlinkSync(f.output);
  if (invalid === 'withheld') fs.writeFileSync(f.output, 'Private runtime identity: '+f.records.find(record => record.name === 'create_pdf')!.id);
  const records = invalid === 'no-artifact' ? [] : invalid === 'unverified'
    ? [{ name: 'create_pdf', arguments: { outputPath: f.output }, result: JSON.stringify({ ok: true, path: f.output }), requestId: f.requestId,
      taskId: f.taskId, terminalVerification: { status: 'unverified', strategy: 'artifact', reason: 'No verified producer' } }] : f.records;
  const live = projectPublicArtifactPayload({ text }, records, f.conversationId, invalid === 'foreign' ? { ...f, requestId: 'unrelated-request' } : f);
  expect(live.text).toBe(text);
  if (invalid !== 'missing') expect(live.fileArtifacts.some(file => file.path === f.output)).toBe(false);
});

it('keeps an independently requested open and its tool explanation after correcting the attachment denial', async () => {
  const f = await sourceHandoffFixture({ handoff: '把PDF发到当前聊天，然后打开PDF。' });
  const open = '如果你希望我用 '+String.fromCharCode(96)+'desktop_open'+String.fromCharCode(96)+' 打开这份文件，也可以说一声。';
  const { live } = await attachmentNarrationProjection(f, '报告已保存。\n我无法将 converted.pdf 作为附件发到当前聊天。\n'+open);
  expect(live.text).toContain(open); expect(live.text).not.toContain('我无法将 converted.pdf');
});


it('keeps an unquoted current-request literal without requiring a generated-file readback', async () => {
  const literal = '我不能把文件作为附件发送到当前聊天。';
  const f = await sourceHandoffFixture({ handoff: '正文请写：'+literal+'完成后把PDF发到当前聊天。' });
  const { projectPublicArtifactPayload } = await import('../server/conversation/chat_artifacts');
  const projection = projectPublicArtifactPayload({ text: literal }, f.records.filter(record => record.name === 'create_pdf'), f.conversationId, f);
  expect(projection.fileArtifacts.map(file => file.path)).toContain(f.output);
  expect(projection.text).toBe(literal);
});

it('leaves ordinary narration whitespace byte for byte when no attachment denial was removed', async () => {
  const f = await sourceHandoffFixture();
  const { projectPublicArtifactPayload } = await import('../server/conversation/chat_artifacts');
  const text = '  报告已保存。\n\n\n数量分别为7和5，相差2。\n';
  expect(projectPublicArtifactPayload({ text }, f.records, f.conversationId, f).text).toBe(text);
});
