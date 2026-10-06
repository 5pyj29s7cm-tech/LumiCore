import { extendTurnBindings } from '../../../cognition/turn_bindings';
import type { IncomingMessage, MessageHandler } from '../../../messaging/types';
import { commitBindingCodeConsumption, createBindingCode, deleteBindingForUser, getBinding, authorizeMessagingGroup, listMessagingGroupAuthorizations, revokeMessagingGroupAuthorization, listBindingsForUser, parseMessagingBindingCommand, planBindingCodeConsumption, rollbackBindingCodeConsumption, type BindingCodeConsumptionPlan, type MessagingPlatformId } from '../../../messaging/bindings';
import { getMember } from '../../../org/db';
import type { FeishuConfig } from '../../../messaging/feishu';
import { Router } from 'express';
import { FeishuAdapter, isMessagingDeliveryUnknownError } from '../../../messaging/feishu';
import { requireAuth } from '../../../middleware/auth';
import { getMessagingConfig, updateMessagingConfig } from '../../../messaging/config';
import { captureMessagingBinding, captureMessagingOrganization, isMessagingAuthorizationCurrent as isAcceptedMessagingAuthorizationCurrent, MessagingAuthorizationRevokedError } from '../../../messaging/turn_authorization';
import { getMessagingJournalEntry, recordMessagingIngress, listQueuedMessagingInputs, updateMessagingJournal } from '../../../messaging/message_journal';
import { evaluateMessagingIngress } from '../../../messaging/ingress_policy';
import { acceptMessageOnce, completeMessageDelivery, releaseMessageDelivery } from '../../../messaging/delivery_ledger';
import { commitPersonalOrganizationScopePlan, planPersonalOrganizationScope, requestsOrganizationScope } from '../../../messaging/personal_org_scope';
import { applyRemoteAttachmentContext, isRemoteConversationDismissalRequest } from '../../../messaging/attachment_context';
import { resolveUserTurn, type TurnResolution } from '../../../cognition/turn_resolution';
import { isPureOperationModeSwitchRequest, type OperationMode } from '../../../cognition/operation_modes';
import type { PersonalityConfig, ToolPolicy } from '../../../personality/types';
import { buildPendingAssistantOfferContextFromTranscript, type PendingAssistantOfferContext } from '../../../cognition/pending_assistant_offer';
import { buildLumiTurnDispatch, type LumiTurnDispatch } from '../../../cognition/turn_dispatch';
import { buildLumiExecutionPipeline, type LumiExecutionPipeline } from '../../../cognition/execution_pipeline';
import { toolRegistry } from '../../../tools/registry';
import { cancelConversationActionExecution, getConversationActionStatus, getMessagesByTokenBudget, getMessagesThroughExternalMessage, persistConversationExecutionPlan, prepareConversationActionExecution, settleConversationActionExecutionRequest, setConversationActionExecutionStatus, startConversationActionExecutionHeartbeat } from '../../../conversation/manager';
import { resolveAcceptedTurnConfirmation, type AcceptedUserTurnAdmission } from '../../../socket/action_turn_durability';
import { reserveConversationExecution } from '../../../cognition/conversation_execution';
import { flushDBOrThrow } from '../../../../db_layer';
import { buildTransportNeutralConfirmationScope, clearPendingConfirmationDurably, formatPendingConfirmationRequest, recordPendingConfirmationDurably } from '../../../tools/pending_confirmation';
import { clearPendingLegalNotice } from '../../../messaging/legal_notice_pending';
import { revalidateAcceptedTaskRelation, taskRelationFollowupIntent } from '../../../cognition/task_concurrency';
import { getStoredOperationMode, saveStoredOperationMode } from '../../../cognition/operation_mode_store';
import { persistExplicitRemoteRelationshipMemories, persistRemotePostTurnLearning } from './remote_memory';
import { generateSystemPrompt } from '../../../personality/engine';
import { buildUnifiedLegalEntryPrompt } from '../../../cognition/legal_entry';
import { CN_TASK_EXECUTION_MESSAGES } from './voice_fast_path_messages';
import { createConversationReceiptObserver } from '../../../conversation/execution_receipt_archive';
import { bindOrganizationWorkItemTask, registerOrganizationWorkExecution, routeOrganizationWork, setOrganizationWorkItemExecutionStatus, type OrganizationWorkExecution, type RouteOrganizationWorkResult } from '../../../org/work_routing';
import { bindCapabilityExecutionPlanTask } from '../../../cognition/capability_execution_plan';
import { formatConversationExecutionFactAnswer, getConversationExecutionFacts, isConversationExecutionFactQuestion } from '../../../conversation/execution_facts';
import { coalesceToolExecutionRecords, mergeToolExecutionRecords, taskReceiptsToRecords, toolRecordSucceeded } from '../../../cognition/task_execution_ledger';
import type { ToolExecutionRecord } from '../../../tools/types';
import { buildDesktopExecutionStabilityPolicy } from '../../../cognition/desktop_execution_stability';
import { createDesktopExecutionTracker } from '../../../desktop/execution_runtime';
import { buildInteractionModeOverlay } from '../../../cognition/turn_flow';
import { buildLumiRuntimeCapabilityContext } from '../../../cognition/capability_context';
import { formatClientSelfPromptForTurn } from '../../../client/self_model';
import { buildLumiOperatingKernelPrompt } from '../../../cognition/operating_kernel';
import { buildResponseLanguageInstruction } from '../../../utils/language';
import { getUserPreferredLLMConfig } from '../../../llm/user_preferences';
import { resolveModelRequestInputBudget } from '../../../llm/request_context_budget';
import { makeLLMCall, type NormalizedMessage } from '../../../llm/providers';
import { createTurnConfirmation } from '../../../tools/turn_confirmation';
import { isRetiredOperationModeRequest } from '../../../cognition/operation_modes';
import { buildOperationModeMetaResponse } from '../../../cognition/capability_meta';
import { executeToolCall } from '../../../tools/execution_engine';
import { formatOperationModeSwitchResponse } from '../../../i18n/operation_mode_messages';
import { handleRemoteLegalNoticeIntake } from './legal_notice_intake';
import { runToolSession } from "../../../llm/tool_session";
import { providerGetterArguments } from "../../../llm/provider_getters";
import { recordTokenUsage, recordTokenUsageBatch } from '../../../llm/token_tracker';
import { finalizeLumiResponse } from '../../../cognition/result_finalizer';
import { WeComAdapter, type WeComConfig } from '../../../messaging/wecom';
import { type MessagingRouteOptions, type IncomingMessageTransport, flushMessagingStateOrThrow, isMessagingReplyDurabilityError, buildRemoteRuntimeEvidenceContext, type MessagingDesktopRelay, type MessagingDesktopLifecycle, finalizeMessagingResponseForDelivery, withCurrentMessagingDesktopExecutionReceipt, currentMessagingFinalizationRecords, type MessagingFinalization } from "./messaging_finalization";
import { enrichFeishuAttachments, remotePlatformLabel, getRequestText, getDisplayText, buildRemoteTurnIntentText, enrichWeComAttachments } from "./remote_materials";
import { acceptingMessagingIngress, assertMessagingAuthorization, registerMessageRouteActivity, acceptedMessageSettlements, correlateMessagingReply, enqueueMessageRoute, isMessagingAuthorizationCurrent, newerMessageSupersedesThisTurn, registerActiveMessageRouteController } from "./messaging_ingress_runtime";
import { createMessagingReplyCommitter, admitBoundMessagingTurnDurably, removeSupersededAssistantMessage, conversationForMessagingTurn, persistBoundMessagingMessage } from "./messaging_persistence";
import { handleRemoteOrgCommand } from "./remote_org_commands";

const bindingCodeQueues = new Map<string, Promise<unknown>>();

function resolveMentionedOrganizationMembers(message: IncomingMessage, orgId: string): string[] {
  if (message.chatType !== 'group' || !orgId) return [];
  if (!['feishu', 'wecom', 'wechat'].includes(message.platform)) return [];
  const platform = message.platform as 'feishu' | 'wecom' | 'wechat';
  const members = (message.mentionedUserIds || []).flatMap(platformUserId => {
    if (!platformUserId || platformUserId === message.userId) return [];
    const binding = getBinding(platform, platformUserId, message.chatId, 'group');
    if (!binding || binding.orgId !== orgId) return [];
    const membership = getMember(orgId, binding.lumiUserId);
    if (!membership || membership.status !== 'active' || membership.role === 'viewer') return [];
    return [binding.lumiUserId];
  });
  return Array.from(new Set(members));
}

function requireMessagingAdmin(req: any, res: any): boolean {
  if (req.user?.role === 'admin') return true;
  res.status(403).json({ error: 'System administrator access is required for host messaging configuration and manual sends.' });
  return false;
}

function bindingOrgId(req: any): string {
  const sessionOrgId = String(req.user?.orgId || '').trim();
  const requestedOrgId = String(req.body?.orgId || '').trim();
  if (sessionOrgId && requestedOrgId && sessionOrgId !== requestedOrgId) {
    throw new Error('Requested organization does not match the active organization context');
  }
  return sessionOrgId || requestedOrgId;
}

export function createMessagingRoutes(
  feishuConfig: FeishuConfig,
  options?: MessagingRouteOptions,
): Router {
  const router = Router();
  const adapter = new FeishuAdapter(feishuConfig);
  recoverQueuedMessagingInputs('feishu', {
    enrich: message => enrichFeishuAttachments(message, adapter),
    reply: (message, text) => adapter.replyMessage(message.messageId, text),
  }, options);

  router.post('/feishu/events', async (req, res) => {
    try {
      const body = req.body;

      if (!adapter.verifyWebhook(body)) {
        return res.status(403).json({ error: 'Invalid Feishu verification token' });
      }

      // URL verification challenge
      if (body.type === 'url_verification' || body.event?.type === 'url_verification') {
        const challenge = body.challenge || body.event?.challenge;
        if (challenge) {
          console.log('[Feishu] URL verification challenge received');
          return res.json({ challenge });
        }
        return res.status(400).json({ error: 'Missing challenge token' });
      }

      let msg = adapter.parseEvent(body);
      if (msg?.chatType === 'group' && msg.botMentioned !== true) {
        await adapter.ensureBotIdentity();
        msg = adapter.parseEvent(body);
      }
      if (!msg) {
        return res.json({ code: 0 });
      }

      console.log(`[Feishu] Received ${msg.chatType} message ${msg.messageId}`);

      // Dispatch durably records input before scheduling any asynchronous work.
      dispatchIncomingMessage(msg, {
        enrich: message => enrichFeishuAttachments(message, adapter),
        reply: async (message, text) => {
          return adapter.replyMessage(message.messageId, text);
        },
      }, options);
      res.json({ code: 0 });
    } catch (err: any) {
      console.error('[Feishu] Event error:', err.message);
      if (!res.headersSent) {
        res.status(503).json({ code: -1, msg: err.message });
      }
    }
  });

  // ── POST /feishu/send — manual send (for testing / admin) ──
  router.post('/feishu/send', requireAuth, async (req, res) => {
    try {
      if (!requireMessagingAdmin(req, res)) return;
      const { chatId, text, card } = req.body;
      if (!chatId) return res.status(400).json({ error: 'chatId required' });
      if (!text && !card) return res.status(400).json({ error: 'text or card required' });
      if (req.body?.confirmed !== true) {
        return res.status(409).json({ error: 'Exact target and payload confirmation is required before sending' });
      }
      const idempotencyKey = String(req.body?.idempotencyKey || '').trim();
      if (!/^[A-Za-z0-9._:@/-]{16,240}$/.test(idempotencyKey)) {
        return res.status(400).json({ error: 'A stable idempotencyKey of 16-240 characters is required' });
      }

      let messageId: string;
      if (card) {
        messageId = await adapter.sendCard(chatId, card, idempotencyKey);
      } else {
        messageId = await adapter.sendMessage(chatId, { text, platform: 'feishu', idempotencyKey });
      }

      res.json({ success: true, messageId });
    } catch (err: any) {
      console.error('[Feishu] Send error:', err.message);
      if (isMessagingDeliveryUnknownError(err)) {
        return res.status(202).json({
          success: false,
          status: 'unknown_outcome',
          stopped: true,
          error: err.message,
        });
      }
      if (/idempotency key is already bound/i.test(String(err?.message || ''))) {
        return res.status(409).json({ error: err.message });
      }
      res.status(500).json({ error: err.message });
    }
  });

  // ── GET /feishu/status — health check ──
  router.get('/feishu/status', requireAuth, (_req, res) => {
    const cfg = getMessagingConfig().feishu;
    res.json({
      platform: 'feishu',
      configured: cfg.enabled,
      transport: cfg.transport,
      connection: options?.getConnectionStatus?.('feishu') || null,
      appId: cfg.appId ? `${cfg.appId.slice(0, 8)}...` : null,
      hasSecret: !!cfg.appSecret,
    });
  });

  // ── GET /feishu/config — full config (masked) ──
  router.get('/feishu/config', requireAuth, (req, res) => {
    if (!requireMessagingAdmin(req, res)) return;
    const cfg = getMessagingConfig().feishu;
    res.json({
      appId: cfg.appId,
      appIdMasked: cfg.appId ? `${cfg.appId.slice(0, 8)}...` : '',
      hasSecret: !!cfg.appSecret,
      verificationToken: cfg.verificationToken ? '***' : undefined,
      transport: cfg.transport,
      connection: options?.getConnectionStatus?.('feishu') || null,
      enabled: cfg.enabled,
    });
  });

  // ── POST /feishu/config — update config ──
  router.post('/feishu/config', requireAuth, async (req, res) => {
    try {
      if (!requireMessagingAdmin(req, res)) return;
      const { appId, appSecret, verificationToken, transport } = req.body;
      const updated = updateMessagingConfig({ appId, appSecret, verificationToken, transport });
      // Reload adapter with new config
      const newConfig = {
        appId: updated.feishu.appId,
        appSecret: updated.feishu.appSecret,
        verificationToken: updated.feishu.verificationToken,
        transport: updated.feishu.transport,
      };
      Object.assign(feishuConfig, newConfig);
      adapter.reload?.(newConfig);
      await options?.onConfigChanged?.();
      res.json({
        success: true,
        configured: updated.feishu.enabled,
        transport: updated.feishu.transport,
        connection: options?.getConnectionStatus?.('feishu') || null,
        appId: updated.feishu.appId ? `${updated.feishu.appId.slice(0, 8)}...` : '',
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  router.post('/feishu/bindings/code', requireAuth, (req, res) => {
    try {
      const code = createBindingCode('feishu', req.user!.uid, bindingOrgId(req));
      res.json({
        code: code.code,
        expiresAt: code.expiresAt,
        instruction: `在飞书里发送：绑定 Lumi ${code.code}`,
      });
    } catch (err: any) {
      res.status(400).json({ error: err?.message || 'Failed to create binding code' });
    }
  });

  router.get('/feishu/bindings', requireAuth, (req, res) => {
    const orgId = String(req.user?.orgId || '').trim();
    res.json({ bindings: listBindingsForUser(req.user!.uid).filter(item =>
      item.platform === 'feishu' && (!orgId || item.orgId === orgId)
    ) });
  });

  router.delete('/feishu/bindings/:bindingId', requireAuth, (req, res) => {
    const ok = deleteBindingForUser(req.user!.uid, req.params.bindingId, req.user?.orgId || undefined);
    res.json({ success: ok });
  });

  router.post('/feishu/groups/authorizations', requireAuth, (req, res) => {
    try {
      const orgId = bindingOrgId(req);
      const authorization = authorizeMessagingGroup({
        platform: 'feishu',
        chatId: String(req.body?.chatId || ''),
        orgId,
        createdBy: req.user!.uid,
        allowedPlatformUserIds: Array.isArray(req.body?.allowedPlatformUserIds)
          ? req.body.allowedPlatformUserIds
          : [],
      });
      res.json({ success: true, authorization });
    } catch (err: any) {
      res.status(403).json({ error: err?.message || 'Unable to authorize Feishu group' });
    }
  });

  router.get('/feishu/groups/authorizations', requireAuth, (req, res) => {
    try {
      const orgId = String(req.user?.orgId || req.query?.orgId || '').trim();
      const membership = getMember(orgId, req.user!.uid);
      if (!membership || membership.status !== 'active') {
        return res.status(403).json({ error: 'Active organization membership required' });
      }
      res.json({ authorizations: listMessagingGroupAuthorizations('feishu', orgId) });
    } catch (err: any) {
      res.status(400).json({ error: err?.message || 'Unable to list Feishu group authorizations' });
    }
  });

  router.delete('/feishu/groups/authorizations/:authorizationId', requireAuth, (req, res) => {
    try {
      const orgId = String(req.user?.orgId || req.body?.orgId || '').trim();
      const success = revokeMessagingGroupAuthorization({
        platform: 'feishu',
        authorizationId: String(req.params.authorizationId || ''),
        orgId,
        revokedBy: req.user!.uid,
      });
      res.json({ success });
    } catch (err: any) {
      res.status(403).json({ error: err?.message || 'Unable to revoke Feishu group authorization' });
    }
  });

  return router;
}

interface PlannedMessagingBindingCommand {
  reply: string;
  consumption?: BindingCodeConsumptionPlan;
}

function isBindingPlatform(platform: IncomingMessage['platform']): platform is MessagingPlatformId {
  return platform === 'feishu' || platform === 'wecom' || platform === 'wechat';
}

function planMessagingBindingCommand(msg: IncomingMessage): PlannedMessagingBindingCommand | null {
  if (!isBindingPlatform(msg.platform)) return null;
  const command = parseMessagingBindingCommand(msg.text);
  if (!command) return null;
  if (msg.chatType === 'group' && command.kind === 'bind') {
    return {
      reply: 'For security, Lumi identity binding codes can only be used in a private chat with the bot. This group must be authorized separately by an organization owner or administrator.',
    };
  }
  if (command.kind === 'status') {
    const current = getBinding(msg.platform, msg.userId, msg.chatId, msg.chatType);
    if (!current) {
      return { reply: `当前${remotePlatformLabel(msg.platform)}身份尚未绑定 Lumi。请在 Lumi 桌面端生成一次性绑定码后发送“绑定 Lumi 绑定码”。` };
    }
    if (current.domain === 'work') {
      const membership = getMember(current.orgId, current.lumiUserId);
      if (!membership || membership.status !== 'active') {
        return { reply: '已找到绑定记录，但对应组织成员权限已经失效。请在 Lumi 中恢复成员权限或重新绑定。' };
      }
    }
    return {
      reply: current.domain === 'personal'
        ? `绑定状态已核验：当前${remotePlatformLabel(msg.platform)}身份已连接到你的个人 Lumi。`
        : `绑定状态已核验：当前${msg.chatType === 'group' ? '群成员身份' : '会话身份'}已连接到 Lumi 组织工作域。`,
    };
  }
  if (command.kind === 'invalid') {
    return { reply: `绑定命令格式不完整。请原样发送“绑定 Lumi 绑定码”，或在 Lumi 桌面端重新生成${remotePlatformLabel(msg.platform)}绑定码。` };
  }
  const consumption = planBindingCodeConsumption(
    msg.platform,
    command.code,
    msg.userId,
    msg.chatId,
    msg.chatType,
  );
  if (!consumption) {
    return { reply: `绑定码无效或已过期。请在 Lumi 桌面端重新生成${remotePlatformLabel(msg.platform)}绑定码。` };
  }
  if (consumption.code.domain === 'work') {
    const membership = getMember(consumption.code.orgId, consumption.code.lumiUserId);
    if (!membership || membership.status !== 'active') {
      return { reply: '绑定码对应的组织成员权限已经失效。请在 Lumi 中恢复成员权限后重新生成绑定码。' };
    }
  }
  return {
    consumption,
    reply: consumption.code.domain === 'personal'
      ? '绑定成功。这里的消息会由你的个人 Lumi 处理，并同步到 Lumi 客户端聊天。'
      : '绑定成功。这个会话现在会按所选组织和你的 Lumi 身份路由；可以查询组织知识库、查询案件，或发送案件文件归档。',
  };
}

function applyMessagingBinding(msg: IncomingMessage): IncomingMessage {
  if (msg.bindingAuthorization !== undefined) return msg;
  if (!isBindingPlatform(msg.platform)) return msg;
  const binding = getBinding(msg.platform, msg.userId, msg.chatId, msg.chatType);
  if (!binding) return msg.boundUserId ? msg : { ...msg, bindingAuthorization: null };
  if (binding.domain === 'work') {
    const membership = getMember(binding.orgId, binding.lumiUserId);
    if (!membership || membership.status !== 'active') return msg;
  }
  return captureMessagingOrganization({
    ...msg,
    boundUserId: binding.lumiUserId,
    boundOrgId: binding.domain === 'work' ? binding.orgId : undefined,
    bindingAuthorization: captureMessagingBinding(binding),
  });
}

function applyPlannedMessagingBinding(
  msg: IncomingMessage,
  plan: BindingCodeConsumptionPlan,
): IncomingMessage {
  return captureMessagingOrganization({
    ...msg,
    boundUserId: plan.code.lumiUserId,
    boundOrgId: plan.code.domain === 'work' ? plan.code.orgId : undefined,
    bindingAuthorization: undefined,
  });
}

function recoverQueuedMessagingInputs(platform: IncomingMessage['platform'], transport: IncomingMessageTransport, options?: MessagingRouteOptions): void {
  setImmediate(() => {
    for (const message of listQueuedMessagingInputs(platform)) {
      try { dispatchIncomingMessage(message, transport, options); }
      catch (error: any) { console.warn(`[Messaging] Queued ${platform} input remains pending:`, error?.message || error); }
    }
  });
}

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

const ORGANIZATION_VIEWER_WRITE_TOOLS = [
  'legal_case_workspace',
  'legal_message_intake_to_case',
  'legal_meeting_minutes_to_case',
  'legal_import_materials_to_kb',
  'legal_import_judgment',
  'wechat_send_file',
  'feishu_send_file',
];

export interface RemoteLumiExecutionPlanInput {
  requestId?: string;
  userText?: string;
  acceptedResolution?: TurnResolution;
  userId: string;
  text: string;
  source: string;
  domain: 'personal' | 'work';
  orgId: string;
  operationMode: OperationMode;
  identityBound: boolean;
  canWriteOrganization: boolean;
  personalityToolPolicy?: ToolPolicy;
  actionTaskState?: import('../../../cognition/action_continuation').ConversationActionContinuationState | null;
  taskId?: string;
  pendingAssistantOfferContext?: PendingAssistantOfferContext;
}

function unauthenticatedRemoteDispatch(dispatch: LumiTurnDispatch): LumiTurnDispatch {
  const flow = {
    ...dispatch.flow,
    operationMode: 'chat' as const,
    effectiveOperationMode: 'chat' as const,
    requestedMode: null,
    autoPromoteToAssistant: false,
    allowToolUseForTurn: false,
    selfRepairTurn: false,
    clientActionOnlyTurn: false,
    promptOverlay: [
      '## Lumi Turn Flow',
      'Channel: chat. Surface: chat. Mode: chat -> chat. Tool access: chat-only.',
      'This remote sender is not identity-bound. Keep the turn conversational and do not expose private, local, organization, client, or desktop tools.',
    ].join('\n'),
  };
  return {
    ...dispatch,
    boundary: 'conversation',
    flow,
    promptOverlay: [
      '## Lumi Unified Turn Dispatch',
      `Entry channel: chat. Source: ${dispatch.source}. Surface: chat. Boundary: conversation.`,
      'Identity boundary: this sender is not bound to a Lumi user, so this turn cannot control or inspect a private Lumi client.',
    ].join('\n'),
  };
}

export function buildRemoteLumiExecutionPlan(input: RemoteLumiExecutionPlanInput): LumiExecutionPipeline {
  const rawDispatch = buildLumiTurnDispatch({
    userId: input.userId,
    text: input.text,
    channel: 'chat',
    source: input.source,
    category: input.domain === 'work' ? 'organization' : undefined,
    domain: input.domain,
    orgId: input.orgId,
    operationMode: input.operationMode,
    targetIsLumi: true,
  });
  const dispatch = input.identityBound ? rawDispatch : unauthenticatedRemoteDispatch(rawDispatch);
  return buildLumiExecutionPipeline({
    requestId:input.requestId, userText:input.userText, acceptedResolution:input.acceptedResolution,
    dispatch: {
      userId: input.userId,
      text: input.text,
      channel: 'chat',
      source: input.source,
      category: input.domain === 'work' ? 'organization' : undefined,
      domain: input.domain,
      orgId: input.orgId,
      operationMode: input.operationMode,
      targetIsLumi: true,
    },
    prebuiltDispatch: dispatch,
    registry: toolRegistry,
    personalityToolPolicy: input.personalityToolPolicy,
    actionTaskState: input.actionTaskState,
    pendingAssistantOfferContext: input.pendingAssistantOfferContext,
    isSanctuary: !input.identityBound,
    additionalForbiddenTools: input.domain === 'work' && !input.canWriteOrganization
      ? ORGANIZATION_VIEWER_WRITE_TOOLS
      : undefined,
    decisionText: input.text,
    traceText: input.text,
    source: input.source,
    taskId: input.taskId,
  });
}

async function enqueueBindingCodeTransaction<T>(
  plan: BindingCodeConsumptionPlan,
  work: () => Promise<T>,
): Promise<T> {
  const key = `${plan.platform}:${plan.code.code}`;
  const previous = bindingCodeQueues.get(key) || Promise.resolve();
  const next = previous.catch(() => undefined).then(work);
  bindingCodeQueues.set(key, next);
  try {
    return await next;
  } finally {
    if (bindingCodeQueues.get(key) === next) bindingCodeQueues.delete(key);
  }
}

export function buildRemoteConversationHistory(
  priorMessages: any[],
  msg: IncomingMessage,
): Array<{ role: 'user' | 'assistant'; content: string }> {
  const stableMessageId = String(msg.messageId || '').trim();
  const stableRequestId = stableMessageId ? `${msg.platform}_bot:${stableMessageId}` : '';
  let historicalMessages = msg.userMessagePersisted && stableMessageId
    ? priorMessages.filter(item => !(
        item.role === 'user'
        && (item.externalMessageId === stableMessageId || item.requestId === stableRequestId)
      ))
    : [...priorMessages];

  // Compatibility for old rows that predate remote message IDs. When identity
  // is unavailable, remove the legacy turn as a unit so its assistant response
  // cannot be left orphaned. Modern turns are filtered only by stable identity;
  // identical text from a prior message is legitimate history.
  if (msg.userMessagePersisted && !stableMessageId) {
    const currentDisplayText = getDisplayText(msg).trim();
    for (let index = historicalMessages.length - 1; index >= 0; index -= 1) {
      const item = historicalMessages[index];
      const content = String(item.message || item.content || '').trim();
      if (item.role !== 'user' || item.externalMessageId || item.requestId || content !== currentDisplayText) continue;
      const remove = new Set([index]);
      const following = historicalMessages[index + 1];
      if (
        following?.role === 'assistant'
        && !following.externalMessageId
        && !following.requestId
      ) {
        remove.add(index + 1);
      }
      historicalMessages = historicalMessages.filter((_, itemIndex) => !remove.has(itemIndex));
      break;
    }
  }

  return historicalMessages.flatMap((item: any) => {
    const content = String(item.message || item.content || '').trim();
    const response = String(item.response || '').trim();
    if (item.role === 'assistant') return content ? [{ role: 'assistant' as const, content }] : [];
    if (item.role === 'user') {
      return [
        ...(content ? [{ role: 'user' as const, content }] : []),
        ...(response ? [{ role: 'assistant' as const, content: response }] : []),
      ];
    }
    return [];
  }).slice(-16);
}

function messagingPendingOffer(msg: IncomingMessage, conversation: ReturnType<typeof conversationForMessagingTurn>): PendingAssistantOfferContext | undefined {
  const precedingTranscript = conversation
    ? getMessagesThroughExternalMessage(conversation.id, msg.messageId, 8).filter(item => !(
        item.role === 'user'
        && (item.externalMessageId === msg.messageId || item.requestId === `${msg.platform}_bot:${msg.messageId}`)
      ))
    : [];
  return conversation
    ? buildPendingAssistantOfferContextFromTranscript({
        messages: precedingTranscript,
        userId: msg.boundUserId,
        domain: msg.boundOrgId ? 'work' : 'personal',
        orgId: msg.boundOrgId || '',
        conversationId: conversation.id,
        taskId: conversation.actionContinuationState?.taskId,
      })
    : undefined;
}

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

async function prepareMessagingTurn(msg: IncomingMessage, options?: MessagingRouteOptions, preacceptedAdmission?: AcceptedUserTurnAdmission<string> | null, acceptedTurn?: { resolution: TurnResolution; pendingAssistantOfferContext?: PendingAssistantOfferContext }) {

  msg = captureMessagingOrganization(msg);
  assertMessagingAuthorization(msg);
  const llm = options?.llmGetters;
  const requestText = getRequestText(msg);
  const registry = options?.personalityRegistry;
  const isIdentityBound = Boolean(msg.boundUserId);
  const isOrganizationBound = Boolean(msg.boundUserId && msg.boundOrgId);
  const effectiveUserId = isIdentityBound ? msg.boundUserId! : 'anonymous';
  const domain = isOrganizationBound ? 'work' as const : 'personal' as const;
  const orgId = isOrganizationBound ? msg.boundOrgId! : '';
  const source = `${msg.platform}_bot`;
  const requestId = `${source}:${msg.messageId}`;
  const flushTerminalReply = async (): Promise<void> => {
    if (isIdentityBound) await flushMessagingStateOrThrow('terminal_reply');
  };
  const conversation = isIdentityBound ? conversationForMessagingTurn(msg) : null;
  // The public entry already persisted and flushed the accepted turn before queue admission.
  const acceptedTurnAdmission = preacceptedAdmission;
  if (isIdentityBound && (!conversation || !acceptedTurnAdmission || acceptedTurnAdmission.persisted !== msg.userMessageId)) {
    throw new Error('The admitted remote turn lost its original conversation or durability token.');
  }
  const actionAbortController = new AbortController();
  let organizationWorkExecution: OrganizationWorkExecution | null = null;
  const actionWasCancelled = () => (
    actionAbortController.signal.aborted || newerMessageSupersedesThisTurn(msg) || !isMessagingAuthorizationCurrent(msg)
    || Boolean(organizationWorkExecution && !organizationWorkExecution.isCurrent())
  );
  const commitReply = createMessagingReplyCommitter(msg, {
    flush: flushTerminalReply, isCancelled: actionWasCancelled, onConversationUpdated: options?.onConversationUpdated,
  });
  const pendingAssistantOfferContext = acceptedTurn
    ? acceptedTurn.pendingAssistantOfferContext : messagingPendingOffer(msg, conversation);
  const confirmationChannelScope = conversation
    ? buildTransportNeutralConfirmationScope({
        domain,
        orgId,
        conversationId: conversation.id,
      })
    : undefined;
  let confirmationScope = conversation
    ? buildTransportNeutralConfirmationScope({
        domain,
        orgId,
        conversationId: conversation.id,
        taskId: conversation.actionContinuationState?.taskId,
      })
    : undefined;
  if (isRemoteConversationDismissalRequest(requestText)) {
    if (isIdentityBound) {
      clearPendingLegalNotice(msg, effectiveUserId);
      if (confirmationScope) {
        await clearPendingConfirmationDurably(effectiveUserId, confirmationScope);
      }
      if (confirmationChannelScope) {
        await clearPendingConfirmationDurably(effectiveUserId, confirmationChannelScope);
      }
      if (conversation?.actionContinuationState?.unfinished) {
        cancelConversationActionExecution(
          conversation.id,
          effectiveUserId,
          'The user ended the current remote foreground exchange.',
        );
      }
    }
    const dismissalReply = /[\u3400-\u9fff]/u.test(requestText)
      ? '好，有需要再叫我。'
      : 'Okay. I\'m here when you need me.';
    return { terminal: await ( await commitReply(dismissalReply)), context: undefined };
  }
  const turnResolution = acceptedTurn?.resolution || resolveUserTurn({
    requestId, userText: requestText, state: conversation?.actionContinuationState,
    options: { pendingAssistantOfferContext },
  });
  const acceptedRelation = revalidateAcceptedTaskRelation(turnResolution.taskRelation, conversation?.actionContinuationState);
  const confirmationResolution = isIdentityBound
    && acceptedTurnAdmission
    && confirmationScope
    && confirmationChannelScope
    ? await resolveAcceptedTurnConfirmation({
        admission: acceptedTurnAdmission,
        userId: effectiveUserId,
        userText: requestText,
        actionState: conversation?.actionContinuationState,
        taskRelation: acceptedRelation,
        taskScope: confirmationScope,
        channelScope: confirmationChannelScope,
      })
    : null;
  if (confirmationResolution) confirmationScope = confirmationResolution.scope;
  const pendingConfirmation = confirmationResolution?.pending || null;
  const pendingConfirmationPrompt = confirmationResolution?.prompt || '';
  const correctionRequiresFreshConfirmation =
    confirmationResolution?.correctionRequiresFreshConfirmation === true;
  assertMessagingAuthorization(msg);
  const organizationMembership = isOrganizationBound ? getMember(orgId, effectiveUserId) : null;
  const canWriteOrganization = organizationMembership?.status === 'active' && organizationMembership.role !== 'viewer';
  // Capability selection is authorized by this user turn, not by words inside
  // an attachment or its cache path. The full attachment remains available in
  // the model's user message for read-only analysis, while planning, task
  // relation, tool projection and confirmation bind only to current wording.
  const routingText = buildRemoteTurnIntentText(msg, pendingConfirmationPrompt);
  const operationMode = isIdentityBound ? getStoredOperationMode(effectiveUserId) : 'chat';
  let personality: PersonalityConfig | null = null;
  if (registry) {
    try {
      personality = registry.getForUser('lumi', isIdentityBound ? effectiveUserId : undefined, domain === 'work' ? orgId : undefined)
        || registry.getDefault();
    } catch (error: any) {
      console.warn('[Messaging] Personality configuration unavailable:', error.message);
    }
  }
  const executionPlan = buildRemoteLumiExecutionPlan({
    requestId,userText:requestText,acceptedResolution:turnResolution,
    actionTaskState:conversation?.actionContinuationState,
    userId: effectiveUserId,
    text: routingText,
    source,
    domain,
    orgId,
    operationMode,
    identityBound: isIdentityBound,
    canWriteOrganization,
    personalityToolPolicy: personality?.toolPolicy,
    pendingAssistantOfferContext,
  });
  const priorMessages = conversation
    ? getMessagesByTokenBudget(conversation.id, 6000, 8, msg.messageId)
    : [];
  const priorRuntimeEvidence = conversation
    ? buildRemoteRuntimeEvidenceContext(getMessagesThroughExternalMessage(conversation.id, msg.messageId, 12))
    : '';
  const conversationHistory = buildRemoteConversationHistory(priorMessages, msg);

  let explicitRemoteMemoryIds: string[] = [];
  if (isIdentityBound) {
    try {
      explicitRemoteMemoryIds = persistExplicitRemoteRelationshipMemories(msg);
    } catch (error: any) {
      console.warn('[Messaging] Explicit remote relationship memory failed:', error?.message || error);
    }
  }
  if (newerMessageSupersedesThisTurn(msg)) return { terminal: await ( ''), context: undefined };

  const requestedMode = executionPlan.turnIntent.flow.requestedMode;
  // A semantic action match is only a planning hint. It must not silently
  // mutate the user's persisted client mode before the model has decided to
  // act. Keep the deterministic native fast path solely for an exact, explicit
  // mode-switch command; compound work remains model-owned.
  const directlyAppliedMode: OperationMode | null = requestedMode
    && isPureOperationModeSwitchRequest(requestText, requestedMode)
    ? requestedMode
    : null;

  // ── Build system prompt from Lumi personality ──
  let systemPrompt = '';

  if (personality) {
    try {
      const memories = isIdentityBound && options?.queryMemories
        ? options.queryMemories({ userId: effectiveUserId, query: requestText, limit: 5, minConfidence: 0.4, domain, orgId })
        : [];
      const emotionalStateKey = domain === 'work' ? `${effectiveUserId}:org:${orgId}` : effectiveUserId;
      const emotionalState = isIdentityBound && options?.loadEmotionalState ? options.loadEmotionalState(emotionalStateKey) : undefined;

      systemPrompt = generateSystemPrompt(
        personality,
        { mode: executionPlan.executionRequested ? 'task' : 'chat', sensory: { audio: false, visual: false, spatial: false, haptic: false, holographic: false, activeDeviceTypes: [], deviceCount: 0 } },
        {
          memories: memories.length > 0 ? memories : undefined,
          emotionalState,
          userId: effectiveUserId,
          userText: requestText,
          domain,
          orgId,
        },
      );
    } catch (err: any) {
      console.warn(`[Messaging] ${source} personality build failed, using fallback:`, err.message);
    }
  }

  if (!systemPrompt) {
    systemPrompt = `You are Lumi, speaking with the user through ${remotePlatformLabel(msg.platform)}. Keep the response concise, useful, and natural, and follow the user's language.`;
  }
  if (isOrganizationBound) {
    systemPrompt += `\n\nThis ${remotePlatformLabel(msg.platform)} session is routed from the same personal Lumi into an organization work domain. Organization ID: ${orgId}. Member role: ${organizationMembership?.role || 'unknown'}. Use only this organization's work memory and data for the turn, and do not write organization content into personal memory automatically. You may analyze the current message and supplied attachments. Organization knowledge lookup and case archive actions must run through server tools. Never claim an organization write unless a tool result confirms it. Legal materials require final review by a qualified lawyer.`;
  } else if (isIdentityBound) {
    systemPrompt += `\n\nThis ${remotePlatformLabel(msg.platform)} user is bound to personal Lumi, and this turn remains in the personal domain. Use the user's personal identity, personality, and conversation memory, and synchronize the turn with personal Lumi chat. Personal Lumi may enter an authorized organization only when the user explicitly selects one, the task resolves to one organization, or an existing organization session scope is retained. No organization scope was resolved for this turn, so do not access or claim access to organization data.`;
  } else {
    systemPrompt += `\n\nThis ${remotePlatformLabel(msg.platform)} user has no verified Lumi identity binding. You may analyze text and attachments supplied in this turn, but do not claim access to organization knowledge, organization cases, or private local data. Only the server binding record can confirm identity; never declare a successful binding merely because the user says it is bound or asks for confirmation.`;
  }
  const attachmentContext = msg.raw?.lumiAttachmentContext;
  if (attachmentContext?.cleared) {
    systemPrompt += '\n\nThe user just cleared the material context for this exact remote conversation. Confirm it briefly. Do not use or mention any earlier attachments.';
  } else if (attachmentContext?.totalCount > 0) {
    systemPrompt += `\n\nRemote material continuity: ${attachmentContext.totalCount} verified locally cached attachment(s) are available in this exact member/chat/thread scope, including ${attachmentContext.carriedCount || 0} carried from earlier turns. Use them for follow-up questions without asking the user to upload again. Never carry them into another member, organization, chat, or thread. If this turn added new files, briefly tell the user once that the materials will remain available in this conversation and can be cleared by sending “清除会话材料”.`;
  }

  const legalOverlay = buildUnifiedLegalEntryPrompt({
    text: routingText,
    domain,
    orgId,
    channel: msg.platform,
    source: `${msg.platform}_bot`,
  });
  if (legalOverlay) systemPrompt += `\n\n${legalOverlay}`;

  const turnDispatch = executionPlan.turnIntent;
  const turnFlow = turnDispatch.flow;
  const executionDecision = executionPlan.execution;
  const capabilitySelection = executionPlan.capabilityPlan;
  const modelToolPolicy = executionPlan.authorizationPolicy;
  const modelToolProjection = executionPlan.modelToolProjection;
  const toolSessionActive = executionPlan.executionRequested;
  const actionFollowupIntent = taskRelationFollowupIntent(acceptedRelation);
  const actionTaskExecution = isIdentityBound && conversation
    ? prepareConversationActionExecution({
        conversationId: conversation.id,
        userId: effectiveUserId,
        userText: requestText,
        requestId,
        userMessageId: msg.userMessageId || '',
        toolPolicy: modelToolPolicy,
        forceResume: Boolean(pendingConfirmation || actionFollowupIntent === 'execute'),
        forceTask: executionPlan.capabilityPlan.taskLedgerRequired
          || (isOrganizationBound && requestsOrganizationScope(requestText)),
      })
    : { state: null, kind: 'conversation' as const, turnRowId: undefined };
  if ('bindingFailure' in actionTaskExecution) {
    const staleText = actionTaskExecution.bindingFailure === 'busy'
      ? CN_TASK_EXECUTION_MESSAGES.actionTurnBusy
      : CN_TASK_EXECUTION_MESSAGES.actionTurnStale;
    return { terminal: await ( await commitReply(staleText)), context: undefined };
  }
  const receiptObserver = conversation && actionTaskExecution.state?.taskId
    ? createConversationReceiptObserver({
        userId: effectiveUserId, conversationId: conversation.id,
        taskId: actionTaskExecution.state.taskId, requestId, turnRowId: actionTaskExecution.turnRowId,
        externalMessageId: msg.messageId, domain, orgId,
      // Closing ingress stops new execution, not evidence for work already begun.
      }, () => isAcceptedMessagingAuthorizationCurrent(msg))
    : undefined;
  let desktopRelay: MessagingDesktopRelay | undefined;
  let personalDesktopRelay: MessagingDesktopRelay | undefined;
  const releaseActiveMessageRouteController = registerActiveMessageRouteController(
    msg,
    actionAbortController,
  );
  const actionLeaseHeartbeat = isIdentityBound && conversation
    ? startConversationActionExecutionHeartbeat({
        conversationId: conversation.id,
        userId: effectiveUserId,
        requestId,
        abortController: actionAbortController,
        onPersistenceUnknown: flushDBOrThrow,
      })
    : null;
  const actionLeaseWasLost = () => Boolean(actionLeaseHeartbeat?.isLeaseLost());
  const throwIfActionLeaseWasLost = () => {
    assertMessagingAuthorization(msg);
    organizationWorkExecution?.assertCurrent();
    if (!actionLeaseWasLost()) return;
    const error = new Error('Remote conversation action execution lease was lost');
    error.name = 'AbortError';
    throw error;
  };
  return { terminal: undefined, context: {
    isIdentityBound: isIdentityBound as typeof isIdentityBound,
    actionTaskExecution: actionTaskExecution as typeof actionTaskExecution,
    requestId: requestId as typeof requestId,
    actionAbortController: actionAbortController as typeof actionAbortController,
    receiptObserver: receiptObserver as typeof receiptObserver,
    get desktopRelay(): typeof desktopRelay { return desktopRelay; },
    set desktopRelay(value: typeof desktopRelay) { desktopRelay = value; },
    options: options as typeof options,
    effectiveUserId: effectiveUserId as typeof effectiveUserId,
    source: source as typeof source,
    domain: domain as typeof domain,
    orgId: orgId as typeof orgId,
    get personalDesktopRelay(): typeof personalDesktopRelay { return personalDesktopRelay; },
    set personalDesktopRelay(value: typeof personalDesktopRelay) { personalDesktopRelay = value; },
    conversation: conversation as typeof conversation,
    executionPlan: executionPlan as typeof executionPlan,
    actionFollowupIntent: actionFollowupIntent as typeof actionFollowupIntent,
    requestText: requestText as typeof requestText,
    commitReply: commitReply as typeof commitReply,
    isOrganizationBound: isOrganizationBound as typeof isOrganizationBound,
    directlyAppliedMode: directlyAppliedMode as typeof directlyAppliedMode,
    get msg(): typeof msg { return msg; },
    set msg(value: typeof msg) { msg = value; },
    routingText: routingText as typeof routingText,
    get organizationWorkExecution(): typeof organizationWorkExecution { return organizationWorkExecution; },
    set organizationWorkExecution(value: typeof organizationWorkExecution) { organizationWorkExecution = value; },
    get systemPrompt(): typeof systemPrompt { return systemPrompt; },
    set systemPrompt(value: typeof systemPrompt) { systemPrompt = value; },
    toolSessionActive: toolSessionActive as typeof toolSessionActive,
    turnFlow: turnFlow as typeof turnFlow,
    capabilitySelection: capabilitySelection as typeof capabilitySelection,
    turnDispatch: turnDispatch as typeof turnDispatch,
    executionDecision: executionDecision as typeof executionDecision,
    get explicitRemoteMemoryIds(): typeof explicitRemoteMemoryIds { return explicitRemoteMemoryIds; },
    set explicitRemoteMemoryIds(value: typeof explicitRemoteMemoryIds) { explicitRemoteMemoryIds = value; },
    priorRuntimeEvidence: priorRuntimeEvidence as typeof priorRuntimeEvidence,
    pendingConfirmationPrompt: pendingConfirmationPrompt as typeof pendingConfirmationPrompt,
    conversationHistory: conversationHistory as typeof conversationHistory,
    pendingConfirmation: pendingConfirmation as typeof pendingConfirmation,
    get confirmationScope(): typeof confirmationScope { return confirmationScope; },
    set confirmationScope(value: typeof confirmationScope) { confirmationScope = value; },
    confirmationChannelScope: confirmationChannelScope as typeof confirmationChannelScope,
    correctionRequiresFreshConfirmation: correctionRequiresFreshConfirmation as typeof correctionRequiresFreshConfirmation,
    actionWasCancelled: actionWasCancelled as typeof actionWasCancelled,
    flushTerminalReply: flushTerminalReply as typeof flushTerminalReply,
    modelToolPolicy: modelToolPolicy as typeof modelToolPolicy,
    llm: llm as typeof llm,
    throwIfActionLeaseWasLost: throwIfActionLeaseWasLost as typeof throwIfActionLeaseWasLost,
    operationMode: operationMode as typeof operationMode,
    modelToolProjection: modelToolProjection as typeof modelToolProjection,
    actionLeaseWasLost: actionLeaseWasLost as typeof actionLeaseWasLost,
    actionLeaseHeartbeat: actionLeaseHeartbeat as typeof actionLeaseHeartbeat,
    releaseActiveMessageRouteController: releaseActiveMessageRouteController as typeof releaseActiveMessageRouteController,
  } };
}
type MessagingTurnContext = NonNullable<Awaited<ReturnType<typeof prepareMessagingTurn>>["context"]>;

async function prepareMessagingExecution(context: MessagingTurnContext) {

  if (context.isIdentityBound) {
    const lifecycle: MessagingDesktopLifecycle = {
      taskId: context.actionTaskExecution.state?.taskId, requestId: context.requestId,
      signal: context.actionAbortController.signal, onLateResult: context.receiptObserver?.onDesktopLateResult,
    };
    context.desktopRelay = context.options?.createScopedDesktopRelay?.(context.effectiveUserId, context.source, context.domain, context.orgId, lifecycle);
    context.personalDesktopRelay = context.options?.createPersonalDesktopRelay?.(context.effectiveUserId, context.source, lifecycle);
  }
  if (context.conversation && context.actionTaskExecution.state?.taskId) {
    context.executionPlan.executionPlan = bindCapabilityExecutionPlanTask(
      context.executionPlan.executionPlan,
      context.actionTaskExecution.state.taskId,
    );
    persistConversationExecutionPlan({
      conversationId: context.conversation.id,
      userId: context.effectiveUserId,
      plan: context.executionPlan.executionPlan,
    });
  }
  if (context.isIdentityBound && context.conversation && context.actionFollowupIntent === 'status') {
    const executionFactQuestion = isConversationExecutionFactQuestion(context.requestText);
    const statusText = executionFactQuestion
      ? formatConversationExecutionFactAnswer(getConversationExecutionFacts({
          conversationId: context.conversation.id,
          userId: context.effectiveUserId,
          domain: context.domain,
          orgId: context.orgId,
          currentRequestId: context.requestId,
          taskId: context.conversation.actionContinuationState?.taskId || '',
        }), context.requestText)
      : getConversationActionStatus(
          context.conversation.id,
          context.effectiveUserId,
          context.requestText,
          context.conversation.actionContinuationState,
        );
    return { terminal: await ( await context.commitReply(statusText, { beforeFlush: superseded => {
      settleConversationActionExecutionRequest(context.conversation.id, context.effectiveUserId, context.requestId,
        superseded ? 'The remote status turn was superseded by a newer user message.' : undefined);
    } })), context: undefined };
  }
  let organizationWorkRoute: RouteOrganizationWorkResult | null = null;
  const shouldRouteOrganizationWork = Boolean(
    context.isOrganizationBound
    && context.conversation
    && context.actionTaskExecution.state?.taskId
    && (
      context.executionPlan.capabilityPlan.taskLedgerRequired
      || requestsOrganizationScope(context.requestText)
      || context.actionTaskExecution.kind === 'resume'
      || Boolean(context.options?.onMessage)
    )
    && !context.directlyAppliedMode
    && context.executionPlan.normalizedIntent.operation !== 'status'
    && context.executionPlan.normalizedIntent.operation !== 'explain',
  );
  if (shouldRouteOrganizationWork) {
    try {
      const mentionedMemberIds = resolveMentionedOrganizationMembers(context.msg, context.orgId);
      organizationWorkRoute = routeOrganizationWork({
        orgId: context.orgId,
        requesterUserId: context.effectiveUserId,
        source: context.source,
        requestId: context.requestId,
        idempotencyKey: `organization-work:${context.requestId}`,
        text: context.routingText,
        intentKind: context.executionPlan.normalizedIntent.kind,
        operation: context.executionPlan.normalizedIntent.operation,
        sideEffectClass: context.executionPlan.normalizedIntent.sideEffectClass,
        conversationId: context.conversation!.id,
        taskId: context.actionTaskExecution.state!.taskId,
        platform: context.msg.platform,
        targetMemberId: mentionedMemberIds[0],
        targetMemberIds: mentionedMemberIds,
      });
      bindOrganizationWorkItemTask({
        orgId: context.orgId,
        workItemId: organizationWorkRoute.workItem.id,
        conversationId: context.conversation!.id,
        taskId: context.actionTaskExecution.state!.taskId,
      });
      const route = organizationWorkRoute.workItem;
      if (!['waiting_approval', 'waiting_human'].includes(route.status)) {
        context.organizationWorkExecution = registerOrganizationWorkExecution({
          orgId: context.orgId,
          workItemId: route.id,
          actorUserId: context.effectiveUserId,
          abortController: context.actionAbortController,
        });
      }
      context.systemPrompt += [
        '',
        '## Organization Business Route',
        `Work item: ${route.id}. Status: ${route.status}.`,
        `Department: ${route.departmentId || 'organization-default'}. Position: ${route.positionId || 'none'}.`,
        `Primary member: ${route.assignedMemberId || 'none'}. Collaborators: ${(route.collaboratorMemberIds || []).join(', ') || 'none'}.`,
        `Required skill tags: ${route.skillTags.join(', ') || 'none'}.`,
        'Do not claim another department, member, position, or skill handled the task unless this durable route or a later handoff receipt says so.',
      ].join('\n');
    } catch (error: any) {
      const blocker = `Organization work routing failed: ${error?.message || error}`;
      setConversationActionExecutionStatus(context.conversation!.id, context.effectiveUserId, 'blocked', { blocker, requestId: context.requestId });
      settleConversationActionExecutionRequest(context.conversation!.id, context.effectiveUserId, context.requestId, blocker);
      const response = `组织任务没有开始执行：${error?.message || '业务路由校验失败'}。请由组织管理员检查部门、岗位、成员或技能配置。`;
      return { terminal: await ( await context.commitReply(response)), context: undefined };
    }
  }
  if (organizationWorkRoute?.workItem.status === 'waiting_approval') {
    const approvalId = organizationWorkRoute.approval?.id || organizationWorkRoute.workItem.approvalId || '';
    const blocker = `Organization approval ${approvalId} is required before execution.`;
    setConversationActionExecutionStatus(context.conversation!.id, context.effectiveUserId, 'blocked', { blocker, requestId: context.requestId });
    settleConversationActionExecutionRequest(context.conversation!.id, context.effectiveUserId, context.requestId, blocker);
    const response = `任务已完成组织路由，但尚未执行。工作项 ${organizationWorkRoute.workItem.id} 正在等待组织管理员审批（审批单 ${approvalId}）。审批通过后，在当前会话说“继续”即可恢复原任务。`;
    return { terminal: await ( await context.commitReply(response)), context: undefined };
  }
  if (organizationWorkRoute?.workItem.status === 'waiting_human') {
    const owner = organizationWorkRoute.workItem.humanOwnerUserId || organizationWorkRoute.workItem.assignedMemberId || '指定成员';
    const blocker = `Organization work item is owned by human member ${owner}.`;
    setConversationActionExecutionStatus(context.conversation!.id, context.effectiveUserId, 'blocked', { blocker, requestId: context.requestId });
    settleConversationActionExecutionRequest(context.conversation!.id, context.effectiveUserId, context.requestId, blocker);
    const response = `任务已转交给组织成员 ${owner}，LumiCore 已停止自动执行。工作项：${organizationWorkRoute.workItem.id}。后续只有收到新的持久转派回执后才会恢复。`;
    return { terminal: await ( await context.commitReply(response)), context: undefined };
  }
  if (
    context.conversation
    && (context.toolSessionActive || Boolean(context.directlyAppliedMode))
    && (context.actionTaskExecution.kind === 'new' || context.actionTaskExecution.kind === 'resume')
  ) {
    setConversationActionExecutionStatus(context.conversation.id, context.effectiveUserId, 'executing', { requestId: context.requestId });
    if (organizationWorkRoute) {
      setOrganizationWorkItemExecutionStatus({
        orgId: context.orgId,
        workItemId: organizationWorkRoute.workItem.id,
        status: 'executing',
        actorUserId: context.effectiveUserId,
        execution: context.organizationWorkExecution,
      });
    }
  }
  const priorTaskRecords = context.actionTaskExecution.kind === 'resume'
    ? taskReceiptsToRecords(context.actionTaskExecution.state?.receipts || [])
    : [];
  const taskAwareRecords = (records: ToolExecutionRecord[]) => (
    coalesceToolExecutionRecords([...priorTaskRecords, ...records])
  );
  const desktopExecutionPolicy = buildDesktopExecutionStabilityPolicy({
    channel: 'chat',
    text: context.routingText,
    flow: context.turnFlow,
    capabilitySelection: context.capabilitySelection,
    capabilityExecutionPlan: context.executionPlan.executionPlan,
  });
  const desktopExecutionTracker = createDesktopExecutionTracker(desktopExecutionPolicy.executionPlan);

  context.systemPrompt += `\n\n${context.turnDispatch.promptOverlay}`;
  context.systemPrompt += `\n\n${context.turnFlow.promptOverlay}`;
  context.systemPrompt += `\n\n${buildInteractionModeOverlay(context.turnFlow)}`;
  context.systemPrompt += `\n\n${context.executionDecision.promptOverlay}`;
  if (context.isIdentityBound) {
    context.systemPrompt += `\n\n${buildLumiRuntimeCapabilityContext({
      userId: context.effectiveUserId,
      text: context.routingText,
      flow: context.turnFlow,
      toolRegistry,
      domain: context.domain,
      orgId: context.orgId,
    })}`;
    context.systemPrompt += `\n\n${context.capabilitySelection.promptOverlay}`;
    if (desktopExecutionPolicy.promptOverlay) {
      context.systemPrompt += `\n\n${desktopExecutionPolicy.promptOverlay}`;
    }
    context.systemPrompt += `\n\n${formatClientSelfPromptForTurn(context.effectiveUserId, context.routingText, { domain: context.domain, orgId: context.orgId })}`;
  }
  context.systemPrompt += `\n\n${buildLumiOperatingKernelPrompt({ channel: 'chat', flow: context.turnFlow })}`;
  context.systemPrompt += '\n\nRemote continuity rule: prior assistant statements about installed tool counts, missing desktop access, or mode availability are conversational history, not runtime evidence. Use the current capability map, client state, scoped relay, and actual tool results as the source of truth.';
  context.systemPrompt += '\nRemote embodiment rule: WeChat, Feishu, and WeCom are transport channels into the same Lumi runtime. Do not claim that a remote channel inherently cannot reach the desktop. A no-client result for one data scope proves only that the scoped device route did not match; report that exact fact and check the personal/work scope before inferring that the desktop client is offline.';
  context.systemPrompt += '\nRemote memory rule: authenticated personal remote chat participates in the same personal memory system. Organization turns remain organization-scoped. Do not ask the user to repeat an explicit relationship or trust statement merely to make it memorable, and do not claim a memory was stored unless the memory pipeline accepted it.';
  context.systemPrompt += '\nExact file identity rule: a filename or path returned by a tool is an immutable identifier. Copy it character-for-character, including underscores, spaces, punctuation, extension, and parent directories. Never invent a size, timestamp, path, copy, upload, or send result; if the exact requested file is not in a receipt, say it was not verified.';
  context.systemPrompt += '\nRemote reply layout rule: make replies easy to scan in mobile chat. Use short paragraphs of 2-4 sentences separated by a blank line. For multiple points, use brief numbered labels or bullet lines. Do not send a dense wall of text.';
  if (context.explicitRemoteMemoryIds.length > 0) {
    context.systemPrompt += '\nCurrent-turn memory receipt: the explicit personal relationship/trust statement was accepted into durable personal memory. You may acknowledge that fact naturally; do not expose internal memory IDs.';
  }
  if (context.priorRuntimeEvidence) context.systemPrompt += `\n\n${context.priorRuntimeEvidence}`;
  if (context.pendingConfirmationPrompt) context.systemPrompt += `\n\n${context.pendingConfirmationPrompt}`;
  context.systemPrompt += `\n\n${buildResponseLanguageInstruction(context.requestText)}`;

  const userLLMPrefs = {
    ...getUserPreferredLLMConfig(context.effectiveUserId, { domain: context.domain, orgId: context.orgId, maxTokens: 4096, source: context.source }),
    inputTokenBudget: resolveModelRequestInputBudget(),
    signal: context.actionAbortController.signal,
  };
  const messages: NormalizedMessage[] = [
    { role: 'system', content: context.systemPrompt },
    ...context.conversationHistory.map(item => ({
      role: item.role === 'assistant' ? 'assistant' as const : 'user' as const,
      content: item.content,
    })),
    { role: 'user', content: [context.msg.text, context.pendingConfirmationPrompt].filter(Boolean).join('\n\n') },
  ];
  let pendingConfirmationCreatedThisTurn: Awaited<ReturnType<typeof recordPendingConfirmationDurably>> | null = null;
  const requestToolConfirmation = createTurnConfirmation({
    userId: context.effectiveUserId, source: context.source, requestId: context.requestId, actionIntent: context.requestText,
    pending: context.pendingConfirmation,
    consumeScope: () => context.confirmationScope,
    proposalScope: () => context.confirmationChannelScope
      ? { ...context.confirmationChannelScope, taskId: context.actionTaskExecution.state?.taskId } : undefined,
    correctionRequiresFreshConfirmation: context.correctionRequiresFreshConfirmation,
    assertCurrent: () => assertMessagingAuthorization(context.msg),
    isCancelled: context.actionWasCancelled,
    onPending: pending => {
      pendingConfirmationCreatedThisTurn = pending;
      if (context.conversation) setConversationActionExecutionStatus(context.conversation.id, context.effectiveUserId, 'waiting_confirmation', {
        assistantState: formatPendingConfirmationRequest(pending), requestId: context.requestId,
      });
    },
  });
  const settleRemoteTask = (fallbackBlocker?: string) => {
    // Every accepted turn owns a request lease, even without a task id.
    if (context.conversation) settleConversationActionExecutionRequest(context.conversation.id, context.effectiveUserId, context.requestId, fallbackBlocker);
  };
  const settleSupersededRemoteTurn = (reason: string) => {
    if (organizationWorkRoute) setOrganizationWorkItemExecutionStatus({
      orgId: context.orgId, workItemId: organizationWorkRoute.workItem.id, status: 'cancelled',
      actorUserId: context.effectiveUserId, execution: context.organizationWorkExecution, blocker: reason,
    });
    settleRemoteTask(reason);
  };

  const settleTransferredExecution = async (records: ToolExecutionRecord[]): Promise<boolean> => {
    if (!context.organizationWorkExecution || context.organizationWorkExecution.isCurrent()) return false;
    // Keep any terminal action evidence in its original conversation ledger,
    // while suppressing prose and completion claims from the former owner.
    if (records.length) {
      const evidenceMessage = persistBoundMessagingMessage(context.msg, 'assistant', '', undefined, records);
      removeSupersededAssistantMessage(evidenceMessage);
    }
    const blocker = 'Organization work was handed off; the previous execution has stopped.';
    if (context.conversation) setConversationActionExecutionStatus(context.conversation.id, context.effectiveUserId, 'blocked', { blocker, requestId: context.requestId });
    settleRemoteTask(blocker);
    await context.flushTerminalReply();
    return true;
  };
  let toolRecords: ToolExecutionRecord[] = [];
  const collectToolRecord = (record: ToolExecutionRecord) => {
    toolRecords = mergeToolExecutionRecords(toolRecords, [record]);
  };
  const observeToolRecord = (record: ToolExecutionRecord) => {
    context.receiptObserver?.onToolRecord(record);
    collectToolRecord(record);
  };

  const remoteToolContext = {
    userId: context.effectiveUserId,
    taskId: context.actionTaskExecution.state?.taskId,
    conversationId: context.conversation?.id,
    turnId: context.msg.messageId,
    turnRowId: context.actionTaskExecution.turnRowId,
    externalMessageId: context.msg.messageId,
    resolutionId: context.executionPlan.resolution.id,
    requestId: context.requestId,
    domain: context.domain,
    orgId: context.orgId,
    actionIntent: context.requestText,
    routedTaskText: context.routingText,
    supervisedExternalCommits: context.isIdentityBound,
    toolPolicy: context.modelToolPolicy,
    source: context.source,
    llmGetters: context.llm as any,
    desktopRelay: context.desktopRelay,
    personalDesktopRelay: context.personalDesktopRelay,
    desktopExecutionTracker,
    isCancelled: context.actionWasCancelled,
    executionSignal: context.actionAbortController.signal,
    onToolRecord: observeToolRecord,
    requestConfirmation: requestToolConfirmation,
  };
  return { terminal: undefined, context: extendTurnBindings(context, {
    get organizationWorkRoute(): typeof organizationWorkRoute { return organizationWorkRoute; },
    set organizationWorkRoute(value: typeof organizationWorkRoute) { organizationWorkRoute = value; },
    remoteToolContext: remoteToolContext as typeof remoteToolContext,
    collectToolRecord: collectToolRecord as typeof collectToolRecord,
    get pendingConfirmationCreatedThisTurn(): typeof pendingConfirmationCreatedThisTurn { return pendingConfirmationCreatedThisTurn; },
    set pendingConfirmationCreatedThisTurn(value: typeof pendingConfirmationCreatedThisTurn) { pendingConfirmationCreatedThisTurn = value; },
    taskAwareRecords: taskAwareRecords as typeof taskAwareRecords,
    get toolRecords(): typeof toolRecords { return toolRecords; },
    set toolRecords(value: typeof toolRecords) { toolRecords = value; },
    desktopExecutionTracker: desktopExecutionTracker as typeof desktopExecutionTracker,
    settleRemoteTask: settleRemoteTask as typeof settleRemoteTask,
    userLLMPrefs: userLLMPrefs as typeof userLLMPrefs,
    messages: messages as typeof messages,
    settleTransferredExecution: settleTransferredExecution as typeof settleTransferredExecution,
    settleSupersededRemoteTurn: settleSupersededRemoteTurn as typeof settleSupersededRemoteTurn,
  }) };
}
type MessagingModelContext = NonNullable<Awaited<ReturnType<typeof prepareMessagingExecution>>["context"]>;

async function executeMessagingModelTurn(context: MessagingModelContext): Promise<string> {


  try {
    const usageInteractionId = `messaging_${context.msg.platform}_${Date.now()}`;
    let responseText = '';
    let callbackReply: Awaited<ReturnType<MessageHandler>> | null = null;
    const callbackBlockedForExternalCommit = Boolean(
      context.options?.onMessage && context.organizationWorkRoute?.workItem.sideEffectClass === 'external_commit',
    );
    // The legacy handler returns only prose and cannot produce a canonical tool
    // envelope. Never let it execute an external commit; those actions must go
    // through the receipt-producing tool route and its exact confirmation gate.
    if (context.options?.onMessage && !callbackBlockedForExternalCommit) {
      assertMessagingAuthorization(context.msg);
      context.organizationWorkExecution?.assertCurrent();
      callbackReply = await context.options.onMessage(context.msg);
      context.throwIfActionLeaseWasLost();
    }
    let deterministicEntryReply: string | null = callbackReply?.text
      || (isRetiredOperationModeRequest(context.requestText) ? buildOperationModeMetaResponse({ text: context.requestText, operationMode: context.operationMode }) : null)
      || (callbackBlockedForExternalCommit
        ? (/[㐀-鿿]/u.test(context.routingText)
          ? '外部提交已停止：旧消息回调不能生成统一工具回执，请改由受确认和回执约束的工具执行。'
          : 'The external commit was stopped because the legacy message callback cannot produce a canonical tool receipt. Use the confirmed tool route instead.')
        : null);
    if (deterministicEntryReply) responseText = deterministicEntryReply;

    if (context.isIdentityBound && context.directlyAppliedMode && !deterministicEntryReply) {
      const modeRecord = await executeToolCall({
        registry: toolRegistry,
        id: `${context.requestId}:client-mode`,
        name: 'client_action',
        arguments: {
          action: 'start_meeting_mode',
          mode: context.directlyAppliedMode,
          // Confirmation authority comes from ToolContext/requestConfirmation,
          // never from a model- or route-authored boolean argument.
          confirmed: false,
        },
        context: context.remoteToolContext,
      });
      context.throwIfActionLeaseWasLost();
      context.collectToolRecord(modeRecord);
      const modeSynced = toolRecordSucceeded(modeRecord);
      if (modeSynced) saveStoredOperationMode(context.effectiveUserId, context.directlyAppliedMode);

      const candidate = context.pendingConfirmationCreatedThisTurn
        ? formatPendingConfirmationRequest(context.pendingConfirmationCreatedThisTurn)
        : formatOperationModeSwitchResponse(context.directlyAppliedMode, modeSynced, context.requestText);
      const modeOutbound = await finalizeMessagingResponseForDelivery({
        taskText: context.routingText,
        responseText: candidate,
        toolRecords: context.taskAwareRecords(context.toolRecords),
        source: context.source,
        flow: context.turnFlow,
        taskId: context.actionTaskExecution.state?.taskId,
        requestId: context.requestId,
        pendingConfirmation: Boolean(context.pendingConfirmationCreatedThisTurn),
        isPendingConfirmation: () => Boolean(context.pendingConfirmationCreatedThisTurn),
      });
      const finalizedMode = modeOutbound.finalization;
      context.toolRecords = withCurrentMessagingDesktopExecutionReceipt(
        modeOutbound.toolRecords,
        context.desktopExecutionTracker,
        context.actionTaskExecution.state?.taskId,
        context.requestId,
      );
      return await context.commitReply(finalizedMode.text, {
        toolCalls: context.toolRecords,
        beforeFlush: superseded => {
          if (superseded) {
            context.settleRemoteTask('The remote turn was superseded by a newer user message.');
            return;
          }
          if (context.pendingConfirmationCreatedThisTurn && context.conversation) {
            setConversationActionExecutionStatus(context.conversation.id, context.effectiveUserId, 'waiting_confirmation', {
              assistantState: formatPendingConfirmationRequest(context.pendingConfirmationCreatedThisTurn), requestId: context.requestId,
            });
          }
          context.settleRemoteTask();
        },
      });
    }

    if (!deterministicEntryReply && context.isOrganizationBound) {
      assertMessagingAuthorization(context.msg);
      deterministicEntryReply = await handleRemoteLegalNoticeIntake(context.msg, {
        isCancelled: context.actionWasCancelled,
        executionSignal: context.actionAbortController.signal,
      });
      assertMessagingAuthorization(context.msg);
      if (!deterministicEntryReply) {
        context.organizationWorkExecution?.assertCurrent();
        deterministicEntryReply = await handleRemoteOrgCommand(context.msg, () => context.organizationWorkExecution?.assertCurrent());
      }
      if (deterministicEntryReply) {
        responseText = deterministicEntryReply;
        context.toolRecords.push({
          id: `${context.requestId}:organization-command`,
          taskId: context.actionTaskExecution.state?.taskId,
          turnId: context.msg.messageId,
          turnRowId: context.actionTaskExecution.turnRowId,
          externalMessageId: context.msg.messageId,
          resolutionId: context.executionPlan.resolution.id,
          requestId: context.requestId,
          idempotencyKey: `${context.organizationWorkRoute?.workItem.id || context.requestId}:organization-command`,
          name: 'organization_business_command',
          arguments: {
            source: context.source,
            requestId: context.requestId,
            workItemId: context.organizationWorkRoute?.workItem.id || '',
          },
          result: JSON.stringify({
            ok: true,
            verified: true,
            status: 'completed',
            verificationMethod: 'organization-server-transaction',
            workItemId: context.organizationWorkRoute?.workItem.id || '',
          }),
          terminalVerification: {
            status: 'verified',
            strategy: 'terminal_receipt',
            reason: 'The organization server transaction returned a verified local receipt.',
          },
          envelope: {
            version: 1,
            status: 'verified_success',
            toolName: 'organization_business_command',
            resolutionId: context.executionPlan.resolution.id,
            taskId: context.actionTaskExecution.state?.taskId || '',
            turnId: context.msg.messageId,
            turnRowId: context.actionTaskExecution.turnRowId,
            externalMessageId: context.msg.messageId,
            requestId: context.requestId,
            idempotencyKey: `${context.organizationWorkRoute?.workItem.id || context.requestId}:organization-command`,
            targetIdentity: context.orgId,
            completedAt: new Date().toISOString(),
            result: {
              workItemId: context.organizationWorkRoute?.workItem.id || '',
              verificationMethod: 'organization-server-transaction',
            },
            verification: {
              status: 'verified',
              reason: 'The organization server transaction returned a verified local receipt.',
            },
          },
        });
      }
    }
    if (deterministicEntryReply && !responseText) responseText = deterministicEntryReply;

    const entryHandled = Boolean(deterministicEntryReply);
    const runMessagingToolTurn = (
      turnMessages: NormalizedMessage[],
      onToolRecord?: (record: ToolExecutionRecord) => void,
      executionSource = context.source,
    ) => runToolSession({
      messages: turnMessages,
      registry: toolRegistry,
      config: context.userLLMPrefs,
      onToolCall: record => { context.collectToolRecord(record); onToolRecord?.(record); },
      maxIterations: context.modelToolPolicy.maxIterations || context.executionDecision.maxIterations,
      context: { ...context.remoteToolContext, source: executionSource, modelToolProjection: context.modelToolProjection },
      getters: context.llm,
    });

    if (!entryHandled && !context.toolSessionActive) {
      assertMessagingAuthorization(context.msg);
      const response = await makeLLMCall(
        context.messages,
        [],
        context.userLLMPrefs,
        ...providerGetterArguments(context.llm ?? {}, "primary"),
      );
      responseText = response.text || '';
      if (response.usage) {
        recordTokenUsage(context.effectiveUserId, context.userLLMPrefs.provider, context.userLLMPrefs.model, response.usage, usageInteractionId, 'chat');
      }
    } else if (!entryHandled) {
      const result = await runMessagingToolTurn(context.messages);
      responseText = result.text || '';
      context.toolRecords = mergeToolExecutionRecords(context.toolRecords, result.toolCalls || []);
      recordTokenUsageBatch(context.effectiveUserId, result.usageRecords || [], usageInteractionId, 'chat');
    }

    context.toolRecords = withCurrentMessagingDesktopExecutionReceipt(
      context.toolRecords,
      context.desktopExecutionTracker,
      context.actionTaskExecution.state?.taskId,
      context.requestId,
    );
    if (context.pendingConfirmationCreatedThisTurn) {
      responseText = formatPendingConfirmationRequest(context.pendingConfirmationCreatedThisTurn);
    }
    const deliveryText = responseText || '这次没有生成可用回复，请稍后重试。';
    const preDeliveryRecords = currentMessagingFinalizationRecords({
      toolRecords: context.taskAwareRecords(context.toolRecords),
      taskId: context.actionTaskExecution.state?.taskId,
      requestId: context.requestId,
    });
    const organizationVerifiedTerminalReceipt = preDeliveryRecords.some(record => {
      const verified = record.envelope?.status === 'verified_success'
        || record.terminalVerification?.status === 'verified';
      if (!verified) return false;
      if (context.organizationWorkRoute?.workItem.sideEffectClass !== 'external_commit') return true;
      return Boolean(record.capability?.sideEffects?.some(effect => (
        effect.type === 'external_communication' || effect.type === 'external_state_change'
      ))) || /(?:send|submit|publish|post|comment|reply|payment|purchase|sign)/i.test(record.name);
    });
    const missingOrganizationExternalCommitReceipt = context.organizationWorkRoute?.workItem.sideEffectClass === 'external_commit'
      && !context.pendingConfirmationCreatedThisTurn
      && !organizationVerifiedTerminalReceipt;
    const initialFinalization: MessagingFinalization = callbackReply
      && context.organizationWorkRoute?.workItem.sideEffectClass !== 'external_commit'
      ? { text: responseText || callbackReply.text, blocked: false }
      : missingOrganizationExternalCommitReceipt
        ? {
        text: /[\u3400-\u9fff]/u.test(context.routingText)
          ? '这次外部提交还没有完成：没有收到可验证的终态回执，Lumi 已停止，且不会盲目重试。'
          : 'The external commit is not complete: no verified terminal receipt was received, so Lumi stopped and will not retry blindly.',
        blocked: true,
        reason: 'The external commit has no verified terminal receipt.',
          }
        : finalizeLumiResponse({
            taskText: context.routingText,
            responseText: deliveryText,
            toolRecords: preDeliveryRecords,
            source: context.source,
            flow: context.turnFlow,
            taskId: context.actionTaskExecution.state?.taskId,
            requestId: context.requestId,
          });
    const outbound = await finalizeMessagingResponseForDelivery({
      taskText: context.routingText,
      responseText: deliveryText,
      toolRecords: preDeliveryRecords,
      source: context.source,
      flow: context.turnFlow,
      taskId: context.actionTaskExecution.state?.taskId,
      requestId: context.requestId,
      initialFinalization,
      allowToolUse: context.toolSessionActive
        && !callbackReply
        && !entryHandled
        && !missingOrganizationExternalCommitReceipt,
      pendingConfirmation: Boolean(context.pendingConfirmationCreatedThisTurn),
      aborted: context.actionWasCancelled(),
      isPendingConfirmation: () => Boolean(context.pendingConfirmationCreatedThisTurn),
      isAborted: context.actionWasCancelled,
      attempt: async ({ instruction, recordTool }) => {
        const recovery = await runMessagingToolTurn(
          [
            ...context.messages,
            ...(deliveryText.trim()
              ? [{ role: 'assistant' as const, content: deliveryText }]
              : []),
            { role: 'user', content: instruction },
          ],
          recordTool,
          `${context.source}_guard_recovery`,
        );
        recordTokenUsageBatch(context.effectiveUserId, recovery.usageRecords || [], usageInteractionId, 'chat');
        return {
          text: recovery.text,
          toolRecords: withCurrentMessagingDesktopExecutionReceipt(
            recovery.toolCalls || [],
            context.desktopExecutionTracker,
            context.actionTaskExecution.state?.taskId,
            context.requestId,
          ),
        };
      },
      refinalize: (candidateText, records) => context.pendingConfirmationCreatedThisTurn
        ? {
            text: formatPendingConfirmationRequest(context.pendingConfirmationCreatedThisTurn),
            blocked: false,
            reason: 'waiting_confirmation',
          }
        : finalizeLumiResponse({
            taskText: context.routingText,
            responseText: candidateText,
            toolRecords: currentMessagingFinalizationRecords({
              toolRecords: withCurrentMessagingDesktopExecutionReceipt(
                records,
                context.desktopExecutionTracker,
                context.actionTaskExecution.state?.taskId,
                context.requestId,
              ),
              taskId: context.actionTaskExecution.state?.taskId,
              requestId: context.requestId,
            }),
            source: `${context.source}_guard_recovery`,
            flow: context.turnFlow,
            taskId: context.actionTaskExecution.state?.taskId,
            requestId: context.requestId,
          }),
    });
    context.toolRecords = withCurrentMessagingDesktopExecutionReceipt(
      outbound.toolRecords,
      context.desktopExecutionTracker,
      context.actionTaskExecution.state?.taskId,
      context.requestId,
    );
    const finalized = outbound.finalization;
    if (context.actionLeaseWasLost()) {
      await context.actionLeaseHeartbeat!.leaseLoss;
      return CN_TASK_EXECUTION_MESSAGES.persistenceUnknown;
    }
    if (await context.settleTransferredExecution(context.toolRecords)) return '';
    context.organizationWorkExecution?.assertCurrent();
    const committedText = await context.commitReply(finalized.text, {
      toolCalls: context.toolRecords,
      beforeFlush: superseded => {
        if (superseded) {
          context.settleSupersededRemoteTurn('The remote turn was superseded by a newer user message.');
          return;
        }
        if (context.pendingConfirmationCreatedThisTurn && context.conversation) {
          setConversationActionExecutionStatus(context.conversation.id, context.effectiveUserId, 'waiting_confirmation', {
            assistantState: formatPendingConfirmationRequest(context.pendingConfirmationCreatedThisTurn),
            requestId: context.requestId,
          });
        }
        if (context.organizationWorkRoute) {
          const organizationStatus = context.pendingConfirmationCreatedThisTurn || finalized.blocked || missingOrganizationExternalCommitReceipt
            ? 'blocked'
            : 'completed';
          const organizationBlocker = context.pendingConfirmationCreatedThisTurn
            ? 'The user action confirmation is still pending.'
            : missingOrganizationExternalCommitReceipt
              ? 'The external commit has no verified terminal receipt.'
              : finalized.reason;
          setOrganizationWorkItemExecutionStatus({
            orgId: context.orgId,
            workItemId: context.organizationWorkRoute.workItem.id,
            status: organizationStatus,
            actorUserId: context.effectiveUserId,
            execution: context.organizationWorkExecution,
            blocker: organizationBlocker,
          });
          if (organizationStatus === 'blocked' && context.conversation) {
            setConversationActionExecutionStatus(context.conversation.id, context.effectiveUserId, 'blocked', {
              blocker: organizationBlocker,
              requestId: context.requestId,
            });
          }
        }
        context.settleRemoteTask();
      },
    });
    if (!committedText) return '';
    // Native organization commands already have a deterministic server
    // transaction and a task-bound terminal receipt. Running the generic
    // post-turn extractor here would invoke a model after the command has
    // completed, making a model outage look like part of the task and
    // needlessly competing with receipt persistence. Learned state for these
    // commands comes from the authoritative organization transaction instead.
    if (!entryHandled) {
      try {
        void persistRemotePostTurnLearning({
          message: context.msg,
          responseText: committedText,
          isCancelled: context.actionWasCancelled,
          llmGetters: context.llm,
          modelConfig: {
            provider: context.userLLMPrefs.provider,
            model: context.userLLMPrefs.model,
          },
        });
      } catch (learningError: any) {
        console.warn('[Messaging] Remote post-turn memory extraction could not be scheduled:', learningError?.message || learningError);
      }
    }
    return committedText;
  } catch (err: any) {
    if (!isMessagingAuthorizationCurrent(context.msg)) {
      context.settleRemoteTask('The remote message authorization was revoked or replaced.');
      await context.flushTerminalReply();
      throw new MessagingAuthorizationRevokedError();
    }
    if (context.actionLeaseWasLost()) {
      await context.actionLeaseHeartbeat!.leaseLoss;
      return CN_TASK_EXECUTION_MESSAGES.persistenceUnknown;
    }
    if (isMessagingReplyDurabilityError(err)) throw err;
    if (await context.settleTransferredExecution(context.toolRecords)) return '';
    console.warn(`[Messaging] ${context.msg.platform} model pipeline failed:`, err?.message || err);
    const fallback = context.toolRecords.length
      ? '当前语言模型暂时不可用，后续处理没有完成。本次已有的执行记录已保留，请稍后继续。'
      : '当前语言模型暂时不可用，这次处理没有完成，请稍后再试。';
    // The assistant write closes this request with an explicit blocked outcome;
    // never recompute completion from an earlier successful substep afterward.
    return await context.commitReply(fallback, {
      toolCalls: context.toolRecords,
      terminalTaskDisposition: context.actionTaskExecution.state?.taskId ? {
        outcome: 'blocked', taskId: context.actionTaskExecution.state.taskId, requestId: context.requestId, reason: fallback,
      } : undefined,
      beforeFlush: superseded => {
        if (superseded) {
          context.settleSupersededRemoteTurn('The remote turn failed after it was superseded by a newer user message.');
          return;
        }
        if (context.organizationWorkRoute) setOrganizationWorkItemExecutionStatus({
          orgId: context.orgId, workItemId: context.organizationWorkRoute.workItem.id, status: 'blocked',
          actorUserId: context.effectiveUserId, execution: context.organizationWorkExecution,
          blocker: err?.message || 'The remote model/tool pipeline failed before a terminal receipt was recorded.',
        });
      },
    });
  }
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


export function createWeComRoutes(
  config: WeComConfig,
  options?: MessagingRouteOptions,
): Router {
  const router = Router();
  const adapter = new WeComAdapter(config);
  recoverQueuedMessagingInputs('wecom', {
    enrich: message => enrichWeComAttachments(message, adapter),
    reply: async (message, text) => { await adapter.sendMessage(message.chatId, { text, platform: 'wecom' }); },
  }, options);

  // ── GET /wecom/events — URL verification ──
  router.get('/wecom/events', (req, res) => {
    try {
      // Use req.query but re-encode + in values that Express decoded to spaces
      const fix = (v: string) => (v || '').replace(/ /g, '+');
      const msg_signature = req.query.msg_signature as string || '';
      const timestamp = req.query.timestamp as string || '';
      const nonce = req.query.nonce as string || '';
      const echostr = req.query.echostr as string || '';

      if (!echostr) return res.status(400).send('Missing echostr');

      console.log('[WeCom] URL verification request received');

      // echostr may have + that Express turned into space
      const plaintext = adapter.verifyUrl(fix(echostr), { msg_signature, timestamp, nonce });
      console.log('[WeCom] URL verified OK — returning plaintext');
      res.type('text/plain').send(plaintext);
    } catch (err: any) {
      console.error('[WeCom] URL verify FAILED:', err.message);
      res.status(403).send('Verification failed');
    }
  });

  // ── POST /wecom/events — receive messages ──
  router.post('/wecom/events', async (req, res) => {
    try {
      const rawBody = (req as any).rawBody || '';
      const q = req.query as Record<string, string>;
      const msg_signature = (q.msg_signature || '').replace(/ /g, '+');
      const timestamp = (q.timestamp || '').replace(/ /g, '+');
      const nonce = (q.nonce || '').replace(/ /g, '+');

      // Decrypt: WeChat Work POST body is always encrypted XML
      let decryptedXml = rawBody;
      const encryptMatch = rawBody.match(/<Encrypt><!\[CDATA\[([\s\S]*?)\]\]><\/Encrypt>/);
      if (!encryptMatch) {
        return res.status(403).send('encrypted callback required');
      }
      const echostr = encryptMatch[1];
      if (!msg_signature || !timestamp || !nonce || !adapter.verifyWebhook({ msg_signature, timestamp, nonce, echostr })) {
        console.log('[WeCom] POST signature verification failed');
        return res.status(403).send('signature mismatch');
      }
      try {
        decryptedXml = (adapter as any).decrypt(echostr);
      } catch (err: any) {
        console.error('[WeCom] Decrypt failed:', err.message);
        return res.status(403).send('decrypt failed');
      }

      const msg = adapter.parseEvent({ rawBody: decryptedXml });
      if (!msg) {
        console.log('[WeCom] parseEvent returned null — msgType may not be text, or XML parse failed');
        return res.send('success');
      }

      console.log(`[WeCom] Received ${msg.chatType} message ${msg.messageId}`);

      dispatchIncomingMessage(msg, {
        enrich: message => enrichWeComAttachments(message, adapter),
        reply: async (message, text) => {
          await adapter.sendMessage(message.chatId, { text, platform: 'wecom' });
        },
      }, options);
      res.type('text/plain').send('success');
    } catch (err: any) {
      console.error('[WeCom] Event error:', err.message);
      if (!res.headersSent) {
        res.status(500).send('error');
      }
    }
  });

  // ── POST /wecom/send — manual send ──
  router.post('/wecom/send', requireAuth, async (req, res) => {
    try {
      if (!requireMessagingAdmin(req, res)) return;
      const { userId, text } = req.body;
      if (!userId) return res.status(400).json({ error: 'userId required' });
      if (!text) return res.status(400).json({ error: 'text required' });
      const messageId = config.mode === 'aibot_long_connection' && options?.sendProactive
        ? await options.sendProactive('wecom', userId, text)
        : await adapter.sendMessage(userId, { text, platform: 'wecom' });
      res.json({ success: true, messageId });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── GET /wecom/status ──
  router.get('/wecom/status', requireAuth, (_req, res) => {
    const current = getMessagingConfig().wecom;
    res.json({
      platform: 'wecom',
      configured: current.enabled,
      mode: current.mode,
      connection: options?.getConnectionStatus?.('wecom') || null,
      corpId: current.corpId ? `${current.corpId.slice(0, 8)}...` : null,
      botId: current.botId ? `${current.botId.slice(0, 8)}...` : null,
      agentId: current.agentId || null,
    });
  });

  // ── GET /wecom/config ──
  router.get('/wecom/config', requireAuth, (req, res) => {
    if (!requireMessagingAdmin(req, res)) return;
    const current = getMessagingConfig().wecom;
    res.json({
      mode: current.mode,
      botId: current.botId || '',
      botIdMasked: current.botId ? `${current.botId.slice(0, 8)}...` : '',
      hasBotSecret: !!current.botSecret,
      corpId: current.corpId,
      corpIdMasked: current.corpId ? `${current.corpId.slice(0, 8)}...` : '',
      agentId: current.agentId,
      hasSecret: !!current.appSecret,
      hasToken: !!current.token,
      hasAesKey: !!current.encodingAESKey,
      connection: options?.getConnectionStatus?.('wecom') || null,
      enabled: current.enabled,
    });
  });

  // ── POST /wecom/config ──
  router.post('/wecom/config', requireAuth, async (req, res) => {
    try {
      if (!requireMessagingAdmin(req, res)) return;
      const { mode, botId, botSecret, corpId, agentId, appSecret, token, encodingAESKey } = req.body;
      const updated = updateMessagingConfig({
        wecom: { mode, botId, botSecret, corpId, agentId, appSecret, token, encodingAESKey },
      });
      Object.assign(config, updated.wecom);
      adapter.reload(config);
      await options?.onConfigChanged?.();
      res.json({
        success: true,
        configured: updated.wecom.enabled,
        mode: updated.wecom.mode,
        connection: options?.getConnectionStatus?.('wecom') || null,
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  router.post('/wecom/bindings/code', requireAuth, (req, res) => {
    try {
      const code = createBindingCode('wecom', req.user!.uid, bindingOrgId(req));
      res.json({
        code: code.code,
        expiresAt: code.expiresAt,
        instruction: `在企业微信 Lumi 应用里发送：绑定 Lumi ${code.code}`,
      });
    } catch (err: any) {
      res.status(400).json({ error: err?.message || 'Failed to create binding code' });
    }
  });

  router.get('/wecom/bindings', requireAuth, (req, res) => {
    const orgId = String(req.user?.orgId || '').trim();
    res.json({ bindings: listBindingsForUser(req.user!.uid).filter(item =>
      item.platform === 'wecom' && (!orgId || item.orgId === orgId)
    ) });
  });

  router.delete('/wecom/bindings/:bindingId', requireAuth, (req, res) => {
    const ok = deleteBindingForUser(req.user!.uid, req.params.bindingId, req.user?.orgId || undefined);
    res.json({ success: ok });
  });

  return router;
}
export { MessagingReplyDurabilityError, finalizeMessagingResponseForDelivery, type MessagingRouteOptions, type MessagingConversationUpdate, type IncomingMessageTransport, buildRemoteRuntimeEvidenceContext } from "./messaging_finalization";
export { persistBoundMessagingExchange, persistBoundMessagingMessage } from "./messaging_persistence";
export { type RemoteCaseAttachmentWriteIntent, classifyRemoteCaseAttachmentWriteIntent, handleRemoteOrgCommand } from "./remote_org_commands";
export { messagingConversationAgentId, getRequestText, buildRemoteTurnIntentText, enrichMessagingAttachments, enrichFeishuAttachments, enrichWeComAttachments } from "./remote_materials";
export { stopMessagingIngressAndDrain, correlateMessagingReply, formatRemoteReplyForReadability, enqueueMessageRoute } from "./messaging_ingress_runtime";
