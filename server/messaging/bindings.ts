import fs from 'fs';
import path from 'path';
import { randomBytes, randomUUID } from 'crypto';
import { getDataPath } from '../config/data_path';
import { getMember, getOrgById, logAudit } from '../org/db';
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

export interface MessagingGroupAuthorization {
  id: string;
  platform: Exclude<MessagingPlatformId, 'wechat'>;
  chatId: string;
  orgId: string;
  createdBy: string;
  allowedPlatformUserIds: string[];
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export type MessagingBindingCommand =
  | { kind: 'bind'; code: string }
  | { kind: 'status' }
  | { kind: 'invalid' };

export interface BindingCodeConsumptionPlan {
  code: BindingCode;
  platform: MessagingPlatformId;
  platformUserId: string;
  chatId: string;
  chatType: 'private' | 'group';
}

export interface BindingCodeConsumptionCommit {
  plan: BindingCodeConsumptionPlan;
  binding: MessagingBinding;
  previousBinding: MessagingBinding | null;
}

interface StoreShape {
  bindings: MessagingBinding[];
  codes: BindingCode[];
  groupAuthorizations: MessagingGroupAuthorization[];
}

const STORE_PATH = getDataPath(path.join('messaging', 'bindings.json'));

function now() {
  return new Date().toISOString();
}

function readStore(): StoreShape {
  try {
    if (!fs.existsSync(STORE_PATH)) return { bindings: [], codes: [], groupAuthorizations: [] };
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
      groupAuthorizations: Array.isArray(parsed?.groupAuthorizations)
        ? parsed.groupAuthorizations.filter((item: any) =>
          item?.platform === 'feishu' || item?.platform === 'wecom'
        ).map((item: any) => ({
          id: String(item.id || randomUUID()),
          platform: item.platform,
          chatId: String(item.chatId || ''),
          orgId: String(item.orgId || ''),
          createdBy: String(item.createdBy || ''),
          allowedPlatformUserIds: Array.isArray(item.allowedPlatformUserIds)
            ? Array.from(new Set(item.allowedPlatformUserIds.map(String).filter(Boolean)))
            : [],
          enabled: item.enabled !== false,
          createdAt: String(item.createdAt || now()),
          updatedAt: String(item.updatedAt || item.createdAt || now()),
        }))
        : [],
    };
  } catch {
    return { bindings: [], codes: [], groupAuthorizations: [] };
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
  const plan = planBindingCodeConsumption(platform, code, platformUserId, chatId, chatType);
  return plan ? commitBindingCodeConsumption(plan)?.binding || null : null;
}

export function planBindingCodeConsumption(
  platform: MessagingPlatformId,
  code: string,
  platformUserId: string,
  chatId = '',
  chatType: 'private' | 'group' = 'private',
): BindingCodeConsumptionPlan | null {
  // Planning is deliberately read-only. The one-time credential is consumed
  // only after the remote user transcript passes its strict durability fence.
  if (chatType === 'group') return null;
  const store = readStore();
  const normalized = code.trim().toUpperCase();
  const found = store.codes.find(item =>
    item.platform === platform
    && item.code === normalized
    && item.expiresAt > now()
  );
  if (!found) return null;
  return {
    code: { ...found },
    platform,
    platformUserId,
    chatId,
    chatType,
  };
}

function bindingIndexForPlan(store: StoreShape, plan: BindingCodeConsumptionPlan): number {
  let index = store.bindings.findIndex(item =>
    item.platform === plan.platform
    && item.platformUserId === plan.platformUserId
    && String(item.chatId || '') === String(plan.chatId || '')
  );
  if (index < 0 && plan.chatId && plan.chatType === 'private') {
    index = store.bindings.findIndex(item =>
      item.platform === plan.platform
      && item.platformUserId === plan.platformUserId
      && !item.chatId
    );
  }
  return index;
}

export function commitBindingCodeConsumption(
  plan: BindingCodeConsumptionPlan,
): BindingCodeConsumptionCommit | null {
  const store = readStore();
  pruneExpiredCodes(store);
  const codeIndex = store.codes.findIndex(item =>
    item.platform === plan.platform
    && item.code === plan.code.code
    && item.createdAt === plan.code.createdAt
    && item.lumiUserId === plan.code.lumiUserId
    && item.orgId === plan.code.orgId
    && item.domain === plan.code.domain
  );
  if (codeIndex < 0) return null;
  const found = store.codes.splice(codeIndex, 1)[0];
  const ts = now();
  const existingIdx = bindingIndexForPlan(store, plan);
  const previousBinding = existingIdx >= 0 ? { ...store.bindings[existingIdx] } : null;
  const binding: MessagingBinding = {
    id: existingIdx >= 0 ? store.bindings[existingIdx].id : randomUUID(),
    platform: plan.platform,
    platformUserId: plan.platformUserId,
    chatId: plan.chatId || undefined,
    chatType: plan.chatType,
    lumiUserId: found.lumiUserId,
    orgId: found.orgId,
    domain: found.domain,
    createdAt: existingIdx >= 0 ? store.bindings[existingIdx].createdAt : ts,
    updatedAt: ts,
  };
  if (existingIdx >= 0) store.bindings[existingIdx] = binding;
  else store.bindings.push(binding);
  writeStore(store);
  return { plan, binding, previousBinding };
}

export function rollbackBindingCodeConsumption(commit: BindingCodeConsumptionCommit): boolean {
  const store = readStore();
  const bindingIndex = store.bindings.findIndex(item =>
    item.id === commit.binding.id
    && item.platform === commit.binding.platform
    && item.platformUserId === commit.binding.platformUserId
    && String(item.chatId || '') === String(commit.binding.chatId || '')
    && item.lumiUserId === commit.binding.lumiUserId
    && item.orgId === commit.binding.orgId
    && item.domain === commit.binding.domain
    && item.updatedAt === commit.binding.updatedAt
  );
  // A newer binding owns this identity now. Never roll it back underneath a
  // later successful transaction.
  if (bindingIndex < 0) return false;
  if (commit.previousBinding) store.bindings[bindingIndex] = commit.previousBinding;
  else store.bindings.splice(bindingIndex, 1);
  if (
    commit.plan.code.expiresAt > now()
    && !store.codes.some(item => item.platform === commit.plan.platform && item.code === commit.plan.code.code)
  ) {
    store.codes.push({ ...commit.plan.code });
  }
  writeStore(store);
  return true;
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
    const authorization = store.groupAuthorizations.find(item =>
      item.platform === platform
      && item.chatId === chatId
      && item.enabled
      && (item.allowedPlatformUserIds.length === 0 || item.allowedPlatformUserIds.includes(platformUserId))
    );
    if (!authorization) return null;
    const identity = store.bindings
      .filter(item =>
        item.platform === platform
        && item.platformUserId === platformUserId
        && item.chatType !== 'group'
      )
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
    if (!identity) return null;
    const membership = getMember(authorization.orgId, identity.lumiUserId);
    if (!membership || membership.status !== 'active') return null;
    return {
      ...identity,
      chatId,
      chatType: 'group',
      orgId: authorization.orgId,
      domain: 'work',
    };
  }
  const candidates = store.bindings
    .filter(item =>
      item.platform === platform
      && item.platformUserId === platformUserId
      && item.chatType !== 'group'
    )
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

export function authorizeMessagingGroup(input: {
  platform: Exclude<MessagingPlatformId, 'wechat'>;
  chatId: string;
  orgId: string;
  createdBy: string;
  allowedPlatformUserIds?: string[];
}): MessagingGroupAuthorization {
  const chatId = String(input.chatId || '').trim();
  const orgId = String(input.orgId || '').trim();
  if (!chatId || !orgId) throw new Error('chatId and orgId are required');
  if (!/^[A-Za-z0-9._:@/-]{6,240}$/.test(chatId)) {
    throw new Error('The group chat identity is invalid for this platform');
  }
  const membership = getMember(orgId, input.createdBy);
  if (!membership || membership.status !== 'active' || !['owner', 'admin'].includes(membership.role)) {
    throw new Error('Only an active organization owner or administrator can authorize a group');
  }
  const store = readStore();
  const timestamp = now();
  const allowedPlatformUserIds = Array.from(new Set(
    (input.allowedPlatformUserIds || []).map(value => String(value || '').trim()).filter(Boolean),
  )).slice(0, 500);
  const index = store.groupAuthorizations.findIndex(item =>
    item.platform === input.platform && item.chatId === chatId
  );
  if (index >= 0 && store.groupAuthorizations[index].orgId !== orgId) {
    throw new Error('This group is already authorized to another organization and must be explicitly revoked there first');
  }
  const authorization: MessagingGroupAuthorization = {
    id: index >= 0 ? store.groupAuthorizations[index].id : randomUUID(),
    platform: input.platform,
    chatId,
    orgId,
    createdBy: input.createdBy,
    allowedPlatformUserIds,
    enabled: true,
    createdAt: index >= 0 ? store.groupAuthorizations[index].createdAt : timestamp,
    updatedAt: timestamp,
  };
  if (index >= 0) store.groupAuthorizations[index] = authorization;
  else store.groupAuthorizations.push(authorization);
  writeStore(store);
  logAudit({
    orgId,
    userId: input.createdBy,
    action: index >= 0 ? 'messaging.group.authorization.updated' : 'messaging.group.authorization.created',
    resourceType: 'messaging_group_authorization',
    resourceId: authorization.id,
    details: {
      platform: input.platform,
      chatId,
      allowedMemberCount: allowedPlatformUserIds.length,
    },
  });
  return authorization;
}

export function listMessagingGroupAuthorizations(
  platform: Exclude<MessagingPlatformId, 'wechat'>,
  orgId: string,
): MessagingGroupAuthorization[] {
  return readStore().groupAuthorizations
    .filter(item => item.platform === platform && item.orgId === orgId)
    .map(item => ({ ...item, allowedPlatformUserIds: [...item.allowedPlatformUserIds] }));
}

export function revokeMessagingGroupAuthorization(input: {
  platform: Exclude<MessagingPlatformId, 'wechat'>;
  authorizationId: string;
  orgId: string;
  revokedBy: string;
}): boolean {
  const membership = getMember(input.orgId, input.revokedBy);
  if (!membership || membership.status !== 'active' || !['owner', 'admin'].includes(membership.role)) {
    throw new Error('Only an active organization owner or administrator can revoke a group');
  }
  const store = readStore();
  const index = store.groupAuthorizations.findIndex(item =>
    item.id === input.authorizationId
    && item.platform === input.platform
    && item.orgId === input.orgId
  );
  if (index < 0) return false;
  const removed = store.groupAuthorizations[index];
  store.groupAuthorizations.splice(index, 1);
  writeStore(store);
  logAudit({
    orgId: input.orgId,
    userId: input.revokedBy,
    action: 'messaging.group.authorization.revoked',
    resourceType: 'messaging_group_authorization',
    resourceId: removed.id,
    details: { platform: input.platform, chatId: removed.chatId },
  });
  return true;
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
