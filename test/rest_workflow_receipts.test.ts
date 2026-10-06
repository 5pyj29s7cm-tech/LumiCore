import { makeApp, JWT_SECRET } from './helpers';
import fs from 'node:fs';
import path from 'node:path';
import jwt from 'jsonwebtoken';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushDBOrThrow, readDB } from '../db_layer';
import { mountChatRoutes } from '../server/routes/chat_routes';
import { issueDesktopSessionProof, DESKTOP_SESSION_HEADER } from '../server/config/desktop_bootstrap';
import { startIndustryWorkflow, getIndustryWorkflowTask } from '../server/industry/workflow_service';
import { executeToolCall } from '../server/tools/execution_engine';
import { ToolRegistry, toolRegistry } from '../server/tools/registry';
import { registerAllTools } from '../server/tools/definitions';
import * as org from '../server/org/db';

const model = vi.hoisted(() => ({ run: vi.fn(), flushGate: null as Promise<void> | null, flushReached: false, failFlush: false }));
vi.mock('../server/llm/adapter', async original => ({
  ...(await original<typeof import('../server/llm/adapter')>()), runWithTools: model.run,
}));
vi.mock('../db_layer', async original => {
  const actual = await original<typeof import('../db_layer')>();
  return { ...actual, flushDBOrThrow: async () => {
    if (model.failFlush) throw new Error('Synthetic final-state storage failure');
    if (model.flushGate) { model.flushReached = true; await model.flushGate; }
    await actual.flushDBOrThrow();
  } };
});
let baseUrl: string;
let cleanup: () => void;
let sequence = 0;
const nativeIdentity = {
  schemaVersion: 1 as const, clientKind: 'tauri' as const, pid: process.pid,
  startedAtUnixMs: Math.floor((Date.now() - 10_000) / 1_000) * 1_000, executablePath: process.execPath,
  executableSha256: 'd'.repeat(64), binaryHashUnavailable: false, buildId: 'c'.repeat(40),
  buildIdSemantics: 'baseline_commit' as const, sourceFingerprint: 'e'.repeat(64), sourceDirty: false, appVersion: '3.1.0',
};
beforeAll(async () => {
  const app = await makeApp(); baseUrl = app.url; cleanup = app.cleanup;
  const unavailable = () => null;
  mountChatRoutes(app.apiRouter, JWT_SECRET, { getDeepSeek: unavailable, getGemini: unavailable, getOpenAI: unavailable, getAnthropic: unavailable, getQwen: unavailable });
  registerAllTools(toolRegistry);
});
beforeEach(() => {
  model.run.mockReset().mockRejectedValue(new Error('No additional model calls in fixture'));
  model.flushGate = null; model.flushReached = false; model.failFlush = false;
});
afterAll(() => cleanup());

function fixture(work = false) {
  const userId = `rest-workflow-${++sequence}`;
  const orgId = work ? org.createOrg('Synthetic', `${userId}-org`, userId).id : '';
  if (orgId) org.addMember(orgId, userId, 'owner');
  const scope = { userId, domain: work ? 'work' as const : 'personal' as const, orgId };
  const target = path.join(String(process.env.LUMI_DATA_DIR), `${userId}.txt`);
  fs.writeFileSync(target, 'orders 10; revenue 500');
  const sourceInput = `请读取 ${target} 的经营数据，并计算销售额和订单指标。`;
  const started = startIndustryWorkflow({ ...scope, entryId: 'today-operations', sourceInput });
  const token = jwt.sign({ uid: userId, role: 'admin', ...(orgId ? { orgId, orgRole: 'owner' } : {}) }, JWT_SECRET);
  const proof = issueDesktopSessionProof(userId, nativeIdentity);
  const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, [DESKTOP_SESSION_HEADER]: proof.proof };
  const send = (stream = false, signal?: AbortSignal) => fetch(`${baseUrl}/api/chat${stream ? '?stream=true' : ''}`, {
    method: 'POST', headers, signal, body: JSON.stringify({ message: sourceInput, industryWorkflowTaskId: started.task.id, industryWorkflowSourceInput: sourceInput }),
  });
  const registry = new ToolRegistry();
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  let entered!: () => void; const entry = new Promise<void>(resolve => { entered = resolve; });
  registry.register({ name: 'read_file', description: 'Isolated workflow read', permission: 'public', securityLevel: 'safe',
    parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    handler: async () => { entered(); await gate; return fs.readFileSync(target, 'utf8'); } });
  let execution: ReturnType<typeof executeToolCall>;
  const install = (mode: 'late' | 'disconnect' | 'normal', afterRecord?: () => void) => model.run.mockImplementationOnce(async (...args: any[]) => {
    execution = executeToolCall({ registry, name: 'read_file', id: `${userId}-read`, arguments: { path: target }, context: args[11] });
    await Promise.race([entry, execution.then(record => { throw Error(`Read did not enter handler: ${JSON.stringify(record)}`); })]);
    if (mode === 'normal') {
      release(); const record = await execution; await args[3]?.(record);
      afterRecord?.();
      return { text: '订单为10单，销售额为500元。', toolCalls: [record], usageRecords: [] };
    }
    if (mode === 'disconnect' && !args[2].signal.aborted) await new Promise(resolve => args[2].signal.addEventListener('abort', resolve, { once: true }));
    throw Error('Synthetic model stopped while the tool was still pending');
  });
  return { scope, started, send, install, release, entry, execution: () => execution,
    task: () => getIndustryWorkflowTask(scope, started.task.id)!,
    receipts: () => readDB().conversationActionReceipts.filter((row: any) => row.taskId === started.conversationTaskId && row.toolName === 'read_file') };
}

describe('REST workflow canonical receipt lifecycle', () => {
  it.each(['late', 'disconnect'] as const)('archives original tool evidence after %s without reviving the workflow', async mode => {
    const f = fixture(); f.install(mode);
    const controller = new AbortController();
    const pending = f.send(false, controller.signal);
    const rejected = mode === 'disconnect' ? expect(pending).rejects.toThrow() : undefined;
    await f.entry;
    if (mode === 'disconnect') { controller.abort(); await rejected; }
    else expect((await pending).status).toBe(500);
    await vi.waitFor(() => expect(f.task().status).toBe(mode === 'disconnect' ? 'cancelled' : 'blocked'));
    f.release(); await f.execution(); await flushDBOrThrow();
    expect(f.receipts()).toHaveLength(1);
    expect(f.task().status).toBe(mode === 'disconnect' ? 'cancelled' : 'blocked');
    expect(f.task().metadata.industryObservedTools).toHaveLength(1);
    expect(model.run).toHaveBeenCalledOnce();
  });

  it.each([false, true])('saves each result once and exposes the same workflow status for stream=%s', async stream => {
    const f = fixture(); f.install('normal');
    const response = await f.send(stream);
    expect(response.status).toBe(200);
    const payload = stream
      ? (await response.text()).trim().split('\n\n').map(frame => JSON.parse(frame.replace(/^data: /, ''))).at(-1)
      : await response.json();
    expect(payload.industryWorkflow).toMatchObject({ taskId: f.started.task.id, status: f.task().status });
    expect(f.receipts()).toHaveLength(1);
    expect(f.task().metadata.industryObservedTools).toHaveLength(1);
  });

  it('does not retain organization output after membership is removed and re-created', async () => {
    const f = fixture(true); f.install('late');
    expect((await f.send()).status).toBe(500);
    org.removeMember(f.scope.orgId, f.scope.userId);
    org.addMember(f.scope.orgId, f.scope.userId, 'owner');
    f.release(); await f.execution(); await flushDBOrThrow();
    expect(f.receipts()).toHaveLength(0);
  });

  it('aborts active organization execution and closes the HTTP reply when membership is revoked', async () => {
    const f = fixture(true); f.install('disconnect');
    const pending = f.send();
    await f.entry;
    org.removeMember(f.scope.orgId, f.scope.userId);
    const response = await pending;
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: 'CHAT_CONVERSATION_REFRESH_FAILED' });
    expect(model.run.mock.calls[0][2].signal.aborted).toBe(true);
    f.release(); await f.execution(); await flushDBOrThrow();
    expect(f.receipts()).toHaveLength(0);
    expect(f.task().status).toBe('cancelled');
  });

  it.each([false, true])('waits for final state persistence before sending the terminal response (stream=%s)', async stream => {
    const f = fixture();
    let releaseSave!: () => void;
    const saveGate = new Promise<void>(resolve => { releaseSave = resolve; });
    f.install('normal', () => { model.flushGate = saveGate; });
    let delivered = false;
    const pending = f.send(stream).then(async response => { await response.text(); delivered = true; return response.status; });
    try {
      await vi.waitFor(() => expect(model.flushReached).toBe(true));
      expect(delivered).toBe(false);
    } finally { releaseSave(); }
    expect(await pending).toBe(200);
  });

  it('returns an error when the terminal state cannot be saved', async () => {
    const f = fixture(); f.install('normal', () => { model.failFlush = true; });
    const response = await f.send();
    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({ error: expect.any(String), code: expect.any(String) });
  });

  it('rejects a deleted business conversation anchor without running a model or redirecting work', async () => {
    const f = fixture(); f.install('normal');
    const { startNewConversation, getOrCreateActiveConversation } = await import('../server/conversation/manager');
    const { writeDB } = await import('../db_layer');
    const boundId = f.task().metadata.industryWorkflow.conversationId;
    const active = startNewConversation(f.scope.userId, 'lumi', f.scope.domain, f.scope.orgId);
    const db = readDB(); db.conversations = db.conversations.filter((row: any) => row.id !== boundId); writeDB(db);
    const response = await f.send();
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: 'CHAT_CONVERSATION_REFRESH_FAILED' });
    expect(model.run).not.toHaveBeenCalled();
    expect(getOrCreateActiveConversation(f.scope.userId, 'lumi', f.scope.domain, f.scope.orgId).id).toBe(active.id);
  });
});
