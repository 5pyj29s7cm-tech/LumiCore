import type { IncomingMessage } from "../../../../messaging/types";
import { captureMessagingOrganization } from "../../../../messaging/turn_authorization";
import { resolveUserTurn, type TurnResolution } from "../../../../cognition/turn_resolution";
import type { PendingAssistantOfferContext } from "../../../../cognition/pending_assistant_offer";
import type { AcceptedUserTurnAdmission } from "../../../../socket/action_turn_durability";
import { reserveConversationExecution } from "../../../../cognition/conversation_execution";
import type { MessagingRouteOptions } from "../messaging_finalization";
import { getRequestText } from "../remote_materials";
import { assertMessagingAuthorization } from "../messaging_ingress_runtime";
import { admitBoundMessagingTurnDurably, conversationForMessagingTurn } from "../messaging_persistence";
import { messagingPendingOffer } from './history';
import { prepareMessagingTurn } from './admission';
import { prepareMessagingExecution } from './execution_preparation';
import { executeMessagingModelTurn } from './model_execution';

export async function processWithPersonality(
  msg: IncomingMessage, options?: MessagingRouteOptions, preacceptedAdmission?: AcceptedUserTurnAdmission<string> | null,
): Promise<string> {
  msg=captureMessagingOrganization(msg); assertMessagingAuthorization(msg);
  if (!msg.boundUserId) return processWithPersonalityAdmitted(msg,options,preacceptedAdmission);
  const accepted = preacceptedAdmission && preacceptedAdmission.persisted === msg.userMessageId
    ? {message:msg,admission:preacceptedAdmission}
    : await admitBoundMessagingTurnDurably(msg,options?.onConversationUpdated);
  const conversation=conversationForMessagingTurn(accepted.message);
  if (!conversation) throw new Error('The accepted messaging conversation is unavailable');
  const pendingAssistantOfferContext = messagingPendingOffer(accepted.message, conversation);
  const acceptedTurn = Object.freeze({
    resolution: resolveUserTurn({ requestId: msg.platform + '_bot:' + msg.messageId, userText: getRequestText(accepted.message),
      state: conversation.actionContinuationState, options: { pendingAssistantOfferContext } }),
    pendingAssistantOfferContext,
  });
  const admission=reserveConversationExecution({
    userId:msg.boundUserId,domain:msg.boundOrgId?'work':'personal',orgId:msg.boundOrgId,
    conversationId:conversation.id,
  },msg.platform+'_bot:'+msg.messageId);
  try {
    await admission.waitForTurn(); assertMessagingAuthorization(msg);
    return await processWithPersonalityAdmitted(accepted.message,options,accepted.admission,acceptedTurn);
  } finally {admission.release();}
}

async function processWithPersonalityAdmitted(msg: IncomingMessage, options?: MessagingRouteOptions, preacceptedAdmission?: AcceptedUserTurnAdmission<string> | null, acceptedTurn?: { resolution: TurnResolution; pendingAssistantOfferContext?: PendingAssistantOfferContext }): Promise<string> {
  const admitted = await prepareMessagingTurn(msg, options, preacceptedAdmission, acceptedTurn);
  if (admitted.terminal !== undefined) return admitted.terminal;
  const context = admitted.context!;
  try {
    const prepared = await prepareMessagingExecution(context);
    if (prepared.terminal !== undefined) return prepared.terminal;
    return await executeMessagingModelTurn(prepared.context!);
  } finally {

    context.desktopRelay?.releaseControlLease?.();
    context.personalDesktopRelay?.releaseControlLease?.();
    context.organizationWorkExecution?.release();
    context.actionLeaseHeartbeat?.stop();
    context.releaseActiveMessageRouteController();
  }
}
