// WeChat ClawBot routes — QR login + status + config
import { Router } from 'express';
import { WeChatClawBotAdapter, type WeChatClawBotConfig } from './wechat-clawbot';
import { getMessagingConfig, updateMessagingConfig } from './config';
import { requireAuth } from '../middleware/auth';
import type { IncomingMessage, MessageHandler } from './types';
import {
  consumeBindingCode,
  createBindingCode,
  deleteBindingForUser,
  getBinding,
  listBindingsForUser,
} from './bindings';
import { getMember } from '../org/db';
import { handleRemoteLegalNoticeIntake } from './legal_notice_intake';
import {
  enqueueMessageRoute,
  handleRemoteOrgCommand,
  persistBoundMessagingExchange,
  processWithPersonality,
} from './routes';

function requireWechatAdmin(req: any, res: any): boolean {
  if (req.user?.role === 'admin') return true;
  res.status(403).json({ error: 'System administrator access is required for the host WeChat bot account.' });
  return false;
}

function requestedBindingOrgId(req: any): string {
  const sessionOrgId = String(req.user?.orgId || '').trim();
  const requestedOrgId = String(req.body?.orgId || '').trim();
  if (sessionOrgId && requestedOrgId && sessionOrgId !== requestedOrgId) {
    throw new Error('Requested organization does not match the active organization context');
  }
  return sessionOrgId || requestedOrgId;
}

export function createWeChatRoutes(
  config: WeChatClawBotConfig,
  options?: {
    onMessage?: MessageHandler;
    llmGetters?: Record<string, () => any>;
    personalityRegistry?: any;
    queryMemories?: (opts: { userId: string; query: string; limit: number; minConfidence: number; domain?: string; orgId?: string }) => any[];
    loadEmotionalState?: (userId: string) => any;
  },
): Router {
  const router = Router();
  const adapter = new WeChatClawBotAdapter(config);

  // ── GET /wechat/qrcode — get login QR code ──
  router.get('/wechat/qrcode', requireAuth, async (req, res) => {
    try {
      if (!requireWechatAdmin(req, res)) return;
      const qr = await adapter.getQRCode();
      res.json(qr);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── GET /wechat/qrcode/status — poll QR scan status ──
  router.get('/wechat/qrcode/status', requireAuth, async (req, res) => {
    try {
      if (!requireWechatAdmin(req, res)) return;
      const qrId = req.query.qrcode_id as string;
      if (!qrId) return res.status(400).json({ error: 'qrcode_id required' });
      const status = await adapter.checkQRCodeStatus(qrId);
      if (status.status === 'confirmed' && status.bot_token) {
        // Derive botId from botToken if not returned: format is "xxx@im.bot:token"
        const botId = status.bot_id || (status.bot_token.split(':')[0] || status.bot_token);
        const conf = {
          botToken: status.bot_token,
          botId,
          baseUrl: status.baseurl || 'https://ilinkai.weixin.qq.com',
          enabled: true,
        };
        // Persist the login credentials
        updateMessagingConfig({ wechat: conf });
        Object.assign(config, conf);
        adapter.reload(config);
        // Start polling in background
        startWeChatPolling(adapter, config, options);
      }
      res.json(status);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── GET /wechat/status — connection status ──
  router.get('/wechat/status', requireAuth, (_req, res) => {
    res.json({
      platform: 'wechat',
      configured: !!(config.botToken && config.botId),
      listening: adapter.isPolling(),
      botId: config.botId ? `${config.botId.slice(0, 12)}...` : null,
    });
  });

  // ── GET /wechat/config ──
  router.get('/wechat/config', requireAuth, (req, res) => {
    if (!requireWechatAdmin(req, res)) return;
    res.json({
      botId: config.botId,
      hasToken: !!config.botToken,
      enabled: !!(config.botToken && config.botId),
    });
  });

  // ── POST /wechat/config — manual config override ──
  router.post('/wechat/config', requireAuth, async (req, res) => {
    try {
      if (!requireWechatAdmin(req, res)) return;
      const { botToken, botId } = req.body;
      const updated = updateMessagingConfig({ wechat: { botToken, botId, baseUrl: 'https://ilinkai.weixin.qq.com' } });
      Object.assign(config, updated.wechat);
      adapter.reload(config);
      if (updated.wechat.enabled) {
        startWeChatPolling(adapter, config, options);
      } else {
        adapter.stopPolling();
      }
      res.json({ success: true, configured: updated.wechat.enabled });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  router.post('/wechat/bindings/code', requireAuth, (req, res) => {
    try {
      const code = createBindingCode('wechat', req.user!.uid, requestedBindingOrgId(req));
      res.json({
        code: code.code,
        expiresAt: code.expiresAt,
        instruction: `在微信 Lumi Bot 里发送：绑定 Lumi ${code.code}`,
      });
    } catch (err: any) {
      res.status(400).json({ error: err?.message || 'Failed to create binding code' });
    }
  });

  router.get('/wechat/bindings', requireAuth, (req, res) => {
    const orgId = String(req.user?.orgId || '').trim();
    res.json({ bindings: listBindingsForUser(req.user!.uid).filter(item =>
      item.platform === 'wechat' && (!orgId || item.orgId === orgId)
    ) });
  });

  router.delete('/wechat/bindings/:bindingId', requireAuth, (req, res) => {
    const ok = deleteBindingForUser(req.user!.uid, req.params.bindingId, req.user?.orgId || undefined);
    res.json({ success: ok });
  });

  // Auto-start polling if already configured (survives restarts)
  if (config?.botToken) {
    if (!config.botId) config.botId = (config.botToken.split(':')[0] || config.botToken);
    console.log('[WeChat] Existing bot session found; starting poll loop');
    startWeChatPolling(adapter, config, options);
  }

  return router;
}

// ── Polling + AI reply pipeline ──

function startWeChatPolling(
  adapter: WeChatClawBotAdapter,
  _config: WeChatClawBotConfig,
  options?: {
    onMessage?: MessageHandler;
    llmGetters?: Record<string, () => any>;
    personalityRegistry?: any;
    queryMemories?: (opts: { userId: string; query: string; limit: number; minConfidence: number; domain?: string; orgId?: string }) => any[];
    loadEmotionalState?: (userId: string) => any;
  },
): void {
  adapter.startPolling(async (msg) => {
    const bindingReply = handleWeChatBindingCommand(msg);
    if (bindingReply) return { text: bindingReply, platform: 'wechat' as const };

    const boundMsg = applyWeChatBinding(msg);
    let outgoing: { text: string; platform: 'wechat' } | null = null;
    await enqueueMessageRoute(boundMsg, async () => {
      const legalNoticeReply = await handleRemoteLegalNoticeIntake(boundMsg);
      if (legalNoticeReply) {
        persistBoundMessagingExchange(boundMsg, legalNoticeReply);
        outgoing = { text: legalNoticeReply, platform: 'wechat' };
        return;
      }
      const remoteOrgReply = await handleRemoteOrgCommand(boundMsg);
      if (remoteOrgReply) {
        persistBoundMessagingExchange(boundMsg, remoteOrgReply);
        outgoing = { text: remoteOrgReply, platform: 'wechat' };
        return;
      }

      if (options?.onMessage) {
        const reply = await options.onMessage(boundMsg);
        if (reply) {
          persistBoundMessagingExchange(boundMsg, reply.text);
          outgoing = { text: reply.text, platform: 'wechat' };
        }
        return;
      }
      const replyText = await processWithPersonality(boundMsg, options);
      outgoing = { text: replyText, platform: 'wechat' };
    });
    return outgoing;
  });
}

function handleWeChatBindingCommand(msg: IncomingMessage): string | null {
  const match = msg.text.trim().match(/^(?:绑定|bind)\s*(?:Lumi|露米|lumi)?\s*([A-Z0-9]{4,12})$/i);
  if (!match) return null;
  const binding = consumeBindingCode('wechat', match[1], msg.userId);
  if (!binding) {
    return '绑定码无效或已过期。请在 Lumi 桌面端重新生成微信绑定码。';
  }
  return '绑定成功。之后你可以把法院短信链接、案件材料或查询指令发给我，我会按组织案件空间处理。';
}

function applyWeChatBinding(msg: IncomingMessage): IncomingMessage {
  const binding = getBinding('wechat', msg.userId);
  if (!binding) return msg;
  const membership = getMember(binding.orgId, binding.lumiUserId);
  if (!membership || membership.status !== 'active') return msg;
  return {
    ...msg,
    boundUserId: binding.lumiUserId,
    boundOrgId: binding.orgId,
  };
}
