import crypto from 'crypto';
import { formatPendingConfirmationRequestMessage } from '../i18n/confirmation_messages';

export interface PendingToolConfirmation {
  id: string;
  userId: string;
  toolName: string;
  argsHash: string;
  /** Exact destination identity shown to and approved by the user. */
  target: string;
  /** Hash of the external payload; changes invalidate the grant. */
  payloadDigest: string;
  /** Exact in-memory arguments used only after the one-time grant is consumed. */
  exactArgs: Record<string, any>;
  safeArgs: Record<string, any>;
  actionIntent: string;
  source: string;
  domain: string;
  orgId: string;
  channelId: string;
  taskId: string;
  createdAt: string;
  expiresAt: number;
}

export interface PendingConfirmationScope {
  source?: string;
  domain?: string;
  orgId?: string;
  channelId?: string;
  taskId?: string;
  actionIntent?: string;
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

function confirmationTarget(args: Record<string, any>): string {
  return String(
    args.contact
    || args.recipient
    || args.target
    || args.channelId
    || args.chatId
    || args.url
    || '',
  ).trim().slice(0, 300);
}

function confirmationPayloadDigest(args: Record<string, any>): string {
  const payload = {
    message: args.message ?? args.text ?? args.content ?? args.draft ?? '',
    filePath: args.filePath ?? args.path ?? args.attachment ?? '',
    submission: args.payload ?? args.body ?? args.data ?? '',
  };
  return crypto.createHash('sha256').update(JSON.stringify(stableValue(payload))).digest('hex');
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
  if (scope.taskId !== undefined && pending.taskId !== scope.taskId) return false;
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
  const taskId = String(scope.taskId || '').trim();
  if (taskId) {
    const existing = readFresh(userId, {
      source,
      domain: scope.domain || '',
      orgId: scope.orgId || '',
      channelId: scope.channelId || '',
      taskId,
    });
    // One unfinished task owns one immutable confirmation boundary. Until it
    // is consumed or cleared, a retry/re-plan cannot replace its tool or args.
    if (existing) return existing;
  }
  const pending: PendingToolConfirmation = {
    id: crypto.randomUUID(),
    userId,
    toolName,
    argsHash: argsHash(args),
    target: confirmationTarget(args),
    payloadDigest: confirmationPayloadDigest(args),
    exactArgs: stableValue(args || {}),
    safeArgs: sanitizeValue(args || {}),
    actionIntent: String(scope.actionIntent || '').trim(),
    source,
    domain: scope.domain || '',
    orgId: scope.orgId || '',
    channelId: scope.channelId || '',
    taskId,
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
  return /^(?:\u786e\u8ba4|\u786e\u8ba4\u6267\u884c|\u7ee7\u7eed\u6267\u884c|\u540c\u610f|\u6388\u6743\u7ee7\u7eed|\u53ef\u4ee5\u6267\u884c|\u53ef\u4ee5|\u597d|\u597d\u7684|\u5f00\u59cb|yes|confirm|proceed|approve|go)[\u3002\uff01\uff1f.!?\s]*$/iu.test(String(text || '').trim());
}

export function isConfirmationCancellation(text: string): boolean {
  return /^(?:\u53d6\u6d88|\u4e0d\u8981\u6267\u884c|\u505c\u6b62\u6267\u884c|\u4e0d\u540c\u610f|\u62d2\u7edd|cancel|deny|reject|stop)[\u3002\uff01\uff1f.!?\s]*$/iu.test(String(text || '').trim());
}

export function formatPendingConfirmationPrompt(pending: PendingToolConfirmation): string {
  return [
    '## Exact Pending Action Confirmation',
    'The user explicitly confirmed the single pending action below in this turn.',
    'You may call only the exact same tool with exactly the same arguments. The grant is one-time and cannot authorize any other action.',
    'Execute the exact pending tool now, then report only its real result.',
    `Pending id: ${pending.id}`,
    `Task id: ${pending.taskId || '(conversation turn)'}`,
    `Tool: ${pending.toolName}`,
    `Target: ${pending.target || '(current verified target)'}`,
    `Payload digest: ${pending.payloadDigest}`,
    `Arguments (secrets redacted): ${JSON.stringify(pending.safeArgs)}`,
  ].join('\n');
}

/** User-facing request shown before an external or otherwise sensitive action starts. */
export function formatPendingConfirmationRequest(pending: PendingToolConfirmation): string {
  return formatPendingConfirmationRequestMessage(pending);
}

export function clearAllPendingConfirmationsForTests(): void {
  pendingById.clear();
}
