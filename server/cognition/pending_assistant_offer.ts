import crypto from 'node:crypto';

export const PENDING_ASSISTANT_OFFER_SCHEMA_VERSION = 1 as const;
export const DEFAULT_ASSISTANT_OFFER_TTL_MS = 2 * 60 * 1000;

export interface PendingAssistantOfferScope {
  userId?: string;
  domain?: string;
  orgId?: string;
  conversationId: string;
  taskId?: string;
  assistantTurnId: string;
}

export interface PendingRuntimeCleanupOffer {
  schemaVersion: typeof PENDING_ASSISTANT_OFFER_SCHEMA_VERSION;
  id: string;
  kind: 'runtime_work_cleanup';
  scope: PendingAssistantOfferScope;
  toolCall: {
    name: 'runtime_work_cancel';
    /**
     * Immutable runtime-work targets observed by the server when the adjacent
     * offer is adopted. An explicit empty array means "nothing matched"; it
     * must never be widened into the tool's legacy cancel-all form.
     */
    arguments: {
      taskIds: string[];
    };
  };
  proposalDigest: string;
  createdAt: string;
  expiresAt: number;
}

export interface PendingAssistantOfferContext {
  offer?: PendingRuntimeCleanupOffer | null;
  userId?: string;
  domain?: string;
  orgId?: string;
  conversationId?: string;
  taskId?: string;
  previousAssistantTurnId?: string;
  now?: number;
}

export interface AssistantOfferTranscriptMessage {
  id?: string;
  role?: string;
  message?: string;
  content?: string;
  timestamp?: string;
  requestId?: string;
  toolCalls?: unknown;
}

export interface AcceptedRuntimeCleanupOffer {
  intent: 'cancel';
  offerId: string;
  toolCall: PendingRuntimeCleanupOffer['toolCall'];
}

function compact(value: unknown): string {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function normalizeTargetTaskIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return Array.from(new Set(value
    .map(item => compact(item).slice(0, 180))
    .filter(Boolean)))
    .slice(0, 64);
}

function parsedToolCalls(value: unknown): any[] {
  let current = value;
  for (let depth = 0; depth < 2 && typeof current === 'string' && current.trim(); depth += 1) {
    try { current = JSON.parse(current); } catch { return []; }
  }
  return Array.isArray(current) ? current : [];
}

/**
 * Recover the frozen target set only from the adjacent assistant turn's
 * verified runtime status receipt. A prose-only offer has no mutation
 * authority because re-snapshotting at acceptance would capture newer work.
 */
export function runtimeCleanupTargetTaskIdsFromAssistantTurn(
  message: AssistantOfferTranscriptMessage | undefined,
): string[] {
  const records = parsedToolCalls(message?.toolCalls);
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const record = records[index];
    if (!record || typeof record !== 'object' || record.name !== 'runtime_work_status') continue;
    if (String(record.error || '').trim()) continue;
    const verified = record.terminalVerification?.status === 'verified'
      || record.envelope?.status === 'verified_success';
    if (!verified) continue;
    let result: any = record.result;
    if (typeof result === 'string') {
      try { result = JSON.parse(result); } catch { continue; }
    }
    if (!result || typeof result !== 'object' || result.ok !== true || !Array.isArray(result.items)) continue;
    return normalizeTargetTaskIds(result.items
      .filter((item: any) => item?.controls?.canCancel === true)
      .map((item: any) => item?.id));
  }
  return [];
}

// A cleanup offer must explicitly propose acting on Lumi's active/background
// work. Merely mentioning cleanup is not enough to create an executable offer.
const RUNTIME_CLEANUP_PROPOSAL_RE = /(?:(?:\u8981\u4e0d\u8981|\u662f\u5426|\u9700\u4e0d\u9700\u8981|\u9700\u8981|\u53ef\u4ee5|\u6211\u53ef\u4ee5|\u5e2e\u4f60).{0,24}(?:\u6e05\u7406|\u53d6\u6d88|\u505c\u6b62|\u7ed3\u675f).{0,24}(?:\u540e\u53f0|\u5f53\u524d|\u8fd9\u4e9b|\u5b83\u4eec|\u4efb\u52a1|\u5de5\u4f5c))|(?:(?:\u540e\u53f0|\u5f53\u524d|\u8fd9\u4e9b|\u5b83\u4eec|\u4efb\u52a1|\u5de5\u4f5c).{0,24}(?:\u6e05\u7406|\u53d6\u6d88|\u505c\u6b62|\u7ed3\u675f).{0,16}(?:\u5417|\u4e48|\u5462|\?|\uff1f))|\b(?:shall|should|would)\s+i\s+(?:clear|cancel|stop)\s+(?:the\s+)?(?:active|background|running)\s+(?:tasks?|work|jobs?)\b/iu;

const RUNTIME_CLEANUP_ACCEPTANCE_RE = /^(?:(?:\u5e2e\u6211)?(?:\u6e05\u7406|\u6e05\u6389|\u6e05\u4e86)(?:\u4e00\u4e0b|\u6389|\u8fd9\u4e9b|\u5b83\u4eec|\u5168\u90e8|\u6240\u6709)?|(?:\u628a)?(?:\u8fd9\u4e9b|\u5b83\u4eec|\u5168\u90e8|\u6240\u6709)(?:\u4efb\u52a1|\u5de5\u4f5c)?(?:\u90fd)?(?:\u53d6\u6d88|\u505c\u6389|\u7ed3\u675f)|(?:clear|cancel|stop)\s+(?:them|those|all)(?:\s+(?:tasks?|jobs?))?)[\u3002\uff01\uff1f.!?\s]*$/iu;

export function isRuntimeCleanupOfferAcceptanceText(text: string): boolean {
  return RUNTIME_CLEANUP_ACCEPTANCE_RE.test(compact(text));
}

export function isExplicitRuntimeCleanupProposal(text: string): boolean {
  return RUNTIME_CLEANUP_PROPOSAL_RE.test(compact(text));
}

export function createPendingRuntimeCleanupOffer(input: {
  assistantText: string;
  scope: PendingAssistantOfferScope;
  targetTaskIds?: string[];
  now?: number;
  ttlMs?: number;
}): PendingRuntimeCleanupOffer | null {
  const assistantText = compact(input.assistantText);
  const conversationId = compact(input.scope.conversationId);
  const assistantTurnId = compact(input.scope.assistantTurnId);
  if (!assistantText || !conversationId || !assistantTurnId) return null;
  if (!isExplicitRuntimeCleanupProposal(assistantText)) return null;

  const now = Number.isFinite(input.now) ? Number(input.now) : Date.now();
  const ttlMs = Math.max(1_000, Math.min(
    Number.isFinite(input.ttlMs) ? Number(input.ttlMs) : DEFAULT_ASSISTANT_OFFER_TTL_MS,
    10 * 60 * 1000,
  ));
  const proposalDigest = crypto.createHash('sha256').update(assistantText, 'utf8').digest('hex');
  const targetTaskIds = normalizeTargetTaskIds(input.targetTaskIds);
  if (targetTaskIds.length === 0) return null;
  const scope: PendingAssistantOfferScope = {
    ...(compact(input.scope.userId) ? { userId: compact(input.scope.userId) } : {}),
    ...(compact(input.scope.domain) ? { domain: compact(input.scope.domain) } : {}),
    ...(compact(input.scope.orgId) ? { orgId: compact(input.scope.orgId) } : {}),
    conversationId,
    ...(compact(input.scope.taskId) ? { taskId: compact(input.scope.taskId) } : {}),
    assistantTurnId,
  };
  const identity = JSON.stringify({ scope, proposalDigest, targetTaskIds, now });
  return {
    schemaVersion: PENDING_ASSISTANT_OFFER_SCHEMA_VERSION,
    id: `assistant_offer_${crypto.createHash('sha256').update(identity).digest('hex').slice(0, 24)}`,
    kind: 'runtime_work_cleanup',
    scope,
    toolCall: { name: 'runtime_work_cancel', arguments: { taskIds: targetTaskIds } },
    proposalDigest,
    createdAt: new Date(now).toISOString(),
    expiresAt: now + ttlMs,
  };
}

/**
 * Derive an executable offer only from the server-owned persisted transcript.
 * The final stored turn must itself be the assistant proposal; an intervening
 * user/tool turn, a missing durable turn id, or an invalid timestamp fails
 * closed. Callers must pass the active task identity when the conversation is
 * task-bound so an acceptance cannot jump between tasks in one conversation.
 */
export function buildPendingAssistantOfferContextFromTranscript(input: {
  messages: AssistantOfferTranscriptMessage[];
  userId?: string;
  domain?: string;
  orgId?: string;
  conversationId: string;
  taskId?: string;
  now?: number;
}): PendingAssistantOfferContext | undefined {
  const conversationId = compact(input.conversationId);
  if (!conversationId || !Array.isArray(input.messages) || input.messages.length === 0) return undefined;
  const previous = input.messages[input.messages.length - 1];
  if (compact(previous?.role).toLowerCase() !== 'assistant') return undefined;
  const assistantTurnId = compact(previous?.id);
  const assistantText = compact(previous?.message ?? previous?.content);
  const createdAt = Date.parse(compact(previous?.timestamp));
  if (!assistantTurnId || !assistantText || !Number.isFinite(createdAt)) return undefined;
  const now = Number.isFinite(input.now) ? Number(input.now) : Date.now();
  const targetTaskIds = runtimeCleanupTargetTaskIdsFromAssistantTurn(previous);
  if (targetTaskIds.length === 0) return undefined;
  const scope: PendingAssistantOfferScope = {
    ...(compact(input.userId) ? { userId: compact(input.userId) } : {}),
    ...(compact(input.domain) ? { domain: compact(input.domain) } : {}),
    ...(compact(input.orgId) ? { orgId: compact(input.orgId) } : {}),
    conversationId,
    ...(compact(input.taskId) ? { taskId: compact(input.taskId) } : {}),
    assistantTurnId,
  };
  const offer = createPendingRuntimeCleanupOffer({
    assistantText,
    scope,
    targetTaskIds,
    now: createdAt,
  });
  if (!offer || offer.expiresAt <= now) return undefined;
  return {
    offer,
    userId: scope.userId,
    domain: scope.domain,
    orgId: scope.orgId,
    conversationId,
    taskId: scope.taskId,
    previousAssistantTurnId: assistantTurnId,
    now,
  };
}

export function resolvePendingRuntimeCleanupOffer(
  userText: string,
  context?: PendingAssistantOfferContext,
): AcceptedRuntimeCleanupOffer | null {
  const offer = context?.offer;
  if (!offer || offer.schemaVersion !== PENDING_ASSISTANT_OFFER_SCHEMA_VERSION) return null;
  if (offer.kind !== 'runtime_work_cleanup' || offer.toolCall.name !== 'runtime_work_cancel') return null;
  const now = Number.isFinite(context?.now) ? Number(context?.now) : Date.now();
  if (offer.expiresAt <= now) return null;
  if (!context?.conversationId || compact(context.conversationId) !== offer.scope.conversationId) return null;
  // The caller must prove that this exact assistant turn is immediately before
  // the user's acceptance. A historical offer cannot be adopted later.
  if (
    !context.previousAssistantTurnId
    || compact(context.previousAssistantTurnId) !== offer.scope.assistantTurnId
  ) return null;
  if (offer.scope.userId && compact(context.userId) !== offer.scope.userId) return null;
  if (offer.scope.domain && compact(context.domain) !== offer.scope.domain) return null;
  if (offer.scope.orgId && compact(context.orgId) !== offer.scope.orgId) return null;
  if (offer.scope.taskId && compact(context.taskId) !== offer.scope.taskId) return null;
  if (!offer.scope.taskId && compact(context.taskId)) return null;
  if (!isRuntimeCleanupOfferAcceptanceText(userText)) return null;
  return {
    intent: 'cancel',
    offerId: offer.id,
    toolCall: {
      name: 'runtime_work_cancel',
      arguments: { taskIds: [...offer.toolCall.arguments.taskIds] },
    },
  };
}
