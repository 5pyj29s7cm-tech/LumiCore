import { makeApp, JWT_SECRET } from './helpers';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import jwt from 'jsonwebtoken';
import { beforeAll, afterAll, beforeEach, afterEach, expect, it } from 'vitest';
import { readDatabaseTables, commitDatabaseTables, querySQL, withDatabaseSqlWriteLock } from '../db_layer';
import { addMessage, getOrCreateActiveConversation, prepareConversationActionExecution, deleteConversationData } from '../server/conversation/manager';
import { createConversationReceiptObserver } from '../server/conversation/execution_receipt_archive';
import { ToolRegistry } from '../server/tools/registry';
import { executeToolCall } from '../server/tools/execution_engine';
import { capabilityContract } from '../server/tools/capability_contracts';
import { designerDataMergeReceiptPath, legacyLegalDataFingerprint } from '../server/config/data_path';
import { archiveGeneratedOutputs, assertGeneratedSourceFilePublic } from '../server/files/generated_archive';

const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const write = (file: string, body: string) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, body); };
let app: Awaited<ReturnType<typeof makeApp>>, home: string, originalRoot: string | undefined;
beforeAll(async () => { app = await makeApp(); app.apiRouter.use((await import('../routes/files')).default); });
afterAll(() => app?.cleanup());
beforeEach(() => {
  originalRoot = process.env.LUMI_DATA_DIR;
  home = fs.mkdtempSync(path.join(String(process.env.LUMI_TEST_TMPDIR || os.tmpdir()), 'migrated-download-'));
  process.env.LUMI_DATA_DIR = path.join(home, 'LumiCore');
});
afterEach(() => {
  if (originalRoot === undefined) delete process.env.LUMI_DATA_DIR; else process.env.LUMI_DATA_DIR = originalRoot;
  if (path.dirname(home) !== path.resolve(String(process.env.LUMI_TEST_TMPDIR || os.tmpdir())) || !path.basename(home).startsWith('migrated-download-')) throw Error('Unsafe fixture cleanup');
  fs.rmSync(home, { recursive: true, force: true });
});

async function fixture(dirty = false, extension = 'dxf', renameChain = false) {
  const source = path.join(home, 'LumiCore-Designer'), target = String(process.env.LUMI_DATA_DIR);
  const originalSource = renameChain ? path.join(home, 'LumiOS-Designer') : source;
  const userId = 'download-' + randomUUID(), requestId = randomUUID();
  const conversationId = getOrCreateActiveConversation(userId, 'lumi', 'personal', '').id;
  const identity = { userId, requestId, conversationId, agentId: 'lumi', domain: 'personal' as const, orgId: '' };
  const relative = `generated/synthetic-${randomUUID()}.${extension}`;
  const oldFile = path.join(originalSource, 'data', relative), newFile = path.join(target, 'data', relative);
  const body = dirty ? 'SYNTHETIC PRIVATE REQUEST: ' + requestId : 'SYNTHETIC CAD/PRESENTATION BYTES';
  write(oldFile, body); write(newFile, body);
  const user = readDatabaseTables(['users']);
  user.users.push({ uid: userId, username: userId, role: 'admin', password: 'fixture', balance: 0, createdAt: new Date().toISOString() } as any);
  commitDatabaseTables(user);
  const text = 'Create the file "' + oldFile + '" and read it back.';
  const userMessageId = addMessage({ ...identity, role: 'user', content: text, deferActionPreparation: true });
  const prepared = prepareConversationActionExecution({ conversationId, userId, requestId, userMessageId, userText: text,
    forceTask: true, toolPolicy: { allowedTools: ['*'], forbiddenTools: [], requireConfirmation: [], maxIterations: 3 } });
  if (!prepared.state) throw Error('Missing synthetic accepted task');
  const taskId = prepared.state.taskId, turnRowId = 'turnRowId' in prepared ? prepared.turnRowId : undefined;
  const registry = new ToolRegistry();
  registry.register({ name: 'create_ppt', description: 'Synthetic existing local artifact receipt', permission: 'user', securityLevel: 'safe',
    parameters: { type: 'object', properties: { outputPath: { type: 'string' } }, required: ['outputPath'] },
    capability: capabilityContract({ id: 'test.migrated.artifact', family: 'test', lane: 'office', operation: 'create', risk: 'low',
      sideEffects: [{ type: 'local_write', scope: 'synthetic named file', reversible: true }], verification: { strategy: 'artifact', required: true,
        requiredFields: ['ok', 'status', 'path'], requiredValues: { ok: true }, successStatuses: ['created'], requiredArtifacts: ['path'], successSignals: [], limitations: [] } }),
    handler: async () => JSON.stringify({ ok: true, status: 'created', path: oldFile, size: Buffer.byteLength(body) }) });
  registry.register({ name: 'read_file', description: 'Synthetic local readback', permission: 'user', securityLevel: 'safe',
    parameters: { type: 'object', properties: { path: { type: 'string' } } }, handler: async () => body });
  const observer = createConversationReceiptObserver({ ...identity, taskId, turnRowId }, () => true);
  const context = { ...identity, taskId, turnRowId, source: 'chat', authenticated: true, authRole: 'admin' as const,
    localExecution: true, executionBoundary: 'trusted_local' as const, actionIntent: text, routedTaskText: text,
    allowLocalFileWrites: true, onToolRecord: observer.onToolRecord,
    toolPolicy: { allowedTools: ['*'], forbiddenTools: [], requireConfirmation: [], maxIterations: 3 } };
  const producer = await executeToolCall({ registry, name: 'create_ppt', id: 'producer-' + requestId, arguments: { outputPath: oldFile }, context });
  const readback = await executeToolCall({ registry, name: 'read_file', id: 'readback-' + requestId, arguments: { path: oldFile }, context });
  expect(producer.terminalVerification?.status, producer.error).toBe('verified');
  expect(readback.terminalVerification?.status, readback.error).toBe('verified');
  addMessage({ ...identity, role: 'assistant', content: 'Synthetic artifact receipt.', toolCalls: [producer, readback] });
  if (renameChain) {
    fs.renameSync(originalSource, source);
    const rootHash = (root: string) => hash(path.normalize(path.resolve(root)).toLowerCase());
    const prepared = { version: 1, product: 'Lumi Designer', migrationId: 'r'.repeat(40), phase: 'prepared', method: 'atomic_directory_rename',
      migratedFrom: originalSource, migratedTo: source, sourceRootDigest: rootHash(originalSource), targetRootDigest: rootHash(source), preparedAt: '2026-10-30T00:00:00.000Z' };
    const raw = JSON.stringify(prepared); write(path.join(source, 'runtime/product-data-migration.json'), raw);
    write(path.join(source, 'runtime/product-data-migration-verified.json'), JSON.stringify({ version: 1, product: 'Lumi Designer',
      migrationReceipt: 'product-data-migration.json', migrationId: prepared.migrationId, migrationReceiptSha256: hash(raw), quickCheck: 'ok',
      databaseBytes: 4096, userCount: 1, conversationCount: 1, interactionCount: 2, verifiedAt: '2026-10-30T00:01:00.000Z' }));
  }
  const manifestPath = path.join(home, 'private-backup/maintenance-manifest.json');
  const manifest = { sourceVariant: 'designer', sourceRoot: source, targetRoot: target, inputDigest: 'a'.repeat(64), migratedFiles: [{ path: relative, sha256: hash(body) }] };
  const raw = JSON.stringify(manifest); write(manifestPath, raw);
  const receiptPath = designerDataMergeReceiptPath(source, target);
  write(receiptPath, JSON.stringify({ version: 1, phase: 'completed', sourceVariant: 'designer', sourceRoot: source, targetRoot: target,
    sourceFingerprint: legacyLegalDataFingerprint(source), inputDigest: manifest.inputDigest, maintenanceManifest: manifestPath, maintenanceManifestSha256: hash(raw) }));
  if (!renameChain) fs.renameSync(source, path.join(home, 'offline-source-backup'));
  expect(fs.existsSync(oldFile)).toBe(false);
  const cookie = (owner = userId) => ({ Cookie: 'token=' + jwt.sign({ uid: owner, username: owner, role: 'admin' }, JWT_SECRET) });
  const get = (file = oldFile, owner = userId, conversation: string | undefined = conversationId) => fetch(app.url + '/api/files/generated?path=' + encodeURIComponent(file)
    + (conversation === undefined ? '' : '&conversationId=' + encodeURIComponent(conversation)), { headers: cookie(owner) });
  return { source, target, oldFile, newFile, body, manifestPath, receiptPath, relative, get, userId, conversationId, cookie,
    records: [producer, readback], identity: { ...identity, taskId } };
}

it.each(['dxf', 'pptx'])('downloads a verified migrated %s after the original root is moved away', async extension => {
  const f = await fixture(false, extension), response = await f.get();
  expect(response.status, await response.clone().text()).toBe(200);
  expect(await response.text()).toBe(f.body);
  expect(response.headers.get('cache-control')).toBe('no-store');
});
it('matches a current target link against the unchanged historical tool-call path', async () => {
  const f = await fixture(), response = await f.get(f.newFile);
  expect(response.status, await response.clone().text()).toBe(200); expect(await response.text()).toBe(f.body);
});
it('rejects a different account and an unrelated conversation', async () => {
  const f = await fixture();
  for (const response of [await f.get(f.oldFile, 'wrong-owner'), await f.get(f.newFile, f.userId, 'unrelated-conversation')]) {
    expect(response.status).toBe(403); expect(await response.text()).not.toContain(f.body);
  }
});
it.each(['manifest', 'target', 'link'] as const)('rejects a changed migrated download: %s', async kind => {
  const f = await fixture();
  if (kind === 'manifest') fs.appendFileSync(f.manifestPath, ' ');
  if (kind === 'target') write(f.newFile, 'MODIFIED CONTENT');
  if (kind === 'link') { const dir = path.dirname(f.newFile), elsewhere = path.join(home, 'redirected'); fs.renameSync(dir, elsewhere); fs.symlinkSync(elsewhere, dir, 'junction'); }
  const response = await f.get(); expect(response.status).toBeGreaterThanOrEqual(400);
  expect(await response.text()).not.toContain(f.body);
});
it('does not grant an old external-root link unscoped access just because its copy is under generated', async () => {
  const f = await fixture(); const response = await fetch(app.url + '/api/files/generated?path=' + encodeURIComponent(f.oldFile), { headers: f.cookie() });
  expect(response.status).toBe(403);
});
it.each(['old', 'current'] as const)('retains private-output denial under the %s path identity', async which => {
  const f = await fixture(true); const response = await f.get(which === 'old' ? f.oldFile : f.newFile);
  expect(response.status).toBe(403); expect(await response.text()).not.toContain(f.body);
});
it('checks historical canonical disclosure again at the generated-source guard', async () => {
  const f = await fixture(true);
  await expect(assertGeneratedSourceFilePublic({ userId: f.userId, domain: 'personal' }, f.newFile)).rejects.toThrow(/not available for public delivery/);
});
it.each([false, true])('retains old archived disclosure after deleting its conversation (history reconciliation=%s)', async historyReconciliation => {
  const f = await fixture(true), scope = { userId: f.userId, domain: 'personal' as const };
  const archiveContext = historyReconciliation
    ? { userId: f.userId, conversationId: f.conversationId, domain: 'personal' as const, source: 'chat' }
    : { ...f.identity, source: 'chat' };
  const archived = await archiveGeneratedOutputs(f.records, archiveContext);
  expect(archived).toHaveLength(1);
  expect(archived[0].sourceDisclosureEvidence?.privateIds).toContain(f.identity.requestId);
  // Model the unchanged legacy archive identity with real archived evidence.
  const rows = await querySQL<{ scope: string; payload: string }>('SELECT scope,payload FROM generated_archive WHERE id=?', [archived[0].id]);
  const entry = { ...JSON.parse(rows[0].payload), sourcePath: f.oldFile };
  await withDatabaseSqlWriteLock(({ run }) => run('UPDATE generated_archive SET sourcePath=?,payload=? WHERE scope=? AND id=?', [f.oldFile, JSON.stringify(entry), rows[0].scope, archived[0].id]));
  expect(deleteConversationData(f.conversationId, f.userId, 'personal', '')).toBeTruthy();
  await expect(assertGeneratedSourceFilePublic(scope, f.newFile)).rejects.toThrow(/not available for public delivery/);
});
it('keeps ordinary current generated-file downloads available to the local administrator', async () => {
  const f = await fixture(), file = path.join(f.target, 'data/generated/current.txt'); write(file, 'CURRENT SAFE FILE');
  const response = await fetch(app.url + '/api/files/generated?path=' + encodeURIComponent(file), { headers: f.cookie() });
  expect(response.status).toBe(200); expect(await response.text()).toBe('CURRENT SAFE FILE');
});

it.each(['old', 'current'] as const)('downloads the %s path only with both rename receipts, merge proof and original owned producer evidence', async which => {
  const f = await fixture(false, 'dxf', true), response = await f.get(which === 'old' ? f.oldFile : f.newFile);
  expect(response.status, await response.clone().text()).toBe(200); expect(await response.text()).toBe(f.body);
});
it('does not let the verified rename chain replace missing canonical producer authority or another account', async () => {
  const f = await fixture(false, 'dxf', true);
  expect((await f.get(f.oldFile, 'wrong-owner')).status).toBe(403);
  const state = readDatabaseTables(['conversationActionReceipts']);
  state.conversationActionReceipts = state.conversationActionReceipts.filter(receipt => receipt.taskId !== f.identity.taskId);
  commitDatabaseTables(state);
  for (const file of [f.oldFile, f.newFile]) {
    const response = await f.get(file); expect(response.status).toBe(403); expect(await response.text()).not.toContain(f.body);
  }
});
it('retains private content denial across the full rename and reviewed merge chain', async () => {
  const f = await fixture(true, 'dxf', true);
  for (const file of [f.oldFile, f.newFile]) {
    const response = await f.get(file); expect(response.status).toBe(403); expect(await response.text()).not.toContain(f.body);
  }
});
