import { extendTurnBindings } from "../../../cognition/turn_bindings";
import { isNamedPersistentWorkTaskStatusQuery } from "../../../cognition/action_contract";
import { readRuntimeWorkForTurn } from "../../../cognition/runtime_work_read";
import { getConversationExecution, getCurrentConversationExecution } from "../../../cognition/conversation_execution";
import { resolveUserTurn } from "../../../cognition/turn_resolution";
import { flushDBOrThrow } from "../../../../db_layer";
import { toolRegistry } from "../../../tools/registry";
import { clearPendingConfirmationDurably } from "../../../tools/pending_confirmation";
import { admitAcceptedUserTurnDurably } from "../../action_turn_durability";
import { personalityRegistry } from "../../../personality";
import { getConversationForScope, getConversationActionStatus, cancelConversationActionExecution } from "../../../conversation/manager";
import { CN_TASK_EXECUTION_MESSAGES } from "../../../regions/messages/task_execution_messages";
import { beginChatSidecarExecution, getDurableChatCancellationForCurrentExecution, getChatExecution, getChatSidecarCancellationTarget, recordChatExecutionPersistenceUnknownDurably, recordChatExecutionTerminalEventDurably, waitForChatSidecarCancellationIntent } from "../../chat_execution_registry";
import { sanitizeChatAgentErrorPayload } from "../../chat_public_error";
import type { prepareChatEvents } from './prepare_chat_events';
import { chatDurabilityUnknownText } from './shared';

export async function resolveChatControlTurn(context: NonNullable<Awaited<ReturnType<typeof prepareChatEvents>>["context"]>) {

    // Request ids are idempotency keys. Socket.IO may deliver a buffered emit
    // after reconnect; acknowledging the existing execution avoids running the
    // same user action twice.
    let existingExecution = getChatExecution(context.executionScope, context.requestId);
    if (existingExecution) {
      if (existingExecution.sidecar === true && !existingExecution.terminal) {
        try {
          await waitForChatSidecarCancellationIntent(context.executionScope, context.requestId);
        } catch (error: any) {
          const publicCode = error?.code === 'CHAT_SIDECAR_TERMINAL_RECEIPT_NOT_DURABLE'
            ? 'CHAT_EXECUTION_FAILED'
            : 'CHAT_CONTROL_RECEIPT_WRITE_FAILED';
          try {
            context.ack?.({
              ok: false,
              requestId: context.requestId,
              error: sanitizeChatAgentErrorPayload({ code: publicCode }).message,
            });
          } catch {}
          { return { terminal: true as const, context: undefined }; }
        }
        existingExecution = getChatExecution(context.executionScope, context.requestId) || existingExecution;
        const durableTarget = getChatSidecarCancellationTarget(context.executionScope, context.requestId);
        if (durableTarget && !getConversationExecution(context.executionScope, durableTarget)) {
          // The process can restart after the durable fence but before the
          // side effect/terminal write. With no matching lease, converge the
          // tombstone to a terminal no-op; never replay cancellation onto a
          // later task.
          const staleControlPayload = context.normalizeAgentPayload('agent:response', {
            text: CN_TASK_EXECUTION_MESSAGES.staleControl,
            agentName: 'Lumi',
            source: context.eventSource,
            requestId: context.requestId,
            conversationId: context.selectedConversationId,
            sidecar: true,
            finalized: true,
            blocked: false,
            reason: 'stale_control',
          });
          const unknownPayload = context.normalizeAgentPayload('agent:response', {
            text: chatDurabilityUnknownText(context.visibleUserText),
            agentName: 'Lumi',
            sidecar: true,
            finalized: true,
            blocked: true,
            reason: 'persistence_unknown',
          });
          try {
            await flushDBOrThrow();
            await recordChatExecutionTerminalEventDurably(
              context.executionScope,
              context.requestId,
              'agent:response',
              staleControlPayload,
              unknownPayload,
            );
          } catch (error: any) {
            console.error('[ChatHandler] Recovered control terminal persistence failed:', error);
            try {
              await recordChatExecutionPersistenceUnknownDurably(
                context.executionScope,
                context.requestId,
                unknownPayload,
              );
            } catch (unknownError) {
              console.error('[ChatHandler] Recovered control unknown receipt persistence failed:', unknownError);
            }
            context.publishRecordedAgent('agent:response', unknownPayload);
            try { context.ack?.({ ok: false, requestId: context.requestId, error: 'Terminal persistence outcome is unknown' }); } catch {}
            { return { terminal: true as const, context: undefined }; }
          }
          existingExecution = getChatExecution(context.executionScope, context.requestId) || existingExecution;
        }
      }
      if (context.rejectRevokedRequest()) { return { terminal: true as const, context: undefined }; }
      try { context.ack?.({ ok: true, requestId: context.requestId, receivedAt: existingExecution.createdAt }); } catch {}
      if (existingExecution.terminalEvent) {
        context.socket.emit(existingExecution.terminalEvent.event, {
          ...existingExecution.terminalEvent.payload,
          replayed: true,
        });
      } else {
        const resumableStatus = existingExecution.status === 'planning' || existingExecution.status === 'acknowledged'
          ? existingExecution.queued === true ? 'queued' : 'thinking'
          : existingExecution.status;
        context.socket.emit('agent:status', {
          status: resumableStatus,
          source: context.eventSource,
          requestId: context.requestId,
          resumed: true,
        });
      }
      { return { terminal: true as const, context: undefined }; }
    }

    // Reconnect/retry may resend a request that is already reserved but has
    // not reached beginChatExecution yet. Acknowledge the existing lease;
    // never attach a second handler to the same queued request.
    const queuedDuplicate = getConversationExecution(context.executionScope, context.requestId);
    if (queuedDuplicate) {
      try {
        context.ack?.({
          ok: true,
          requestId: context.requestId,
          receivedAt: new Date().toISOString(),
        });
      } catch {}
      context.socket.emit('agent:status', {
        status: queuedDuplicate.state === 'active' ? 'thinking' : 'queued',
        source: context.eventSource,
        requestId: context.requestId,
        resumed: true,
      });
      { return { terminal: true as const, context: undefined }; }
    }

    // A status question is a side conversation, not a replacement command.
    // Answer it without aborting/superseding the foreground executor.
    const observedExistingSession = getCurrentConversationExecution(context.executionScope);
    // Socket delivery happens immediately after the terminal durability fence,
    // while queue-resource release finishes a few microtasks later. A fast
    // follow-up can therefore observe the old queue slot even though its
    // request already has a durable terminal. Do not answer that follow-up as
    // "still executing"; let it queue briefly and resolve against the ledger.
    const existingSession = observedExistingSession
      && getChatExecution(context.executionScope, observedExistingSession.requestId)?.terminal !== true
      ? observedExistingSession
      : null;
    const controlTargetRequestId = String(context.data.controlTargetRequestId || '').trim().slice(0, 120);
    const controlTargetTaskId = String(context.data.controlTargetTaskId || '').trim().slice(0, 180);
    const controlTargetRevision = typeof context.data.controlTargetRevision === 'number'
      && Number.isFinite(context.data.controlTargetRevision)
      ? Math.max(0, Math.trunc(context.data.controlTargetRevision))
      : undefined;
    // The serial queue key already includes the explicitly selected
    // conversation id. Resolve status against that exact conversation; using
    // the user's globally active chat here leaks isolated/native E2E sidecars
    // into an unrelated personal transcript.
    const activeConversationForStatus = existingSession ? getConversationForScope(
      context.selectedConversationId,
      context.uid,
      context.resolvedDomain,
      context.resolvedOrgId,
    ) : null;
    context.acceptedTurnResolution = resolveUserTurn({
      requestId: context.requestId, userText: context.visibleUserText,
      state: activeConversationForStatus?.actionContinuationState || context.selectedConversation.actionContinuationState,
      options: {
        activeRequestId: existingSession?.requestId,
        controlTargetRequestId,
        controlTargetTaskId,
        controlTargetRevision,
        pendingAssistantOfferContext: context.pendingAssistantOfferContext,
      },
    });
    context.resolvedTaskRelation = { ...context.acceptedTurnResolution.taskRelation };
    if (!context.isMemoryAvatar && context.acceptedTurnResolution.queryTarget === 'runtime_work'
      && context.acceptedTurnResolution.userIntent.operation === 'status') {
      if (!beginChatSidecarExecution(context.executionScope, context.requestId)) { return { terminal: true as const, context: undefined }; }
      const admission = await admitAcceptedUserTurnDurably({
        persistAcceptedUserTurn: () => context.addMessageIdempotent({conversationId:context.selectedConversationId,role:'user',
          content:context.storedUserContent,receivedAt:context.requestReceivedAt,skipActionContinuation:true,
        }),
        flush:flushDBOrThrow,
        onPersistenceUnknown:async error=>{
          const payload=context.normalizeAgentPayload('agent:response',{text:chatDurabilityUnknownText(context.visibleUserText),
            agentName:'Lumi',finalized:true,blocked:true,reason:'persistence_unknown',sidecar:true});
          try {await recordChatExecutionPersistenceUnknownDurably(context.executionScope,context.requestId,payload);}
          catch {console.error('[ChatHandler] Runtime status admission persistence failed:',error);}
          context.publishRecordedAgent('agent:response',payload);
          try {context.ack?.({ok:false,requestId: context.requestId,error:'Accepted user turn persistence is unknown'});} catch {}
        },
      });
      if (!admission) { return { terminal: true as const, context: undefined }; }
      try {context.ack?.({ok:true,requestId: context.requestId,receivedAt:context.requestReceivedAt});} catch {}
      const result = await readRuntimeWorkForTurn({
        resolution:context.acceptedTurnResolution,userId:context.uid,domain:context.resolvedDomain,orgId:context.resolvedOrgId,
        conversationId:context.selectedConversationId,source:context.eventSource,registry:toolRegistry,
        securityContext:context.toolSecurityContext,authorization:context.turnAuthorization,
        personalityToolPolicy: (personalityRegistry.getForUser('lumi', context.uid, context.resolvedDomain === 'work' ? context.resolvedOrgId : undefined)
          || personalityRegistry.getDefault()).toolPolicy,
      });
      await context.commitChatReply({
        text:result.text,
        blocked:result.blocked,
        reason:'runtime_work_status',
        sidecar:true,
        message: () => ({
          toolCalls:[result.record],
          cognitiveIntent:'runtime_work_status',
          llmWasCalled:false,
          skipActionContinuation:true,
        }),
        errorContext:'Read-only runtime status terminal',
      });
      { return { terminal: true as const, context: undefined }; }
    }
    const durableStatusTaskState = activeConversationForStatus?.actionContinuationState
      || context.selectedConversation.actionContinuationState;
    const durablePostCancelBinding = !existingSession && context.resolvedTaskRelation.feedback === 'status'
      ? getDurableChatCancellationForCurrentExecution(context.executionScope, {
          ...(durableStatusTaskState?.taskId
            ? {
                currentTask: {
                  taskId: durableStatusTaskState.taskId,
                  revision: Number.isFinite(Number(durableStatusTaskState.revision))
                    ? Math.max(0, Math.trunc(Number(durableStatusTaskState.revision)))
                    : -1,
                  activeRequestId: durableStatusTaskState.activeRequestId,
                  unfinished: durableStatusTaskState.unfinished === true,
                },
              }
            : {}),
          relation: {
            binding: context.resolvedTaskRelation.binding,
            taskId: context.resolvedTaskRelation.taskId,
            revision: context.resolvedTaskRelation.revision,
            targetRequestId: context.resolvedTaskRelation.targetRequestId,
          },
          requestedTarget: {
            requestId: controlTargetRequestId,
            taskId: controlTargetTaskId,
            revision: controlTargetRevision,
          },
        })
      : null;
    const exactPostCancelStatusTarget = durablePostCancelBinding?.targetRequestId
      && (!controlTargetRequestId || controlTargetRequestId === durablePostCancelBinding.targetRequestId)
      ? durablePostCancelBinding.targetRequestId
      : '';
    const exactPostCancelTargetTerminal = exactPostCancelStatusTarget
      ? durablePostCancelBinding?.targetTerminal || null
      : null;
    if (
      !existingSession
      && context.resolvedTaskRelation.feedback === 'status'
      && exactPostCancelTargetTerminal?.terminal === true
      && exactPostCancelTargetTerminal.terminalEvent
    ) {
      if (!beginChatSidecarExecution(context.executionScope, context.requestId)) { return { terminal: true as const, context: undefined }; }
      context.addMessageIdempotent({
        conversationId: context.selectedConversationId,
        role: 'user',
        content: context.storedUserContent,
        cognitiveIntent: 'task_status',
        receivedAt: context.requestReceivedAt,
        timestamp: context.requestReceivedAt,
        skipActionContinuation: true,
      });
      const statusText = String(
        exactPostCancelTargetTerminal.terminalEvent.payload?.text
        || CN_TASK_EXECUTION_MESSAGES.activeWithoutReceipt,
      ).trim();
      try { context.ack?.({ ok: true, requestId: context.requestId, receivedAt: new Date().toISOString() }); } catch {}
      await context.commitChatReply({
        text: statusText,
        source: context.eventSource,
        requestId: context.requestId,
        sidecar: true,
        reason: 'target_execution_status',
        controlIntent: 'status',
        targetRequestId: exactPostCancelStatusTarget,
        message: () => ({
          cognitiveIntent: 'task_status',
          llmWasCalled: false,
          skipActionContinuation: true,
        }),
        errorContext: 'Exact post-cancellation status terminal',
      });
      { return { terminal: true as const, context: undefined }; }
    }
    if (
      context.resolvedTaskRelation.binding === 'stale'
      && context.resolvedTaskRelation.relation !== 'queue'
    ) {
      if (!beginChatSidecarExecution(context.executionScope, context.requestId)) { return { terminal: true as const, context: undefined }; }
      context.addMessageIdempotent({
        conversationId: context.selectedConversationId,
        role: 'user',
        content: context.storedUserContent,
        cognitiveIntent: 'stale_task_control',
        receivedAt: context.requestReceivedAt,
        timestamp: context.requestReceivedAt,
        skipActionContinuation: true,
      });
      try { context.ack?.({ ok: true, requestId: context.requestId, receivedAt: new Date().toISOString() }); } catch {}
      await context.commitChatReply({
        text: CN_TASK_EXECUTION_MESSAGES.staleControl,
        sidecar: true,
        reason: context.resolvedTaskRelation.reason,
        message: () => ({
          cognitiveIntent: 'stale_task_control',
          llmWasCalled: false,
          skipActionContinuation: true,
        }),
        errorContext: 'Stale task control terminal',
      });
      { return { terminal: true as const, context: undefined }; }
    }
    if (
      !existingSession
      && context.resolvedTaskRelation.feedback === 'cancel'
      && context.resolvedTaskRelation.taskId
      && context.selectedConversation.actionContinuationState?.unfinished
    ) {
      if (!beginChatSidecarExecution(context.executionScope, context.requestId)) { return { terminal: true as const, context: undefined }; }
      context.addMessageIdempotent({
        conversationId: context.selectedConversationId,
        role: 'user',
        content: context.storedUserContent,
        cognitiveIntent: 'task_cancel',
        receivedAt: context.requestReceivedAt,
        timestamp: context.requestReceivedAt,
        skipActionContinuation: true,
      });
      const cancelled = cancelConversationActionExecution(
        context.selectedConversationId,
        context.uid,
        'Cancelled by the user.',
        context.selectedConversation.actionContinuationState?.activeRequestId
          ? controlTargetRequestId || undefined
          : undefined,
      );
      const clearedTaskConfirmation = await clearPendingConfirmationDurably(context.uid, context.confirmationScope);
      const clearedTasklessConfirmation = await clearPendingConfirmationDurably(context.uid, context.confirmationChannelScope);
      context.pendingConfirmationCleared = clearedTaskConfirmation || clearedTasklessConfirmation;
      const cancelledCurrentTask = cancelled?.taskId === context.resolvedTaskRelation.taskId
        && cancelled.status === 'cancelled';
      const responseText = cancelledCurrentTask
        ? CN_TASK_EXECUTION_MESSAGES.cancelled
        : CN_TASK_EXECUTION_MESSAGES.staleControl;
      if (cancelledCurrentTask) {
        context.resolvedTaskRelation = { ...context.resolvedTaskRelation, revision: cancelled?.revision };
      }
      try { context.ack?.({ ok: true, requestId: context.requestId, receivedAt: new Date().toISOString() }); } catch {}
      await context.commitChatReply({
        text: responseText,
        sidecar: true,
        reason: cancelledCurrentTask ? 'cancelled_by_user' : 'stale_control',
        message: () => ({
          cognitiveIntent: 'task_cancel',
          skipActionContinuation: true,
        }),
        errorContext: 'Task cancellation terminal',
      });
      { return { terminal: true as const, context: undefined }; }
    }
    if (
      existingSession
      && !isNamedPersistentWorkTaskStatusQuery(context.visibleUserText)
      && context.resolvedTaskRelation.feedback === 'status'
    ) {
      if (!beginChatSidecarExecution(context.executionScope, context.requestId)) { return { terminal: true as const, context: undefined }; }
      // Natural-language status controls do not carry UI fence metadata. The
      // server-observed foreground lease is authoritative in that case; an
      // explicitly supplied stale target was already rejected above.
      if (controlTargetRequestId && controlTargetRequestId !== existingSession.requestId) {
        try { context.ack?.({ ok: true, requestId: context.requestId, receivedAt: new Date().toISOString() }); } catch {}
        await context.commitDeterministicTerminal({ payload: {
          text: CN_TASK_EXECUTION_MESSAGES.staleControl,
          agentName: 'Lumi',
          sidecar: true,
          finalized: true,
          blocked: false,
          reason: 'stale_control',
        }, errorContext: 'Stale status control terminal' });
        { return { terminal: true as const, context: undefined }; }
      }
      const activeConversation = activeConversationForStatus || context.selectedConversation;
      if (activeConversation) {
        context.addMessageIdempotent({
          conversationId: activeConversation.id,
          role: 'user',
          content: context.storedUserContent,
          cognitiveIntent: 'task_status',
          receivedAt: context.requestReceivedAt,
          timestamp: context.requestReceivedAt,
          skipActionContinuation: true,
        });
      }
      const statusText = activeConversation && context.resolvedTaskRelation.taskId
        ? getConversationActionStatus(activeConversation.id, context.uid, context.visibleUserText, activeConversation.actionContinuationState)
        : CN_TASK_EXECUTION_MESSAGES.activeWithoutReceipt;
      try { context.ack?.({ ok: true, requestId: context.requestId, receivedAt: new Date().toISOString() }); } catch {}
      await context.commitDeterministicTerminal({
        payload: {
          text: statusText,
          agentName: 'Lumi',
          source: context.eventSource,
          requestId: context.requestId,
          sidecar: true,
          finalized: true,
          blocked: false,
          reason: '',
        },
        persistAssistantMessage: activeConversation
          ? () => context.addMessageIdempotent({ conversationId: activeConversation.id, role: 'assistant', content: statusText, cognitiveIntent: 'task_status', skipActionContinuation: true })
          : undefined,
        errorContext: 'Active task status terminal',
      });
      { return { terminal: true as const, context: undefined }; }
    }
  return { terminal: false as const, context: extendTurnBindings(context, {
    existingSession: existingSession as typeof existingSession,
    activeConversationForStatus: activeConversationForStatus as typeof activeConversationForStatus,
    controlTargetRequestId: controlTargetRequestId as typeof controlTargetRequestId,
    controlTargetTaskId: controlTargetTaskId as typeof controlTargetTaskId,
    controlTargetRevision: controlTargetRevision as typeof controlTargetRevision,
  }) };
}
