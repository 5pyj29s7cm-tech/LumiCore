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
  /** Request that proposed the exact action; later turns cannot adopt it. */
  originRequestId: string;
  createdAt: string;
  expiresAt: number;
}

export interface PendingConfirmationScope {
  source?: string;
  domain?: string;
  orgId?: string;
  channelId?: string;
  taskId?: string;
  originRequestId?: string;
  actionIntent?: string;
}

export const PENDING_CONFIRMATION_PERSISTENCE_VERSION = 1 as const;

export type PendingConfirmationPersistenceStatus =
  | 'pending'
  | 'consumed'
  | 'cancelled'
  | 'expired';

/**
 * Storage-safe confirmation envelope. Exact arguments are deliberately absent
 * and must be encrypted by the persistence adapter before this record is
 * written. `revision` and `status` are the future atomic-CAS boundary.
 */
export interface PendingConfirmationPersistenceRecord {
  schemaVersion: typeof PENDING_CONFIRMATION_PERSISTENCE_VERSION;
  revision: number;
  status: PendingConfirmationPersistenceStatus;
  id: string;
  userId: string;
  toolName: string;
  argsHash: string;
  target: string;
  payloadDigest: string;
  exactArgsCiphertext: string;
  safeArgs: Record<string, any>;
  actionIntent: string;
  source: string;
  domain: string;
  orgId: string;
  channelId: string;
  taskId: string;
  originRequestId: string;
  createdAt: string;
  updatedAt: string;
  expiresAt: number;
}

export interface PendingConfirmationPersistenceAdapter {
  persist(pending: PendingToolConfirmation): Promise<number>;
  consume(input: { id: string; userId: string; revision: number }): Promise<boolean>;
  cancel(input: {
    id: string;
    userId: string;
    revision: number;
    expiresAt?: number;
  }): Promise<boolean>;
}

/** Stable across separate utterances on the same voice channel. */
export function buildVoiceConfirmationChannelScope(input: {
  domain?: string; orgId?: string; channelId?: string; taskId?: string; originRequestId?: string;
}): PendingConfirmationScope {
  const taskId = String(input.taskId || '').trim();
  const originRequestId = String(input.originRequestId || '').trim();
  return {
    source: 'voice', domain: String(input.domain || ''), orgId: String(input.orgId || ''),
    channelId: String(input.channelId || ''),
    ...(taskId ? { taskId } : {}),
    ...(originRequestId ? { originRequestId } : {}),
  };
}

/** Stable across Socket.IO reconnects for one persisted conversation. */
export function buildConversationConfirmationChannelScope(input: {
  source?: string; domain?: string; orgId?: string; conversationId: string; taskId?: string; originRequestId?: string;
}): PendingConfirmationScope {
  const taskId = String(input.taskId || '').trim();
  const originRequestId = String(input.originRequestId || '').trim();
  return {
    source: String(input.source || 'chat'),
    domain: String(input.domain || ''),
    orgId: String(input.orgId || ''),
    channelId: `conversation:${String(input.conversationId || '').trim()}`,
    ...(taskId ? { taskId } : {}),
    ...(originRequestId ? { originRequestId } : {}),
  };
}

/**
 * Conversation identity without a transport source. A voice proposal and a
 * typed confirmation can intentionally share this scope when both transports
 * supply the same persisted conversation and task ids.
 */
export function buildTransportNeutralConfirmationScope(input: {
  domain?: string; orgId?: string; conversationId: string; taskId?: string; originRequestId?: string;
}): PendingConfirmationScope {
  const conversationId = String(input.conversationId || '').trim();
  if (!conversationId) throw new Error('Transport-neutral confirmation scope requires a conversation id');
  const taskId = String(input.taskId || '').trim();
  const originRequestId = String(input.originRequestId || '').trim();
  return {
    domain: String(input.domain || ''),
    orgId: String(input.orgId || ''),
    channelId: `conversation:${conversationId}`,
    ...(taskId ? { taskId } : {}),
    ...(originRequestId ? { originRequestId } : {}),
  };
}

const pendingById = new Map<string, PendingToolConfirmation>();
const persistedRevisionById = new Map<string, number>();
const revocationQuarantineIds = new Set<string>();
const revokedChannelKeys = new Set<string>();
let persistenceAdapter: PendingConfirmationPersistenceAdapter | null = null;
const CONFIRMATION_TTL_MS = 10 * 60 * 1000;
const SECRET_KEY_RE = /password|passkey|secret|token|api.?key|credential|otp|captcha|verification.?code/i;

export type PendingConfirmationChannelScope = Required<Pick<
  PendingConfirmationScope,
  'domain' | 'orgId' | 'channelId'
>>;

function confirmationChannelKey(
  userId: string,
  scope: Pick<PendingConfirmationScope, 'domain' | 'orgId' | 'channelId'>,
): string {
  return [
    String(userId || '').trim(),
    String(scope.domain || ''),
    String(scope.orgId || ''),
    String(scope.channelId || '').trim(),
  ].join('\0');
}

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
    || args.path
    || args.channelId
    || args.chatId
    || args.url
    || args.proposalId
    || '',
  ).trim().slice(0, 300);
}

function confirmationPayloadDigest(args: Record<string, any>): string {
  // Bind every exact argument, including long tails and identity pins. A
  // selective payload projection allowed two materially different patches to
  // share the same user-visible digest.
  return crypto.createHash('sha256').update(JSON.stringify(stableValue(args || {}))).digest('hex');
}

/** Compare exact tool arguments without depending on object key order. */
export function confirmationArgumentsMatch(
  left: Record<string, any>,
  right: Record<string, any>,
): boolean {
  return argsHash(left || {}) === argsHash(right || {});
}

/**
 * Prove that a pending record is the exact proposal created by this immutable
 * task request, rather than an older same-task confirmation returned by the
 * one-boundary deduplication rule.
 */
export function pendingConfirmationMatchesExactProposal(
  pending: PendingToolConfirmation | null | undefined,
  toolName: string,
  args: Record<string, any>,
  scope: Pick<PendingConfirmationScope, 'taskId' | 'originRequestId'>,
): boolean {
  return Boolean(
    pending
    && pending.expiresAt > Date.now()
    && pending.toolName === String(toolName || '').trim()
    && pending.taskId === String(scope.taskId || '').trim()
    && pending.originRequestId === String(scope.originRequestId || '').trim()
    && pending.argsHash === argsHash(args || {})
    && confirmationArgumentsMatch(pending.exactArgs, args || {})
    && pending.target === confirmationTarget(args || {})
    && pending.payloadDigest === confirmationPayloadDigest(args || {}),
  );
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

function confirmationSafeArgs(toolName: string, args: Record<string, any>): Record<string, any> {
  if (toolName === 'self_improvement_stage_patch') {
    const patch = String(args.patch || '');
    const paths = Array.from(new Set(patch.split(/\r?\n/)
      .filter(line => line.startsWith('+++ b/'))
      .map(line => line.slice(6).trim())
      .filter(Boolean)));
    return {
      proposalId: String(args.proposalId || ''),
      expectedBaseCommit: String(args.expectedBaseCommit || ''),
      expectedDeliveryBranch: String(args.expectedDeliveryBranch || ''),
      commitMessage: String(args.commitMessage || ''),
      patchReview: {
        sha256: crypto.createHash('sha256').update(patch, 'utf8').digest('hex'),
        bytes: Buffer.byteLength(patch, 'utf8'),
        lines: patch.split(/\r?\n/).length,
        changedPaths: paths,
        fullPatch: patch,
      },
    };
  }
  if (toolName !== 'desktop_write_text_file') return sanitizeValue(args || {});
  const content = String(args.content ?? '');
  return {
    path: String(args.path || ''),
    encoding: String(args.encoding || 'utf-8'),
    overwritePolicy: String(args.overwritePolicy || 'fail_if_exists'),
    contentSummary: {
      characters: content.length,
      sha256: crypto.createHash('sha256').update(content, 'utf8').digest('hex'),
      preview: content.slice(0, 120),
      truncated: content.length > 120,
    },
  };
}

function confirmationModelSafeArgs(pending: PendingToolConfirmation): Record<string, any> {
  if (pending.toolName !== 'self_improvement_stage_patch') return pending.safeArgs;
  const review = pending.safeArgs.patchReview || {};
  return {
    ...pending.safeArgs,
    patchReview: {
      ...review,
      fullPatch: `[omitted from model continuation; user reviewed exact SHA-256 ${review.sha256 || pending.payloadDigest}]`,
    },
  };
}

export function buildPendingConfirmationPersistenceRecord(
  pending: PendingToolConfirmation,
  exactArgsCiphertext: string,
  updatedAt = new Date().toISOString(),
): PendingConfirmationPersistenceRecord {
  const ciphertext = String(exactArgsCiphertext || '').trim();
  if (!ciphertext) {
    throw new Error('Pending confirmation persistence requires encrypted exact arguments');
  }
  return {
    schemaVersion: PENDING_CONFIRMATION_PERSISTENCE_VERSION,
    revision: 1,
    status: 'pending',
    id: pending.id,
    userId: pending.userId,
    toolName: pending.toolName,
    argsHash: pending.argsHash,
    target: pending.target,
    payloadDigest: pending.payloadDigest,
    exactArgsCiphertext: ciphertext,
    safeArgs: stableValue(pending.safeArgs),
    actionIntent: pending.actionIntent,
    source: pending.source,
    domain: pending.domain,
    orgId: pending.orgId,
    channelId: pending.channelId,
    taskId: pending.taskId,
    originRequestId: pending.originRequestId,
    createdAt: pending.createdAt,
    updatedAt,
    expiresAt: pending.expiresAt,
  };
}

/**
 * Rebuild an in-memory confirmation only after an external persistence adapter
 * decrypts the exact arguments. Hash and payload checks fail closed if either
 * the database envelope or ciphertext result was changed.
 */
export function hydratePendingConfirmationFromPersistence(
  record: PendingConfirmationPersistenceRecord,
  decryptedExactArgs: Record<string, any>,
  now = Date.now(),
): PendingToolConfirmation | null {
  if (!record || record.schemaVersion !== PENDING_CONFIRMATION_PERSISTENCE_VERSION) return null;
  if (record.status !== 'pending' || record.revision < 1 || record.expiresAt <= now) return null;
  if (!record.id || !record.userId || !record.toolName || !record.exactArgsCiphertext) return null;
  if (argsHash(decryptedExactArgs) !== record.argsHash) return null;
  if (confirmationPayloadDigest(decryptedExactArgs) !== record.payloadDigest) return null;
  if (confirmationTarget(decryptedExactArgs) !== record.target) return null;
  if (
    JSON.stringify(stableValue(confirmationSafeArgs(record.toolName, decryptedExactArgs)))
    !== JSON.stringify(stableValue(record.safeArgs || {}))
  ) return null;
  return {
    id: record.id,
    userId: record.userId,
    toolName: record.toolName,
    argsHash: record.argsHash,
    target: record.target,
    payloadDigest: record.payloadDigest,
    exactArgs: stableValue(decryptedExactArgs || {}),
    safeArgs: stableValue(record.safeArgs || {}),
    actionIntent: record.actionIntent,
    source: record.source,
    domain: record.domain,
    orgId: record.orgId,
    channelId: record.channelId,
    taskId: record.taskId,
    originRequestId: record.originRequestId,
    createdAt: record.createdAt,
    expiresAt: record.expiresAt,
  };
}

function matchesScope(pending: PendingToolConfirmation, scope?: PendingConfirmationScope): boolean {
  if (!scope) return true;
  // Once an action is task-bound, a later generic turn in the same channel is
  // not allowed to adopt it merely because it says "confirm". The live
  // conversation/task pointer must present the exact task id again.
  if (pending.taskId && scope.taskId === undefined) return false;
  if (scope.source !== undefined && pending.source !== scope.source) return false;
  if (scope.domain !== undefined && pending.domain !== scope.domain) return false;
  if (scope.orgId !== undefined && pending.orgId !== scope.orgId) return false;
  if (scope.channelId !== undefined && pending.channelId !== scope.channelId) return false;
  if (scope.taskId !== undefined && pending.taskId !== scope.taskId) return false;
  if (
    scope.originRequestId !== undefined
    && pending.originRequestId !== scope.originRequestId
  ) return false;
  return true;
}

function readFresh(userId: string, scope?: PendingConfirmationScope): PendingToolConfirmation | null {
  const fresh: PendingToolConfirmation[] = [];
  for (const [id, pending] of pendingById.entries()) {
    if (pending.expiresAt <= Date.now()) {
      pendingById.delete(id);
      persistedRevisionById.delete(id);
      revocationQuarantineIds.delete(id);
      continue;
    }
    if (revocationQuarantineIds.has(id)) continue;
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
  if (scope.channelId && revokedChannelKeys.has(confirmationChannelKey(userId, {
    domain: scope.domain,
    orgId: scope.orgId,
    channelId: scope.channelId,
  }))) {
    throw new Error('Pending confirmation channel has been revoked');
  }
  const taskId = String(scope.taskId || '').trim();
  if (taskId) {
    const existing = readFresh(userId, {
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
    safeArgs: confirmationSafeArgs(toolName, args || {}),
    actionIntent: String(scope.actionIntent || '').trim(),
    source,
    domain: scope.domain || '',
    orgId: scope.orgId || '',
    channelId: scope.channelId || '',
    taskId,
    originRequestId: String(scope.originRequestId || '').trim(),
    createdAt: new Date().toISOString(),
    expiresAt: Date.now() + CONFIRMATION_TTL_MS,
  };
  for (const [id, existing] of pendingById.entries()) {
    if (
      existing.userId === userId &&
      existing.domain === pending.domain &&
      existing.orgId === pending.orgId &&
      existing.channelId === pending.channelId
    ) {
      pendingById.delete(id);
      persistedRevisionById.delete(id);
    }
  }
  pendingById.set(pending.id, pending);
  return pending;
}

/** Configure the encrypted durable adapter after it has hydrated active rows. */
export function configurePendingConfirmationPersistence(
  adapter: PendingConfirmationPersistenceAdapter | null,
): void {
  persistenceAdapter = adapter;
}

/** Restore one already decrypted and envelope-verified record at startup. */
export function restorePendingConfirmationForRuntime(
  pending: PendingToolConfirmation,
  revision: number,
): boolean {
  if (!pending?.id || !pending.userId || pending.expiresAt <= Date.now() || revision < 1) return false;
  const currentRevision = persistedRevisionById.get(pending.id) || 0;
  if (pendingById.has(pending.id) && currentRevision >= revision) return false;
  pendingById.set(pending.id, pending);
  persistedRevisionById.set(pending.id, revision);
  return true;
}

export async function recordPendingConfirmationDurably(
  userId: string,
  toolName: string,
  args: Record<string, any>,
  source = 'chat',
  scope: Omit<PendingConfirmationScope, 'source'> = {},
): Promise<PendingToolConfirmation> {
  const pending = recordPendingConfirmation(userId, toolName, args, source, scope);
  if (!persistenceAdapter || persistedRevisionById.has(pending.id)) return pending;
  try {
    const revision = await persistenceAdapter.persist(pending);
    if (!Number.isSafeInteger(revision) || revision < 1) {
      throw new Error('Pending confirmation persistence returned an invalid revision');
    }
    if (pending.channelId && revokedChannelKeys.has(confirmationChannelKey(userId, pending))) {
      await persistenceAdapter.cancel({
        id: pending.id,
        userId,
        revision,
        expiresAt: pending.expiresAt,
      });
      pendingById.delete(pending.id);
      throw new Error('Pending confirmation channel was revoked during persistence');
    }
    persistedRevisionById.set(pending.id, revision);
    return pending;
  } catch (error) {
    pendingById.delete(pending.id);
    persistedRevisionById.delete(pending.id);
    throw error;
  }
}

function validatesPendingConsumption(
  userId: string,
  pendingId: string,
  toolName: string,
  args: Record<string, any>,
  scope?: PendingConfirmationScope,
): PendingToolConfirmation | null {
  if (revocationQuarantineIds.has(pendingId)) return null;
  const pending = pendingById.get(pendingId);
  if (!pending || pending.expiresAt <= Date.now()) return null;
  if (pending.userId !== userId || !matchesScope(pending, scope)) return null;
  if (pending.toolName !== toolName || pending.argsHash !== argsHash(args)) return null;
  return pending;
}

export async function consumePendingConfirmationDurably(
  userId: string,
  pendingId: string,
  toolName: string,
  args: Record<string, any>,
  scope?: PendingConfirmationScope,
): Promise<boolean> {
  const pending = validatesPendingConsumption(userId, pendingId, toolName, args, scope);
  if (!pending) {
    if (revocationQuarantineIds.has(pendingId)) return false;
    pendingById.delete(pendingId);
    persistedRevisionById.delete(pendingId);
    return false;
  }
  const revision = persistedRevisionById.get(pendingId);
  if (persistenceAdapter && revision) {
    const claimed = await persistenceAdapter.consume({ id: pendingId, userId, revision });
    // A competing process may have consumed/cancelled this row. Either way,
    // the local grant disappears and cannot be retried.
    if (!claimed) {
      pendingById.delete(pendingId);
      persistedRevisionById.delete(pendingId);
      return false;
    }
  }
  pendingById.delete(pending.id);
  persistedRevisionById.delete(pending.id);
  return true;
}

async function clearPendingCandidatesDurably(
  userId: string,
  candidates: PendingToolConfirmation[],
): Promise<number> {
  let cleared = 0;
  for (const pending of candidates) {
    const revision = persistedRevisionById.get(pending.id);
    if (persistenceAdapter && revision) {
      try {
        await persistenceAdapter.cancel({
          id: pending.id,
          userId,
          revision,
          expiresAt: pending.expiresAt,
        });
      } catch (error) {
        // Deny this grant immediately, but retain its identity so cancellation
        // can be retried. The production repository writes a durable revocation
        // barrier before attempting the SQLite CAS, preventing restart revival.
        revocationQuarantineIds.add(pending.id);
        throw error;
      }
      pendingById.delete(pending.id);
      persistedRevisionById.delete(pending.id);
      revocationQuarantineIds.delete(pending.id);
    } else {
      pendingById.delete(pending.id);
      persistedRevisionById.delete(pending.id);
    }
    cleared += 1;
  }
  return cleared;
}

export async function clearPendingConfirmationDurably(
  userId: string,
  scope?: PendingConfirmationScope,
): Promise<boolean> {
  const candidates = [...pendingById.values()].filter(pending => (
    pending.userId === userId && matchesScope(pending, scope)
  ));
  return (await clearPendingCandidatesDurably(userId, candidates)) > 0;
}

/**
 * Permanently revoke one exact conversation channel for this process and
 * cancel every active grant in it, including task-bound grants. The tombstone
 * closes the deletion race with an already-admitted turn that tries to persist
 * a new confirmation after its conversation has been deleted.
 */
export async function revokePendingConfirmationChannelDurably(
  userId: string,
  scope: PendingConfirmationChannelScope,
): Promise<number> {
  const channelId = String(scope.channelId || '').trim();
  if (!channelId) throw new Error('Pending confirmation channel revocation requires channelId');
  const normalizedScope: PendingConfirmationChannelScope = {
    domain: String(scope.domain || ''),
    orgId: String(scope.orgId || ''),
    channelId,
  };
  revokedChannelKeys.add(confirmationChannelKey(userId, normalizedScope));
  const candidates = [...pendingById.values()].filter(pending => (
    pending.userId === userId
    && pending.domain === normalizedScope.domain
    && pending.orgId === normalizedScope.orgId
    && pending.channelId === normalizedScope.channelId
  ));
  return clearPendingCandidatesDurably(userId, candidates);
}

export function getPendingConfirmation(
  userId: string,
  scope?: PendingConfirmationScope,
): PendingToolConfirmation | null {
  return readFresh(userId, scope);
}

/** Async production API paired with startup hydration and durable CAS writes. */
export async function getPendingConfirmationDurably(
  userId: string,
  scope?: PendingConfirmationScope,
): Promise<PendingToolConfirmation | null> {
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
  if (revocationQuarantineIds.has(pendingId)) return false;
  if (!pending || pending.expiresAt <= Date.now()) {
    if (pending) pendingById.delete(pendingId);
    persistedRevisionById.delete(pendingId);
    return false;
  }
  if (pending.userId !== userId || !matchesScope(pending, scope)) return false;
  if (pending.toolName !== toolName || pending.argsHash !== argsHash(args)) return false;
  pendingById.delete(pending.id);
  persistedRevisionById.delete(pending.id);
  return true;
}

export function clearPendingConfirmation(userId: string, scope?: PendingConfirmationScope): boolean {
  let cleared = false;
  for (const [id, pending] of pendingById.entries()) {
    if (pending.userId === userId && matchesScope(pending, scope)) {
      pendingById.delete(id);
      persistedRevisionById.delete(id);
      revocationQuarantineIds.delete(id);
      cleared = true;
    }
  }
  return cleared;
}

export function isExplicitConfirmationReply(text: string): boolean {
  return /^(?:\u786e\u8ba4(?:\u4e86|\u6267\u884c)?|\u7ee7\u7eed\u6267\u884c|\u540c\u610f|\u6388\u6743\u7ee7\u7eed|\u53ef\u4ee5\u6267\u884c|\u53ef\u4ee5|\u597d|\u597d\u7684|\u5f00\u59cb|yes|confirm|proceed|approve|go)[\u3002\uff01\uff1f.!?\s]*$/iu.test(String(text || '').trim());
}

export function isConfirmationCancellation(text: string): boolean {
  const normalized = String(text || '').trim();
  if (/^(?:\u4e0d\u8981\u6267\u884c|\u505c\u6b62\u6267\u884c|\u4e0d\u540c\u610f|\u62d2\u7edd|cancel|deny|reject|stop|terminate)[\u3002\uff01\uff1f.!?\s]*$/iu.test(normalized)) {
    return true;
  }
  if (/^(?:\u53d6\u6d88|\u505c\u6b62|\u7ec8\u6b62)[\u3002\uff01\uff1f.!?\s]*$/u.test(normalized)) return true;
  // English users commonly name the exact pending scope without a trailing
  // safety clause. Keep domain commands such as "terminate order ..." out of
  // this lane by requiring an explicit task/operation/work noun.
  if (/^(?:please\s+)?(?:cancel|stop|abort|terminate)\s+(?:this|that|the\s+current)\s+(?:task|operation|work)[.!?\s]*$/iu.test(normalized)) return true;
  // A cancellation may explicitly restate the safety outcome (for example,
  // "Cancel this task. Do not write any file"). Keep it on the deterministic
  // cancellation lane instead of sending the second sentence to the model.
  if (/^(?:please\s+)?(?:cancel|stop|abort|terminate)(?:\s+(?:this|that|the\s+current)\s+(?:task|operation|work))?[.!?\s]+(?:do\s+not|don['\u2019]?t|never)\s+(?:write|create|send|publish|execute|run|continue)\b[^\r\n]{0,180}[.!?\s]*$/iu.test(normalized)) {
    return true;
  }
  if (/^(?:\u53d6\u6d88|\u505c\u6b62|\u7ec8\u6b62)(?:\u8fd9\u4e2a|\u90a3\u4e2a|\u5f53\u524d)?(?:\u4efb\u52a1|\u64cd\u4f5c|\u5de5\u4f5c)?[\uff0c,\u3002.\s]+(?:\u4e0d\u8981|\u522b|\u65e0\u9700|\u4e0d\u5fc5)(?:\u518d|\u7ee7\u7eed)?(?:\u5199\u5165|\u521b\u5efa|\u53d1\u9001|\u53d1\u5e03|\u6267\u884c|\u7ee7\u7eed)[^\r\n]{0,180}$/u.test(normalized)) {
    return true;
  }
  if (!/^(?:\u53d6\u6d88|\u505c\u6b62|\u7ec8\u6b62)/u.test(normalized)) return false;
  // Natural cancellations often name the pending recipient/action and then
  // ask Lumi to confirm that nothing was sent. Accept that full sentence as
  // long as it explicitly refers to a confirmation/action boundary. Do not
  // classify unrelated domain commands such as "取消订单" as confirmation
  // cancellation.
  return /(?:\u521a\u624d|\u521a\u521a|\u4e4b\u524d|\u4e0a\u4e00\u4e2a|\u5916\u53d1|\u53d1\u9001|\u63d0\u4ea4|\u53d1\u5e03|\u786e\u8ba4|\u64cd\u4f5c|\u4efb\u52a1)/u.test(normalized.slice(0, 180));
}

export function formatPendingConfirmationPrompt(pending: PendingToolConfirmation): string {
  return [
    '## Exact Pending Action Confirmation',
    'The user explicitly confirmed the single pending action below in this turn.',
    'You may call only the exact same tool with exactly the same arguments. The grant is one-time and cannot authorize any other action.',
    'Execute the exact pending tool now, then report only its real result.',
    `Pending id: ${pending.id}`,
    `Task id: ${pending.taskId || '(conversation turn)'}`,
    `Origin request id: ${pending.originRequestId || '(not recorded)'}`,
    `Tool: ${pending.toolName}`,
    `Target: ${pending.target || '(current verified target)'}`,
    `Payload digest: ${pending.payloadDigest}`,
    `Arguments (secrets redacted): ${JSON.stringify(confirmationModelSafeArgs(pending))}`,
  ].join('\n');
}

/** User-facing request shown before an external or otherwise sensitive action starts. */
export function formatPendingConfirmationRequest(pending: PendingToolConfirmation): string {
  return formatPendingConfirmationRequestMessage(pending);
}

export function clearAllPendingConfirmationsForTests(): void {
  pendingById.clear();
  persistedRevisionById.clear();
  revocationQuarantineIds.clear();
  revokedChannelKeys.clear();
  persistenceAdapter = null;
}
