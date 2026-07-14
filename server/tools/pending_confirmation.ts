import crypto from 'crypto';

export interface PendingToolConfirmation {
  id: string;
  userId: string;
  toolName: string;
  argsHash: string;
  safeArgs: Record<string, any>;
  source: string;
  domain: string;
  orgId: string;
  channelId: string;
  createdAt: string;
  expiresAt: number;
}

export interface PendingConfirmationScope {
  source?: string;
  domain?: string;
  orgId?: string;
  channelId?: string;
}

const pendingById = new Map<string, PendingToolConfirmation>();
const CONFIRMATION_TTL_MS = 10 * 60 * 1000;
const SECRET_KEY_RE = /password|passkey|secret|token|api.?key|credential|otp|captcha|verification.?code/i;

function stableValue(value: any): any {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.keys(value).sort().map(key => [key, stableValue(value[key])]),
  );
}

function argsHash(args: Record<string, any>): string {
  return crypto.createHash('sha256').update(JSON.stringify(stableValue(args || {}))).digest('hex');
}

function sanitizeValue(value: any, depth = 0): any {
  if (depth > 4) return '[nested data omitted]';
  if (Array.isArray(value)) return value.slice(0, 20).map(item => sanitizeValue(item, depth + 1));
  if (!value || typeof value !== 'object') {
    return typeof value === 'string' && value.length > 500 ? `${value.slice(0, 500)}...` : value;
  }
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [
    key,
    SECRET_KEY_RE.test(key) ? '[redacted]' : sanitizeValue(item, depth + 1),
  ]));
}

function matchesScope(pending: PendingToolConfirmation, scope?: PendingConfirmationScope): boolean {
  if (!scope) return true;
  if (scope.source !== undefined && pending.source !== scope.source) return false;
  if (scope.domain !== undefined && pending.domain !== scope.domain) return false;
  if (scope.orgId !== undefined && pending.orgId !== scope.orgId) return false;
  if (scope.channelId !== undefined && pending.channelId !== scope.channelId) return false;
  return true;
}

function readFresh(userId: string, scope?: PendingConfirmationScope): PendingToolConfirmation | null {
  const fresh: PendingToolConfirmation[] = [];
  for (const [id, pending] of pendingById.entries()) {
    if (pending.expiresAt <= Date.now()) {
      pendingById.delete(id);
      continue;
    }
    if (pending.userId === userId && matchesScope(pending, scope)) fresh.push(pending);
  }
  return fresh.sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0] || null;
}

export function recordPendingConfirmation(
  userId: string,
  toolName: string,
  args: Record<string, any>,
  source = 'chat',
  scope: Omit<PendingConfirmationScope, 'source'> = {},
): PendingToolConfirmation {
  const pending: PendingToolConfirmation = {
    id: crypto.randomUUID(),
    userId,
    toolName,
    argsHash: argsHash(args),
    safeArgs: sanitizeValue(args || {}),
    source,
    domain: scope.domain || '',
    orgId: scope.orgId || '',
    channelId: scope.channelId || '',
    createdAt: new Date().toISOString(),
    expiresAt: Date.now() + CONFIRMATION_TTL_MS,
  };
  for (const [id, existing] of pendingById.entries()) {
    if (
      existing.userId === userId &&
      existing.source === pending.source &&
      existing.domain === pending.domain &&
      existing.orgId === pending.orgId &&
      existing.channelId === pending.channelId
    ) {
      pendingById.delete(id);
    }
  }
  pendingById.set(pending.id, pending);
  return pending;
}

export function getPendingConfirmation(
  userId: string,
  scope?: PendingConfirmationScope,
): PendingToolConfirmation | null {
  return readFresh(userId, scope);
}

export function consumePendingConfirmation(
  userId: string,
  pendingId: string,
  toolName: string,
  args: Record<string, any>,
  scope?: PendingConfirmationScope,
): boolean {
  const pending = pendingById.get(pendingId);
  if (!pending || pending.expiresAt <= Date.now()) {
    if (pending) pendingById.delete(pendingId);
    return false;
  }
  if (pending.userId !== userId || !matchesScope(pending, scope)) return false;
  if (pending.toolName !== toolName || pending.argsHash !== argsHash(args)) return false;
  pendingById.delete(pending.id);
  return true;
}

export function clearPendingConfirmation(userId: string, scope?: PendingConfirmationScope): boolean {
  let cleared = false;
  for (const [id, pending] of pendingById.entries()) {
    if (pending.userId === userId && matchesScope(pending, scope)) {
      pendingById.delete(id);
      cleared = true;
    }
  }
  return cleared;
}

export function isExplicitConfirmationReply(text: string): boolean {
  return /^(?:确认|确认执行|继续执行|同意|授权继续|可以执行|yes|confirm|proceed|approve)[。.!！?？\s]*$/i.test(String(text || '').trim());
}

export function isConfirmationCancellation(text: string): boolean {
  return /^(?:取消|不要执行|停止执行|不同意|拒绝|cancel|deny|reject|stop)[。.!！?？\s]*$/i.test(String(text || '').trim());
}

export function formatPendingConfirmationPrompt(pending: PendingToolConfirmation): string {
  return [
    '## Exact Pending Action Confirmation',
    'The user explicitly confirmed the single pending action below in this turn.',
    'You may call only the exact same tool with exactly the same arguments. The grant is one-time and cannot authorize any other action.',
    'Execute the exact pending tool now, then report only its real result.',
    `Pending id: ${pending.id}`,
    `Tool: ${pending.toolName}`,
    `Arguments (secrets redacted): ${JSON.stringify(pending.safeArgs)}`,
  ].join('\n');
}

export function clearAllPendingConfirmationsForTests(): void {
  pendingById.clear();
}
