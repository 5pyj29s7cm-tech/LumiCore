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
  entries = next.slice(-MAX_ENTRIES);
  fs.mkdirSync(path.dirname(JOURNAL_PATH), { recursive: true });
  const temporaryPath = `${JOURNAL_PATH}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporaryPath, JSON.stringify(entries, null, 2), 'utf8');
  fs.renameSync(temporaryPath, JOURNAL_PATH);
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
    chatId: String(message.chatId || ''),
    chatType: message.chatType,
    threadId: String(message.threadId || ''),
    text: String(message.text || '').slice(0, 8_000),
    attachmentNames: (message.attachments || []).map(item => String(item.fileName || '')).filter(Boolean),
    externalTimestamp: String(message.timestamp || ''),
    receivedAt,
    updatedAt: receivedAt,
    status: 'received',
    routeSequence: message.routeSequence,
    domain: message.boundOrgId ? 'work' : 'personal',
    orgId: String(message.boundOrgId || ''),
  }]);
}

export function updateMessagingJournal(
  message: Pick<IncomingMessage, 'platform' | 'messageId'>,
  update: Partial<Pick<MessagingJournalEntry, 'status' | 'replyText' | 'replyMessageId' | 'replyRetryable' | 'error' | 'routeSequence' | 'boundUserId' | 'domain' | 'orgId'>>,
): void {
  const current = readEntries();
  const entry = current.find(item => item.key === journalKey(message));
  if (!entry) return;
  Object.assign(entry, update, { updatedAt: new Date().toISOString() });
  writeEntries(current);
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
