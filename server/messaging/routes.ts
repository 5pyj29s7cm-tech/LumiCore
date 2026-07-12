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

// Dedup cache: prevent duplicate processing when Feishu retries events
// Feishu retries if no 200 within 1s, but AI reply may take 5-30s
const recentMessages = new Map<string, number>();
const messageRouteQueues = new Map<string, Promise<void>>();
const DEDUP_TTL_MS = 5 * 60 * 1000; // 5 min
const MAX_FEISHU_ATTACHMENT_BYTES = 25 * 1024 * 1024;
function isDuplicate(platform: string, messageId: string): boolean {
  const now = Date.now();
  // Cleanup stale entries
  for (const [id, ts] of recentMessages) {
    if (now - ts > DEDUP_TTL_MS) recentMessages.delete(id);
  }
  const key = `${platform}:${messageId}`;
  if (recentMessages.has(key)) return true;
  recentMessages.set(key, now);
  return false;
}

function messageRouteKey(message: IncomingMessage): string {
  return [
    message.platform,
    message.boundOrgId || 'unbound',
    message.boundUserId || message.userId,
    message.chatId,
  ].join(':');
}

function messagingConversationAgentId(message: IncomingMessage): string {
  return `lumi:${message.platform}:${message.chatId}`;
}

export function persistBoundMessagingExchange(message: IncomingMessage, reply: string): void {
  if (!message.boundUserId || !message.boundOrgId) return;
  const agentId = messagingConversationAgentId(message);
  const conversation = getOrCreateActiveConversation(message.boundUserId, agentId, 'work', message.boundOrgId);
  addMessage({
    userId: message.boundUserId,
    agentId,
    conversationId: conversation.id,
    role: 'user',
    content: message.text,
    domain: 'work',
    orgId: message.boundOrgId,
  });
  addMessage({
    userId: message.boundUserId,
    agentId,
    conversationId: conversation.id,
    role: 'assistant',
    content: reply,
    domain: 'work',
    orgId: message.boundOrgId,
  });
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
  options?: {
    onMessage?: MessageHandler;
    llmGetters?: {
      getDeepSeek?: () => any;
      getGemini?: () => any;
      getOpenAI?: () => any;
      getAnthropic?: () => any;
      getQwen?: () => any;
    };
    personalityRegistry?: any;
    queryMemories?: (opts: { userId: string; query: string; limit: number; minConfidence: number; domain?: string; orgId?: string }) => any[];
    loadEmotionalState?: (userId: string) => any;
  },
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

      // Dedup: Feishu retries events if no ack, but we process async below
      if (isDuplicate('feishu', msg.messageId)) {
        console.log(`[Feishu] Ignoring duplicate: ${msg.messageId}`);
        return res.json({ code: 0 });
      }

      console.log(`[Feishu] ${msg.userName} (${msg.chatType}): ${msg.text.slice(0, 80)}`);

      // Respond to Feishu IMMEDIATELY (must be < 1s), process AI reply async
      res.json({ code: 0 });

      const bindingReply = handleFeishuBindingCommand(msg);
      if (bindingReply) {
        await adapter.replyMessage(msg.messageId, bindingReply).catch(() =>
          adapter.sendMessage(msg.chatId, { text: bindingReply, platform: 'feishu' }));
        return;
      }

      const boundMsg = applyMessagingBinding(msg);
      await enqueueMessageRoute(boundMsg, async () => {
        const enrichedMsg = await enrichFeishuAttachments(boundMsg, adapter);
        const legalNoticeReply = await handleRemoteLegalNoticeIntake(enrichedMsg);
        if (legalNoticeReply) {
          persistBoundMessagingExchange(enrichedMsg, legalNoticeReply);
          await adapter.replyMessage(msg.messageId, legalNoticeReply).catch(() =>
            adapter.sendMessage(msg.chatId, { text: legalNoticeReply, platform: 'feishu' }));
          return;
        }
        const remoteOrgReply = await handleRemoteOrgCommand(enrichedMsg);
        if (remoteOrgReply) {
          persistBoundMessagingExchange(enrichedMsg, remoteOrgReply);
          await adapter.replyMessage(msg.messageId, remoteOrgReply).catch(() =>
            adapter.sendMessage(msg.chatId, { text: remoteOrgReply, platform: 'feishu' }));
          return;
        }

        if (options?.onMessage) {
          const reply = await options.onMessage(enrichedMsg);
          if (reply) {
            persistBoundMessagingExchange(enrichedMsg, reply.text);
            await adapter.replyMessage(msg.messageId, reply.text).catch(() =>
              adapter.sendMessage(msg.chatId, { text: reply.text, platform: 'feishu' }));
          }
        } else {
          const replyText = await processWithPersonality(enrichedMsg, options);
          await adapter.replyMessage(msg.messageId, replyText).catch(() =>
            adapter.sendMessage(msg.chatId, { text: replyText, platform: 'feishu' }));
        }
      });
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
      enabled: cfg.enabled,
    });
  });

  // ── POST /feishu/config — update config ──
  router.post('/feishu/config', requireAuth, async (req, res) => {
    try {
      if (!requireMessagingAdmin(req, res)) return;
      const { appId, appSecret, verificationToken } = req.body;
      const updated = updateMessagingConfig({ appId, appSecret, verificationToken });
      // Reload adapter with new config
      const newConfig = { appId: updated.feishu.appId, appSecret: updated.feishu.appSecret, verificationToken: updated.feishu.verificationToken };
      Object.assign(feishuConfig, newConfig);
      adapter.reload?.(newConfig);
      res.json({ success: true, configured: updated.feishu.enabled, appId: updated.feishu.appId ? `${updated.feishu.appId.slice(0, 8)}...` : '' });
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

function handleFeishuBindingCommand(msg: IncomingMessage): string | null {
  const text = msg.text.trim();
  const match = text.match(/^(?:绑定|bind)\s*(?:Lumi|露米|lumi)?\s*([A-Z0-9]{4,12})$/i);
  if (!match) return null;
  const binding = consumeBindingCode('feishu', match[1], msg.userId);
  if (!binding) {
    return '绑定码无效或已过期。请在 Lumi 桌面端重新生成飞书绑定码。';
  }
  return `绑定成功。之后你可以通过飞书让 Lumi 查询组织知识库、查询案件，或发送案件文件让 Lumi 归档到组织案件。`;
}

function applyMessagingBinding(msg: IncomingMessage): IncomingMessage {
  const binding = getBinding('feishu', msg.userId);
  if (!binding) return msg;
  const membership = getMember(binding.orgId, binding.lumiUserId);
  if (!membership || membership.status !== 'active') return msg;
  return {
    ...msg,
    boundUserId: binding.lumiUserId,
    boundOrgId: binding.orgId,
  };
}

function needsBinding(text: string): boolean {
  return /(组织|工作域|知识库|资料库|文档库|案件|案号|归档|保存|材料|卷宗|律所)/.test(text)
    || /(提取|调取|获取|查看|整理|总结|摘要|列出).*(案件|案号|卷宗|组织资料|组织文档|组织知识)/.test(text);
}

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

async function enrichFeishuAttachments(msg: IncomingMessage, adapter: FeishuAdapter): Promise<IncomingMessage> {
  if (!msg.attachments || msg.attachments.length === 0) return msg;

  const enrichedAttachments: IncomingAttachment[] = [];
  for (const attachment of msg.attachments) {
    const enriched: IncomingAttachment = { ...attachment };
    try {
      if (!attachment.resourceKey) throw new Error('missing resource key');
      const buffer = await adapter.downloadMessageResource(msg.messageId, attachment.resourceKey, attachment.resourceType || 'file');
      enriched.fileSize = enriched.fileSize || buffer.byteLength;
      if (buffer.byteLength > MAX_FEISHU_ATTACHMENT_BYTES) {
        throw new Error(`file too large (${Math.round(buffer.byteLength / 1024 / 1024)} MB)`);
      }

      const safeName = sanitizeFileName(enriched.fileName);
      const scopeDir = msg.boundOrgId
        ? `org-${sanitizeFileName(msg.boundOrgId)}`
        : 'unbound-quarantine';
      const savePath = getDataPath(path.join('messaging', 'feishu', 'attachments', scopeDir, `${Date.now()}_${safeName}`));
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
    '以下是用户通过飞书发送的附件内容。请优先结合附件内容回答；如果像案件材料，请按案件事实、争议焦点、证据/材料缺口、下一步建议来整理，并提醒最终由律师确认。',
    attachmentBlocks,
  ].filter(Boolean).join('\n');

  return {
    ...msg,
    text,
    attachments: enrichedAttachments,
  };
}

async function enrichWeComAttachments(msg: IncomingMessage, adapter: WeComAdapter): Promise<IncomingMessage> {
  if (!msg.attachments || msg.attachments.length === 0) return msg;

  const enrichedAttachments: IncomingAttachment[] = [];
  for (const attachment of msg.attachments) {
    const enriched: IncomingAttachment = { ...attachment };
    try {
      if (!attachment.resourceKey) throw new Error('missing media id');
      const buffer = await adapter.downloadMedia(attachment.resourceKey);
      enriched.fileSize = enriched.fileSize || buffer.byteLength;
      if (buffer.byteLength > MAX_FEISHU_ATTACHMENT_BYTES) {
        throw new Error(`file too large (${Math.round(buffer.byteLength / 1024 / 1024)} MB)`);
      }

      const safeName = sanitizeFileName(enriched.fileName);
      const scopeDir = msg.boundOrgId
        ? `org-${sanitizeFileName(msg.boundOrgId)}`
        : 'unbound-quarantine';
      const savePath = getDataPath(path.join('messaging', 'wecom', 'attachments', scopeDir, `${Date.now()}_${safeName}`));
      fs.mkdirSync(path.dirname(savePath), { recursive: true });
      fs.writeFileSync(savePath, buffer);
      enriched.localPath = savePath;

      if (isParseableAttachment(safeName, enriched.type)) {
        const parsed = await parseDocument(savePath);
        if (parsed?.text?.trim()) enriched.extractedText = parsed.text.trim();
        else enriched.parseError = '文件已保存，但没有抽取到可读文本';
      }
    } catch (err: any) {
      enriched.parseError = err?.message || String(err);
    }
    enrichedAttachments.push(enriched);
  }

  const attachmentBlocks = enrichedAttachments.map(attachmentPromptBlock).join('\n\n');
  return {
    ...msg,
    text: [
      msg.text,
      '',
      '以下是用户通过企业微信发送的附件内容。请结合附件回答；如属案件材料，按事实、争议焦点、证据缺口和下一步建议整理。',
      attachmentBlocks,
    ].filter(Boolean).join('\n'),
    attachments: enrichedAttachments,
  };
}

export async function processWithPersonality(
  msg: IncomingMessage,
  options?: {
    llmGetters?: Record<string, () => any>;
    personalityRegistry?: any;
    queryMemories?: (opts: { userId: string; query: string; limit: number; minConfidence: number; domain?: string; orgId?: string }) => any[];
    loadEmotionalState?: (userId: string) => any;
  },
): Promise<string> {
  const llm = options?.llmGetters;
  const registry = options?.personalityRegistry;
  const isBound = Boolean(msg.boundUserId && msg.boundOrgId);
  const effectiveUserId = isBound ? msg.boundUserId! : 'anonymous';
  const domain = isBound ? 'work' as const : 'personal' as const;
  const orgId = isBound ? msg.boundOrgId! : '';
  const conversationAgentId = messagingConversationAgentId(msg);
  const conversation = isBound
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

  // ── Build system prompt from Lumi personality ──
  let systemPrompt = '';
  let personality: any = null;

  if (registry) {
    try {
      const memories = isBound && options?.queryMemories
        ? options.queryMemories({ userId: effectiveUserId, query: msg.text, limit: 5, minConfidence: 0.4, domain, orgId })
        : [];
      const emotionalStateKey = domain === 'work' ? `${effectiveUserId}:org:${orgId}` : effectiveUserId;
      const emotionalState = isBound && options?.loadEmotionalState ? options.loadEmotionalState(emotionalStateKey) : undefined;

      const result = registry.buildSystemPrompt(
        'lumi',
        { mode: 'chat', sensory: { hasAudio: false, hasVideo: false, hasSpatial: false, hasHaptic: false, hasHolographic: false, activeDeviceTypes: [], deviceCount: 0 } },
        {
          memories: memories.length > 0 ? memories : undefined,
          emotionalState,
          userId: effectiveUserId,
          userText: msg.text,
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
  if (msg.boundOrgId) {
    systemPrompt += `\n\n当前${remotePlatformLabel(msg.platform)}用户已绑定到 Lumi 组织工作域。你可以基于本轮消息和已提供的附件内容进行分析；查询组织知识库、查询/归档案件由服务端安全工具提前处理。不要声称已经写入组织数据，除非系统消息或用户看到的回复明确说明已完成。涉及法律材料时必须提醒最终由执业律师确认。`;
  } else {
    systemPrompt += `\n\n当前${remotePlatformLabel(msg.platform)}用户尚未绑定 Lumi 身份。可以分析用户直接提供的文本/附件，但不要声称可以访问组织知识库、组织案件或本地私人数据。`;
  }

  // ── Determine model order from user LLM prefs ──
  const userLLMPrefs = getUserPreferredLLMConfig(effectiveUserId, { domain, orgId });
  const activeProvider = userLLMPrefs.provider || 'deepseek';
  const activeModel = userLLMPrefs.model || 'deepseek-v4-flash';

  // Respect the selected primary brain. Do not silently fall back to another
  // configured provider from Feishu, because that can create unexpected billing.
  const modelProviders = resolveProviderOrder(activeProvider, activeModel, [], llm);

  for (const { getter, model } of modelProviders) {
    try {
      const client = getter();
      if (!client) continue;

      if (model.includes('gemini')) {
        const genAI = client;
        const modelInstance = genAI.getGenerativeModel({ model, systemInstruction: systemPrompt });
        const result = await modelInstance.generateContent({
          contents: [
            ...conversationHistory.map(item => ({ role: item.role === 'assistant' ? 'model' : 'user', parts: [{ text: item.content }] })),
            { role: 'user', parts: [{ text: msg.text }] },
          ],
        });
        const text = result.response.text();
        if (text) {
          persistBoundMessagingExchange(msg, text);
          return text;
        }
      } else {
        const response = await client.chat.completions.create({
          model,
          messages: [
            { role: 'system', content: systemPrompt },
            ...conversationHistory,
            { role: 'user', content: msg.text },
          ],
        });
        const text = response.choices?.[0]?.message?.content;
        if (text) {
          persistBoundMessagingExchange(msg, text);
          return text;
        }
      }
    } catch (err: any) {
      console.warn(`[Feishu] Model ${model} failed:`, err.message);
    }
  }

  return `收到你的消息："${msg.text.slice(0, 100)}"。当前暂无 AI 回复，请稍后再试。`;
}

function resolveProviderOrder(
  activeProvider: string,
  activeModel: string,
  fallbackCandidates: { provider: string; model: string }[],
  llmGetters?: Record<string, () => any>,
): { getter: () => any; model: string }[] {
  const keyMap: Record<string, string> = {
    qwen: 'getQwen', deepseek: 'getDeepSeek', gemini: 'getGemini',
    openai: 'getOpenAI', anthropic: 'getAnthropic',
  };

  const ordered: { getter: () => any; model: string }[] = [];
  const seen = new Set<string>();

  // Active provider first
  const getterKey = keyMap[activeProvider];
  if (getterKey && llmGetters?.[getterKey]) {
    ordered.push({ getter: llmGetters[getterKey], model: activeModel });
    seen.add(getterKey);
  }

  // User's other configured models as fallbacks
  for (const { provider, model } of fallbackCandidates) {
    const gk = keyMap[provider];
    if (gk && llmGetters?.[gk] && !seen.has(gk)) {
      ordered.push({ getter: llmGetters[gk], model });
      seen.add(gk);
    }
  }

  return ordered;
}

// ═══════════════════════════════════════════════════════════════════
// Enterprise WeChat (企业微信) Routes
// ═══════════════════════════════════════════════════════════════════

import { WeComAdapter, type WeComConfig } from './wecom';

export function createWeComRoutes(
  config: WeComConfig,
  options?: {
    onMessage?: MessageHandler;
    llmGetters?: Record<string, () => any>;
    personalityRegistry?: any;
    queryMemories?: (opts: { userId: string; query: string; limit: number; minConfidence: number; domain?: string; orgId?: string }) => any[];
    loadEmotionalState?: (userId: string) => any;
  },
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

      console.log('[WeCom] URL verify — k/v:',
        'sig:', msg_signature?.slice(0, 12),
        'ts:', timestamp,
        'nonce:', nonce,
        'echostr_head:', fix(echostr).slice(0, 16),
        'token_head:', config.token?.slice(0, 4) + '***',
        'aeskey_len:', config.encodingAESKey?.length
      );

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
        console.log('[WeCom] XML decrypted:', decryptedXml.slice(0, 200));
      } catch (err: any) {
        console.error('[WeCom] Decrypt failed:', err.message);
        return res.status(403).send('decrypt failed');
      }

      const msg = adapter.parseEvent({ rawBody: decryptedXml });
      if (!msg) {
        console.log('[WeCom] parseEvent returned null — msgType may not be text, or XML parse failed');
        console.log('[WeCom] XML was:', decryptedXml.slice(0, 300));
        return res.send('success');
      }

      if (isDuplicate('wecom', msg.messageId)) {
        return res.send('success');
      }

      console.log(`[WeCom] ${msg.userName}: ${msg.text.slice(0, 80)}`);

      // Respond IMMEDIATELY (WeCom requires < 5s)
      res.type('text/plain').send('success');

      // Process AI reply async
      const bindingReply = handleWeComBindingCommand(msg);
      if (bindingReply) {
        await adapter.sendMessage(msg.chatId, { text: bindingReply, platform: 'wecom' });
        return;
      }

      const boundMsg = applyWeComBinding(msg);
      await enqueueMessageRoute(boundMsg, async () => {
        const enrichedMsg = await enrichWeComAttachments(boundMsg, adapter);
        const legalNoticeReply = await handleRemoteLegalNoticeIntake(enrichedMsg);
        if (legalNoticeReply) {
          persistBoundMessagingExchange(enrichedMsg, legalNoticeReply);
          await adapter.sendMessage(msg.chatId, { text: legalNoticeReply, platform: 'wecom' });
          return;
        }
        const remoteOrgReply = await handleRemoteOrgCommand(enrichedMsg);
        if (remoteOrgReply) {
          persistBoundMessagingExchange(enrichedMsg, remoteOrgReply);
          await adapter.sendMessage(msg.chatId, { text: remoteOrgReply, platform: 'wecom' });
          return;
        }

        if (options?.onMessage) {
          const reply = await options.onMessage(enrichedMsg);
          if (reply) {
            persistBoundMessagingExchange(enrichedMsg, reply.text);
            await adapter.sendMessage(msg.chatId, { text: reply.text, platform: 'wecom' });
          }
        } else {
          const replyText = await processWithPersonality(enrichedMsg, options);
          await adapter.sendMessage(msg.chatId, { text: replyText, platform: 'wecom' });
        }
      });
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
      const messageId = await adapter.sendMessage(userId, { text, platform: 'wecom' });
      res.json({ success: true, messageId });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── GET /wecom/status ──
  router.get('/wecom/status', requireAuth, (_req, res) => {
    res.json({
      platform: 'wecom',
      configured: config.corpId && config.appSecret ? true : false,
      corpId: config.corpId ? `${config.corpId.slice(0, 8)}...` : null,
      agentId: config.agentId || null,
    });
  });

  // ── GET /wecom/config ──
  router.get('/wecom/config', requireAuth, (req, res) => {
    if (!requireMessagingAdmin(req, res)) return;
    res.json({
      corpId: config.corpId,
      corpIdMasked: config.corpId ? `${config.corpId.slice(0, 8)}...` : '',
      agentId: config.agentId,
      hasSecret: !!config.appSecret,
      hasAesKey: !!config.encodingAESKey,
      enabled: !!(config.corpId && config.appSecret),
    });
  });

  // ── POST /wecom/config ──
  router.post('/wecom/config', requireAuth, async (req, res) => {
    try {
      if (!requireMessagingAdmin(req, res)) return;
      const { corpId, agentId, appSecret, token, encodingAESKey } = req.body;
      const updated = updateMessagingConfig({
        wecom: { corpId, agentId, appSecret, token, encodingAESKey },
      });
      Object.assign(config, updated.wecom);
      adapter.reload(config);
      res.json({ success: true, configured: updated.wecom.enabled });
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

function handleWeComBindingCommand(msg: IncomingMessage): string | null {
  const text = msg.text.trim();
  const match = text.match(/^(?:绑定|bind)\s*(?:Lumi|露米|lumi)?\s*([A-Z0-9]{4,12})$/i);
  if (!match) return null;
  const binding = consumeBindingCode('wecom', match[1], msg.userId);
  if (!binding) {
    return '绑定码无效或已过期。请在 Lumi 桌面端重新生成企微绑定码。';
  }
  return '绑定成功。之后你可以通过企业微信转发法院短信链接、查询案件或发送案件材料，Lumi 会按组织案件空间处理。';
}

function applyWeComBinding(msg: IncomingMessage): IncomingMessage {
  const binding = getBinding('wecom', msg.userId);
  if (!binding) return msg;
  const membership = getMember(binding.orgId, binding.lumiUserId);
  if (!membership || membership.status !== 'active') return msg;
  return {
    ...msg,
    boundUserId: binding.lumiUserId,
    boundOrgId: binding.orgId,
  };
}
