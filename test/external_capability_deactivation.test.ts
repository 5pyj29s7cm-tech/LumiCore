import './helpers';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { closeDatabase, initDatabase, readDB } from '../db_layer';
import {
  activateExternalCapabilityProposal,
  configureExternalCapabilityRegistryForTests,
  deactivateExternalCapability,
  executeExternalCapabilityAction,
  hydrateExternalCapabilities,
  listActiveExternalCapabilities,
  resetExternalCapabilityRegistryForTests,
  reviewExternalCapabilityProposal,
} from '../server/external_capabilities/registry';
import { ToolRegistry } from '../server/tools/registry';

const OWNER = 'external-deactivation-owner';
const OTHER_USER = 'external-deactivation-other';
const CAPABILITY_ID = 'external.deactivation.fixture';
const TARGET_TOOL = 'external_deactivation_fixture_open';

function registerTarget(registry: ToolRegistry): void {
  registry.register({
    name: TARGET_TOOL,
    description: 'Open the exact reviewed fixture target.',
    parameters: {
      type: 'object',
      properties: { url: { type: 'string' } },
      required: ['url'],
    },
    permission: 'user',
    securityLevel: 'safe',
    capability: {
      id: TARGET_TOOL,
      family: 'web',
      lane: 'web',
      source: 'builtin',
      operation: 'observe',
      risk: 'low',
      sideEffects: [],
      verification: {
        strategy: 'state_diff',
        required: true,
        requiredFields: ['status', 'targetMatched'],
        requiredValues: { targetMatched: true },
        successStatuses: ['opened'],
        successSignals: ['fixture opened'],
        limitations: [],
      },
      prerequisites: ['deactivation fixture revision one'],
    },
    evidence: {
      capability: TARGET_TOOL,
      operation: 'observe',
      assurance: 'observed',
      subjectArgument: 'url',
    },
    handler: async () => JSON.stringify({
      status: 'opened',
      targetMatched: true,
      verified: true,
      verificationStatus: 'verified',
    }),
  });
}

function packageProposal() {
  return {
    schemaVersion: 1 as const,
    id: CAPABILITY_ID,
    version: '1.0.0',
    name: 'Deactivation fixture',
    description: 'A reviewed capability used to verify durable owner-bound deactivation.',
    presentation: {
      icon: 'fixture',
      placements: ['desktop' as const],
      launchActionId: 'open-fixture',
    },
    guidance: {
      whenToUse: ['Use when the owner asks to open the deactivation fixture.'],
      whenNotToUse: ['Do not use outside this fixture.'],
      triggerHints: ['open deactivation fixture'],
      steps: ['Open the exact reviewed fixture target.'],
      completionRules: ['Require the canonical host receipt.'],
    },
    documents: [
      {
        kind: 'manual' as const,
        label: 'Fixture manual',
        ref: 'https://docs.example.test/external-deactivation/manual',
        sha256: 'd'.repeat(64),
      },
      {
        kind: 'security' as const,
        label: 'Fixture security',
        ref: 'https://docs.example.test/external-deactivation/security',
        sha256: 'd'.repeat(64),
      },
    ],
    runtimeRefs: [{ id: 'fixture-runtime', kind: 'builtin' as const }],
    credentialRefs: [],
    actions: [{
      id: 'open-fixture',
      label: 'Open fixture',
      description: 'Open the exact reviewed fixture target.',
      executionMode: 'assisted' as const,
      runtimeRef: 'fixture-runtime',
      tool: {
        name: TARGET_TOOL,
        capabilityId: TARGET_TOOL,
        fixedArguments: { url: 'https://fixture.example.test/app' },
        userArgumentNames: [],
      },
    }],
    acceptance: { requiredActionIds: ['open-fixture'], minimumVerifiedRuns: 1 },
  };
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

async function activate(registry: ToolRegistry): Promise<string> {
  const proposal = packageProposal();
  const reviewed = await reviewExternalCapabilityProposal({
    ownerUserId: OWNER,
    proposal,
    desktopSessionProof: 'native-deactivation-session',
    registry,
  });
  await activateExternalCapabilityProposal({
    ownerUserId: OWNER,
    proposal,
    reviewNonce: reviewed.reviewNonce,
    desktopSessionProof: 'native-deactivation-session',
    registry,
  });
  return listActiveExternalCapabilities(OWNER, registry)[0].actions[0].toolName;
}

beforeAll(async () => {
  await initDatabase();
});

beforeEach(() => {
  resetExternalCapabilityRegistryForTests({ clearPersisted: true });
  configureExternalCapabilityRegistryForTests(null);
});

describe('reviewed external capability deactivation', () => {
  it('is owner-bound, rolls back failed persistence, unregisters every surface, and stays inactive after restart', async () => {
    const registry = new ToolRegistry();
    registerTarget(registry);
    const proxyName = await activate(registry);

    expect(registry.getToolDeclarations({ context: { userId: OWNER, domain: 'personal' } })
      .map(item => item.function.name)).toContain(proxyName);
    expect(listActiveExternalCapabilities(OWNER, registry)).toHaveLength(1);

    await expect(deactivateExternalCapability({
      ownerUserId: OTHER_USER,
      capabilityId: CAPABILITY_ID,
      registry,
    })).rejects.toThrow(/not active|not found/i);
    expect(listActiveExternalCapabilities(OWNER, registry)).toHaveLength(1);
    expect(registry.get(proxyName)).toBeDefined();

    configureExternalCapabilityRegistryForTests({
      persist: async () => { throw new Error('forced deactivation persistence failure'); },
    });
    await expect(deactivateExternalCapability({
      ownerUserId: OWNER,
      capabilityId: CAPABILITY_ID,
      registry,
    })).rejects.toThrow(/forced deactivation persistence failure/i);
    expect(readDB().externalCapabilityPackages.find((row: any) => row.capabilityId === CAPABILITY_ID)?.status).toBe('active');
    expect(listActiveExternalCapabilities(OWNER, registry)).toHaveLength(1);
    expect(registry.get(proxyName)).toBeDefined();

    configureExternalCapabilityRegistryForTests(null);
    await expect(deactivateExternalCapability({
      ownerUserId: OWNER,
      capabilityId: CAPABILITY_ID,
      registry,
    })).resolves.toMatchObject({ capabilityId: CAPABILITY_ID, status: 'inactive' });
    expect(listActiveExternalCapabilities(OWNER, registry)).toHaveLength(0);
    expect(registry.get(proxyName)).toBeUndefined();
    expect(registry.getToolDeclarations({ context: { userId: OWNER, domain: 'personal' } })
      .map(item => item.function.name)).not.toContain(proxyName);
    await expect(executeExternalCapabilityAction({
      ownerUserId: OWNER,
      capabilityId: CAPABILITY_ID,
      actionId: 'open-fixture',
      arguments: {},
      requestId: 'deactivated-action-request',
      idempotencyKey: 'deactivated-action-idempotency',
      registry,
      context: ownerContext(),
    })).rejects.toThrow(/not active/i);

    await closeDatabase();
    await initDatabase();
    resetExternalCapabilityRegistryForTests();
    const restartedRegistry = new ToolRegistry();
    registerTarget(restartedRegistry);
    await expect(hydrateExternalCapabilities(restartedRegistry)).resolves.toMatchObject({
      active: 0,
      ready: 0,
      proxies: 0,
    });
    expect(restartedRegistry.get(proxyName)).toBeUndefined();
    expect(listActiveExternalCapabilities(OWNER, restartedRegistry)).toHaveLength(0);
  });
});
