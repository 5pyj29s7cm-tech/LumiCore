import '../test/helpers';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeAll, expect, it, vi } from 'vitest';
import { initDatabase, flushDBOrThrow } from '../db_layer';
import { captureRequestAuthorization } from '../server/conversation/lifecycle';
import { addMessageIdempotent, getOrCreateActiveConversation, startConversationActionExecutionHeartbeat } from '../server/conversation/manager';
import { preparePlannedConversationExecution } from '../server/conversation/planned_execution';
import { buildLumiExecutionPipeline } from '../server/cognition/execution_pipeline';
import { extendTurnBindings } from '../server/cognition/turn_bindings';
import { executeToolCall } from '../server/tools/execution_engine';
import { registerFileOpsTools } from '../server/tools/definitions/file_ops';
import { ToolRegistry } from '../server/tools/registry';
import type { ToolPolicy } from '../server/personality/types';
import { createVoiceExecutionReceiptCollector } from '../server/socket/voice_execution_receipts';
import { prepareVoiceReceiptsAndTools } from '../server/socket/voice/turn/prepare_voice_receipts_and_tools';

// No desktop, audio, summaries or learning are used. Keep the real selected-call
// owner, voice preparation callback, registry/engine and receipt collector.
vi.mock('../server/socket/desktop_relay', () => ({
  createDesktopRelay: vi.fn(() => Object.assign(async () => { throw new Error('NO_DESKTOP_IO'); }, {
    releaseControlLease: vi.fn(), getControlPauseReason: () => null,
  })),
}));
vi.mock('../logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('../server/conversation/summary_scheduler', () => ({ scheduleConversationSummary: vi.fn() }));
vi.mock('../server/personality/state', () => ({ loadEmotionalState: () => undefined }));
vi.mock('../server/cognition/post_turn_learning', () => ({ persistLumiPostTurnLearning: vi.fn() }));
vi.mock('../server/work_takeover/execution_writeback', () => ({ persistWorkTakeoverTurnExecution: vi.fn() }));

beforeAll(() => initDatabase());
let stopAcceptedHeartbeat = () => {};
afterEach(() => { stopAcceptedHeartbeat(); vi.restoreAllMocks(); });
type VoiceContext = Parameters<typeof prepareVoiceReceiptsAndTools>[0];
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

it('binds the real voice owner and unknown started-call receipt to the selected task across later phase copies', async () => {
  const network = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('VOICE_NEGATIVE_NETWORK_FORBIDDEN'));
  const userId = 'voice-selected-negative-' + randomUUID(), requestId = randomUUID();
  const conversation = getOrCreateActiveConversation(userId, 'lumi', 'personal', '');
  const identity = { userId, conversationId: conversation.id, requestId, domain: 'personal' as const, orgId: '' };
  const userText = 'Please handle the document with these members.';
  const pipelineAbort = new AbortController();
  const authorization = captureRequestAuthorization(() => !pipelineAbort.signal.aborted, 'Isolated voice owner revoked');
  const started = deferred(), release = deferred(), registry = new ToolRegistry();
  const handler = vi.fn(async () => {
    started.resolve(); await release.promise;
    return JSON.stringify({ ok: true, status: 'completed' });
  });
  registerFileOpsTools(registry);
  registry.get('read_file')!.handler = handler;
  const policy: ToolPolicy = { allowedTools: ['*'], forbiddenTools: [], requireConfirmation: [], maxIterations: 3 };
  const executionPipeline = buildLumiExecutionPipeline({
    requestId, dispatch: { ...identity, text: userText, source: 'voice', channel: 'voice', operationMode: 'assistant', targetIsLumi: true },
    registry, personalityToolPolicy: policy, executionBoundary: 'trusted_local',
  });
  expect(executionPipeline.executionRequested).toBe(true);
  const userMessageId = addMessageIdempotent({ ...identity, source: 'voice', channel: 'voice', role: 'user', content: userText, deferActionPreparation: true });
  const actionTaskExecution = preparePlannedConversationExecution({ ...identity, execution: executionPipeline, userText, userMessageId, bindConversationTurn: true });
  if ('bindingFailure' in actionTaskExecution) throw new Error('Synthetic voice turn was not admitted');
  expect(actionTaskExecution.state?.taskId).toBeUndefined();
  const heartbeat = startConversationActionExecutionHeartbeat({ ...identity, abortController: pipelineAbort });
  stopAcceptedHeartbeat = () => heartbeat.stop();
  await flushDBOrThrow();
  const collector = createVoiceExecutionReceiptCollector(requestId);
  collector.bindTask(undefined);
  const foregroundRequestIdentity = Object.freeze({ ...identity });
  const session: Partial<VoiceContext['session']> = {
    userId, agentId: 'lumi', domain: 'personal', orgId: '', sidecarHistory: [], isBackgroundWork: false,
    activeTurnRequestId: requestId, activeTurnText: userText, activeForegroundRequestIdentity: foregroundRequestIdentity,
    activeTaskConversationId: null, activeTaskRequestId: null, activeTaskId: null,
  };
  const input: Partial<VoiceContext> = {
    session: session as unknown as VoiceContext['session'],
    conversationTurn: { conversation } as unknown as VoiceContext['conversationTurn'],
    requestId, userText, actionIntentText: userText, routedUserText: userText, pipelineAbort,
    turnAuthorization: authorization, isCurrentTurn: () => !pipelineAbort.signal.aborted,
    actionTaskExecution, foregroundRequestIdentity, executionReceipts: collector, executionPipeline,
    turnFlow: executionPipeline.turnIntent.flow, voiceScope: { domain: 'personal', orgId: '' },
    routedToolPolicy: policy, modelToolProjection: executionPipeline.modelToolProjection, toolSessionActive: true,
    toolSecurityContext: { authenticated: true, authRole: 'admin', localExecution: true, executionBoundary: 'trusted_local' } as unknown as VoiceContext['toolSecurityContext'],
    effectiveOperationMode: 'assistant', correctionRequiresFreshConfirmation: false, pendingConfirmation: null,
    confirmationResolution: {} as unknown as VoiceContext['confirmationResolution'],
    confirmationScope: { domain: 'personal', orgId: '', channelId: conversation.id },
    confirmationChannelScope: { domain: 'personal', orgId: '', channelId: conversation.id },
    allowLocalFileWrites: false, localWriteIntentReason: '', emitAgent: vi.fn(),
    llmGetters: { getDeepSeek: () => null, getGemini: () => null, getRelay: () => null },
  };
  const prepared = await prepareVoiceReceiptsAndTools(input as unknown as VoiceContext);
  const laterPhase = extendTurnBindings(prepared.context, {});
  const bindSelected = prepared.context.toolContext.prepareSelectedToolCall;
  if (!bindSelected) throw new Error('Actual voice selected-call owner missing');
  const copiedToolContext = { ...prepared.context.toolContext };
  const originalRelay = copiedToolContext.desktopRelay;
  expect(copiedToolContext.taskId).toBeUndefined();
  const execution = executeToolCall({ registry, id: 'voice-deferred-call-' + requestId,
    name: 'read_file', arguments: { path: String(process.env.LUMI_DATA_DIR) + '/deferred-read.txt' }, context: copiedToolContext });
  try {
    await Promise.race([started.promise, execution.then(() => { throw new Error('Adapter settled without entering the deferred fixture'); })]);
    const binding = { taskId: actionTaskExecution.state!.taskId };
    expect(binding.taskId).toBeTruthy();
    expect(copiedToolContext.taskId).toBe(binding.taskId);
    expect(copiedToolContext.desktopRelay).toBe(prepared.context.desktopRelay);
    expect(copiedToolContext.desktopRelay).not.toBe(originalRelay);
    pipelineAbort.abort(new DOMException('Synthetic voice interruption', 'AbortError'));
    const unsettled = await collector.settle(1);
    expect(unsettled).toMatchObject({ settled: false, pendingCount: 1 });
    expect(unsettled.records).toHaveLength(1);
    expect(unsettled.records[0]).toMatchObject({
      taskId: binding.taskId, requestId, turnId: requestId, name: 'read_file',
      terminalVerification: { status: 'unverified', reason: 'tool_settlement_unknown' },
    });
    expect(unsettled.records[0].error).toContain('outcome_unknown');
    expect(laterPhase.foregroundRequestIdentity).toMatchObject({ ...identity, expectedTaskId: binding.taskId });
    expect(prepared.context.foregroundRequestIdentity).toBe(session.activeForegroundRequestIdentity);
    expect(session).toMatchObject({ activeTaskConversationId: conversation.id, activeTaskRequestId: requestId, activeTaskId: binding.taskId });
    expect(actionTaskExecution.state?.taskId).toBe(binding.taskId);
    expect(handler).toHaveBeenCalledOnce(); expect(network).not.toHaveBeenCalled();
  } finally {
    release.resolve(); await execution;
  }
});
