import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';

function loadPhase(path: string, name: string, bindings: Record<string, any>) {
  const source = ts.createSourceFile(path, readFileSync(resolve(path), 'utf8'), ts.ScriptTarget.Latest, true);
  const imports = source.statements.filter(ts.isImportDeclaration);
  const names = imports.flatMap(node => node.importClause?.namedBindings && ts.isNamedImports(node.importClause.namedBindings)
    ? node.importClause.namedBindings.elements.filter(item => !item.isTypeOnly).map(item => item.name.text) : []);
  const body = source.statements.filter(node => !ts.isImportDeclaration(node)).map(node => node.getFullText(source)).join('');
  const compiled = ts.transpileModule(body, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const exports: Record<string, any> = {};
  new Function('exports', ...names, compiled)(exports, ...names.map(key => bindings[key] ?? (() => undefined)));
  return exports[name];
}

function fixture() {
  const abort = new AbortController();
  const authorized = vi.fn();
  const bound = vi.fn(async () => ({ taskId: 'accepted-task', turnRowId: 'accepted-turn' }));
  const emit = vi.fn();
  const policy = { allowedTools: ['actual_read'], forbiddenTools: ['actual_write'], requireConfirmation: ['actual_send'] };
  const context: any = {
    uid: 'test-user', requestId: 'test-request', conversationId: 'test-conversation', conversation: { id: 'test-conversation' },
    effectiveUserId: 'test-user', source: 'test-remote', msg: { text: 'Original request', messageId: 'native-message' },
    requestText: 'Original request', text: 'Original request', visibleUserText: 'Original request', routingText: 'Original request',
    resolvedDomain: 'personal', domain: 'personal', personality: { id: 'lumi', name: 'Lumi' },
    effectiveSystemPrompt: 'USER-CONFIGURED-PERSONA', systemPrompt: 'USER-CONFIGURED-PERSONA', fullPersonalityPrompt: 'USER-CONFIGURED-PERSONA',
    toolSecurityContext: { executionBoundary: 'native' }, modelCapabilityPolicy: policy, modelToolPolicy: policy,
    toolSessionActive: true, executionDecision: { allowToolUse: true, promptOverlay: 'OBSOLETE-EXECUTION-PROSE' },
    workSurfaceRoute: { promptOverlay: 'OBSOLETE-WORKSURFACE-PROSE' },
    capabilitySelection: { lane: 'actual-source', primary: 'actual_read', preferredTools: ['actual_read'], reasons: ['actual-source'], promptOverlay: 'OBSOLETE-CAPABILITY-PROSE' },
    desktopExecutionPolicy: { applies: true, promptOverlay: 'OBSOLETE-DESKTOP-PROSE' },
    turnFlow: { routeText: 'Original request', surface: 'chat', promptOverlay: 'EXISTING-FLOW' },
    turnDispatch: { promptOverlay: 'EXISTING-DISPATCH' }, intentTrace: { summary: 'actual-route' },
    actionTaskExecution: { kind: 'none', turnRowId: 'accepted-turn', prepareSelectedToolCall: bound },
    confirmationResolution: {}, abortController: abort, actionAbortController: abort, pipelineAbort: abort,
    turnAuthorization: { isCurrent: () => true, assertCurrent: authorized },
    normalizeAgentPayload: (_event: string, payload: any) => payload,
    executionPipeline: { executionRequested: true, resolution: { id: 'actual-resolution' } },
    executionPlan: { normalizedIntent: {}, resolution: { id: 'actual-resolution' } },
    emitAgent: emit, socket: { emit }, requestToolRecords: [], conversationHistory: [{ role: 'user', content: 'Earlier native text' }],
    operationMode: 'assistant', effectiveOperationMode: 'assistant',
    session: { userId: 'test-user' }, conversationTurn: { conversation: { id: 'test-conversation' } }, voiceScope: {},
    executionReceipts: { bindTask: vi.fn() }, baseVoiceOverlay: 'REAL-VOICE-TRANSPORT', topicContext: '',
    pendingConfirmationPrompt: 'REAL-PENDING-CONFIRMATION', actionContinuationBridge: 'REAL-ACTION-CONTINUATION',
    isIdentityBound: true, isOrganizationBound: false, options: {}, explicitRemoteMemoryIds: [],
  };
  const relay = { releaseControlLease: vi.fn() };
  const bindings: Record<string, any> = {
    extendTurnBindings: (base: object, added: object) => Object.defineProperties(base, Object.getOwnPropertyDescriptors(added)),
    createDesktopRelay: () => relay,
    createConversationReceiptObserver: () => ({ onDesktopLateResult: vi.fn() }),
    startConversationActionExecutionHeartbeat: vi.fn(() => ({ stop: vi.fn() })),
    buildDurableTaskDeterministicToolRecoveryCall: () => undefined,
    coalesceToolExecutionRecords: (records: unknown[]) => records,
    withDesktopExecutionReceipt: (records: unknown[]) => records,
    restrictVisibleToolNamesForExecutionBoundary: (names: string[]) => [...names],
    executionBoundaryPromptOverlay: (text: string) => text,
    restrictSystemPromptForExecutionBoundary: (text: string, boundary: string) => boundary === 'remote_restricted' ? 'ACTUAL-REMOTE-ISOLATION' : text,
    buildInteractionModeOverlay: () => 'OBSOLETE-INTERACTION-PROSE',
    buildVisionRoutingOverlay: () => 'OBSOLETE-VISION-PROSE',
    buildLumiOperatingKernelPrompt: () => 'OBSOLETE-KERNEL-PROSE',
    buildDesktopExecutionStabilityPolicy: () => context.desktopExecutionPolicy,
    createDesktopExecutionTracker: () => ({ actualTracker: true }),
    buildLumiRuntimeCapabilityContext: () => 'EXISTING-RUNTIME-CAPABILITY',
    formatCompactClientSelfPrompt: () => 'EXISTING-CLIENT-SELF', formatClientSelfPromptForTurn: () => 'EXISTING-CLIENT-SELF',
    buildVoiceReplyStyleOverlay: () => 'REAL-VOICE-STYLE',
    getScopedPreferredLLM: () => ({ provider: 'test-provider', model: 'test-model' }),
    getUserPreferredLLMConfig: () => ({ provider: 'test-provider', model: 'test-model' }),
    resolveModelRequestInputBudget: () => Infinity,
    buildResponseLanguageInstruction: () => 'REAL-LANGUAGE-PREFERENCE',
    createTurnConfirmation: vi.fn(() => vi.fn()),
    logger: { info: vi.fn() }, toolRegistry: {},
  };
  return { context, bindings, abort, policy, authorized, bound, relay };
}

describe('entry execution policies remain data rather than automatic prompt instructions', () => {
  it('preserves native prompt, accepted request and live tool policy through the actual lease phase', async () => {
    const f = fixture();
    const phase = loadPhase('server/socket/chat/phases/prepare_chat_execution_lease_and_tools.ts', 'prepareChatExecutionLeaseAndTools', f.bindings);
    const result = await phase(f.context);
    expect(result.context.effectiveSystemPrompt).toBe('USER-CONFIGURED-PERSONA');
    expect(result.context.toolContext.toolPolicy).toBe(f.policy);
    expect(result.context.toolContext.executionSignal).toBe(f.abort.signal);
    expect(result.context.toolContext.actionIntent).toBe('Original request');
    const selected = await result.context.toolContext.prepareSelectedToolCall();
    expect(selected.taskId).toBe('accepted-task');
    expect(f.bound).toHaveBeenCalledOnce();
    expect(f.authorized).toHaveBeenCalledTimes(2);
    expect(result.context.toolContext.desktopRelay).toBe(f.relay);
  });

  it.each(['native', 'remote_restricted'])('keeps voice input, pending confirmation and remote isolation for %s', async boundary => {
    const f = fixture(); f.context.toolSecurityContext.executionBoundary = boundary;
    const phase = loadPhase('server/socket/voice/turn/prepare_voice_execution_and_prompt.ts', 'prepareVoiceExecutionAndPrompt', f.bindings);
    const result = await phase(f.context);
    expect(result.context.voiceSystemPrompt).not.toContain('OBSOLETE-');
    expect(result.context.voiceSystemPrompt).toContain(boundary === 'remote_restricted' ? 'ACTUAL-REMOTE-ISOLATION' : 'USER-CONFIGURED-PERSONA');
    expect(result.context.voiceSystemPrompt).toContain('REAL-VOICE-TRANSPORT');
    expect(result.context.voiceSystemPrompt).toContain('REAL-PENDING-CONFIRMATION');
    expect(result.context.voiceSystemPrompt).toContain('REAL-ACTION-CONTINUATION');
    expect(f.context.session.activeForegroundRequestIdentity.requestId).toBe('test-request');
  });

  it('keeps remote native history, current input, confirmation and real execution context', async () => {
    const f = fixture();
    const phase = loadPhase('server/regions/packs/cn/messaging_turn/execution_preparation.ts', 'prepareMessagingExecution', f.bindings);
    const result = await phase(f.context);
    expect(result.context.systemPrompt).not.toContain('OBSOLETE-');
    expect(result.context.messages[1]).toEqual({ role: 'user', content: 'Earlier native text' });
    expect(result.context.messages.at(-1).content).toBe('Original request\n\nREAL-PENDING-CONFIRMATION');
    expect(result.context.remoteToolContext.toolPolicy).toBe(f.policy);
    expect(result.context.remoteToolContext.executionSignal).toBe(f.abort.signal);
    expect(result.context.remoteToolContext.actionIntent).toBe('Original request');
    expect(result.context.remoteToolContext.requestConfirmation).toBeTypeOf('function');
  });
});
