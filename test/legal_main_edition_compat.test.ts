import { makeApp, JWT_SECRET } from './helpers';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import jwt from 'jsonwebtoken';
import { createHash, randomUUID } from 'node:crypto';
import { mountChatRoutes } from '../server/routes/chat_routes';
import { toolRegistry } from '../server/tools/registry';
import { executeToolCall } from '../server/tools/execution_engine';
import { encodeToolResult } from '../server/tools/result_envelope';
import { mcpManager } from '../server/mcp/client';
import { addMember, createOrg, removeMember } from '../server/org/db';
import * as Cases from '../server/org/legal_cases';

const nativeFetch = globalThis.fetch;
const names = ['legal_search_subject_cases', 'legal_search_public_footprint'] as const;
const owner = 'main-edition-compat-owner';
const subject = 'SyntheticCo';
const shareholders = JSON.stringify({ Result: { Name: subject, Shareholders: [{ Name: 'Synthetic Holder', StockPercent: '50.00%', StockCount: '100 units' }] } });
const caseSource = JSON.stringify({ Result: { Party: subject, Cases: [{ CaseNumber: 'SYNTHETIC-CASE-ONLY' }] } });
const snippets = 'SyntheticCo candidate | unverified search excerpt | https://fixture.invalid/source';
const secret = 'synthetic-key-never-echo';
const sha = (text: string) => createHash('sha256').update(text).digest('hex');
let app: Awaited<ReturnType<typeof makeApp>>;
const context = { userId: owner, domain: 'personal', authenticated: true, authRole: 'user', source: 'legal-direct-tool' } as any;
const token = (uid = owner, orgId?: string) => jwt.sign({ uid, username: uid, role: 'user', ...(orgId ? { orgId } : {}) }, JWT_SECRET);
async function request(name: string, args: Record<string, unknown> = {}, auth: string | null = token()) {
  const response = await nativeFetch(app.url + '/api/legal/tool/' + name, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...(auth ? { Authorization: 'Bearer ' + auth } : {}) },
    body: JSON.stringify({ args: { name: subject, persistCase: false, ...args } }), signal: AbortSignal.timeout(10_000),
  });
  return { status: response.status, data: await response.json() as any };
}
const run = (name: string, args: Record<string, unknown> = {}, extraContext: Record<string, unknown> = {}) => executeToolCall({ registry: toolRegistry, name, arguments: { name: subject, ...args }, context: { ...context, ...extraContext } });

beforeAll(async () => {
  app = await makeApp();
  const { registerAllTools } = await import('../server/tools/definitions');
  registerAllTools(toolRegistry);
  const nil = () => null;
  mountChatRoutes(app.apiRouter, JWT_SECRET, { getDeepSeek: nil, getGemini: nil, getOpenAI: nil, getAnthropic: nil, getQwen: nil });
});
afterAll(() => app.cleanup());
beforeEach(() => {
  for (const key of ['QICHACHA_API_KEY', 'QICHACHA_APP_KEY', 'QICHACHA_SECRET_KEY', 'QICHACHA_BASE_URL', 'TIANYANCHA_API_KEY', 'QIXINBAO_API_KEY']) vi.stubEnv(key, '');
  vi.stubEnv('QICHACHA_API_KEY', secret);
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('No external HTTP in edition compatibility fixtures'); }));
  vi.spyOn(mcpManager, 'callToolForServer').mockImplementation(async (_server, tool) => tool === 'get_shareholder_info' ? shareholders : caseSource);
  vi.spyOn(toolRegistry.get('web_search')!, 'handler').mockResolvedValue(encodeToolResult(snippets, { ok: true, status: 'observed', provider: 'fixture', resultCount: 1 }));
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe('Main compatibility with Legal query contracts', () => {
  it('registers both exact tools once through the complete production catalog with explicit read-only contracts', () => {
    for (const name of names) {
      expect(toolRegistry.getToolDeclarations().filter(x => x.function.name === name)).toHaveLength(1);
      const tool = toolRegistry.get(name)!;
      expect(tool).toMatchObject({ permission: 'user', capability: { operation: 'observe', sideEffects: [{ type: 'network_read' }] } });
      expect(toolRegistry.getCapabilityManifest().find(entry => entry.toolName === name)?.evidence?.declarationSource).toBe('tool_definition');
    }
  });
  it('returns the exact shareholder source text and digest through the authenticated API, without another paid query or persistence', async () => {
    const result = await request('legal_company_database_lookup', { queryType: 'shareholders', sourceIds: ['qichacha'] });
    expect(result.status).toBe(200);
    expect(result.data.receipt).toMatchObject({ ok: true, status: 'observed', persisted: false, changedCaseIds: [], sourceResults: [{ sourceTool: 'get_shareholder_info', subject, queryType: 'shareholders', sourceText: shareholders, sourceTextSha256: sha(shareholders) }] });
    expect(result.data.receipt.sourceResults).toHaveLength(1);
    expect(result.data.verification.status).toBe('verified');
    expect(mcpManager.callToolForServer).toHaveBeenCalledExactlyOnceWith('qcc-company', 'get_shareholder_info', { searchKey: subject }, expect.any(Object));
    expect(fetch).not.toHaveBeenCalled();
    expect(result.data.text).not.toContain(secret);
  });
  it.each(names)('routes %s for an authenticated personal user without case mutation', async name => {
    const item = Cases.createCase(Cases.legalWorkspaceNamespace(owner), owner, { title: 'Synthetic original ' + randomUUID() });
    const before = JSON.stringify(Cases.getCase(item.orgId, item.id, owner));
    const result = await request(name, { caseId: item.id, persistCase: true, confirmedForKb: true });
    expect(result.status).toBe(200);
    expect(result.data.receipt).toMatchObject({ ok: true, status: 'observed', persisted: false, changedCaseIds: [], articleIds: [], artifacts: [] });
    expect(result.data.verification.status).toBe('verified');
    expect(JSON.stringify(Cases.getCase(item.orgId, item.id, owner))).toBe(before);
    expect(fetch).not.toHaveBeenCalled();
    if (name === names[0]) {
      expect(mcpManager.callToolForServer).toHaveBeenCalledExactlyOnceWith('qcc-case', 'get_judicial_case_search', { party: subject }, expect.any(Object));
      expect(result.data.text).toContain(caseSource);
      expect(result.data.receipt.sourceResults[0]).toMatchObject({ subject, queryScope: 'cases', sourceTextSha256: sha(caseSource) });
    } else {
      expect(toolRegistry.get('web_search')!.handler).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ query: JSON.stringify(subject), maxResults: 5 }), expect.objectContaining({ userId: owner, authenticated: true }));
      expect(result.data.receipt.sourceResults[0]).toMatchObject({ sourceText: snippets, sourceTextSha256: sha(snippets), resultCount: 1 });
      expect(mcpManager.callToolForServer).not.toHaveBeenCalled();
    }
  });
  it('routes the expressly selected enforcement source without an extra case or registration query', async () => {
    const result = await request(names[0], { scope: 'enforcement' });
    expect(result.status).toBe(200); expect(result.data.receipt.ok).toBe(true);
    expect(mcpManager.callToolForServer).toHaveBeenCalledExactlyOnceWith('qcc-risk', 'get_judgment_debtor_info', { searchKey: subject }, expect.any(Object));
  });
  it.each(names)('rejects anonymous API access to %s before any source request', async name => {
    expect((await request(name, {}, null)).status).toBe(401);
    expect(mcpManager.callToolForServer).not.toHaveBeenCalled(); expect(toolRegistry.get('web_search')!.handler).not.toHaveBeenCalled();
  });
  it.each(names)('preserves viewer denial and current membership checks for %s', async name => {
    const org = createOrg('Synthetic compatibility org', randomUUID(), owner);
    const viewer = 'viewer-' + randomUUID(), member = 'member-' + randomUUID();
    addMember(org.id, viewer, 'viewer'); addMember(org.id, member, 'member');
    expect((await request(name, {}, token(viewer, org.id))).status).toBe(403);
    expect(mcpManager.callToolForServer).not.toHaveBeenCalled(); expect(toolRegistry.get('web_search')!.handler).not.toHaveBeenCalled();
    expect((await request(name, {}, token(member, org.id))).status).toBe(200);
    vi.mocked(mcpManager.callToolForServer).mockClear(); vi.mocked(toolRegistry.get('web_search')!.handler).mockClear();
    removeMember(org.id, member);
    expect((await request(name, {}, token(member, org.id))).status).toBe(403);
    expect(mcpManager.callToolForServer).not.toHaveBeenCalled(); expect(toolRegistry.get('web_search')!.handler).not.toHaveBeenCalled();
  });
  it.each(names)('rejects another owner case for %s before source access', async name => {
    const other = 'other-' + randomUUID(); const item = Cases.createCase(Cases.legalWorkspaceNamespace(other), other, { title: 'Other synthetic case' });
    const result = await request(name, { caseId: item.id, orgId: item.orgId, userId: other });
    expect(result.status).not.toBe(200);
    expect(mcpManager.callToolForServer).not.toHaveBeenCalled(); expect(toolRegistry.get('web_search')!.handler).not.toHaveBeenCalled();
  });
  it.each(names)('keeps local-only %s partial without dispatch', async name => {
    const result = await run(name, {}, { dataRoutingPolicy: 'local_only' });
    expect(result.receipt).toMatchObject({ ok: false, status: 'partial', persisted: false });
    expect(result.terminalVerification?.status).not.toBe('verified');
    expect(mcpManager.callToolForServer).not.toHaveBeenCalled(); expect(toolRegistry.get('web_search')!.handler).not.toHaveBeenCalled();
  });
  it('keeps absent authorization and malformed or failed provider sources partial without echoing secrets', async () => {
    vi.stubEnv('QICHACHA_API_KEY', '');
    const missing = await run(names[0]); expect(missing.receipt).toMatchObject({ ok: false, status: 'partial', sourceResults: [] });
    expect(mcpManager.callToolForServer).not.toHaveBeenCalled();
    vi.stubEnv('QICHACHA_API_KEY', secret);
    for (const source of ['[]', '{}', JSON.stringify({ code: 403, message: secret })]) {
      vi.mocked(mcpManager.callToolForServer).mockResolvedValueOnce(source);
      const result = await run(names[0]); expect(result.receipt).toMatchObject({ ok: false, status: 'partial', sourceResults: [] });
      expect(result.result).not.toContain(secret); expect(result.terminalVerification?.status).not.toBe('verified');
    }
  });
  it('does not turn a failed search receipt into an observed public-footprint result', async () => {
    vi.mocked(toolRegistry.get('web_search')!.handler).mockResolvedValueOnce(encodeToolResult('Synthetic unavailable search', { ok: false, status: 'partial' }));
    const result = await run(names[1]);
    expect(result.receipt).toMatchObject({ ok: false, status: 'partial', persisted: false });
    expect(result.terminalVerification?.status).not.toBe('verified');
    expect(mcpManager.callToolForServer).not.toHaveBeenCalled();
  });
  it.each(names)('does not turn a late source response into success after cancelling %s', async name => {
    let release!: (value: string) => void;
    const waiting = new Promise<string>(resolve => { release = resolve; });
    if (name === names[0]) vi.mocked(mcpManager.callToolForServer).mockReturnValueOnce(waiting);
    else vi.mocked(toolRegistry.get('web_search')!.handler).mockReturnValueOnce(waiting);
    const controller = new AbortController();
    const pending = run(name, {}, { executionSignal: controller.signal, isCancelled: () => controller.signal.aborted });
    await vi.waitFor(() => expect(name === names[0] ? mcpManager.callToolForServer : toolRegistry.get('web_search')!.handler).toHaveBeenCalledTimes(1));
    controller.abort();
    release(name === names[0] ? caseSource : encodeToolResult(snippets, { ok: true, status: 'observed', resultCount: 1 }));
    const result = await pending;
    expect((result.receipt as { ok?: boolean } | undefined)?.ok).not.toBe(true);
    expect(result.terminalVerification?.status).not.toBe('verified');
  });
  it.each(names)('honors an already cancelled execution of %s without source dispatch', async name => {
    const controller = new AbortController(); controller.abort();
    const result = await run(name, {}, { executionSignal: controller.signal, isCancelled: () => true });
    expect((result.receipt as { ok?: boolean } | undefined)?.ok).not.toBe(true);
    expect(mcpManager.callToolForServer).not.toHaveBeenCalled(); expect(toolRegistry.get('web_search')!.handler).not.toHaveBeenCalled();
  });
});
