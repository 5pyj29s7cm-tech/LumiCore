import type { ToolExecutionRecord } from "../../tools/types";

// A bounded target-evidence window, independent of the model prompt window.
export const TASK_TARGET_HISTORY_LIMIT = 80;

export type TaskTargetAnchorStatus = 'unresolved' | 'candidate' | 'confirmed' | 'rejected';

export type TaskTargetAnchorSource =
  | 'durable_state'
  | 'tool_receipt'
  | 'user_correction'
  | 'active_window'
  | 'running_window'
  | 'document_interface'
  | 'unknown';

export interface TaskTargetAnchorV1 {
  label: string;
  application: string;
  window: string;
  object: string;
  path: string;
  location: string;
  status: TaskTargetAnchorStatus;
  source: TaskTargetAnchorSource;
}

/** A target resolved from server-owned conversation state, never client history. */
export interface AcceptedTaskTarget {
  target: TaskTargetAnchorV1;
  source: 'current_turn' | 'prior_user_message' | 'prior_tool_receipt' | 'task';
  sourceId: string;
}

export interface TaskTargetEvidenceRecord {
  capability?: ToolExecutionRecord['capability'];
  requestId?: string;
  name?: string;
  arguments?: Record<string, unknown>;
  result?: unknown;
  receipt?: unknown;
  error?: string;
  outcome?: 'success' | 'partial' | 'failure';
  terminalVerification?: { status?: string };
}

export interface TaskTargetAnchorProjectionV1 {
  target: TaskTargetAnchorV1;
  allowedSearchRoots: string[];
  /** A trusted foreground or unique background authoring window matches the anchored object. */
  windowVerified: boolean;
  /** The anchored object has one concrete filesystem path. */
  pathResolved: boolean;
  analysisReady: boolean;
  nextAction: 'analyze' | 'inspect_active_document' | 'search_bounded_roots' | 'clarify_target';
  clarification: string;
  ignoredCandidates: string[];
}

export interface BuildTaskTargetAnchorInput {
  taskText: string;
  applicationHint?: string;
  sourcePaths?: string[];
  previousTarget?: Partial<TaskTargetAnchorV1> | null;
  evidence?: TaskTargetEvidenceRecord[];
  rejectedTargets?: string[];
}

export interface TaskTargetToolCallGuardResult {
  allowed: boolean;
  reason: string;
  /** Server-owned arguments completed from one exact trusted task anchor. */
  normalizedArguments?: Record<string, unknown>;
  code?:
    | 'target_unresolved'
    | 'active_document_required'
    | 'search_scope_required'
    | 'search_scope_forbidden'
    | 'runtime_candidate_forbidden'
    | 'target_mismatch'
    | 'rejected_target'
    | 'unstructured_file_access_forbidden';
  status?: 'blocked';
  clarification?: {
    required: true;
    question: string;
  };
  anchor?: TaskTargetAnchorProjectionV1;
}

export interface CanonicalPathValue {
  flavor: 'win32' | 'posix';
  normalized: string;
  identity: string;
  absolute: boolean;
}

export interface EvidenceCandidate extends TaskTargetAnchorV1 {
  kind: 'active_window' | 'running_window' | 'document_interface' | 'tool_receipt' | 'discovery';
}

export type SupportedAuthoringApplication = 'WPS' | 'Microsoft Word' | 'Microsoft Excel' | 'Microsoft PowerPoint';
