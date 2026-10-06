import type { IncomingMessage } from "../../../../messaging/types";
import { commitBindingCodeConsumption, planBindingCodeConsumption, rollbackBindingCodeConsumption } from "../../../../messaging/bindings";
import { isMessagingDeliveryUnknownError } from "../../../../messaging/feishu";
import { captureMessagingBinding, captureMessagingOrganization, MessagingAuthorizationRevokedError } from "../../../../messaging/turn_authorization";
import { getMessagingJournalEntry, recordMessagingIngress, updateMessagingJournal } from "../../../../messaging/message_journal";
import { evaluateMessagingIngress } from "../../../../messaging/ingress_policy";
import { acceptMessageOnce, completeMessageDelivery, releaseMessageDelivery } from "../../../../messaging/delivery_ledger";
import { commitPersonalOrganizationScopePlan, planPersonalOrganizationScope, requestsOrganizationScope } from "../../../../messaging/personal_org_scope";
import { applyRemoteAttachmentContext } from "../../../../messaging/attachment_context";
import { type MessagingRouteOptions, type IncomingMessageTransport, flushMessagingStateOrThrow, isMessagingReplyDurabilityError } from "../messaging_finalization";
import { remotePlatformLabel, getRequestText } from "../remote_materials";
import { acceptingMessagingIngress, assertMessagingAuthorization, registerMessageRouteActivity, acceptedMessageSettlements, correlateMessagingReply, enqueueMessageRoute, isMessagingAuthorizationCurrent, newerMessageSupersedesThisTurn } from "../messaging_ingress_runtime";
import { createMessagingReplyCommitter, admitBoundMessagingTurnDurably } from "../messaging_persistence";
import { applyMessagingBinding, planMessagingBindingCommand, enqueueBindingCodeTransaction, applyPlannedMessagingBinding } from './binding_commands';
import { processWithPersonality } from './processing';

export function dispatchIncomingMessage(
  message: IncomingMessage,
  transport: IncomingMessageTransport,
  options?: MessagingRouteOptions,
): boolean {
  if (!acceptingMessagingIngress) throw new Error('Messaging ingress is stopping; retry this delivery later.');
  const ingressDecision = evaluateMessagingIngress(message);
  if (!ingressDecision.allowed) {
    recordMessagingIngress(message);
    updateMessagingJournal(message, {
      status: 'ignored',
      error: ingressDecision.reason,
    });
    return false;
  }
  const acceptedBinding = Object.prototype.hasOwnProperty.call(message, 'bindingAuthorization')
    ? message : captureMessagingOrganization(applyMessagingBinding(message));
  assertMessagingAuthorization(acceptedBinding);
  // The inbox is durable before either the lease or the platform success ACK.
  recordMessagingIngress(acceptedBinding);
  try {
    if (!acceptMessageOnce(message.platform, message.messageId)) {
      console.log(`[Messaging] Ignoring duplicate ${message.platform} message: ${message.messageId}`);
      return false;
    }
  } catch (err: any) {
    console.error('[Messaging] Delivery ledger unavailable; refusing an untracked remote turn:', err?.message || err);
    throw err;
  }

  const trackedMessage = registerMessageRouteActivity(acceptedBinding);
  recordMessagingIngress(trackedMessage);
  let finalJournalStatus: 'completed' | 'superseded' = 'completed';
  let terminalReplyDurable = false;
  let retryableBindingTurn = false;
  let retryableReplyDelivery = false;
  let settleAcceptedMessage!: () => void;
  let failAcceptedMessage!: (error: unknown) => void;
  const settlement = new Promise<void>((resolve, reject) => { settleAcceptedMessage = resolve; failAcceptedMessage = reject; });
  void settlement.catch(() => undefined);
  acceptedMessageSettlements.add(settlement);
  const persistDispatchReply = (target: IncomingMessage, text: string) => createMessagingReplyCommitter(target, {
    isCancelled: () => !isMessagingAuthorizationCurrent(target) || newerMessageSupersedesThisTurn(target),
    onConversationUpdated: options?.onConversationUpdated,
    flush: async () => {
      if (!target.boundUserId) return;
      await flushMessagingStateOrThrow('terminal_reply');
      terminalReplyDurable = true;
    },
  })(text);
  const deliverReply = async (target: IncomingMessage, text: string, transportTarget = target): Promise<void> => {
    const current = correlateMessagingReply(target, text);
    if (current.superseded || !current.text) {
      finalJournalStatus = 'superseded';
      if (retryableReplyDelivery) updateMessagingJournal(trackedMessage, { replyRetryable: false });
      retryableReplyDelivery = false;
      return;
    }
    const replyMessageId = await transport.reply(transportTarget, current.text);
    retryableReplyDelivery = false;
    updateMessagingJournal(trackedMessage, {
      status: 'replied', replyText: text, replyMessageId: String(replyMessageId || ''), replyRetryable: false, error: '',
    });
  };

  setImmediate(() => {
    void (async () => {
      assertMessagingAuthorization(trackedMessage);
      const interruptedDelivery = getMessagingJournalEntry(trackedMessage);
      if (
        interruptedDelivery?.status === 'delivery_unknown'
        && interruptedDelivery.replyRetryable
        && interruptedDelivery.replyText
      ) {
        retryableBindingTurn = true;
        retryableReplyDelivery = true;
        updateMessagingJournal(trackedMessage, { status: 'processing' });
        const retryTarget: IncomingMessage = {
          ...trackedMessage,
          boundUserId: interruptedDelivery.boundUserId || undefined,
          boundOrgId: interruptedDelivery.orgId || undefined,
          bindingAuthorization: interruptedDelivery.bindingAuthorization,
          organizationAuthorization: interruptedDelivery.organizationAuthorization,
        };
        // Historical binding receipts without an identity version cannot safely
        // be replayed through a possibly replaced platform binding.
        if (retryTarget.boundUserId && retryTarget.bindingAuthorization === undefined) {
          throw new MessagingAuthorizationRevokedError();
        }
        assertMessagingAuthorization(retryTarget);
        await deliverReply(retryTarget, interruptedDelivery.replyText, trackedMessage);
        return;
      }

      updateMessagingJournal(trackedMessage, { status: 'processing' });
      const bindingCommand = planMessagingBindingCommand(trackedMessage);
      if (bindingCommand) {
        await enqueueMessageRoute(trackedMessage, async () => {
          const correlated = correlateMessagingReply(trackedMessage, bindingCommand.reply);
          if (correlated.superseded) {
            finalJournalStatus = 'superseded';
            return;
          }
          if (!bindingCommand.consumption) {
            const existingTarget = applyMessagingBinding(trackedMessage);
            const accepted = await admitBoundMessagingTurnDurably(
              existingTarget,
              options?.onConversationUpdated,
            );
            const reply = await persistDispatchReply(accepted.message, correlated.text);
            await deliverReply(accepted.message, reply, trackedMessage);
            return;
          }

          await enqueueBindingCodeTransaction(bindingCommand.consumption, async () => {
            const refreshedPlan = planBindingCodeConsumption(
              bindingCommand.consumption!.platform,
              bindingCommand.consumption!.code.code,
              bindingCommand.consumption!.platformUserId,
              bindingCommand.consumption!.chatId,
              bindingCommand.consumption!.chatType,
            );
            if (!refreshedPlan) {
              const invalidReply = `绑定码无效或已过期。请在 Lumi 桌面端重新生成${remotePlatformLabel(trackedMessage.platform)}绑定码。`;
              await deliverReply(trackedMessage, invalidReply);
              return;
            }
            retryableBindingTurn = true;
            const plannedTarget = applyPlannedMessagingBinding(trackedMessage, refreshedPlan);
            const accepted = await admitBoundMessagingTurnDurably(
              plannedTarget,
              options?.onConversationUpdated,
            );
            assertMessagingAuthorization(trackedMessage);
            assertMessagingAuthorization(accepted.message);
            const committed = commitBindingCodeConsumption(refreshedPlan);
            if (!committed) {
              throw new Error('The binding code was already consumed by another durable request');
            }
            const committedTarget: IncomingMessage = {
              ...accepted.message,
              boundUserId: committed.binding.lumiUserId,
              boundOrgId: committed.binding.domain === 'work' ? committed.binding.orgId : undefined,
              bindingAuthorization: captureMessagingBinding(committed.binding),
            };
            let committedReply: string;
            try {
              committedReply = await persistDispatchReply(committedTarget, correlated.text);
            } catch (error) {
              rollbackBindingCodeConsumption(committed);
              throw error;
            }
            if (!committedReply) { finalJournalStatus = 'superseded'; return; }
            updateMessagingJournal(trackedMessage, {
              boundUserId: committedTarget.boundUserId || '',
              bindingAuthorization: committedTarget.bindingAuthorization,
              organizationAuthorization: committedTarget.organizationAuthorization,
              domain: committedTarget.boundOrgId ? 'work' : 'personal',
              orgId: committedTarget.boundOrgId || '',
              replyText: correlated.text,
              replyRetryable: true,
            });
            retryableReplyDelivery = true;
            await deliverReply(committedTarget, committedReply, trackedMessage);
          });
        });
        return;
      }

      const boundMessage = applyMessagingBinding(trackedMessage);
      const scopePlan = planPersonalOrganizationScope(
        boundMessage,
        requestsOrganizationScope(getRequestText(boundMessage)),
      );
      // Accepted transcripts are persisted immediately, even when execution is
      // queued behind an older long-running turn. Side effects remain fenced.
      const accepted = await admitBoundMessagingTurnDurably(
        captureMessagingOrganization(scopePlan.resolution.message),
        options?.onConversationUpdated,
      );
      const routeBaseMessage = accepted.message;
      assertMessagingAuthorization(routeBaseMessage);
      const enrichment = scopePlan.resolution.kind === 'reply'
        ? Promise.resolve(routeBaseMessage)
        : transport.enrich(routeBaseMessage);
      await enqueueMessageRoute(trackedMessage, async () => {
        if (!isMessagingAuthorizationCurrent(routeBaseMessage)) {
          void enrichment.catch(() => undefined);
          throw new MessagingAuthorizationRevokedError();
        }
        if (newerMessageSupersedesThisTurn(trackedMessage)) {
          void enrichment.catch(() => undefined);
          finalJournalStatus = 'superseded';
          return;
        }
        commitPersonalOrganizationScopePlan(scopePlan);
        updateMessagingJournal(trackedMessage, {
          boundUserId: routeBaseMessage.boundUserId || '',
          organizationAuthorization: routeBaseMessage.organizationAuthorization,
          domain: routeBaseMessage.boundOrgId ? 'work' : 'personal',
          orgId: routeBaseMessage.boundOrgId || '',
        });
        // Attachment enrichment may download and write local files. It starts
        // only after a bound user's accepted transcript is durably flushed,
        // but before a long-running predecessor can let signed URLs expire.
        const enriched = await enrichment;
        assertMessagingAuthorization(routeBaseMessage);
        const enrichedMessage: IncomingMessage = applyRemoteAttachmentContext({
          ...enriched,
          boundUserId: routeBaseMessage.boundUserId,
          boundOrgId: routeBaseMessage.boundOrgId,
          bindingAuthorization: routeBaseMessage.bindingAuthorization,
          organizationAuthorization: routeBaseMessage.organizationAuthorization,
          receivedAt: routeBaseMessage.receivedAt,
          routeSequence: routeBaseMessage.routeSequence,
          userMessagePersisted: routeBaseMessage.userMessagePersisted,
          userMessageId: routeBaseMessage.userMessageId,
        });
        const deliverExchange = async (target: IncomingMessage, reply: string): Promise<void> => {
          await deliverReply(target, await persistDispatchReply(target, reply));
        };

        if (scopePlan.resolution.kind === 'reply') {
          await deliverExchange(enrichedMessage, scopePlan.resolution.reply);
          return;
        }

        const routedMessage = enrichedMessage;

        const replyText = await processWithPersonality(routedMessage, options, accepted.admission);
        if (!replyText) {
          finalJournalStatus = 'superseded';
          return;
        }
        terminalReplyDurable = Boolean(routedMessage.boundUserId);
        await deliverReply(routedMessage, replyText);
      });
    })().then(() => {
      completeMessageDelivery(trackedMessage.platform, trackedMessage.messageId);
      updateMessagingJournal(trackedMessage, { status: finalJournalStatus });
    }).catch(async (err: any) => {
      if (err instanceof MessagingAuthorizationRevokedError) {
        completeMessageDelivery(trackedMessage.platform, trackedMessage.messageId);
        updateMessagingJournal(trackedMessage, { status: 'ignored', replyRetryable: false, error: err.message });
        return;
      }
      if (retryableBindingTurn) {
        releaseMessageDelivery(trackedMessage.platform, trackedMessage.messageId);
        updateMessagingJournal(trackedMessage, {
          status: retryableReplyDelivery ? 'delivery_unknown' : 'failed',
          error: err?.message || String(err),
        });
        console.error(`[Messaging] ${trackedMessage.platform} binding route failed:`, err?.message || err);
        return;
      }
      if (
        isMessagingReplyDurabilityError(err)
        || isMessagingDeliveryUnknownError(err)
        || terminalReplyDurable
      ) {
        completeMessageDelivery(trackedMessage.platform, trackedMessage.messageId);
        updateMessagingJournal(trackedMessage, {
          status: 'delivery_unknown',
          error: err?.message || String(err),
        });
        return;
      }
      releaseMessageDelivery(trackedMessage.platform, trackedMessage.messageId);
      updateMessagingJournal(trackedMessage, { status: 'failed', error: err?.message || String(err) });
      console.error(`[Messaging] ${trackedMessage.platform} route failed:`, err?.message || err);
    }).then(() => {
      acceptedMessageSettlements.delete(settlement);
      settleAcceptedMessage();
    }, error => {
      acceptedMessageSettlements.delete(settlement);
      failAcceptedMessage(error);
    });
  });
  return true;
}
