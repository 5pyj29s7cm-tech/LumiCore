import { type ConversationActionTerminalDisposition } from './action_ledger';
import { type ConversationActionTurn } from './action_turn_ledger';

export interface FinalizeConversationActionRequestOptions {
  assistantState?: string;
  fallbackBlocker?: string;
  now?: string;
  terminalDisposition?: ConversationActionTerminalDisposition;
}

export interface ConvergeConversationActionRequestLeaseInput {
  conversationId: string;
  userId: string;
  requestId: string;
  now?: Date | string | number;
  /** @internal Keep the process owner until the staged mutation is strictly flushed. */
  deferLocalOwnerClear?: boolean;
}

export type ConversationActionRequestLeaseEvidence =
  | 'found'
  | 'missing'
  | 'ambiguous'
  | 'unbound';

export interface ConvergeConversationActionRequestLeaseResult {
  conversationId: string;
  userId: string;
  requestId: string;
  taskId: string;
  assistantMessageId: string;
  beforeStatus: ConversationActionTurn['status'] | 'missing';
  finalStatus: ConversationActionTurn['status'] | 'missing';
  action: 'none' | 'terminal' | 'cancelled' | 'persistence_unknown';
  converged: boolean;
  changed: boolean;
  reason: string;
  evidence: {
    conversation: ConversationActionRequestLeaseEvidence;
    task: ConversationActionRequestLeaseEvidence;
    assistant: ConversationActionRequestLeaseEvidence;
  };
  localOwnerCleared: boolean;
  turn: ConversationActionTurn | null;
}

export type ForegroundRequestFinalizationOutcome =
  | 'terminal'
  | 'cancelled'
  | 'superseded'
  | 'blocked'
  | 'persistence_unknown';

export interface FinalizeForegroundRequestInput {
  /** Immutable identity of the already accepted foreground request. */
  readonly conversationId: string;
  readonly userId: string;
  readonly requestId: string;
  /** Optional caller assertion. It must agree with the durable turn binding. */
  readonly expectedTaskId?: string;
  readonly outcome: ForegroundRequestFinalizationOutcome;
  /** Exact durable assistant row. Text alone is never terminal evidence. */
  readonly assistantMessageId?: string;
  /** Bounded user-visible state copied into a task projection when one exists. */
  readonly assistantState?: string;
  readonly reason?: string;
  readonly now?: Date | string | number;
  /** @internal Keep the process owner until the staged mutation is strictly flushed. */
  readonly deferLocalOwnerClear?: boolean;
}

export type ForegroundRequestFinalizationEvidence =
  | 'found'
  | 'missing'
  | 'ambiguous'
  | 'unbound'
  | 'mismatch';

export interface FinalizeForegroundRequestResult {
  conversationId: string;
  userId: string;
  requestId: string;
  requestedOutcome: ForegroundRequestFinalizationOutcome;
  effectiveOutcome: ForegroundRequestFinalizationOutcome;
  taskId: string;
  assistantMessageId: string;
  taskStatus: string;
  actionTurnStatus: ConversationActionTurn['status'] | 'missing' | 'ambiguous';
  converged: boolean;
  changed: boolean;
  reason: string;
  evidence: {
    conversation: ForegroundRequestFinalizationEvidence;
    actionTurn: ForegroundRequestFinalizationEvidence;
    task: ForegroundRequestFinalizationEvidence;
    assistant: ForegroundRequestFinalizationEvidence;
  };
  localOwnerCleared: boolean;
}

export interface ForegroundRequestDurabilityDependencies {
  /** Strict persistence barrier. Tests may inject a deterministic failure. */
  flush?: () => Promise<void>;
}

export interface ForegroundRequestIdentity {
  readonly conversationId: string;
  readonly userId: string;
  readonly requestId: string;
  readonly expectedTaskId?: string;
}

export interface ForegroundRequestReleaseInput {
  readonly identity: ForegroundRequestIdentity;
  readonly aborted: boolean;
  readonly reason?: string;
  readonly assistantState?: string;
}

export interface ForegroundRequestReleaseResult {
  convergence: ConvergeConversationActionRequestLeaseResult;
  finalization: FinalizeForegroundRequestResult | null;
  converged: boolean;
}
