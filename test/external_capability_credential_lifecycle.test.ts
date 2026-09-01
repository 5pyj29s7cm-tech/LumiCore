import './helpers';
import crypto from 'node:crypto';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { initDatabase, readDB, writeDB } from '../db_layer';
import {
  activateExternalCapabilityProposal,
  executeExternalCapabilityAction,
  hydrateExternalCapabilities,
  listActiveExternalCapabilities,
  resetExternalCapabilityRegistryForTests,
  reviewExternalCapabilityProposal,
} from '../server/external_capabilities/registry';
import type { ExternalCapabilityPackageProposal } from '../server/external_capabilities/schema';
import { ToolRegistry, resetExternalCommitRuntimeCacheForTests } from '../server/tools/registry';

const OWNER = 'external-credential-owner';
const CREDENTIAL_REF = 'LUMI_TEST_CUSTOMER_TOOL_API_KEY';
const CREDENTIAL_A = 'customer-credential-revision-A-123456';
const CREDENTIAL_B = 'customer-credential-revision-B-654321';
const DOCUMENT_DIGEST = 'b'.repeat(64);

function proposal(input: {
  runtimeKind?: 'builtin' | 'mcp';
  provider?: string;
  executionMode?: 'manual' | 'assisted' | 'automatic_candidate';
  credentialRefs?: string[];
} = {}): ExternalCapabilityPackageProposal {
  const runtimeKind = input.runtimeKind || 'builtin';
  return {
    schemaVersion: 1,
    id: 'customer.secure.tool',
    version: '1.0.0',
    name: 'Secure customer tool',
    description: 'A reviewed customer tool whose credential lifecycle is host-bound.',
    presentation: {
      icon: 'shield',
      placements: ['desktop'],
      launchActionId: 'open-tool',
    },
    guidance: {
      whenToUse: ['Use when the owner asks to open the reviewed secure customer tool.'],
      whenNotToUse: ['Do not use for an unrelated target.'],
      triggerHints: ['open secure customer tool'],
      steps: ['Open the exact reviewed target through the host tool.'],
      completionRules: ['Require a canonical host verification receipt.'],
    },
    documents: [
      { kind: 'manual', label: 'Manual', ref: 'https://docs.example.test/customer/manual', sha256: DOCUMENT_DIGEST },
      { kind: 'security', label: 'Security', ref: 'https://docs.example.test/customer/security', sha256: DOCUMENT_DIGEST },
      { kind: 'api', label: 'API', ref: 'https://docs.example.test/customer/api', sha256: DOCUMENT_DIGEST },
    ],
    runtimeRefs: [{
      id: 'customer-runtime',
      kind: runtimeKind,
      ...(input.provider ? { provider: input.provider } : {}),
    }],
    credentialRefs: input.credentialRefs || [CREDENTIAL_REF],
    actions: [{
      id: 'open-tool',
      label: 'Open tool',
      description: 'Open the exact reviewed customer target.',
      executionMode: input.executionMode || 'automatic_candidate',
      runtimeRef: 'customer-runtime',
      tool: {
        name: 'credential_bound_open_tool',
        capabilityId: 'credential_bound_open_tool',
        fixedArguments: { url: 'https://customer.example.test/app' },
        userArgumentNames: [],
      },
    }],
    acceptance: { requiredActionIds: ['open-tool'], minimumVerifiedRuns: 1 },
  };
}

function registerTool(
  registry: ToolRegistry,
  state: { fail: boolean },
  input: { source?: 'builtin' | 'mcp'; provider?: string } = {},
): void {
  registry.register({
    name: 'credential_bound_open_tool',
    description: 'Open one exact reviewed target and observe the resulting host state.',
    parameters: {
      type: 'object',
      properties: { url: { type: 'string' } },
      required: ['url'],
    },
    permission: 'user',
    securityLevel: 'safe',
    capability: {
      id: 'credential_bound_open_tool',
      family: 'web',
      lane: 'web',
      source: input.source || 'builtin',
      ...(input.provider ? { provider: input.provider } : {}),
      operation: 'mutate',
      risk: 'low',
      sideEffects: [{ type: 'local_state_change', scope: 'browser', reversible: true }],
      verification: {
        strategy: 'state_diff',
        required: true,
        requiredFields: ['status', 'targetMatched'],
        requiredValues: { targetMatched: true },
        successStatuses: ['opened'],
        failureStatuses: ['failed'],
        successSignals: ['host-observed exact target'],
        limitations: [],
      },
    },
    evidence: {
      capability: 'credential_bound_open_tool',
      operation: 'mutate',
      assurance: 'observed',
      subjectArgument: 'url',
    },
    handler: async args => {
      if (state.fail) throw new Error('host-observed open failure');
      return JSON.stringify({ status: 'opened', targetMatched: args.url === 'https://customer.example.test/app' });
    },
  });
}

function ownerContext() {
  return {
    userId: OWNER,
    authenticated: true,
    authRole: 'admin',
    localExecution: true,
    executionBoundary: 'trusted_local' as const,
    domain: 'personal',
    orgId: '',
  };
}

async function reviewAndActivate(registry: ToolRegistry, candidate: ExternalCapabilityPackageProposal) {
  const reviewed = await reviewExternalCapabilityProposal({
    ownerUserId: OWNER,
    proposal: candidate,
    desktopSessionProof: 'credential-native-session',
    registry,
  });
  await activateExternalCapabilityProposal({
    ownerUserId: OWNER,
    proposal: candidate,
    reviewNonce: reviewed.reviewNonce,
    desktopSessionProof: 'credential-native-session',
    registry,
  });
  return reviewed;
}

async function execute(registry: ToolRegistry, suffix: string) {
  return executeExternalCapabilityAction({
    ownerUserId: OWNER,
    capabilityId: 'customer.secure.tool',
    actionId: 'open-tool',
    arguments: {},
    requestId: `credential-request-${suffix}`,
    idempotencyKey: `credential-idempotency-${suffix}`,
    registry,
    context: ownerContext(),
  });
}

beforeAll(async () => {
  await initDatabase();
});

beforeEach(() => {
  delete process.env[CREDENTIAL_REF];
  resetExternalCommitRuntimeCacheForTests();
  resetExternalCapabilityRegistryForTests({ clearPersisted: true });
  const db = readDB();
  db.conversationActionTasks = [];
  db.conversationActionReceipts = [];
  writeDB(db);
});

afterEach(() => {
  delete process.env[CREDENTIAL_REF];
});

describe('external capability credential and automatic lifecycle', () => {
  it('binds review, execution, receipts, and automatic readiness to an installation HMAC credential revision', async () => {
    process.env[CREDENTIAL_REF] = CREDENTIAL_A;
    const registry = new ToolRegistry();
    registerTool(registry, { fail: false });
    const candidate = proposal();
    const reviewedA = await reviewAndActivate(registry, candidate);
    const rowA = readDB().externalCapabilityPackages.find((row: any) => row.status === 'active');
    expect(rowA?.credentialBindingRevision).toMatch(/^[a-f0-9]{64}$/);
    expect(rowA?.credentialBindingRevision).not.toBe(
      crypto.createHash('sha256').update(CREDENTIAL_A).digest('hex'),
    );
    expect(JSON.stringify(reviewedA)).not.toContain(CREDENTIAL_A);
    expect(JSON.stringify(reviewedA)).not.toContain(rowA.credentialBindingRevision);

    const first = await execute(registry, 'A');
    expect(first.execution.status).toBe('verified_success');
    expect(readDB().externalCapabilityReceipts.at(-1)).toMatchObject({
      credentialBindingRevision: rowA.credentialBindingRevision,
      status: 'verified_success',
    });
    const projectionA = listActiveExternalCapabilities(OWNER, registry)[0];
    expect(projectionA.stage).toBe('automatic');
    expect(JSON.stringify(projectionA)).not.toContain(CREDENTIAL_A);
    expect(JSON.stringify(projectionA)).not.toContain(rowA.credentialBindingRevision);
    const proxyA = projectionA.actions[0].toolName;
    expect(JSON.stringify(registry.getCapabilityManifestEntry(proxyA))).not.toContain(rowA.credentialBindingRevision);

    process.env[CREDENTIAL_REF] = CREDENTIAL_B;
    expect(listActiveExternalCapabilities(OWNER, registry)[0]).toMatchObject({
      stage: 'configured',
      availability: 'unavailable',
    });
    await expect(execute(registry, 'B-before-review')).rejects.toThrow(/credential revision changed/i);

    const reviewedB = await reviewAndActivate(registry, candidate);
    const rowB = readDB().externalCapabilityPackages.find((row: any) => row.status === 'active');
    expect(rowB.id).not.toBe(rowA.id);
    expect(rowB.credentialBindingRevision).not.toBe(rowA.credentialBindingRevision);
    expect(JSON.stringify(reviewedB)).not.toContain(CREDENTIAL_B);
    expect(JSON.stringify(reviewedB)).not.toContain(rowB.credentialBindingRevision);
    expect(listActiveExternalCapabilities(OWNER, registry)[0]).toMatchObject({
      stage: 'connected',
      actions: [{ verification: { verifiedRuns: 0 } }],
    });
  });

  it('marks an active package unavailable and refuses execution when a required credential is removed', async () => {
    const registry = new ToolRegistry();
    registerTool(registry, { fail: false });
    await expect(reviewExternalCapabilityProposal({
      ownerUserId: OWNER,
      proposal: proposal(),
      desktopSessionProof: 'missing-credential-review',
      registry,
    })).rejects.toThrow(/credentials are not configured/i);
    process.env[CREDENTIAL_REF] = CREDENTIAL_A;
    await reviewAndActivate(registry, proposal());
    delete process.env[CREDENTIAL_REF];

    expect(listActiveExternalCapabilities(OWNER, registry)[0]).toMatchObject({
      availability: 'unavailable',
      stage: 'configured',
    });
    await expect(execute(registry, 'missing')).rejects.toThrow(/credentials are not configured/i);
    await expect(hydrateExternalCapabilities(registry)).resolves.toMatchObject({
      active: 1,
      ready: 0,
      unavailable: 1,
      proxies: 0,
    });
  });

  it('revokes automatic readiness after the most recent current-revision execution fails', async () => {
    process.env[CREDENTIAL_REF] = CREDENTIAL_A;
    const registry = new ToolRegistry();
    const state = { fail: false };
    registerTool(registry, state);
    await reviewAndActivate(registry, proposal());
    await execute(registry, 'success');
    const automatic = listActiveExternalCapabilities(OWNER, registry)[0];
    expect(automatic.stage).toBe('automatic');
    const proxyName = automatic.actions[0].toolName;

    state.fail = true;
    const failed = await execute(registry, 'failure');
    expect(failed.execution.status).not.toBe('verified_success');
    const revoked = listActiveExternalCapabilities(OWNER, registry)[0];
    expect(revoked.stage).not.toBe('automatic');
    expect(revoked.actions[0].verification.status).toBe('failed');
    expect(registry.getToolDeclarations({
      context: { userId: OWNER, domain: 'personal', autonomous: true, source: 'autonomous' },
    }).map(item => item.function.name)).not.toContain(proxyName);
  });

  it('rejects MCP automatic candidates without host corroboration while retaining assisted mode', async () => {
    const registry = new ToolRegistry();
    registerTool(registry, { fail: false }, { source: 'mcp', provider: 'customer-mcp' });
    const automatic = proposal({
      runtimeKind: 'mcp',
      provider: 'customer-mcp',
      credentialRefs: [],
    });
    await expect(reviewExternalCapabilityProposal({
      ownerUserId: OWNER,
      proposal: automatic,
      desktopSessionProof: 'mcp-automatic-session',
      registry,
    })).rejects.toThrow(/host-corroborated.*assisted mode/i);

    const assisted = proposal({
      runtimeKind: 'mcp',
      provider: 'customer-mcp',
      executionMode: 'assisted',
      credentialRefs: [],
    });
    await expect(reviewAndActivate(registry, assisted)).resolves.toBeTruthy();
    expect(listActiveExternalCapabilities(OWNER, registry)[0]).toMatchObject({
      stage: 'connected',
      actions: [{ executionMode: 'assisted' }],
    });
  });
});
