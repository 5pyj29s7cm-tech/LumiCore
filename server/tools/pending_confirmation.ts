import crypto from 'crypto';

export interface PendingToolConfirmation {
  id: string;
  userId: string;
  toolName: string;
  argsHash: string;
  safeArgs: Record<string, any>;
  source: string;
  createdAt: string;
  expiresAt: number;
}

const pendingByUser = new Map<string, PendingToolConfirmation>();
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

function readFresh(userId: string): PendingToolConfirmation | null {
  const pending = pendingByUser.get(userId);
  if (!pending) return null;
  if (pending.expiresAt <= Date.now()) {
    pendingByUser.delete(userId);
    return null;
  }
  return pending;
}

export function recordPendingConfirmation(
  userId: string,
  toolName: string,
  args: Record<string, any>,
  source = 'chat',
): PendingToolConfirmation {
  const pending: PendingToolConfirmation = {
    id: crypto.randomUUID(),
    userId,
    toolName,
    argsHash: argsHash(args),
    safeArgs: sanitizeValue(args || {}),
    source,
    createdAt: new Date().toISOString(),
    expiresAt: Date.now() + CONFIRMATION_TTL_MS,
  };
  pendingByUser.set(userId, pending);
  return pending;
}

export function getPendingConfirmation(userId: string): PendingToolConfirmation | null {
  return readFresh(userId);
}

export function consumePendingConfirmation(
  userId: string,
  pendingId: string,
  toolName: string,
  args: Record<string, any>,
): boolean {
  const pending = readFresh(userId);
  if (!pending || pending.id !== pendingId) return false;
  if (pending.toolName !== toolName || pending.argsHash !== argsHash(args)) return false;
  pendingByUser.delete(userId);
  return true;
}

export function clearPendingConfirmation(userId: string): boolean {
  return pendingByUser.delete(userId);
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
    `Pending id: ${pending.id}`,
    `Tool: ${pending.toolName}`,
    `Arguments (secrets redacted): ${JSON.stringify(pending.safeArgs)}`,
  ].join('\n');
}

export function clearAllPendingConfirmationsForTests(): void {
  pendingByUser.clear();
}
