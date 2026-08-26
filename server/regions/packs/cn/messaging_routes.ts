/**
 * Feishu Messaging Routes — webhook receiver + send endpoints.
 *
 * Feishu Event Subscription flow:
 *   1. POST /api/feishu/events — receives all subscribed events
 *   2. URL verification: Feishu sends { type: "url_verification", challenge: "..." }
 *      → respond with { challenge: "..." } within 1 second
 *   3. Message events: parse → process via LLM with Lumi personality → reply
 */
import { Router } from 'express';
import fs from 'fs';
import path from 'path';
import { FeishuAdapter, isMessagingDeliveryUnknownError } from '../../../messaging/feishu';
import type { FeishuConfig } from '../../../messaging/feishu';
import type { IncomingAttachment, IncomingMessage, MessageHandler } from '../../../messaging/types';
import { getMessagingConfig, updateMessagingConfig } from '../../../messaging/config';
import {
  commitBindingCodeConsumption,
  createBindingCode,
  deleteBindingForUser,
  getBinding,
  authorizeMessagingGroup,
  listMessagingGroupAuthorizations,
  revokeMessagingGroupAuthorization,
  listBindingsForUser,
  parseMessagingBindingCommand,
  planBindingCodeConsumption,
  rollbackBindingCodeConsumption,
  type BindingCodeConsumptionPlan,
  type MessagingPlatformId,
} from '../../../messaging/bindings';
import { evaluateMessagingIngress } from '../../../messaging/ingress_policy';
import { flushDBOrThrow, readDB } from '../../../../db_layer';
import { requireAuth } from '../../../middleware/auth';
import { getDataPath } from '../../../config/data_path';
import { parseDocument } from '../../../legal/parser';
import { getMember } from '../../../org/db';
import {
  bindOrganizationWorkItemTask,
  routeOrganizationWork,
  setOrganizationWorkItemExecutionStatus,
  type RouteOrganizationWorkResult,
} from '../../../org/work_routing';
import * as OrgKB from '../../../org/kb';
import * as LegalCases from '../../../org/legal_cases';
import { handleRemoteLegalNoticeIntake } from './legal_notice_intake';
import { getUserPreferredLLMConfig } from '../../../llm/user_preferences';
import {
  addMessageIdempotent,
  getConversationActionStatus,
  getConversationModelExecutionRecovery,
  getMessagesByTokenBudget,
  getMessagesThroughExternalMessage,
  getOrCreateActiveConversation,
  persistConversationExecutionPlan,
  persistConversationModelExecutionResult,
  prepareConversationActionExecution,
  settleConversationActionExecutionRequest,
  setConversationActionExecutionStatus,
  startConversationActionExecutionHeartbeat,
} from '../../../conversation/manager';
import { CN_TASK_EXECUTION_MESSAGES } from './voice_fast_path_messages';
import { acceptMessageOnce, completeMessageDelivery, releaseMessageDelivery } from '../../../messaging/delivery_ledger';
import {
  getMessagingJournalEntry,
  recordMessagingIngress,
  updateMessagingJournal,
} from '../../../messaging/message_journal';
import { applyRemoteAttachmentContext } from '../../../messaging/attachment_context';
import { runWithTools } from '../../../llm/adapter';
import { makeLLMCall, type NormalizedMessage } from '../../../llm/providers';
import { resolveModelRequestInputBudget } from '../../../llm/request_context_budget';
import { toolRegistry } from '../../../tools/registry';
import { executeToolCall } from '../../../tools/execution_engine';
import type { ToolExecutionRecord } from '../../../tools/types';
import { buildUnifiedLegalEntryPrompt } from '../../../cognition/legal_entry';
import { finalizeLumiResponse } from '../../../cognition/result_finalizer';
import {
  finalizeExecutionForOutboundDelivery,
  type ExecutionGuardRecoveryRunInput,
} from '../../../cognition/execution_guard_recovery';
import { recordTokenUsage } from '../../../llm/token_tracker';
import type { ToolPolicy } from '../../../personality/types';
import {
  commitPersonalOrganizationScopePlan,
  planPersonalOrganizationScope,
  requestsOrganizationScope,
} from '../../../messaging/personal_org_scope';
import { buildLumiTurnDispatch, type LumiTurnDispatch } from '../../../cognition/turn_dispatch';
import { buildLumiExecutionPipeline, type LumiExecutionPipeline } from '../../../cognition/execution_pipeline';
import {
  buildModelCapabilityPolicy,
  buildModelToolProjection,
} from '../../../cognition/capability_selection';
import { buildLumiRuntimeCapabilityContext } from '../../../cognition/capability_context';
import { buildInteractionModeOverlay } from '../../../cognition/turn_flow';
import type { LumiTurnFlow } from '../../../cognition/turn_flow';
import { bindCapabilityExecutionPlanTask } from '../../../cognition/capability_execution_plan';
import { buildDesktopExecutionStabilityPolicy } from '../../../cognition/desktop_execution_stability';
import { createDesktopExecutionTracker, withDesktopExecutionReceipt } from '../../../desktop/execution_runtime';
import { buildLumiOperatingKernelPrompt } from '../../../cognition/operating_kernel';
import { getStoredOperationMode, saveStoredOperationMode } from '../../../cognition/operation_mode_store';
import { isPureOperationModeSwitchRequest, type OperationMode } from '../../../cognition/operation_modes';
import { formatOperationModeSwitchResponse } from '../../../i18n/operation_mode_messages';
import { formatClientSelfPromptForTurn } from '../../../client/self_model';
import { buildResponseLanguageInstruction } from '../../../utils/language';
import { canAutoApproveAction } from '../../../tools/action_constitution';
import {
  classifyComplexity,
  isTerminalOrchestrationToolEvent,
  runOrchestratedTask,
  shouldAttemptOrchestration,
} from '../../../agents/orchestrator';
import { classifyConversationActionFollowupIntent } from '../../../cognition/action_continuation';
import { coalesceToolExecutionRecords, taskReceiptsToRecords } from '../../../cognition/task_execution_ledger';
import {
  persistExplicitRemoteRelationshipMemories,
  persistRemotePostTurnLearning,
} from './remote_memory';
import {
  buildTransportNeutralConfirmationScope,
  consumePendingConfirmationDurably,
  formatPendingConfirmationRequest,
  recordPendingConfirmationDurably,
} from '../../../tools/pending_confirmation';
import { ensurePendingConfirmationPersistenceInitialized } from '../../../tools/pending_confirmation_repository';
import {
  admitAcceptedUserTurnDurably,
  resolveAcceptedTurnConfirmation,
  type AcceptedUserTurnAdmission,
} from '../../../socket/action_turn_durability';
import {
  buildPendingAssistantOfferContextFromTranscript,
  type PendingAssistantOfferContext,
} from '../../../cognition/pending_assistant_offer';

const messageRouteQueues = new Map<string, Promise<void>>();
const bindingCodeQueues = new Map<string, Promise<unknown>>();
const messageRouteActivity = new Map<string, {
  latestSequence: number;
  latestMessageId: string;
  latestText: string;
  updatedAt: number;
}>();
const MAX_MESSAGING_ATTACHMENT_BYTES = 25 * 1024 * 1024;
const MESSAGE_ACTIVITY_TTL_MS = 24 * 60 * 60 * 1000;

export class MessagingReplyDurabilityError extends Error {
  readonly stage: 'accepted_turn' | 'terminal_reply';

  constructor(stage: 'accepted_turn' | 'terminal_reply', cause: unknown) {
    super(`Remote messaging ${stage} durability fence failed`, { cause });
    this.name = 'MessagingReplyDurabilityError';
    this.stage = stage;
  }
}

function isMessagingReplyDurabilityError(error: unknown): error is MessagingReplyDurabilityError {
  return error instanceof MessagingReplyDurabilityError;
}

async function flushMessagingStateOrThrow(
  stage: 'accepted_turn' | 'terminal_reply',
): Promise<void> {
  try {
    await flushDBOrThrow();
  } catch (error) {
    throw new MessagingReplyDurabilityError(stage, error);
  }
}

type MessagingFinalization = ReturnType<typeof finalizeLumiResponse>;

async function finalizeMessagingResponseForDelivery(input: {
  taskText: string;
  responseText: string;
  toolRecords: ToolExecutionRecord[];
  source: string;
  flow?: LumiTurnFlow;
  initialFinalization?: MessagingFinalization;
  allowToolUse?: boolean;
  pendingConfirmation?: boolean;
  aborted?: boolean;
  isPendingConfirmation?: () => boolean;
  isAborted?: () => boolean;
  attempt?: ExecutionGuardRecoveryRunInput<MessagingFinalization>['attempt'];
  refinalize?: ExecutionGuardRecoveryRunInput<MessagingFinalization>['finalize'];
}) {
  const finalization = input.initialFinalization || finalizeLumiResponse({
    taskText: input.taskText,
    responseText: input.responseText,
    toolRecords: input.toolRecords,
    source: input.source,
    flow: input.flow,
  });
  return finalizeExecutionForOutboundDelivery({
    task: input.taskText,
    responseText: input.responseText,
    finalization,
    allowToolUse: input.allowToolUse === true,
    pendingConfirmation: input.pendingConfirmation,
    aborted: input.aborted,
    isPendingConfirmation: input.isPendingConfirmation,
    isAborted: input.isAborted,
    toolRecords: input.toolRecords,
    attempt: input.attempt,
    finalize: input.refinalize || ((candidateText, records) => finalizeLumiResponse({
        taskText: input.taskText,
        responseText: candidateText,
        toolRecords: records,
        source: `${input.source}_guard_recovery`,
        flow: input.flow,
      })),
  });
}

export interface MessagingRouteOptions {
  onMessage?: MessageHandler;
  llmGetters?: Record<string, () => any>;
  personalityRegistry?: any;
  queryMemories?: (opts: { userId: string; query: string; limit: number; minConfidence: number; domain?: string; orgId?: string }) => any[];
  loadEmotionalState?: (userId: string) => any;
  onConfigChanged?: () => void | Promise<void>;
  getConnectionStatus?: (platform: 'feishu' | 'wecom') => Record<string, any> | null;
  sendProactive?: (platform: 'feishu' | 'wecom', chatId: string, text: string) => Promise<string>;
  onConversationUpdated?: (update: MessagingConversationUpdate) => void;
  createScopedDesktopRelay?: (
    userId: string,
    source: string,
    domain: 'personal' | 'work',
    orgId: string,
  ) => (toolName: string, args: Record<string, any>) => Promise<string>;
  createPersonalDesktopRelay?: (userId: string, source: string) => (toolName: string, args: Record<string, any>) => Promise<string>;
}

export interface MessagingConversationUpdate {
  userId: string;
  domain: 'personal' | 'work';
  orgId: string;
  conversationId: string;
  agentId: string;
  source: string;
  messageId: string;
}

export interface IncomingMessageTransport {
  enrich: (message: IncomingMessage) => Promise<IncomingMessage>;
  reply: (message: IncomingMessage, text: string) => Promise<string | void>;
}

function visibleMessageRouteKey(message: IncomingMessage): string {
  return [
    message.platform,
    message.userId,
    message.chatType,
    message.chatId,
    message.threadId || 'main',
  ].join(':');
}

function registerMessageRouteActivity(message: IncomingMessage): IncomingMessage {
  const currentTime = Date.now();
  for (const [key, activity] of messageRouteActivity) {
    if (currentTime - activity.updatedAt > MESSAGE_ACTIVITY_TTL_MS) messageRouteActivity.delete(key);
  }
  const key = visibleMessageRouteKey(message);
  const previous = messageRouteActivity.get(key);
  const routeSequence = (previous?.latestSequence || 0) + 1;
  const tracked = {
    ...message,
    receivedAt: message.receivedAt || new Date(currentTime).toISOString(),
    routeSequence,
  };
  messageRouteActivity.set(key, {
    latestSequence: routeSequence,
    latestMessageId: tracked.messageId,
    latestText: getRequestText(tracked),
    updatedAt: currentTime,
  });
  return tracked;
}

function newerMessageActivity(message: IncomingMessage) {
  const activity = messageRouteActivity.get(visibleMessageRouteKey(message));
  if (!activity || !message.routeSequence || activity.latestSequence <= message.routeSequence) return null;
  return activity;
}

function newerMessageCancelsThisTurn(message: IncomingMessage): boolean {
  const activity = newerMessageActivity(message);
  if (!activity) return false;
  const text = activity.latestText.trim();
  return /^(?:\u53d6\u6d88|\u505c\u6b62|\u505c\u4e0b|\u5148\u522b|\u4e0d\u8981\u4e86|cancel|stop|never\s*mind)\b/iu.test(text)
    || /(?:\u521a\u521a|\u521a\u624d|\u4e0a\u4e00\u6761|\u524d\u9762|\u90a3\u53e5|\u90a3\u6761).{0,40}(?:\u4e0d\u662f(?:\u6307\u4ee4|\u4efb\u52a1)|\u522b(?:\u6267\u884c|\u505a)|\u4e0d\u8981(?:\u6267\u884c|\u505a)|\u53d6\u6d88|\u505c\u6b62|\u7406\u89e3\u9519|\u4e0d\u662f\u8fd9\u4e2a\u610f\u601d)/u.test(text)
    || /(?:that|previous|last)\s+(?:message|line|turn).{0,48}(?:wasn't|was\s+not|isn't|is\s+not).{0,16}(?:an?\s+)?(?:instruction|task|command)/iu.test(text);
}

export function correlateMessagingReply(
  message: IncomingMessage,
  reply: string,
): { text: string; superseded: boolean; delayed: boolean } {
  const readableReply = formatRemoteReplyForReadability(reply);
  const activity = newerMessageActivity(message);
  if (!activity) return { text: readableReply, superseded: false, delayed: false };
  if (newerMessageCancelsThisTurn(message)) {
    return { text: '', superseded: true, delayed: true };
  }
  const original = getRequestText(message).replace(/\s+/g, ' ').trim().slice(0, 72);
  if (!original) return { text: readableReply, superseded: false, delayed: true };
  const prefix = /[\u3400-\u9fff]/u.test(original)
    ? `\u5173\u4e8e\u4f60\u5148\u524d\u7684\u8fd9\u6761\u6d88\u606f\uff1a\u300c${original}\u300d`
    : `Regarding your earlier message: "${original}"`;
  return { text: `${prefix}\n\n${readableReply}`.trim(), superseded: false, delayed: true };
}

export function formatRemoteReplyForReadability(value: string): string {
  const text = String(value || '').replace(/\r\n/g, '\n').trim();
  if (!text) return '';
  const paragraphs = text.split(/\n{2,}/).flatMap(paragraph => {
    const clean = paragraph.trim();
    if (clean.length <= 120 || /```|^\s*(?:[-*+] |\d+[.)] )/m.test(clean)) return clean ? [clean] : [];
    const sentences = clean.split(/(?<=[。！？!?；;])\s*/u).filter(Boolean);
    if (sentences.length < 2) return [clean];
    const chunks: string[] = [];
    let chunk = '';
    for (const sentence of sentences) {
      if (chunk && (chunk.length + sentence.length > 150 || chunk.split(/[。！？!?；;]/u).length > 3)) {
        chunks.push(chunk.trim());
        chunk = sentence;
      } else {
        chunk += sentence;
      }
    }
    if (chunk.trim()) chunks.push(chunk.trim());
    return chunks;
  });
  return paragraphs.join('\n\n');
}

function messageRouteKey(message: IncomingMessage): string {
  return visibleMessageRouteKey(message);
}

export function messagingConversationAgentId(message: IncomingMessage): string {
  if (message.platform === 'wechat' && message.boundUserId && !message.boundOrgId) {
    return 'lumi';
  }
  const scope = message.chatType === 'group'
    ? `group:${message.chatId}:member:${message.userId}:thread:${message.threadId || 'main'}`
    : `private:${message.chatId || message.userId}`;
  return `lumi:${message.platform}:${scope}`;
}

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

function parsePersistedToolRecords(value: unknown): any[] {
  let current = value;
  for (let depth = 0; depth < 2 && typeof current === 'string' && current.trim(); depth += 1) {
    try {
      current = JSON.parse(current);
    } catch {
      return [];
    }
  }
  return Array.isArray(current) ? current : [];
}

function summarizeRemoteToolRecord(record: any): string {
  const name = String(record?.name || '').trim();
  if (!name) return '';
  if (record?.error) return `${name}: failed`;

  let payload: Record<string, any> | null = null;
  try {
    const parsed = typeof record?.result === 'string' ? JSON.parse(record.result) : record?.result;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) payload = parsed;
  } catch {}

  const facts: string[] = [];
  const allowedKeys = [
    'sent',
    'read',
    'ok',
    'success',
    'verified',
    'status',
    'verificationStatus',
    'verificationMethod',
    'completionMarkerExists',
    'fileName',
    'messageId',
    'contact',
    'method',
  ];
  for (const key of allowedKeys) {
    const value = payload?.[key];
    if (value === undefined || value === null || value === '') continue;
    facts.push(`${key}=${JSON.stringify(value).slice(0, 180)}`);
  }
  if (facts.length === 0 && /"sent"\s*:\s*true|sent:\s*true/i.test(String(record?.result || ''))) {
    facts.push('sent=true');
  }
  if (facts.length > 0) return `${name}: ${facts.join(', ')}`;

  const rawResult = String(record?.result || '').trim();
  const explicitlyFailed =
    payload?.ok === false
    || payload?.success === false
    || /^(?:blocked|cancelled|canceled|error|failed|partial|pending|queued|requires_setup|submitted_unverified|timeout|timed_out)$/i.test(String(payload?.status || ''))
    || /(?:^|\b)(?:failed|error|blocked|timed?\s*out|not\s+completed|manual_required)(?:\b|$)|(?:失败|错误|受阻|超时|未完成|需要人工|需要确认)/iu.test(rawResult);
  if (explicitlyFailed) return `${name}: failed or incomplete`;

  // A tool record without an error is not, by itself, completion evidence.
  // Keep unknown/plain results available as chronology without teaching the
  // next model turn that the external action definitely succeeded.
  return `${name}: result recorded (completion unverified)`;
}

export function buildRemoteRuntimeEvidenceContext(messages: any[]): string {
  const lines = messages
    .slice(-12)
    .flatMap(message => parsePersistedToolRecords(message?.toolCalls).map(summarizeRemoteToolRecord))
    .filter(Boolean)
    .slice(-10);
  if (lines.length === 0) return '';
  return [
    'Authoritative runtime evidence persisted from recent turns:',
    ...lines.map(line => `- ${line}`),
    'Use this evidence when explaining prior outcomes. Do not replace a successful provider acknowledgement with a guess based on the visible assistant wording.',
  ].join('\n');
}

export function persistBoundMessagingExchange(
  message: IncomingMessage,
  reply: string,
  onConversationUpdated?: MessagingRouteOptions['onConversationUpdated'],
): MessagingConversationUpdate | null {
  if (!message.userMessagePersisted) {
    persistBoundMessagingMessage(message, 'user', getDisplayText(message));
  }
  return persistBoundMessagingMessage(message, 'assistant', reply, onConversationUpdated);
}

export function persistBoundMessagingMessage(
  message: IncomingMessage,
  role: 'user' | 'assistant',
  content: string,
  onConversationUpdated?: MessagingRouteOptions['onConversationUpdated'],
  toolCalls?: any[],
): MessagingConversationUpdate | null {
  if (!message.boundUserId) return null;
  const agentId = messagingConversationAgentId(message);
  const domain = message.boundOrgId ? 'work' as const : 'personal' as const;
  const orgId = message.boundOrgId || '';
  const conversation = getOrCreateActiveConversation(message.boundUserId, agentId, domain, orgId);
  const source = `${message.platform}_bot`;
  const requestId = `${source}:${message.messageId}`;
  const messageId = addMessageIdempotent({
    userId: message.boundUserId,
    agentId,
    conversationId: conversation.id,
    role,
    content,
    domain,
    orgId,
    source,
    channel: message.platform,
    externalMessageId: message.messageId,
    routeSequence: message.routeSequence,
    receivedAt: message.receivedAt,
    requestId,
    toolCalls: toolCalls?.length ? toolCalls : undefined,
    // Remote ingress persists before routing so attachment download/queueing
    // cannot lose the accepted turn. The shared executor creates the real task
    // with its final policy and request lease; never create a placeholder task
    // from this early write.
    deferActionPreparation: role === 'user',
  });
  const update: MessagingConversationUpdate = {
    userId: message.boundUserId,
    domain,
    orgId,
    conversationId: conversation.id,
    agentId,
    source,
    messageId,
  };
  onConversationUpdated?.(update);
  return update;
}

async function admitBoundMessagingTurnDurably(
  message: IncomingMessage,
  onConversationUpdated?: MessagingRouteOptions['onConversationUpdated'],
): Promise<{ message: IncomingMessage; admission: AcceptedUserTurnAdmission<string> | null }> {
  if (!message.boundUserId) return { message, admission: null };
  const persisted = message.userMessagePersisted && message.userMessageId
    ? { messageId: message.userMessageId }
    : persistBoundMessagingMessage(message, 'user', getDisplayText(message), onConversationUpdated);
  const acceptedMessage: IncomingMessage = {
    ...message,
    userMessagePersisted: Boolean(persisted?.messageId),
    userMessageId: persisted?.messageId,
  };
  let admissionFailure: unknown;
  const admission = await admitAcceptedUserTurnDurably({
    persistAcceptedUserTurn: () => {
      if (!acceptedMessage.userMessagePersisted || !acceptedMessage.userMessageId) {
        throw new Error('Accepted remote user transcript was not persisted');
      }
      return acceptedMessage.userMessageId;
    },
    flush: flushDBOrThrow,
    onPersistenceUnknown: error => {
      admissionFailure = error;
    },
  });
  if (!admission) {
    console.error('[Messaging] Accepted remote turn is not durable:', admissionFailure);
    throw new MessagingReplyDurabilityError('accepted_turn', admissionFailure);
  }
  return { message: acceptedMessage, admission };
}

export async function enqueueMessageRoute(message: IncomingMessage, work: () => Promise<void>): Promise<void> {
  const key = messageRouteKey(message);
  const previous = messageRouteQueues.get(key) || Promise.resolve();
  const next = previous.catch(() => undefined).then(work);
  messageRouteQueues.set(key, next);
  try {
    await next;
  } finally {
    if (messageRouteQueues.get(key) === next) messageRouteQueues.delete(key);
  }
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

      // Respond to Feishu IMMEDIATELY (must be < 1s), process AI reply async
      res.json({ code: 0 });
      dispatchIncomingMessage(msg, {
        enrich: message => enrichFeishuAttachments(message, adapter),
        reply: async (message, text) => {
          return adapter.replyMessage(message.messageId, text);
        },
      }, options);
    } catch (err: any) {
      console.error('[Feishu] Event error:', err.message);
      if (!res.headersSent) {
        res.json({ code: -1, msg: err.message });
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

// ── AI reply pipeline — powered by Lumi personality ──

function sanitizeFileName(name: string): string {
  return (name || 'attachment')
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120) || 'attachment';
}

function isParseableAttachment(fileName: string, attachmentType: string): boolean {
  const ext = path.extname(fileName).toLowerCase();
  if (attachmentType === 'image' || attachmentType === 'audio' || attachmentType === 'media') return false;
  return ['.pdf', '.docx', '.doc', '.xlsx', '.xls', '.csv', '.txt', '.md'].includes(ext);
}

function getRequestText(msg: IncomingMessage): string {
  const marker = '\n\n以下是用户通过';
  return msg.text.includes(marker) ? msg.text.slice(0, msg.text.indexOf(marker)).trim() : msg.text.trim();
}

function getDisplayText(msg: IncomingMessage): string {
  const request = getRequestText(msg);
  const attachmentNames = Array.from(new Set((msg.attachments || [])
    .map(attachment => String(attachment.fileName || '').trim())
    .filter(name => name && !request.includes(name))));
  return [request, attachmentNames.length ? `附件：${attachmentNames.join('；')}` : ''].filter(Boolean).join('\n');
}

function remotePlatformLabel(platform: IncomingMessage['platform']): string {
  if (platform === 'wecom') return '企业微信';
  if (platform === 'wechat') return '微信';
  return '飞书';
}

function remoteMaterialSource(platform: IncomingMessage['platform']): 'feishu' | 'wecom' | 'wechat' {
  if (platform === 'wecom') return 'wecom';
  if (platform === 'wechat') return 'wechat';
  return 'feishu';
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
  if (!isBindingPlatform(msg.platform)) return msg;
  const binding = getBinding(msg.platform, msg.userId, msg.chatId, msg.chatType);
  if (!binding) return msg;
  if (binding.domain === 'work') {
    const membership = getMember(binding.orgId, binding.lumiUserId);
    if (!membership || membership.status !== 'active') return msg;
  }
  return {
    ...msg,
    boundUserId: binding.lumiUserId,
    boundOrgId: binding.domain === 'work' ? binding.orgId : undefined,
  };
}

function applyPlannedMessagingBinding(
  msg: IncomingMessage,
  plan: BindingCodeConsumptionPlan,
): IncomingMessage {
  return {
    ...msg,
    boundUserId: plan.code.lumiUserId,
    boundOrgId: plan.code.domain === 'work' ? plan.code.orgId : undefined,
  };
}

export function dispatchIncomingMessage(
  message: IncomingMessage,
  transport: IncomingMessageTransport,
  options?: MessagingRouteOptions,
): boolean {
  const ingressDecision = evaluateMessagingIngress(message);
  if (!ingressDecision.allowed) {
    recordMessagingIngress(message);
    updateMessagingJournal(message, {
      status: 'ignored',
      error: ingressDecision.reason,
    });
    return false;
  }
  try {
    if (!acceptMessageOnce(message.platform, message.messageId)) {
      console.log(`[Messaging] Ignoring duplicate ${message.platform} message: ${message.messageId}`);
      return false;
    }
  } catch (err: any) {
    recordMessagingIngress(message);
    updateMessagingJournal(message, {
      status: 'delivery_unknown',
      error: `Delivery ledger unavailable: ${err?.message || err}`,
    });
    console.error('[Messaging] Delivery ledger unavailable; refusing an untracked remote turn:', err?.message || err);
    return false;
  }

  const trackedMessage = registerMessageRouteActivity(message);
  recordMessagingIngress(trackedMessage);
  let finalJournalStatus: 'completed' | 'superseded' = 'completed';
  let terminalReplyDurable = false;
  let retryableBindingTurn = false;
  let retryableReplyDelivery = false;

  setImmediate(() => {
    void (async () => {
      const interruptedDelivery = getMessagingJournalEntry(trackedMessage);
      if (
        interruptedDelivery?.status === 'delivery_unknown'
        && interruptedDelivery.replyRetryable
        && interruptedDelivery.replyText
      ) {
        retryableBindingTurn = true;
        retryableReplyDelivery = true;
        updateMessagingJournal(trackedMessage, { status: 'processing' });
        const replyMessageId = await transport.reply(trackedMessage, interruptedDelivery.replyText);
        retryableReplyDelivery = false;
        updateMessagingJournal(trackedMessage, {
          status: 'replied',
          replyText: interruptedDelivery.replyText,
          replyMessageId: String(replyMessageId || ''),
          replyRetryable: false,
          error: '',
        });
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
            if (accepted.message.boundUserId) {
              persistBoundMessagingExchange(
                accepted.message,
                correlated.text,
                options?.onConversationUpdated,
              );
              await flushMessagingStateOrThrow('terminal_reply');
              terminalReplyDurable = true;
            }
            const replyMessageId = await transport.reply(trackedMessage, correlated.text);
            updateMessagingJournal(trackedMessage, {
              status: 'replied',
              replyText: correlated.text,
              replyMessageId: String(replyMessageId || ''),
            });
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
              const replyMessageId = await transport.reply(trackedMessage, invalidReply);
              updateMessagingJournal(trackedMessage, {
                status: 'replied',
                replyText: invalidReply,
                replyMessageId: String(replyMessageId || ''),
              });
              return;
            }
            retryableBindingTurn = true;
            const plannedTarget = applyPlannedMessagingBinding(trackedMessage, refreshedPlan);
            const accepted = await admitBoundMessagingTurnDurably(
              plannedTarget,
              options?.onConversationUpdated,
            );
            const committed = commitBindingCodeConsumption(refreshedPlan);
            if (!committed) {
              throw new Error('The binding code was already consumed by another durable request');
            }
            const committedTarget: IncomingMessage = {
              ...accepted.message,
              boundUserId: committed.binding.lumiUserId,
              boundOrgId: committed.binding.domain === 'work' ? committed.binding.orgId : undefined,
            };
            try {
              persistBoundMessagingExchange(
                committedTarget,
                correlated.text,
                options?.onConversationUpdated,
              );
              await flushMessagingStateOrThrow('terminal_reply');
              terminalReplyDurable = true;
            } catch (error) {
              rollbackBindingCodeConsumption(committed);
              throw error;
            }
            updateMessagingJournal(trackedMessage, {
              boundUserId: committedTarget.boundUserId || '',
              domain: committedTarget.boundOrgId ? 'work' : 'personal',
              orgId: committedTarget.boundOrgId || '',
              replyText: correlated.text,
              replyRetryable: true,
            });
            retryableReplyDelivery = true;
            const replyMessageId = await transport.reply(trackedMessage, correlated.text);
            retryableReplyDelivery = false;
            updateMessagingJournal(trackedMessage, {
              status: 'replied',
              replyText: correlated.text,
              replyMessageId: String(replyMessageId || ''),
              replyRetryable: false,
            });
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
        scopePlan.resolution.message,
        options?.onConversationUpdated,
      );
      const routeBaseMessage = accepted.message;
      const enrichment = scopePlan.resolution.kind === 'reply'
        ? Promise.resolve(routeBaseMessage)
        : transport.enrich(routeBaseMessage);
      await enqueueMessageRoute(trackedMessage, async () => {
        commitPersonalOrganizationScopePlan(scopePlan);
        updateMessagingJournal(trackedMessage, {
          boundUserId: routeBaseMessage.boundUserId || '',
          domain: routeBaseMessage.boundOrgId ? 'work' : 'personal',
          orgId: routeBaseMessage.boundOrgId || '',
        });
        // Attachment enrichment may download and write local files. It starts
        // only after a bound user's accepted transcript is durably flushed,
        // but before a long-running predecessor can let signed URLs expire.
        const enriched = await enrichment;
        const enrichedMessage: IncomingMessage = applyRemoteAttachmentContext({
          ...enriched,
          receivedAt: routeBaseMessage.receivedAt,
          routeSequence: routeBaseMessage.routeSequence,
          userMessagePersisted: routeBaseMessage.userMessagePersisted,
          userMessageId: routeBaseMessage.userMessageId,
        });
        const deliverExchange = async (target: IncomingMessage, reply: string): Promise<void> => {
          const correlated = correlateMessagingReply(target, reply);
          if (correlated.superseded) {
            finalJournalStatus = 'superseded';
            return;
          }
          persistBoundMessagingExchange(target, correlated.text, options?.onConversationUpdated);
          if (target.boundUserId) {
            await flushMessagingStateOrThrow('terminal_reply');
            terminalReplyDurable = true;
          }
          const replyMessageId = await transport.reply(target, correlated.text);
          updateMessagingJournal(trackedMessage, {
            status: 'replied',
            replyText: correlated.text,
            replyMessageId: String(replyMessageId || ''),
          });
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
        const replyMessageId = await transport.reply(routedMessage, replyText);
        updateMessagingJournal(trackedMessage, {
          status: 'replied',
          replyText,
          replyMessageId: String(replyMessageId || ''),
        });
      });
    })().then(() => {
      completeMessageDelivery(trackedMessage.platform, trackedMessage.messageId);
      updateMessagingJournal(trackedMessage, { status: finalJournalStatus });
    }).catch(async (err: any) => {
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
    });
  });
  return true;
}

const needsBinding = requestsOrganizationScope;

function formatKbResults(results: any[]): string {
  if (!results || results.length === 0) return '没有在组织知识库里找到相关内容。';
  return [
    `找到 ${results.length} 条组织知识库结果：`,
    '',
    ...results.slice(0, 5).map((item: any, index: number) => {
      const title = item.title || item.articleTitle || item.article?.title || `结果 ${index + 1}`;
      const content = String(item.content || item.chunk || item.snippet || '').slice(0, 500);
      const score = typeof item.score === 'number' ? ` 相似度 ${(item.score * 100).toFixed(1)}%` : '';
      return `${index + 1}. ${title}${score}\n${content}`;
    }),
  ].join('\n');
}

function formatCaseResults(cases: LegalCases.OrgLegalCaseFile[]): string {
  if (!cases || cases.length === 0) return '没有找到匹配的组织案件。';
  return [
    `找到 ${cases.length} 个组织案件：`,
    '',
    ...cases.slice(0, 8).map((item, index) => {
      const materialCount = item.materials?.length || 0;
      return `${index + 1}. ${item.title || '未命名案件'}\n案号：${item.caseNumber || '未填写'}\n案由：${item.cause || '未填写'}\n法院：${item.court || '未填写'}\n阶段：${item.stage}\n材料：${materialCount} 份\n更新：${new Date(item.updatedAt).toLocaleString()}`;
    }),
  ].join('\n');
}

function stripExtractionQuery(text: string, source: 'case' | 'kb' | 'any' = 'any'): string {
  let query = text
    .replace(/绑定 Lumi [A-Z0-9]{4,12}/gi, ' ')
    .replace(/(请|帮我|麻烦|一下|从|在|把|将|给我|发我|Lumi|露米|组织|工作域|远程|飞书|企业微信|企微|微信)/g, ' ')
    .replace(/(提取|调取|获取|查看|查询|查找|搜索|检索|整理|总结|摘要|列出|找出|读取|看看)/g, ' ')
    .replace(/(出来|一下|相关|有关|里面|中的|里的|关于|信息|资料|内容|全文|要点|清单|列表|目录|报告)/g, ' ');

  if (source === 'case' || source === 'any') {
    query = query.replace(/(案件|案号|卷宗|案情|材料|证据|关键日期|时间线|期限|开庭|判决|上诉|执行|事实|争议焦点|争议|焦点|法院|法官|当事人|案由|阶段)/g, ' ');
  }
  if (source === 'kb' || source === 'any') {
    query = query.replace(/(知识库|资料库|文档库|制度|文档|文章|规范|流程|政策)/g, ' ');
  }

  return query
    .replace(/[「」《》"“”'‘’：:，。；;、?？!！\n\r\t]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 100);
}

function fallbackKnowledgeSearch(orgId: string, userId: string, query: string, limit: number) {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  return OrgKB.listArticles(orgId, { status: 'published' }, userId)
    .filter((article: any) => {
      const haystack = `${article.title || ''}\n${article.content || ''}\n${article.category || ''}`.toLowerCase();
      return haystack.includes(q);
    })
    .slice(0, limit)
    .map((article: any) => ({
      articleId: article.id,
      title: article.title || '未命名资料',
      chunk: String(article.content || '').slice(0, 700),
      score: undefined,
    }));
}

async function searchOrgKnowledge(orgId: string, userId: string, query: string, limit = 5) {
  const q = query.trim();
  if (!q) return [];
  const semantic = await OrgKB.searchKnowledgeBase(orgId, q, { limit, userId });
  return semantic.length > 0 ? semantic : fallbackKnowledgeSearch(orgId, userId, q, limit);
}

function formatKbExtraction(results: any[], query: string): string {
  if (!results || results.length === 0) {
    return `没有从组织知识库里提取到“${query || '相关'}”资料。`;
  }
  return [
    `从组织知识库提取到 ${results.length} 条资料：`,
    '',
    ...results.slice(0, 6).map((item: any, index: number) => {
      const title = item.title || item.articleTitle || item.article?.title || `资料 ${index + 1}`;
      const content = String(item.content || item.chunk || item.snippet || '').trim().slice(0, 700);
      const score = typeof item.score === 'number' ? ` 相似度 ${(item.score * 100).toFixed(1)}%` : '';
      return `${index + 1}. ${title}${score}\n${content || '没有可展示的摘要内容'}`;
    }),
  ].join('\n');
}

function formatCaseTimeline(caseFile: LegalCases.OrgLegalCaseFile): string {
  const lines = [
    `案件：${caseFile.title || '未命名案件'}`,
    `案号：${caseFile.caseNumber || '未填写'}`,
    `阶段：${caseFile.stage || '未填写'}`,
    `开庭日：${caseFile.hearingDate || '未填写'}`,
    `判决日：${caseFile.judgmentDate || '未填写'}`,
    `上诉期限：${caseFile.appealDeadline || '未填写'}`,
    `执行期限：${caseFile.enforcementDeadline || '未填写'}`,
  ];
  return lines.join('\n');
}

function formatMaterialSnippet(material: LegalCases.OrgLegalCaseMaterial, includeContent: boolean): string {
  const created = material.createdAt ? new Date(material.createdAt).toLocaleString() : '未知时间';
  const head = `- ${material.title || material.fileName || '案件材料'}｜${material.type}｜${material.source}｜${created}`;
  if (!includeContent) return head;
  const snippet = String(material.content || '').replace(/\s+/g, ' ').slice(0, 450);
  return `${head}\n  ${snippet || '暂无可读文本'}`;
}

function formatCaseMaterials(caseFile: LegalCases.OrgLegalCaseFile, requestText: string): string {
  const includeContent = /(内容|全文|摘录|摘要|提取|看看|读取|具体)/.test(requestText);
  const materials = caseFile.materials || [];
  if (materials.length === 0) {
    return `案件“${caseFile.title}”目前还没有归档材料。`;
  }
  return [
    `案件“${caseFile.title}”共有 ${materials.length} 份材料：`,
    '',
    ...materials.slice(0, includeContent ? 6 : 20).map(item => formatMaterialSnippet(item, includeContent)),
  ].join('\n');
}

function formatCaseBrief(caseFile: LegalCases.OrgLegalCaseFile): string {
  const latestMaterials = (caseFile.materials || []).slice(0, 4);
  return [
    `案件：${caseFile.title || '未命名案件'}`,
    `案号：${caseFile.caseNumber || '未填写'}`,
    `当事人：${caseFile.party || '未填写'}`,
    `案由：${caseFile.cause || '未填写'}`,
    `法院/法官：${[caseFile.court, caseFile.judge].filter(Boolean).join(' / ') || '未填写'}`,
    `阶段：${caseFile.stage || '未填写'}`,
    `关键日期：开庭 ${caseFile.hearingDate || '未填写'}；判决 ${caseFile.judgmentDate || '未填写'}；上诉 ${caseFile.appealDeadline || '未填写'}；执行 ${caseFile.enforcementDeadline || '未填写'}`,
    `材料数量：${caseFile.materials?.length || 0} 份`,
    caseFile.notes ? `备注摘录：${caseFile.notes.replace(/\s+/g, ' ').slice(0, 600)}` : '',
    latestMaterials.length > 0 ? `最近材料：${latestMaterials.map(item => item.title || item.fileName || '案件材料').join('；')}` : '',
  ].filter(Boolean).join('\n');
}

function formatCaseFocusedExtraction(caseFile: LegalCases.OrgLegalCaseFile, requestText: string): string {
  const wantsTimeline = /(日期|时间线|期限|开庭|判决|上诉|执行|提醒)/.test(requestText);
  const wantsMaterials = /(材料|证据|附件|文件|卷宗|清单|列表|目录|全文|内容)/.test(requestText);
  const wantsBrief = /(摘要|总结|梳理|案情|事实|争议|焦点|分析|要点|信息|资料)/.test(requestText);

  const sections: string[] = [];
  if (wantsTimeline) {
    sections.push('【关键日期】');
    sections.push(formatCaseTimeline(caseFile));
  }
  if (wantsMaterials) {
    sections.push('【材料】');
    sections.push(formatCaseMaterials(caseFile, requestText));
  }
  if (!wantsTimeline && !wantsMaterials || wantsBrief) {
    sections.push('【案件摘要】');
    sections.push(formatCaseBrief(caseFile));
  }

  sections.push('');
  sections.push('注意：以上为案件资料提取与辅助整理，正式法律意见由执业律师确认。');
  return sections.join('\n');
}

async function handleRemoteExtractionCommand(msg: IncomingMessage, textAttachments: IncomingAttachment[]): Promise<string | null> {
  const requestText = getRequestText(msg);

  const asksAboutCurrentAttachments = textAttachments.length > 0
    && /(提取|摘要|总结|整理|分析|读取|看看).*(附件|文件|这份|这个|材料|资料|内容|信息)/.test(requestText)
    && !/(知识库|资料库|文档库|案件库|案件|案号|卷宗|归档|保存|导入|上传|收录)/.test(requestText);
  if (asksAboutCurrentAttachments) return null;

  const wantsKbExtraction = /(提取|调取|获取|查看|查询|查找|整理|总结|摘要|列出|读取).*(知识库|资料库|文档库|制度|组织资料|组织文档)|(知识库|资料库|文档库|制度).*(提取|调取|获取|查看|整理|总结|摘要|资料|信息)/.test(requestText);
  if (wantsKbExtraction) {
    const query = stripExtractionQuery(requestText, 'kb') || requestText;
    const results = await searchOrgKnowledge(msg.boundOrgId!, msg.boundUserId!, query, 6);
    return formatKbExtraction(results, query);
  }

  const wantsCaseExtraction = /(提取|调取|获取|查看|查询|查找|整理|总结|摘要|列出|读取).*(案件|案号|卷宗|案情|材料|证据)|(案件|案号|卷宗).*(提取|调取|获取|查看|整理|总结|摘要|材料|证据|关键日期|时间线|资料|信息)/.test(requestText);
  if (wantsCaseExtraction) {
    const query = stripExtractionQuery(requestText, 'case');
    const cases = query
      ? LegalCases.listCases(msg.boundOrgId!, query, 5, msg.boundUserId)
      : LegalCases.listCases(msg.boundOrgId!, '', 5, msg.boundUserId);
    if (cases.length === 0) {
      return query
        ? `没有找到“${query}”对应的组织案件。可以换一个案号、当事人、法院或案件名称再试。`
        : '请告诉我你要提取哪个案件，例如：提取 张三合同纠纷案 的材料清单。';
    }
    if (cases.length > 1 && query) {
      const exact = cases.find(item => item.caseNumber === query || item.title === query);
      if (!exact) {
        return [
          `找到 ${cases.length} 个可能相关的案件，请再指定一个案号或案件名称：`,
          '',
          ...cases.slice(0, 5).map((item, index) => `${index + 1}. ${item.title || '未命名案件'}｜${item.caseNumber || '未填案号'}｜${item.cause || '未填案由'}`),
        ].join('\n');
      }
      return formatCaseFocusedExtraction(exact, requestText);
    }
    return formatCaseFocusedExtraction(cases[0], requestText);
  }

  const wantsGenericExtraction = /(提取|调取|获取|查看|查询|查找|整理|总结|摘要|列出|读取).*(资料|信息|文档)/.test(requestText);
  if (wantsGenericExtraction) {
    const query = stripExtractionQuery(requestText, 'any');
    if (!query) return null;
    const [kbResults, cases] = await Promise.all([
      searchOrgKnowledge(msg.boundOrgId!, msg.boundUserId!, query, 4),
      Promise.resolve(LegalCases.listCases(msg.boundOrgId!, query, 3, msg.boundUserId)),
    ]);
    if (kbResults.length === 0 && cases.length === 0) {
      return `没有从组织知识库或案件库里提取到“${query}”相关资料。`;
    }
    return [
      `围绕“${query}”提取到这些组织资料：`,
      '',
      cases.length > 0 ? '【相关案件】' : '',
      ...cases.map((item, index) => `${index + 1}. ${item.title || '未命名案件'}｜${item.caseNumber || '未填案号'}｜材料 ${item.materials?.length || 0} 份`),
      cases.length > 0 ? '' : '',
      kbResults.length > 0 ? '【知识库资料】' : '',
      ...kbResults.slice(0, 4).map((item: any, index: number) => `${index + 1}. ${item.title || '资料'}\n${String(item.chunk || item.content || '').slice(0, 500)}`),
    ].filter(Boolean).join('\n');
  }

  return null;
}

function extractCaseArchiveTarget(text: string): string {
  const patterns = [
    /(?:归档|保存|加入|添加|放入|放到).{0,12}(?:到|进|给)\s*(?:案件|案号|卷宗)?[：:\s「《"]*([^，。；;\n」》"]{2,80})/,
    /(?:案件|案号|卷宗)[：:\s「《"]+([^，。；;\n」》"]{2,80})/,
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match?.[1]) {
      return match[1].replace(/^(里|中|内|为|是)/, '').trim();
    }
  }
  return '';
}

function inferMaterialType(fileName: string, text: string): LegalCases.LegalCaseMaterialType {
  const lower = fileName.toLowerCase();
  if (/合同|协议|contract/.test(fileName) || lower.includes('contract')) return 'contract';
  if (/判决|裁定|文书|judgment/.test(fileName) || lower.includes('judgment')) return 'judgment';
  if (/起诉状|答辩状|申请书|委托书|代理词|pleading/.test(fileName + text)) return 'pleading';
  if (/笔录|会谈|庭审|transcript/.test(fileName + text)) return 'consultation';
  return 'evidence';
}

function updateCaseHintsFromText(orgId: string, userId: string, caseFile: LegalCases.OrgLegalCaseFile, text: string) {
  const hints = LegalCases.extractLegalCaseHints(text);
  const patch: Partial<LegalCases.OrgLegalCaseFile> = {};
  if (hints.caseNumber && !caseFile.caseNumber) patch.caseNumber = hints.caseNumber;
  if (hints.court && !caseFile.court) patch.court = hints.court;
  if (hints.cause && !caseFile.cause) patch.cause = hints.cause;
  if (hints.hearingDate && !caseFile.hearingDate) patch.hearingDate = hints.hearingDate;
  if (Object.keys(patch).length > 0) {
    LegalCases.updateCase(orgId, userId, caseFile.id, patch);
  }
}

export async function handleRemoteOrgCommand(msg: IncomingMessage): Promise<string | null> {
  const requestText = getRequestText(msg);
  const platformLabel = remotePlatformLabel(msg.platform);
  const materialSource = remoteMaterialSource(msg.platform);
  const wantsOrgData = needsBinding(requestText);
  if (wantsOrgData && (!msg.boundUserId || !msg.boundOrgId)) {
    return `这个操作需要先绑定${platformLabel}身份。请在 Lumi 桌面端生成绑定码，然后在${platformLabel}里发送：绑定 Lumi <绑定码>。`;
  }
  if (!msg.boundUserId || !msg.boundOrgId) return null;
  const membership = getMember(msg.boundOrgId, msg.boundUserId);
  if (!membership || membership.status !== 'active') {
    return '当前 Lumi 身份的组织成员权限已经失效，请重新进入组织或联系管理员。';
  }
  const writeRequest = /(归档|保存|导入|上传|新建|创建|添加|写入|修改|更新|删除)/.test(requestText)
    || Boolean(msg.attachments?.length && /(案件|材料|卷宗|知识库|资料库|文档库)/.test(requestText));
  if (writeRequest && membership.role === 'viewer') {
    return '当前 Lumi 身份在该组织中只有查看权限，不能归档、创建或修改组织数据。';
  }

  const textAttachments = (msg.attachments || []).filter(item => item.extractedText?.trim());
  const extractionReply = await handleRemoteExtractionCommand(msg, textAttachments);
  if (extractionReply) return extractionReply;

  if (/知识库|制度|资料|文档库/.test(requestText) && /(查|搜|找|检索|搜索)/.test(requestText)) {
    const query = requestText.replace(/(查|搜|找|检索|搜索)?\s*(组织)?\s*(知识库|制度|资料|文档库)/g, '').trim() || requestText;
    const results = await searchOrgKnowledge(msg.boundOrgId, msg.boundUserId, query, 5);
    return formatKbResults(results);
  }

  if (/(查|搜|找|检索|搜索).*(案件|案号|材料|卷宗)|案件.*(在哪|有没有|列表)/.test(requestText)) {
    const query = requestText.replace(/(查|搜|找|检索|搜索)?\s*(组织)?\s*(案件|案号|材料|卷宗)/g, '').trim();
    const cases = LegalCases.listCases(msg.boundOrgId, query, 8, msg.boundUserId);
    return formatCaseResults(cases);
  }

  const wantsKbArchive = textAttachments.length > 0 && /(知识库|文档库|资料库)/.test(requestText) && /(归档|保存|导入|上传|收录)/.test(requestText);
  if (wantsKbArchive) {
    const articles = textAttachments.map(attachment => OrgKB.createArticle(msg.boundOrgId!, msg.boundUserId!, {
      title: attachment.fileName || requestText.slice(0, 80) || `${platformLabel}远程文档`,
      content: attachment.extractedText || '',
      category: materialSource,
      tags: [materialSource, 'remote-file'],
      status: 'published',
    }));
    return [
      `已归档 ${articles.length} 份${platformLabel}文件到组织知识库。`,
      '',
      ...articles.map((article, index) => `${index + 1}. ${article.title}`),
      '',
      `后续可以在${platformLabel}里说“查组织知识库 <关键词>”继续检索。`,
    ].join('\n');
  }

  const wantsArchive = /(归档|保存|导入|上传|新建|创建|案件|案情|材料|卷宗)/.test(requestText);
  if (textAttachments.length > 0 && wantsArchive) {
    const first = textAttachments[0];
    const combined = textAttachments
      .map(item => `# ${item.fileName}\n\n${item.extractedText}`)
      .join('\n\n---\n\n');
    const target = extractCaseArchiveTarget(requestText);
    const targetCases = target ? LegalCases.listCases(msg.boundOrgId, target, 3, msg.boundUserId) : [];
    if (targetCases.length > 0) {
      const targetCase = targetCases[0];
      for (const attachment of textAttachments) {
        LegalCases.addMaterial(msg.boundOrgId, msg.boundUserId, targetCase.id, {
          type: inferMaterialType(attachment.fileName, attachment.extractedText || ''),
          title: attachment.fileName || `${platformLabel}案件材料`,
          content: attachment.extractedText || '',
          fileName: attachment.fileName,
          localPath: attachment.localPath,
          source: materialSource,
        });
      }
      updateCaseHintsFromText(msg.boundOrgId, msg.boundUserId, targetCase, combined);
      const refreshed = LegalCases.getCase(msg.boundOrgId, targetCase.id, msg.boundUserId) || targetCase;
      return [
        `已把 ${textAttachments.length} 份${platformLabel}附件归档到已有案件。`,
        '',
        `案件：${refreshed.title}`,
        `案号：${refreshed.caseNumber || '未识别'}`,
        `法院：${refreshed.court || '未识别'}`,
        `案由：${refreshed.cause || '未识别'}`,
        `材料数：${refreshed.materials.length}`,
        '',
        '后续可以继续发送材料，或说“查案件 <关键词>”。',
        '注意：此归档和分析只辅助律师工作，最终法律意见由执业律师确认。',
      ].join('\n');
    }

    const title = requestText
      .replace(/(请|帮我|把|将|归档|保存|新建|创建|案件|材料|到|组织|律所)/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 80) || first.fileName || `${platformLabel}远程案件材料`;
    const caseFile = LegalCases.createCaseFromRemoteMaterial({
      orgId: msg.boundOrgId,
      userId: msg.boundUserId,
      title,
      text: combined,
      fileName: first.fileName,
      localPath: first.localPath,
      source: materialSource,
    });
    for (const attachment of textAttachments.slice(1)) {
      LegalCases.addMaterial(msg.boundOrgId, msg.boundUserId, caseFile.id, {
        type: 'evidence',
        title: attachment.fileName,
        content: attachment.extractedText || '',
        fileName: attachment.fileName,
        localPath: attachment.localPath,
        source: materialSource,
      });
    }
    const refreshed = LegalCases.getCase(msg.boundOrgId, caseFile.id, msg.boundUserId) || caseFile;
    return [
      `已创建组织案件并归档 ${textAttachments.length} 份${platformLabel}附件。`,
      '',
      `案件：${refreshed.title}`,
      `案号：${refreshed.caseNumber || '未识别'}`,
      `法院：${refreshed.court || '未识别'}`,
      `案由：${refreshed.cause || '未识别'}`,
      `材料数：${refreshed.materials.length}`,
      '',
      `我已按案件材料保存。后续可以在${platformLabel}里说“查案件 <关键词>”，或在桌面端组织律所区域继续整理。`,
      '注意：此归档和分析只辅助律师工作，最终法律意见由执业律师确认。',
    ].join('\n');
  }

  if (/(新建|创建).*(案件)/.test(requestText)) {
    const caseFile = LegalCases.createCaseFromRemoteMaterial({
      orgId: msg.boundOrgId,
      userId: msg.boundUserId,
      title: requestText.slice(0, 80) || `${platformLabel}远程案件`,
      text: requestText,
      source: materialSource,
    });
    return `已新建组织案件：${caseFile.title}\n案号：${caseFile.caseNumber || '未识别'}\n后续可以继续发送文件并说“归档到案件”。`;
  }

  return null;
}

function attachmentPromptBlock(attachment: IncomingAttachment): string {
  const parts = [
    `## 附件：${attachment.fileName}`,
    `类型：${attachment.type}`,
    attachment.fileSize ? `大小：${attachment.fileSize} bytes` : '',
    attachment.localPath ? `本地缓存：${attachment.localPath}` : '',
  ].filter(Boolean);
  if (attachment.parseError) {
    parts.push(`解析状态：${attachment.parseError}`);
  } else if (attachment.extractedText) {
    parts.push('解析文本：');
    parts.push(attachment.extractedText.slice(0, 12000));
  } else {
    parts.push('解析状态：已接收附件，但当前类型暂未自动抽取文本。');
  }
  return parts.join('\n');
}

export async function enrichMessagingAttachments(
  msg: IncomingMessage,
  platformFolder: 'feishu' | 'wecom' | 'wechat',
  contextPrompt: string,
  downloader: (attachment: IncomingAttachment) => Promise<Buffer>,
): Promise<IncomingMessage> {
  if (!msg.attachments || msg.attachments.length === 0) return msg;

  const enrichedAttachments: IncomingAttachment[] = [];
  for (const attachment of msg.attachments) {
    const enriched: IncomingAttachment = { ...attachment };
    try {
      if (attachment.fileSize && attachment.fileSize > MAX_MESSAGING_ATTACHMENT_BYTES) {
        throw new Error(`file too large (${Math.round(attachment.fileSize / 1024 / 1024)} MB)`);
      }
      const buffer = await downloader(attachment);
      enriched.fileSize = enriched.fileSize || buffer.byteLength;
      if (buffer.byteLength > MAX_MESSAGING_ATTACHMENT_BYTES) {
        throw new Error(`file too large (${Math.round(buffer.byteLength / 1024 / 1024)} MB)`);
      }

      const safeName = sanitizeFileName(enriched.fileName);
      const scopeDir = msg.boundOrgId
        ? `org-${sanitizeFileName(msg.boundOrgId)}`
        : msg.boundUserId
          ? `personal-${sanitizeFileName(msg.boundUserId)}`
          : 'unbound-quarantine';
      const messageKey = sanitizeFileName(msg.messageId).slice(0, 80);
      const savePath = getDataPath(path.join('messaging', platformFolder, 'attachments', scopeDir, `${Date.now()}_${messageKey}_${safeName}`));
      fs.mkdirSync(path.dirname(savePath), { recursive: true });
      fs.writeFileSync(savePath, buffer);
      enriched.localPath = savePath;

      if (isParseableAttachment(safeName, enriched.type)) {
        const parsed = await parseDocument(savePath);
        if (parsed?.text?.trim()) {
          enriched.extractedText = parsed.text.trim();
        } else {
          enriched.parseError = '文件已保存，但没有抽取到可读文本';
        }
      }
    } catch (err: any) {
      enriched.parseError = err?.message || String(err);
    }
    enrichedAttachments.push(enriched);
  }

  const attachmentBlocks = enrichedAttachments.map(attachmentPromptBlock).join('\n\n');
  const text = [
    msg.text,
    '',
    contextPrompt,
    attachmentBlocks,
  ].filter(Boolean).join('\n');

  return {
    ...msg,
    text,
    attachments: enrichedAttachments,
  };
}

export function enrichFeishuAttachments(msg: IncomingMessage, adapter: FeishuAdapter): Promise<IncomingMessage> {
  return enrichMessagingAttachments(
    msg,
    'feishu',
    '以下是用户通过飞书发送的附件内容。请优先结合附件内容回答；如果像案件材料，请按案件事实、争议焦点、证据/材料缺口、下一步建议来整理，并提醒最终由律师确认。',
    async attachment => {
      if (!attachment.resourceKey) throw new Error('missing resource key');
      return adapter.downloadMessageResource(msg.messageId, attachment.resourceKey, attachment.resourceType || 'file');
    },
  );
}

export function enrichWeComAttachments(msg: IncomingMessage, adapter: WeComAdapter): Promise<IncomingMessage> {
  return enrichMessagingAttachments(
    msg,
    'wecom',
    '以下是用户通过企业微信发送的附件内容。请结合附件回答；如属案件材料，按事实、争议焦点、证据缺口和下一步建议整理。',
    async attachment => {
      if (!attachment.resourceKey) throw new Error('missing media id');
      return adapter.downloadMedia(attachment.resourceKey);
    },
  );
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

export interface RemoteLumiExecutionPlan extends LumiExecutionPipeline {
  /** Compatibility alias retained for route diagnostics and existing callers. */
  dispatch: LumiTurnDispatch;
  source: string;
}

export interface RemoteLumiExecutionPlanInput {
  userId: string;
  text: string;
  source: string;
  domain: 'personal' | 'work';
  orgId: string;
  operationMode: OperationMode;
  identityBound: boolean;
  canWriteOrganization: boolean;
  personalityToolPolicy?: ToolPolicy;
  dispatch?: LumiTurnDispatch;
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

export function buildRemoteLumiExecutionPlan(input: RemoteLumiExecutionPlanInput): RemoteLumiExecutionPlan {
  const rawDispatch = input.dispatch || buildLumiTurnDispatch({
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
  const pipeline = buildLumiExecutionPipeline({
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
  return { ...pipeline, dispatch: pipeline.turnIntent, source: input.source };
}

function desktopRelayReportedSuccess(raw: string): boolean {
  if (!String(raw || '').trim()) return false;
  try {
    const parsed = JSON.parse(raw);
    return parsed?.ok !== false && !parsed?.error;
  } catch {
    return !/\b(?:error|failed|failure)\b|失败|错误/i.test(raw);
  }
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

export async function processWithPersonality(
  msg: IncomingMessage,
  options?: MessagingRouteOptions,
  preacceptedAdmission?: AcceptedUserTurnAdmission<string> | null,
): Promise<string> {
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
  const conversationAgentId = messagingConversationAgentId(msg);
  let conversation = isIdentityBound
    ? getOrCreateActiveConversation(effectiveUserId, conversationAgentId, domain, orgId)
    : null;
  let acceptedTurnAdmission: AcceptedUserTurnAdmission<string> | null =
    preacceptedAdmission?.persisted === msg.userMessageId ? preacceptedAdmission : null;
  if (isIdentityBound && (!msg.userMessagePersisted || !msg.userMessageId)) {
    const persistedUserMessage = persistBoundMessagingMessage(
      msg,
      'user',
      getDisplayText(msg),
      options?.onConversationUpdated,
    );
    msg = {
      ...msg,
      userMessagePersisted: Boolean(persistedUserMessage?.messageId),
      userMessageId: persistedUserMessage?.messageId,
    };
    conversation = getOrCreateActiveConversation(effectiveUserId, conversationAgentId, domain, orgId);
  }
  if (isIdentityBound && !acceptedTurnAdmission) {
    let admissionFailure: unknown;
    acceptedTurnAdmission = await admitAcceptedUserTurnDurably({
      persistAcceptedUserTurn: () => {
        if (!msg.userMessagePersisted || !msg.userMessageId) {
          throw new Error('Accepted remote user transcript was not persisted');
        }
        return msg.userMessageId;
      },
      flush: flushDBOrThrow,
      onPersistenceUnknown: error => {
        admissionFailure = error;
      },
    });
    if (!acceptedTurnAdmission) {
      console.error('[Messaging] Accepted remote turn is not durable:', admissionFailure);
      throw new MessagingReplyDurabilityError('accepted_turn', admissionFailure);
    }
    try {
      await ensurePendingConfirmationPersistenceInitialized();
    } catch (error: any) {
      console.error('[Messaging] Encrypted confirmation store is unavailable:', error);
      if (isMessagingReplyDurabilityError(error)) throw error;
      throw new MessagingReplyDurabilityError('accepted_turn', error);
    }
  }
  const precedingTranscript = conversation
    ? getMessagesThroughExternalMessage(conversation.id, msg.messageId, 8).filter(item => !(
        item.role === 'user'
        && (item.externalMessageId === msg.messageId || item.requestId === requestId)
      ))
    : [];
  const pendingAssistantOfferContext = conversation
    ? buildPendingAssistantOfferContextFromTranscript({
        messages: precedingTranscript,
        userId: effectiveUserId,
        domain,
        orgId,
        conversationId: conversation.id,
        taskId: conversation.actionContinuationState?.taskId,
      })
    : undefined;
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
  const confirmationResolution = isIdentityBound
    && acceptedTurnAdmission
    && confirmationScope
    && confirmationChannelScope
    ? await resolveAcceptedTurnConfirmation({
        admission: acceptedTurnAdmission,
        userId: effectiveUserId,
        userText: requestText,
        actionState: conversation?.actionContinuationState,
        taskScope: confirmationScope,
        channelScope: confirmationChannelScope,
      })
    : null;
  if (confirmationResolution) confirmationScope = confirmationResolution.scope;
  const pendingConfirmation = confirmationResolution?.pending || null;
  const pendingConfirmationPrompt = confirmationResolution?.prompt || '';
  const organizationMembership = isOrganizationBound ? getMember(orgId, effectiveUserId) : null;
  const canWriteOrganization = organizationMembership?.status === 'active' && organizationMembership.role !== 'viewer';
  const routingText = [
    requestText,
    ...(msg.attachments || []).flatMap(attachment => [attachment.fileName, attachment.localPath || '', attachment.extractedText || '']),
    pendingConfirmationPrompt,
  ].filter(Boolean).join('\n');
  const operationMode = isIdentityBound ? getStoredOperationMode(effectiveUserId) : 'chat';
  const provisionalPlan = buildRemoteLumiExecutionPlan({
    userId: effectiveUserId,
    text: routingText,
    source,
    domain,
    orgId,
    operationMode,
    identityBound: isIdentityBound,
    canWriteOrganization,
    pendingAssistantOfferContext,
  });
  const desktopRelay = isIdentityBound
    ? options?.createScopedDesktopRelay?.(effectiveUserId, source, domain, orgId)
    : undefined;
  const personalDesktopRelay = isIdentityBound
    ? options?.createPersonalDesktopRelay?.(effectiveUserId, source)
    : undefined;
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
  if (newerMessageCancelsThisTurn(msg)) return '';

  const requestedMode = provisionalPlan.dispatch.flow.requestedMode;
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
  let personality: any = null;

  if (registry) {
    try {
      const memories = isIdentityBound && options?.queryMemories
        ? options.queryMemories({ userId: effectiveUserId, query: requestText, limit: 5, minConfidence: 0.4, domain, orgId })
        : [];
      const emotionalStateKey = domain === 'work' ? `${effectiveUserId}:org:${orgId}` : effectiveUserId;
      const emotionalState = isIdentityBound && options?.loadEmotionalState ? options.loadEmotionalState(emotionalStateKey) : undefined;

      const result = registry.buildSystemPrompt(
        'lumi',
        { mode: provisionalPlan.execution.allowToolUse ? 'task' : 'chat', sensory: { hasAudio: false, hasVideo: false, hasSpatial: false, hasHaptic: false, hasHolographic: false, activeDeviceTypes: [], deviceCount: 0 } },
        {
          memories: memories.length > 0 ? memories : undefined,
          emotionalState,
          userId: effectiveUserId,
          userText: requestText,
          domain,
          orgId,
        },
      );
      personality = result.config;
      systemPrompt = result.systemPrompt;
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

  const executionPlan = buildRemoteLumiExecutionPlan({
    userId: effectiveUserId,
    text: routingText,
    source,
    domain,
    orgId,
    operationMode,
    identityBound: isIdentityBound,
    canWriteOrganization,
    personalityToolPolicy: personality?.toolPolicy,
    dispatch: provisionalPlan.dispatch,
    actionTaskState: conversation?.actionContinuationState,
    pendingAssistantOfferContext,
  });
  const turnDispatch = executionPlan.dispatch;
  const turnFlow = turnDispatch.flow;
  const executionDecision = executionPlan.execution;
  const modelToolPolicy = buildModelCapabilityPolicy(executionDecision);
  const modelToolProjection = buildModelToolProjection(executionDecision);
  const capabilitySelection = executionPlan.capabilityPlan;
  const actionFollowupIntent = classifyConversationActionFollowupIntent(
    requestText,
    conversation?.actionContinuationState,
  );
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
    : { state: null, kind: 'conversation' as const };
  if ('bindingFailure' in actionTaskExecution) {
    const staleText = actionTaskExecution.bindingFailure === 'busy'
      ? CN_TASK_EXECUTION_MESSAGES.actionTurnBusy
      : CN_TASK_EXECUTION_MESSAGES.actionTurnStale;
    persistBoundMessagingMessage(
      msg,
      'assistant',
      staleText,
      options?.onConversationUpdated,
    );
    await flushTerminalReply();
    return staleText;
  }
  const actionAbortController = new AbortController();
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
  const actionWasCancelled = () => (
    actionAbortController.signal.aborted || newerMessageCancelsThisTurn(msg)
  );
  const throwIfActionLeaseWasLost = () => {
    if (!actionLeaseWasLost()) return;
    const error = new Error('Remote conversation action execution lease was lost');
    error.name = 'AbortError';
    throw error;
  };
  try {
  if (conversation && actionTaskExecution.state?.taskId) {
    executionPlan.executionPlan = bindCapabilityExecutionPlanTask(
      executionPlan.executionPlan,
      actionTaskExecution.state.taskId,
    );
    persistConversationExecutionPlan({
      conversationId: conversation.id,
      userId: effectiveUserId,
      plan: executionPlan.executionPlan,
    });
  }
  if (isIdentityBound && conversation && actionFollowupIntent === 'status') {
    const statusText = getConversationActionStatus(
      conversation.id,
      effectiveUserId,
      requestText,
      conversation.actionContinuationState,
    );
    const correlated = correlateMessagingReply(msg, statusText);
    if (correlated.superseded) return '';
    persistBoundMessagingMessage(msg, 'assistant', correlated.text, options?.onConversationUpdated);
    await flushTerminalReply();
    return correlated.text;
  }
  let organizationWorkRoute: RouteOrganizationWorkResult | null = null;
  const shouldRouteOrganizationWork = Boolean(
    isOrganizationBound
    && conversation
    && actionTaskExecution.state?.taskId
    && (
      executionPlan.capabilityPlan.taskLedgerRequired
      || requestsOrganizationScope(requestText)
      || actionTaskExecution.kind === 'resume'
    )
    && !directlyAppliedMode
    && executionPlan.normalizedIntent.operation !== 'status'
    && executionPlan.normalizedIntent.operation !== 'explain',
  );
  if (shouldRouteOrganizationWork) {
    try {
      const mentionedMemberIds = resolveMentionedOrganizationMembers(msg, orgId);
      organizationWorkRoute = routeOrganizationWork({
        orgId,
        requesterUserId: effectiveUserId,
        source,
        requestId,
        idempotencyKey: `organization-work:${requestId}`,
        text: routingText,
        intentKind: executionPlan.normalizedIntent.kind,
        operation: executionPlan.normalizedIntent.operation,
        sideEffectClass: executionPlan.normalizedIntent.sideEffectClass,
        conversationId: conversation!.id,
        taskId: actionTaskExecution.state!.taskId,
        platform: msg.platform,
        targetMemberId: mentionedMemberIds[0],
        targetMemberIds: mentionedMemberIds,
      });
      bindOrganizationWorkItemTask({
        orgId,
        workItemId: organizationWorkRoute.workItem.id,
        conversationId: conversation!.id,
        taskId: actionTaskExecution.state!.taskId,
      });
      const route = organizationWorkRoute.workItem;
      systemPrompt += [
        '',
        '## Organization Business Route',
        `Work item: ${route.id}. Status: ${route.status}.`,
        `Department: ${route.departmentId || 'organization-default'}. Position: ${route.positionId || 'none'}.`,
        `Primary member: ${route.assignedMemberId || 'none'}. Collaborators: ${(route.collaboratorMemberIds || []).join(', ') || 'none'}.`,
        `Allowed organization worker agents for orchestration: ${route.assignedAgentIds.join(', ') || 'central Lumi only'}.`,
        `Required skill tags: ${route.skillTags.join(', ') || 'none'}.`,
        'Do not claim another department, member, position, skill, or worker handled the task unless this durable route or a later handoff receipt says so.',
      ].join('\n');
    } catch (error: any) {
      const blocker = `Organization work routing failed: ${error?.message || error}`;
      setConversationActionExecutionStatus(conversation!.id, effectiveUserId, 'blocked', { blocker, requestId });
      settleConversationActionExecutionRequest(conversation!.id, effectiveUserId, requestId, blocker);
      const response = `组织任务没有开始执行：${error?.message || '业务路由校验失败'}。请由组织管理员检查部门、岗位、成员、技能或智能体配置。`;
      const correlated = correlateMessagingReply(msg, response);
      if (!correlated.superseded) persistBoundMessagingMessage(msg, 'assistant', correlated.text, options?.onConversationUpdated);
      await flushTerminalReply();
      return correlated.text;
    }
  }
  if (organizationWorkRoute?.workItem.status === 'waiting_approval') {
    const approvalId = organizationWorkRoute.approval?.id || organizationWorkRoute.workItem.approvalId || '';
    const blocker = `Organization approval ${approvalId} is required before execution.`;
    setConversationActionExecutionStatus(conversation!.id, effectiveUserId, 'blocked', { blocker, requestId });
    settleConversationActionExecutionRequest(conversation!.id, effectiveUserId, requestId, blocker);
    const response = `任务已完成组织路由，但尚未执行。工作项 ${organizationWorkRoute.workItem.id} 正在等待组织管理员审批（审批单 ${approvalId}）。审批通过后，在当前会话说“继续”即可恢复原任务。`;
    const correlated = correlateMessagingReply(msg, response);
    if (!correlated.superseded) persistBoundMessagingMessage(msg, 'assistant', correlated.text, options?.onConversationUpdated);
    await flushTerminalReply();
    return correlated.text;
  }
  if (organizationWorkRoute?.workItem.status === 'waiting_human') {
    const owner = organizationWorkRoute.workItem.humanOwnerUserId || organizationWorkRoute.workItem.assignedMemberId || '指定成员';
    const blocker = `Organization work item is owned by human member ${owner}.`;
    setConversationActionExecutionStatus(conversation!.id, effectiveUserId, 'blocked', { blocker, requestId });
    settleConversationActionExecutionRequest(conversation!.id, effectiveUserId, requestId, blocker);
    const response = `任务已转交给组织成员 ${owner}，Lumi 已停止自动执行。工作项：${organizationWorkRoute.workItem.id}。后续只有收到转派或退回智能体的持久回执后才会恢复。`;
    const correlated = correlateMessagingReply(msg, response);
    if (!correlated.superseded) persistBoundMessagingMessage(msg, 'assistant', correlated.text, options?.onConversationUpdated);
    await flushTerminalReply();
    return correlated.text;
  }
  if (
    conversation
    && (executionDecision.allowToolUse || Boolean(directlyAppliedMode))
    && (actionTaskExecution.kind === 'new' || actionTaskExecution.kind === 'resume')
  ) {
    setConversationActionExecutionStatus(conversation.id, effectiveUserId, 'executing', { requestId });
    if (organizationWorkRoute) {
      setOrganizationWorkItemExecutionStatus({
        orgId,
        workItemId: organizationWorkRoute.workItem.id,
        status: 'executing',
        actorUserId: effectiveUserId,
      });
    }
  }
  const priorTaskRecords = actionTaskExecution.kind === 'resume'
    ? taskReceiptsToRecords(actionTaskExecution.state?.receipts || [])
    : [];
  const taskAwareRecords = (records: ToolExecutionRecord[]) => (
    coalesceToolExecutionRecords([...priorTaskRecords, ...records])
  );
  const desktopExecutionPolicy = buildDesktopExecutionStabilityPolicy({
    channel: 'chat',
    text: routingText,
    flow: turnFlow,
    capabilitySelection,
    capabilityExecutionPlan: executionPlan.executionPlan,
  });
  const desktopExecutionTracker = createDesktopExecutionTracker(desktopExecutionPolicy.executionPlan);

  systemPrompt += `\n\n${turnDispatch.promptOverlay}`;
  systemPrompt += `\n\n${turnFlow.promptOverlay}`;
  systemPrompt += `\n\n${buildInteractionModeOverlay(turnFlow)}`;
  systemPrompt += `\n\n${executionDecision.promptOverlay}`;
  if (isIdentityBound) {
    systemPrompt += `\n\n${buildLumiRuntimeCapabilityContext({
      userId: effectiveUserId,
      text: routingText,
      flow: turnFlow,
      toolRegistry,
      domain,
      orgId,
    })}`;
    systemPrompt += `\n\n${capabilitySelection.promptOverlay}`;
    if (desktopExecutionPolicy.promptOverlay) {
      systemPrompt += `\n\n${desktopExecutionPolicy.promptOverlay}`;
    }
    systemPrompt += `\n\n${formatClientSelfPromptForTurn(effectiveUserId, routingText, { domain, orgId })}`;
  }
  systemPrompt += `\n\n${buildLumiOperatingKernelPrompt({ channel: 'chat', flow: turnFlow })}`;
  systemPrompt += '\n\nRemote continuity rule: prior assistant statements about installed tool counts, missing desktop access, or mode availability are conversational history, not runtime evidence. Use the current capability map, client state, scoped relay, and actual tool results as the source of truth.';
  systemPrompt += '\nRemote embodiment rule: WeChat, Feishu, and WeCom are transport channels into the same Lumi runtime. Do not claim that a remote channel inherently cannot reach the desktop. A no-client result for one data scope proves only that the scoped device route did not match; report that exact fact and check the personal/work scope before inferring that the desktop client is offline.';
  systemPrompt += '\nRemote memory rule: authenticated personal remote chat participates in the same personal memory system. Organization turns remain organization-scoped. Do not ask the user to repeat an explicit relationship or trust statement merely to make it memorable, and do not claim a memory was stored unless the memory pipeline accepted it.';
  systemPrompt += '\nRemote reply layout rule: make replies easy to scan in mobile chat. Use short paragraphs of 2-4 sentences separated by a blank line. For multiple points, use brief numbered labels or bullet lines. Do not send a dense wall of text.';
  if (explicitRemoteMemoryIds.length > 0) {
    systemPrompt += '\nCurrent-turn memory receipt: the explicit personal relationship/trust statement was accepted into durable personal memory. You may acknowledge that fact naturally; do not expose internal memory IDs.';
  }
  if (priorRuntimeEvidence) systemPrompt += `\n\n${priorRuntimeEvidence}`;
  if (pendingConfirmationPrompt) systemPrompt += `\n\n${pendingConfirmationPrompt}`;
  systemPrompt += `\n\n${buildResponseLanguageInstruction(requestText)}`;

  const userLLMPrefs = {
    ...getUserPreferredLLMConfig(effectiveUserId, { domain, orgId, maxTokens: 4096, source }),
    inputTokenBudget: resolveModelRequestInputBudget(),
    signal: actionAbortController.signal,
  };
  const messages: NormalizedMessage[] = [
    { role: 'system', content: systemPrompt },
    ...conversationHistory.map(item => ({
      role: item.role === 'assistant' ? 'assistant' as const : 'user' as const,
      content: item.content,
    })),
    { role: 'user', content: [msg.text, pendingConfirmationPrompt].filter(Boolean).join('\n\n') },
  ];
  let pendingConfirmationCreatedThisTurn: Awaited<ReturnType<typeof recordPendingConfirmationDurably>> | null = null;
  const requestToolConfirmation = async (
    toolName: string,
    args: Record<string, any>,
  ): Promise<boolean> => {
    if (actionWasCancelled()) return false;
    if (
      pendingConfirmation
      && confirmationScope
      && await consumePendingConfirmationDurably(
        effectiveUserId,
        pendingConfirmation.id,
        toolName,
        args,
        confirmationScope,
      )
    ) {
      console.log(`[Messaging] Consumed one-time ${source} confirmation for "${toolName}".`);
      return true;
    }
    if (canAutoApproveAction(toolName, args, { actionIntent: requestText })) return true;
    if (pendingConfirmationCreatedThisTurn) return false;
    if (!confirmationChannelScope) return false;
    const pending = await recordPendingConfirmationDurably(
      effectiveUserId,
      toolName,
      args,
      source,
      {
        domain,
        orgId,
        channelId: confirmationChannelScope.channelId,
        taskId: actionTaskExecution.state?.taskId,
        originRequestId: requestId,
        actionIntent: requestText,
      },
    );
    pendingConfirmationCreatedThisTurn = pending;
    if (conversation) {
      setConversationActionExecutionStatus(conversation.id, effectiveUserId, 'waiting_confirmation', {
        assistantState: formatPendingConfirmationRequest(pending),
        requestId,
      });
    }
    console.warn(`[Messaging] Tool "${toolName}" is waiting for scoped ${source} confirmation ${pending.id}.`);
    return false;
  };
  const settleRemoteTask = (fallbackBlocker?: string) => {
    if (!conversation || !actionTaskExecution.state?.taskId) return;
    if (fallbackBlocker) {
      settleConversationActionExecutionRequest(
        conversation.id,
        effectiveUserId,
        requestId,
        fallbackBlocker,
      );
    } else {
      settleConversationActionExecutionRequest(conversation.id, effectiveUserId, requestId);
    }
  };

  try {
    const usageInteractionId = `messaging_${msg.platform}_${Date.now()}`;
    let responseText = '';
    let toolRecords: ToolExecutionRecord[] = [];
    let callbackReply: Awaited<ReturnType<MessageHandler>> | null = null;
    const callbackBlockedForExternalCommit = Boolean(
      options?.onMessage && organizationWorkRoute?.workItem.sideEffectClass === 'external_commit',
    );
    // The legacy handler returns only prose and cannot produce a canonical tool
    // envelope. Never let it execute an external commit; those actions must go
    // through the receipt-producing tool route and its exact confirmation gate.
    if (options?.onMessage && !callbackBlockedForExternalCommit) {
      callbackReply = await options.onMessage(msg);
      throwIfActionLeaseWasLost();
    }
    let deterministicEntryReply: string | null = callbackReply?.text
      || (callbackBlockedForExternalCommit
        ? (/[㐀-鿿]/u.test(routingText)
          ? '外部提交已停止：旧消息回调不能生成统一工具回执，请改由受确认和回执约束的工具执行。'
          : 'The external commit was stopped because the legacy message callback cannot produce a canonical tool receipt. Use the confirmed tool route instead.')
        : null);
    if (deterministicEntryReply) responseText = deterministicEntryReply;

    if (isIdentityBound && directlyAppliedMode && !deterministicEntryReply) {
      const modeRecord = await executeToolCall({
        registry: toolRegistry,
        id: `${requestId}:client-mode`,
        name: 'client_action',
        arguments: {
          action: 'set_client_mode',
          mode: directlyAppliedMode,
          // Confirmation authority comes from ToolContext/requestConfirmation,
          // never from a model- or route-authored boolean argument.
          confirmed: false,
        },
        context: {
          userId: effectiveUserId,
          taskId: actionTaskExecution.state?.taskId,
          conversationId: conversation?.id,
          turnId: msg.messageId,
          requestId,
          domain,
          orgId,
          actionIntent: requestText,
          routedTaskText: routingText,
          supervisedExternalCommits: true,
          toolPolicy: modelToolPolicy,
          source,
          llmGetters: llm as any,
          desktopRelay,
          personalDesktopRelay,
          desktopExecutionTracker,
          isCancelled: actionWasCancelled,
          requestConfirmation: requestToolConfirmation,
        },
      });
      throwIfActionLeaseWasLost();
      toolRecords.push(modeRecord);
      const modeSynced = !modeRecord.error && desktopRelayReportedSuccess(modeRecord.result);
      if (modeSynced) saveStoredOperationMode(effectiveUserId, directlyAppliedMode);

      if (isPureOperationModeSwitchRequest(requestText, provisionalPlan.dispatch.flow.requestedMode)) {
        const candidate = pendingConfirmationCreatedThisTurn
          ? formatPendingConfirmationRequest(pendingConfirmationCreatedThisTurn)
          : formatOperationModeSwitchResponse(directlyAppliedMode, modeSynced, requestText);
        const modeOutbound = await finalizeMessagingResponseForDelivery({
          taskText: routingText,
          responseText: candidate,
          toolRecords: taskAwareRecords(toolRecords),
          source,
          flow: turnFlow,
          pendingConfirmation: Boolean(pendingConfirmationCreatedThisTurn),
          isPendingConfirmation: () => Boolean(pendingConfirmationCreatedThisTurn),
        });
        const finalizedMode = modeOutbound.finalization;
        toolRecords = withDesktopExecutionReceipt(modeOutbound.toolRecords, desktopExecutionTracker);
        const correlated = correlateMessagingReply(msg, finalizedMode.text);
        if (correlated.superseded) {
          settleRemoteTask('The remote turn was superseded by a newer user message.');
          await flushTerminalReply();
          return '';
        }
        persistBoundMessagingMessage(
          msg,
          'assistant',
          correlated.text,
          options?.onConversationUpdated,
          toolRecords,
        );
        if (pendingConfirmationCreatedThisTurn && conversation) {
          setConversationActionExecutionStatus(conversation.id, effectiveUserId, 'waiting_confirmation', {
            assistantState: formatPendingConfirmationRequest(pendingConfirmationCreatedThisTurn),
            requestId,
          });
        }
        settleRemoteTask();
        await flushTerminalReply();
        return correlated.text;
      }
    }

    if (!deterministicEntryReply && isOrganizationBound) {
      deterministicEntryReply = await handleRemoteLegalNoticeIntake(msg)
        || await handleRemoteOrgCommand(msg);
      if (deterministicEntryReply) {
        responseText = deterministicEntryReply;
        toolRecords.push({
          id: `${requestId}:organization-command`,
          taskId: actionTaskExecution.state?.taskId,
          turnId: msg.messageId,
          requestId,
          idempotencyKey: `${organizationWorkRoute?.workItem.id || requestId}:organization-command`,
          name: 'organization_business_command',
          arguments: {
            source,
            requestId,
            workItemId: organizationWorkRoute?.workItem.id || '',
          },
          result: JSON.stringify({
            ok: true,
            verified: true,
            status: 'completed',
            verificationMethod: 'organization-server-transaction',
            workItemId: organizationWorkRoute?.workItem.id || '',
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
            taskId: actionTaskExecution.state?.taskId || '',
            turnId: msg.messageId,
            requestId,
            idempotencyKey: `${organizationWorkRoute?.workItem.id || requestId}:organization-command`,
            targetIdentity: orgId,
            completedAt: new Date().toISOString(),
            result: {
              workItemId: organizationWorkRoute?.workItem.id || '',
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

    const orchestrationContext = {
      userId: effectiveUserId,
      personalityId: personality?.id || 'lumi',
      domain,
      orgId,
      conversationId: conversation?.id,
      turnId: msg.messageId,
      requestId,
      availableAgentIds: organizationWorkRoute?.workItem.assignedAgentIds.length
        ? organizationWorkRoute.workItem.assignedAgentIds
        : undefined,
      desktopRelay,
      personalDesktopRelay,
      toolPolicy: modelToolPolicy,
      rootTaskText: routingText,
      taskId: actionTaskExecution.state?.taskId,
      desktopExecutionTracker,
      requestConfirmation: requestToolConfirmation,
      supervisedExternalCommits: isIdentityBound,
      isCancelled: actionWasCancelled,
    };
    const complexity = classifyComplexity(routingText, orchestrationContext);
    const shouldOrchestrate = isIdentityBound && shouldAttemptOrchestration({
      channel: 'chat',
      text: turnFlow.routeText,
      complexity,
      allowToolUse: executionDecision.allowToolUse,
      clientActionOnly: turnFlow.clientActionOnlyTurn,
      selfRepair: turnFlow.selfRepairTurn,
      artifactFirst: turnFlow.workSurfaceRoute.artifactFirst,
      directDesktop: turnFlow.workSurfaceRoute.directDesktop,
      prefersSequentialWorkflow: turnFlow.workSurfaceRoute.artifactFirst
        && !turnFlow.workSurfaceRoute.directDesktop,
      capabilityLane: capabilitySelection.lane,
      cognitionCategory: executionPlan.normalizedIntent.kind,
    });
    let usedOrchestrator = Boolean(deterministicEntryReply);
    if (shouldOrchestrate && !usedOrchestrator) {
      const recovery = conversation && actionTaskExecution.state?.taskId
        ? getConversationModelExecutionRecovery({
            conversationId: conversation.id,
            userId: effectiveUserId,
            taskId: actionTaskExecution.state.taskId,
          })
        : null;
      const orchestrated = await runOrchestratedTask(
        routingText,
        {
          ...orchestrationContext,
          resumeNodeReceipts: recovery?.receipts,
          resumeExecutionGraph: recovery?.graph,
        },
        {
          ...userLLMPrefs,
          conversationId: conversation?.id,
          requestId,
          interactionId: usageInteractionId,
          source,
        },
        {
          getDeepSeek: llm?.getDeepSeek || (() => null),
          getGemini: llm?.getGemini || (() => null),
          getOpenAI: llm?.getOpenAI,
          getAnthropic: llm?.getAnthropic,
          getQwen: llm?.getQwen,
          getOllama: llm?.getOllama,
          getLmStudio: llm?.getLmStudio,
          getArk: llm?.getArk,
          getXiaomi: llm?.getXiaomi,
          getKimi: llm?.getKimi,
          getGlm: llm?.getGlm,
          getRelay: llm?.getRelay,
        },
        undefined,
        record => {
          if (!isTerminalOrchestrationToolEvent(record)) return;
          toolRecords.push({ ...record, result: record.result || '' });
        },
      );
      if (orchestrated) {
        usedOrchestrator = true;
        responseText = orchestrated.responseText;
        if (conversation && actionTaskExecution.state?.taskId) {
          persistConversationModelExecutionResult({
            conversationId: conversation.id,
            userId: effectiveUserId,
            taskId: actionTaskExecution.state.taskId,
            workflowResult: orchestrated.workflowResult,
          });
        }
      }
    }

    const runMessagingToolTurn = (
      turnMessages: NormalizedMessage[],
      onToolRecord?: (record: ToolExecutionRecord) => void,
      executionSource = source,
    ) => runWithTools(
      turnMessages,
      toolRegistry,
      userLLMPrefs,
      onToolRecord,
      modelToolPolicy.maxIterations || executionDecision.maxIterations,
      llm?.getDeepSeek,
      llm?.getGemini,
      llm?.getOpenAI,
      llm?.getAnthropic,
      llm?.getQwen,
      undefined,
      {
        userId: effectiveUserId,
        taskId: actionTaskExecution.state?.taskId,
        conversationId: conversation?.id,
        turnId: msg.messageId,
        requestId,
        domain,
        orgId,
        actionIntent: requestText,
        routedTaskText: routingText,
        supervisedExternalCommits: isIdentityBound,
        toolPolicy: modelToolPolicy,
        modelToolProjection,
        source: executionSource,
        llmGetters: llm as any,
        desktopRelay,
        personalDesktopRelay,
        desktopExecutionTracker,
        isCancelled: actionWasCancelled,
        requestConfirmation: requestToolConfirmation,
      },
      llm?.getOllama,
      llm?.getLmStudio,
      llm?.getArk,
      llm?.getXiaomi,
      llm?.getKimi,
      llm?.getGlm,
      llm?.getRelay,
    );

    if (!usedOrchestrator && !executionDecision.allowToolUse) {
      const response = await makeLLMCall(
        messages,
        [],
        userLLMPrefs,
        llm?.getDeepSeek || (() => null),
        llm?.getGemini || (() => null),
        llm?.getOpenAI,
        llm?.getAnthropic,
        llm?.getQwen,
        llm?.getOllama,
        llm?.getLmStudio,
        llm?.getArk,
        llm?.getXiaomi,
        llm?.getKimi,
        llm?.getGlm,
        llm?.getRelay,
      );
      responseText = response.text || '';
      if (response.usage) {
        recordTokenUsage(effectiveUserId, userLLMPrefs.provider, userLLMPrefs.model, response.usage, usageInteractionId, 'chat');
      }
    } else if (!usedOrchestrator) {
      const result = await runMessagingToolTurn(messages);
      responseText = result.text || '';
      toolRecords.push(...(result.toolCalls || []));
      for (const usage of result.usageRecords || []) {
        recordTokenUsage(effectiveUserId, usage.provider, usage.model, usage, usageInteractionId, 'chat');
      }
    }

    toolRecords = withDesktopExecutionReceipt(toolRecords, desktopExecutionTracker);
    if (pendingConfirmationCreatedThisTurn) {
      responseText = formatPendingConfirmationRequest(pendingConfirmationCreatedThisTurn);
    }
    const deliveryText = responseText || '这次没有生成可用回复，请稍后重试。';
    const preDeliveryRecords = taskAwareRecords(toolRecords);
    const organizationVerifiedTerminalReceipt = preDeliveryRecords.some(record => {
      const verified = record.envelope?.status === 'verified_success'
        || record.terminalVerification?.status === 'verified';
      if (!verified) return false;
      if (organizationWorkRoute?.workItem.sideEffectClass !== 'external_commit') return true;
      return Boolean(record.capability?.sideEffects?.some(effect => (
        effect.type === 'external_communication' || effect.type === 'external_state_change'
      ))) || /(?:send|submit|publish|post|comment|reply|payment|purchase|sign)/i.test(record.name);
    });
    const missingOrganizationExternalCommitReceipt = organizationWorkRoute?.workItem.sideEffectClass === 'external_commit'
      && !pendingConfirmationCreatedThisTurn
      && !organizationVerifiedTerminalReceipt;
    const initialFinalization: MessagingFinalization = callbackReply
      && organizationWorkRoute?.workItem.sideEffectClass !== 'external_commit'
      ? { text: responseText || callbackReply.text, blocked: false }
      : missingOrganizationExternalCommitReceipt
        ? {
        text: /[\u3400-\u9fff]/u.test(routingText)
          ? '这次外部提交还没有完成：没有收到可验证的终态回执，Lumi 已停止，且不会盲目重试。'
          : 'The external commit is not complete: no verified terminal receipt was received, so Lumi stopped and will not retry blindly.',
        blocked: true,
        reason: 'The external commit has no verified terminal receipt.',
          }
        : finalizeLumiResponse({
            taskText: routingText,
            responseText: deliveryText,
            toolRecords: preDeliveryRecords,
            source,
            flow: turnFlow,
          });
    const outbound = await finalizeMessagingResponseForDelivery({
      taskText: routingText,
      responseText: deliveryText,
      toolRecords: preDeliveryRecords,
      source,
      flow: turnFlow,
      initialFinalization,
      allowToolUse: executionDecision.allowToolUse
        && !callbackReply
        && !missingOrganizationExternalCommitReceipt,
      pendingConfirmation: Boolean(pendingConfirmationCreatedThisTurn),
      aborted: actionWasCancelled(),
      isPendingConfirmation: () => Boolean(pendingConfirmationCreatedThisTurn),
      isAborted: actionWasCancelled,
      attempt: async ({ instruction, recordTool }) => {
        const recovery = await runMessagingToolTurn(
          [
            ...messages,
            ...(deliveryText.trim()
              ? [{ role: 'assistant' as const, content: deliveryText }]
              : []),
            { role: 'user', content: instruction },
          ],
          recordTool,
          `${source}_guard_recovery`,
        );
        for (const usage of recovery.usageRecords || []) {
          recordTokenUsage(
            effectiveUserId,
            usage.provider,
            usage.model,
            usage,
            usageInteractionId,
            'chat',
          );
        }
        return {
          text: recovery.text,
          toolRecords: withDesktopExecutionReceipt(
            recovery.toolCalls || [],
            desktopExecutionTracker,
          ),
        };
      },
      refinalize: (candidateText, records) => pendingConfirmationCreatedThisTurn
        ? {
            text: formatPendingConfirmationRequest(pendingConfirmationCreatedThisTurn),
            blocked: false,
            reason: 'waiting_confirmation',
          }
        : finalizeLumiResponse({
            taskText: routingText,
            responseText: candidateText,
            toolRecords: withDesktopExecutionReceipt(records, desktopExecutionTracker),
            source: `${source}_guard_recovery`,
            flow: turnFlow,
          }),
    });
    toolRecords = withDesktopExecutionReceipt(outbound.toolRecords, desktopExecutionTracker);
    const finalized = outbound.finalization;
    if (actionLeaseWasLost()) {
      await actionLeaseHeartbeat!.leaseLoss;
      return CN_TASK_EXECUTION_MESSAGES.persistenceUnknown;
    }
    const correlated = correlateMessagingReply(msg, finalized.text);
    if (correlated.superseded) {
      if (organizationWorkRoute) {
        setOrganizationWorkItemExecutionStatus({
          orgId,
          workItemId: organizationWorkRoute.workItem.id,
          status: 'cancelled',
          actorUserId: effectiveUserId,
          blocker: 'The remote turn was superseded by a newer user message.',
        });
      }
      settleRemoteTask('The remote turn was superseded by a newer user message.');
      await flushTerminalReply();
      return '';
    }
    persistBoundMessagingMessage(msg, 'assistant', correlated.text, options?.onConversationUpdated, toolRecords);
    if (pendingConfirmationCreatedThisTurn && conversation) {
      setConversationActionExecutionStatus(conversation.id, effectiveUserId, 'waiting_confirmation', {
        assistantState: formatPendingConfirmationRequest(pendingConfirmationCreatedThisTurn),
        requestId,
      });
    }
    if (organizationWorkRoute) {
      const organizationStatus = pendingConfirmationCreatedThisTurn || finalized.blocked || missingOrganizationExternalCommitReceipt
        ? 'blocked'
        : 'completed';
      const organizationBlocker = pendingConfirmationCreatedThisTurn
        ? 'The user action confirmation is still pending.'
        : missingOrganizationExternalCommitReceipt
          ? 'The external commit has no verified terminal receipt.'
          : finalized.reason;
      setOrganizationWorkItemExecutionStatus({
        orgId,
        workItemId: organizationWorkRoute.workItem.id,
        status: organizationStatus,
        actorUserId: effectiveUserId,
        blocker: organizationBlocker,
      });
      if (organizationStatus === 'blocked' && conversation) {
        setConversationActionExecutionStatus(conversation.id, effectiveUserId, 'blocked', {
          blocker: organizationBlocker,
          requestId,
        });
      }
    }
    settleRemoteTask();
    await flushTerminalReply();
    try {
      persistRemotePostTurnLearning({
        message: msg,
        responseText: correlated.text,
        llmGetters: llm,
        modelConfig: {
          provider: userLLMPrefs.provider,
          model: userLLMPrefs.model,
        },
      });
    } catch (learningError: any) {
      console.warn('[Messaging] Remote post-turn learning could not be scheduled:', learningError?.message || learningError);
    }
    return correlated.text;
  } catch (err: any) {
    if (actionLeaseWasLost()) {
      await actionLeaseHeartbeat!.leaseLoss;
      return CN_TASK_EXECUTION_MESSAGES.persistenceUnknown;
    }
    if (isMessagingReplyDurabilityError(err)) throw err;
    console.warn(`[Messaging] ${msg.platform} model pipeline failed:`, err?.message || err);
    const fallback = '当前语言模型暂时不可用，这次处理没有完成，请稍后再试。';
    const correlated = correlateMessagingReply(msg, fallback);
    if (correlated.superseded) {
      if (organizationWorkRoute) {
        setOrganizationWorkItemExecutionStatus({
          orgId,
          workItemId: organizationWorkRoute.workItem.id,
          status: 'cancelled',
          actorUserId: effectiveUserId,
          blocker: 'The remote turn failed after it was superseded by a newer user message.',
        });
      }
      settleRemoteTask('The remote turn failed after it was superseded by a newer user message.');
      await flushTerminalReply();
      return '';
    }
    if (isIdentityBound) {
      persistBoundMessagingMessage(msg, 'assistant', correlated.text, options?.onConversationUpdated);
    }
    if (organizationWorkRoute) {
      setOrganizationWorkItemExecutionStatus({
        orgId,
        workItemId: organizationWorkRoute.workItem.id,
        status: 'blocked',
        actorUserId: effectiveUserId,
        blocker: err?.message || 'The remote model/tool pipeline failed before a terminal receipt was recorded.',
      });
    }
    settleRemoteTask(err?.message || 'The remote model/tool pipeline failed before a terminal receipt was recorded.');
    await flushTerminalReply();
    return correlated.text;
  }
  } finally {
    actionLeaseHeartbeat?.stop();
  }
}

// ═══════════════════════════════════════════════════════════════════
// Enterprise WeChat (企业微信) Routes
// ═══════════════════════════════════════════════════════════════════

import { WeComAdapter, type WeComConfig } from '../../../messaging/wecom';

export function createWeComRoutes(
  config: WeComConfig,
  options?: MessagingRouteOptions,
): Router {
  const router = Router();
  const adapter = new WeComAdapter(config);

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

      // Respond IMMEDIATELY (WeCom requires < 5s)
      res.type('text/plain').send('success');

      dispatchIncomingMessage(msg, {
        enrich: message => enrichWeComAttachments(message, adapter),
        reply: async (message, text) => {
          await adapter.sendMessage(message.chatId, { text, platform: 'wecom' });
        },
      }, options);
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
