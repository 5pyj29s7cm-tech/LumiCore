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
import { FeishuAdapter } from './feishu';
import type { FeishuConfig } from './feishu';
import type { IncomingAttachment, IncomingMessage, MessageHandler } from './types';
import { getMessagingConfig, updateMessagingConfig } from './config';
import {
  consumeBindingCode,
  createBindingCode,
  deleteBindingForUser,
  getBinding,
  listBindingsForUser,
  parseMessagingBindingCommand,
} from './bindings';
import { readDB } from '../../db_layer';
import { requireAuth } from '../middleware/auth';
import { getDataPath } from '../config/data_path';
import { parseDocument } from '../legal/parser';
import { getMember } from '../org/db';
import * as OrgKB from '../org/kb';
import * as LegalCases from '../org/legal_cases';
import { handleRemoteLegalNoticeIntake } from './legal_notice_intake';
import { getUserPreferredLLMConfig } from '../llm/user_preferences';
import { addMessage, getMessagesByTokenBudget, getOrCreateActiveConversation } from '../conversation/manager';
import { acceptMessageOnce, completeMessageDelivery, releaseMessageDelivery } from './delivery_ledger';
import { runWithTools } from '../llm/adapter';
import { toolRegistry } from '../tools/registry';
import { buildUnifiedLegalEntryPrompt } from '../cognition/legal_entry';
import { finalizeLumiResponse } from '../cognition/result_finalizer';
import { recordTokenUsage } from '../llm/token_tracker';
import type { ToolPolicy } from '../personality/types';
import type { NormalizedMessage } from '../llm/providers';
import { requestsOrganizationScope, resolvePersonalOrganizationScope } from './personal_org_scope';

const messageRouteQueues = new Map<string, Promise<void>>();
const MAX_MESSAGING_ATTACHMENT_BYTES = 25 * 1024 * 1024;

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
  createPersonalDesktopRelay?: (userId: string, source: string) => (toolName: string, args: Record<string, any>) => Promise<string>;
}

export interface MessagingConversationUpdate {
  userId: string;
  domain: 'personal' | 'work';
  orgId: string;
  conversationId: string;
  agentId: string;
  source: string;
}

export interface IncomingMessageTransport {
  enrich: (message: IncomingMessage) => Promise<IncomingMessage>;
  reply: (message: IncomingMessage, text: string) => Promise<void>;
}

function messageRouteKey(message: IncomingMessage): string {
  return [
    message.platform,
    message.boundOrgId || 'unbound',
    message.boundUserId || 'anonymous',
    message.userId,
    message.chatType,
    message.chatId,
    message.threadId || 'main',
  ].join(':');
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

export function persistBoundMessagingExchange(
  message: IncomingMessage,
  reply: string,
  onConversationUpdated?: MessagingRouteOptions['onConversationUpdated'],
): MessagingConversationUpdate | null {
  persistBoundMessagingMessage(message, 'user', getDisplayText(message));
  return persistBoundMessagingMessage(message, 'assistant', reply, onConversationUpdated);
}

export function persistBoundMessagingMessage(
  message: IncomingMessage,
  role: 'user' | 'assistant',
  content: string,
  onConversationUpdated?: MessagingRouteOptions['onConversationUpdated'],
): MessagingConversationUpdate | null {
  if (!message.boundUserId) return null;
  const agentId = messagingConversationAgentId(message);
  const domain = message.boundOrgId ? 'work' as const : 'personal' as const;
  const orgId = message.boundOrgId || '';
  const conversation = getOrCreateActiveConversation(message.boundUserId, agentId, domain, orgId);
  addMessage({
    userId: message.boundUserId,
    agentId,
    conversationId: conversation.id,
    role,
    content,
    domain,
    orgId,
  });
  const update: MessagingConversationUpdate = {
    userId: message.boundUserId,
    domain,
    orgId,
    conversationId: conversation.id,
    agentId,
    source: `${message.platform}_bot`,
  };
  onConversationUpdated?.(update);
  return update;
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

      const msg = adapter.parseEvent(body);
      if (!msg) {
        return res.json({ code: 0 });
      }

      console.log(`[Feishu] Received ${msg.chatType} message ${msg.messageId}`);

      // Respond to Feishu IMMEDIATELY (must be < 1s), process AI reply async
      res.json({ code: 0 });
      dispatchIncomingMessage(msg, {
        enrich: message => enrichFeishuAttachments(message, adapter),
        reply: async (message, text) => {
          await adapter.replyMessage(message.messageId, text).catch(() =>
            adapter.sendMessage(message.chatId, { text, platform: 'feishu' }));
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

      let messageId: string;
      if (card) {
        messageId = await adapter.sendCard(chatId, card);
      } else {
        messageId = await adapter.sendMessage(chatId, { text, platform: 'feishu' });
      }

      res.json({ success: true, messageId });
    } catch (err: any) {
      console.error('[Feishu] Send error:', err.message);
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

function handleMessagingBindingCommand(msg: IncomingMessage): string | null {
  if (msg.platform !== 'feishu' && msg.platform !== 'wecom') return null;
  const command = parseMessagingBindingCommand(msg.text);
  if (!command) return null;
  if (command.kind === 'status') {
    const current = getBinding(msg.platform, msg.userId, msg.chatId, msg.chatType);
    if (!current) {
      return `当前${remotePlatformLabel(msg.platform)}身份尚未绑定 Lumi。请在组织工作台生成一次性绑定码后发送“绑定 Lumi 绑定码”。`;
    }
    const membership = getMember(current.orgId, current.lumiUserId);
    if (!membership || membership.status !== 'active') {
      return '已找到绑定记录，但对应组织成员权限已经失效。请在 Lumi 中恢复成员权限或重新绑定。';
    }
    return `绑定状态已核验：当前${msg.chatType === 'group' ? '群成员身份' : '会话身份'}已连接到 Lumi 组织工作域。`;
  }
  if (command.kind === 'invalid') {
    return `绑定命令格式不完整。请原样发送“绑定 Lumi 绑定码”，或在 Lumi 桌面端重新生成${remotePlatformLabel(msg.platform)}绑定码。`;
  }
  const binding = consumeBindingCode(msg.platform, command.code, msg.userId, msg.chatId, msg.chatType);
  if (!binding) {
    return `绑定码无效或已过期。请在 Lumi 桌面端重新生成${remotePlatformLabel(msg.platform)}绑定码。`;
  }
  return msg.chatType === 'group'
    ? '绑定成功。你在这个群里的消息会按你的 Lumi 身份和组织权限独立路由；其他成员仍需分别绑定，不会共享你的权限或对话。'
    : '绑定成功。这个会话现在会按所选组织和你的 Lumi 身份路由；可以查询组织知识库、查询案件，或发送案件文件归档。';
}

function applyMessagingBinding(msg: IncomingMessage): IncomingMessage {
  if (msg.platform !== 'feishu' && msg.platform !== 'wecom') return msg;
  const binding = getBinding(msg.platform, msg.userId, msg.chatId, msg.chatType);
  if (!binding) return msg;
  const membership = getMember(binding.orgId, binding.lumiUserId);
  if (!membership || membership.status !== 'active') return msg;
  return {
    ...msg,
    boundUserId: binding.lumiUserId,
    boundOrgId: binding.orgId,
  };
}

export function dispatchIncomingMessage(
  message: IncomingMessage,
  transport: IncomingMessageTransport,
  options?: MessagingRouteOptions,
): boolean {
  try {
    if (!acceptMessageOnce(message.platform, message.messageId)) {
      console.log(`[Messaging] Ignoring duplicate ${message.platform} message: ${message.messageId}`);
      return false;
    }
  } catch (err: any) {
    console.warn('[Messaging] Delivery ledger unavailable; continuing with this message:', err?.message || err);
  }

  setImmediate(() => {
    void (async () => {
      const bindingReply = handleMessagingBindingCommand(message);
      if (bindingReply) {
        await transport.reply(message, bindingReply);
        return;
      }

      const boundMessage = applyMessagingBinding(message);
      // Long-connection attachment URLs can expire within minutes. Download before
      // waiting behind another long-running task from the same conversation.
      const enrichedMessage = await transport.enrich(boundMessage);
      await enqueueMessageRoute(enrichedMessage, async () => {
        const legalNoticeReply = await handleRemoteLegalNoticeIntake(enrichedMessage);
        if (legalNoticeReply) {
          persistBoundMessagingExchange(enrichedMessage, legalNoticeReply, options?.onConversationUpdated);
          await transport.reply(enrichedMessage, legalNoticeReply);
          return;
        }

        const scope = resolvePersonalOrganizationScope(
          enrichedMessage,
          requestsOrganizationScope(getRequestText(enrichedMessage)),
        );
        if (scope.kind === 'reply') {
          persistBoundMessagingExchange(scope.message, scope.reply, options?.onConversationUpdated);
          await transport.reply(scope.message, scope.reply);
          return;
        }
        const routedMessage = scope.message;

        const remoteOrgReply = await handleRemoteOrgCommand(routedMessage);
        if (remoteOrgReply) {
          persistBoundMessagingExchange(routedMessage, remoteOrgReply, options?.onConversationUpdated);
          await transport.reply(routedMessage, remoteOrgReply);
          return;
        }

        if (options?.onMessage) {
          const reply = await options.onMessage(routedMessage);
          if (reply) {
            persistBoundMessagingExchange(routedMessage, reply.text, options?.onConversationUpdated);
            await transport.reply(routedMessage, reply.text);
          }
          return;
        }

        const replyText = await processWithPersonality(routedMessage, options);
        await transport.reply(routedMessage, replyText);
      });
    })().then(() => {
      completeMessageDelivery(message.platform, message.messageId);
    }).catch(async (err: any) => {
      releaseMessageDelivery(message.platform, message.messageId);
      console.error(`[Messaging] ${message.platform} route failed:`, err?.message || err);
      await transport.reply(message, '这次处理没有完成，请稍后重试。').catch(() => undefined);
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

function fallbackKnowledgeSearch(orgId: string, query: string, limit: number) {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  return OrgKB.listArticles(orgId, { status: 'published' })
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

async function searchOrgKnowledge(orgId: string, query: string, limit = 5) {
  const q = query.trim();
  if (!q) return [];
  const semantic = await OrgKB.searchKnowledgeBase(orgId, q, limit);
  return semantic.length > 0 ? semantic : fallbackKnowledgeSearch(orgId, q, limit);
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
    const results = await searchOrgKnowledge(msg.boundOrgId!, query, 6);
    return formatKbExtraction(results, query);
  }

  const wantsCaseExtraction = /(提取|调取|获取|查看|查询|查找|整理|总结|摘要|列出|读取).*(案件|案号|卷宗|案情|材料|证据)|(案件|案号|卷宗).*(提取|调取|获取|查看|整理|总结|摘要|材料|证据|关键日期|时间线|资料|信息)/.test(requestText);
  if (wantsCaseExtraction) {
    const query = stripExtractionQuery(requestText, 'case');
    const cases = query
      ? LegalCases.listCases(msg.boundOrgId!, query, 5)
      : LegalCases.listCases(msg.boundOrgId!, '', 5);
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
      searchOrgKnowledge(msg.boundOrgId!, query, 4),
      Promise.resolve(LegalCases.listCases(msg.boundOrgId!, query, 3)),
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
    const results = await searchOrgKnowledge(msg.boundOrgId, query, 5);
    return formatKbResults(results);
  }

  if (/(查|搜|找|检索|搜索).*(案件|案号|材料|卷宗)|案件.*(在哪|有没有|列表)/.test(requestText)) {
    const query = requestText.replace(/(查|搜|找|检索|搜索)?\s*(组织)?\s*(案件|案号|材料|卷宗)/g, '').trim();
    const cases = LegalCases.listCases(msg.boundOrgId, query, 8);
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
    const targetCases = target ? LegalCases.listCases(msg.boundOrgId, target, 3) : [];
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
      const refreshed = LegalCases.getCase(msg.boundOrgId, targetCase.id) || targetCase;
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
    const refreshed = LegalCases.getCase(msg.boundOrgId, caseFile.id) || caseFile;
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

export async function processWithPersonality(
  msg: IncomingMessage,
  options?: MessagingRouteOptions,
): Promise<string> {
  const llm = options?.llmGetters;
  const requestText = getRequestText(msg);
  const registry = options?.personalityRegistry;
  const isIdentityBound = Boolean(msg.boundUserId);
  const isOrganizationBound = Boolean(msg.boundUserId && msg.boundOrgId);
  const effectiveUserId = isIdentityBound ? msg.boundUserId! : 'anonymous';
  const domain = isOrganizationBound ? 'work' as const : 'personal' as const;
  const orgId = isOrganizationBound ? msg.boundOrgId! : '';
  const organizationMembership = isOrganizationBound ? getMember(orgId, effectiveUserId) : null;
  const canWriteOrganization = organizationMembership?.status === 'active' && organizationMembership.role !== 'viewer';
  const conversationAgentId = messagingConversationAgentId(msg);
  const conversation = isIdentityBound
    ? getOrCreateActiveConversation(effectiveUserId, conversationAgentId, domain, orgId)
    : null;
  const priorMessages = conversation
    ? getMessagesByTokenBudget(conversation.id, 6000, 8)
    : [];
  const conversationHistory = priorMessages.flatMap((item: any) => {
    const content = String(item.message || item.content || '').trim();
    const response = String(item.response || '').trim();
    if (item.role === 'assistant') return content ? [{ role: 'assistant', content }] : [];
    if (item.role === 'user') {
      return [
        ...(content ? [{ role: 'user', content }] : []),
        ...(response ? [{ role: 'assistant', content: response }] : []),
      ];
    }
    return [];
  }).slice(-16);

  if (isIdentityBound) {
    persistBoundMessagingMessage(msg, 'user', getDisplayText(msg), options?.onConversationUpdated);
  }

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
        { mode: 'chat', sensory: { hasAudio: false, hasVideo: false, hasSpatial: false, hasHaptic: false, hasHolographic: false, activeDeviceTypes: [], deviceCount: 0 } },
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
      console.warn('[Feishu] Personality build failed, using fallback:', err.message);
    }
  }

  if (!systemPrompt) {
    systemPrompt = `你是一个名为 Lumi 的 AI 助手，通过${remotePlatformLabel(msg.platform)}与用户交流。保持回复简洁、有帮助、自然。`;
  }
  if (isOrganizationBound) {
    systemPrompt += `\n\n当前${remotePlatformLabel(msg.platform)}会话已由同一个个人 Lumi 进入组织工作域，组织 ID 为 ${orgId}，成员角色为 ${organizationMembership?.role || 'unknown'}。本轮只使用该组织的工作记忆和数据，不把组织内容自动写回个人记忆。你可以基于本轮消息和已提供的附件内容进行分析；查询组织知识库、查询/归档案件由服务端安全工具处理。不要声称已经写入组织数据，除非工具结果明确说明已完成。涉及法律材料时必须提醒最终由执业律师确认。`;
  } else if (isIdentityBound) {
    systemPrompt += `\n\n当前${remotePlatformLabel(msg.platform)}用户已绑定到个人 Lumi，本轮仍处于个人域。使用该用户的个人身份、人格与个人对话记忆，并把本轮收发同步到个人 Lumi 聊天。个人 Lumi 可以在用户明确选择组织、唯一组织任务或已保持的组织会话作用域下进入有权限的组织，但服务器没有为本轮解析出组织作用域，因此不要自行访问或声称访问组织数据。`;
  } else {
    systemPrompt += `\n\n当前${remotePlatformLabel(msg.platform)}用户尚未绑定 Lumi 身份。可以分析用户直接提供的文本/附件，但不要声称可以访问组织知识库、组织案件或本地私人数据。绑定状态只能由服务端绑定记录确认；即使用户自称“已经绑定”或要求你确认，也绝不能口头宣称绑定成功。`;
  }

  const legalEntryText = [
    requestText,
    ...(msg.attachments || []).flatMap(attachment => [attachment.fileName, attachment.extractedText || '']),
  ].filter(Boolean).join('\n');
  const legalOverlay = buildUnifiedLegalEntryPrompt({
    text: legalEntryText,
    domain,
    orgId,
    channel: msg.platform,
    source: `${msg.platform}_bot`,
  });
  if (legalOverlay) systemPrompt += `\n\n${legalOverlay}`;

  const commonRemoteTools = [
    'legal_search_statute',
    'legal_verify_citation',
    'legal_authority_source_status',
    'messaging_list_file_targets',
    'feishu_send_file',
  ];
  const organizationRemoteTools = [
    'legal_review_contract',
    'legal_draft_contract',
    'legal_search_case',
    'legal_case_workspace',
    'legal_case_workflow_status',
    'legal_case_reasoning_matrix',
    'legal_extract_dispute_focus',
    'legal_generate_argument_or_opinion',
    'legal_generate_litigation_packet',
    'legal_generate_bid',
    'legal_generate_citation_verification_report',
    'legal_finalize_delivery_package',
    'wechat_send_file',
  ];
  const personalityPolicy = personality?.toolPolicy as ToolPolicy | undefined;
  const allowedByPersonality = new Set(personalityPolicy?.allowedTools || ['*']);
  const forbiddenByPersonality = new Set(personalityPolicy?.forbiddenTools || []);
  const personalityForbidsAll = forbiddenByPersonality.has('*');
  const remoteAllowed = [...commonRemoteTools, ...(isOrganizationBound && canWriteOrganization ? organizationRemoteTools : [])]
    .filter(() => !personalityForbidsAll)
    .filter(name => !forbiddenByPersonality.has(name))
    .filter(name => allowedByPersonality.has('*') || allowedByPersonality.has(name));
  const remoteToolPolicy: ToolPolicy = {
    allowedTools: remoteAllowed,
    requireConfirmation: personalityPolicy?.requireConfirmation || [],
    forbiddenTools: [...forbiddenByPersonality],
    maxIterations: Math.min(3, personalityPolicy?.maxIterations || 3),
    securityOverrides: personalityPolicy?.securityOverrides,
  };

  const userLLMPrefs = getUserPreferredLLMConfig(effectiveUserId, { domain, orgId, maxTokens: 4096 });
  const messages: NormalizedMessage[] = [
    { role: 'system', content: systemPrompt },
    ...conversationHistory.map(item => ({
      role: item.role === 'assistant' ? 'assistant' as const : 'user' as const,
      content: item.content,
    })),
    { role: 'user', content: msg.text },
  ];

  try {
    const result = await runWithTools(
      messages,
      toolRegistry,
      userLLMPrefs,
      undefined,
      3,
      llm?.getDeepSeek,
      llm?.getGemini,
      llm?.getOpenAI,
      llm?.getAnthropic,
      llm?.getQwen,
      undefined,
      {
        userId: effectiveUserId,
        domain,
        orgId,
        actionIntent: requestText,
        supervisedExternalCommits: isIdentityBound,
        toolPolicy: remoteToolPolicy,
        source: `${msg.platform}_bot`,
        llmGetters: llm as any,
        personalDesktopRelay: isIdentityBound
          ? options?.createPersonalDesktopRelay?.(effectiveUserId, `${msg.platform}_bot`)
          : undefined,
      },
      llm?.getOllama,
      llm?.getLmStudio,
      llm?.getArk,
      llm?.getXiaomi,
      llm?.getKimi,
      llm?.getGlm,
      llm?.getRelay,
    );
    for (const usage of result.usageRecords || []) {
      recordTokenUsage(effectiveUserId, usage.provider, usage.model, usage, `messaging_${msg.platform}_${Date.now()}`, 'chat');
    }
    const finalized = finalizeLumiResponse({
      taskText: requestText,
      responseText: result.text || '这次没有生成可用回复，请稍后重试。',
      toolRecords: result.toolCalls,
      source: `${msg.platform}_bot`,
    });
    persistBoundMessagingMessage(msg, 'assistant', finalized.text, options?.onConversationUpdated);
    return finalized.text;
  } catch (err: any) {
    console.warn(`[Messaging] ${msg.platform} model pipeline failed:`, err?.message || err);
    const fallback = '当前语言模型暂时不可用，这次处理没有完成，请稍后再试。';
    if (isIdentityBound) {
      persistBoundMessagingMessage(msg, 'assistant', fallback, options?.onConversationUpdated);
    }
    return fallback;
  }
}

// ═══════════════════════════════════════════════════════════════════
// Enterprise WeChat (企业微信) Routes
// ═══════════════════════════════════════════════════════════════════

import { WeComAdapter, type WeComConfig } from './wecom';

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
