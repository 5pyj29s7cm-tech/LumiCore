import type { IncomingMessage } from "../../../messaging/types";
import { createBindingCode, deleteBindingForUser, authorizeMessagingGroup, listMessagingGroupAuthorizations, revokeMessagingGroupAuthorization, listBindingsForUser } from "../../../messaging/bindings";
import { getMember } from "../../../org/db";
import type { FeishuConfig } from "../../../messaging/feishu";
import { Router } from "express";
import { FeishuAdapter, isMessagingDeliveryUnknownError } from "../../../messaging/feishu";
import { requireAuth } from "../../../middleware/auth";
import { getMessagingConfig, updateMessagingConfig } from "../../../messaging/config";
import { listQueuedMessagingInputs } from "../../../messaging/message_journal";
import { WeComAdapter, type WeComConfig } from "../../../messaging/wecom";
import type { MessagingRouteOptions, IncomingMessageTransport } from "./messaging_finalization";
import { enrichFeishuAttachments, enrichWeComAttachments } from "./remote_materials";
import { dispatchIncomingMessage } from './messaging_turn/ingress';
import { bindingOrgId } from './messaging_turn/binding_commands';

export { MessagingReplyDurabilityError, finalizeMessagingResponseForDelivery, type MessagingRouteOptions, type MessagingConversationUpdate, type IncomingMessageTransport, buildRemoteRuntimeEvidenceContext } from "./messaging_finalization";
export { persistBoundMessagingExchange, persistBoundMessagingMessage } from "./messaging_persistence";
export { type RemoteCaseAttachmentWriteIntent, classifyRemoteCaseAttachmentWriteIntent, handleRemoteOrgCommand } from "./remote_org_commands";
export { messagingConversationAgentId, getRequestText, buildRemoteTurnIntentText, enrichMessagingAttachments, enrichFeishuAttachments, enrichWeComAttachments } from "./remote_materials";
export { stopMessagingIngressAndDrain, correlateMessagingReply, formatRemoteReplyForReadability, enqueueMessageRoute } from "./messaging_ingress_runtime";
export { dispatchIncomingMessage } from './messaging_turn/ingress';
export type { RemoteLumiExecutionPlanInput } from './messaging_turn/remote_plan';
export { buildRemoteLumiExecutionPlan } from './messaging_turn/remote_plan';
export { buildRemoteConversationHistory } from './messaging_turn/history';
export { processWithPersonality } from './messaging_turn/processing';

function requireMessagingAdmin(req: any, res: any): boolean {
  if (req.user?.role === 'admin') return true;
  res.status(403).json({ error: 'System administrator access is required for host messaging configuration and manual sends.' });
  return false;
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

function recoverQueuedMessagingInputs(platform: IncomingMessage['platform'], transport: IncomingMessageTransport, options?: MessagingRouteOptions): void {
  setImmediate(() => {
    for (const message of listQueuedMessagingInputs(platform)) {
      try { dispatchIncomingMessage(message, transport, options); }
      catch (error: any) { console.warn(`[Messaging] Queued ${platform} input remains pending:`, error?.message || error); }
    }
  });
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
