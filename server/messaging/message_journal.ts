import fs from 'fs';
import path from 'path';
import { getDataPath } from '../config/data_path';
import type { IncomingMessage } from './types';

export type MessagingJournalStatus =
  | 'received'
  | 'processing'
  | 'replied'
  | 'completed'
  | 'superseded'
  | 'ignored'
  | 'delivery_unknown'
  | 'failed';

export interface MessagingJournalEntry {
  key: string;
  platform: IncomingMessage['platform'];
  messageId: string;
  platformUserId: string;
  boundUserId?: string;
  bindingAuthorization?: IncomingMessage['bindingAuthorization'];
  organizationAuthorization?: IncomingMessage['organizationAuthorization'];
  chatId: string;
  chatType: IncomingMessage['chatType'];
  threadId: string;
  text: string;
  attachmentNames: string[];
  externalTimestamp: string;
  receivedAt: string;
  updatedAt: string;
  status: MessagingJournalStatus;
  routeSequence?: number;
  domain?: 'personal' | 'work';
  orgId?: string;
  replyText?: string;
  replyMessageId?: string;
  replyRetryable?: boolean;
  error?: string;
  /** Durable input for an accepted-but-not-started turn; no transport secrets. */
  inboundMessage?: IncomingMessage;
}

const JOURNAL_PATH = getDataPath(path.join('messaging', 'message_journal.json'));
const MAX_ENTRIES = 5_000;
let entries: MessagingJournalEntry[] | null = null;

function journalKey(message: Pick<IncomingMessage, 'platform' | 'messageId'>): string {
  return `${message.platform}:${String(message.messageId || '').trim()}`;
}

function readEntries(): MessagingJournalEntry[] {
  if (entries) return entries;
  try {
    const parsed = JSON.parse(fs.readFileSync(JOURNAL_PATH, 'utf8'));
    entries = Array.isArray(parsed)
      ? parsed.filter(item => typeof item?.key === 'string' && typeof item?.messageId === 'string')
      : [];
  } catch {
    entries = [];
  }
  return entries;
}

function writeEntries(next: MessagingJournalEntry[]): void {
  const bounded = next.slice(-MAX_ENTRIES);
  fs.mkdirSync(path.dirname(JOURNAL_PATH), { recursive: true });
  const temporaryPath = `${JOURNAL_PATH}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporaryPath, JSON.stringify(bounded, null, 2), 'utf8');
  fs.renameSync(temporaryPath, JOURNAL_PATH);
  entries = bounded;
}

export function recordMessagingIngress(message: IncomingMessage): void {
  const current = readEntries();
  const key = journalKey(message);
  if (current.some(item => item.key === key)) return;
  const receivedAt = message.receivedAt || new Date().toISOString();
  writeEntries([...current, {
    key,
    platform: message.platform,
    messageId: String(message.messageId || ''),
    platformUserId: String(message.userId || ''),
    boundUserId: String(message.boundUserId || ''),
    bindingAuthorization: message.bindingAuthorization,
    organizationAuthorization: message.organizationAuthorization,
    chatId: String(message.chatId || ''),
    chatType: message.chatType,
    threadId: String(message.threadId || ''),
    text: String(message.text || '').slice(0, 8_000),
    attachmentNames: (message.attachments || []).map(item => String(item.fileName || '')).filter(Boolean),
    externalTimestamp: String(message.timestamp || ''),
    receivedAt,
    updatedAt: receivedAt,
    status: 'received',
    inboundMessage: { ...message, raw: {} },
    routeSequence: message.routeSequence,
    domain: message.boundOrgId ? 'work' : 'personal',
    orgId: String(message.boundOrgId || ''),
  }]);
}

export function updateMessagingJournal(
  message: Pick<IncomingMessage, 'platform' | 'messageId'>,
  update: Partial<Pick<MessagingJournalEntry, 'status' | 'replyText' | 'replyMessageId' | 'replyRetryable' | 'error' | 'routeSequence' | 'boundUserId' | 'bindingAuthorization' | 'organizationAuthorization' | 'domain' | 'orgId'>>,
): void {
  const current = readEntries();
  const entry = current.find(item => item.key === journalKey(message));
  if (!entry) return;
  writeEntries(current.map(item => item === entry ? { ...item, ...update, updatedAt: new Date().toISOString() } : item));
}

export function listQueuedMessagingInputs(platform: IncomingMessage['platform']): IncomingMessage[] {
  // Processing turns may already have effects; they are not safe to rerun.
  return readEntries().filter(entry => entry.platform === platform && entry.status === 'received' && entry.inboundMessage)
    .map(entry => JSON.parse(JSON.stringify(entry.inboundMessage)) as IncomingMessage);
}

export function listMessagingJournal(limit = 100): MessagingJournalEntry[] {
  return readEntries().slice(-Math.max(1, limit)).map(entry => ({ ...entry }));
}

export function getMessagingJournalEntry(
  message: Pick<IncomingMessage, 'platform' | 'messageId'>,
): MessagingJournalEntry | null {
  const entry = readEntries().find(item => item.key === journalKey(message));
  return entry
    ? { ...entry, attachmentNames: Array.isArray(entry.attachmentNames) ? [...entry.attachmentNames] : [] }
    : null;
}

export function resetMessagingJournalForTest(): void {
  entries = [];
  try { fs.rmSync(JOURNAL_PATH, { force: true }); } catch {}
}
