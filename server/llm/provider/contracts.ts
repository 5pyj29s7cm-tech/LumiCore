import type { ParsedToolCall } from "../../tools/types";
import type { ModelTurnState } from "../model_turn_state";
import type { UserLLMFallbackCandidate, UserLLMSelectionMode } from "../user_preferences";
import type { responseFormatParameter } from './openai_compatible';

export type MessageContent =
  | string
  | null
  | Array<{ type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string; detail?: 'auto' | 'low' | 'high' } }>;

export type LLMResponseFormat = 'json_object' | {
  type: 'json_schema';
  json_schema: { name: string; schema: Record<string, unknown>; strict?: boolean };
};

export type ReasoningProvider = string;

export interface LLMCallConfig {
  provider: ReasoningProvider;
  model: string;
  maxTokens?: number;
  userId?: string;
  domain?: string;
  orgId?: string;
  conversationId?: string;
  requestId?: string;
  nativeDeviceId?: string;
  executionSessionId?: string;
  nativeClientIdentitySha256?: string;
  audioInputKind?: 'physical_microphone' | 'synthetic_accepted_transcript';
  syntheticAudio?: boolean;
  captureSessionId?: string;
  sttReceiptId?: string;
  contextChainId?: string;
  previousRequestId?: string;
  interactionId?: string;
  source?: string;
  responseFormat?: LLMResponseFormat;
  /** Per-call opt-out for supported DeepSeek thinking APIs; never a saved preference. */
  thinkingMode?: 'disabled';
  reasoningEffort?: 'low' | 'high' | 'max';
  signal?: AbortSignal;
  /** Provider-independent lifecycle deadlines for one model attempt. */
  attemptTimeouts?: Partial<ModelAttemptTimeouts>;
  /** Shared only within the accepted user turn, including guarded recovery. */
  modelTurnState?: ModelTurnState;
  /** Total input budget across system, history, current input, and tool schemas. */
  inputTokenBudget?: number;
  /** Server-selected schemas that the final provider budget must retain. */
  protectedToolNames?: string[];
  role?: 'reasoning' | 'vision' | 'world';
  selectionMode?: UserLLMSelectionMode;
  fallbackCandidates?: UserLLMFallbackCandidate[];
  allowCloudFallback?: boolean;
  /** Per-request routing boundary. Unlike global strict mode, this survives graph recovery. */
  dataRoutingPolicy?: 'policy_scoped' | 'local_only';
  /**
   * Execute exactly `provider`/`model` and never consult stored preferences,
   * automatic routing, or fallbackCandidates. Model-graph execution sets this
   * because the graph itself is the authoritative, budgeted failover plan.
   */
  noImplicitFailover?: boolean;
  /** True only for a candidate compiled from the user's stored route policy. */
  authorizedRoutingCandidate?: boolean;
  /** Local-only declaration names that preflight must retain or fail closed. */
  localRequiredToolNames?: string[];
  /**
   * Keep candidate chunks private until that candidate reaches a successful
   * terminal frame. Tool/action turns use this because their caller already
   * buffers output for final adjudication; a provider may then fail over
   * without leaking or concatenating a partial first-candidate sentence.
   */
  bufferStreamUntilCandidateSuccess?: boolean;
  /** Aggregate the existing SSE transport for a long buffered call; never inferred from chat text. */
  relayStreaming?: boolean;
}

export interface ModelAttemptTimeouts {
  /** Time allowed to establish the provider response/stream. */
  requestMs: number;
  /** Time allowed before the first transport frame arrives. */
  firstByteMs: number;
  /** Time allowed before text or a tool call is produced. */
  semanticContentMs: number;
  /** Maximum gap between transport frames after streaming starts. */
  idleMs: number;
  /** Hard wall-clock limit for the complete attempt. */
  absoluteMs: number;
}

export type ModelAttemptDeadlineStage =
  | 'request'
  | 'first_byte'
  | 'semantic_content'
  | 'idle'
  | 'absolute'
  | 'cancelled';

export interface NormalizedMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: MessageContent;
  /** Server-only durable transcript provenance; never serialized to a provider. */
  sourceMessageId?: string;
  /** Server-only semantic budget contract; never provider payload metadata. */
  promptBlock?: import("../prompt_blocks").PromptBlock;
  toolCalls?: ParsedToolCall[];
  toolCallId?: string;
  name?: string;
  reasoningContent?: string | null;
}

export interface ToolDeclaration {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, any>;
  };
}

export type OpenAICompatibleMessage = {
  role: string;
  content: MessageContent;
  tool_calls?: any;
  tool_call_id?: string;
  name?: string;
  reasoning_content?: string;
};

// ── DeepSeek (OpenAI-compatible) ──

export type OpenAICompatibleRequestParams = {
  model: string;
  messages: NormalizedMessage[];
  toolDeclarations: ToolDeclaration[];
  maxTokens?: number;
  userId?: string;
  responseFormat?: LLMResponseFormat;
};

export type OpenAICompatibleRequest = {
  model: string;
  messages: OpenAICompatibleMessage[];
  tools?: ToolDeclaration[];
  tool_choice?: string;
  max_tokens?: number;
  user?: string;
  response_format?: ReturnType<typeof responseFormatParameter>;
};

// ── Streaming LLM Call Router ──

export type StreamCallback = (chunk: string) => void;

export type AttemptDeadline = { stage: Exclude<ModelAttemptDeadlineStage, 'cancelled'>; dueAt: number; timeoutMs: number };
