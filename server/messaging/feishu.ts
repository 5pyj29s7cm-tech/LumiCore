/**
 * Feishu Message Adapter — Bot integration via Feishu Open API.
 *
 * Setup:
 *   1. Go to https://open.feishu.cn/app → Create Custom App
 *   2. Enable "Bot" capability
 *   3. Set event subscription URL to https://your-server/api/feishu/events
 *   4. Subscribe to: im.message.receive_v1
 *   5. Copy App ID + App Secret → .env as FEISHU_APP_ID / FEISHU_APP_SECRET
 */
import crypto from 'crypto';
import type {
  MessageAdapter,
  IncomingMessage,
  OutgoingMessage,
  CardPayload,
  MessagingPlatform,
  IncomingAttachment,
} from './types';

export interface FeishuConfig {
  appId: string;
  appSecret: string;
  verificationToken?: string; // optional extra security
  transport?: 'long_connection' | 'webhook';
}

export class FeishuAdapter implements MessageAdapter {
  readonly platform: MessagingPlatform = 'feishu';
  private config: FeishuConfig;
  private tenantToken: string | null = null;
  private tokenExpiry: number = 0;
  private tokenPromise: Promise<string> | null = null;

  constructor(config: FeishuConfig) {
    this.config = config;
  }

  // ── Reinitialize after config change ──

  reload(config: FeishuConfig): void {
    this.config = config;
    this.tenantToken = null;
    this.tokenExpiry = 0;
    this.tokenPromise = null;
  }

  // ── Token Management ──

  private async getTenantToken(): Promise<string> {
    if (this.tenantToken && Date.now() < this.tokenExpiry - 60_000) {
      return this.tenantToken;
    }
    if (this.tokenPromise) return this.tokenPromise;
    this.tokenPromise = (async () => {
      const res = await fetch('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ app_id: this.config.appId, app_secret: this.config.appSecret }),
      });
      const data: any = await res.json().catch(() => ({}));
      if (!res.ok || data.code !== 0) throw new Error(`Feishu auth error: ${data.msg || data.error || res.status}`);
      this.tenantToken = data.tenant_access_token;
      this.tokenExpiry = Date.now() + (data.expire || 7200) * 1000;
      return this.tenantToken!;
    })();
    try {
      return await this.tokenPromise;
    } finally {
      this.tokenPromise = null;
    }
  }

  // ── Webhook Verification ──

  verifyWebhook(body: Record<string, any>): boolean {
    const configured = String(this.config.verificationToken || '').trim();
    const supplied = String(body?.token || body?.header?.token || body?.event?.token || '').trim();
    if (!configured) {
      return body?.type === 'url_verification' || body?.event?.type === 'url_verification';
    }
    if (!supplied) return false;
    const expected = Buffer.from(configured);
    const actual = Buffer.from(supplied);
    return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
  }

  // ── Event Parsing ──

  parseEvent(body: any): IncomingMessage | null {
    // Feishu wraps events in: { schema: "2.0", header: {...}, event: {...} }
    const dispatchedEvent = Boolean(body?.message && body?.sender);
    const eventData = dispatchedEvent ? body : (body.event || body);
    const header = body.header || {};

    // URL verification challenge
    if (body.type === 'url_verification' || eventData.type === 'url_verification') {
      // This is handled by the route, not parseEvent
      return null;
    }

    const eventType = eventData.type || header.event_type || (dispatchedEvent ? 'im.message.receive_v1' : '');

    if (eventType !== 'im.message.receive_v1') return null;

    const event = eventData.event || eventData;
    const message = event?.message;
    if (!message) return null;

    const parsedContent = this.parseMessageContent(message.content);
    const attachments = this.parseAttachments(message.message_type, parsedContent);
    const textContent = message.message_type === 'text'
      ? String(parsedContent.text || '').trim()
      : attachments.length > 0
        ? attachments.map(att => `[附件] ${att.fileName}`).join('\n')
        : '';
    if (!textContent && attachments.length === 0) return null;

    const chatId = message.chat_id || '';
    const isGroup = message.chat_type === 'group';

    return {
      platform: 'feishu',
      userId: event?.sender?.sender_id?.open_id || message.open_id || 'unknown',
      userName: event?.sender?.sender_id?.open_id || 'FeishuUser',
      chatId,
      chatType: isGroup ? 'group' : 'private',
      messageId: message.message_id || `${Date.now()}`,
      text: textContent,
      attachments: attachments.length > 0 ? attachments : undefined,
      raw: { event: eventData, message },
      timestamp: new Date(Number(message.create_time) || Date.now()).toISOString(),
    };
  }

  private parseMessageContent(content: string): Record<string, any> {
    try {
      return JSON.parse(content || '{}');
    } catch {
      return { text: content || '' };
    }
  }

  private parseAttachments(messageType: string, content: Record<string, any>): IncomingAttachment[] {
    const attachmentType = messageType === 'file' || messageType === 'image' || messageType === 'media' || messageType === 'audio'
      ? messageType
      : 'unknown';
    const resourceKey = content.file_key || content.image_key || content.media_key || content.audio_key || content.key || '';
    if (!resourceKey) return [];
    const fileName = content.file_name || content.name || `${attachmentType}-${resourceKey}`;
    const resourceType = attachmentType === 'image' ? 'image' : attachmentType === 'media' ? 'file' : attachmentType === 'audio' ? 'file' : 'file';
    return [{
      id: `${attachmentType}_${resourceKey}`,
      type: attachmentType,
      fileName,
      fileSize: Number(content.file_size || content.size || 0) || undefined,
      mimeType: content.mime_type || content.mimetype || undefined,
      resourceKey,
      resourceType,
    }];
  }

  async downloadMessageResource(messageId: string, resourceKey: string, resourceType = 'file'): Promise<Buffer> {
    const token = await this.getTenantToken();
    const url = `https://open.feishu.cn/open-apis/im/v1/messages/${encodeURIComponent(messageId)}/resources/${encodeURIComponent(resourceKey)}?type=${encodeURIComponent(resourceType)}`;
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Feishu resource download failed: ${res.status} ${text.slice(0, 160)}`);
    }
    return Buffer.from(await res.arrayBuffer());
  }

  // ── Send Message ──

  async sendMessage(chatId: string, message: OutgoingMessage): Promise<string> {
    const token = await this.getTenantToken();
    const body: Record<string, any> = {
      receive_id: chatId,
      msg_type: 'text',
      content: JSON.stringify({ text: message.text }),
    };

    const res = await fetch('https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=chat_id', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
      },
      body: JSON.stringify(body),
    });

    const data: any = await res.json();
    if (data.code !== 0) {
      console.error(`[Feishu] Send error:`, data.msg);
      throw new Error(`Feishu send failed: ${data.msg}`);
    }
    return data.data?.message_id || '';
  }

  async sendCard(chatId: string, card: CardPayload): Promise<string> {
    const token = await this.getTenantToken();
    const feishuCard = {
      config: { wide_screen_mode: true },
      header: {
        title: { tag: 'plain_text', content: card.title },
        ...(card.subtitle ? { subtitle: { tag: 'plain_text', content: card.subtitle } } : {}),
        ...(card.color ? { template: card.color } : {}),
      },
      elements: [
        {
          tag: 'markdown',
          content: card.body,
        },
        ...(card.linkUrl ? [{
          tag: 'action',
          actions: [{
            tag: 'button',
            text: { tag: 'plain_text', content: '查看详情' },
            type: 'primary',
            url: card.linkUrl,
          }],
        }] : []),
      ],
    };

    const body: Record<string, any> = {
      receive_id: chatId,
      msg_type: 'interactive',
      content: JSON.stringify(feishuCard),
    };

    const res = await fetch('https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=chat_id', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
      },
      body: JSON.stringify(body),
    });

    const data: any = await res.json();
    if (data.code !== 0) {
      console.error(`[Feishu] Card send error:`, data.msg);
      throw new Error(`Feishu card send failed: ${data.msg}`);
    }
    return data.data?.message_id || '';
  }

  // ── Reply to specific message ──

  async replyMessage(messageId: string, text: string): Promise<string> {
    const token = await this.getTenantToken();
    const body = {
      content: JSON.stringify({ text }),
      msg_type: 'text',
    };

    const res = await fetch(`https://open.feishu.cn/open-apis/im/v1/messages/${messageId}/reply`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
      },
      body: JSON.stringify(body),
    });

    const data: any = await res.json();
    if (data.code !== 0) {
      console.error(`[Feishu] Reply error:`, data.msg);
      throw new Error(`Feishu reply failed: ${data.msg}`);
    }
    return data.data?.message_id || '';
  }
}
