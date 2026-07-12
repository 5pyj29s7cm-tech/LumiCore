import fs from 'fs';
import path from 'path';
import { randomBytes, randomUUID } from 'crypto';
import { getDataPath } from '../config/data_path';
import { getMember, getOrgById } from '../org/db';

export type MessagingPlatformId = 'feishu' | 'wechat' | 'wecom';

export interface MessagingBinding {
  id: string;
  platform: MessagingPlatformId;
  platformUserId: string;
  chatId?: string;
  chatType?: 'private' | 'group';
  lumiUserId: string;
  orgId: string;
  createdAt: string;
  updatedAt: string;
}

interface BindingCode {
  code: string;
  platform: MessagingPlatformId;
  lumiUserId: string;
  orgId: string;
  expiresAt: string;
  createdAt: string;
}

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
      bindings: Array.isArray(parsed?.bindings) ? parsed.bindings : [],
      codes: Array.isArray(parsed?.codes) ? parsed.codes : [],
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
  return randomBytes(6).toString('base64url').slice(0, 8).toUpperCase();
}

function pruneExpiredCodes(store: StoreShape) {
  const ts = now();
  store.codes = store.codes.filter(item => item.expiresAt > ts);
}

export function createBindingCode(platform: MessagingPlatformId, lumiUserId: string, orgId = ''): BindingCode {
  if (!orgId) {
    throw new Error('Choose an organization before creating a messaging binding');
  }
  const membership = getMember(orgId, lumiUserId);
  if (!membership || membership.status !== 'active') {
    throw new Error('User is not an active member of this organization');
  }
  if (!orgId || !getOrgById(orgId)) {
    throw new Error('No organization available for binding');
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
  let existingIdx = chatType === 'group' && chatId
    ? store.bindings.findIndex(item =>
        item.platform === platform
        && item.chatType === 'group'
        && String(item.chatId || '') === String(chatId)
      )
    : store.bindings.findIndex(item =>
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
      .filter(item => item.platform === platform && item.chatType === 'group' && item.chatId === chatId)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0] || null;
  }
  const candidates = store.bindings
    .filter(item => item.platform === platform && item.platformUserId === platformUserId)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  if (chatId) {
    const exact = candidates.find(item => item.chatId === chatId);
    if (exact) return exact;
  }
  return candidates.find(item => item.chatType === 'private')
    || candidates.find(item => !item.chatId)
    || (candidates.length === 1 ? candidates[0] : null);
}

export function resetMessagingBindingsForTest(): void {
  try { fs.rmSync(STORE_PATH, { force: true }); } catch {}
}

export function listBindingsForUser(lumiUserId: string): MessagingBinding[] {
  return readStore().bindings.filter(item => item.lumiUserId === lumiUserId);
}

export function deleteBindingForUser(lumiUserId: string, bindingId: string, orgId?: string): boolean {
  const store = readStore();
  const idx = store.bindings.findIndex(item =>
    item.id === bindingId &&
    item.lumiUserId === lumiUserId &&
    (orgId === undefined || item.orgId === orgId)
  );
  if (idx < 0) return false;
  store.bindings.splice(idx, 1);
  writeStore(store);
  return true;
}
