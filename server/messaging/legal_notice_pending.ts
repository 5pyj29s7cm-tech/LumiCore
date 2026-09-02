import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import { getDataPath } from '../config/data_path';
import type { IncomingAttachment, IncomingMessage } from './types';

export interface PendingLegalNoticeCandidate {
  orgId: string;
  orgName: string;
  caseId?: string;
  caseTitle?: string;
  caseNumber?: string;
}

export interface PendingLegalNotice {
  id: string;
  userId: string;
  platform: IncomingMessage['platform'];
  platformUserId: string;
  chatId: string;
  messageText: string;
  attachments: IncomingAttachment[];
  inspectionReport: string;
  candidates: PendingLegalNoticeCandidate[];
  createdAt: string;
  expiresAt: string;
}

interface PendingLegalNoticeStore {
  items: PendingLegalNotice[];
}

const STORE_PATH = getDataPath(path.join('messaging', 'pending_legal_notices.json'));
const PENDING_TTL_MS = 24 * 60 * 60 * 1000;

function readStore(): PendingLegalNoticeStore {
  try {
    if (!fs.existsSync(STORE_PATH)) return { items: [] };
    const parsed = JSON.parse(fs.readFileSync(STORE_PATH, 'utf8'));
    return { items: Array.isArray(parsed?.items) ? parsed.items : [] };
  } catch {
    return { items: [] };
  }
}

function writeStore(store: PendingLegalNoticeStore): void {
  fs.mkdirSync(path.dirname(STORE_PATH), { recursive: true });
  const temporaryPath = `${STORE_PATH}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporaryPath, JSON.stringify(store, null, 2), 'utf8');
  fs.renameSync(temporaryPath, STORE_PATH);
}

function routeMatches(item: PendingLegalNotice, message: IncomingMessage, userId: string): boolean {
  return item.userId === userId
    && item.platform === message.platform
    && item.platformUserId === message.userId
    && item.chatId === message.chatId;
}

function prune(store: PendingLegalNoticeStore): void {
  const now = Date.now();
  store.items = store.items.filter(item => Date.parse(item.expiresAt) > now);
}

export function savePendingLegalNotice(input: {
  userId: string;
  message: IncomingMessage;
  messageText: string;
  inspectionReport?: string;
  candidates: PendingLegalNoticeCandidate[];
}): PendingLegalNotice {
  const store = readStore();
  prune(store);
  store.items = store.items.filter(item => !routeMatches(item, input.message, input.userId));
  const createdAt = new Date().toISOString();
  const item: PendingLegalNotice = {
    id: randomUUID(),
    userId: input.userId,
    platform: input.message.platform,
    platformUserId: input.message.userId,
    chatId: input.message.chatId,
    messageText: input.messageText,
    attachments: (input.message.attachments || []).map(attachment => ({ ...attachment })),
    inspectionReport: String(input.inspectionReport || ''),
    candidates: input.candidates.map(candidate => ({ ...candidate })),
    createdAt,
    expiresAt: new Date(Date.now() + PENDING_TTL_MS).toISOString(),
  };
  store.items.push(item);
  writeStore(store);
  return item;
}

export function getPendingLegalNotice(message: IncomingMessage, userId: string): PendingLegalNotice | null {
  const store = readStore();
  const before = store.items.length;
  prune(store);
  if (store.items.length !== before) writeStore(store);
  return store.items
    .filter(item => routeMatches(item, message, userId))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0] || null;
}

export function consumePendingLegalNotice(id: string): PendingLegalNotice | null {
  const store = readStore();
  prune(store);
  const index = store.items.findIndex(item => item.id === id);
  if (index < 0) {
    writeStore(store);
    return null;
  }
  const [item] = store.items.splice(index, 1);
  writeStore(store);
  return item;
}

export function clearPendingLegalNotice(message: IncomingMessage, userId: string): boolean {
  const store = readStore();
  prune(store);
  const before = store.items.length;
  store.items = store.items.filter(item => !routeMatches(item, message, userId));
  if (store.items.length !== before) writeStore(store);
  return store.items.length !== before;
}

export function resetPendingLegalNoticesForTest(): void {
  try { fs.rmSync(STORE_PATH, { force: true }); } catch {}
}
