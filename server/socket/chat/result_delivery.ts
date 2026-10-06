import type { prepareChatModelState } from './phases/prepare_chat_model_state';

import { scheduleTurnMemory } from "../../memory/turn_memory";

import { readDatabaseTables, commitDatabaseTables } from "../../../db_layer";
import { pushNotification } from "../../routes/notifications";



import { buildForegroundTaskCompletionFeedback } from "../../cognition/acceptance_evidence";



import { formatPendingConfirmationRequest } from "../../tools/pending_confirmation";

import { saveEmotionalState, updateEmotionalState, updateEmotionalStateWithHIM, saveHIMState, generateContextualGreeting } from "../../personality/state";

import { addMessage, extractTopics, trackTopic, setConversationActionExecutionStatus } from "../../conversation/manager";

import { RECONFIRMATION_REQUIRED_BLOCKER } from "../../cognition/action_continuation";

import { summarizeToolRecordForPersistence } from "../../cognition/tool_record_status";



type completeChatTurnInput = NonNullable<Awaited<ReturnType<typeof prepareChatModelState>>['context']> & { finalResponse: import('../../cognition/result_finalizer_types').LumiResultFinalizerResult };
export async function completeChatTurn(context: completeChatTurnInput) {

      let finalResponse = context.finalResponse;
      context.responseText = finalResponse.text;
      if (finalResponse.blocked) {
        console.warn('[ChatHandler] Completion claim blocked:', finalResponse.reason);
        // Keep the live action lease until the terminal assistant persistence
        // boundary when this turn already has tool evidence.  Finalizing the
        // task here clears its active request before `addMessageIdempotent`
        // can bind the evidence, causing verified observations (notably the
        // WPS active-window anchor) to be archived as stale and dropping the
        // target from the durable capsule.  A blocked turn with no evidence
        // still needs the early request finalization below.
        if (context.conversationId && context.actionTaskExecution.state?.taskId && context.toolSessionActive && context.allToolRecords.length === 0) {
          const blocker = context.correctionRequiresFreshConfirmation
            && !context.pendingConfirmationCreatedThisTurn
            ? RECONFIRMATION_REQUIRED_BLOCKER
            : finalResponse.reason || 'The current work product did not pass final verification.';
          setConversationActionExecutionStatus(context.conversationId, context.uid, 'blocked', {
            blocker,
            assistantState: context.responseText,
            requestId: '',
          });
        }
      }

      // Completion is a durability claim. Keep the native terminal frame
      // behind the task/message write and strict database flush.
      const responseCompletionFeedback = context.durableTaskId
        ? buildForegroundTaskCompletionFeedback({
            taskId: context.durableTaskId,
            taskLabel: context.completionTaskText,
            toolRecords: context.taskAwareRecords(context.allToolRecords),
            blocked: finalResponse.blocked,
            reason: finalResponse.reason,
            status: context.pendingConfirmationCreatedThisTurn || finalResponse.reason === 'waiting_confirmation'
              ? 'waiting_confirmation' : finalResponse.reason === 'workflow_running' ? 'executing' : undefined,
          })
        : undefined;
      const trustedConfirmationRequestText = context.pendingConfirmationCreatedThisTurn
        ? formatPendingConfirmationRequest(context.pendingConfirmationCreatedThisTurn)
        : undefined;
      const responseTerminalPayload = context.normalizeAgentPayload('agent:response', {
        text: context.responseText,
        agentName: context.personality.name,
        finalized: true,
        blocked: finalResponse.blocked,
        reason: finalResponse.reason || '',
        completionFeedback: responseCompletionFeedback,
      }, trustedConfirmationRequestText ? { trustedConfirmationRequestText } : undefined);
      context.responseText = String(responseTerminalPayload.text || '');
      finalResponse = { ...finalResponse, text: context.responseText };
      if (
        context.pendingConfirmationCreatedThisTurn
        && context.conversationId
        && context.pendingConfirmationAssistantState !== context.responseText
      ) {
        setConversationActionExecutionStatus(context.conversationId, context.uid, 'waiting_confirmation', {
          assistantState: context.responseText,
          requestId: context.requestId,
        });
        context.pendingConfirmationAssistantState = context.responseText;
      }
      const responseUnknownPayload = context.normalizeAgentPayload('agent:response', {
        text: context.chatDurabilityUnknownText(context.visibleUserText),
        agentName: context.personality.name,
        finalized: true,
        blocked: true,
        reason: 'persistence_unknown',
        completionFeedback: context.durableTaskId
          ? buildForegroundTaskCompletionFeedback({
              taskId: context.durableTaskId,
              taskLabel: context.completionTaskText,
              toolRecords: context.taskAwareRecords(context.allToolRecords),
              status: 'persistence_unknown',
              reason: 'Terminal persistence outcome is unknown.',
            })
          : undefined,
      });
      if (context.actionLeaseHeartbeat?.isLeaseLost()) {
        await context.actionLeaseHeartbeat.leaseLoss;
        await context.releaseChatSession();
        return;
      }
      const terminalCommitted = await context.commitRecordedTerminal({
          persistTerminalState: () => context.persistChatTakeoverExecution(context.responseText, {
          toolRecords: context.allToolRecords,
          source: 'chat',
          sourceInteractionId: context.interactionId,
          capabilitySelection: context.capabilitySelection,
          finalizationBlocked: finalResponse.blocked,
          assistantTextTrusted: !finalResponse.blocked,
          finalizationReason: finalResponse.reason,
        }),
          persistAssistantMessage: () => {
          if (!context.conversationId) return;
          // Keep terminal tool evidence immediately before the assistant row in
          // the same strict durability boundary.
          for (const tc of context.allToolRecords) {
            if (!tc.error && !String(tc.result || '').trim()) continue;
            const tcSummary = summarizeToolRecordForPersistence(tc);
            addMessage({ userId: context.uid, agentId: context.conversationAgentId, conversationId: context.conversationId, role: 'tool', content: tcSummary, domain: context.resolvedDomain, orgId: context.resolvedOrgId });
          }
          context.addMessageIdempotent({
            conversationId: context.conversationId,
            role: 'assistant',
            content: context.responseText,
            personality: context.personality.id,
            toolCalls: context.allToolRecords.length ? context.allToolRecords : undefined,
            cognitiveIntent: finalResponse.blocked ? 'work_product_guard' : context.executionPipeline.normalizedIntent.kind,
            llmWasCalled: context.llmWasCalled,
            completionFeedback: responseCompletionFeedback,
            ...(finalResponse.blocked && context.durableTaskId ? {
              terminalTaskDisposition: {
                outcome: 'blocked' as const,
                taskId: context.durableTaskId,
                requestId: context.requestId,
                reason: finalResponse.reason
                  || 'The foreground request ended without verified goal-level completion evidence.',
              },
            } : {}),
          });
          context.refreshTerminalPayloadTaskRelation(responseTerminalPayload, context.durableTaskId);
        },
        payload: responseTerminalPayload,
        unknownPayload: responseUnknownPayload,
        notification: finalResponse.notification,
        llmWasCalled: context.llmWasCalled,
        repairUnknownAssistant: true,
        errorContext: 'Terminal persistence failed:',
      });
      if (!terminalCommitted) {
        await context.releaseChatSession();
        return;
      }
      context.actionLeaseHeartbeat?.stop();

      // Post-commit enrichment must never delay or precede the durable terminal.
      if (!context.turnAuthorization.isCurrent()) return;

      if (context.conversationId) {
        // (conversation_updated NOW emitted AFTER agent:response — see below)

        // Topic tracking — extract and record topics for cross-session continuity
        if (!finalResponse.blocked) {
          try {
            const topics = extractTopics(context.text + ' ' + context.responseText);
            for (const topic of topics) trackTopic(context.conversationId, topic);
          } catch {}
        }

        // Shared chat/voice scheduler owns cadence, reservation, guard
        // filtering, and captured-count persistence.
        context.scheduleChatSummary(context.conversationId);
      }

      if (!context.isMemoryAvatar && !finalResponse.blocked) {
        context.persistChatLearning(context.responseText, { toolRecords: context.allToolRecords, logLabel: 'chat' });
      }

      // Clean up abort session
      await context.releaseChatSession();
      if (!context.turnAuthorization.isCurrent()) return;

      if (context.allowAdaptiveLearning && !finalResponse.blocked) scheduleTurnMemory({
        userId: context.uid, domain: context.resolvedDomain, orgId: context.resolvedOrgId, userText: context.text,
        channel: 'chat', source: context.eventSource, requestId: context.requestId, conversationId: context.conversationId,
        agentId: context.conversationAgentId, authorization: context.turnAuthorization, llmGetters: context.llmGetters,
      });

      // Update emotional state — reconnect if user was away for a while
      if (!context.turnAuthorization.isCurrent()) return;
      const hoursSinceLast = context.emotionalState.lastInteractionAt
        ? (Date.now() - new Date(context.emotionalState.lastInteractionAt).getTime()) / (1000 * 60 * 60)
        : 24;
      const isReconnect = hoursSinceLast > 1;
      let updatedState = updateEmotionalState(context.emotionalState, { type: 'interaction', userId: context.uid, timestamp: new Date().toISOString() });
      // Apply sentiment analysis results to emotional state
      if (context.sentiment.valence !== 0 || context.sentiment.frustration > 0 || context.sentiment.urgency > 0) {
        updatedState = updateEmotionalState(updatedState, { type: 'sentiment_analysis', sentiment: context.sentiment, userId: context.uid, timestamp: new Date().toISOString() });
      }
      if (isReconnect) {
        updatedState = updateEmotionalState(updatedState, { type: 'reconnect', intensity: Math.min(1, hoursSinceLast / 72), userId: context.uid, timestamp: new Date().toISOString() });
      }
      if (context.isNovel) {
        updatedState = updateEmotionalState(updatedState, { type: 'novel_topic', userId: context.uid, timestamp: new Date().toISOString() });
      }
      // HIM: comfort-gradient drive → dynamic initiative + curiosity
      const { state: himUpdated, him: newHim } = updateEmotionalStateWithHIM(updatedState, { type: 'self_reflection', userId: context.uid }, context.himState, context.text.slice(0, 40));
      saveEmotionalState(context.emotionKey, himUpdated);
      saveHIMState(context.emotionKey, newHim);

      // Emit a contextual greeting on reconnect.
      if (!context.isMemoryAvatar && context.turnAuthorization.isCurrent() && isReconnect && updatedState.intimacy > 0.2) {
        const greeting = generateContextualGreeting(updatedState, context.uid);
        if (greeting) {
          const greetingTs = new Date().toISOString();
          // Save to chat log
          const greetingDb = readDatabaseTables(["interactions"]);
          greetingDb.interactions.push({
            id: `greeting-${context.uid}-${Date.now()}`,
            userId: context.uid,
            agentId: context.conversationAgentId,
            conversationId: context.conversationId || '',
            content: greeting,
            response: '',
            role: 'agent',
            personality: context.personality.id,
            timestamp: greetingTs,
            cognitiveIntent: 'greeting',
            llmWasCalled: false,
          });
          commitDatabaseTables(greetingDb);

          // Emit to chat window and notification center
          context.socket.emit('agent:proactive', {
            type: 'greeting',
            message: greeting,
            agentName: context.personality.name,
            intimacy: updatedState.intimacy,
            timestamp: greetingTs,
          });
          pushNotification(context.uid, { type: 'greeting', title: `Welcome back`, message: greeting });
        }
      }
}
