import type { ToolPolicy } from "../../personality/types";
import type { ConversationTaskPolicySnapshot, ConversationTaskReceipt, ConversationTaskStatus } from "../task_execution_ledger";
import type { TaskCapsuleV1 } from "../../conversation/task_capsule";

export interface ActionContinuationHistoryItem {
  role?: string;
  type?: string;
  message?: string;
  content?: string;
  text?: string;
  response?: string;
  toolCalls?: unknown;
  cognitiveIntent?: string;
  timestamp?: string;
  receivedAt?: string;
}

export interface RecentActionContinuationState {
  goal: string;
  appTarget: string;
  sourcePaths: string[];
  latestBlocker: string;
  unfinished: boolean;
  evidenceTools: string[];
}

/**
 * Compact, conversation-scoped execution pointer persisted alongside the
 * conversation. It is deliberately evidence-derived: a plain assistant claim
 * can never create or advance this state without terminal tool records.
 */
export interface ConversationActionContinuationState extends RecentActionContinuationState {
  version: 1 | 2;
  /** Stable identity shared by every turn that advances the same task. */
  taskId?: string;
  status?: ConversationTaskStatus;
  /** Capability envelope selected from the original complete instruction. */
  policySnapshot?: ConversationTaskPolicySnapshot;
  /** Coalesced terminal receipts. A successful retry supersedes its failure. */
  receipts?: ConversationTaskReceipt[];
  activeRequestId?: string;
  supersededTaskId?: string;
  revision?: number;
  latestInstruction: string;
  /** Persisted user message id, falling back to the owning request id. */
  latestInstructionRef?: string;
  assistantState: string;
  toolSummaries: string[];
  /** Durable semantic projection shared by chat, voice, and restart hydration. */
  taskCapsule?: TaskCapsuleV1;
  updatedAt: string;
  evidenceMessageId?: string;
  completionSource?: 'tool_receipt' | 'user_observation';
  /**
   * A terminal projection was staged in memory, but its strict persistence
   * fence failed.  Keep this marker with the resumable task so restart
   * hydration cannot turn the staged success back into an authoritative one.
   */
  terminalPersistence?: {
    status: 'persistence_unknown';
    requestId: string;
    quarantinedAt: string;
  };
}

export interface PendingRuntimeCancellationRecheck {
  taskId: string;
  taskIds: string[];
  priorReceiptId: string;
  priorStatus: 'cancelling';
}

export interface ConversationActionContinuationUpdate {
  previous?: ConversationActionContinuationState | null;
  userText: string;
  assistantText: string;
  toolCalls: unknown;
  updatedAt?: string;
  evidenceMessageId?: string;
  /** Exact persisted user message that supplied userText, when available. */
  userMessageId?: string;
  requestId?: string;
  toolPolicy?: ToolPolicy;
}

export type ToolRecordTaskDurability = 'observation_only' | 'durable' | 'unknown';

export type RecentActionFollowupIntent = 'execute' | 'status' | 'repeat' | 'none';
