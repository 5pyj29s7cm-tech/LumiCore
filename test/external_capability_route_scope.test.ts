import './helpers';
import jwt from 'jsonwebtoken';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  DESKTOP_SESSION_HEADER,
  issueDesktopSessionProof,
} from '../server/config/desktop_bootstrap';
import {
  activateExternalCapabilityProposal,
  hydrateExternalCapabilities,
  listActiveExternalCapabilities,
  resetExternalCapabilityRegistryForTests,
  reviewExternalCapabilityProposal,
} from '../server/external_capabilities/registry';
import { getMCPConfig, mcpManager } from '../server/mcp';
import { mountSkillRoutes } from '../server/routes/skill_routes';
import { mountSystemRoutes } from '../server/routes/system_routes';
import { mountExternalCapabilityRoutes } from '../server/routes/external_capability_routes';
import { toolRegistry } from '../server/tools/registry';
import { JWT_SECRET, LLM_GETTERS, makeApp } from './helpers';

const OWNER = 'external-route-scope-owner';
const OTHER_USER = 'external-route-scope-other';
const PROVIDER = 'external_route_scope_fixture';
const TARGET_TOOL = 'external_route_scope_fixture_open';
const CAPABILITY_ID = 'external.route.scope.fixture';
const DOCUMENT_DIGEST = 'b'.repeat(64);

const ownerToken = jwt.sign({ uid: OWNER, username: OWNER, role: 'user' }, JWT_SECRET);
const otherToken = jwt.sign({ uid: OTHER_USER, username: OTHER_USER, role: 'user' }, JWT_SECRET);
const ownerAdminToken = jwt.sign({ uid: OWNER, username: OWNER, role: 'admin' }, JWT_SECRET);
const otherAdminToken = jwt.sign({ uid: OTHER_USER, username: OTHER_USER, role: 'admin' }, JWT_SECRET);

function auth(token: string) {
  return { Authorization: `Bearer ${token}` };
}

function nativeIdentity(pid: number) {
  return {
    schemaVersion: 1 as const,
    clientKind: 'tauri' as const,
    pid,
    startedAtUnixMs: Math.floor((Date.now() - 30_000) / 1_000) * 1_000,
    executablePath: process.platform === 'win32' ? 'C:\\LumiCore\\lumi-core.exe' : '/opt/LumiCore/lumi-core',
    executableSha256: 'e'.repeat(64),
    binaryHashUnavailable: false,
    buildId: 'f'.repeat(40),
    buildIdSemantics: 'baseline_commit' as const,
    sourceFingerprint: 'a'.repeat(64),
    sourceDirty: false,
    appVersion: '3.1.0',
  };
}

function packageProposal() {
  return {
    schemaVersion: 1,
    id: CAPABILITY_ID,
    version: '1.0.0',
    name: 'Owner scoped route fixture',
    description: 'A reviewed MCP capability used to verify route projection isolation.',
    presentation: {
      icon: 'fixture',
      placements: ['skill_center'],
    },
    guidance: {
      whenToUse: ['Use only for the owning user route projection test.'],
      whenNotToUse: ['Do not use outside the owning personal workspace.'],
      triggerHints: ['open owner scoped fixture'],
      steps: ['Invoke the reviewed fixture action.'],
      completionRules: ['Require the canonical tool receipt.'],
    },
    documents: [
      {
        kind: 'manual',
        label: 'Fixture manual',
        ref: 'https://docs.example.test/external-route-scope/manual',
        sha256: DOCUMENT_DIGEST,
      },
      {
        kind: 'security',
        label: 'Fixture security',
        ref: 'https://docs.example.test/external-route-scope/security',
        sha256: DOCUMENT_DIGEST,
      },
    ],
    runtimeRefs: [{ id: 'fixture-runtime', kind: 'mcp', provider: PROVIDER }],
    credentialRefs: [],
    actions: [{
      id: 'open-fixture',
      label: 'Open fixture',
      description: 'Invoke the exact reviewed fixture tool.',
      executionMode: 'assisted',
      runtimeRef: 'fixture-runtime',
      tool: {
        name: TARGET_TOOL,
        capabilityId: TARGET_TOOL,
        fixedArguments: {},
        userArgumentNames: [],
      },
    }],
    acceptance: { requiredActionIds: ['open-fixture'], minimumVerifiedRuns: 1 },
  };
}

describe('owner-scoped external capability route projections', () => {
  let baseUrl = '';
  let cleanup = () => {};
  let proxyName = '';
  let ownerDesktopSessionProof = '';
  let otherDesktopSessionProof = '';
  let originalMcpConfig: ReturnType<typeof getMCPConfig> = {};

  beforeAll(async () => {
    const app = await makeApp();
    baseUrl = app.url;
    cleanup = app.cleanup;
    mountSystemRoutes(app.apiRouter, JWT_SECRET, { emit: () => {} });
    mountSkillRoutes(app.apiRouter, JWT_SECRET, LLM_GETTERS, { emit: () => {} } as any);
    mountExternalCapabilityRoutes(app.apiRouter, { emit: () => undefined } as any);
    ownerDesktopSessionProof = issueDesktopSessionProof(OWNER, nativeIdentity(53_101)).proof;
    otherDesktopSessionProof = issueDesktopSessionProof(OTHER_USER, nativeIdentity(53_102)).proof;

    resetExternalCapabilityRegistryForTests({ clearPersisted: true });
    originalMcpConfig = structuredClone(getMCPConfig());
    mcpManager.saveConfig({
      ...originalMcpConfig,
      [PROVIDER]: {
        enabled: true,
        source: 'external',
        description: 'External route scope fixture',
        toolCount: 1,
      },
    });
    expect(toolRegistry.register({
      name: TARGET_TOOL,
      description: 'A synthetic MCP tool for scoped route projection tests.',
      parameters: { type: 'object', properties: {} },
      permission: 'user',
      securityLevel: 'safe',
      capability: {
        id: TARGET_TOOL,
        family: 'web',
        lane: 'web',
        source: 'mcp',
        provider: PROVIDER,
        operation: 'observe',
        risk: 'low',
        sideEffects: [],
        verification: {
          strategy: 'state_diff',
          required: true,
          requiredFields: ['status'],
          successStatuses: ['ok'],
          successSignals: ['fixture result'],
          limitations: [],
        },
      },
      handler: async () => JSON.stringify({ status: 'ok', verified: true }),
    })).toBe(true);

    const proposal = packageProposal();
    const reviewed = await reviewExternalCapabilityProposal({
      ownerUserId: OWNER,
      proposal,
      desktopSessionProof: 'external-route-scope-session',
      registry: toolRegistry,
    });
    await activateExternalCapabilityProposal({
      ownerUserId: OWNER,
      proposal,
      reviewNonce: reviewed.reviewNonce,
      desktopSessionProof: 'external-route-scope-session',
      registry: toolRegistry,
    });
    proxyName = listActiveExternalCapabilities(OWNER, toolRegistry)[0]?.actions[0]?.toolName || '';
    expect(proxyName).toMatch(/^external_capability_action_/u);
  });

  afterAll(async () => {
    resetExternalCapabilityRegistryForTests({ clearPersisted: true });
    await hydrateExternalCapabilities(toolRegistry);
    toolRegistry.unregister(TARGET_TOOL);
    mcpManager.saveConfig(originalMcpConfig);
    cleanup();
  });

  it('does not expose another user\'s proxy through /runtime/status acceptance projection', async () => {
    const ownerResponse = await fetch(`${baseUrl}/api/runtime/status`, { headers: auth(ownerToken) });
    expect(ownerResponse.status).toBe(200);
    const ownerBody: any = await ownerResponse.json();
    expect(ownerBody.acceptance.capabilities.map((item: any) => item.toolName)).toContain(proxyName);

    const otherResponse = await fetch(`${baseUrl}/api/runtime/status`, { headers: auth(otherToken) });
    expect(otherResponse.status).toBe(200);
    const otherBody: any = await otherResponse.json();
    expect(otherBody.acceptance.capabilities.map((item: any) => item.toolName)).not.toContain(proxyName);
    expect(JSON.stringify(otherBody)).not.toContain(proxyName);
  });

  it('does not expose another user\'s proxy through /skills registeredToolNames', async () => {
    const ownerResponse = await fetch(`${baseUrl}/api/skills`, { headers: auth(ownerToken) });
    expect(ownerResponse.status).toBe(200);
    const ownerSkill = ((await ownerResponse.json()) as any).skills.find((item: any) => item.name === PROVIDER);
    expect(ownerSkill.registeredToolNames).toContain(proxyName);

    const otherResponse = await fetch(`${baseUrl}/api/skills`, { headers: auth(otherToken) });
    expect(otherResponse.status).toBe(200);
    const otherBody: any = await otherResponse.json();
    const otherSkill = otherBody.skills.find((item: any) => item.name === PROVIDER);
    expect(otherSkill.registeredToolNames).not.toContain(proxyName);
    expect(JSON.stringify(otherBody)).not.toContain(proxyName);
  });

  it('requires administrator, native personal ownership before deactivation', async () => {
    const endpoint = `${baseUrl}/api/external-capabilities/${encodeURIComponent(CAPABILITY_ID)}/deactivate`;
    const anonymous = await fetch(endpoint, { method: 'POST' });
    expect(anonymous.status).toBe(401);

    const nonAdmin = await fetch(endpoint, {
      method: 'POST',
      headers: {
        ...auth(ownerToken),
        [DESKTOP_SESSION_HEADER]: ownerDesktopSessionProof,
      },
    });
    expect(nonAdmin.status).toBe(403);

    const noNativeSession = await fetch(endpoint, {
      method: 'POST',
      headers: auth(ownerAdminToken),
    });
    expect(noNativeSession.status).toBe(403);

    const otherOwner = await fetch(endpoint, {
      method: 'POST',
      headers: {
        ...auth(otherAdminToken),
        [DESKTOP_SESSION_HEADER]: otherDesktopSessionProof,
      },
    });
    expect(otherOwner.status).toBe(404);
    expect(listActiveExternalCapabilities(OWNER, toolRegistry)).toHaveLength(1);

    const owner = await fetch(endpoint, {
      method: 'POST',
      headers: {
        ...auth(ownerAdminToken),
        [DESKTOP_SESSION_HEADER]: ownerDesktopSessionProof,
      },
    });
    expect(owner.status).toBe(200);
    await expect(owner.json()).resolves.toMatchObject({ capabilityId: CAPABILITY_ID, status: 'inactive' });
    expect(listActiveExternalCapabilities(OWNER, toolRegistry)).toHaveLength(0);
    expect(toolRegistry.get(proxyName)).toBeUndefined();
  });
});
