import type { ConversationActionContinuationState } from "../../cognition/action_continuation";
import type { NormalizedActionIntent } from "../../cognition/normalized_action_intent";
import type { ConversationTaskStatus } from "../../cognition/task_execution_ledger";
import type { ToolExecutionRecord } from "../../tools/types";
import type { CapabilityExecutionPlan } from "../../cognition/capability_execution_plan";

export interface ConversationActionTaskRow {
  id: string;
  conversationId: string;
  userId: string;
  domain: string;
  orgId: string;
  parentTaskId: string;
  rootUserMessageId: string;
  intentKind: string;
  operation: string;
  goal: string;
  target: string;
  status: ConversationTaskStatus;
  blocker: string;
  activeRequestId: string;
  completionSource: string;
  context: string | Record<string, unknown>;
  revision: number;
  createdAt: string;
  updatedAt: string;
  completedAt: string;
}

export interface ConversationActionReceiptRow {
  id: string;
  taskId: string;
  conversationId: string;
  turnId: string;
  requestId: string;
  turnRowId?: string;
  externalMessageId?: string;
  modelRoutingReceiptId?: string;
  executionOrigin?: ToolExecutionRecord['executionOrigin'];
  idempotencyKey: string;
  toolName: string;
  targetIdentity: string;
  inputDigest: string;
  envelope: string;
  outcome: string;
  createdAt: string;
}

export interface PersistedCapabilityExecutionPlan {
  schemaVersion: 1;
  planId: string;
  taskId: string;
  intent: Omit<NormalizedActionIntent, 'payload'> & {
    payload: '';
    payloadDigest: string;
  };
  nodes: Array<{
    nodeId: string;
    type: string;
    terminalStatus?: NonNullable<ToolExecutionRecord['envelope']>['status'];
    capabilityId: string;
    toolName?: string;
    lane: string;
    operation: string;
    risk: string;
    requiresConfirmation: boolean;
    verificationStrategy: string;
    executionRole: 'planner' | 'adapter' | 'verifier' | 'join';
    selectionGroup?: string;
    selectionRank?: number;
  }>;
  edges: CapabilityExecutionPlan['edges'];
  expectedEvidence: CapabilityExecutionPlan['expectedEvidence'];
  risk: CapabilityExecutionPlan['risk'];
  fallbackPolicy: CapabilityExecutionPlan['fallbackPolicy'];
  contextRefs: CapabilityExecutionPlan['contextRefs'];
  decisionAuthority: 'semantic_planner' | 'registry_bound_call';
  scriptAuthority: 'adapter_only';
  persistedAt: string;
}

export type ConversationActionTaskFinalizationOutcome =
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'blocked'
  | 'persistence_unknown';

/**
 * Request-scoped terminal adjudication supplied by a foreground transport.
 *
 * This is deliberately narrower than task finalization: a blocked request
 * leaves the durable task resumable, while preventing a successful receipt
 * from an earlier step in the same request from being mistaken for completion.
 */
export interface ConversationActionTerminalDisposition {
  outcome: 'blocked' | 'cancelled';
  taskId: string;
  requestId: string;
  reason: string;
}

export interface ConversationActionLiveProjection {
  id: string;
  userId: string;
  domain?: string;
  orgId?: string;
  actionContinuationState?: ConversationActionContinuationState;
  pendingActionContinuation?: {
    userText: string;
    messageId: string;
    requestId?: string;
    updatedAt: string;
  };
}
