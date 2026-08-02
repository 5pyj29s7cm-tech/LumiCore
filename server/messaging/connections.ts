import * as Lark from '@larksuiteoapi/node-sdk';
import AiBot, { generateReqId, type WsFrame } from '@wecom/aibot-node-sdk';
import type { MessagingConfig } from './config';
import { FeishuAdapter } from './feishu';
import type { IncomingAttachment, IncomingMessage } from './types';
import {
  dispatchIncomingMessage,
  enrichFeishuAttachments,
  enrichMessagingAttachments,
  type MessagingRouteOptions,
} from './routes';

export type MessagingConnectionState = 'disabled' | 'connecting' | 'connected' | 'reconnecting' | 'error';

export interface MessagingConnectionStatus {
  platform: 'feishu' | 'wecom';
  mode: string;
  configured: boolean;
  state: MessagingConnectionState;
  lastConnectedAt?: string;
  lastMessageAt?: string;
  lastError?: string;
  reconnectAttempts: number;
}

function initialStatus(platform: 'feishu' | 'wecom', mode: string): MessagingConnectionStatus {
  return { platform, mode, configured: false, state: 'disabled', reconnectAttempts: 0 };
}

function textFromMixed(items: any[]): string {
  return (Array.isArray(items) ? items : [])
    .filter(item => item?.msgtype === 'text')
    .map(item => String(item?.text?.content || '').trim())
    .filter(Boolean)
    .join('\n');
}

function attachmentsFromWeComBody(body: any): IncomingAttachment[] {
  const candidates: Array<{ type: IncomingAttachment['type']; value: any; fallback: string }> = [];
  if (body?.msgtype === 'image' && body.image) candidates.push({ type: 'image', value: body.image, fallback: 'image' });
  if (body?.msgtype === 'file' && body.file) candidates.push({ type: 'file', value: body.file, fallback: 'file' });
  if (body?.msgtype === 'video' && body.video) candidates.push({ type: 'media', value: body.video, fallback: 'video' });
  if (body?.msgtype === 'mixed') {
    for (const [index, item] of (body.mixed?.msg_item || []).entries()) {
      if (item?.msgtype === 'image' && item.image) {
        candidates.push({ type: 'image', value: item.image, fallback: `image-${index + 1}` });
      }
    }
  }
  return candidates.map((candidate, index) => ({
    id: `${body.msgid || 'message'}_${candidate.fallback}_${index}`,
    type: candidate.type,
    fileName: String(candidate.value?.filename || candidate.value?.name || candidate.value?.file_name || candidate.fallback),
    fileSize: Number(candidate.value?.size || candidate.value?.file_size || 0) || undefined,
    mimeType: candidate.value?.mime_type || candidate.value?.mimetype || undefined,
    downloadUrl: candidate.value?.url || undefined,
    encryptionKey: candidate.value?.aeskey || undefined,
    resourceType: body.msgtype,
  }));
}

export function parseWeComLongConnectionMessage(frame: WsFrame): IncomingMessage | null {
  const body: any = frame?.body;
  if (!body?.msgid || !body?.from?.userid) return null;
  const attachments = attachmentsFromWeComBody(body);
  const text = body.msgtype === 'text'
    ? String(body.text?.content || '')
    : body.msgtype === 'voice'
      ? String(body.voice?.content || '')
      : body.msgtype === 'mixed'
        ? textFromMixed(body.mixed?.msg_item || [])
        : attachments.map(item => `[附件] ${item.fileName}`).join('\n');
  if (!text.trim() && attachments.length === 0) return null;
  const rawTimestamp = Number(body.create_time || 0);
  const timestampMs = rawTimestamp > 10_000_000_000 ? rawTimestamp : rawTimestamp * 1000;
  return {
    platform: 'wecom',
    userId: String(body.from.userid),
    userName: String(body.from.name || body.from.userid),
    chatId: String(body.chatid || body.from.userid),
    chatType: body.chattype === 'group' ? 'group' : 'private',
    messageId: String(body.msgid),
    text: text.trim(),
    attachments: attachments.length ? attachments : undefined,
    raw: { frame },
    timestamp: new Date(timestampMs || Date.now()).toISOString(),
  };
}

function truncateUtf8(value: string, maxBytes = 19_000): string {
  const source = String(value || '');
  if (Buffer.byteLength(source, 'utf8') <= maxBytes) return source;
  let output = source;
  while (output && Buffer.byteLength(`${output}\n\n[内容过长，已截断]`, 'utf8') > maxBytes) {
    output = output.slice(0, Math.max(0, output.length - 256));
  }
  return `${output}\n\n[内容过长，已截断]`;
}

export class MessagingConnectionManager {
  private feishuClient: Lark.WSClient | null = null;
  private feishuAdapter: FeishuAdapter | null = null;
  private wecomClient: InstanceType<typeof AiBot.WSClient> | null = null;
  private routeOptions: MessagingRouteOptions = {};
  private config: MessagingConfig | null = null;
  private lifecycle: Promise<void> = Promise.resolve();
  private statuses: Record<'feishu' | 'wecom', MessagingConnectionStatus> = {
    feishu: initialStatus('feishu', 'long_connection'),
    wecom: initialStatus('wecom', 'app_webhook'),
  };

  configure(config: MessagingConfig, routeOptions: MessagingRouteOptions): void {
    this.config = config;
    this.routeOptions = routeOptions;
  }

  start(): Promise<void> {
    return this.enqueueLifecycle(async () => {
      await this.stopClients();
      if (!this.config) return;
      this.startFeishu(this.config);
      this.startWeCom(this.config);
    });
  }

  restart(): Promise<void> {
    return this.start();
  }

  stop(): Promise<void> {
    return this.enqueueLifecycle(() => this.stopClients());
  }

  status(platform: 'feishu' | 'wecom'): MessagingConnectionStatus {
    const status = { ...this.statuses[platform] };
    if (platform === 'feishu' && this.feishuClient) {
      const live = this.feishuClient.getConnectionStatus();
      if (live.state === 'connected') status.state = 'connected';
      else if (live.state === 'reconnecting') status.state = 'reconnecting';
      else if (live.state === 'connecting') status.state = 'connecting';
      else if (live.state === 'failed') status.state = 'error';
      status.reconnectAttempts = live.reconnectAttempts;
    }
    if (platform === 'wecom' && this.wecomClient?.isConnected) status.state = 'connected';
    return status;
  }

  async sendProactive(platform: 'feishu' | 'wecom', chatId: string, text: string): Promise<string> {
    if (platform === 'feishu') {
      if (!this.feishuAdapter) throw new Error('Feishu long connection is not configured');
      return this.feishuAdapter.sendMessage(chatId, { platform: 'feishu', text });
    }
    if (!this.wecomClient?.isConnected) throw new Error('WeCom AI Bot long connection is not connected');
    const response = await this.wecomClient.sendMessage(chatId, {
      msgtype: 'markdown',
      markdown: { content: truncateUtf8(text) },
    });
    return String(response.headers?.req_id || '');
  }

  private enqueueLifecycle(operation: () => Promise<void>): Promise<void> {
    const run = this.lifecycle.then(operation, operation);
    this.lifecycle = run.catch(() => undefined);
    return run;
  }

  private async stopClients(): Promise<void> {
    if (this.feishuClient) {
      this.feishuClient.close({ force: true });
      this.feishuClient = null;
      this.feishuAdapter = null;
    }
    if (this.wecomClient) {
      this.wecomClient.disconnect();
      this.wecomClient.removeAllListeners();
      this.wecomClient = null;
    }
  }

  private startFeishu(config: MessagingConfig): void {
    const feishu = config.feishu;
    this.statuses.feishu = initialStatus('feishu', feishu.transport);
    this.statuses.feishu.configured = feishu.enabled;
    if (!feishu.enabled || feishu.transport !== 'long_connection') return;
    if (!/^cli_[A-Za-z0-9_-]{8,64}$/.test(feishu.appId)) {
      this.statuses.feishu.state = 'error';
      this.statuses.feishu.lastError = 'App ID 格式无效';
      return;
    }

    this.statuses.feishu.state = 'connecting';
    const adapter = new FeishuAdapter(feishu);
    const dispatcher = new Lark.EventDispatcher({}).register({
      'im.message.receive_v1': async (data: any) => {
        let message = adapter.parseEvent(data);
        if (message?.chatType === 'group' && message.botMentioned !== true) {
          try {
            await adapter.ensureBotIdentity();
            message = adapter.parseEvent(data);
          } catch (error: any) {
            this.statuses.feishu.lastError = error?.message || String(error);
            return;
          }
        }
        if (!message) return;
        this.statuses.feishu.lastMessageAt = new Date().toISOString();
        dispatchIncomingMessage(message, {
          enrich: incoming => enrichFeishuAttachments(incoming, adapter),
          reply: async (incoming, text) => {
            return adapter.replyMessage(incoming.messageId, text);
          },
        }, this.routeOptions);
      },
    });
    const client = new Lark.WSClient({
      appId: feishu.appId,
      appSecret: feishu.appSecret,
      autoReconnect: true,
      source: 'lumios',
      loggerLevel: Lark.LoggerLevel.warn,
      handshakeTimeoutMs: 15_000,
      wsConfig: { pingTimeout: 10 },
      onReady: () => {
        this.statuses.feishu.state = 'connected';
        this.statuses.feishu.lastConnectedAt = new Date().toISOString();
        this.statuses.feishu.lastError = undefined;
      },
      onReconnecting: () => {
        this.statuses.feishu.state = 'reconnecting';
        this.statuses.feishu.reconnectAttempts += 1;
      },
      onReconnected: () => {
        this.statuses.feishu.state = 'connected';
        this.statuses.feishu.lastConnectedAt = new Date().toISOString();
        this.statuses.feishu.lastError = undefined;
      },
      onError: error => {
        this.statuses.feishu.state = 'error';
        this.statuses.feishu.lastError = error.message;
      },
    });
    this.feishuAdapter = adapter;
    this.feishuClient = client;
    void client.start({ eventDispatcher: dispatcher }).catch(error => {
      this.statuses.feishu.state = 'error';
      this.statuses.feishu.lastError = error?.message || String(error);
    });
  }

  private startWeCom(config: MessagingConfig): void {
    const wecom = config.wecom;
    this.statuses.wecom = initialStatus('wecom', wecom.mode);
    this.statuses.wecom.configured = wecom.enabled;
    if (!wecom.enabled || wecom.mode !== 'aibot_long_connection') return;

    this.statuses.wecom.state = 'connecting';
    const client = new AiBot.WSClient({
      botId: wecom.botId,
      secret: wecom.botSecret,
      maxReconnectAttempts: -1,
      maxAuthFailureAttempts: 5,
      heartbeatInterval: 30_000,
      requestTimeout: 15_000,
    });
    client.on('connected', () => {
      this.statuses.wecom.state = 'connecting';
    });
    client.on('authenticated', () => {
      this.statuses.wecom.state = 'connected';
      this.statuses.wecom.lastConnectedAt = new Date().toISOString();
      this.statuses.wecom.lastError = undefined;
    });
    client.on('reconnecting', attempt => {
      this.statuses.wecom.state = 'reconnecting';
      this.statuses.wecom.reconnectAttempts = attempt;
    });
    client.on('disconnected', reason => {
      this.statuses.wecom.state = 'reconnecting';
      this.statuses.wecom.lastError = String(reason || 'connection closed');
    });
    client.on('error', error => {
      this.statuses.wecom.state = 'error';
      this.statuses.wecom.lastError = error.message;
    });
    client.on('message', frame => {
      const message = parseWeComLongConnectionMessage(frame);
      if (!message) return;
      this.statuses.wecom.lastMessageAt = new Date().toISOString();
      const streamId = generateReqId('lumi');
      let initialReply: Promise<any> | null = null;
      const accepted = dispatchIncomingMessage(message, {
        enrich: incoming => enrichMessagingAttachments(
          incoming,
          'wecom',
          '以下是用户通过企业微信发送的附件内容。请结合附件回答；如属案件材料，按事实、争议焦点、证据缺口和下一步建议整理。',
          async attachment => {
            if (!attachment.downloadUrl) throw new Error('missing WeCom attachment URL');
            return (await client.downloadFile(attachment.downloadUrl, attachment.encryptionKey)).buffer;
          },
        ),
        reply: async (_incoming, text) => {
          if (initialReply) await initialReply.catch(() => undefined);
          await client.replyStream(frame, streamId, truncateUtf8(text), true);
        },
      }, this.routeOptions);
      if (accepted) {
        initialReply = client.replyStream(frame, streamId, '正在处理', false);
        void initialReply.catch(error => {
          console.warn('[WeCom] Initial stream reply failed:', error?.message || error);
        });
      }
    });
    this.wecomClient = client;
    client.connect();
  }
}

export const messagingConnectionManager = new MessagingConnectionManager();
