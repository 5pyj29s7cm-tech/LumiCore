import fs from 'fs';
import path from 'path';
import { getDataPath } from '../config/data_path';
import { getMember, listUserOrgs, type Organization } from '../org/db';
import type { IncomingAttachment, IncomingMessage } from './types';

const STORE_PATH = getDataPath(path.join('messaging', 'personal_org_scopes.json'));
const SCOPE_TTL_MS = 24 * 60 * 60 * 1000;

interface PendingOrganizationSelection {
  orgIds: string[];
  text: string;
  attachments?: IncomingAttachment[];
  createdAt: string;
}

interface PersonalOrganizationScopeRecord {
  key: string;
  userId: string;
  platform: string;
  platformUserId: string;
  chatId: string;
  activeOrgId?: string;
  pending?: PendingOrganizationSelection;
  updatedAt: string;
}

interface ScopeStore {
  records: PersonalOrganizationScopeRecord[];
}

export type PersonalOrganizationScopeResolution =
  | { kind: 'personal'; message: IncomingMessage }
  | { kind: 'organization'; message: IncomingMessage; org: Organization; entered: boolean }
  | { kind: 'reply'; message: IncomingMessage; reply: string };

function requestText(text: string): string {
  const marker = '\n\n以下是用户通过';
  return text.includes(marker) ? text.slice(0, text.indexOf(marker)).trim() : text.trim();
}

export function requestsOrganizationScope(text: string): boolean {
  const request = requestText(text);
  return /(组织|工作域|知识库|资料库|文档库|案件|案号|归档|保存|材料|卷宗|律所)/.test(request)
    || /(提取|调取|获取|查看|整理|总结|摘要|列出).*(案件|案号|卷宗|组织资料|组织文档|组织知识)/.test(request);
}

function now(): string {
  return new Date().toISOString();
}

function readStore(): ScopeStore {
  try {
    const parsed = JSON.parse(fs.readFileSync(STORE_PATH, 'utf8'));
    return { records: Array.isArray(parsed?.records) ? parsed.records : [] };
  } catch {
    return { records: [] };
  }
}

function writeStore(store: ScopeStore): void {
  fs.mkdirSync(path.dirname(STORE_PATH), { recursive: true });
  const temp = `${STORE_PATH}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(store, null, 2), 'utf8');
  fs.renameSync(temp, STORE_PATH);
}

function scopeKey(message: IncomingMessage): string {
  return [
    message.boundUserId || '',
    message.platform,
    message.userId,
    message.chatType,
    message.chatId,
    message.threadId || 'main',
  ].join(':');
}

function activeOrganizations(userId: string): Organization[] {
  return listUserOrgs(userId).filter(org => getMember(org.id, userId)?.status === 'active');
}

function normalize(value: string): string {
  return String(value || '').toLowerCase().replace(/[\s「」《》"“”'‘’]/g, '');
}

function matchingOrganizations(text: string, organizations: Organization[]): Organization[] {
  const input = normalize(text);
  return organizations.filter(org => {
    const names = [org.name, org.slug, org.id]
      .map(normalize)
      .filter(value => value.length >= 2);
    return names.some(value => input.includes(value));
  });
}

function selectOrganization(text: string, organizations: Organization[]): Organization | null {
  const indexMatch = text.match(/^(?:进入|选择|切换到|切到|第)?\s*(\d+)\s*(?:个|项|号)?\s*(?:组织)?[。.!！]?$/);
  if (indexMatch) return organizations[Number(indexMatch[1]) - 1] || null;
  const matches = matchingOrganizations(text, organizations);
  return matches.length === 1 ? matches[0] : null;
}

function organizationPrompt(organizations: Organization[]): string {
  return [
    '个人 Lumi 可以进入你有权限的组织，但当前有多个可用组织。请选择一个，原任务会在选定后继续：',
    ...organizations.map((org, index) => `${index + 1}. ${org.name}`),
  ].join('\n');
}

function isExitRequest(text: string): boolean {
  return /^(?:退出|离开|返回|切回|回到)\s*(?:当前)?\s*(?:组织|工作域|工作台|个人|个人域)/.test(text.trim());
}

function isPureEnterRequest(text: string): boolean {
  return /^(?:进入|切换到|切到|转到)\s*[^，。；;\n]{0,80}(?:组织|工作域|工作台)?[。.!！]?$/.test(text.trim());
}

function scopedMessage(
  message: IncomingMessage,
  org: Organization,
  pending?: PendingOrganizationSelection,
): IncomingMessage {
  return {
    ...message,
    boundOrgId: org.id,
    text: pending?.text || message.text,
    attachments: pending?.attachments || message.attachments,
  };
}

export function resolvePersonalOrganizationScope(
  message: IncomingMessage,
  requiresOrganization: boolean,
): PersonalOrganizationScopeResolution {
  if (!message.boundUserId || message.boundOrgId) return { kind: 'personal', message };

  const request = requestText(message.text);
  const key = scopeKey(message);
  const store = readStore();
  let recordIndex = store.records.findIndex(item => item.key === key);
  let record = recordIndex >= 0 ? store.records[recordIndex] : null;
  if (record && Date.now() - new Date(record.updatedAt).getTime() > SCOPE_TTL_MS) {
    store.records.splice(recordIndex, 1);
    writeStore(store);
    record = null;
    recordIndex = -1;
  }

  if (isExitRequest(request)) {
    if (record) {
      store.records = store.records.filter(item => item.key !== key);
      writeStore(store);
    }
    return { kind: 'reply', message, reply: '已退出组织工作域，后续对话回到个人 Lumi。' };
  }

  const organizations = activeOrganizations(message.boundUserId);
  if (record?.pending) {
    const pendingOrganizations = record.pending.orgIds
      .map(orgId => organizations.find(org => org.id === orgId))
      .filter((org): org is Organization => Boolean(org));
    const selected = selectOrganization(request, pendingOrganizations);
    if (selected) {
      const pending = record.pending;
      record = { ...record, activeOrgId: selected.id, pending: undefined, updatedAt: now() };
      store.records[recordIndex] = record;
      writeStore(store);
      return { kind: 'organization', message: scopedMessage(message, selected, pending), org: selected, entered: true };
    }
    if (/^(?:进入|选择|切换|第|\d)/.test(request)) {
      return { kind: 'reply', message, reply: organizationPrompt(pendingOrganizations) };
    }
  }

  const explicitScopeRequest = requiresOrganization || /^(?:进入|切换到|切到|转到|使用)/.test(request);
  const explicitMatches = explicitScopeRequest ? matchingOrganizations(request, organizations) : [];
  if (explicitMatches.length === 1) {
    const selected = explicitMatches[0];
    const next: PersonalOrganizationScopeRecord = {
      key,
      userId: message.boundUserId,
      platform: message.platform,
      platformUserId: message.userId,
      chatId: message.chatId,
      activeOrgId: selected.id,
      updatedAt: now(),
    };
    if (recordIndex >= 0) store.records[recordIndex] = next;
    else store.records.push(next);
    writeStore(store);
    if (isPureEnterRequest(request)) {
      return {
        kind: 'reply',
        message: scopedMessage(message, selected),
        reply: `已进入“${selected.name}”组织工作域。后续消息按你的组织权限处理；说“切回个人”即可退出。`,
      };
    }
    return { kind: 'organization', message: scopedMessage(message, selected), org: selected, entered: true };
  }

  const activeOrg = record?.activeOrgId
    ? organizations.find(org => org.id === record?.activeOrgId)
    : undefined;
  if (activeOrg) {
    record!.updatedAt = now();
    store.records[recordIndex] = record!;
    writeStore(store);
    return { kind: 'organization', message: scopedMessage(message, activeOrg), org: activeOrg, entered: false };
  }

  if (!requiresOrganization) return { kind: 'personal', message };
  if (organizations.length === 0) {
    return { kind: 'reply', message, reply: '当前个人 Lumi 身份没有可访问的组织。请先创建组织或由组织管理员添加成员权限。' };
  }
  if (organizations.length === 1) {
    const selected = organizations[0];
    const next: PersonalOrganizationScopeRecord = {
      key,
      userId: message.boundUserId,
      platform: message.platform,
      platformUserId: message.userId,
      chatId: message.chatId,
      activeOrgId: selected.id,
      updatedAt: now(),
    };
    if (recordIndex >= 0) store.records[recordIndex] = next;
    else store.records.push(next);
    writeStore(store);
    return { kind: 'organization', message: scopedMessage(message, selected), org: selected, entered: true };
  }

  const next: PersonalOrganizationScopeRecord = {
    key,
    userId: message.boundUserId,
    platform: message.platform,
    platformUserId: message.userId,
    chatId: message.chatId,
    pending: {
      orgIds: organizations.map(org => org.id),
      text: message.text,
      attachments: message.attachments,
      createdAt: now(),
    },
    updatedAt: now(),
  };
  if (recordIndex >= 0) store.records[recordIndex] = next;
  else store.records.push(next);
  writeStore(store);
  return { kind: 'reply', message, reply: organizationPrompt(organizations) };
}

export function resetPersonalOrganizationScopesForTest(): void {
  try { fs.rmSync(STORE_PATH, { force: true }); } catch {}
}
