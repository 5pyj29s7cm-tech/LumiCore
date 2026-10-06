import type { ModelTurnState } from "../model_turn_state";
import type { ToolExecutionRecord } from "../../tools/types";
import type { LLMResponseFormat, ModelAttemptTimeouts } from "../providers";
import type { CompletionGuardResult } from "../../work_product/completion_guard";
import type { UserLLMFallbackCandidate, UserLLMSelectionMode } from "../user_preferences";

export interface LLMConfig {
  provider: string;
  model: string;
  maxTokens?: number;
  userId?: string;
  domain?: string;
  orgId?: string;
  conversationId?: string;
  requestId?: string;
  interactionId?: string;
  source?: string;
  /** Accepted transport provenance, separate from the model-routing stage. */
  workflowSource?: string;
  responseFormat?: LLMResponseFormat;
  thinkingMode?: 'disabled';
  signal?: AbortSignal;
  /** Provider-independent lifecycle deadlines for each model candidate. */
  attemptTimeouts?: Partial<ModelAttemptTimeouts>;
  /** Total provider-input budget including system, history, input and schemas. */
  inputTokenBudget?: number;
  /** Schemas selected by the execution plan that provider compaction must retain. */
  protectedToolNames?: string[];
  /** Cumulative budget spent waiting on model providers; tool runtime is excluded. */
  modelWaitBudgetMs?: number;
  modelTurnState?: ModelTurnState;
  /**
   * Maximum time allowed for one durable tool-lifecycle observer write. The
   * observer is an execution boundary, not UI telemetry: timing it out leaves
   * an already-started adapter quarantined instead of reporting completion.
   */
  toolLifecycleObserverTimeoutMs?: number;
  selectionMode?: UserLLMSelectionMode;
  fallbackCandidates?: UserLLMFallbackCandidate[];
  allowCloudFallback?: boolean;
  /** Per-request routing boundary inherited from a durable execution graph. */
  dataRoutingPolicy?: 'policy_scoped' | 'local_only';
  /**
   * Execute the configured provider/model as one exact candidate. The caller
   * owns all candidate fallback and retry ordering outside this adapter.
   */
  noImplicitFailover?: boolean;
  /** Candidate was compiled by a trusted LumiCore routing policy. */
  authorizedRoutingCandidate?: boolean;
  /**
   * Server-internal schema names that a small local candidate must retain.
   * This never changes executor authorization or the cloud candidate payload.
   */
  localRequiredToolNames?: string[];
  /** Action/tool-loop streams are caller-buffered and may safely fail over
   * before the selected candidate reaches a terminal response. */
  bufferStreamUntilCandidateSuccess?: boolean;
}

export interface LLMResult {
  text: string;
  toolCalls: ToolExecutionRecord[];
  usageRecords: LLMUsageRecord[];
  /** Preserve a pre-finalization verdict; guarded prose is not fresh evidence of success. */
  completionGuard?: CompletionGuardResult;
}

export interface LLMUsageRecord {
  provider: string;
  model: string;
  requestedProvider?: string;
  requestedModel?: string;
  selectionMode?: UserLLMSelectionMode;
  fallbackReason?: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}
