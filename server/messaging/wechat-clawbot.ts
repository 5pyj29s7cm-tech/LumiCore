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
  ok: boolean;
  messages?: WeixinMessage[];
  get_updates_buf?: string;
}

// ── Adapter ──

export class WeChatClawBotAdapter implements MessageAdapter {
  readonly platform: MessagingPlatform = 'wechat';
  private config: WeChatClawBotConfig;
  private cursor: string = '';  // get_updates_buf
  private pollingTimer: ReturnType<typeof setInterval> | null = null;
  private pollingAbort: AbortController | null = null;
  private onMessage: ((msg: IncomingMessage) => Promise<OutgoingMessage | null>) | null = null;

  constructor(config: WeChatClawBotConfig) {
    this.config = config;
  }

  reload(config: WeChatClawBotConfig): void {
    this.config = config;
  }

  isPolling(): boolean {
    return !!this.pollingTimer;
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
    // X-WECHAT-UIN must be base64 of a 32-bit unsigned integer, not a string
    const uin = crypto.randomInt(1, 4294967295);
    const buf = Buffer.alloc(4);
    buf.writeUInt32BE(uin, 0);
    const uinB64 = buf.toString('base64');
    return {
      'Content-Type': 'application/json',
      'AuthorizationType': 'ilink_bot_token',
      'X-WECHAT-UIN': uinB64,
      'Authorization': `Bearer ${this.config.botToken}`,
    };
  }

  private async activate(): Promise<void> {
    try {
      const base = this.config.baseUrl || 'https://ilinkai.weixin.qq.com';

      const cfgRes = await fetch(`${base}/ilink/bot/getconfig`, {
        method: 'POST', headers: this.makeHeaders(),
        body: JSON.stringify({ ilink_user_id: this.config.botId }),
      });
      const cfgText = await cfgRes.text();
      let cfg: any = {};
      try { cfg = JSON.parse(cfgText); } catch {}
      const ticket = cfg?.typing_ticket || cfg?.ticket || '';
      console.log('[WeChat] Activation configuration received:', ticket ? 'typing enabled' : 'no typing ticket');

      if (ticket) {
        await fetch(`${base}/ilink/bot/sendtyping`, {
          method: 'POST', headers: this.makeHeaders(),
          body: JSON.stringify({ ticket, to_user_id: this.config.botId }),
        });
        console.log('[WeChat] sendtyping ok');
      }
    } catch (err: any) {
      console.warn('[WeChat] Activation:', err.message);
    }
  }

  // ── Messaging: long-poll for new messages ──

  /** Start long-polling loop. Calls onMessage callback for each incoming message. */
  async startPolling(onMessage: (msg: IncomingMessage) => Promise<OutgoingMessage | null>): Promise<void> {
    this.onMessage = onMessage;
    if (this.pollingTimer) return;

    const running = { value: true };
    this.pollingTimer = running as any;

    // Activate the bot session before polling
    await this.activate();

    const poll = async () => {
      while (running.value) {
        let timeout: ReturnType<typeof setTimeout> | null = null;
        const controller = new AbortController();
        this.pollingAbort = controller;
        try {
          const body: any = {};
          if (this.cursor) body.get_updates_buf = this.cursor;
          timeout = setTimeout(() => controller.abort(), 40_000);

          const res = await fetch(`${this.config.baseUrl || 'https://ilinkai.weixin.qq.com'}/ilink/bot/getupdates`, {
            method: 'POST',
            headers: this.makeHeaders(),
            body: JSON.stringify(body),
            signal: controller.signal,
          });

          const data: GetUpdatesResponse = await res.json();
          console.log('[WeChat] Poll response — ok:', data.ok, 'messages:', data.messages?.length || 0);
          if (data.get_updates_buf) this.cursor = data.get_updates_buf;

          if (data.messages && data.messages.length > 0) {
            for (const msg of data.messages) {
              const parsed = this.parseEvent(msg);
              if (parsed) console.log('[WeChat] Received message', parsed.messageId, 'type:', msg.message_type);
              if (parsed && this.onMessage) {
                const reply = await this.onMessage(parsed).catch(() => null);
                if (reply) {
                  // Must carry the context_token from the inbound message to the outbound reply
                  (reply as any).context_token = (parsed.raw as any)?.context_token || msg.context_token || '';
                  await this.sendMessage(parsed.userId, reply).catch(e => console.error('[WeChat] Send error:', e));
                }
              }
            }
          }
        } catch (err: any) {
          if (!running.value) break;
          if (err.name === 'AbortError' || err.name === 'TimeoutError') {
            // Expected on long-poll timeout — reconnect immediately
            continue;
          }
          console.error('[WeChat] Poll error:', err.message);
          await new Promise(r => setTimeout(r, 3000));
        } finally {
          if (timeout) clearTimeout(timeout);
          if (this.pollingAbort === controller) this.pollingAbort = null;
        }
      }
      if (this.pollingTimer === (running as any)) this.pollingTimer = null;
    };

    poll(); // start the loop
  }

  /** Stop long-polling loop */
  stopPolling(): void {
    if (this.pollingTimer) {
      (this.pollingTimer as any).value = false;
      this.pollingTimer = null;
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
      messageId: crypto.randomUUID(),
      text: textItem.text,
      raw: { context_token: msg.context_token, message: msg },
      timestamp: new Date().toISOString(),
    };
  }

  // ── Send Message ──

  async sendMessage(toUser: string, message: OutgoingMessage): Promise<string> {
    const contextToken = (message as any).context_token || '';

    const body: any = {
      to_user_id: toUser,
      message_type: 1,
      item_list: [{ type: 1, text_item: { text: message.text } }],
    };
    if (contextToken) body.context_token = contextToken;

    const url = `${this.config.baseUrl || 'https://ilinkai.weixin.qq.com'}/ilink/bot/sendmessage`;
    const res = await fetch(url, {
      method: 'POST',
      headers: this.makeHeaders(),
      body: JSON.stringify(body),
    });

    const data = await res.json();
    if (!data.ok && data.ok !== undefined) {
      const reason = data.error || data.errmsg || data.errcode || 'unknown error';
      console.error('[WeChat] Send failed:', reason);
      throw new Error(`WeChat send failed: ${reason}`);
    }
    return data.message_id || crypto.randomUUID();
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
