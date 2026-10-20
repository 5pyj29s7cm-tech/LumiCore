import type { IncomingMessage } from "../../../../messaging/types";
import { captureMessagingOrganization, isMessagingAuthorizationCurrent } from "../../../../messaging/turn_authorization";
import { resolveUserTurn } from "../../../../cognition/turn_resolution";
import type { AcceptedUserTurnAdmission } from "../../../../socket/action_turn_durability";
import { runLumiEntryTurn, type ExecutedLumiTurn } from "../../../../cognition/turn_execution";
import { captureRequestAuthorization } from "../../../../conversation/lifecycle";
import type { MessagingRouteOptions } from "../messaging_finalization";
import { getRequestText } from "../remote_materials";
import { planRemoteOrganizationScope } from "../legal_notice_intake";
import { createMessagingReplyCommitter } from "../messaging_persistence";
import { flushMessagingStateOrThrow } from "../messaging_finalization";
import { assertMessagingAuthorization } from "../messaging_ingress_runtime";
import { admitBoundMessagingTurnDurably, conversationForMessagingTurn } from "../messaging_persistence";
import { messagingPendingOffer } from './history';
import { prepareMessagingTurn, type MessagingTurnContext } from './admission';
import { prepareMessagingExecution, type MessagingModelContext } from './execution_preparation';
import { prepareMessagingModelTurn, finalizeMessagingModelFailure } from './model_execution';

export async function processWithPersonality(
  msg: IncomingMessage, options?: MessagingRouteOptions, preacceptedAdmission?: AcceptedUserTurnAdmission<string> | null,
): Promise<string> {
  msg = captureMessagingOrganization(msg); assertMessagingAuthorization(msg);
  const preaccepted = preacceptedAdmission && preacceptedAdmission.persisted === msg.userMessageId;
  const scopePlan = preaccepted ? null : await planRemoteOrganizationScope(msg);
  if (scopePlan) msg = captureMessagingOrganization(scopePlan.resolution.message);
  assertMessagingAuthorization(msg);
  const accepted = !msg.boundUserId || preaccepted
    ? { message: msg, admission: preacceptedAdmission }
    : await admitBoundMessagingTurnDurably(msg, options?.onConversationUpdated);
  msg = accepted.message;
  scopePlan?.commit();
  if (scopePlan?.resolution.kind === 'reply') {
    return createMessagingReplyCommitter(msg, {
      flush: async () => { if (msg.boundUserId) await flushMessagingStateOrThrow('terminal_reply'); },
      isCancelled: () => !isMessagingAuthorizationCurrent(msg),
      onConversationUpdated: options?.onConversationUpdated,
    })(scopePlan.resolution.reply);
  }
  const conversation = msg.boundUserId ? conversationForMessagingTurn(accepted.message) : null;
  if (msg.boundUserId && !conversation) throw new Error('The accepted messaging conversation is unavailable');
  const pendingAssistantOfferContext = conversation ? messagingPendingOffer(accepted.message, conversation) : undefined;
  const acceptedTurn = conversation ? Object.freeze({
    resolution: resolveUserTurn({ requestId: msg.platform + '_bot:' + msg.messageId, userText: getRequestText(accepted.message),
      state: conversation.actionContinuationState, options: { pendingAssistantOfferContext } }), pendingAssistantOfferContext,
  }) : undefined;
  const controller = new AbortController();
  const authorization = captureRequestAuthorization(() => isMessagingAuthorizationCurrent(msg), 'Messaging authorization was revoked');
  let setup: Awaited<ReturnType<typeof prepareMessagingTurn>> | undefined;
  let context: MessagingTurnContext | undefined;
  let modelContext: MessagingModelContext | undefined;
  let deliver: ((result: ExecutedLumiTurn) => Promise<string>) | undefined;
  return runLumiEntryTurn({
    entry: { source: msg.platform + '_bot', channel: msg.platform, historyLimit: 0,
      failureText: 'The remote turn could not finish.', failureReason: 'remote_execution_failed' },
    identity: { userId: msg.boundUserId || 'anonymous', agentId: conversation?.agentId || 'lumi',
      conversationId: conversation?.id || '', requestId: msg.platform + '_bot:' + msg.messageId,
      domain: msg.boundUserId && msg.boundOrgId ? 'work' : 'personal', orgId: msg.boundUserId && msg.boundOrgId || '' },
    userText: getRequestText(accepted.message), persistence: msg.boundUserId ? 'preaccepted' : 'external', authorization, controller,
    planning: async () => {
      setup = await prepareMessagingTurn(accepted.message, options, accepted.admission, acceptedTurn, controller);
      if (setup.terminal !== undefined) return { terminal: setup.terminal };
      return setup.planning!;
    },
    assemble: async execution => {
      const admitted = await setup!.assemble!(execution);
      if (admitted.terminal !== undefined) return { terminal: admitted.terminal };
      context = admitted.context!;
      const prepared = await prepareMessagingExecution(context);
      if (prepared.terminal !== undefined) return { terminal: prepared.terminal };
      modelContext = prepared.context!;
      const data = await prepareMessagingModelTurn(modelContext);
      if (data.terminal !== undefined) return { terminal: data.terminal };
      deliver = data.deliver;
      return data.data;
    },
    deliver: result => deliver!(result),
    onFailure: error => {
      if (modelContext) return finalizeMessagingModelFailure(error, modelContext);
      throw error;
    },
    settle: async () => {
      context?.desktopRelay?.releaseControlLease?.();
      context?.personalDesktopRelay?.releaseControlLease?.();
      context?.organizationWorkExecution?.release();
      context?.actionLeaseHeartbeat?.stop();
      context?.releaseActiveMessageRouteController();
    },
  });
}
