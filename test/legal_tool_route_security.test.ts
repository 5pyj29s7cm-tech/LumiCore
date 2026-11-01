import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import jwt from 'jsonwebtoken';
import { makeApp, JWT_SECRET } from './helpers';
import { mountChatRoutes } from '../server/routes/chat_routes';
import { toolRegistry } from '../server/tools/registry';
import { addMember, createOrg, removeMember } from '../server/org/db';
import { legalToolDefinitions } from '../server/regions/packs/cn/legal_tools';
import { listCases } from '../server/org/legal_cases';

let url: string;
let cleanup: () => void;
const userToken = jwt.sign({ uid: 'legal-user', username: 'legal-user', role: 'user' }, JWT_SECRET);
const viewerId = `legal-viewer-${Date.now()}`;
const memberId = `legal-member-${Date.now()}`;
let orgId = '';
let viewerToken = '';
let memberToken = '';
const registeredStubTools: string[] = [];
const observedCalls: Array<{
  name: string;
  args: Record<string, any>;
  context: Record<string, any>;
}> = [];

function registerLegalStub(name: string): void {
  const registered = toolRegistry.register({
    name,
    description: `Security-test stub for ${name}`,
    parameters: { type: 'object', properties: {} },
    permission: 'user',
    securityLevel: 'safe',
    capability: {
      operation: name === 'legal_case_workspace' ? 'mutate' : 'observe',
      risk: name === 'legal_case_workspace' ? 'medium' : 'none',
      sideEffects: name === 'legal_case_workspace'
        ? [{ type: 'local_state_change', scope: 'security-test stub', reversible: true }]
        : [],
      verification: {
        strategy: 'terminal_receipt',
        required: true,
        requiredFields: [],
        successSignals: ['non-empty test receipt'],
        limitations: [],
      },
    },
    handler: async (args, context) => {
      observedCalls.push({ name, args, context: { ...(context as any) } });
      if (args?.securityFailureTest === true || String(args?.contract || '').includes('security-failure-test')) {
        throw new Error('private legal runtime failed api_key=sk-legal-private-secret at C:\\private\\legal');
      }
      return `${name}:ok`;
    },
  });
  if (!registered) throw new Error(`Expected ${name} to be unregistered in the isolated test process`);
  registeredStubTools.push(name);
}

function bearer(token: string): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${token}`,
  };
}

describe('direct legal tool route security', () => {
  beforeAll(async () => {
    const app = await makeApp();
    url = app.url;
    cleanup = app.cleanup;
    const unavailable = () => null;
    mountChatRoutes(app.apiRouter, JWT_SECRET, {
      getDeepSeek: unavailable,
      getGemini: unavailable,
      getOpenAI: unavailable,
      getAnthropic: unavailable,
      getQwen: unavailable,
    });

    const org = createOrg('Legal route authorization', `legal-route-${Date.now()}`, 'legal-route-owner');
    orgId = org.id;
    addMember(orgId, viewerId, 'viewer');
    addMember(orgId, memberId, 'member');
    viewerToken = jwt.sign({ uid: viewerId, username: viewerId, role: 'user', orgId }, JWT_SECRET);
    memberToken = jwt.sign({ uid: memberId, username: memberId, role: 'user', orgId }, JWT_SECRET);

    registerLegalStub('legal_authority_source_status');
    registerLegalStub('legal_case_workspace');
    registerLegalStub('legal_review_contract');
  });

  afterAll(() => {
    for (const name of registeredStubTools) toolRegistry.unregister(name);
    cleanup?.();
  });

  it('stops anonymous legal tool calls before argument defaults can enable persistence', async () => {
    const response = await fetch(`${url}/api/legal/tool/legal_case_workspace`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ caseName: 'must-not-persist' }),
      signal: AbortSignal.timeout(5000),
    });
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ error: 'Authentication required' });
  });

  it('requires authentication for the dedicated contract-review route', async () => {
    const response = await fetch(`${url}/api/legal/contract-review`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contract: 'anonymous contract' }),
      signal: AbortSignal.timeout(5000),
    });
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ error: 'Authentication required' });
  });

  it('allows a personal authenticated user and passes verified auth context to the tool', async () => {
    const response = await fetch(`${url}/api/legal/tool/legal_case_workspace`, {
      method: 'POST',
      headers: bearer(userToken),
      body: JSON.stringify({ caseName: 'authenticated-probe' }),
      signal: AbortSignal.timeout(5000),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ text: 'legal_case_workspace:ok' });
    expect(observedCalls.at(-1)).toMatchObject({
      name: 'legal_case_workspace',
      args: {
        userId: 'legal-user',
        domain: 'personal',
        orgId: 'personal:legal-user',
        persistCase: true,
      },
      context: {
        userId: 'legal-user',
        domain: 'personal',
        orgId: '',
        authenticated: true,
        authRole: 'user',
      },
    });
  });

  it('allows an organization viewer to invoke an explicit read-only legal tool', async () => {
    const response = await fetch(`${url}/api/legal/tool/legal_authority_source_status`, {
      method: 'POST',
      headers: bearer(viewerToken),
      body: JSON.stringify({}),
      signal: AbortSignal.timeout(5000),
    });
    expect(response.status).toBe(200);
    expect(observedCalls.at(-1)).toMatchObject({
      name: 'legal_authority_source_status',
      args: { userId: viewerId, domain: 'work', orgId },
      context: {
        userId: viewerId,
        domain: 'work',
        orgId,
        authenticated: true,
        authRole: 'user',
        orgRole: 'viewer',
      },
    });
  });

  it('denies an organization viewer a case-writing legal tool before execution', async () => {
    const callCount = observedCalls.length;
    const response = await fetch(`${url}/api/legal/tool/legal_case_workspace`, {
      method: 'POST',
      headers: bearer(viewerToken),
      body: JSON.stringify({ caseName: 'viewer-must-not-write' }),
      signal: AbortSignal.timeout(5000),
    });
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({
      error: 'Organization viewers may only use read-only legal tools.',
    });
    expect(observedCalls).toHaveLength(callCount);
  });

  it('allows an organization viewer to review a contract without persistence', async () => {
    const response = await fetch(`${url}/api/legal/contract-review`, {
      method: 'POST',
      headers: bearer(viewerToken),
      body: JSON.stringify({ contract: 'read-only contract', persistCase: false,
        userId: 'forged-user', orgId: 'forged-org', domain: 'personal' }),
      signal: AbortSignal.timeout(5000),
    });
    expect(response.status).toBe(200);
    // The legacy URL shares the canonical direct-tool receipt, not a separate
    // model fallback with a degraded flag.
    const payload = await response.json();
    expect(payload).toMatchObject({ text: 'legal_review_contract:ok', toolName: 'legal_review_contract',
      requestId: expect.any(String), receipt: expect.any(Object), verification: expect.any(Object), caseUpdates: [], artifacts: [] });
    expect(payload.requestId).toMatch(/^[0-9a-f-]{36}$/i);
    expect(payload).not.toHaveProperty('degraded');
    expect(observedCalls.at(-1)).toMatchObject({
      name: 'legal_review_contract',
      args: { userId: viewerId, orgId, domain: 'work', persistCase: false },
      context: {
        userId: viewerId,
        domain: 'work',
        orgId,
        authenticated: true,
        authRole: 'user',
        orgRole: 'viewer',
      },
    });
  });

  it('denies an organization viewer contract review that would persist a case', async () => {
    const callCount = observedCalls.length;
    const response = await fetch(`${url}/api/legal/contract-review`, {
      method: 'POST',
      headers: bearer(viewerToken),
      body: JSON.stringify({ contract: 'persistent contract', caseName: 'viewer case' }),
      signal: AbortSignal.timeout(5000),
    });
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({
      error: 'Organization viewers may only use read-only legal tools.',
    });
    expect(observedCalls).toHaveLength(callCount);
  });

  it('keeps case-writing legal tools available to an organization member', async () => {
    const response = await fetch(`${url}/api/legal/tool/legal_case_workspace`, {
      method: 'POST',
      headers: bearer(memberToken),
      body: JSON.stringify({ caseName: 'member case' }),
      signal: AbortSignal.timeout(5000),
    });
    expect(response.status).toBe(200);
    expect(observedCalls.at(-1)).toMatchObject({
      name: 'legal_case_workspace',
      context: { orgRole: 'member', authenticated: true, authRole: 'user' },
    });
  });

  it('does not expose direct legal tool failures or contract fallback internals', async () => {
    const direct = await fetch(`${url}/api/legal/tool/legal_case_workspace`, {
      method: 'POST',
      headers: bearer(userToken),
      body: JSON.stringify({ caseName: 'failure probe', securityFailureTest: true }),
      signal: AbortSignal.timeout(5000),
    });
    expect(direct.status).toBe(500);
    const directPayload = await direct.json();
    expect(directPayload).toEqual({
      error: 'Legal tool execution failed',
      code: 'LEGAL_TOOL_EXECUTION_FAILED',
      requestId: expect.stringMatching(/^[0-9a-f-]{36}$/i),
    });

    const contract = await fetch(`${url}/api/legal/contract-review`, {
      method: 'POST',
      headers: bearer(userToken),
      body: JSON.stringify({ contract: 'security-failure-test' }),
      signal: AbortSignal.timeout(5000),
    });
    expect(contract.status).toBe(500);
    const contractPayload = await contract.json();
    expect(contractPayload).toEqual({
      error: 'Legal tool execution failed',
      code: 'LEGAL_TOOL_EXECUTION_FAILED',
      requestId: expect.stringMatching(/^[0-9a-f-]{36}$/i),
    });
    expect(contractPayload.requestId).not.toBe(directPayload.requestId);

    const payload = JSON.stringify({ directPayload, contractPayload });
    expect(payload).not.toContain('sk-legal-private-secret');
    expect(payload).not.toContain('C:\\private\\legal');
  });

  it('keeps the actual source-only contract review partial and non-persistent through both public URLs', async () => {
    const stub = toolRegistry.get('legal_review_contract')!;
    const actual = legalToolDefinitions().find(tool => tool.name === 'legal_review_contract')!;
    const before = JSON.stringify(listCases(orgId, '', null, viewerId));
    toolRegistry.unregister(actual.name);
    expect(toolRegistry.register(actual)).toBe(true);
    try {
      for (const direct of [false, true]) {
        const args = { contract: 'Synthetic contract: Party A supplies ten desks to Party B.', sourceOnly: true, persistCase: false };
        const response = await fetch(`${url}/api/legal/${direct ? 'tool/legal_review_contract' : 'contract-review'}`, {
          method: 'POST', headers: bearer(viewerToken), body: JSON.stringify(direct ? { args } : args),
          signal: AbortSignal.timeout(5000),
        });
        expect(response.status).toBe(200);
        const payload = await response.json();
        expect(payload).toMatchObject({ toolName: actual.name, caseUpdates: [], artifacts: [],
          receipt: { ok: false, status: 'partial', persisted: false, changedCaseIds: [], articleIds: [], artifacts: [] } });
        expect(payload.text).not.toBe('');
        expect(payload.verification.status).not.toBe('verified');
        expect(JSON.stringify(listCases(orgId, '', null, viewerId))).toBe(before);
      }
    } finally {
      toolRegistry.unregister(actual.name);
      expect(toolRegistry.register(stub)).toBe(true);
    }
  });

  it('denies a revoked membership before invoking the contract-review tool despite an old owner role token', async () => {
    const revokedId = `revoked-legal-${Date.now()}`;
    addMember(orgId, revokedId, 'member');
    const token = jwt.sign({ uid: revokedId, username: revokedId, role: 'user', orgId, orgRole: 'owner' }, JWT_SECRET);
    removeMember(orgId, revokedId);
    const count = observedCalls.length;
    const response = await fetch(`${url}/api/legal/contract-review`, {
      method: 'POST', headers: bearer(token), body: JSON.stringify({ contract: 'Synthetic contract', persistCase: false }),
      signal: AbortSignal.timeout(5000),
    });
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'Active organization membership required.' });
    expect(observedCalls).toHaveLength(count);
  });
});
