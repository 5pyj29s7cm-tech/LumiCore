/**
 * WeChat ClawBot Adapter — 腾讯官方个人号 Bot API (iLink 协议)
 *
 * 接入方式：
 *   1. Lumi Settings → Messaging → WeChat 页签 → 点「获取二维码」
 *   2. 手机微信扫描二维码 → 确认登录
 *   3. Lumi 自动开始接收和回复微信消息
 *
 * 不需要企业注册、不需要域名、不需要 Webhook 回调。
 * 基于腾讯 ilinkai.weixin.qq.com 的官方开放的个人 Bot API。
 */

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { getDataPath } from '../config/data_path';
import type {
  MessageAdapter,
  IncomingMessage,
  OutgoingMessage,
  CardPayload,
  MessagingPlatform,
} from './types';

export interface WeChatClawBotConfig {
  botToken: string;
  botId: string;         // bot user ID (xxx@im.bot)
  baseUrl: string;       // returned by QR login, typically https://ilinkai.weixin.qq.com
  enabled: boolean;
}

// ── API types ──

interface QRCodeResponse {
  qrcode: string;            // base64 PNG image
  qrcode_id: string;         // QR code identifier for polling
  qrcode_img_content: string; // URL to QR image
  ret: number;
}

interface QRCodeStatusResponse {
  status: 'pending' | 'scanned' | 'confirmed' | 'expired';
  bot_token?: string;
  bot_id?: string;
  baseurl?: string;
  extra_info?: string;
}

interface WeixinMessage {
  seq?: number;
  message_id?: number;
  client_id?: string;
  create_time_ms?: number;
  from_user_id: string;
  to_user_id: string;
  message_type: number;
  message_state: number;
  context_token: string;
  item_list: Array<{
    type: number;
    text_item?: { text: string };
  }>;
}

interface GetUpdatesResponse {
  ret?: number;
  errcode?: number;
  errmsg?: string;
  msgs?: WeixinMessage[];
  get_updates_buf?: string;
  longpolling_timeout_ms?: number;
}

export interface WeChatConnectionStatus {
  listening: boolean;
  sessionExpired: boolean;
  lastPollAt: string | null;
  lastMessageAt: string | null;
  lastReplyAt: string | null;
  lastError: string | null;
}

// ── Adapter ──

export class WeChatClawBotAdapter implements MessageAdapter {
  readonly platform: MessagingPlatform = 'wechat';
  private config: WeChatClawBotConfig;
  private readonly cursorPathOverride?: string;
  private cursor: string = '';  // get_updates_buf
  private processedMessageIds = new Set<string>();
  private pollingRun: { value: boolean } | null = null;
  private pollingAbort: AbortController | null = null;
  private onMessage: ((msg: IncomingMessage) => Promise<OutgoingMessage | null>) | null = null;
  private suggestedLongPollMs = 35_000;
  private health: Omit<WeChatConnectionStatus, 'listening'> = {
    sessionExpired: false,
    lastPollAt: null,
    lastMessageAt: null,
    lastReplyAt: null,
    lastError: null,
  };

  constructor(config: WeChatClawBotConfig, options?: { cursorPath?: string }) {
    this.config = { ...config };
    this.cursorPathOverride = options?.cursorPath;
    this.cursor = this.readCursor();
  }

  reload(config: WeChatClawBotConfig): void {
    const accountChanged = this.accountKey(this.config) !== this.accountKey(config);
    this.config = { ...config };
    if (accountChanged) {
      this.cursor = this.readCursor();
      this.health.sessionExpired = false;
      this.health.lastError = null;
    }
  }

  isPolling(): boolean {
    return Boolean(this.pollingRun?.value);
  }

  getStatus(): WeChatConnectionStatus {
    return { listening: this.isPolling(), ...this.health };
  }

  private accountKey(config = this.config): string {
    return `${config.baseUrl || 'https://ilinkai.weixin.qq.com'}|${config.botId || config.botToken || 'unconfigured'}`;
  }

  private cursorPath(): string {
    if (this.cursorPathOverride) return this.cursorPathOverride;
    const key = crypto.createHash('sha256').update(this.accountKey()).digest('hex').slice(0, 20);
    return getDataPath(path.join('messaging', `wechat-cursor-${key}.json`));
  }

  private readCursor(): string {
    try {
      const data = JSON.parse(fs.readFileSync(this.cursorPath(), 'utf8'));
      this.processedMessageIds = new Set(
        Array.isArray(data?.processed_message_ids) ? data.processed_message_ids.map(String).slice(-500) : [],
      );
      return typeof data?.get_updates_buf === 'string' ? data.get_updates_buf : '';
    } catch {
      this.processedMessageIds.clear();
      return '';
    }
  }

  private saveCursor(cursor: string): void {
    try {
      const target = this.cursorPath();
      fs.mkdirSync(path.dirname(target), { recursive: true });
      const temp = `${target}.${process.pid}.${Date.now()}.tmp`;
      fs.writeFileSync(temp, JSON.stringify({
        get_updates_buf: cursor,
        processed_message_ids: [...this.processedMessageIds].slice(-500),
        updatedAt: new Date().toISOString(),
      }), 'utf8');
      fs.renameSync(temp, target);
    } catch (err: any) {
      console.warn('[WeChat] Cursor persistence failed:', err?.message || err);
    }
  }

  private baseInfo() {
    return { channel_version: '3.0.0', bot_agent: 'Lumi/3.0.0' };
  }

  // ── Auth: get QR code for login ──

  async getQRCode(): Promise<QRCodeResponse> {
    const res = await fetch('https://ilinkai.weixin.qq.com/ilink/bot/get_bot_qrcode?bot_type=3');
    const data = await res.json();
    if (!data.qrcode) throw new Error(`QR code fetch failed: ${JSON.stringify(data)}`);
    // qrcode_img_content is a liteapp.weixin.qq.com URL — the QR image must be fetched through
    // WeChat's CDN which only works from within the WeChat client. Use the QR code ID string
    // to generate the QR locally instead.
    return { qrcode: data.qrcode, qrcode_id: data.qrcode, qrcode_img_content: data.qrcode_img_content, ret: data.ret || 0 };
  }

  async checkQRCodeStatus(qrcodeId: string): Promise<QRCodeStatusResponse> {
    const res = await fetch(`https://ilinkai.weixin.qq.com/ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcodeId)}`);
    const data = await res.json();
    // ret=0 means success (scanned + confirmed), ret!=0 means pending/error
    const isConfirmed = data.ret === 0 && data.bot_token;
    return {
      status: isConfirmed ? 'confirmed' : (data.status || 'pending'),
      bot_token: data.bot_token,
      bot_id: data.bot_id,
      baseurl: data.baseurl || 'https://ilinkai.weixin.qq.com',
      extra_info: data.extra_info,
    };
  }

  // ── Activation ──

  private makeHeaders(): Record<string, string> {
    // iLink expects: random uint32 -> decimal UTF-8 string -> base64.
    const uin = crypto.randomBytes(4).readUInt32BE(0);
    const uinB64 = Buffer.from(String(uin), 'utf8').toString('base64');
    return {
      'Content-Type': 'application/json',
      'AuthorizationType': 'ilink_bot_token',
      'X-WECHAT-UIN': uinB64,
      'Authorization': `Bearer ${this.config.botToken}`,
    };
  }

  private async activate(): Promise<void> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);
    try {
      const base = this.config.baseUrl || 'https://ilinkai.weixin.qq.com';
      const res = await fetch(`${base}/ilink/bot/msg/notifystart`, {
        method: 'POST',
        headers: this.makeHeaders(),
        body: JSON.stringify({ base_info: this.baseInfo() }),
        signal: controller.signal,
      });
      if (!res.ok) throw new Error(`notifyStart HTTP ${res.status}`);
      const data: any = await res.json().catch(() => ({}));
      if (data.ret && data.ret !== 0) {
        throw new Error(data.errmsg || `notifyStart ret=${data.ret}`);
      }
      console.log('[WeChat] Bot session announced');
    } catch (err: any) {
      if (err?.name !== 'AbortError') console.warn('[WeChat] Activation:', err?.message || err);
    } finally {
      clearTimeout(timeout);
    }
  }

  // ── Messaging: long-poll for new messages ──

  /** Start long-polling loop. Calls onMessage callback for each incoming message. */
  async startPolling(onMessage: (msg: IncomingMessage) => Promise<OutgoingMessage | null>): Promise<void> {
    this.onMessage = onMessage;
    if (this.pollingRun?.value) return;

    const running = { value: true };
    this.pollingRun = running;
    this.health.sessionExpired = false;
    this.health.lastError = null;

    // Session announcement is best-effort and must not delay the first receive poll.
    void this.activate();

    const poll = async () => {
      while (running.value) {
        let timeout: ReturnType<typeof setTimeout> | null = null;
        const controller = new AbortController();
        this.pollingAbort = controller;
        try {
          const body = {
            get_updates_buf: this.cursor || '',
            base_info: this.baseInfo(),
          };
          timeout = setTimeout(() => controller.abort(), Math.max(10_000, this.suggestedLongPollMs + 5_000));

          const res = await fetch(`${this.config.baseUrl || 'https://ilinkai.weixin.qq.com'}/ilink/bot/getupdates`, {
            method: 'POST',
            headers: this.makeHeaders(),
            body: JSON.stringify(body),
            signal: controller.signal,
          });

          if (!res.ok) throw new Error(`getUpdates HTTP ${res.status}`);
          const data: GetUpdatesResponse = await res.json();
          this.health.lastPollAt = new Date().toISOString();
          if (Number.isFinite(data.longpolling_timeout_ms) && Number(data.longpolling_timeout_ms) > 0) {
            this.suggestedLongPollMs = Number(data.longpolling_timeout_ms);
          }
          const ret = data.ret ?? data.errcode ?? 0;
          if (ret !== 0) {
            const reason = data.errmsg || `getUpdates ret=${ret}`;
            this.health.lastError = reason;
            if (ret === -14 || data.errcode === -14) {
              this.health.sessionExpired = true;
              running.value = false;
              console.error('[WeChat] Session expired; QR authorization is required again');
              break;
            }
            throw new Error(reason);
          }

          const messages = Array.isArray(data.msgs) ? data.msgs : [];
          console.log('[WeChat] Poll response — ret:', ret, 'messages:', messages.length);
          if (messages.length > 0) {
            for (const msg of messages) {
              const parsed = this.parseEvent(msg);
              if (parsed) console.log('[WeChat] Received message', parsed.messageId, 'type:', msg.message_type);
              if (parsed && this.onMessage) {
                if (this.processedMessageIds.has(parsed.messageId)) {
                  console.log('[WeChat] Skipping already completed message', parsed.messageId);
                  continue;
                }
                this.health.lastMessageAt = new Date().toISOString();
                const reply = await this.onMessage(parsed);
                if (reply) {
                  // Must carry the context_token from the inbound message to the outbound reply
                  (reply as any).context_token = (parsed.raw as any)?.context_token || msg.context_token || '';
                  await this.sendMessage(parsed.userId, reply);
                  this.health.lastReplyAt = new Date().toISOString();
                }
                this.processedMessageIds.add(parsed.messageId);
                this.saveCursor(this.cursor);
              }
            }
          }
          if (typeof data.get_updates_buf === 'string') {
            this.cursor = data.get_updates_buf;
            this.processedMessageIds.clear();
            this.saveCursor(this.cursor);
          }
          this.health.lastError = null;
        } catch (err: any) {
          if (!running.value) break;
          if (err.name === 'AbortError' || err.name === 'TimeoutError') {
            // Expected on long-poll timeout — reconnect immediately
            continue;
          }
          this.health.lastError = err?.message || String(err);
          console.error('[WeChat] Poll error:', err.message);
          await new Promise(r => setTimeout(r, 3000));
        } finally {
          if (timeout) clearTimeout(timeout);
          if (this.pollingAbort === controller) this.pollingAbort = null;
        }
      }
      if (this.pollingRun === running) this.pollingRun = null;
    };

    void poll();
  }

  /** Stop long-polling loop */
  stopPolling(): void {
    if (this.pollingRun) {
      this.pollingRun.value = false;
      this.pollingRun = null;
    }
    this.pollingAbort?.abort();
    this.pollingAbort = null;
  }

  // ── Event Parsing ──

  parseEvent(event: any): IncomingMessage | null {
    const msg: WeixinMessage = event;

    if (!msg.from_user_id || msg.message_type !== 1) return null; // text only
    const textItem = msg.item_list?.find(i => i.type === 1)?.text_item;
    if (!textItem?.text) return null;

    return {
      platform: 'wechat',
      userId: msg.from_user_id,
      userName: msg.from_user_id,
      chatId: msg.from_user_id, // for now 1:1
      chatType: 'private',
      messageId: String(msg.message_id || msg.client_id || crypto.randomUUID()),
      text: textItem.text,
      raw: { context_token: msg.context_token, message: msg },
      timestamp: new Date(msg.create_time_ms || Date.now()).toISOString(),
    };
  }

  // ── Send Message ──

  async sendMessage(toUser: string, message: OutgoingMessage): Promise<string> {
    const contextToken = (message as any).context_token || '';
    const clientId = crypto.randomUUID();
    const msg: any = {
      to_user_id: toUser,
      client_id: clientId,
      message_type: 2,
      message_state: 2,
      item_list: [{ type: 1, text_item: { text: message.text } }],
    };
    if (contextToken) msg.context_token = contextToken;

    const url = `${this.config.baseUrl || 'https://ilinkai.weixin.qq.com'}/ilink/bot/sendmessage`;
    const res = await fetch(url, {
      method: 'POST',
      headers: this.makeHeaders(),
      body: JSON.stringify({ msg, base_info: this.baseInfo() }),
    });

    if (!res.ok) throw new Error(`WeChat send failed: HTTP ${res.status}`);
    const data = await res.json();
    if (data.ret && data.ret !== 0) {
      const reason = data.errmsg || data.errcode || `ret=${data.ret}`;
      console.error('[WeChat] Send failed:', reason);
      throw new Error(`WeChat send failed: ${reason}`);
    }
    return data.message_id || clientId;
  }

  async sendCard(_chatId: string, _card: CardPayload): Promise<string> {
    // WeChat iLink doesn't support cards yet — fall back to inline text
    return '';
  }

  getLoginQRUrl(): string {
    return '/api/wechat/qrcode';
  }
}

// ── Static helpers ──

export function createWeChatAdapter(config: WeChatClawBotConfig): WeChatClawBotAdapter {
  return new WeChatClawBotAdapter(config);
}
