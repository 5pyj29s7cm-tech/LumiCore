import { extendTurnBindings } from "../../../cognition/turn_bindings";
import { logger } from "../../../../logger";
import { createDurableForegroundReleaseGate } from "../../../conversation/manager";
import { recordChatExecutionPersistenceUnknownDurably } from "../../chat_execution_registry";
import { flushDBOrThrow } from "../../../../db_layer";
import { stopVoiceWorkHeartbeat } from "../work_progress";
import { commitChatTerminalBoundary, persistAuthorizedTerminalReceipt } from "../../chat_terminal_boundary";
import { resetSilenceTimer, enforceVoiceForegroundConvergenceBeforeRelease } from "../../voice_transport_runtime";
import type { ToolExecutionRecord } from "../../../tools/types";
import { scheduleTurnMemory } from "../../../memory/turn_memory";
import { createVoiceTerminalCompletion } from "../terminal_completion";
import type { prepareVoiceSpeech } from './prepare_voice_speech';

export async function prepareVoiceRelease(context: NonNullable<Awaited<ReturnType<typeof prepareVoiceSpeech>>["context"]>) {


  const commitVoiceTerminal = async <T = unknown>(input: {
    text: string;
    source: string;
    blocked: boolean;
    reason?: string;
    cognitiveIntent: string;
    llmWasCalled: boolean;
    toolCalls?: ToolExecutionRecord[];
    speechText?: string;
    notification?: Record<string, any>;
    persistTerminalState?: () => T;
    publishAfter?: (terminalState: T | undefined) => void;
  }): Promise<boolean> => {
    // An interrupted/superseded turn no longer owns persistence, publication,
    // or speech. Its cancellation terminal is committed by the transport
    // handler against the captured request identity instead.
    if (!context.isCurrentTurn()) return false;
    if (context.actionLeaseHeartbeat?.isLeaseLost()) {
      await context.actionLeaseHeartbeat.leaseLoss;
      return false;
    }
    const terminalPayload = context.normalizeAgentPayload('agent:response', {
      text: input.text,
      agentName: 'Lumi',
      source: input.source,
      finalized: true,
      blocked: input.blocked,
      reason: input.reason || '',
    });
    const committed = await commitChatTerminalBoundary<T | undefined>({
      persistTerminalState: () => {
        if (!context.isCurrentTurn()) throw Object.assign(new Error('Voice turn superseded'), { name: 'AbortError' });
        context.persistVoiceUserMessage(input.cognitiveIntent);
        context.persistSidecarConversation(context.conversationTurn.conversation.id);
        return input.persistTerminalState?.();
      },
      persistAssistantMessage: () => {
        if (!context.isCurrentTurn()) throw Object.assign(new Error('Voice turn superseded'), { name: 'AbortError' });
        // Keep the request lease alive until the assistant row has consumed
        // the terminal tool receipts. Settling it first clears the pending
        // turn and makes the durable transcript lose the very evidence needed
        // to complete the task.
        const assistantMessageId = context.persistVoiceAssistantMessage(
          context.conversationTurn.conversation.id,
          input.text,
          {
            toolCalls: input.toolCalls,
            cognitiveIntent: input.cognitiveIntent,
            llmWasCalled: input.llmWasCalled,
            source: input.source,
            terminalTaskDisposition: input.blocked && context.foregroundRequestIdentity?.expectedTaskId
              ? {
                  outcome: 'blocked',
                  taskId: context.foregroundRequestIdentity.expectedTaskId,
                  requestId: context.requestId,
                  reason: input.reason || 'Voice terminal response reported a blocked execution.',
                }
              : undefined,
          },
        );
        return assistantMessageId;
      },
      flush: flushDBOrThrow,
      persistTerminalReceipt: () => persistAuthorizedTerminalReceipt({ scope: context.executionScope, requestId: context.requestId,
        event: 'agent:response', payload: terminalPayload, unknownPayload: context.executionUnknownPayload,
        authorization: context.turnAuthorization, channel: 'voice', flush: flushDBOrThrow }),
      persistUnknownReceipt: () => recordChatExecutionPersistenceUnknownDurably(
        context.executionScope,
        context.requestId,
        context.executionUnknownPayload,
      ),
      publishCommitted: terminalState => {
        if (!context.turnAuthorization.isCurrent()) { context.publishRecordedAgent('agent:response', terminalPayload); return; }
        if (!context.isCurrentTurn()) return;
        if (input.notification) {
          context.publishRecordedAgent(
            'agent:notification',
            context.normalizeAgentPayload('agent:notification', input.notification),
          );
        }
        const executionWriteback = terminalState as any;
        if (executionWriteback?.recorded) {
          context.publishRecordedAgent(
            'agent:task_execution_writeback',
            context.normalizeAgentPayload('agent:task_execution_writeback', executionWriteback),
          );
        }
        context.publishRecordedAgent('agent:response', terminalPayload);
        context.socket.emit('chat:conversation_updated', {
          conversationId: context.conversationTurn.conversation.id,
          agentId: context.session.agentId,
          source: input.source,
          requestId: context.requestId,
        });
        context.scheduleVoiceSummary(context.conversationTurn.conversation.id);
        if (String(input.speechText || '').trim()) context.queueFinalizedSpeech(input.speechText!);
        input.publishAfter?.(terminalState);
      },
      publishUnknown: () => {
        context.publishRecordedAgent('agent:response', context.executionUnknownPayload);
      },
      persistenceUnknownProjection: {
        text: context.executionUnknownPayload.text,
        completionFeedback: context.executionUnknownPayload.completionFeedback,
        reason: 'Terminal persistence outcome is unknown.',
      },
      onPersistenceError: error => {
        logger.error(`[Audio] ${input.source} terminal persistence failed:`, error);
      },
    });
    if (committed && !terminalPayload.blocked && context.turnAuthorization.isCurrent()) scheduleTurnMemory({
      userId: context.session.userId, domain: context.voiceScope.domain, orgId: context.voiceScope.orgId, userText: context.userText,
      channel: 'voice', source: 'voice', requestId: context.requestId, conversationId: context.conversationTurn.conversation.id,
      agentId: context.session.agentId, authorization: context.turnAuthorization, llmGetters: context.llmGetters,
    });
    return committed;
  };

  const releaseVoiceTransportResources = (): void => {
    context.resources.admission?.release();
    context.actionLeaseHeartbeat?.stop();
    context.speculativeSpeech?.controller.abort();
    context.speculativeSpeech = null;
    context.desktopRelay.releaseControlLease('voice_turn_complete');

    // An older aborted pipeline must never clear state/controllers that already
    // belong to a newer barge-in turn.
    if (context.session.pipelineAbortController !== context.pipelineAbort) return;
    if (
      context.session.activeTaskConversationId
      && context.session.activeTaskRequestId === context.requestId
    ) {
      context.session.activeTaskConversationId = null;
      context.session.activeTaskRequestId = null;
      context.session.activeTaskId = null;
    }
    if (context.session.activeForegroundRequestIdentity?.requestId === context.requestId) {
      context.session.activeForegroundRequestIdentity = null;
    }
    context.session.sidecarAbortController?.abort();
    context.session.sidecarAbortController = null;
    context.session.sidecarGeneration++;
    context.session.sidecarHistory = [];
    context.session.isSpeaking = false;
    context.session.isProcessing = false;
    context.session.isBackgroundWork = false;
    context.session.activeWorkStatus = 'idle';
    context.session.activeWorkStep = '';
    context.session.activeWorkToolCalls = 0;
    stopVoiceWorkHeartbeat(context.session);
    if (context.session.ttsAbortController === context.turnSpeechAbort) context.session.ttsAbortController = null;
    context.session.pipelineAbortController = null;
    context.session.activeTurnText = '';
    context.session.activeRoutingText = '';

    if (context.session.isActive) {
      resetSilenceTimer(context.session, context.socket);
      context.socket.emit('audio:status', { status: 'listening', requestId: context.requestId });
      context.emitAgent('agent:status', { status: 'idle' });
    }
    context.session.activeTurnRequestId = null;
    context.session.activeTurnProvenance = null;
    context.session.suppressedSpeechRequestIds.delete(context.requestId);
  };
  const voiceReleaseGate = createDurableForegroundReleaseGate({
    converge: async reason => {
      // The cancellation owner must consume completed/in-flight tool receipts
      // before this old pipeline can settle its task or release the lease.
      if (context.executionReceipts.cancellation) await context.executionReceipts.cancellation;
      // Durable ownership always converges before any heartbeat, desktop lease,
      // or mutable voice work lane is released. This remains safe for an older
      // aborted pipeline because the immutable identity is local to this turn.
      const releaseResult = await enforceVoiceForegroundConvergenceBeforeRelease({
        identity: context.foregroundRequestIdentity,
        aborted: context.pipelineAbort.signal.aborted,
        reason,
        assistantState: context.finalAgentResponseDelivered ? context.responseText : undefined,
      });
      return Boolean(releaseResult?.converged);
    },
    releaseResources: releaseVoiceTransportResources,
    onRecoveryTakeover: ({ attempts }) => logger.error('[Audio] voice_foreground_release_recovery_takeover', {
      code: 'VOICE_FOREGROUND_RELEASE_RECOVERY_TAKEOVER',
      identity: context.foregroundRequestIdentity,
      attempts,
    }),
  });
  context.resources.ownedByDurableRelease = true;
  const releaseVoiceTurnResources = (
    reason = 'Voice turn reached its release boundary.',
  ): Promise<boolean> => {
    const cancel = !context.turnAuthorization.isCurrent() && !context.finalAgentResponseDelivered
      ? context.session.cancelAuthorizationTurn?.(context.requestId)
      : undefined;
    return Promise.resolve(cancel).then(() => voiceReleaseGate.release(reason));
  };

  const finishVoiceTerminal = createVoiceTerminalCompletion({
    commit: commitVoiceTerminal,
    drainSpeech: () => Promise.allSettled(context.ttsPromises),
    isCurrent: context.isCurrentTurn,
  });
  return { terminal: false as const, context: extendTurnBindings(context, {
    finishVoiceTerminal,
    releaseVoiceTurnResources,
  }) };
}
