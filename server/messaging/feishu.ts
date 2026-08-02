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
import {
  claimExternalCommitAttempt,
  settleExternalCommitAttempt,
} from '../tools/external_commit_journal';
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
  botOpenId?: string;
}

export class MessagingDeliveryUnknownError extends Error {
  readonly messagingDeliveryUnknown = true;

  constructor(message: string) {
    super(message);
    this.name = 'MessagingDeliveryUnknownError';
  }
}

export function isMessagingDeliveryUnknownError(error: unknown): boolean {
  return Boolean((error as any)?.messagingDeliveryUnknown);
}

export class FeishuAdapter implements MessageAdapter {
  readonly platform: MessagingPlatform = 'feishu';
  private config: FeishuConfig;
  private tenantToken: string | null = null;
  private tokenExpiry: number = 0;
  private tokenPromise: Promise<string> | null = null;
  private botOpenId = '';
  private botIdentityPromise: Promise<string> | null = null;

  constructor(config: FeishuConfig) {
    this.config = config;
    this.botOpenId = String(config.botOpenId || '');
  }

  // ── Reinitialize after config change ──

  reload(config: FeishuConfig): void {
    this.config = config;
    this.tenantToken = null;
    this.tokenExpiry = 0;
    this.tokenPromise = null;
    this.botOpenId = String(config.botOpenId || '');
    this.botIdentityPromise = null;
  }

  async ensureBotIdentity(): Promise<string> {
    if (this.botOpenId) return this.botOpenId;
    if (this.botIdentityPromise) return this.botIdentityPromise;
    this.botIdentityPromise = (async () => {
      const token = await this.getTenantToken();
      const response = await fetch('https://open.feishu.cn/open-apis/bot/v3/info', {
        headers: { Authorization: `Bearer ${token}` },
      });
      const body: any = await response.json().catch(() => ({}));
      const openId = String(body?.bot?.open_id || body?.data?.bot?.open_id || '');
      if (!response.ok || body?.code !== 0 || !openId) {
        throw new Error(`Feishu bot identity error: ${body?.msg || body?.error || response.status}`);
      }
      this.botOpenId = openId;
      return openId;
    })();
    try {
      return await this.botIdentityPromise;
    } finally {
      this.botIdentityPromise = null;
    }
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
    const mentions = Array.isArray(message.mentions) ? message.mentions : [];
    const mentionedUserIds = mentions.flatMap((mention: any) => [
      mention?.id?.open_id,
      mention?.open_id,
    ]).filter(Boolean).map(String);
    const botMentioned = message.chat_type !== 'group'
      || Boolean(this.botOpenId && mentionedUserIds.includes(this.botOpenId));
    const botMentionKeys = mentions
      .filter((mention: any) => [mention?.id?.open_id, mention?.open_id].includes(this.botOpenId))
      .map((mention: any) => String(mention?.key || ''))
      .filter(Boolean);
    const attachments = this.parseAttachments(message.message_type, parsedContent);
    const textContent = message.message_type === 'text'
      ? botMentionKeys.reduce(
        (text, key) => text.replaceAll(key, ' '),
        String(parsedContent.text || ''),
      ).replace(/\s+/g, ' ').trim()
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
      threadId: message.thread_id || message.root_id || message.parent_id || undefined,
      botMentioned,
      mentionedUserIds,
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

  async uploadFile(buffer: Buffer, fileName: string, fileType = 'stream'): Promise<string> {
    if (buffer.byteLength === 0) throw new Error('Feishu file upload rejected an empty file');
    if (buffer.byteLength > 30 * 1024 * 1024) throw new Error('Feishu file upload limit is 30 MB');
    const token = await this.getTenantToken();
    const form = new FormData();
    form.append('file_type', fileType);
    form.append('file_name', fileName);
    form.append('file', new Blob([new Uint8Array(buffer)]), fileName);

    const res = await fetch('https://open.feishu.cn/open-apis/im/v1/files', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: form,
    });
    const data: any = await res.json().catch(() => ({}));
    if (!res.ok || data.code !== 0 || !data.data?.file_key) {
      throw new Error(`Feishu file upload failed: ${data.msg || data.error || res.status}`);
    }
    return String(data.data.file_key);
  }

  async sendFile(chatId: string, buffer: Buffer, fileName: string, fileType = 'stream'): Promise<string> {
    const fileKey = await this.uploadFile(buffer, fileName, fileType);
    const token = await this.getTenantToken();
    const res = await fetch('https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=chat_id', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
      },
      body: JSON.stringify({
        receive_id: chatId,
        msg_type: 'file',
        content: JSON.stringify({ file_key: fileKey }),
      }),
    });
    const data: any = await res.json().catch(() => ({}));
    if (!res.ok || data.code !== 0) {
      throw new Error(`Feishu file send failed: ${data.msg || data.error || res.status}`);
    }
    return String(data.data?.message_id || '');
  }

  // ── Send Message ──

  async sendMessage(chatId: string, message: OutgoingMessage): Promise<string> {
    const token = await this.getTenantToken();
    const body: Record<string, any> = {
      receive_id: chatId,
      msg_type: 'text',
      content: JSON.stringify({ text: message.text }),
    };

    const uuid = this.deliveryUuid(message.idempotencyKey || randomDeliverySeed());
    return this.durableDelivery({
      idempotencyKey: `feishu:send:${uuid}`,
      toolName: 'feishu_send_message',
      target: chatId,
      payload: body,
      execute: async () => {
        const { data } = await this.deliveryRequest(
          `https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=chat_id&uuid=${uuid}`,
          token,
          body,
          'send',
        );
        return data.data.message_id;
      },
    });
  }

  async sendCard(chatId: string, card: CardPayload, idempotencyKey?: string): Promise<string> {
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

    const uuid = this.deliveryUuid(idempotencyKey || randomDeliverySeed());
    return this.durableDelivery({
      idempotencyKey: `feishu:card:${uuid}`,
      toolName: 'feishu_send_card',
      target: chatId,
      payload: body,
      execute: async () => {
        const { data } = await this.deliveryRequest(
          `https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=chat_id&uuid=${uuid}`,
          token,
          body,
          'card send',
        );
        return data.data.message_id;
      },
    });
  }

  // ── Reply to specific message ──

  async replyMessage(messageId: string, text: string): Promise<string> {
    const token = await this.getTenantToken();
    const body = {
      content: JSON.stringify({ text }),
      msg_type: 'text',
    };

    const uuid = this.deliveryUuid(`reply:${messageId}:${crypto.createHash('sha256').update(text).digest('hex')}`);
    return this.durableDelivery({
      idempotencyKey: `feishu:reply:${uuid}`,
      toolName: 'feishu_reply_message',
      target: messageId,
      payload: body,
      execute: async () => {
        const { data } = await this.deliveryRequest(
          `https://open.feishu.cn/open-apis/im/v1/messages/${encodeURIComponent(messageId)}/reply?uuid=${uuid}`,
          token,
          body,
          'reply',
        );
        return data.data.message_id;
      },
    });
  }

  private deliveryUuid(seed: string): string {
    return crypto.createHash('sha256').update(seed).digest('hex').slice(0, 32);
  }

  private async deliveryRequest(
    url: string,
    token: string,
    body: Record<string, any>,
    operation: string,
  ): Promise<{ data: any }> {
    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(body),
      });
    } catch (error: any) {
      throw new MessagingDeliveryUnknownError(
        `Feishu ${operation} result is unknown; automatic fallback send was stopped: ${error?.message || error}`,
      );
    }
    let data: any;
    try {
      data = await response.json();
    } catch (error: any) {
      throw new MessagingDeliveryUnknownError(
        `Feishu ${operation} returned an unreadable acknowledgement; automatic resend was stopped: ${error?.message || error}`,
      );
    }
    if (!response.ok || data.code !== 0) {
      if (response.status >= 500) {
        throw new MessagingDeliveryUnknownError(
          `Feishu ${operation} outcome is unknown after provider error ${response.status}; automatic resend was stopped`,
        );
      }
      throw new Error(`Feishu ${operation} failed: ${data.msg || data.error || response.status}`);
    }
    if (!data.data?.message_id) {
      throw new MessagingDeliveryUnknownError(
        `Feishu ${operation} acknowledgement did not contain a message ID; automatic resend was stopped`,
      );
    }
    return { data };
  }

  private async durableDelivery(input: {
    idempotencyKey: string;
    toolName: string;
    target: string;
    payload: Record<string, any>;
    execute: () => Promise<string>;
  }): Promise<string> {
    const inputDigest = crypto.createHash('sha256')
      .update(JSON.stringify({ target: input.target, payload: input.payload }))
      .digest('hex');
    const claimToken = crypto.randomUUID();
    const timestamp = new Date().toISOString();
    const claim = await claimExternalCommitAttempt({
      idempotencyKey: input.idempotencyKey,
      taskId: input.idempotencyKey,
      userId: 'messaging-runtime',
      toolName: input.toolName,
      inputDigest,
      state: 'running',
      replayResult: '',
      claimToken,
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    if (!claim.claimed) {
      if (claim.entry.inputDigest !== inputDigest) {
        throw new Error('Feishu delivery idempotency key is already bound to a different target or payload');
      }
      if (claim.entry.state === 'verified') {
        try {
          const replay = JSON.parse(claim.entry.replayResult || '{}');
          if (replay.messageId) return String(replay.messageId);
        } catch {}
      }
      throw new MessagingDeliveryUnknownError(
        'A prior Feishu delivery with the same idempotency key is running or unknown; automatic resend was stopped',
      );
    }

    try {
      const messageId = await input.execute();
      const settled = await settleExternalCommitAttempt({
        idempotencyKey: input.idempotencyKey,
        claimToken,
        state: 'verified',
        replayResult: JSON.stringify({ messageId }),
        updatedAt: new Date().toISOString(),
      });
      if (!settled) {
        throw new MessagingDeliveryUnknownError(
          'Feishu acknowledged delivery but its durable receipt could not be settled; automatic resend was stopped',
        );
      }
      return messageId;
    } catch (error: any) {
      if (!isMessagingDeliveryUnknownError(error)) {
        await settleExternalCommitAttempt({
          idempotencyKey: input.idempotencyKey,
          claimToken,
          state: 'unknown',
          replayResult: '',
          updatedAt: new Date().toISOString(),
        }).catch(() => false);
      } else {
        await settleExternalCommitAttempt({
          idempotencyKey: input.idempotencyKey,
          claimToken,
          state: 'unknown',
          replayResult: '',
          updatedAt: new Date().toISOString(),
        }).catch(() => false);
      }
      throw error;
    }
  }
}

function randomDeliverySeed(): string {
  return crypto.randomUUID();
}
