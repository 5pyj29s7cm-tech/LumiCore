import { registerChatExecutionControls } from "./chat/connection_controls";
import type { ProviderGetters as SharedProviderGetters } from "../llm/provider_getters";
import type { Server, Socket } from "socket.io";
import { buildForegroundTaskCompletionFeedback } from "../cognition/acceptance_evidence";
import { CN_VOICE_WORK_MESSAGES } from "../regions/messages/voice_fast_path_messages";
import { CN_TASK_EXECUTION_MESSAGES } from "../regions/messages/task_execution_messages";
import { chatPublicErrorCodeForException, sanitizeChatAgentErrorPayload } from "./chat_public_error";
import { prepareChatRequest } from './chat/phases/prepare_chat_request';
import { prepareChatEvents } from './chat/phases/prepare_chat_events';
import { resolveChatControlTurn } from './chat/phases/resolve_chat_control_turn';
import { admitChatForegroundTurn } from './chat/phases/admit_chat_foreground_turn';
import { startChatForegroundTurn, prepareChatForegroundLifetime, completeQueuedChatFailure } from './chat/phases/start_chat_foreground_turn';
import { runLumiEntryTurn } from '../cognition/turn_execution';
import { prepareChatModelTurn } from './chat/model_execution';
import { prepareChatPriorTaskQuery } from './chat/phases/prepare_chat_prior_task_query';
import { prepareChatConversationContext } from './chat/phases/prepare_chat_conversation_context';
import { prepareChatTerminalWriters } from './chat/phases/prepare_chat_terminal_writers';
import { prepareChatExecutionLeaseAndTools } from './chat/phases/prepare_chat_execution_lease_and_tools';
import { prepareChatRuntimeControlAndModel } from './chat/phases/prepare_chat_runtime_control_and_model';
import { prepareChatModelState } from './chat/phases/prepare_chat_model_state';
import { executeChatModelAndDelivery } from './chat/phases/execute_chat_model_and_delivery';

export { normalizeChatHistoryRecord } from "./chat/history";
export { buildChatAttachmentContext } from "./chat/attachments";
export { buildSocketNativeRequestBinding } from './native_request_binding';
export type { SocketNativeRequestBinding } from './native_request_binding';
export type {
  ForegroundRequestIdentity as ChatForegroundRequestIdentity,
  ForegroundRequestReleaseResult as ChatForegroundRequestReleaseResult,
} from '../conversation/manager';
export { convergeChatForegroundRequestBeforeRelease } from './chat/phases/shared';

async function processChatTurn(socket: Socket, llmGetters: SharedProviderGetters & Required<Pick<SharedProviderGetters, 'getOpenAI' | 'getAnthropic' | 'getQwen' | 'getOllama' | 'isOllamaAvailable' | 'getLmStudio' | 'isLmStudioAvailable'>>, sensoryFn: (uid: string) => any, userIdFn: (s: Socket) => string, io: Server, data: { text?: string; history?: any[]; attachments?: any[]; personalityId?: string; category?: string; agentId?: string; domain?: string; orgId?: string | null; mode?: string; operationMode?: string; source?: string; requestId?: string; conversationId?: string; controlTargetRequestId?: string; controlTargetTaskId?: string; controlTargetRevision?: number; mediaRequest?: unknown }, ack?: (payload: { ok: boolean; requestId?: string; receivedAt?: string; error?: string }) => void): Promise<void> {
  const prepareChatRequestResult = await prepareChatRequest(socket, llmGetters, sensoryFn, userIdFn, io, data, ack);
  if (prepareChatRequestResult.terminal) return;
  const prepareChatEventsResult = await prepareChatEvents(prepareChatRequestResult.context);
  if (prepareChatEventsResult.terminal) return;
  const resolveChatControlTurnResult = await resolveChatControlTurn(prepareChatEventsResult.context);
  if (resolveChatControlTurnResult.terminal) return;
  const admitChatForegroundTurnResult = await admitChatForegroundTurn(resolveChatControlTurnResult.context);
  if (admitChatForegroundTurnResult.terminal) return;
  const context = prepareChatForegroundLifetime(admitChatForegroundTurnResult.context);
  let started = false;
  let conversationSetup: Extract<Awaited<ReturnType<typeof prepareChatConversationContext>>, { terminal: false }> | undefined;
  let modelContext: NonNullable<Awaited<ReturnType<typeof prepareChatModelState>>['context']> | undefined;
  await runLumiEntryTurn<void>({
    entry: { source: 'chat', channel: 'chat', historyLimit: 0, failureText: 'The chat turn could not finish.', failureReason: 'chat_execution_failed' },
    identity: { userId: context.uid, agentId: context.conversationAgentId, conversationId: context.selectedConversationId,
      requestId: context.requestId, domain: context.resolvedDomain, orgId: context.resolvedOrgId },
    userText: context.visibleUserText, persistence: 'preaccepted', authorization: context.turnAuthorization, controller: context.abortController,
    resource: { admission: context.sessionLease, ownedByDurableRelease: true },
    planning: async () => {
      const foreground = await startChatForegroundTurn(context);
      if (foreground.terminal) return { terminal: undefined };
      started = true;
      const prior = await prepareChatPriorTaskQuery(foreground.context);
      if (prior.terminal) return { terminal: undefined };
      const prepared = await prepareChatConversationContext(prior.context);
      if (prepared.terminal === true) return { terminal: undefined };
      conversationSetup = prepared;
      return prepared.planning;
    },
    assemble: async execution => {
      const conversation = await conversationSetup!.resume(execution);
      const terminalWriters = await prepareChatTerminalWriters(conversation.context);
      if (terminalWriters.terminal) return { terminal: undefined };
      const tools = await prepareChatExecutionLeaseAndTools(terminalWriters.context);
      if (tools.terminal) return { terminal: undefined };
      const control = await prepareChatRuntimeControlAndModel(tools.context);
      if (control.terminal) return { terminal: undefined };
      const prepared = await prepareChatModelState(control.context);
      if (prepared.terminal) return { terminal: undefined };
      modelContext = prepared.context;
      return prepareChatModelTurn(modelContext);
    },
    deliver: async result => { await executeChatModelAndDelivery(modelContext!, result); },
    onFailure: async (error: any) => {
      if (!started && context.abortController.signal.aborted) { await completeQueuedChatFailure(context); return; }
      if (context.isChatCancelled() || error?.name === 'AbortError') {
        const cancelledText = CN_TASK_EXECUTION_MESSAGES.cancelled;
        const cancelledRecords = context.collectRequestTerminalRecords();
        const cancelledFeedback = context.requestTaskId ? buildForegroundTaskCompletionFeedback({
          taskId: context.requestTaskId,
          taskLabel: context.visibleUserText,
          toolRecords: cancelledRecords,
          status: 'cancelled',
          reason: 'Cancelled by the user; completed steps remain recorded.',
        }) : undefined;
        await context.commitChatReply({
          text: cancelledText,
          reason: 'cancelled',
          completionFeedback: cancelledFeedback,
          message: () => ({
            cognitiveIntent: 'task_cancelled',
            llmWasCalled: true,
            toolCalls: cancelledRecords.length ? cancelledRecords : undefined,
            completionFeedback: cancelledFeedback,
            ...(context.requestTaskId ? { terminalTaskDisposition: {
              outcome: 'cancelled' as const,
              taskId: context.requestTaskId,
              requestId: context.requestId,
              reason: 'Cancelled by the user; completed steps remain recorded.',
            } } : {}),
          }),
          publishAfter: () => context.emitConversationUpdated({
            conversationId: context.selectedConversationId,
            agentId: context.conversationAgentId,
            source: context.eventSource,
          }),
          errorContext: 'Caught chat cancellation terminal',
        });
        return;
      }
      console.error("[Socket Agent Error]:", error);
      const publicError = sanitizeChatAgentErrorPayload({
        code: chatPublicErrorCodeForException(error),
      });
      const failureText = publicError.code === 'CHAT_PRIVACY_RESTRICTED'
        ? CN_VOICE_WORK_MESSAGES.privacyRestricted
        : publicError.code === 'CHAT_MODEL_ROUTES_UNAVAILABLE'
        ? CN_VOICE_WORK_MESSAGES.modelRoutesUnavailable
        : CN_VOICE_WORK_MESSAGES.processingFailed;
      const failedRecords = context.collectRequestTerminalRecords();
      const failedFeedback = context.requestTaskId ? buildForegroundTaskCompletionFeedback({
        taskId: context.requestTaskId,
        taskLabel: context.visibleUserText,
        toolRecords: failedRecords,
        blocked: true,
        reason: String(publicError.reason || 'chat_execution_failed'),
      }) : undefined;
      await context.commitChatReply({
        text: failureText,
        blocked: true,
        reason: String(publicError.reason || 'chat_execution_failed'),
        completionFeedback: failedFeedback,
        message: () => ({
          cognitiveIntent: String(publicError.code || 'CHAT_EXECUTION_FAILED').toLowerCase(),
          llmWasCalled: false,
          toolCalls: failedRecords.length ? failedRecords : undefined,
          completionFeedback: failedFeedback,
          ...(context.requestTaskId ? { terminalTaskDisposition: {
            outcome: 'blocked' as const,
            taskId: context.requestTaskId,
            requestId: context.requestId,
            reason: String(publicError.reason || 'chat_execution_failed'),
          } } : {}),
        }),
        publishAfter: () => context.emitConversationUpdated({
          conversationId: context.selectedConversationId,
          agentId: context.conversationAgentId,
          source: context.eventSource,
        }),
        errorContext: 'Unhandled chat failure terminal',
      });
    },
    settle: async () => { await context.releaseChatSession(); },
  });
}

export function registerChatHandler(
  socket: Socket,
  llmGetters: SharedProviderGetters & Required<Pick<SharedProviderGetters, 'getOpenAI' | 'getAnthropic' | 'getQwen' | 'getOllama' | 'isOllamaAvailable' | 'getLmStudio' | 'isLmStudioAvailable'>>,
  sensoryFn: (uid: string) => any,
  userIdFn: (s: Socket) => string,
  io: Server,
) {
  registerChatExecutionControls(socket, userIdFn, io);

  socket.on("agent:chat", async (data: { text?: string; history?: any[]; attachments?: any[]; personalityId?: string; category?: string; agentId?: string; domain?: string; orgId?: string | null; mode?: string; operationMode?: string; source?: string; requestId?: string; conversationId?: string; controlTargetRequestId?: string; controlTargetTaskId?: string; controlTargetRevision?: number; mediaRequest?: unknown }, ack?: (payload: { ok: boolean; requestId?: string; receivedAt?: string; error?: string }) => void) => processChatTurn(socket, llmGetters, sensoryFn, userIdFn, io, data, ack));
}
