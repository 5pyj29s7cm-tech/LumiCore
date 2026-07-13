import fs from 'fs';
import path from 'path';
import { randomBytes, randomUUID } from 'crypto';
import { getDataPath } from '../config/data_path';
import { getMember, getOrgById } from '../org/db';
import { parseCnMessagingBindingCommand } from '../regions/packs/cn/messaging';

export type MessagingPlatformId = 'feishu' | 'wechat' | 'wecom';
export type MessagingBindingDomain = 'personal' | 'work';

export interface MessagingBinding {
  id: string;
  platform: MessagingPlatformId;
  platformUserId: string;
  chatId?: string;
  chatType?: 'private' | 'group';
  lumiUserId: string;
  orgId: string;
  domain: MessagingBindingDomain;
  createdAt: string;
  updatedAt: string;
}

export interface BindingCode {
  code: string;
  platform: MessagingPlatformId;
  lumiUserId: string;
  orgId: string;
  domain: MessagingBindingDomain;
  expiresAt: string;
  createdAt: string;
}

export type MessagingBindingCommand =
  | { kind: 'bind'; code: string }
  | { kind: 'status' }
  | { kind: 'invalid' };

interface StoreShape {
  bindings: MessagingBinding[];
  codes: BindingCode[];
}

const STORE_PATH = getDataPath(path.join('messaging', 'bindings.json'));

function now() {
  return new Date().toISOString();
}

function readStore(): StoreShape {
  try {
    if (!fs.existsSync(STORE_PATH)) return { bindings: [], codes: [] };
    const parsed = JSON.parse(fs.readFileSync(STORE_PATH, 'utf8'));
    return {
      bindings: Array.isArray(parsed?.bindings) ? parsed.bindings.map((item: any) => ({
        ...item,
        orgId: String(item?.orgId || ''),
        domain: item?.domain === 'personal' || !item?.orgId ? 'personal' : 'work',
      })) : [],
      codes: Array.isArray(parsed?.codes) ? parsed.codes.map((item: any) => ({
        ...item,
        orgId: String(item?.orgId || ''),
        domain: item?.domain === 'personal' || !item?.orgId ? 'personal' : 'work',
      })) : [],
    };
  } catch {
    return { bindings: [], codes: [] };
  }
}

function writeStore(store: StoreShape) {
  fs.mkdirSync(path.dirname(STORE_PATH), { recursive: true });
  const tempPath = `${STORE_PATH}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(store, null, 2), 'utf8');
  fs.renameSync(tempPath, STORE_PATH);
}

function makeCode() {
  // Hex keeps future codes copy-safe across chat clients while retaining 48 bits
  // of entropy for a short-lived one-time code.
  return randomBytes(6).toString('hex').toUpperCase();
}

export function parseMessagingBindingCommand(text: string): MessagingBindingCommand | null {
  const normalized = String(text || '').trim();
  if (!normalized) return null;

  const codeMatch = normalized.match(/^bind\s*(?:Lumi)?\s*([A-Z0-9_-]{4,16})\s*[.!]?$/i);
  if (codeMatch) return { kind: 'bind', code: codeMatch[1].toUpperCase() };

  if (/^(?:(?:i(?:'m| am)?|am i)\s+)?(?:already\s+)?bound(?:\s+(?:successfully|now|yet))?\s*[?.!]*$/i.test(normalized)
    || /^binding\s+(?:succeeded|successful|complete|completed|status)\s*[?.!]*$/i.test(normalized)) {
    return { kind: 'status' };
  }

  if (/^bind\s+lumi(?:\s|$)/i.test(normalized)) {
    return { kind: 'invalid' };
  }
  return parseCnMessagingBindingCommand(normalized);
}

function pruneExpiredCodes(store: StoreShape) {
  const ts = now();
  store.codes = store.codes.filter(item => item.expiresAt > ts);
}

export function createBindingCode(
  platform: MessagingPlatformId,
  lumiUserId: string,
  orgId = '',
  domain: MessagingBindingDomain = 'work',
): BindingCode {
  if (domain === 'work') {
    if (!orgId) {
      throw new Error('Choose an organization before creating a messaging binding');
    }
    const membership = getMember(orgId, lumiUserId);
    if (!membership || membership.status !== 'active') {
      throw new Error('User is not an active member of this organization');
    }
    if (!getOrgById(orgId)) {
      throw new Error('No organization available for binding');
    }
  } else if (orgId) {
    throw new Error('Personal messaging bindings cannot target an organization');
  }
  const store = readStore();
  pruneExpiredCodes(store);
  let code = makeCode();
  while (store.codes.some(item => item.code === code)) code = makeCode();
  const bindingCode: BindingCode = {
    code,
    platform,
    lumiUserId,
    orgId,
    domain,
    createdAt: now(),
    expiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
  };
  store.codes.push(bindingCode);
  writeStore(store);
  return bindingCode;
}

export function consumeBindingCode(
  platform: MessagingPlatformId,
  code: string,
  platformUserId: string,
  chatId = '',
  chatType: 'private' | 'group' = 'private',
): MessagingBinding | null {
  const store = readStore();
  pruneExpiredCodes(store);
  const normalized = code.trim().toUpperCase();
  const idx = store.codes.findIndex(item => item.platform === platform && item.code === normalized);
  if (idx < 0) {
    writeStore(store);
    return null;
  }
  const found = store.codes.splice(idx, 1)[0];
  const ts = now();
  let existingIdx = store.bindings.findIndex(item =>
    item.platform === platform
    && item.platformUserId === platformUserId
    && String(item.chatId || '') === String(chatId || '')
  );
  if (existingIdx < 0 && chatId && chatType === 'private') {
    existingIdx = store.bindings.findIndex(item =>
      item.platform === platform
      && item.platformUserId === platformUserId
      && !item.chatId
    );
  }
  const binding: MessagingBinding = {
    id: existingIdx >= 0 ? store.bindings[existingIdx].id : randomUUID(),
    platform,
    platformUserId,
    chatId: chatId || undefined,
    chatType,
    lumiUserId: found.lumiUserId,
    orgId: found.orgId,
    domain: found.domain,
    createdAt: existingIdx >= 0 ? store.bindings[existingIdx].createdAt : ts,
    updatedAt: ts,
  };
  if (existingIdx >= 0) store.bindings[existingIdx] = binding;
  else store.bindings.push(binding);
  writeStore(store);
  return binding;
}

export function getBinding(
  platform: MessagingPlatformId,
  platformUserId: string,
  chatId = '',
  chatType: 'private' | 'group' = 'private',
): MessagingBinding | null {
  const store = readStore();
  if (chatType === 'group') {
    if (!chatId) return null;
    return store.bindings
      .filter(item =>
        item.platform === platform
        && item.platformUserId === platformUserId
        && item.chatType === 'group'
        && item.chatId === chatId
      )
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0] || null;
  }
  const candidates = store.bindings
    .filter(item => item.platform === platform && item.platformUserId === platformUserId)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  if (chatId) {
    const exact = candidates.find(item => item.chatId === chatId);
    if (exact) return exact;
    return candidates.find(item => !item.chatId && item.chatType !== 'group') || null;
  }
  return candidates.find(item => item.chatType === 'private')
    || candidates.find(item => !item.chatId)
    || null;
}

export function resetMessagingBindingsForTest(): void {
  try { fs.rmSync(STORE_PATH, { force: true }); } catch {}
}

export function listBindingsForUser(lumiUserId: string): MessagingBinding[] {
  return readStore().bindings.filter(item => item.lumiUserId === lumiUserId);
}

export function listActiveBindingCodesForUser(
  lumiUserId: string,
  platform?: MessagingPlatformId,
  domain?: MessagingBindingDomain,
): BindingCode[] {
  const store = readStore();
  const before = store.codes.length;
  pruneExpiredCodes(store);
  if (store.codes.length !== before) writeStore(store);
  return store.codes
    .filter(item => item.lumiUserId === lumiUserId)
    .filter(item => !platform || item.platform === platform)
    .filter(item => !domain || item.domain === domain)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function deleteBindingForUser(
  lumiUserId: string,
  bindingId: string,
  orgId?: string,
  domain?: MessagingBindingDomain,
): boolean {
  const store = readStore();
  const idx = store.bindings.findIndex(item =>
    item.id === bindingId &&
    item.lumiUserId === lumiUserId &&
    (orgId === undefined || item.orgId === orgId) &&
    (domain === undefined || item.domain === domain)
  );
  if (idx < 0) return false;
  store.bindings.splice(idx, 1);
  writeStore(store);
  return true;
}
