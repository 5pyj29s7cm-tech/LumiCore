import './helpers';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import jwt from 'jsonwebtoken';
import { beforeAll, beforeEach, afterAll, expect, it, vi } from 'vitest';
import { makeApp, JWT_SECRET } from './helpers';
const model = vi.hoisted(() => vi.fn());
vi.mock('../server/llm/providers', async original => ({ ...await original<any>(), makeLLMCall: model, makeLLMCallStreaming: model }));
import { readDB, readDatabaseTables, commitDatabaseTables, flushDBOrThrow } from '../db_layer';
import { getOrCreateActiveConversation, addMessage, deleteConversationData } from '../server/conversation/manager';
import { captureRequestAuthorization } from '../server/conversation/lifecycle';
import { runLumiEntryTurn } from '../server/cognition/turn_execution';
import { ToolRegistry } from '../server/tools/registry';
import { capabilityContract } from '../server/tools/capability_contracts';
import { inspectPublicExecutionReferences } from '../server/cognition/user_output_protection';
import { registerFileOpsTools } from '../server/tools/definitions/file_ops';
import { executeToolCall } from '../server/tools/execution_engine';
import { sameArtifactPath } from '../server/tools/artifact_evidence';
import { appendConversationActionReceipts } from '../server/conversation/ledger/receipt_store';
import { collectChatArtifacts, collectTechnicalChatArtifacts, publicChatArtifactDelivery, projectPublicArtifactPayload, publicArtifactSnapshotDelivery, artifactContentSnapshot, isCompleteArchivedArtifactEvidence } from '../server/conversation/chat_artifacts';
import { projectConversationMessageForCustomer } from '../server/routes/conversations';
import { registerConversationHandlers } from '../server/socket/conversations';
import { extractGeneratedFiles } from '../src/components/agent_chat/media_artifacts';
import { archiveGeneratedOutputs, listGeneratedArchive, listGeneratedArchiveProjection } from '../server/files/generated_archive';
import { generatedKnowledgeDirectory } from '../server/files/knowledge_directory';
let app: Awaited<ReturnType<typeof makeApp>>;
beforeAll(async () => { app = await makeApp(); app.apiRouter.use((await import('../routes/files')).default); });
afterAll(() => app?.cleanup());
beforeEach(() => model.mockReset());
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
async function fixture(original = 'ORIGINAL_FULL_BODY\nTAIL_SENTINEL', userLiteral = '', referenceSource = true, batchAllReads = true, dirtyBody?: (id: string) => string, laterReadId?: string) {
  const userId = 'public-artifact-' + randomUUID(), requestId = randomUUID();
  const conversationId = getOrCreateActiveConversation(userId, 'lumi', 'personal', '').id;
  const identity = { userId, conversationId, requestId, agentId: 'lumi', domain: 'personal' as const, orgId: '' };
  const scope = { userId, domain: 'personal' as const };
  const dir = path.join(String(process.env.LUMI_DATA_DIR), 'artifact-' + requestId); fs.mkdirSync(dir, { recursive: true });
  const source = path.join(dir, 'source.txt'), dirty = path.join(dir, 'report.txt'), safe = path.join(dir, 'safe.txt');
  fs.writeFileSync(source, original);
  const db = readDatabaseTables(['users']); db.users.push({ uid: userId, username: userId, role: 'admin', password: 'fixture', balance: 0, createdAt: new Date().toISOString() } as any); commitDatabaseTables(db);
  const text = (referenceSource ? 'Read the file "' + source + '"' : 'Read the available source') + ' and show its complete contents. Then create the file "' + dirty
    + '" containing "REPORT_OK" and read it back. Then create the file "' + safe + '" containing "SAFE_OK" and read it back.' + userLiteral;
  const registry = new ToolRegistry(); registerFileOpsTools(registry);
  let round = 0;
  model.mockImplementation(async () => {
    round++;
    if (round === 1) return { text: '', toolCalls: [
      { id: 'input-source-read', name: 'read_file', arguments: { path: source } },
      { id: 'dirty-report-write', name: 'write_file', arguments: { path: laterReadId ? dirty.replaceAll('\\', '/') : dirty, content: dirtyBody ? dirtyBody('input-source-read') : 'REPORT_OK\nInternal reference: input-source-read' } },
      { id: 'safe-report-write', name: 'write_file', arguments: { path: safe, content: 'SAFE_OK' } },
      ...(laterReadId ? [{ id: laterReadId, name: 'read_file', arguments: { path: source } }] : []),
      ...(batchAllReads ? [{ id: 'dirty-report-readback', name: 'read_file', arguments: { path: dirty } },
        { id: 'safe-report-readback', name: 'read_file', arguments: { path: safe } }] : []),
    ] };
    const rows = readDB().conversationActionReceipts.filter((row: any) => row.requestId === requestId);
    if (batchAllReads && !rows.some((row: any) => row.toolName === 'read_file' && row.targetIdentity === dirty)) return { text: '', toolCalls: [
      { id: 'dirty-report-readback', name: 'read_file', arguments: { path: dirty } },
      { id: 'safe-report-readback', name: 'read_file', arguments: { path: safe } },
    ] };
    return { text: original + '\nREPORT_OK\nSAFE_OK', toolCalls: [] };
  });
  const context = { authenticated: true, authRole: 'admin', localExecution: true, executionBoundary: 'trusted_local' as const,
    actionIntent: text, routedTaskText: text, allowLocalFileWrites: true, requestConfirmation: async () => true };
  const r: any = await runLumiEntryTurn({ entry: { source: 'chat', channel: 'chat', historyLimit: 10, failureText: 'The request did not finish.', failureReason: 'fixture' }, identity, userText: text,
    authorization: captureRequestAuthorization(() => true, 'Revoked'), controller: new AbortController(),
    planning: { dispatch: { ...identity, text, source: 'chat', channel: 'chat', operationMode: 'assistant', targetIsLumi: true }, registry,
      personalityToolPolicy: { allowedTools: ['*'], forbiddenTools: [], requireConfirmation: [], maxIterations: 5 }, executionBoundary: 'trusted_local' },
    assemble: () => ({ systemPrompt: 'Use canonical file receipts.', model: { registry, config: { provider: 'deepseek', model: 'offline-fixture', userId, requestId }, getters: {}, maxIterations: 5, context } }), deliver: result => result } as any);
  expect(r.toolRecords.filter((record: any) => record.name === 'write_file' && record.envelope?.status === 'verified_success')).toHaveLength(2);
  if (batchAllReads && referenceSource) expect(r.toolRecords.filter((record: any) => record.name === 'read_file' && record.envelope?.status === 'verified_success')).toHaveLength(3);
  if (batchAllReads && !referenceSource) {
    expect(r.toolRecords.find((record: any) => record.id === 'input-source-read').envelope.status).toBe('failed');
    expect(r.toolRecords.filter((record: any) => record.name === 'read_file' && record.envelope?.status === 'verified_success')).toHaveLength(2);
  }
  expect(fs.readFileSync(dirty, 'utf8')).toBe(dirtyBody ? dirtyBody('input-source-read') : 'REPORT_OK\nInternal reference: input-source-read');
  const cookie = { Cookie: 'token=' + jwt.sign({ uid: userId, username: userId, role: 'admin' }, JWT_SECRET) };
  return { r, registry, context, identity, scope, text, source, dirty, safe, original, cookie };
}
const generatedRoute = (f: Awaited<ReturnType<typeof fixture>>, filePath: string) => '/files/generated?path=' + encodeURIComponent(filePath) + '&conversationId=' + encodeURIComponent(f.identity.conversationId);
async function replaceWithCleanVersion(f: Awaited<ReturnType<typeof fixture>>) {
  const identity = { ...f.identity, requestId: randomUUID() };
  const text = 'Write a text file "' + f.dirty + '" containing "CLEAN_REPORT" and read the saved file back.';
  expect(identity.requestId).not.toBe(f.identity.requestId);
  let round = 0;
  model.mockImplementation(async () => ++round === 1 ? { text: '', toolCalls: [
    { id: 'clean-overwrite', name: 'write_file', arguments: { path: f.dirty, content: 'CLEAN_REPORT' } },
    { id: 'clean-readback', name: 'read_file', arguments: { path: f.dirty } },
  ] } : { text: 'CLEAN_REPORT', toolCalls: [] });
  const result: any = await runLumiEntryTurn({ entry: { source: 'chat', channel: 'chat', historyLimit: 10, failureText: 'The clean version was not verified.', failureReason: 'fixture' }, identity, userText: text,
    authorization: captureRequestAuthorization(() => true, 'Revoked'), controller: new AbortController(),
    planning: { dispatch: { ...identity, text, source: 'chat', channel: 'chat', operationMode: 'assistant', targetIsLumi: true }, registry: f.registry,
      personalityToolPolicy: { allowedTools: ['*'], forbiddenTools: [], requireConfirmation: [], maxIterations: 3 }, executionBoundary: 'trusted_local' },
    assemble: () => ({ systemPrompt: 'Use canonical file receipts.', model: { registry: f.registry, config: { provider: 'deepseek', model: 'offline-fixture', userId: identity.userId, requestId: identity.requestId }, getters: {}, maxIterations: 3,
      context: { ...f.context, actionIntent: text, routedTaskText: text } } }), deliver: value => value } as any);
  const records = result.toolRecords.filter((record: any) => record.id === 'clean-overwrite' || record.id === 'clean-readback');
  expect(records).toHaveLength(2);
  for (const record of records) { expect(record.envelope?.status).toBe('verified_success'); expect(record.requestId).toBe(identity.requestId); }
  expect(records.map((record: any) => record.name)).toEqual(['write_file', 'read_file']);
  expect(fs.readFileSync(f.dirty, 'utf8')).toBe('CLEAN_REPORT');
  const task = readDB().conversationActionTasks.find((task: any) => task.id === result.taskId);
  expect(task).toBeDefined();
  const acceptedTurn = readDB().conversationActionTurns.find((turn: any) => turn.taskId === result.taskId && turn.requestId === identity.requestId);
  expect(acceptedTurn).toBeDefined();
  return { records, identity, taskId: result.taskId, text };
}
it('withholds only the polluted current file across live collection, serialized history and the real feed fallback', async () => {
  const f = await fixture();
  expect(f.r.finalized.blocked).toBe(true);
  const task = readDB().conversationActionTasks.find((task: any) => task.id === f.r.taskId);
  expect(task?.status).not.toBe('completed'); expect(task?.status).toBe('blocked');
  expect(f.r.finalized.fileArtifacts.map((file: any) => file.path)).toEqual([f.safe]);
  const raw = collectTechnicalChatArtifacts(f.r.toolRecords, f.identity.conversationId);
  expect(raw.map(file => file.path).sort()).toEqual([f.dirty, f.safe].sort());
  const live = projectPublicArtifactPayload({ text: 'Output file: ' + f.dirty + '\nOutput file: ' + f.safe,
    artifactProgress: { completed: ['File saved', 'Latest saved version read back'], evidence: [f.dirty, f.safe] }, completionFeedback: { status: 'completed', evidence: [f.dirty, f.safe] } }, f.r.toolRecords, f.identity.conversationId, { ...f.identity });
  expect(live.fileArtifacts.map(file => file.path)).toEqual([f.safe]); expect(live.blocked).toBe(true);
  expect(live.text).not.toContain(f.dirty); expect(live.text).toContain(f.safe);
  expect(live.artifactProgress.completed).toEqual(['File saved', 'Latest saved version read back']);
  expect(live.artifactProgress.evidence).toEqual([f.safe]); expect(live.completionFeedback.status).toBe('blocked');
  expect(extractGeneratedFiles(live.text, f.identity.conversationId).map(file => file.path)).not.toContain(f.dirty);
  const json = JSON.stringify(f.r.toolRecords);
  expect(collectChatArtifacts(json, f.identity.conversationId).map(file => file.path)).toEqual([f.safe]);
  const history = projectConversationMessageForCustomer({ ...f.identity, role: 'assistant', toolCalls: json, message: 'Output file: ' + f.dirty + '\nOutput file: ' + f.safe });
  expect(history.fileArtifacts.map((file: any) => file.path)).toEqual([f.safe]); expect(history.message).not.toContain(f.dirty);
  expect(extractGeneratedFiles(history.message, f.identity.conversationId).map(file => file.path)).not.toContain(f.dirty);
  expect(f.r.toolRecords.filter((record: any) => record.name === 'write_file').every((record: any) => record.terminalVerification.status === 'verified')).toBe(true);
  const cancelled = projectPublicArtifactPayload({ text: 'Cancelled.', blocked: false, reason: 'cancelled', completionFeedback: { status: 'cancelled' } }, f.r.toolRecords, f.identity.conversationId, f.identity);
  expect(cancelled.reason).toBe('cancelled'); expect(cancelled.blocked).toBe(false); expect(cancelled.completionFeedback.status).toBe('cancelled');
  expect(cancelled.fileArtifacts.map(file => file.path)).toEqual([f.safe]);
});
it('the actual Socket history handler uses the same durable file projection', async () => {
  const f = await fixture();
  addMessage({ ...f.identity, role: 'assistant', content: 'Output file: ' + f.dirty + '\nOutput file: ' + f.safe, toolCalls: f.r.toolRecords });
  const handlers: Record<string, Function> = {}, emitted = vi.fn();
  registerConversationHandlers({ data: { authenticatedUserId: f.identity.userId }, on: (event: string, fn: Function) => handlers[event] = fn, emit: emitted } as any, () => f.identity.userId);
  await handlers['chat:messages']({ conversationId: f.identity.conversationId });
  const messages = emitted.mock.calls.find(([event]) => event === 'chat:messages')?.[1].messages;
  const reply = messages.find((message: any) => message.type === 'lumi' && message.fileArtifacts?.some((file: any) => file.path === f.safe));
  expect(reply).toBeDefined(); expect(reply.content).not.toContain(f.dirty); expect(reply.fileArtifacts.map((file: any) => file.path)).toEqual([f.safe]);
});
it('binds old archive and download disclosure to their immutable bytes after a real clean overwrite', async () => {
  const f = await fixture();
  const entries = await archiveGeneratedOutputs(f.r.toolRecords.filter((record: any) => record.name === 'write_file'), { ...f.identity, taskId: f.r.taskId, source: 'chat' });
  const dirty = entries.find(entry => entry.sourcePath === f.dirty)!, safe = entries.find(entry => entry.sourcePath === f.safe)!;
  expect(dirty).toBeDefined(); expect(safe).toBeDefined();
  expect(dirty.sourceDisclosureEvidence?.sha256).toBe(dirty.sha256);
  expect(dirty.sourceDisclosureEvidence?.readbackId).toBe('dirty-report-readback');
  expect(dirty.sourceDisclosureEvidence?.literalIds).not.toContain('input-source-read');
  expect(dirty.sourceDisclosureEvidence?.privateIds).toEqual(['input-source-read']);
  const oldSnapshot = path.join(generatedKnowledgeDirectory(f.scope), dirty.filename);
  expect(fs.readFileSync(oldSnapshot, 'utf8')).toBe('REPORT_OK\nInternal reference: input-source-read');
  expect((await listGeneratedArchive(f.scope)).map(entry => entry.filename)).not.toContain(dirty.filename);
  expect((await listGeneratedArchive(f.scope)).map(entry => entry.filename)).toContain(safe.filename);
  const get = (route: string) => fetch(app.url + '/api' + route, { headers: f.cookie });
  expect((await get(generatedRoute(f, f.dirty))).status).toBe(403);
  expect((await get(generatedRoute(f, f.safe))).status).toBe(200);
  expect((await get('/files/download/' + dirty.filename + '?preview=1')).status).toBe(403);
  expect((await get('/files/download/' + safe.filename)).status).toBe(200);
  const files = (await (await get('/files/list')).json()).files;
  expect(files.map((file: any) => file.id)).not.toContain(dirty.filename); expect(files.map((file: any) => file.id)).toContain(safe.filename);
  const cleanTurn = await replaceWithCleanVersion(f);
  const [clean] = await archiveGeneratedOutputs([cleanTurn.records[0]], { ...cleanTurn.identity, taskId: cleanTurn.taskId, source: 'chat' });
  expect(clean.sha256).toBe(hash('CLEAN_REPORT')); expect(clean.id).not.toBe(dirty.id);
  expect(clean.sourceDisclosureEvidence?.privateIds).toEqual([]);
  expect(clean.sourceDisclosureEvidence?.readbackId).toBe('clean-readback');
  expect(isCompleteArchivedArtifactEvidence(clean.sourceDisclosureEvidence)).toBe(true);
  expect(isCompleteArchivedArtifactEvidence({ ...clean.sourceDisclosureEvidence!, readbackId: undefined })).toBe(false);
  const visible = await listGeneratedArchive(f.scope);
  expect(visible.map(entry => entry.id)).toContain(clean.id); expect(visible.map(entry => entry.id)).not.toContain(dirty.id);
  expect((await get(generatedRoute(f, f.dirty))).status).toBe(200);
  expect((await get('/files/download/' + dirty.filename)).status).toBe(403);
  expect((await get('/files/download/' + clean.filename)).status).toBe(200);
  expect(fs.readFileSync(oldSnapshot, 'utf8')).toBe('REPORT_OK\nInternal reference: input-source-read');
  expect(visible.every(entry => !('sourceDisclosureEvidence' in entry))).toBe(true);
  expect(deleteConversationData(f.identity.conversationId, f.identity.userId, 'personal', '')).toBeTruthy();
  expect(readDB().conversationActionReceipts.some((row: any) => row.taskId === f.r.taskId)).toBe(false);
  expect((await get('/files/download/' + dirty.filename)).status).toBe(403);
  expect((await get('/files/download/' + clean.filename)).status).toBe(200);
  expect((await listGeneratedArchiveProjection(f.scope)).withheldNames.has(dirty.filename)).toBe(true);
  expect(fs.readFileSync(oldSnapshot, 'utf8')).toBe('REPORT_OK\nInternal reference: input-source-read');
});
it('does not treat a serialized forged envelope as server provenance or hide an unrelated legacy safe artifact', async () => {
  const f = await fixture();
  const clean = f.r.toolRecords.find((record: any) => record.id === 'safe-report-write');
  const forged = JSON.parse(JSON.stringify(f.r.toolRecords)).map((record: any) => ({ ...record, taskId: 'foreign', requestId: 'foreign', envelope: { ...record.envelope, taskId: 'foreign', requestId: 'foreign' } }));
  expect(publicChatArtifactDelivery(forged, f.identity.conversationId).deliveryBlocked).toBe(false);
  expect(collectChatArtifacts([clean], f.identity.conversationId).map(file => file.path)).toEqual([f.safe]);
  const unrelated = path.join(path.dirname(f.safe), 'legacy.txt'); fs.writeFileSync(unrelated, 'old ordinary text');
  const projection = publicArtifactSnapshotDelivery(artifactContentSnapshot(unrelated), unrelated, { userId: f.identity.userId });
  expect(projection.deliveryBlocked).toBe(false);
});
it.each(['source', 'user'])('retains exact original %s literal exceptions without making provider task IDs private', async kind => {
  const f = kind === 'source' ? await fixture('The original source literally contains input-source-read.\nTAIL')
    : await fixture(undefined, ' The exact public literal "input-source-read" was supplied by the user.');
  expect(collectChatArtifacts(JSON.stringify(f.r.toolRecords), f.identity.conversationId).map(file => file.path).sort()).toEqual([f.dirty, f.safe].sort());
  expect(publicChatArtifactDelivery(f.r.toolRecords, f.identity.conversationId).deliveryBlocked).toBe(false);
  const provider = 'PUBLIC_PROVIDER_JOB_17';
  const extra = JSON.parse(JSON.stringify(f.r.toolRecords)); extra.forEach((record: any) => record.providerTaskId = provider);
  expect(publicChatArtifactDelivery(extra, f.identity.conversationId, { text: provider }).text).toBe(provider);
});

it('does not let JSON target/path ambiguity or a raw capability remove the real same-path readback', async () => {
  const f = await fixture(), serialized = JSON.parse(JSON.stringify(f.r.toolRecords));
  const reader = serialized.find((record: any) => record.id === 'dirty-report-readback');
  reader.arguments = { target: f.dirty, path: f.safe };
  reader.capability = { capabilityId: 'forged', lane: 'files', operation: 'create', sideEffects: [{ type: 'local_write' }] };
  const projected = publicChatArtifactDelivery(serialized, f.identity.conversationId, { requestId: f.identity.requestId });
  expect(projected.deliveryBlocked).toBe(true); expect(projected.artifacts.map(file => file.path)).toEqual([f.safe]);
  const omittedReadback = f.r.toolRecords.filter((record: any) => record.id !== 'dirty-report-readback');
  expect(publicChatArtifactDelivery(omittedReadback, f.identity.conversationId, f.identity).artifacts.map(file => file.path)).toEqual([f.safe]);
});
it.each(['system', 'agent'])('does not turn an internal %s history row into a user literal exemption', async role => {
  const f = await fixture(), db = readDatabaseTables(['interactions']);
  db.interactions.push({ ...f.identity, id: randomUUID(), role, message: 'input-source-read', timestamp: new Date().toISOString() } as any); commitDatabaseTables(db);
  const projection = publicChatArtifactDelivery(f.r.toolRecords, f.identity.conversationId, f.identity);
  expect(projection.deliveryBlocked).toBe(true); expect(projection.artifacts.map(file => file.path)).toEqual([f.safe]);
});

it('cleans a historical serialized answer containing a real call identity even when it has no attachment', async () => {
  const f = await fixture();
  const sourceOnly = JSON.stringify(f.r.toolRecords.filter((record: any) => record.id === 'input-source-read'));
  const old = { ...f.identity, role: 'assistant', toolCalls: sourceOnly, message: f.original + '\nInternal reference: input-source-read' };
  const visible = projectConversationMessageForCustomer(old);
  expect(visible.fileArtifacts).toEqual([]); expect(visible.message).toContain(f.original);
  expect(visible.message).not.toContain('input-source-read'); expect(visible.message).not.toContain('Internal reference:');
  expect(old.message).toContain('input-source-read');
});

it('keeps the actual rejected source call private without pretending it was a successful input read', async () => {
  const f = await fixture('Runtime contains input-source-read.\nTAIL', '', false);
  const visible = publicChatArtifactDelivery(f.r.toolRecords, f.identity.conversationId, f.identity);
  expect(visible.deliveryBlocked).toBe(true);
  expect(visible.artifacts.map(file => file.path)).toEqual([f.safe]);
  expect(f.r.toolRecords.find((record: any) => record.id === 'input-source-read').terminalVerification.status).toBe('failed');
});

it('withholds a real polluted copied version even without canonical readback and cannot wash it with a later clean source', async () => {
  const f = await fixture(undefined, '', true, false);
  expect(f.r.toolRecords.some((record: any) => record.name === 'read_file' && record.arguments.path === f.dirty)).toBe(false);
  expect(f.r.toolRecords.find((record: any) => record.id === 'dirty-report-write').terminalVerification.status).toBe('verified');
  expect(f.r.finalized.blocked).toBe(true);
  expect(readDB().conversationActionTasks.find((task: any) => task.id === f.r.taskId)?.status).toBe('blocked');
  expect(f.r.finalized.fileArtifacts.map((file: any) => file.path)).toEqual([f.safe]);
  const entries = await archiveGeneratedOutputs(f.r.toolRecords.filter((record: any) => record.name === 'write_file'), { ...f.identity, taskId: f.r.taskId, source: 'chat' });
  const dirty = entries.find(entry => entry.sourcePath === f.dirty)!;
  expect(dirty.sourceDisclosureEvidence?.readbackId).toBeUndefined();
  expect(isCompleteArchivedArtifactEvidence(dirty.sourceDisclosureEvidence)).toBe(false);
  expect(dirty.sourceDisclosureEvidence?.privateIds).toContain('input-source-read');
  expect((await listGeneratedArchive(f.scope)).map(entry => entry.filename)).not.toContain(dirty.filename);
  const get = (route: string) => fetch(app.url + '/api' + route, { headers: f.cookie });
  expect((await get(generatedRoute(f, f.dirty))).status).toBe(403);
  expect((await get('/files/download/' + dirty.filename)).status).toBe(403);
  const cleanTurn = await replaceWithCleanVersion(f);
  const [clean] = await archiveGeneratedOutputs([cleanTurn.records[0]], { ...cleanTurn.identity, taskId: cleanTurn.taskId, source: 'chat' });
  expect(clean.sha256).toBe(hash('CLEAN_REPORT'));
  expect(deleteConversationData(f.identity.conversationId, f.identity.userId, 'personal', '')).toBeTruthy();
  expect((await get('/files/download/' + dirty.filename)).status).toBe(403);
  expect((await get('/files/download/' + clean.filename)).status).toBe(200);
  expect(fs.readFileSync(path.join(generatedKnowledgeDirectory(f.scope), dirty.filename), 'utf8')).toBe('REPORT_OK\nInternal reference: input-source-read');
});

it('observes exact private identities across UTF8 chunk boundaries above the native read limit without inventing a readback', async () => {
  const f = await fixture(undefined, '', true, false, id => '汉'.repeat(21845) + id + '语'.repeat(45000));
  expect(fs.statSync(f.dirty).size).toBeGreaterThan(100 * 1024);
  const bytes = fs.readFileSync(f.dirty), expectedSHA = createHash('sha256').update(bytes).digest('hex');
  const observed = artifactContentSnapshot(f.dirty, ['input-source-read'])!;
  expect(observed.sha256).toBe(expectedSHA); expect(observed.text).toBeUndefined();
  expect(observed.observedIds).toContain('input-source-read');
  expect(bytes.indexOf(Buffer.from('input-source-read'))).toBe(65535);
  expect(bytes[196608] & 0xC0).toBe(0x80);
  expect(f.r.toolRecords.some((record: any) => record.name === 'read_file' && record.arguments.path === f.dirty)).toBe(false);
  expect(f.r.finalized.blocked).toBe(true);
  expect(f.r.finalized.fileArtifacts.map((file: any) => file.path)).toEqual([f.safe]);
  const entries = await archiveGeneratedOutputs(f.r.toolRecords.filter((record: any) => record.name === 'write_file'), { ...f.identity, taskId: f.r.taskId, source: 'chat' });
  const dirty = entries.find(entry => entry.sourcePath === f.dirty)!;
  expect(dirty.sourceDisclosureEvidence?.privateIds).toContain('input-source-read');
  expect(dirty.sourceDisclosureEvidence?.readbackId).toBeUndefined();
  expect(isCompleteArchivedArtifactEvidence(dirty.sourceDisclosureEvidence)).toBe(false);
  expect((await listGeneratedArchive(f.scope)).map(entry => entry.filename)).not.toContain(dirty.filename);
  expect((await fetch(app.url + '/api' + generatedRoute(f, f.dirty), { headers: f.cookie })).status).toBe(403);
  expect(deleteConversationData(f.identity.conversationId, f.identity.userId, 'personal', '')).toBeTruthy();
  expect((await fetch(app.url + '/api/files/download/' + dirty.filename, { headers: f.cookie })).status).toBe(403);
  const binary = path.join(path.dirname(f.dirty), 'binary.dat');
  fs.writeFileSync(binary, Buffer.concat([Buffer.from([255]), Buffer.from('input-source-read')]));
  const unknown = artifactContentSnapshot(binary, ['input-source-read']);
  expect(unknown?.text).toBeUndefined(); expect(unknown?.observedIds).toBeUndefined();
});
it('keeps an ordinary large clean UTF8 copy available without treating empty IDs as full native-read proof', async () => {
  const f = await fixture(undefined, '', true, false, () => '清洁正文'.repeat(12000));
  expect(fs.statSync(f.dirty).size).toBeGreaterThan(100 * 1024);
  const entries = await archiveGeneratedOutputs(f.r.toolRecords.filter((record: any) => record.name === 'write_file'), { ...f.identity, taskId: f.r.taskId, source: 'chat' });
  const clean = entries.find(entry => entry.sourcePath === f.dirty)!;
  expect(clean.sourceDisclosureEvidence?.privateIds).toEqual([]);
  expect(isCompleteArchivedArtifactEvidence(clean.sourceDisclosureEvidence)).toBe(false);
  expect((await listGeneratedArchive(f.scope)).map(entry => entry.filename)).toContain(clean.filename);
  const downloaded = await fetch(app.url + '/api/files/download/' + clean.filename, { headers: f.cookie });
  expect(downloaded.status).toBe(200); expect(await downloaded.text()).toBe('清洁正文'.repeat(12000));
  fs.appendFileSync(path.join(generatedKnowledgeDirectory(f.scope), clean.filename), 'CHANGED_ARCHIVE_BYTES');
  expect((await fetch(app.url + '/api/files/download/' + clean.filename, { headers: f.cookie })).status).toBe(403);
});

it('a real canonical server-only read is not a user input exemption when the original user request never named that path', async () => {
  const f = await fixture(), id = 'server-runtime-read-' + f.identity.requestId;
  const runtime = path.join(path.dirname(f.source), 'runtime.txt'); fs.writeFileSync(runtime, id);
  expect(f.text).not.toContain(runtime);
  const records = [];
  const calls = [
    ['read_file', { path: runtime }, id, 'Read the file \"' + runtime + '\".'],
    ['write_file', { path: f.dirty, content: 'RUNTIME_REPORT\nInternal reference: ' + id }, 'runtime-report-write-' + f.identity.requestId, 'Write a text file \"' + f.dirty + '\".'],
    ['read_file', { path: f.dirty }, 'runtime-report-read-' + f.identity.requestId, 'Read the file \"' + f.dirty + '\".'],
  ] as const;
  for (const [name, args, callId, task] of calls) {
    const record = await executeToolCall({ registry: f.registry, name, arguments: args, id: callId,
      context: { ...f.context, ...f.identity, taskId: f.r.taskId, turnId: f.identity.requestId, source: 'chat', actionIntent: task, routedTaskText: task } });
    expect(record.envelope?.status).toBe('verified_success');
    const db = readDatabaseTables(['conversationActionTasks', 'conversationActionTurns', 'conversationActionReceipts']);
    const row = db.conversationActionTasks.find((row: any) => row.id === f.r.taskId)!;
    const turn = db.conversationActionTurns.find((row: any) => row.taskId === f.r.taskId && row.requestId === f.identity.requestId)!;
    appendConversationActionReceipts(db, { task: row, records: [record], requestId: f.identity.requestId, turnId: record.turnId, turnRowId: turn.id });
    commitDatabaseTables(db); await flushDBOrThrow(); records.push(record);
  }
  const body = fs.readFileSync(f.dirty, 'utf8'), all = [...f.r.toolRecords, ...records];
  const inspection = inspectPublicExecutionReferences({ task: f.text, taskId: f.r.taskId, requestId: f.identity.requestId, toolCalls: all, completionRequest: { currentText: f.text } }, body);
  expect(inspection.privateReferences).toContain(id); expect(inspection.sourceText).not.toContain(id);
  const visible = publicChatArtifactDelivery(all, f.identity.conversationId, f.identity);
  expect(visible.deliveryBlocked).toBe(true); expect(visible.artifacts.map(file => file.path)).toEqual([f.safe]);
});

it.each([false, true])('keeps a real failed-only media scope private and never publishes its verified-looking container; user literal=%s', async userLiteral => {
  const userId = 'failed-media-' + randomUUID(), requestId = randomUUID();
  const conversationId = getOrCreateActiveConversation(userId, 'lumi', 'personal', '').id;
  const identity = { userId, conversationId, requestId, agentId: 'lumi', domain: 'personal' as const, orgId: '' };
  const db = readDatabaseTables(['users']); db.users.push({ uid: userId, username: userId, role: 'admin', password: 'fixture', balance: 0, createdAt: new Date().toISOString() } as any); commitDatabaseTables(db);
  const outputPath = path.join(String(process.env.LUMI_DATA_DIR), 'failed-' + requestId + '.mp4');
  const id = 'failed-media-call', text = 'Generate a video and save the result to \"' + outputPath + '\".'
    + (userLiteral ? ' The exact public literal \"' + id + '\" is supplied by the user.' : '');
  const registry = new ToolRegistry(), adapter = vi.fn(async () => {
    fs.writeFileSync(outputPath, 'UNVALIDATED_MEDIA_FIXTURE');
    return JSON.stringify({ ok: true, verified: true, verificationStatus: 'verified', status: 'completed', artifacts: [{ path: outputPath }], outputPath });
  });
  registry.register({ name: 'generate_video', description: 'Offline failed receipt boundary fixture', parameters: { type: 'object', properties: {} }, handler: adapter, permission: 'user', securityLevel: 'safe',
    capability: capabilityContract({ id: 'test.media.failed', family: 'test', lane: 'media', operation: 'create', risk: 'low',
      sideEffects: [{ type: 'local_write', scope: 'owned test output', reversible: true }],
      verification: { strategy: 'artifact', required: true, requiredFields: ['missingIndependentContainerProof'], successSignals: [], limitations: [] } }) });
  let round = 0; model.mockImplementation(async () => ++round === 1 ? { text: '', toolCalls: [{ id, name: 'generate_video', arguments: {} }] } : { text: 'The generated result was not verified.', toolCalls: [] });
  const result: any = await runLumiEntryTurn({ entry: { source: 'chat', channel: 'chat', historyLimit: 10, failureText: 'Not complete.', failureReason: 'fixture' }, identity, userText: text,
    authorization: captureRequestAuthorization(() => true, 'Revoked'), controller: new AbortController(),
    planning: { dispatch: { ...identity, text, source: 'chat', channel: 'chat', operationMode: 'assistant', targetIsLumi: true }, registry,
      personalityToolPolicy: { allowedTools: ['*'], forbiddenTools: [], requireConfirmation: [], maxIterations: 3 }, executionBoundary: 'trusted_local' },
    assemble: () => ({ systemPrompt: 'Offline receipt fixture.', model: { registry, config: { provider: 'deepseek', model: 'offline-fixture', userId, requestId }, getters: {}, maxIterations: 3,
      context: { authenticated: true, authRole: 'admin', localExecution: true, executionBoundary: 'trusted_local' as const, actionIntent: text, routedTaskText: text, allowLocalFileWrites: true, requestConfirmation: async () => true } } }), deliver: value => value } as any);
  expect(adapter).toHaveBeenCalledTimes(1);
  const record = result.toolRecords.find((record: any) => record.id === id)!;
  expect(record.envelope.status).toBe('failed'); expect(record.terminalVerification.status).not.toBe('verified');
  expect(JSON.parse(record.result).verified).toBe(true); expect(fs.existsSync(outputPath)).toBe(true);
  const rows = readDB().conversationActionReceipts.filter((row: any) => row.taskId === result.taskId && row.requestId === requestId);
  expect(rows.some((row: any) => row.outcome === 'verified_success')).toBe(false);
  const visible = publicChatArtifactDelivery(JSON.stringify(result.toolRecords), conversationId, { ...identity, taskId: result.taskId, text: id });
  expect(visible.artifacts).toEqual([]);
  if (userLiteral) { expect(visible.text).toBe(id); expect(visible.deliveryBlocked).toBe(false); }
  else { expect(visible.text).not.toContain(id); expect(visible.deliveryBlocked).toBe(true); }
});

it.each([false, true])('final scope preserves late actual call identity observations in the original copy before deleting the conversation; user literal=%s', async userLiteral => {
  const id = 'later-actual-read';
  const f = await fixture(undefined, userLiteral ? ' The exact public literal \"' + id + '\" is supplied by the user.' : '', true, false, () => 'REPORT_OK\nInternal reference: ' + id, id);
  const record = f.r.toolRecords.find((record: any) => record.id === id)!;
  expect(record.envelope.status).toBe('verified_success');
  expect(f.r.toolRecords.findIndex((record: any) => record.id === 'dirty-report-write')).toBeLessThan(f.r.toolRecords.indexOf(record));
  expect(f.r.toolRecords.some((record: any) => record.name === 'read_file' && record.arguments.path === f.dirty)).toBe(false);
  expect(f.r.finalized.blocked).toBe(true);
  const entries = await archiveGeneratedOutputs(f.r.toolRecords.filter((record: any) => record.name === 'write_file'), { ...f.identity, taskId: f.r.taskId, source: 'chat' });
  const dirty = entries.find(entry => entry.sourcePath === f.dirty)!;
  const producer = f.r.toolRecords.find((record: any) => record.id === 'dirty-report-write')!;
  expect(producer.arguments.path).toContain('/');
  expect(dirty.sourcePath).toBe(path.resolve(producer.arguments.path));
  expect(dirty.sourcePath).not.toBe(producer.arguments.path);
  expect(dirty.sourceDisclosureEvidence?.privateIds).toContain(id);
  expect(dirty.sourceDisclosureEvidence?.readbackId).toBeUndefined();
  expect(isCompleteArchivedArtifactEvidence(dirty.sourceDisclosureEvidence)).toBe(false);
  if (userLiteral) {
    expect(dirty.sourceDisclosureEvidence?.literalIds).toContain(id);
    const cards = f.r.finalized.fileArtifacts;
    expect(cards).toHaveLength(2);
    expect(cards.filter((file: any) => sameArtifactPath(file.path, f.dirty))).toHaveLength(1);
    expect(cards.filter((file: any) => sameArtifactPath(file.path, f.safe))).toHaveLength(1);
  }
  else { expect(dirty.sourceDisclosureEvidence?.literalIds).not.toContain(id); expect(f.r.finalized.fileArtifacts.map((file: any) => file.path)).toEqual([f.safe]); }
  expect(deleteConversationData(f.identity.conversationId, f.identity.userId, 'personal', '')).toBeTruthy();
  expect(readDB().conversationActionReceipts.some((row: any) => row.taskId === f.r.taskId)).toBe(false);
  const response = await fetch(app.url + '/api/files/download/' + dirty.filename, { headers: f.cookie });
  expect(response.status).toBe(userLiteral ? 200 : 403);
  if (userLiteral) expect(await response.text()).toBe('REPORT_OK\nInternal reference: ' + id);
});
