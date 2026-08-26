/**
 * Lumi Messaging — Unified message adapter types.
 * Supports: Feishu, Telegram, WeChat, Web Chat
 */

export type MessagingPlatform = 'feishu' | 'telegram' | 'wechat' | 'wecom' | 'web';

export interface IncomingMessage {
  platform: MessagingPlatform;
  userId: string;          // platform user ID
  userName: string;        // display name
  chatId: string;          // conversation/group ID
  chatType: 'private' | 'group';
  threadId?: string;       // platform thread/topic/root-message ID
  /** True only when the platform payload proves that this bot was mentioned. */
  botMentioned?: boolean;
  mentionedUserIds?: string[];
  messageId: string;       // platform message ID
  text: string;            // plain text content
  attachments?: IncomingAttachment[];
  boundUserId?: string;
  boundOrgId?: string;
  raw: Record<string, any>; // raw platform payload
  timestamp: string;
  /** Local receipt time, independent from the platform timestamp. */
  receivedAt?: string;
  /** Monotonic sequence within the visible external conversation. */
  routeSequence?: number;
  /** Internal marker used when ingress persistence happened before queued execution. */
  userMessagePersisted?: boolean;
  /** Exact durable Lumi transcript row that owns this routed request. */
  userMessageId?: string;
}

export interface IncomingAttachment {
  id: string;
  type: 'file' | 'image' | 'media' | 'audio' | 'unknown';
  fileName: string;
  fileSize?: number;
  mimeType?: string;
  resourceKey?: string;
  resourceType?: string;
  downloadUrl?: string;
  encryptionKey?: string;
  localPath?: string;
  extractedText?: string;
  parseError?: string;
}

export interface OutgoingMessage {
  text: string;
  idempotencyKey?: string;
  replyTo?: string;        // message ID to reply to
  buttons?: MessageButton[];
  card?: CardPayload;      // rich card (Feishu/Telegram)
  platform: MessagingPlatform;
}

export interface MessageButton {
  label: string;
  action: string;          // callback data
  style?: 'primary' | 'default' | 'danger';
}

export interface CardPayload {
  title: string;
  subtitle?: string;
  body: string;
  color?: string;          // Feishu: red/green/blue/yellow/purple
  linkUrl?: string;
}

export interface MessageAdapter {
  readonly platform: MessagingPlatform;
  sendMessage(chatId: string, message: OutgoingMessage): Promise<string>;
  sendCard(chatId: string, card: CardPayload): Promise<string>;
  verifyWebhook?(params: Record<string, any>): boolean;
  parseEvent(body: any): IncomingMessage | null;
}

export type MessageHandler = (message: IncomingMessage) => Promise<OutgoingMessage | null>;
