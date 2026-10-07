export type ChatExecutionStatus =
  | 'acknowledged'
  | 'planning'
  | 'executing'
  | 'waiting_confirmation'
  | 'cancelling'
  | 'completed'
  | 'cancelled'
  | 'failed';

export type ChatExecutionScope = {
  userId: string;
  domain: 'personal' | 'work';
  orgId?: string;
  source: string;
  conversationId?: string;
  /** Main chat receipts cannot outlive the transcript that authorized them. */
  requireConversation?: boolean;
};

export type ChatExecutionEvent = {
  event: string;
  payload: Record<string, any>;
};

export type ChatExecutionSnapshot = {
  requestId: string;
  source: string;
  /** Server-owned conversation identity, including requests recovered without a client conversation id. */
  conversationId?: string;
  /** Sidecar requests have durable receipts but never own the foreground slot. */
  sidecar?: boolean;
  /** Reserved behind another foreground turn; exact-id resumable, never active. */
  queued?: boolean;
  status: ChatExecutionStatus;
  createdAt: string;
  updatedAt: string;
  terminal: boolean;
  lastEvent?: ChatExecutionEvent;
  terminalEvent?: ChatExecutionEvent;
};

export type DurableChatCancellationBinding = {
  controlRequestId: string;
  targetRequestId: string;
  controlTerminal: ChatExecutionSnapshot;
  targetTerminal: ChatExecutionSnapshot;
};

/**
 * Durable conversation/task identity observed by the status route. Recovery
 * receipts alone cannot establish "current": after a restart they contain
 * bounded terminal history, while the conversation ledger may already own a
 * newer accepted request.
 */
export type DurableChatCancellationStatusFence = {
  currentTask?: {
    taskId: string;
    revision: number;
    activeRequestId?: string;
    unfinished: boolean;
  };
  relation?: {
    binding: string;
    taskId?: string;
    revision?: number;
    targetRequestId?: string;
  };
  requestedTarget?: {
    requestId?: string;
    taskId?: string;
    revision?: number;
  };
};

export type StoredExecution = ChatExecutionSnapshot & {
  /** Recovered cancellation receipts are history, not a live process task. */
  inProcess?: boolean;
  scopeKey: string;
  recoveryScopeKey: string;
  controlIntentTarget?: string;
  controlIntentDurable?: boolean;
  controlIntentBarrier?: Promise<void>;
  /** Installed at sidecar reservation so duplicates can wait before a more
   * specific control-intent or terminal receipt barrier has been created. */
  sidecarDurabilityBarrier?: Promise<void>;
  resolveSidecarDurability?: () => void;
  rejectSidecarDurability?: (error: unknown) => void;
  sidecarDurabilitySettled?: boolean;
  /**
   * A strict terminal is kept private until its durable receipt settles. This
   * prevents reconnect/retry readers from replaying a success that only exists
   * in memory while the database write is still in flight.
   */
  terminalReceiptPending?: {
    status: 'completed' | 'cancelled' | 'failed';
    event: ChatExecutionEvent;
    updatedAt: string;
  };
  terminalReceiptDurable?: boolean;
  terminalReceiptBarrier?: Promise<void>;
};

export type PersistedChatExecutionReceipt = {
  userId: string;
  domain: 'personal' | 'work';
  orgId: string;
  source: string;
  conversationId: string;
  requestId: string;
  status: 'cancelling' | 'completed' | 'cancelled' | 'failed';
  event: string;
  payload: Record<string, any>;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
};

export type ChatExecutionPersistenceAdapter = {
  loadRecoverable(nowIso: string): Promise<PersistedChatExecutionReceipt[]>;
  upsert(receipt: PersistedChatExecutionReceipt): Promise<void>;
  purgeExpired(nowIso: string): Promise<void>;
  deleteConversation?(scope: Pick<ChatExecutionScope, 'userId' | 'domain' | 'orgId' | 'conversationId'>): Promise<void>;
};

export const TERMINAL_RETENTION_MS = 30 * 60 * 1000;

export const CONTROL_INTENT_RETENTION_MS = 24 * 60 * 60 * 1000;

export const PERSISTENT_PURGE_INTERVAL_MS = 5 * 60 * 1000;

export const MAX_TERMINAL_TEXT_CHARS = 8_000;

export const MAX_TERMINAL_ERROR_CHARS = 1_000;
