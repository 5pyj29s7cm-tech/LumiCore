import './helpers';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { closeDatabase, flushDBOrThrow, initDatabase, readDB, writeDB } from '../db_layer';
import {
  activateExternalCapabilityProposal,
  configureExternalCapabilityRegistryForTests,
  executeExternalCapabilityAction,
  hydrateExternalCapabilities,
  listActiveExternalCapabilities,
  resetExternalCapabilityRegistryForTests,
  reviewExternalCapabilityProposal,
} from '../server/external_capabilities/registry';
import {
  normalizeExternalCapabilityProposal,
  type ExternalCapabilityPackageProposal,
} from '../server/external_capabilities/schema';
import { requirePersonalExternalCapabilityScope } from '../server/routes/external_capability_routes';
import { executeToolCall } from '../server/tools/execution_engine';
import { ToolRegistry, resetExternalCommitRuntimeCacheForTests } from '../server/tools/registry';
import { attachAutonomousHostAuthority } from '../server/tools/host_execution_authority';
import { buildLumiExecutionPipeline } from '../server/cognition/execution_pipeline';
import { buildAutonomousCapabilityPipeline } from '../server/autonomy/task_executor';
import { buildLumiRuntimeCapabilityContext } from '../server/cognition/capability_context';

const OWNER = 'external-capability-owner';
const OTHER_USER = 'external-capability-other';
const DOCUMENT_DIGEST = 'a'.repeat(64);

function proposal(input: {
  runtimeKind?: 'builtin' | 'mcp';
  provider?: string;
  executionMode?: 'manual' | 'assisted' | 'automatic_candidate';
} = {}): ExternalCapabilityPackageProposal {
  const runtimeKind = input.runtimeKind || 'builtin';
  return {
    schemaVersion: 1,
    id: 'aivid.tool',
    version: '1.0.0',
    name: 'AIVID customer tool',
    description: 'A reviewed customer capability package used by LumiCore and its desktop icon.',
    presentation: {
      icon: 'video',
      placements: ['desktop'],
      launchActionId: 'open-tool',
    },
    guidance: {
      whenToUse: ['Use when the owner asks to open the reviewed customer video tool.'],
      whenNotToUse: ['Do not use for unrelated web searches.'],
      triggerHints: ['open customer video tool'],
      steps: ['Open the exact reviewed HTTPS target.'],
      completionRules: ['The host receipt must verify the opened target.'],
    },
    documents: [
      { kind: 'manual', label: 'User manual', ref: 'https://docs.example.test/aivid/manual', sha256: DOCUMENT_DIGEST },
      { kind: 'security', label: 'Security', ref: 'https://docs.example.test/aivid/security', sha256: DOCUMENT_DIGEST },
      { kind: 'api', label: 'API', ref: 'https://docs.example.test/aivid/api', sha256: DOCUMENT_DIGEST },
    ],
    runtimeRefs: [{
      id: 'launch-runtime',
      kind: runtimeKind,
      ...(input.provider ? { provider: input.provider } : {}),
    }],
    credentialRefs: [],
    actions: [{
      id: 'open-tool',
      label: 'Open tool',
      description: 'Open the exact reviewed customer tool.',
      executionMode: input.executionMode || 'automatic_candidate',
      runtimeRef: 'launch-runtime',
      tool: {
        name: 'reviewed_open_tool',
        capabilityId: 'reviewed_open_tool',
        fixedArguments: { url: 'https://aivid.example.test/app' },
        userArgumentNames: [],
      },
    }],
    acceptance: { requiredActionIds: ['open-tool'], minimumVerifiedRuns: 1 },
  };
}

function registerOpenTool(registry: ToolRegistry, input: { source?: 'builtin' | 'mcp'; provider?: string; revision?: string } = {}) {
  const calls: Array<Record<string, unknown>> = [];
  registry.register({
    name: 'reviewed_open_tool',
    description: 'Open an exact reviewed tool URL and return host-observed post-state.',
    parameters: {
      type: 'object',
      properties: { url: { type: 'string' } },
      required: ['url'],
    },
    permission: 'user',
    securityLevel: 'safe',
    capability: {
      id: 'reviewed_open_tool',
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
        successSignals: ['host-observed opened target'],
        limitations: [],
      },
      prerequisites: [`runtime revision ${input.revision || 'one'}`],
    },
    evidence: {
      capability: 'reviewed_open_tool',
      operation: 'mutate',
      assurance: 'observed',
      subjectArgument: 'url',
    },
    preflight: async args => {
      if (args.url !== 'https://aivid.example.test/app') throw new Error('unexpected target');
    },
    handler: async args => {
      calls.push(structuredClone(args));
      return JSON.stringify({ status: 'opened', targetMatched: true, verified: true });
    },
  });
  return calls;
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

async function reviewAndActivate(registry: ToolRegistry, candidate = proposal()) {
  const reviewed = await reviewExternalCapabilityProposal({
    ownerUserId: OWNER,
    proposal: candidate,
    desktopSessionProof: 'native-session-proof-a',
    registry,
  });
  await activateExternalCapabilityProposal({
    ownerUserId: OWNER,
    proposal: candidate,
    reviewNonce: reviewed.reviewNonce,
    desktopSessionProof: 'native-session-proof-a',
    registry,
  });
  return reviewed;
}

beforeAll(async () => {
  await initDatabase();
});

beforeEach(() => {
  resetExternalCommitRuntimeCacheForTests();
  resetExternalCapabilityRegistryForTests({ clearPersisted: true });
  configureExternalCapabilityRegistryForTests(null);
  const db = readDB();
  db.conversationActionTasks = [];
  db.conversationActionReceipts = [];
  writeDB(db);
});

describe('reviewed external capability packages', () => {
  it('rejects embedded credentials, unsafe document references, and incomplete teaching guidance', () => {
    expect(() => normalizeExternalCapabilityProposal({
      ...proposal(),
      apiKey: 'must-never-be-stored',
    })).toThrow(/credential material|unsupported field/i);
    expect(() => normalizeExternalCapabilityProposal({
      ...proposal(),
      documents: [{ kind: 'manual', label: 'unsafe', ref: 'https://user:pass@example.test/doc?token=x', sha256: DOCUMENT_DIGEST }],
    })).toThrow(/query-free HTTPS/i);
    expect(() => normalizeExternalCapabilityProposal({
      ...proposal(),
      guidance: { ...proposal().guidance, steps: [] },
    })).toThrow(/must each contain at least one/i);
    for (const fixedArguments of [
      { credential: 'RANDOMVALUE1234567890' },
      { key: 'ghp_1234567890abcdefghijklmnop' },
      { nested: { accessKeyId: 'AKIA1234567890ABCDEF' } },
      { auth: 'xoxb-1234567890-abcdefghijklmnop' },
      { url: 'https://example.test/private/ghp_1234567890abcdefghijklmnop' },
    ]) {
      const candidate = proposal();
      candidate.actions[0].tool.fixedArguments = fixedArguments;
      expect(() => normalizeExternalCapabilityProposal(candidate)).toThrow(/credential material/i);
    }
  });

  it('hydrates one owner-scoped proxy and uses it for both model and icon execution', async () => {
    const registry = new ToolRegistry();
    const targetCalls = registerOpenTool(registry);
    await reviewAndActivate(registry);

    const capability = listActiveExternalCapabilities(OWNER, registry)[0];
    const proxyName = capability.actions[0].toolName;
    expect(proxyName).toMatch(/^external_capability_action_/);
    expect(capability).toMatchObject({
      id: 'aivid.tool',
      stage: 'connected',
      availability: 'ready',
      presentation: { launchActionId: 'open-tool' },
    });
    expect(registry.getToolDeclarations({ context: { userId: OWNER } }).map(item => item.function.name)).toContain(proxyName);
    expect(registry.getCapabilityManifest(undefined, { context: { userId: OWNER } }).map(item => item.toolName)).toContain(proxyName);
    expect(registry.getToolDeclarations({ context: { userId: OTHER_USER } }).map(item => item.function.name)).not.toContain(proxyName);
    expect(registry.getCapabilityManifest(undefined, { context: { userId: OTHER_USER } }).map(item => item.toolName)).not.toContain(proxyName);
    expect(registry.findRelevant('open customer video tool', { context: { userId: OTHER_USER } }).map(item => item.name)).not.toContain(proxyName);
    expect(registry.getToolDeclarations({ context: { userId: OWNER, domain: 'work', orgId: 'org-1' } }).map(item => item.function.name)).not.toContain(proxyName);

    const ownerPipeline = buildLumiExecutionPipeline({
      dispatch: {
        userId: OWNER,
        text: 'Open the reviewed customer video tool.',
        channel: 'chat',
        source: 'command-center-chat',
        operationMode: 'assistant',
        domain: 'personal',
        targetIsLumi: true,
      },
      registry,
      personalityToolPolicy: { allowedTools: ['*'], requireConfirmation: [], forbiddenTools: [], maxIterations: 20 },
    });
    expect(ownerPipeline.modelToolProjection.toolNames).toContain(proxyName);
    const otherPipeline = buildLumiExecutionPipeline({
      dispatch: {
        userId: OTHER_USER,
        text: 'Open the reviewed customer video tool.',
        channel: 'chat',
        source: 'command-center-chat',
        operationMode: 'assistant',
        domain: 'personal',
        targetIsLumi: true,
      },
      registry,
      personalityToolPolicy: { allowedTools: ['*'], requireConfirmation: [], forbiddenTools: [], maxIterations: 20 },
    });
    expect(otherPipeline.modelToolProjection.toolNames).not.toContain(proxyName);

    const canonicalModelExecution = await executeToolCall({
      registry,
      name: proxyName,
      arguments: {},
      id: 'model-proxy-fixed-arguments',
      context: {
        ...ownerContext(),
        source: 'chat',
        taskId: 'model-proxy-task',
        requestId: 'model-proxy-request',
        idempotencyKey: 'model-proxy-idempotency',
        currentTurnExecutionRequested: true,
      },
    });
    expect(canonicalModelExecution.error).toBeUndefined();
    expect(canonicalModelExecution.arguments).toEqual({ url: 'https://aivid.example.test/app' });
    expect(canonicalModelExecution.evidence?.scope).toEqual(['https://aivid.example.test/app']);

    const denied = await executeToolCall({
      registry,
      name: proxyName,
      arguments: {},
      context: { ...ownerContext(), userId: OTHER_USER },
    });
    expect(denied.error).toMatch(/owning user scope/i);
    expect(targetCalls).toHaveLength(1);

    const executed = await executeExternalCapabilityAction({
      ownerUserId: OWNER,
      capabilityId: 'aivid.tool',
      actionId: 'open-tool',
      arguments: {},
      requestId: 'request-owner-1',
      idempotencyKey: 'idempotency-owner-1',
      registry,
      context: ownerContext(),
    });
    expect(executed.execution.error).toBeUndefined();
    expect(executed.execution).toMatchObject({
      status: 'verified_success',
      toolName: proxyName,
      underlyingToolName: 'reviewed_open_tool',
      terminalVerification: { status: 'verified' },
    });
    expect(targetCalls).toEqual([
      { url: 'https://aivid.example.test/app' },
      { url: 'https://aivid.example.test/app' },
    ]);
    expect(listActiveExternalCapabilities(OWNER, registry)[0]).toMatchObject({
      stage: 'automatic',
      actions: [{ verification: { status: 'verified', verifiedRuns: 1 } }],
    });
  });

  it('does not promote an assisted MCP provider self-report to verified or automatic', async () => {
    const registry = new ToolRegistry();
    registerOpenTool(registry, { source: 'mcp', provider: 'customer-mcp' });
    const candidate = proposal({ runtimeKind: 'mcp', provider: 'customer-mcp', executionMode: 'assisted' });
    await reviewAndActivate(registry, candidate);
    const executed = await executeExternalCapabilityAction({
      ownerUserId: OWNER,
      capabilityId: 'aivid.tool',
      actionId: 'open-tool',
      arguments: {},
      requestId: 'request-mcp-1',
      idempotencyKey: 'idempotency-mcp-1',
      registry,
      context: ownerContext(),
    });
    expect(executed.execution.terminalVerification?.status).toBe('unverified');
    expect(listActiveExternalCapabilities(OWNER, registry)[0]).toMatchObject({
      stage: 'connected',
      actions: [{ verification: { status: 'failed', verifiedRuns: 0 } }],
    });
  });

  it('runs a fixed browser target through semantic target guards and records the bound URL', async () => {
    const registry = new ToolRegistry();
    const calls: Array<Record<string, unknown>> = [];
    registry.register({
      name: 'browser_open_task',
      description: 'Open one exact browser URL.',
      parameters: {
        type: 'object',
        properties: { url: { type: 'string' } },
        required: ['url'],
      },
      permission: 'user',
      securityLevel: 'safe',
      capability: {
        id: 'browser_open_task',
        family: 'web',
        lane: 'web',
        source: 'builtin',
        operation: 'mutate',
        risk: 'low',
        sideEffects: [{ type: 'local_state_change', scope: 'browser', reversible: true }],
        verification: {
          strategy: 'state_diff',
          required: true,
          requiredFields: ['status', 'targetMatched'],
          requiredValues: { targetMatched: true },
          successStatuses: ['opened'],
          successSignals: ['host-observed opened target'],
          limitations: [],
        },
      },
      evidence: {
        capability: 'browser_open_task',
        operation: 'mutate',
        assurance: 'observed',
        subjectArgument: 'url',
      },
      handler: async args => {
        calls.push(structuredClone(args));
        return JSON.stringify({ status: 'opened', targetMatched: true, verified: true });
      },
    });
    const candidate = proposal();
    candidate.actions[0].tool.name = 'browser_open_task';
    candidate.actions[0].tool.capabilityId = 'browser_open_task';
    await reviewAndActivate(registry, candidate);
    const proxyName = listActiveExternalCapabilities(OWNER, registry)[0].actions[0].toolName;
    const mismatched = await executeToolCall({
      registry,
      name: proxyName,
      arguments: {},
      context: {
        ...ownerContext(),
        source: 'chat',
        actionIntent: 'Open https://different.example.test now.',
        routedTaskText: 'Open https://different.example.test now.',
        currentTurnExecutionRequested: true,
      },
    });
    expect(mismatched.error).toMatch(/target does not match/i);
    expect(calls).toHaveLength(0);

    const executed = await executeExternalCapabilityAction({
      ownerUserId: OWNER,
      capabilityId: 'aivid.tool',
      actionId: 'open-tool',
      arguments: {},
      requestId: 'browser-fixed-request',
      idempotencyKey: 'browser-fixed-idempotency',
      registry,
      context: ownerContext(),
    });
    expect(executed.execution.error, JSON.stringify(executed.execution)).toBeUndefined();
    expect(executed.execution).toMatchObject({
      status: 'verified_success',
      arguments: { url: 'https://aivid.example.test/app' },
      evidence: { scope: ['https://aivid.example.test/app'] },
    });
    expect(calls).toEqual([{ url: 'https://aivid.example.test/app' }]);
  });

  it('binds fixed confirmation targets before approval and rejects caller overrides', async () => {
    const registry = new ToolRegistry();
    registry.register({
      name: 'send_reviewed_message',
      description: 'Send one reviewed message to an exact recipient.',
      parameters: {
        type: 'object',
        properties: { recipient: { type: 'string' } },
        required: ['recipient'],
      },
      permission: 'user',
      securityLevel: 'confirm',
      capability: {
        id: 'send_reviewed_message',
        family: 'messaging',
        lane: 'messaging',
        source: 'builtin',
        operation: 'communicate',
        risk: 'high',
        sideEffects: [{ type: 'external_communication', scope: 'recipient', reversible: false }],
        verification: {
          strategy: 'terminal_receipt',
          required: true,
          requiredFields: ['status', 'verified'],
          requiredValues: { verified: true },
          successStatuses: ['sent'],
          successSignals: ['provider receipt'],
          limitations: [],
        },
      },
      evidence: {
        capability: 'send_reviewed_message',
        operation: 'communicate',
        assurance: 'verified',
        subjectArgument: 'recipient',
      },
      handler: async () => JSON.stringify({ status: 'sent', verified: true, messageId: 'message-1' }),
    });
    const candidate = proposal({ executionMode: 'assisted' });
    candidate.presentation = {
      icon: 'message',
      placements: ['skill_center'],
      launchActionId: 'send-message',
    };
    candidate.actions[0] = {
      ...candidate.actions[0],
      id: 'send-message',
      label: 'Send message',
      description: 'Send to the exact reviewed recipient.',
      tool: {
        name: 'send_reviewed_message',
        capabilityId: 'send_reviewed_message',
        fixedArguments: { recipient: 'customer@example.test' },
        userArgumentNames: [],
      },
    };
    candidate.acceptance = { requiredActionIds: ['send-message'], minimumVerifiedRuns: 1 };
    await reviewAndActivate(registry, candidate);
    const proxyName = listActiveExternalCapabilities(OWNER, registry)[0].actions[0].toolName;
    let confirmationArguments: Record<string, unknown> | undefined;
    const waiting = await executeToolCall({
      registry,
      name: proxyName,
      arguments: {},
      context: {
        ...ownerContext(),
        source: 'chat',
        currentTurnExecutionRequested: true,
        requestConfirmation: async (_name, args) => {
          confirmationArguments = structuredClone(args);
          return false;
        },
      },
    });
    expect(confirmationArguments).toEqual({ recipient: 'customer@example.test' });
    expect(waiting.arguments).toEqual({ recipient: 'customer@example.test' });

    const override = await executeToolCall({
      registry,
      name: proxyName,
      arguments: { recipient: 'attacker@example.test' },
      context: { ...ownerContext(), source: 'chat', currentTurnExecutionRequested: true },
    });
    expect(override.error).toMatch(/server-owned.*cannot be overridden/i);
  });

  it('counts only owner-bound canonical conversation receipts for the reviewed proxy', async () => {
    const registry = new ToolRegistry();
    registerOpenTool(registry);
    await reviewAndActivate(registry);
    const capability = listActiveExternalCapabilities(OWNER, registry)[0];
    const proxyName = capability.actions[0].toolName;
    const db = readDB();
    db.conversationActionTasks.push({ id: 'owner-task', userId: OWNER });
    db.conversationActionTasks.push({ id: 'other-task', userId: OTHER_USER });
    const envelope = JSON.stringify({
      status: 'verified_success',
      verification: { status: 'verified', basis: 'terminal_verification' },
    });
    db.conversationActionReceipts.push(
      { id: 'other-receipt', taskId: 'other-task', toolName: proxyName, outcome: 'verified_success', envelope, createdAt: new Date().toISOString() },
      { id: 'owner-unverified', taskId: 'owner-task', toolName: proxyName, outcome: 'verified_success', envelope: JSON.stringify({ status: 'verified_success', verification: { status: 'verified', basis: 'compatibility_inference' } }), createdAt: new Date().toISOString() },
    );
    expect(listActiveExternalCapabilities(OWNER, registry)[0].stage).toBe('connected');
    db.conversationActionReceipts.push({
      id: 'owner-receipt',
      taskId: 'owner-task',
      toolName: proxyName,
      outcome: 'verified_success',
      envelope,
      createdAt: new Date().toISOString(),
    });
    expect(listActiveExternalCapabilities(OWNER, registry)[0]).toMatchObject({
      stage: 'automatic',
      actions: [{ verification: { verifiedRuns: 1 } }],
    });
  });

  it('fails closed when the reviewed target runtime changes before activation', async () => {
    const registry = new ToolRegistry();
    registerOpenTool(registry);
    const candidate = proposal();
    const reviewed = await reviewExternalCapabilityProposal({
      ownerUserId: OWNER,
      proposal: candidate,
      desktopSessionProof: 'native-session-proof-change',
      registry,
    });
    registry.unregister('reviewed_open_tool');
    registerOpenTool(registry, { source: 'builtin', revision: 'two' });
    await expect(activateExternalCapabilityProposal({
      ownerUserId: OWNER,
      proposal: candidate,
      reviewNonce: reviewed.reviewNonce,
      desktopSessionProof: 'native-session-proof-change',
      registry,
    })).rejects.toThrow(/changed after review|identity changed/i);
    expect(listActiveExternalCapabilities(OWNER, registry)).toHaveLength(0);
  });

  it('rolls back review and activation memory state when strict persistence fails', async () => {
    const registry = new ToolRegistry();
    registerOpenTool(registry);
    configureExternalCapabilityRegistryForTests({ persist: async () => { throw new Error('forced persistence failure'); } });
    await expect(reviewExternalCapabilityProposal({
      ownerUserId: OWNER,
      proposal: proposal(),
      desktopSessionProof: 'native-session-proof-fail-review',
      registry,
    })).rejects.toThrow(/forced persistence failure/i);
    expect(readDB().externalCapabilityPackages).toHaveLength(0);
    expect(readDB().externalCapabilityReceipts).toHaveLength(0);

    configureExternalCapabilityRegistryForTests(null);
    const reviewed = await reviewExternalCapabilityProposal({
      ownerUserId: OWNER,
      proposal: proposal(),
      desktopSessionProof: 'native-session-proof-fail-activate',
      registry,
    });
    configureExternalCapabilityRegistryForTests({ persist: async () => { throw new Error('forced activation persistence failure'); } });
    await expect(activateExternalCapabilityProposal({
      ownerUserId: OWNER,
      proposal: proposal(),
      reviewNonce: reviewed.reviewNonce,
      desktopSessionProof: 'native-session-proof-fail-activate',
      registry,
    })).rejects.toThrow(/forced activation persistence failure/i);
    expect(readDB().externalCapabilityPackages).toHaveLength(1);
    expect(readDB().externalCapabilityPackages[0].status).toBe('reviewed');
    expect(readDB().externalCapabilityReceipts.filter((item: any) => item.kind === 'activation')).toHaveLength(0);
  });

  it('rejects work-domain access at the GET/list boundary', () => {
    let status = 0;
    let payload: unknown;
    let nextCalled = false;
    requirePersonalExternalCapabilityScope(
      { user: { uid: OWNER, username: 'owner', role: 'admin', orgId: 'org-1' } } as any,
      {
        status(code: number) { status = code; return this; },
        json(value: unknown) { payload = value; return this; },
      } as any,
      () => { nextCalled = true; },
    );
    expect(status).toBe(403);
    expect(payload).toMatchObject({ error: expect.stringMatching(/personal workspace/i) });
    expect(nextCalled).toBe(false);
  });

  it('binds review approval to one native session and consumes the nonce once', async () => {
    const registry = new ToolRegistry();
    registerOpenTool(registry);
    const candidate = proposal();
    const wrongSessionReview = await reviewExternalCapabilityProposal({
      ownerUserId: OWNER,
      proposal: candidate,
      desktopSessionProof: 'native-session-one',
      registry,
    });
    await expect(activateExternalCapabilityProposal({
      ownerUserId: OWNER,
      proposal: candidate,
      reviewNonce: wrongSessionReview.reviewNonce,
      desktopSessionProof: 'native-session-two',
      registry,
    })).rejects.toThrow(/not bound.*native desktop session/i);
    await expect(activateExternalCapabilityProposal({
      ownerUserId: OWNER,
      proposal: candidate,
      reviewNonce: wrongSessionReview.reviewNonce,
      desktopSessionProof: 'native-session-one',
      registry,
    })).rejects.toThrow(/expired|already used|matching reviewed/i);

    const oneUseReview = await reviewExternalCapabilityProposal({
      ownerUserId: OWNER,
      proposal: candidate,
      desktopSessionProof: 'native-session-three',
      registry,
    });
    await activateExternalCapabilityProposal({
      ownerUserId: OWNER,
      proposal: candidate,
      reviewNonce: oneUseReview.reviewNonce,
      desktopSessionProof: 'native-session-three',
      registry,
    });
    await expect(activateExternalCapabilityProposal({
      ownerUserId: OWNER,
      proposal: candidate,
      reviewNonce: oneUseReview.reviewNonce,
      desktopSessionProof: 'native-session-three',
      registry,
    })).rejects.toThrow(/matching reviewed|expired|already used/i);
  });

  it('enforces manual, assisted, and earned-automatic execution modes at projection and execution', async () => {
    const manualRegistry = new ToolRegistry();
    registerOpenTool(manualRegistry);
    await reviewAndActivate(manualRegistry, proposal({ executionMode: 'manual' }));
    const manualProxy = listActiveExternalCapabilities(OWNER, manualRegistry)[0].actions[0].toolName;
    expect(manualRegistry.getToolDeclarations({ context: { userId: OWNER, domain: 'personal', source: 'chat' } })
      .map(item => item.function.name)).not.toContain(manualProxy);
    const bypassManual = await executeToolCall({
      registry: manualRegistry,
      name: manualProxy,
      arguments: {},
      context: { ...ownerContext(), source: 'chat', currentTurnExecutionRequested: true },
    });
    expect(bypassManual.error).toMatch(/manual external capability/i);

    const assistedRegistry = new ToolRegistry();
    registerOpenTool(assistedRegistry);
    await reviewAndActivate(assistedRegistry, proposal({ executionMode: 'assisted' }));
    const assistedProxy = listActiveExternalCapabilities(OWNER, assistedRegistry)[0].actions[0].toolName;
    expect(assistedRegistry.getToolDeclarations({ context: { userId: OWNER, domain: 'personal', source: 'autonomous', autonomous: true } })
      .map(item => item.function.name)).not.toContain(assistedProxy);
    const bypassAssisted = await executeToolCall({
      registry: assistedRegistry,
      name: assistedProxy,
      arguments: {},
      context: { ...ownerContext(), source: 'autonomous', autonomous: true, taskId: 'assisted-task', currentTurnExecutionRequested: true },
    });
    expect(bypassAssisted.error).toMatch(/assisted-only/i);

    const automaticRegistry = new ToolRegistry();
    registerOpenTool(automaticRegistry);
    await reviewAndActivate(automaticRegistry, proposal());
    const automaticProxy = listActiveExternalCapabilities(OWNER, automaticRegistry)[0].actions[0].toolName;
    const autonomousTask = {
      id: 'external-auto-task',
      userId: OWNER,
      title: 'Open customer video tool',
      description: 'Open the reviewed customer video tool.',
      source: 'user_request' as const,
    };
    expect(buildAutonomousCapabilityPipeline(autonomousTask, 10, automaticRegistry).modelToolProjection.toolNames)
      .not.toContain(automaticProxy);
    const premature = await executeToolCall({
      registry: automaticRegistry,
      name: automaticProxy,
      arguments: {},
      context: { ...ownerContext(), source: 'autonomous', autonomous: true, taskId: autonomousTask.id, currentTurnExecutionRequested: true },
    });
    expect(premature.error).toMatch(/not earned automatic/i);

    await executeExternalCapabilityAction({
      ownerUserId: OWNER,
      capabilityId: 'aivid.tool',
      actionId: 'open-tool',
      arguments: {},
      requestId: 'automatic-acceptance-request',
      idempotencyKey: 'automatic-acceptance-idempotency',
      registry: automaticRegistry,
      context: ownerContext(),
    });
    expect(buildAutonomousCapabilityPipeline(autonomousTask, 10, automaticRegistry).modelToolProjection.toolNames)
      .toContain(automaticProxy);
    const unbranded = await executeToolCall({
      registry: automaticRegistry,
      name: automaticProxy,
      arguments: {},
      context: { ...ownerContext(), source: 'autonomous', autonomous: true, taskId: autonomousTask.id, currentTurnExecutionRequested: true },
    });
    expect(unbranded.error).toMatch(/host-owned autonomous task authority/i);
    const brandedContext = attachAutonomousHostAuthority({
      userId: OWNER,
      domain: 'personal' as const,
      orgId: '',
      autonomous: true,
      source: 'autonomous',
      taskId: autonomousTask.id,
      currentTurnExecutionRequested: true,
    }, { ownerUserId: OWNER, taskId: autonomousTask.id });
    const earned = await executeToolCall({
      registry: automaticRegistry,
      name: automaticProxy,
      arguments: {},
      context: brandedContext,
    });
    expect(earned.error).toBeUndefined();
  });

  it('keeps an unknown pending receipt and never repeats a completed action when outer persistence fails', async () => {
    const registry = new ToolRegistry();
    const calls = registerOpenTool(registry);
    await reviewAndActivate(registry);
    const beforeReceipts = structuredClone(readDB().externalCapabilityReceipts);
    let persistenceCalls = 0;
    configureExternalCapabilityRegistryForTests({
      persist: async () => {
        persistenceCalls += 1;
        if (persistenceCalls === 2) throw new Error('forced execution persistence failure');
        await flushDBOrThrow();
      },
    });
    const request = {
      ownerUserId: OWNER,
      capabilityId: 'aivid.tool',
      actionId: 'open-tool',
      arguments: {},
      requestId: 'failed-persist-request',
      idempotencyKey: 'failed-persist-idempotency',
      registry,
      context: ownerContext(),
    };
    const unknown = await executeExternalCapabilityAction(request);
    expect(unknown.execution).toMatchObject({
      status: 'unknown_outcome',
      recovery: {
        pendingPersistence: true,
        requestId: 'failed-persist-request',
        idempotencyKey: 'failed-persist-idempotency',
      },
    });
    expect(unknown.execution.error).toMatch(/may have completed.*automatic resend was stopped/i);
    expect(calls).toHaveLength(1);
    expect(readDB().externalCapabilityReceipts).toHaveLength(beforeReceipts.length + 1);
    expect(readDB().externalCapabilityReceipts.at(-1)).toMatchObject({
      status: 'unknown_outcome',
      hostVerified: false,
      persistenceState: 'pending',
      idempotencyKey: 'failed-persist-idempotency',
    });
    expect(persistenceCalls).toBe(2);
    expect(listActiveExternalCapabilities(OWNER, registry)[0].stage).toBe('connected');

    configureExternalCapabilityRegistryForTests(null);
    const recovered = await executeExternalCapabilityAction(request);
    expect(recovered.execution).toMatchObject({
      status: 'verified_success',
      recovery: { pendingPersistence: false, deduplicated: true, recovered: true },
    });
    expect(recovered.execution.error).toBeUndefined();
    expect(calls).toHaveLength(1);
    expect(readDB().externalCapabilityReceipts).toHaveLength(beforeReceipts.length + 1);
    expect(readDB().externalCapabilityReceipts.at(-1)).toMatchObject({
      status: 'verified_success',
      hostVerified: true,
      persistenceState: 'persisted',
      idempotencyKey: 'failed-persist-idempotency',
    });
  });

  it('keeps a failed mutation unknown when its handler changed state before throwing and never replays it', async () => {
    const registry = new ToolRegistry();
    const calls: Array<Record<string, unknown>> = [];
    registry.register({
      name: 'reviewed_open_tool',
      description: 'Perform one reviewed local mutation whose provider may fail after changing state.',
      parameters: {
        type: 'object',
        properties: { url: { type: 'string' } },
        required: ['url'],
      },
      permission: 'user',
      securityLevel: 'safe',
      capability: {
        id: 'reviewed_open_tool',
        family: 'web',
        lane: 'web',
        source: 'builtin',
        operation: 'mutate',
        risk: 'low',
        sideEffects: [{ type: 'local_state_change', scope: 'browser', reversible: false }],
        verification: {
          strategy: 'state_diff',
          required: true,
          requiredFields: ['status'],
          successStatuses: ['opened'],
          successSignals: ['host state changed'],
          limitations: [],
        },
      },
      evidence: {
        capability: 'reviewed_open_tool',
        operation: 'mutate',
        assurance: 'observed',
        subjectArgument: 'url',
      },
      handler: async args => {
        calls.push(structuredClone(args));
        throw new Error('permanent provider failure after local state changed');
      },
    });
    await reviewAndActivate(registry);
    let persistenceCalls = 0;
    configureExternalCapabilityRegistryForTests({
      persist: async () => {
        persistenceCalls += 1;
        if (persistenceCalls === 2) throw new Error('forced final receipt persistence failure');
        await flushDBOrThrow();
      },
    });
    const request = {
      ownerUserId: OWNER,
      capabilityId: 'aivid.tool',
      actionId: 'open-tool',
      arguments: {},
      requestId: 'failed-mutation-request',
      idempotencyKey: 'failed-mutation-idempotency',
      registry,
      context: ownerContext(),
    };

    const unknown = await executeExternalCapabilityAction(request);
    expect(unknown.execution).toMatchObject({
      status: 'unknown_outcome',
      recovery: { pendingPersistence: true },
    });
    expect(calls).toHaveLength(1);
    expect(readDB().externalCapabilityReceipts.at(-1)).toMatchObject({
      status: 'unknown_outcome',
      hostVerified: false,
      persistenceState: 'pending',
      canonicalOutcome: { status: 'unknown_outcome', hostVerified: false },
    });

    configureExternalCapabilityRegistryForTests(null);
    const retry = await executeExternalCapabilityAction(request);
    expect(retry.execution).toMatchObject({
      status: 'unknown_outcome',
      recovery: { deduplicated: true, recovered: true },
    });
    expect(calls).toHaveLength(1);
  });

  it('rehydrates active proxies after a database restart', async () => {
    const registry = new ToolRegistry();
    registerOpenTool(registry);
    await reviewAndActivate(registry);
    await closeDatabase();
    await initDatabase();
    resetExternalCapabilityRegistryForTests();
    const restartedRegistry = new ToolRegistry();
    registerOpenTool(restartedRegistry);
    const hydration = await hydrateExternalCapabilities(restartedRegistry);
    expect(hydration).toMatchObject({ active: 1, ready: 1, unavailable: 0, proxies: 1 });
    expect(listActiveExternalCapabilities(OWNER, restartedRegistry)).toHaveLength(1);
  });

  it('skips a malformed persisted package without crashing hydration or listing', async () => {
    const registry = new ToolRegistry();
    registerOpenTool(registry);
    await reviewAndActivate(registry);
    const db = readDB();
    db.externalCapabilityPackages.push({
      id: 'malformed-row',
      ownerUserId: OWNER,
      capabilityId: 'malformed.package',
      version: '1.0.0',
      status: 'active',
      packageDigest: '0'.repeat(64),
      proposal: { broken: true },
      resolvedActions: [],
      availability: 'ready',
      unavailableReason: '',
      createdAt: '',
      reviewedAt: '',
      activatedAt: '',
      updatedAt: '',
      lastHydratedAt: '',
    } as any);
    writeDB(db);
    await expect(hydrateExternalCapabilities(registry)).resolves.toMatchObject({
      active: 2,
      ready: 1,
      unavailable: 1,
    });
    expect(listActiveExternalCapabilities(OWNER, registry)).toHaveLength(1);
  });

  it('keeps personal reviewed capability guidance out of work-domain context', async () => {
    const registry = new ToolRegistry();
    registerOpenTool(registry);
    await reviewAndActivate(registry);
    const flow = buildLumiExecutionPipeline({
      dispatch: {
        userId: OWNER,
        text: 'Open the reviewed customer video tool.',
        channel: 'chat',
        source: 'command-center-chat',
        operationMode: 'assistant',
        domain: 'work',
        orgId: 'org-one',
        targetIsLumi: true,
      },
      registry,
      personalityToolPolicy: { allowedTools: ['*'], requireConfirmation: [], forbiddenTools: [], maxIterations: 20 },
    }).turnIntent.flow;
    const prompt = buildLumiRuntimeCapabilityContext({
      userId: OWNER,
      text: 'Open the reviewed customer video tool.',
      flow,
      toolRegistry: registry,
      domain: 'work',
      orgId: 'org-one',
    });
    expect(prompt).not.toContain('AIVID customer tool');
    expect(prompt).not.toContain('external_capability_action_');
  });
});
