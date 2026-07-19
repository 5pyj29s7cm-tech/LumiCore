// WeChat ClawBot routes — QR login + status + config
import { Router } from 'express';
import { WeChatClawBotAdapter, type WeChatClawBotConfig } from '../../../messaging/wechat-clawbot';
import { getMessagingConfig, updateMessagingConfig } from '../../../messaging/config';
import { requireAuth } from '../../../middleware/auth';
import type { IncomingMessage } from '../../../messaging/types';
import {
  consumeBindingCode,
  createBindingCode,
  deleteBindingForUser,
  getBinding,
  listActiveBindingCodesForUser,
  listBindingsForUser,
  parseMessagingBindingCommand,
} from '../../../messaging/bindings';
import { getMember } from '../../../org/db';
import {
  dispatchIncomingMessage,
  enrichMessagingAttachments,
} from './messaging_routes';
import type { MessagingRouteOptions } from './messaging_routes';
import { setActiveWeChatAdapter } from '../../../messaging/wechat_runtime';
import { desktopWechatWatchService } from '../../../messaging/desktop_wechat_watch';

function requireWechatAdmin(req: any, res: any): boolean {
  if (req.user?.role === 'admin') return true;
  res.status(403).json({ error: 'System administrator access is required for the host WeChat bot account.' });
  return false;
}

function requestedBinding(req: any): { domain: 'personal' | 'work'; orgId: string } {
  const domain = req.body?.scope === 'personal' ? 'personal' : 'work';
  if (domain === 'personal') return { domain, orgId: '' };
  const sessionOrgId = String(req.user?.orgId || '').trim();
  const requestedOrgId = String(req.body?.orgId || '').trim();
  if (sessionOrgId && requestedOrgId && sessionOrgId !== requestedOrgId) {
    throw new Error('Requested organization does not match the active organization context');
  }
  return { domain, orgId: sessionOrgId || requestedOrgId };
}

export function createWeChatRoutes(
  config: WeChatClawBotConfig,
  options?: MessagingRouteOptions,
): Router {
  const router = Router();
  const adapter = new WeChatClawBotAdapter(config);
  setActiveWeChatAdapter(adapter);

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
        adapter.stopPolling();
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
  router.get('/wechat/status', requireAuth, (req, res) => {
    const personalBinding = listBindingsForUser(req.user!.uid).find(item =>
      item.platform === 'wechat' && item.domain === 'personal'
    );
    const pendingPersonalBinding = personalBinding
      ? null
      : listActiveBindingCodesForUser(req.user!.uid, 'wechat', 'personal')[0] || null;
    res.json({
      platform: 'wechat',
      configured: !!(config.botToken && config.botId),
      ...adapter.getStatus(),
      botId: config.botId ? `${config.botId.slice(0, 12)}...` : null,
      canConfigure: req.user?.role === 'admin',
      personalBound: Boolean(personalBinding),
      personalBinding: personalBinding ? {
        id: personalBinding.id,
        platformUserId: personalBinding.platformUserId,
        updatedAt: personalBinding.updatedAt,
      } : null,
      pendingPersonalBinding: pendingPersonalBinding ? {
        code: pendingPersonalBinding.code,
        expiresAt: pendingPersonalBinding.expiresAt,
      } : null,
      desktopWatch: desktopWechatWatchService.status(req.user!.uid),
    });
  });

  // Desktop WeChat duty mode observes the user's native WeChat window. It is
  // independent from the iLink bot connection above and never auto-sends.
  router.put('/wechat/desktop-watch', requireAuth, (req, res) => {
    try {
      const config = desktopWechatWatchService.updateConfig(req.user!.uid, {
        enabled: req.body?.enabled,
        pollIntervalSeconds: req.body?.pollIntervalSeconds,
        autoInspectWhenIdle: req.body?.autoInspectWhenIdle,
        idleBeforeInspectSeconds: req.body?.idleBeforeInspectSeconds,
        contactAllowlist: req.body?.contactAllowlist,
      });
      res.json({ success: true, ...desktopWechatWatchService.status(req.user!.uid), config });
    } catch (err: any) {
      res.status(400).json({ error: err?.message || 'Failed to update desktop WeChat watch.' });
    }
  });

  router.post('/wechat/desktop-watch/scan', requireAuth, async (req, res) => {
    try {
      res.json({ success: true, ...(await desktopWechatWatchService.scanNow(req.user!.uid)) });
    } catch (err: any) {
      res.status(400).json({ error: err?.message || 'Desktop WeChat scan failed.' });
    }
  });

  router.post('/wechat/desktop-watch/events/:eventId/approve', requireAuth, async (req, res) => {
    try {
      const event = await desktopWechatWatchService.approveReply(
        req.user!.uid,
        req.params.eventId,
        req.body?.draft ? String(req.body.draft) : undefined,
      );
      res.json({ success: event.status === 'sent', event, desktopWatch: desktopWechatWatchService.status(req.user!.uid) });
    } catch (err: any) {
      res.status(400).json({ error: err?.message || 'Desktop WeChat reply failed.' });
    }
  });

  router.post('/wechat/desktop-watch/events/:eventId/dismiss', requireAuth, (req, res) => {
    try {
      const event = desktopWechatWatchService.dismissEvent(req.user!.uid, req.params.eventId);
      res.json({ success: true, event, desktopWatch: desktopWechatWatchService.status(req.user!.uid) });
    } catch (err: any) {
      res.status(400).json({ error: err?.message || 'Failed to dismiss desktop WeChat event.' });
    }
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
      adapter.stopPolling();
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
      const requested = requestedBinding(req);
      const code = createBindingCode('wechat', req.user!.uid, requested.orgId, requested.domain);
      res.json({
        code: code.code,
        expiresAt: code.expiresAt,
        scope: code.domain,
        instruction: `在微信 Lumi Bot 里发送：绑定 Lumi ${code.code}`,
      });
    } catch (err: any) {
      res.status(400).json({ error: err?.message || 'Failed to create binding code' });
    }
  });

  router.get('/wechat/bindings', requireAuth, (req, res) => {
    const orgId = String(req.user?.orgId || '').trim();
    const scope = req.query.scope === 'personal' ? 'personal' : req.query.scope === 'work' ? 'work' : '';
    res.json({ bindings: listBindingsForUser(req.user!.uid).filter(item =>
      item.platform === 'wechat'
      && (!scope || item.domain === scope)
      && (item.domain === 'personal' || !orgId || item.orgId === orgId)
    ) });
  });

  router.delete('/wechat/bindings/:bindingId', requireAuth, (req, res) => {
    const scope = req.query.scope === 'personal' ? 'personal' : req.query.scope === 'work' ? 'work' : undefined;
    const orgFilter = scope === 'personal' ? '' : req.user?.orgId || undefined;
    const ok = deleteBindingForUser(req.user!.uid, req.params.bindingId, orgFilter, scope);
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

export function startWeChatPolling(
  adapter: WeChatClawBotAdapter,
  _config: WeChatClawBotConfig,
  options?: MessagingRouteOptions,
): void {
  void adapter.startPolling(async (msg) => {
    const bindingReply = handleWeChatBindingCommand(msg);
    if (bindingReply) return { text: bindingReply, platform: 'wechat' as const };

    const boundMsg = applyWeChatBinding(msg);
    dispatchIncomingMessage(boundMsg, {
      enrich: message => enrichMessagingAttachments(
        message,
        'wechat',
        '以下是用户通过个人微信发送的真实附件内容。个人绑定的附件保持在个人域；只有用户明确要求转入组织，或法院通知唯一匹配到其有权限的组织案件时，才可跨域归档。',
        attachment => adapter.downloadAttachment(attachment),
      ),
      reply: async (message, text) => {
        const outgoing: any = {
          text,
          platform: 'wechat' as const,
          replyTo: message.messageId,
          context_token: message.raw?.context_token || message.raw?.message?.context_token || '',
        };
        return adapter.sendMessage(message.userId, outgoing);
      },
    }, options);

    // Intake returns immediately. The shared route queue now owns execution and
    // reply delivery, so a slow tool call cannot stop WeChat from receiving the
    // user's next message.
    return null;
  }).catch(err => console.error('[WeChat] Polling failed:', err?.message || err));
}

export function handleWeChatBindingCommand(msg: IncomingMessage): string | null {
  const command = parseMessagingBindingCommand(msg.text);
  if (!command) return null;
  if (command.kind === 'status') {
    const current = getBinding('wechat', msg.userId, msg.chatId, msg.chatType);
    if (!current) {
      return '微信 Bot 已连接，但当前微信身份尚未绑定到个人 Lumi。请在 Lumi 客户端生成绑定码后，原样发送“绑定 Lumi 绑定码”。';
    }
    return current.domain === 'personal'
      ? '绑定状态已核验：当前微信身份已连接到你的个人 Lumi，后续消息会同步到个人聊天窗口。'
      : '绑定状态已核验：当前微信身份已连接到 Lumi 组织工作域。';
  }
  if (command.kind === 'invalid') {
    return '绑定命令格式不完整。请从 Lumi 客户端复制完整命令，并原样发送“绑定 Lumi 绑定码”。';
  }
  const binding = consumeBindingCode('wechat', command.code, msg.userId, msg.chatId, msg.chatType);
  if (!binding) {
    return '绑定码无效或已过期。请在 Lumi 桌面端重新生成微信绑定码。';
  }
  return binding.domain === 'personal'
    ? '绑定成功。这里的消息会由你的个人 Lumi 处理，并同步到 Lumi 客户端聊天。'
    : '绑定成功。之后你可以把法院短信链接、案件材料或查询指令发给我，我会按组织案件空间处理。';
}

function applyWeChatBinding(msg: IncomingMessage): IncomingMessage {
  const binding = getBinding('wechat', msg.userId);
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
