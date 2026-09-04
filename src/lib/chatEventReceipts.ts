export interface ChatEventReceiptIdentity {
  requestId?: string;
  source?: string;
  conversationId?: string;
}

function compact(value: unknown): string {
  return String(value || '').trim();
}

export type PersistedPendingChatExecution = {
  requestId: string;
  source: string;
  domain: 'personal' | 'work';
  orgId?: string;
  conversationId?: string;
  startedAt: string;
  mediaGeneration?: {
    mode: 'image' | 'video';
    operation?: 'text_to_image' | 'image_edit' | 'text_to_video' | 'image_to_video';
    size: string;
    count?: number;
    duration?: number;
    primaryImage?: string;
    referenceImages?: string[];
    referenceImage?: string;
  };
};

export type PersistedPendingChatExecutionState = {
  version: 2;
  pending: PersistedPendingChatExecution[];
};

type PersistedMediaGeneration = NonNullable<PersistedPendingChatExecution['mediaGeneration']>;

const MAX_PERSISTED_PENDING_CHAT_EXECUTIONS = 8;

function normalizePendingExecution(value: unknown): PersistedPendingChatExecution | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const candidate = value as Partial<PersistedPendingChatExecution>;
  const requestId = compact(candidate.requestId);
  const startedAt = compact(candidate.startedAt);
  if (!requestId || !startedAt) return null;
  const rawMedia = candidate.mediaGeneration && typeof candidate.mediaGeneration === 'object'
    ? candidate.mediaGeneration
    : undefined;
  const mode = rawMedia?.mode === 'image' || rawMedia?.mode === 'video' ? rawMedia.mode : undefined;
  const size = compact(rawMedia?.size).slice(0, 40);
  const rawOperation = compact(rawMedia?.operation);
  const operation: PersistedMediaGeneration['operation'] = mode === 'image'
    ? (rawOperation === 'image_edit' ? 'image_edit' : 'text_to_image')
    : mode === 'video'
      ? (rawOperation === 'image_to_video' ? 'image_to_video' : 'text_to_video')
      : undefined;
  const primaryImage = compact(rawMedia?.primaryImage).slice(0, 8192);
  const referenceImages = Array.isArray(rawMedia?.referenceImages)
    ? rawMedia.referenceImages.map(value => compact(value).slice(0, 8192)).filter(Boolean).slice(0, 1)
    : [];
  const referenceImage = compact(rawMedia?.referenceImage).slice(0, 8192);
  const mediaGeneration = mode && size ? {
    mode,
    ...(operation ? { operation } : {}),
    size,
    ...(operation === 'text_to_image'
      ? { count: Math.min(4, Math.max(1, Number(rawMedia?.count) || 1)) }
      : operation === 'image_edit'
        ? {
            ...(primaryImage ? { primaryImage } : {}),
            ...(referenceImages.length ? { referenceImages } : {}),
          }
        : {
            duration: Math.min(120, Math.max(1, Number(rawMedia?.duration) || 6)),
            ...(operation === 'image_to_video' && referenceImage ? { referenceImage } : {}),
          }),
  } : undefined;
  return {
    requestId,
    source: compact(candidate.source) || 'chat',
    domain: candidate.domain === 'work' ? 'work' : 'personal',
    orgId: compact(candidate.orgId) || undefined,
    conversationId: compact(candidate.conversationId) || undefined,
    startedAt,
    ...(mediaGeneration ? { mediaGeneration } : {}),
  };
}

/** Accepts the old single-row shape and the v2 bounded FIFO shape. */
export function normalizePersistedPendingChatExecutions(
  value: unknown,
): PersistedPendingChatExecution[] {
  const raw = value && typeof value === 'object' && !Array.isArray(value)
    && Array.isArray((value as PersistedPendingChatExecutionState).pending)
    ? (value as PersistedPendingChatExecutionState).pending
    : [value];
  const unique = new Map<string, PersistedPendingChatExecution>();
  for (const item of raw) {
    const normalized = normalizePendingExecution(item);
    if (!normalized) continue;
    if (!unique.has(normalized.requestId)) unique.set(normalized.requestId, normalized);
  }
  return [...unique.values()].slice(-MAX_PERSISTED_PENDING_CHAT_EXECUTIONS);
}

export function upsertPersistedPendingChatExecution(
  value: unknown,
  execution: PersistedPendingChatExecution,
): PersistedPendingChatExecutionState {
  const pending = normalizePersistedPendingChatExecutions(value);
  const index = pending.findIndex(item => item.requestId === execution.requestId);
  if (index >= 0) pending[index] = { ...execution, startedAt: pending[index].startedAt };
  else pending.push(execution);
  return { version: 2, pending: pending.slice(-MAX_PERSISTED_PENDING_CHAT_EXECUTIONS) };
}

export function removePersistedPendingChatExecution(
  value: unknown,
  requestId: string,
): PersistedPendingChatExecutionState {
  const normalizedRequestId = compact(requestId);
  return {
    version: 2,
    pending: normalizePersistedPendingChatExecutions(value)
      .filter(item => item.requestId !== normalizedRequestId),
  };
}

/**
 * Returns a stable terminal identity when the transport supplied a request id.
 * Request ids are the idempotency key; source prevents unrelated chat surfaces
 * from sharing a key. Conversation id remains metadata because the first native
 * turn can be emitted once before and once after the server assigns it.
 */
export function chatTerminalReceiptKey(event?: ChatEventReceiptIdentity): string {
  const requestId = compact(event?.requestId);
  if (!requestId) return '';
  return `${compact(event?.source) || 'chat'}\u001f${requestId}`;
}

/** Bounded per-view receipt ledger for Socket.IO replay/duplicate suppression. */
export class ChatTerminalReceiptLedger {
  private readonly receipts = new Map<string, string>();

  constructor(private readonly maxEntries = 256) {}

  claim(event?: ChatEventReceiptIdentity): boolean {
    const key = chatTerminalReceiptKey(event);
    // Legacy frames without a request id cannot be safely conflated by text.
    if (!key) return true;
    if (this.receipts.has(key)) return false;

    this.receipts.set(key, compact(event?.conversationId));
    while (this.receipts.size > this.maxEntries) {
      const oldest = this.receipts.keys().next().value as string | undefined;
      if (!oldest) break;
      this.receipts.delete(oldest);
    }
    return true;
  }

  clear(): void {
    this.receipts.clear();
  }
}

/** Tracks overlapping foreground/queued/sidecar requests without guessing intent. */
export class ChatRequestLedger {
  private readonly pending = new Set<string>();
  private foregroundRequestId = '';

  begin(requestId: string): { controlTargetRequestId: string } {
    const normalizedRequestId = compact(requestId);
    const controlTargetRequestId = this.foregroundRequestId;
    if (!normalizedRequestId) return { controlTargetRequestId };
    this.pending.add(normalizedRequestId);
    if (!this.foregroundRequestId) this.foregroundRequestId = normalizedRequestId;
    return { controlTargetRequestId };
  }

  has(requestId: string): boolean {
    return this.pending.has(compact(requestId));
  }

  settle(requestId: string): { remaining: number; foregroundRequestId: string } {
    const normalizedRequestId = compact(requestId);
    if (normalizedRequestId) this.pending.delete(normalizedRequestId);
    if (this.foregroundRequestId === normalizedRequestId || !this.pending.has(this.foregroundRequestId)) {
      this.foregroundRequestId = this.pending.values().next().value || '';
    }
    return { remaining: this.pending.size, foregroundRequestId: this.foregroundRequestId };
  }

  get foreground(): string {
    return this.foregroundRequestId;
  }

  get size(): number {
    return this.pending.size;
  }

  clear(): void {
    this.pending.clear();
    this.foregroundRequestId = '';
  }
}

export function finalizeStreamedChatMessage<T extends { id: string; text?: unknown }>(
  messages: T[],
  streamedMessageId: string,
  finalText: string,
): T[] {
  if (!streamedMessageId || !finalText) return messages;
  return messages.map(message => (
    message.id === streamedMessageId
      ? { ...message, text: finalText }
      : message
  ));
}

/**
 * Owns delayed UI cleanup for one request generation. Starting another turn
 * both cancels old timers and invalidates callbacks that were already queued.
 */
export class ChatTurnTimerGuard {
  private generation = 0;
  private requestId = '';
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();

  begin(requestId: string): number {
    this.clearTimers();
    this.generation += 1;
    this.requestId = compact(requestId);
    return this.generation;
  }

  schedule(requestId: string, delayMs: number, callback: () => void): ReturnType<typeof setTimeout> | null {
    const expectedRequestId = compact(requestId);
    if (!expectedRequestId || expectedRequestId !== this.requestId) return null;
    const expectedGeneration = this.generation;
    let timer: ReturnType<typeof setTimeout>;
    timer = setTimeout(() => {
      this.timers.delete(timer);
      if (this.generation !== expectedGeneration || this.requestId !== expectedRequestId) return;
      callback();
    }, delayMs);
    this.timers.add(timer);
    return timer;
  }

  invalidate(): void {
    this.clearTimers();
    this.generation += 1;
    this.requestId = '';
  }

  dispose(): void {
    this.invalidate();
  }

  private clearTimers(): void {
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
  }
}
