import { extendTurnBindings } from "../../../cognition/turn_bindings";
import { flushDBOrThrow } from "../../../../db_layer";
import { readScopedDeletionReceipt } from "../../../persistence/durable_scope_mutation";
import { runAfterAcceptedUserTurnAdmission } from "../../action_turn_durability";
import { createDurableForegroundReleaseGate } from "../../../conversation/manager";
import { CN_TASK_EXECUTION_MESSAGES } from "../../../regions/messages/task_execution_messages";
import { beginChatExecutionDurably, recordChatExecutionPersistenceUnknownDurably } from "../../chat_execution_registry";
import type { admitChatForegroundTurn } from './admit_chat_foreground_turn';
import { convergeChatForegroundRequestBeforeRelease, chatDurabilityUnknownText } from './shared';

export async function startChatForegroundTurn(context: NonNullable<Awaited<ReturnType<typeof admitChatForegroundTurn>>["context"]>) {

    const releaseChatTransportResources = (): void => {
      context.stopAuthorizationWatch();
      context.abortController.signal.removeEventListener('abort', context.markRequestCancellation);
      context.unregisterShutdownCancellation();
      context.actionLeaseHeartbeat?.stop();
      context.releaseDesktopControlLease?.();
      context.releaseDesktopControlLease = null;
      context.sessionLease.release();
    };
    const chatReleaseGate = createDurableForegroundReleaseGate({
      converge: async reason => {
        // Pre-binding exits own no durable action-turn lease.
        if (!context.foregroundRequestIdentity) return true;
        // An explicit deletion removes this request's transcript and action
        // projection together. Once that deletion is durable there is no
        // deleted lease to reconstruct or endlessly retry. Independently
        // running native work retains its own execution/settlement fencing.
        if (!context.conversationAuthorization.isCurrent() && readScopedDeletionReceipt(
          { userId: context.uid, domain: context.resolvedDomain, orgId: context.resolvedOrgId },
          'conversation', context.selectedConversationId,
        )) {
          await flushDBOrThrow();
          return true;
        }
        const releaseResult = await convergeChatForegroundRequestBeforeRelease({
          identity: context.foregroundRequestIdentity,
          aborted: context.abortController.signal.aborted,
          reason,
        });
        if (!releaseResult.converged) {
          console.error('[ChatHandler] foreground_request_finalization_incomplete', {
            code: 'CHAT_FOREGROUND_FINALIZATION_INCOMPLETE',
            identity: context.foregroundRequestIdentity,
            convergence: {
              finalStatus: releaseResult.convergence.finalStatus,
              reason: releaseResult.convergence.reason,
              evidence: releaseResult.convergence.evidence,
            },
            finalization: releaseResult.finalization ? {
              effectiveOutcome: releaseResult.finalization.effectiveOutcome,
              taskStatus: releaseResult.finalization.taskStatus,
              actionTurnStatus: releaseResult.finalization.actionTurnStatus,
              reason: releaseResult.finalization.reason,
              evidence: releaseResult.finalization.evidence,
            } : null,
          });
        }
        return releaseResult.converged;
      },
      releaseResources: releaseChatTransportResources,
      onFailure: ({ error }) => {
        if (error instanceof Error && error.message === 'foreground_request_not_durably_converged') return;
        const convergenceError = error as any;
        console.error('[ChatHandler] foreground_request_finalization_failed', {
          code: 'CHAT_FOREGROUND_FINALIZATION_FAILED',
          identity: context.foregroundRequestIdentity,
          errorName: String(convergenceError?.name || 'Error'),
          errorMessage: String(convergenceError?.message || 'Unknown convergence error'),
        });
      },
      onRecoveryTakeover: ({ attempts }) => console.error('[ChatHandler] foreground_release_recovery_takeover', {
        code: 'CHAT_FOREGROUND_RELEASE_RECOVERY_TAKEOVER',
        identity: context.foregroundRequestIdentity,
        attempts,
      }),
    });
    const releaseChatSession = (
      reason = 'Chat foreground request reached its release boundary.',
    ): Promise<boolean> => chatReleaseGate.release(reason);

    if (context.sessionLease.waitingForRequestId) {
      try {
        context.ack?.({ ok: true, requestId: context.requestId, receivedAt: new Date().toISOString() });
        context.acknowledged = true;
      } catch {}
      if (context.turnAuthorization.isCurrent()) context.io.to(context.executionRoom).emit('agent:status', {
        status: context.activeMessageRelation === 'replace' ? 'replacing' : 'queued',
        source: context.eventSource,
        requestId: context.requestId,
        waitingForRequestId: context.sessionLease.waitingForRequestId,
        taskRelation: context.resolvedTaskRelation,
      });
    }
    if (!await context.sessionLease.waitForTurn().then(() => true, error => {
      if (!context.abortController.signal.aborted) throw error;
      return false;
    })) {
      const waitTimedOut = context.sessionLease.state === 'timed_out';
      const terminalText = waitTimedOut
        ? CN_TASK_EXECUTION_MESSAGES.queueWaitTimedOut
        : CN_TASK_EXECUTION_MESSAGES.cancelled;
      await context.commitChatReply({
        text: terminalText,
        blocked: true,
        reason: waitTimedOut ? 'queue_wait_timeout' : 'cancelled',
        message: () => ({
          cognitiveIntent: waitTimedOut ? 'queue_wait_timeout' : 'task_cancel',
        }),
        errorContext: waitTimedOut ? 'Queued wait timeout terminal' : 'Queued cancellation terminal',
      });
      await releaseChatSession();
      { return { terminal: true as const, context: undefined }; }
    }
    let superseded = null as Awaited<ReturnType<typeof beginChatExecutionDurably>>;
    try {
      superseded = await runAfterAcceptedUserTurnAdmission(
        context.chatAdmission,
        () => beginChatExecutionDurably(context.executionScope, context.requestId, {
          text: chatDurabilityUnknownText(context.visibleUserText),
          agentName: 'Lumi',
        }),
      );
    } catch (error) {
      console.error('[ChatHandler] Superseded terminal persistence failed:', error);
      const unknownPayload = context.normalizeAgentPayload('agent:response', {
        text: chatDurabilityUnknownText(context.visibleUserText),
        agentName: 'Lumi',
        finalized: true,
        blocked: true,
        reason: 'persistence_unknown',
      });
      try {
        await recordChatExecutionPersistenceUnknownDurably(
          context.executionScope,
          context.requestId,
          unknownPayload,
        );
      } catch (unknownError) {
        console.error('[ChatHandler] Replacement unknown receipt persistence failed:', unknownError);
      }
      context.publishRecordedAgent('agent:response', unknownPayload);
      await releaseChatSession();
      { return { terminal: true as const, context: undefined }; }
    }
    if (superseded?.terminalEvent && context.turnAuthorization.isCurrent()) {
      context.io.to(context.executionRoom).emit(superseded.terminalEvent.event, superseded.terminalEvent.payload);
    }
    if (!context.acknowledged) {
      try { context.ack?.({ ok: true, requestId: context.requestId, receivedAt: new Date().toISOString() }); } catch {}
    }
  return { terminal: false as const, context: extendTurnBindings(context, {
    releaseChatSession: releaseChatSession as typeof releaseChatSession,
  }) };
}
