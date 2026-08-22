import type { ModelRoutingTrace } from '../llm/model_routing_receipts';

export type ToolPermission = 'public' | 'user' | 'admin' | 'system';

/** Security classification per tool — inspired by Claude Code's tier system */
export type SecurityLevel = 'safe' | 'confirm' | 'forbidden';
export type CapabilitySource = 'builtin' | 'mcp' | 'skill' | 'adapter';
export type CapabilityOperation = 'observe' | 'test' | 'mutate' | 'create' | 'communicate' | 'unknown';
export type CapabilityMode = 'chat' | 'assistant' | 'autonomous' | 'meeting';
export type CapabilityRisk = 'none' | 'low' | 'medium' | 'high' | 'critical';
export type CapabilityTrust = 'core' | 'official' | 'user-reviewed' | 'third-party' | 'untrusted';
export type CapabilityLane =
  | 'client'
  | 'files'
  | 'desktop'
  | 'web'
  | 'cad'
  | 'messaging'
  | 'office'
  | 'media'
  | 'knowledge'
  | 'memory'
  | 'agents'
  | 'system'
  | 'industry'
  | 'general';

export interface CapabilitySideEffect {
  type:
    | 'local_read'
    | 'local_write'
    | 'local_state_change'
    | 'desktop_control'
    | 'network_read'
    | 'external_state_change'
    | 'external_communication'
    | 'credential_access'
    | 'process_execution'
    | 'installation'
    | 'none';
  scope: string;
  reversible: boolean;
}

export interface CapabilityVerification {
  strategy:
    | 'terminal_receipt'
    | 'state_diff'
    | 'artifact'
    | 'provider_ack'
    | 'visual'
    | 'measured'
    | 'none';
  required: boolean;
  /** Dot-separated receipt fields that must be present, including false/zero values. */
  requiredFields: string[];
  /** Exact primitive/object values required at dot-separated receipt paths. */
  requiredValues?: Record<string, unknown>;
  /** Receipt status values that are successful for this capability. */
  successStatuses?: string[];
  /** Receipt status values that are failures for this capability. */
  failureStatuses?: string[];
  /** Dot-separated receipt fields whose local paths must all exist and be non-empty. */
  requiredArtifacts?: string[];
  /** Dot-separated receipt fields containing arrays of paths or `{ path }` artifacts; every item must exist. */
  requiredArtifactCollections?: string[];
  successSignals: string[];
  limitations: string[];
}

export interface CapabilityFallback {
  capabilityId: string;
  when: string;
  order: number;
}

export interface CapabilityProvenance {
  kind: CapabilitySource;
  provider: string;
  trust: CapabilityTrust;
}

export interface CapabilityAdapterContract {
  id: string;
  /** Stable semantic operations exposed identically on every platform. */
  operations: string[];
  /** Platform adapter ids; tool names and schemas remain platform-independent. */
  implementations: Partial<Record<'windows' | 'macos' | 'linux' | 'web', string>>;
}

export interface CapabilityReconciliationContract {
  /** Stable capability ids whose uncertain commits this read-only adapter can verify. */
  reconcilesCapabilityIds: string[];
  /** Only this dedicated field is accepted as commit-state evidence. */
  outcomeField: 'reconciliationStatus';
  committedValues: string[];
  notCommittedValues: string[];
}

/**
 * Stable capability metadata shared by discovery, model exposure, execution,
 * diagnostics, and client self-awareness. A tool may add richer metadata, but
 * the registry always materializes a complete manifest entry.
 */
export interface ToolCapabilityMetadata {
  /** Stable semantic capability id. Defaults to evidence.capability or tool name. */
  id?: string;
  /** Broad family used for generic grouping. Defaults to provider or name prefix. */
  family?: string;
  /** Stable work lane used by routing, adapters, self-model, and verification. */
  lane?: CapabilityLane;
  /** Runtime origin. Built-in tools default to builtin. */
  source?: CapabilitySource;
  /** MCP server, skill, adapter, or other provider that owns this tool. */
  provider?: string;
  /** Side-effect class used for discovery; unknown never counts as proof. */
  operation?: CapabilityOperation;
  /** Optional product/domain scopes, such as desktop, CAD, legal, or messaging. */
  domains?: string[];
  /** Search vocabulary in addition to the tool name and description. */
  tags?: string[];
  /** User intents handled by this capability. */
  intents?: string[];
  /** Operation modes in which the capability may be exposed. */
  modes?: CapabilityMode[];
  /** Product-level risk independent of the current personality policy. */
  risk?: CapabilityRisk;
  /** Concrete side effects produced by successful execution. */
  sideEffects?: CapabilitySideEffect[];
  /** Task-level verification contract. */
  verification?: CapabilityVerification;
  /** Ordered semantic fallbacks, never raw implementation guesses. */
  fallbacks?: CapabilityFallback[];
  /** Runtime provenance and trust classification. */
  provenance?: Partial<CapabilityProvenance>;
  /** Optional platform adapter contract. */
  adapter?: CapabilityAdapterContract;
  /** Explicit semantic pairing for a read-only unknown-outcome reconciler. */
  reconciliation?: CapabilityReconciliationContract;
  /** Marks a capability unavailable for new plans while preserving migration data. */
  deprecated?: boolean;
  /** Stable replacement capability id when deprecated. */
  replacedBy?: string;
  /** Optional mode-specific security override generated into operation-mode policy. */
  modeSecurity?: Partial<Record<CapabilityMode, SecurityLevel>>;
  /** Runtime prerequisites that may affect availability. */
  prerequisites?: string[];
}

export interface CapabilityManifestEntry {
  toolName: string;
  capabilityId: string;
  family: string;
  lane: CapabilityLane;
  source: CapabilitySource;
  provider?: string;
  description: string;
  permission: ToolPermission;
  configuredSecurityLevel: SecurityLevel;
  effectiveSecurityLevel: SecurityLevel;
  effectiveSecurityReason: string;
  executable: boolean;
  requiresConfirmation: boolean;
  operation: CapabilityOperation;
  modes: CapabilityMode[];
  risk: CapabilityRisk;
  sideEffects: CapabilitySideEffect[];
  metadataSources: {
    operation: 'tool_definition' | 'manifest_policy';
    lane: 'tool_definition' | 'manifest_policy';
    risk: 'tool_definition' | 'manifest_policy';
    sideEffects: 'tool_definition' | 'manifest_policy';
    evidence: 'tool_definition' | 'manifest_policy' | 'not_required';
    verification: 'tool_definition' | 'manifest_policy';
  };
  assurance: NonNullable<ToolDefinition['evidence']>['assurance'] | 'none';
  hasEvidenceContract: boolean;
  evidence: {
    capability: string;
    operation: Exclude<CapabilityOperation, 'unknown'>;
    assurance: NonNullable<ToolDefinition['evidence']>['assurance'];
    limitations: string[];
    declarationSource: 'tool_definition' | 'manifest_policy';
    explicit: boolean;
  } | null;
  verification: CapabilityVerification;
  fallbacks: CapabilityFallback[];
  provenance: CapabilityProvenance;
  trust: CapabilityTrust;
  deprecated: boolean;
  replacedBy?: string;
  adapter?: CapabilityAdapterContract;
  reconciliation?: CapabilityReconciliationContract;
  modeSecurity: Partial<Record<CapabilityMode, SecurityLevel>>;
  domains: string[];
  intents: string[];
  routingTerms: string[];
  prerequisites: string[];
  parameterNames: string[];
}

export interface ToolContext {
  userId?: string;
  /** Durable execution correlation shared by task, confirmation and receipt ledgers. */
  taskId?: string;
  conversationId?: string;
  turnId?: string;
  requestId?: string;
  idempotencyKey?: string;
  /**
   * Canonical calls that already executed before this model/tool-loop segment,
   * such as the exact receipt produced after consuming a one-time user
   * confirmation. They are evidence and deduplication/recovery state only:
   * the loop must never emit their lifecycle callback or execute them again.
   */
  priorToolRecords?: ToolExecutionRecord[];
  /** Runtime consumer for the current DesktopExecutionPlan state machine. */
  desktopExecutionTracker?: import('../desktop/execution_runtime').DesktopExecutionTracker;
  /** Canonical registry injected by ToolRegistry for nested workflow/tool execution. */
  toolRegistry?: import('./registry').ToolRegistry;
  /** Active data domain for scoped writes. */
  domain?: 'personal' | 'work' | string;
  /** Organization id when domain is work. */
  orgId?: string;
  socketId?: string;
  cwd?: string;
  /** Relay for desktop tools: sends execution request to Tauri frontend and returns result */
  desktopRelay?: (toolName: string, args: Record<string, any>) => Promise<string>;
  /** Explicit personal-device relay used only for approved cross-workspace handoff, such as sending an organization file to the member's own WeChat. */
  personalDesktopRelay?: (toolName: string, args: Record<string, any>) => Promise<string>;
  /** Called when a tool requires confirmation. Returns true to proceed, false to abort. */
  requestConfirmation?: (toolName: string, args: Record<string, any>) => Promise<boolean>;
  /** Original user/task intent used to classify semantic risk for low-level actions. */
  actionIntent?: string;
  /**
   * Routed execution text, including trusted continuation state recovered for
   * the current turn. Task-specific guards may use this instead of the shorter
   * visible user message, but it must not replace actionIntent for risk checks.
   */
  routedTaskText?: string;
  /** True only after the registry's confirmation callback approved this tool call. */
  userConfirmed?: boolean;
  /**
   * True when the current user turn explicitly asked Lumi to create/export/save a
   * local deliverable. This only relaxes medium-risk local file generation tools;
   * high-risk actions and already-confirm-level tools keep their confirmation gate.
   */
  allowLocalFileWrites?: boolean;
  /** Human-readable reason recorded when allowLocalFileWrites is set. */
  localWriteIntentReason?: string;
  /**
   * True for foreground, user-present execution surfaces where Lumi can perform
   * ordinary social/content commits (messages, comments, non-commercial posts)
   * without a separate confirmation popup. High-consequence actions still gate.
   */
  supervisedExternalCommits?: boolean;
  /** Personality's tool policy for security level resolution */
  toolPolicy?: import('../personality/types').ToolPolicy;
  /** Returns true if the task has been cancelled — checked between tool iterations */
  isCancelled?: () => boolean;
  /** Progress callback for long-running tools (computer_use) — reports each step */
  onProgress?: (step: string) => void;
  /** Lifecycle callback fired immediately before an LLM-selected tool begins. */
  onToolStart?: (call: { id?: string; name: string; arguments: Record<string, any> }) => void;
  /** Fired only after policy/confirmation checks, immediately before an adapter handler starts. */
  onAdapterStart?: (call: { name: string; attempt: number }) => void | Promise<void>;
  /** LLM provider getters for tools that need to call vision/text models internally */
  llmGetters?: {
    getDeepSeek: () => any;
    getGemini: () => any;
    getOpenAI?: () => any;
    getAnthropic?: () => any;
    getQwen?: () => any;
    getArk?: () => any;
    getOllama?: () => any;
    getLmStudio?: () => any;
    getXiaomi?: () => any;
    getKimi?: () => any;
    getGlm?: () => any;
    getRelay?: () => any;
  };
  /** True when the tool is being used by background autonomous work. */
  autonomous?: boolean;
  /** Surface that initiated the tool call, such as chat, voice, runtime-log, meeting, or mcp. */
  source?: string;
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, any>;
  handler: (args: Record<string, any>, context?: ToolContext) => Promise<string>;
  /**
   * Read-only reconciliation for a timed-out external commit. It must query
   * the original provider/target with the same idempotency key and must never
   * repeat the mutation. Return a verified normal tool result or null when the
   * outcome remains unknown.
   */
  reconcileExternalCommit?: (
    args: Record<string, any>,
    context: ToolContext | undefined,
    idempotencyKey: string,
  ) => Promise<string | null>;
  permission: ToolPermission;
  /** Security level: safe = auto-execute, confirm = ask user, forbidden = never execute */
  securityLevel: SecurityLevel;
  /** Localized discovery vocabulary; interpreted generically by ToolRegistry. */
  routingHints?: string[];
  /** Canonical capability metadata used by the runtime manifest. */
  capability?: ToolCapabilityMetadata;
  /**
   * Machine-readable evidence produced by a successful invocation. This lets
   * the execution ledger reason about capabilities instead of hard-coding
   * every possible user sentence.
   */
  evidence?: {
    capability: string;
    operation: 'observe' | 'test' | 'mutate' | 'create' | 'communicate';
    assurance: 'declared' | 'observed' | 'measured' | 'verified';
    /**
     * Argument that identifies one member of a tool's natural scope. When its
     * JSON schema contains an enum, the generic planner can preserve an
     * explicit "all/every/remaining" request without knowing the domain.
     */
    subjectArgument?: string;
    limitations?: string[];
  };
}

export interface ParsedToolCall {
  id: string;
  name: string;
  arguments: Record<string, any>;
}

export interface LLMUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface NormalizedLLMResponse {
  text: string | null;
  toolCalls: ParsedToolCall[] | null;
  reasoningContent?: string | null;
  usage?: LLMUsage;
  /** The provider produced usable output but stopped delivering stream frames before a terminal frame. */
  streamIncomplete?: boolean;
  /** Exact model route used for this call, including explicit fallback evidence. */
  routing?: ModelRoutingTrace;
}

export interface ToolExecutionRecord {
  id?: string;
  taskId?: string;
  turnId?: string;
  requestId?: string;
  idempotencyKey?: string;
  name: string;
  arguments: Record<string, any>;
  result: string;
  /** Machine-readable handler receipt, separated from user/model-facing content. */
  receipt?: unknown;
  /** True only when the canonical registry crossed the adapter invocation boundary. */
  adapterStarted?: boolean;
  error?: string;
  /** Evidence metadata copied from the invoked tool definition. */
  evidence?: {
    capability: string;
    operation: 'observe' | 'test' | 'mutate' | 'create' | 'communicate';
    assurance: 'declared' | 'observed' | 'measured' | 'verified';
    scope: string[];
    limitations?: string[];
  };
  /** Capability contract snapshot used by the executor for this exact call. */
  capability?: {
    capabilityId: string;
    lane: CapabilityLane;
    operation: CapabilityOperation;
    risk: CapabilityRisk;
    sideEffects: CapabilitySideEffect[];
    verification: CapabilityVerification;
    reconciliation?: CapabilityReconciliationContract;
  };
  /** Terminal verification is distinct from handler return/success. */
  terminalVerification?: {
    status: 'verified' | 'unverified' | 'failed';
    strategy: CapabilityVerification['strategy'];
    reason: string;
  };
  /** Uniform terminal projection attached by the canonical executor. */
  envelope?: ToolExecutionEnvelope;
}

export type ToolExecutionEnvelopeStatus =
  | 'verified_success'
  | 'failed'
  | 'timeout'
  | 'forbidden'
  | 'waiting_confirmation'
  | 'unknown_outcome'
  | 'target_mismatch';

/** Canonical result projected from every legacy/new tool record. */
export interface ToolExecutionEnvelope<T = unknown> {
  version: 1;
  status: ToolExecutionEnvelopeStatus;
  toolName: string;
  taskId: string;
  turnId: string;
  requestId: string;
  idempotencyKey: string;
  targetIdentity: string;
  startedAt?: string;
  completedAt: string;
  durationMs?: number;
  result?: T;
  error?: string;
  verification: {
    status: 'verified' | 'unverified' | 'failed';
    reason: string;
  };
}
