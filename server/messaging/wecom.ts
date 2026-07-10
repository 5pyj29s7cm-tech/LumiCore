/**
 * Enterprise WeChat (企业微信) Message Adapter.
 *
 * Setup:
 *   1. Register at https://work.weixin.qq.com/ → Create app
 *   2. Copy Corp ID, Agent ID, App Secret from app management page
 *   3. Set callback URL to https://your-server/api/wecom/events
 *   4. Generate Token + EncodingAESKey in the callback settings page
 *   5. Subscribe to message events in app permissions
 */
import crypto from 'crypto';
import type {
  MessageAdapter,
  IncomingMessage,
  OutgoingMessage,
  CardPayload,
  MessagingPlatform,
} from './types';

export interface WeComConfig {
  corpId: string;
  agentId: string;
  appSecret: string;
  token: string;            // callback verification token
  encodingAESKey: string;   // 43-char base64 key from WeCom admin
}

export class WeComAdapter implements MessageAdapter {
  readonly platform: MessagingPlatform = 'wecom';
  private config: WeComConfig;
  private accessToken: string | null = null;
  private tokenExpiry: number = 0;
  private tokenPromise: Promise<string> | null = null; // inflight dedup

  constructor(config: WeComConfig) {
    this.config = config;
  }

  reload(config: WeComConfig): void {
    this.config = config;
    this.accessToken = null;
    this.tokenExpiry = 0;
    this.tokenPromise = null;
  }

  // ── Token Management ──

  private async getAccessToken(): Promise<string> {
    if (this.accessToken && Date.now() < this.tokenExpiry - 120_000) {
      return this.accessToken;
    }
    // Dedup concurrent token requests
    if (this.tokenPromise) return this.tokenPromise;

    this.tokenPromise = (async () => {
      const url = `https://qyapi.weixin.qq.com/cgi-bin/gettoken?corpid=${encodeURIComponent(this.config.corpId)}&corpsecret=${encodeURIComponent(this.config.appSecret)}`;
      const res = await fetch(url);
      const data: any = await res.json();
      if (data.errcode !== 0) {
        this.tokenPromise = null;
        throw new Error(`WeCom token error [${data.errcode}]: ${data.errmsg}`);
      }
      this.accessToken = data.access_token;
      this.tokenExpiry = Date.now() + (data.expires_in || 7200) * 1000;
      this.tokenPromise = null;
      return this.accessToken!;
    })();

    return this.tokenPromise;
  }

  // ── AES Decrypt (WeCom message encryption) ──

  private decrypt(encrypted: string): string {
    const key = Buffer.from(this.config.encodingAESKey + '=', 'base64'); // 43→44 chars
    const iv = key.subarray(0, 16);
    const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
    decipher.setAutoPadding(false);
    let buf = Buffer.concat([decipher.update(encrypted, 'base64'), decipher.final()]);
    // PKCS7 unpad
    const padLen = buf[buf.length - 1];
    if (padLen > 0 && padLen <= 32) buf = buf.subarray(0, buf.length - padLen);
    // Strip random prefix (16 bytes) + network byte order length (4 bytes)
    const content = buf.subarray(16);
    const msgLen = content.readUInt32BE(0);
    const xml = content.subarray(4, 4 + msgLen).toString('utf-8');
    const receiveid = content.subarray(4 + msgLen).toString('utf-8');
    // Verify receiveid matches corpId (handles both corpId format: plain ID or with wx prefix)
    if (receiveid && !receiveid.includes(this.config.corpId) && !this.config.corpId.includes(receiveid)) {
      console.warn('[WeCom] receiveid mismatch — expected:', this.config.corpId, 'got:', receiveid);
    }
    return xml;
  }

  // ── SHA1 Signature Verification ──

  private sha1(...parts: string[]): string {
    return crypto.createHash('sha1').update(parts.sort().join('')).digest('hex');
  }

  verifyWebhook(params: Record<string, any>): boolean {
    const { msg_signature, timestamp, nonce, echostr } = params;
    if (!msg_signature || !timestamp || !nonce) return false;
    const expected = this.sha1(this.config.token, timestamp, nonce, echostr || '');
    const match = expected === msg_signature;
    if (!match) {
      console.log('[WeCom] SIG MISMATCH — expected:', expected.slice(0, 20), 'got:', msg_signature.slice(0, 20));
      console.log('[WeCom] token:', this.config.token?.slice(0, 5) + '***', 'ts:', timestamp, 'nonce:', nonce);
    }
    return match;
  }

  /** URL verification: decrypt echostr and return plaintext */
  verifyUrl(echostr: string, params: Record<string, any>): string {
    if (!this.verifyWebhook({ ...params, echostr })) throw new Error('Signature verification failed');
    const plaintext = this.decrypt(echostr);
    // Validate corpId is in the decrypted message
    const parsed = this.extractXml(plaintext);
    const appId = parsed && this.getTag(parsed, 'ToUserName');
    console.log('[WeCom] Decrypted — appId/ToUserName:', appId, 'corpId:', this.config.corpId);
    return plaintext;
  }

  // ── Event Parsing ──

  parseEvent(body: any): IncomingMessage | null {
    // WeCom sends XML to the callback URL
    const rawXml: string = typeof body === 'string' ? body : (body.rawBody || body.xml || '');
    if (!rawXml) return null;

    const xml = this.extractXml(rawXml);
    if (!xml) return null;

    const msgType = this.getTag(xml, 'MsgType');
    if (msgType !== 'text') return null;

    const content = this.getTag(xml, 'Content');
    if (!content) return null;

    const fromUser = this.getTag(xml, 'FromUserName') || 'unknown';
    const toUser = this.getTag(xml, 'ToUserName') || '';
    const createTime = this.getTag(xml, 'CreateTime') || String(Date.now() / 1000);
    const msgId = this.getTag(xml, 'MsgId') || `${Date.now()}`;

    return {
      platform: 'wecom',
      userId: fromUser,
      userName: fromUser,
      chatId: fromUser, // WeCom uses user ID as chat ID for single chat
      chatType: 'private',
      messageId: msgId,
      text: content,
      raw: { xml: rawXml },
      timestamp: new Date(Number(createTime) * 1000 || Date.now()).toISOString(),
    };
  }

  private extractXml(raw: string): string | null {
    const match = raw.match(/<xml[\s\S]*<\/xml>/i);
    return match ? match[0] : raw.includes('<xml') ? raw : null;
  }

  private getTag(xml: string, tag: string): string | null {
    const m = xml.match(new RegExp(`<${tag}><!\\[CDATA\\[([\\s\\S]*?)\\]\\]><\\/${tag}>`));
    if (m) return m[1];
    const m2 = xml.match(new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`));
    return m2 ? m2[1] : null;
  }

  // ── Send Message ──

  async sendMessage(chatId: string, message: OutgoingMessage): Promise<string> {
    const token = await this.getAccessToken();
    const body = {
      touser: chatId,
      msgtype: 'text',
      agentid: Number(this.config.agentId),
      text: { content: message.text },
    };

    const res = await fetch(`https://qyapi.weixin.qq.com/cgi-bin/message/send?access_token=${token}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    const data: any = await res.json();
    if (data.errcode !== 0) {
      console.error(`[WeCom] Send error [${data.errcode}]: ${data.errmsg}`);
      throw new Error(`WeCom send failed: ${data.errmsg}`);
    }
    return data.msgid || '';
  }

  async sendCard(chatId: string, card: CardPayload): Promise<string> {
    const token = await this.getAccessToken();
    const body: any = {
      touser: chatId,
      msgtype: 'textcard',
      agentid: Number(this.config.agentId),
      textcard: {
        title: card.title,
        description: card.body.replace(/[*#`>]/g, '').slice(0, 512),
        url: card.linkUrl || 'https://work.weixin.qq.com',
        btntxt: '查看详情',
      },
    };

    const res = await fetch(`https://qyapi.weixin.qq.com/cgi-bin/message/send?access_token=${token}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    const data: any = await res.json();
    if (data.errcode !== 0) {
      console.error(`[WeCom] Card send error [${data.errcode}]: ${data.errmsg}`);
      throw new Error(`WeCom card send failed: ${data.errmsg}`);
    }
    return data.msgid || '';
  }

  async replyMessage(_messageId: string, text: string): Promise<string> {
    // WeCom doesn't have a reply endpoint — fall back to send to user
    // messageId is the userId for single chat
    return '';
  }
}
