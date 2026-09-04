import {
  CapabilityAdapterContract,
  CapabilityLane,
  CapabilityManifestEntry,
  CapabilityMode,
  CapabilityOperation,
  CapabilityRisk,
  CapabilitySideEffect,
  CapabilityTrust,
  CapabilityVerification,
  ToolDefinition,
  ToolExecutionRecord,
  ToolPermission,
  SecurityLevel,
  ToolContext,
} from './types';
import { ToolPolicy } from '../personality/types';
import { evaluateActionConstitution } from './action_constitution';
import {
  inferCapabilityFamily,
  inferCapabilityLane,
  inferCapabilityOperation,
  projectToolDeclarationForRouting,
  type CapabilityRoutingProjection,
} from './capability_projection';
import crypto from 'node:crypto';
import { getJwtSecret } from '../config/local_identity';
import { beginToolMetric, recordToolRetry } from '../runtime/tool_metrics';
import {
  claimExternalCommitAttempt,
  settleExternalCommitAttempt,
} from './external_commit_journal';
import {
  adapterFailureIsTransient,
  beforeAdapterExecution,
  cancelAdapterExecutionPermit,
  getAdapterRetryPolicy,
  recordAdapterExecutionFailure,
  recordAdapterExecutionSuccess,
} from './adapter_resilience';
import { readDB } from '../../db_layer';
import {
  isRemoteRestrictedExecution,
  isRemoteRestrictedToolAllowed,
  restrictToolPolicyForExecutionBoundary,
} from './remote_policy';
import {
  brandToolLifecyclePersistenceFailure,
  isToolLifecyclePersistenceFailure,
} from './lifecycle_persistence_error';
import { hasAutonomousHostAuthority } from './host_execution_authority';

export {
  inferCapabilityFamily,
  inferCapabilityLane,
  inferCapabilityOperation,
  projectToolDeclarationForRouting,
};
export type { CapabilityRoutingProjection };

export type EffectiveSecurity = { level: SecurityLevel; reason: string };

type ExternalCommitAttempt = {
  state: 'preparing' | 'running' | 'verified' | 'unknown';
  ready?: Promise<void>;
  promise?: Promise<string>;
  result?: string;
  expiresAt: number;
};

const externalCommitAttempts = new Map<string, ExternalCommitAttempt>();

type SideEffectAttempt = {
  state: 'running' | 'verified' | 'unknown';
  inputDigest: string;
  promise?: Promise<string>;
  result?: string;
  expiresAt: number;
};

// Non-external mutations do not have the durable provider journal, but an
// explicit caller idempotency key still owns an in-process single-flight fence.
// This prevents timeout/cancellation from creating an overlapping resend.
const sideEffectAttempts = new Map<string, SideEffectAttempt>();

type PermissionExecutionContext = ToolContext & {
  authenticated?: boolean;
  authRole?: string;
  systemExecution?: boolean;
  trustedServiceExecution?: boolean;
};

function isAnonymousToolIdentity(userId: unknown): boolean {
  const normalized = String(userId || '').trim().toLowerCase();
  return !normalized || normalized === 'anonymous' || normalized === 'guest';
}

function isRegisteredAdmin(userId: string): boolean {
  try {
    const user = (readDB().users || []).find((candidate: any) => candidate?.uid === userId);
    return user?.role === 'admin';
  } catch {
    return false;
  }
}

function isExternallySourcedToolContext(context?: PermissionExecutionContext): boolean {
  if (!context) return false;
  return context.executionBoundary !== undefined
    || /^(?:rest_chat|mcp_|chat(?:_|$)|task(?:_|$)|voice(?:_|$)|meeting-analyze|legal-)/i.test(
      String(context.source || ''),
    );
}

type ToolVisibilityContext = Pick<ToolContext, 'userId' | 'domain' | 'orgId' | 'autonomous' | 'source'>;

function isToolVisibleToContext(tool: ToolDefinition, context?: ToolVisibilityContext): boolean {
  const ownerUserId = String(tool.internalVisibility?.ownerUserId || '').trim();
  if (!ownerUserId) return true;
  // Context-free inventory calls are retained for trusted internal audits.
  if (!context) return true;
  if (String(context.userId || '').trim() !== ownerUserId) return false;
  if (tool.internalVisibility?.personalOnly && (context.domain === 'work' || String(context.orgId || '').trim())) {
    return false;
  }
  return true;
}

function isAutonomousVisibilityContext(context?: ToolVisibilityContext): boolean {
  return context?.autonomous === true || /(?:^|[_-])(?:autonomy|autonomous|scheduler)(?:$|[_-])/i.test(String(context?.source || ''));
}

function isToolVisibleToModelContext(tool: ToolDefinition, context?: ToolVisibilityContext): boolean {
  if (!isToolVisibleToContext(tool, context)) return false;
  // Context-free inventory calls remain available to trusted internal audits.
  if (!context) return true;
  const access = tool.internalVisibility?.modelAccess;
  if (access === 'hidden') return false;
  if (!isAutonomousVisibilityContext(context)) return true;
  if (access === 'foreground') return false;
  if (access === 'automatic_candidate') {
    try { return tool.internalVisibility?.automaticReady?.() === true; } catch { return false; }
  }
  return true;
}

function assertToolPermission(tool: ToolDefinition, context?: ToolContext): void {
  const permissionContext = context as PermissionExecutionContext | undefined;
  const userId = String(permissionContext?.userId || '').trim();

  if (!isToolVisibleToContext(tool, permissionContext)) {
    throw new Error(`Tool "${tool.name}" is unavailable outside its owning user scope.`);
  }
  if (permissionContext && tool.internalVisibility?.modelAccess === 'hidden') {
    if (String(permissionContext.source || '') !== 'external-capability-icon') {
      throw new Error(`Tool "${tool.name}" is a manual external capability and requires its reviewed host entry point.`);
    }
  }
  if (
    permissionContext
    && tool.internalVisibility?.modelAccess === 'foreground'
    && isAutonomousVisibilityContext(permissionContext)
  ) {
    throw new Error(`Tool "${tool.name}" is assisted-only and unavailable to autonomous execution.`);
  }
  if (
    permissionContext
    && tool.internalVisibility?.modelAccess === 'automatic_candidate'
    && isAutonomousVisibilityContext(permissionContext)
  ) {
    let ready = false;
    try { ready = tool.internalVisibility.automaticReady?.() === true; } catch { ready = false; }
    if (!ready) {
      throw new Error(`Tool "${tool.name}" has not earned automatic execution through host-verified acceptance receipts.`);
    }
    if (!hasAutonomousHostAuthority(permissionContext, String(tool.internalVisibility.ownerUserId || ''))) {
      throw new Error(`Tool "${tool.name}" requires host-owned autonomous task authority.`);
    }
  }

  // This check intentionally precedes `public` permission. A host/process tool
  // accidentally registered as public must still never cross a remote model
  // boundary. Model declaration filtering is only the first line of defence.
  if (isRemoteRestrictedExecution(permissionContext) && !isRemoteRestrictedToolAllowed(tool.name)) {
    throw new Error(`Tool "${tool.name}" is unavailable on remote execution surfaces.`);
  }
  if (
    isRemoteRestrictedExecution(permissionContext)
    && permissionContext?.authenticated !== true
    && permissionContext?.trustedServiceExecution !== true
  ) {
    throw new Error(`Tool "${tool.name}" requires an authenticated user.`);
  }

  if (tool.permission === 'public') return;

  if (tool.permission === 'user') {
    if (
      tool.internalVisibility?.modelAccess === 'automatic_candidate'
      && hasAutonomousHostAuthority(permissionContext, String(tool.internalVisibility.ownerUserId || ''))
    ) return;
    if (
      permissionContext?.authenticated === true
      && !isAnonymousToolIdentity(userId)
    ) return;
    if (permissionContext?.systemExecution === true || permissionContext?.trustedServiceExecution === true) return;
    // Context-free registry calls are trusted in-process invocations retained
    // for backwards compatibility. Explicit transport boundaries and sources
    // with a localExecution marker are external and therefore fail closed.
    if (!permissionContext || !String(permissionContext.source || '').trim()) return;
    const externallySourced = isExternallySourcedToolContext(permissionContext);
    if (!externallySourced && !isAnonymousToolIdentity(userId)) return;
    throw new Error(`Tool "${tool.name}" requires an authenticated user.`);
  }

  if (tool.permission === 'admin') {
    const verifiedContextAdmin = permissionContext?.authenticated === true
      && permissionContext.authRole === 'admin'
      && !isAnonymousToolIdentity(userId);
    const registeredInternalAdmin = !isExternallySourcedToolContext(permissionContext)
      && !isAnonymousToolIdentity(userId)
      && isRegisteredAdmin(userId);
    if (verifiedContextAdmin || registeredInternalAdmin) return;
    throw new Error(`Tool "${tool.name}" requires administrator permission.`);
  }

  if (tool.permission === 'system' && permissionContext?.systemExecution === true) return;
  throw new Error(`Tool "${tool.name}" requires trusted system permission.`);
}

/** Test-only process restart simulation; durable journal rows are preserved. */
export function resetExternalCommitRuntimeCacheForTests(): void {
  externalCommitAttempts.clear();
  sideEffectAttempts.clear();
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value as Record<string, unknown>).sort().map(key => [
    key,
    stableValue((value as Record<string, unknown>)[key]),
  ]));
}

function executionIdempotencyKey(name: string, args: Record<string, any>, context?: ToolContext): string {
  if (context?.idempotencyKey) return context.idempotencyKey;
  return crypto.createHash('sha256').update(JSON.stringify(stableValue({
    userId: context?.userId || '',
    taskId: context?.taskId || '',
    actionIntent: context?.actionIntent || '',
    name,
    args,
  }))).digest('hex');
}

export function externalCommitInputDigest(name: string, args: Record<string, any>): string {
  return crypto.createHmac('sha256', getJwtSecret())
    .update('lumi.external-commit.input.v1\0')
    .update(JSON.stringify(stableValue({ name, args })))
    .digest('hex');
}

const EXTERNAL_REPLAY_SECRET_KEY_RE = /password|passphrase|passkey|secret|token|api.?key|credential|authorization|cookie|otp|captcha|verification.?code|pin/i;
const EXTERNAL_REPLAY_SECRET_VALUE_RE = /(?:bearer\s+[a-z0-9._~+/=-]{8,}|\bsk-[a-z0-9_-]{12,}\b)/i;

function sanitizeExternalCommitReplayValue(value: unknown, depth = 0): unknown {
  if (depth > 4) return '[nested data omitted]';
  if (typeof value === 'string') {
    if (EXTERNAL_REPLAY_SECRET_VALUE_RE.test(value)) return '[redacted]';
    return value.slice(0, 500);
  }
  if (Array.isArray(value)) return value.slice(0, 30).map(item => sanitizeExternalCommitReplayValue(item, depth + 1));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .slice(0, 40)
      .map(([key, item]) => [
        key,
        EXTERNAL_REPLAY_SECRET_KEY_RE.test(key)
          ? '[redacted]'
          : sanitizeExternalCommitReplayValue(item, depth + 1),
      ]),
  );
}

function persistedExternalCommitReplay(result: string, idempotencyKey: string): string {
  const safeKeys = /^(?:sent|submitted|published|verified|verificationStatus|verificationMethod|verificationConfidence|verificationReason|providerReceipt|messageId|submissionId|publicationId|paymentId|signatureId|status|targetMatched|conversationVerified|contactVerified|sendAttempted|sessionId|taskId|questionDigest|counts|routePriority|reconciled|completedAt|timestamp)$/i;
  try {
    const parsed = JSON.parse(result || '{}');
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const safe = Object.fromEntries(
        Object.entries(parsed)
          .filter(([key]) => safeKeys.test(key))
          .slice(0, 40)
          .map(([key, value]) => [key, sanitizeExternalCommitReplayValue(value)]),
      );
      const replay = JSON.stringify({
        ...safe,
        verified: true,
        verificationStatus: 'verified',
        deduplicated: true,
        idempotencyKey,
      });
      if (replay.length <= 8_192) return replay;
      return JSON.stringify({
        verified: true,
        verificationStatus: 'verified',
        deduplicated: true,
        receiptTruncated: true,
        idempotencyKey,
      });
    }
  } catch {}
  return JSON.stringify({
    verified: true,
    verificationStatus: 'verified',
    deduplicated: true,
    idempotencyKey,
    resultDigest: crypto.createHash('sha256').update(String(result || '')).digest('hex'),
  });
}

function externalCommitUnknownError(name: string, detail: string): Error {
  const error = new Error(
    `Tool "${name}" external commit outcome is unknown and automatic resend was stopped. ${detail}`.trim(),
  ) as Error & { externalCommitUnknown?: boolean };
  error.externalCommitUnknown = true;
  return error;
}

function localSideEffectFenceKey(name: string, context?: ToolContext): string {
  const idempotencyKey = String(context?.idempotencyKey || '').trim();
  if (!idempotencyKey) return '';
  const userId = String(context?.userId || '').trim() || 'anonymous';
  const domain = String(context?.domain || '').trim() || 'personal';
  const orgId = String(context?.orgId || '').trim();
  return JSON.stringify([name, userId, domain, orgId, idempotencyKey]);
}

export class ToolHandlerSettledAfterTimeoutError extends Error {
  readonly toolExecutionTimedOut = true;
  readonly handlerSettlement = 'rejected' as const;
  readonly cause: unknown;

  constructor(name: string, timeoutMs: number, cause: unknown) {
    super(
      `Tool "${name}" timed out after ${timeoutMs / 1000}s; `
      + 'the original handler later settled as rejected.',
    );
    this.name = 'ToolHandlerSettledAfterTimeoutError';
    this.cause = cause;
  }
}

function externalResultIsVerified(result: string): boolean {
  try {
    const payload = JSON.parse(result || '{}');
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return false;
    if (payload.sent === false || payload.submitted === false || payload.published === false) return false;
    if (Object.prototype.hasOwnProperty.call(payload, 'verificationStatus')) {
      return payload.verificationStatus === 'verified';
    }
    if (Object.prototype.hasOwnProperty.call(payload, 'verified')) {
      return payload.verified === true;
    }
  } catch {
    // External side effects must never become durable successes from prose or
    // malformed provider output. Only an explicit verified receipt may close
    // the idempotency fence; every other result remains unknown and blocks a
    // resend until host-owned reconciliation can prove the outcome.
  }
  return false;
}

/**
 * Canonical tool-name visibility rule shared by model declarations, routed
 * workflows and the executor. Security level/confirmation is resolved later;
 * this function answers only whether the name exists in the effective policy.
 */
export function isToolNameAllowedByPolicy(toolName: string, policy?: ToolPolicy): boolean {
  if (!policy) return true;
  const forbidden = policy.forbiddenTools || [];
  if (forbidden.includes('*') || forbidden.includes(toolName)) return false;
  const allowed = policy.allowedTools || [];
  return allowed.includes('*') || allowed.includes(toolName);
}

export function getToolExecutionTimeoutMs(name: string): number {
  if (name === 'computer_use') return 10 * 60_000;
  if (name === 'generate_video') return 15 * 60_000;
  if (name === 'generate_image' || name === 'generate_image_dalle' || name === 'ai_edit_image') return 3 * 60_000;
  if (/^model_configuration_(?:update|test)$/i.test(name)) return 2 * 60_000;
  if (name === 'transcribe_audio_to_text_file') return 60 * 60_000;
  if (/^mcp_cad-drafting_autocad_playback_file$/i.test(name)) return 30 * 60_000;
  if (name === 'cad_draw_floorplan_in_autocad') return 45 * 60_000;
  if (/^cad_prepare_autocad_operations$/i.test(name)) return 5 * 60_000;
  if (/^(web_login_|url_fetch_logged_in)/i.test(name)) return 5 * 60_000;
  if (name === 'legal_refresh_authoritative_sources') return 3 * 60_000;
  if (name === 'self_improvement_stage_patch' || name === 'self_improvement_activate') return 60 * 60_000;
  if (/^(wechat_|desktop_ai_|external_ai_)/i.test(name)) return 3 * 60_000;
  if (/^(work_takeover_|capability_gap_autofix|generate_skill|install_skill)/i.test(name)) return 10 * 60_000;
  if (/^desktop_/i.test(name)) return 90_000;
  if (/^floorplan_extract_geometry$/i.test(name)) return 10 * 60_000;
  if (/^ocr_/i.test(name) || name === 'cad_generate_dxf') return 90_000;
  return 30_000;
}

function normalizeJsonSchema(params: Record<string, any>): Record<string, any> {
  if (!params || Object.keys(params).length === 0) {
    return { type: 'object', properties: {} };
  }

  // Already standard JSON Schema format
  if (params.type === 'object' && params.properties) {
    return params;
  }

  // Flat format (used by MCP tools): { key: { type, description, required } }
  // Convert to standard JSON Schema: { type: 'object', properties: {...}, required: [...] }
  const properties: Record<string, any> = {};
  const required: string[] = [];

  for (const [key, def] of Object.entries(params)) {
    const val = def as Record<string, any>;
    const propDef: Record<string, any> = {};
    if (val.type) propDef.type = val.type;
    if (val.description) propDef.description = val.description;
    if (val.enum) propDef.enum = val.enum;
    properties[key] = propDef;
    if (val.required) required.push(key);
  }

  const schema: Record<string, any> = { type: 'object', properties };
  if (required.length > 0) schema.required = required;
  return schema;
}

function defaultCapabilityModes(): CapabilityMode[] {
  return ['assistant', 'autonomous'];
}

function inferCapabilitySideEffects(
  toolName: string,
  lane: CapabilityLane,
  operation: CapabilityOperation,
  securityLevel: SecurityLevel,
): CapabilitySideEffect[] {
  if (operation === 'observe' || operation === 'test') return [];
  if (operation === 'communicate') {
    return [{
      type: 'external_communication',
      scope: lane,
      reversible: false,
    }];
  }
  if (/\b(?:install|upgrade|package)\b/i.test(toolName)) {
    return [{
      type: 'installation',
      scope: lane,
      reversible: true,
    }];
  }
  if (/\b(?:run_command|exec|code_execution|python_exec)\b/i.test(toolName)) {
    return [{
      type: 'process_execution',
      scope: lane,
      reversible: false,
    }];
  }
  if (lane === 'desktop') {
    return [{
      type: 'desktop_control',
      scope: 'active desktop session',
      reversible: true,
    }];
  }
  if (lane === 'files' || lane === 'office' || lane === 'cad' || lane === 'media') {
    return [{
      type: 'local_write',
      scope: lane,
      reversible: operation === 'create',
    }];
  }
  if (lane === 'web' || lane === 'messaging' || lane === 'industry') {
    return [{
      type: 'external_state_change',
      scope: lane,
      reversible: false,
    }];
  }
  if (operation === 'unknown' && securityLevel !== 'safe') {
    return [{
      type: 'external_state_change',
      scope: 'unknown until provider metadata is supplied',
      reversible: false,
    }];
  }
  return operation === 'mutate' || operation === 'create'
    ? [{
        type: 'local_write',
        scope: lane,
        reversible: operation === 'create',
      }]
    : [];
}

function inferCapabilityRisk(
  operation: CapabilityOperation,
  securityLevel: SecurityLevel,
  sideEffects: CapabilitySideEffect[],
): CapabilityRisk {
  if (securityLevel === 'forbidden') return 'critical';
  if (securityLevel === 'confirm') return 'high';
  if (operation === 'observe' || operation === 'test') return 'low';
  if (sideEffects.some(effect => !effect.reversible)) return 'high';
  if (sideEffects.length > 0) return 'medium';
  return operation === 'unknown' ? 'medium' : 'none';
}

function inferCapabilityVerification(
  lane: CapabilityLane,
  operation: CapabilityOperation,
  assurance: CapabilityManifestEntry['assurance'],
): CapabilityVerification {
  if (operation === 'observe' || operation === 'test') {
    return {
      strategy: assurance === 'measured' ? 'measured' : 'terminal_receipt',
      required: true,
      // Legacy/read-only adapters legitimately return arrays or native state
      // objects without manufacturing a `status` property. A non-empty
      // terminal receipt is sufficient for inferred observation contracts;
      // tools needing stronger proof declare requiredFields explicitly.
      requiredFields: [],
      successSignals: ['terminal tool receipt'],
      limitations: assurance === 'none'
        ? ['The receipt proves observation returned, not that the observed external state is complete.']
        : [],
    };
  }
  if (operation === 'communicate') {
    return {
      strategy: 'provider_ack',
      required: true,
      // Inferred adapters may return sent/submitted/published=true plus a
      // provider marker without manufacturing a synthetic status field. The
      // provider_ack strategy validates that acknowledgement directly;
      // explicit tool contracts can still require an exact status value.
      requiredFields: [],
      successSignals: ['provider or target acknowledgement'],
      limitations: ['Draft creation, clipboard writes, and submit-button presses are not delivery acknowledgement.'],
    };
  }
  if (operation === 'create' && ['files', 'office', 'cad', 'media'].includes(lane)) {
    return {
      strategy: 'artifact',
      required: true,
      requiredFields: ['status'],
      successSignals: ['artifact exists and matches the requested output'],
      limitations: ['A path alone is not content or application-state verification.'],
    };
  }
  if (lane === 'desktop') {
    return {
      strategy: 'state_diff',
      required: true,
      requiredFields: ['status'],
      successSignals: ['post-action native state or visual evidence differs as intended'],
      limitations: ['An input event alone is not proof that the target application accepted it.'],
    };
  }
  return {
    strategy: 'terminal_receipt',
    required: true,
    requiredFields: ['status'],
    successSignals: ['terminal tool receipt'],
    limitations: operation === 'unknown'
      ? ['Provider did not declare semantic side effects; completion claims must remain conservative.']
      : [],
  };
}

function inferCapabilityTrust(source: CapabilityManifestEntry['source']): CapabilityTrust {
  if (source === 'builtin') return 'core';
  if (source === 'adapter') return 'official';
  if (source === 'skill') return 'user-reviewed';
  return 'third-party';
}

function defaultAdapterContract(
  lane: CapabilityLane,
  operation: CapabilityOperation,
): CapabilityAdapterContract | undefined {
  if (lane !== 'desktop') return undefined;
  return {
    id: 'desktop.native',
    operations: [operation],
    implementations: {
      windows: 'windows-native-desktop',
      macos: 'macos-native-desktop',
    },
  };
}

export class ToolRegistry {
  private tools: Map<string, ToolDefinition> = new Map();

  register(tool: ToolDefinition): boolean {
    if (this.tools.has(tool.name)) {
      console.warn(`[ToolRegistry] "${tool.name}" already registered — skipping duplicate`);
      return false;
    }
    this.tools.set(tool.name, tool);
    return true;
  }

  get(name: string): ToolDefinition | undefined {
    return this.tools.get(name);
  }

  /** Bind immutable host arguments before the canonical execution pipeline. */
  prepareExecution(
    name: string,
    args: Record<string, any>,
    context?: ToolContext,
  ): { arguments: Record<string, any>; semanticToolName: string } {
    const tool = this.get(name);
    if (!tool) throw new Error(`Tool "${name}" not found in registry`);
    assertToolPermission(tool, context);
    const bound = tool.serverOwnedArgumentBinder
      ? tool.serverOwnedArgumentBinder(structuredClone(args || {}), context)
      : args || {};
    if (!bound || typeof bound !== 'object' || Array.isArray(bound)) {
      throw new Error(`Tool "${name}" produced invalid server-owned arguments.`);
    }
    return {
      arguments: bound,
      semanticToolName: String(tool.semanticToolName || name),
    };
  }

  getEvidenceDescriptor(name: string): ToolDefinition['evidence'] | undefined {
    return this.tools.get(name)?.evidence;
  }

  getCapabilityManifestEntry(
    name: string,
    policy?: ToolPolicy,
    context?: ToolVisibilityContext,
  ): CapabilityManifestEntry | undefined {
    const tool = this.tools.get(name);
    return tool && isToolVisibleToContext(tool, context)
      ? this.buildCapabilityManifestEntry(tool, policy)
      : undefined;
  }

  /** Build the evidence envelope attached to a terminal tool receipt. */
  buildEvidenceRecord(
    name: string,
    args: Record<string, any>,
  ): ToolExecutionRecord['evidence'] | undefined {
    const tool = this.get(name);
    if (!tool) return undefined;
    const manifestEvidence = this.buildCapabilityManifestEntry(tool).evidence;
    const descriptor = tool.evidence || manifestEvidence;
    if (!descriptor) return undefined;
    const schema = normalizeJsonSchema(tool.parameters || {});
    const subjectArgument = tool.evidence?.subjectArgument;
    const declaredScope = subjectArgument
      ? schema.properties?.[subjectArgument]?.enum
      : undefined;
    const selected = subjectArgument ? args?.[subjectArgument] : undefined;
    const scope = selected !== undefined && selected !== null && String(selected).trim()
      ? [String(selected)]
      : Array.isArray(declaredScope)
        ? declaredScope.map(value => String(value))
        : [];
    return {
      capability: descriptor.capability,
      operation: descriptor.operation,
      assurance: descriptor.assurance,
      scope,
      ...(descriptor.limitations?.length ? { limitations: [...descriptor.limitations] } : {}),
    };
  }

  /**
   * Generic lexical capability discovery. Domain vocabulary lives in each
   * tool description; LumiCore does not need a branch per tool.
   */
  findRelevant(text: string, options?: {
    limit?: number;
    evidenceOperations?: Array<NonNullable<ToolDefinition['evidence']>['operation']>;
    context?: ToolVisibilityContext;
  }): ToolDefinition[] {
    const query = String(text || '').toLowerCase().trim();
    if (!query) return [];
    // File-system path segments describe where work lives, not what capability
    // the user requested. Without removing them first, a common path such as
    // D:\\work\\brief.txt spuriously matches every "workflow/work" tool.
    const semanticQuery = query.replace(/\b[a-z]:[\\/][^\s"'<>|]*/gi, ' ');
    const ascii = semanticQuery.match(/[a-z0-9_]{3,}/g) || [];
    const cjkRuns = query.match(/[\u3400-\u9fff]+/g) || [];
    const cjk: string[] = [];
    for (const run of cjkRuns) {
      for (let size = 2; size <= Math.min(4, run.length); size += 1) {
        for (let index = 0; index <= run.length - size; index += 1) {
          cjk.push(run.slice(index, index + size));
        }
      }
    }
    const tokens = Array.from(new Set([...ascii, ...cjk]));
    const allowedOperations = options?.evidenceOperations?.length
      ? new Set(options.evidenceOperations)
      : null;
    return this.list()
      .filter(tool => isToolVisibleToModelContext(tool, options?.context))
      .filter(tool => !allowedOperations || (tool.evidence && allowedOperations.has(tool.evidence.operation)))
      .map(tool => {
        const haystack = `${tool.name} ${tool.description} ${(tool.routingHints || []).join(' ')}`.toLowerCase();
        const haystackAsciiTokens = new Set(
          (haystack.match(/[a-z0-9_]{3,}/g) || []).flatMap(token => [token, ...token.split('_').filter(Boolean)]),
        );
        const score = tokens.reduce((total, token) => (
          total + ((/^[a-z0-9_]+$/i.test(token)
            ? haystackAsciiTokens.has(token)
            : haystack.includes(token))
            ? Math.min(4, token.length)
            : 0)
        ), 0);
        return { tool, score };
      })
      .filter(item => item.score >= 4)
      .sort((left, right) => right.score - left.score)
      .slice(0, Math.max(1, options?.limit || 8))
      .map(item => item.tool);
  }

  unregister(name: string): boolean {
    return this.tools.delete(name);
  }

  unregisterByPrefix(prefix: string): string[] {
    const removed: string[] = [];
    for (const [name] of this.tools) {
      if (name.startsWith(prefix)) {
        this.tools.delete(name);
        removed.push(name);
      }
    }
    if (removed.length > 0) {
      console.log(`[ToolRegistry] Unregistered ${removed.length} tools with prefix "${prefix}"`);
    }
    return removed;
  }

  list(filterPermission?: ToolPermission): ToolDefinition[] {
    const all = Array.from(this.tools.values());
    if (!filterPermission) return all;
    return all.filter(t => t.permission === filterPermission || t.permission === 'public');
  }

  private buildCapabilityManifestEntry(
    tool: ToolDefinition,
    policy?: ToolPolicy,
  ): CapabilityManifestEntry {
    const effective = this.resolveSecurity(tool.name, policy);
    const source = tool.capability?.source || 'builtin';
    const provider = tool.capability?.provider;
    const family = String(tool.capability?.family || provider || inferCapabilityFamily(tool.name));
    const operation: CapabilityOperation = tool.evidence?.operation
      || tool.capability?.operation
      || inferCapabilityOperation(tool.name);
    const lane = tool.capability?.lane || inferCapabilityLane(tool.name, family);
    const modes = Array.from(new Set(
      tool.capability?.modes?.length ? tool.capability.modes : defaultCapabilityModes(),
    ));
    const sideEffects = tool.capability?.sideEffects
      ? [...tool.capability.sideEffects]
      : inferCapabilitySideEffects(tool.name, lane, operation, tool.securityLevel);
    const risk = tool.capability?.risk
      || inferCapabilityRisk(operation, tool.securityLevel, sideEffects);
    const capabilityId = tool.capability?.id || tool.evidence?.capability || tool.name;
    const assurance = tool.evidence?.assurance || 'none';
    const conservativeEvidenceOperation = operation === 'unknown' ? 'mutate' : operation;
    const evidence = tool.evidence
      ? {
          capability: tool.evidence.capability,
          operation: tool.evidence.operation,
            assurance: tool.evidence.assurance,
            limitations: [...(tool.evidence.limitations || [])],
            declarationSource: 'tool_definition' as const,
            explicit: true,
          }
      : sideEffects.length > 0
        ? {
            capability: capabilityId,
            operation: conservativeEvidenceOperation as Exclude<CapabilityOperation, 'unknown'>,
            assurance: 'declared' as const,
            limitations: [
              'The terminal receipt proves the handler returned; task-level verification is still required.',
              ...(operation === 'unknown'
                ? ['The provider did not declare its semantic operation; it is treated conservatively as a mutation.']
                : []),
              ],
            declarationSource: 'manifest_policy' as const,
            explicit: false,
          }
        : null;
    const verification = tool.capability?.verification
      || inferCapabilityVerification(lane, operation, assurance);
    const provenance: CapabilityManifestEntry['provenance'] = {
      kind: tool.capability?.provenance?.kind || source,
      provider: tool.capability?.provenance?.provider || provider || source,
      trust: tool.capability?.provenance?.trust || inferCapabilityTrust(source),
    };
    const deprecated = tool.capability?.deprecated === true;
    const schema = normalizeJsonSchema(tool.parameters);
    const nameTerms = tool.name.split(/[_\-\s]+/).filter(Boolean);
    const routingTerms = Array.from(new Set([
      ...nameTerms,
      ...(tool.routingHints || []),
      ...(tool.capability?.tags || []),
    ].map(term => String(term).trim()).filter(Boolean)));

    return {
      toolName: tool.name,
      capabilityId,
      family,
      lane,
      source,
      provider,
      description: tool.description,
      permission: tool.permission,
      configuredSecurityLevel: tool.securityLevel,
      effectiveSecurityLevel: effective.level,
      effectiveSecurityReason: effective.reason,
      executable: effective.level !== 'forbidden' && !deprecated,
      requiresConfirmation: effective.level === 'confirm',
      operation,
      modes,
      risk,
      sideEffects,
      metadataSources: {
        operation: tool.evidence?.operation || tool.capability?.operation
          ? 'tool_definition'
          : 'manifest_policy',
        lane: tool.capability?.lane ? 'tool_definition' : 'manifest_policy',
        risk: tool.capability?.risk ? 'tool_definition' : 'manifest_policy',
        sideEffects: tool.capability?.sideEffects ? 'tool_definition' : 'manifest_policy',
        evidence: tool.evidence
          ? 'tool_definition'
          : sideEffects.length > 0
            ? 'manifest_policy'
            : 'not_required',
        verification: tool.capability?.verification ? 'tool_definition' : 'manifest_policy',
      },
      assurance,
      hasEvidenceContract: Boolean(evidence),
      evidence,
      verification,
      fallbacks: [...(tool.capability?.fallbacks || [])].sort((left, right) => left.order - right.order),
      provenance,
      trust: provenance.trust,
      deprecated,
      ...(tool.capability?.replacedBy ? { replacedBy: tool.capability.replacedBy } : {}),
      ...(tool.capability?.adapter || defaultAdapterContract(lane, operation)
        ? { adapter: tool.capability?.adapter || defaultAdapterContract(lane, operation) }
        : {}),
      ...(tool.capability?.reconciliation
        ? { reconciliation: {
            ...tool.capability.reconciliation,
            reconcilesCapabilityIds: [...tool.capability.reconciliation.reconcilesCapabilityIds],
            committedValues: [...tool.capability.reconciliation.committedValues],
            notCommittedValues: [...tool.capability.reconciliation.notCommittedValues],
          } }
        : {}),
      modeSecurity: { ...(tool.capability?.modeSecurity || {}) },
      domains: Array.from(new Set(
        tool.capability?.domains?.length ? tool.capability.domains : [family],
      )),
      intents: Array.from(new Set([
        ...(tool.capability?.intents || []),
        ...(tool.routingHints || []),
        ...(tool.capability?.tags || []),
      ].map(term => String(term).trim()).filter(Boolean))),
      routingTerms,
      prerequisites: Array.from(new Set(tool.capability?.prerequisites || [])),
      parameterNames: Object.keys(schema.properties || {}),
    };
  }

  /**
   * Authoritative runtime capability inventory. This is derived from the same
   * definitions and effective policy used by the executor.
   */
  getCapabilityManifest(
    policy?: ToolPolicy,
    options?: { executableOnly?: boolean; context?: ToolVisibilityContext },
  ): CapabilityManifestEntry[] {
    const entries = this.list()
      .filter(tool => isToolVisibleToModelContext(tool, options?.context))
      .map(tool => this.buildCapabilityManifestEntry(tool, policy));
    return options?.executableOnly ? entries.filter(entry => entry.executable) : entries;
  }

  getToolDeclarations(options?: { context?: ToolVisibilityContext }): Array<{
    type: 'function';
    function: { name: string; description: string; parameters: Record<string, any> };
  }> {
    return this.list().filter(tool => isToolVisibleToModelContext(tool, options?.context)).map(t => ({
      type: 'function' as const,
      function: {
        name: t.name,
        description: t.description,
        parameters: normalizeJsonSchema(t.parameters),
      },
    }));
  }

  /**
   * Policy-filtered declarations for models and planners. The executor uses
   * the same resolveSecurity() decision, so a forbidden tool cannot remain
   * visible to the model while failing only after selection.
   */
  getToolDeclarationsForPolicy(
    policy?: ToolPolicy,
    options?: {
      failClosedWithoutPolicy?: boolean;
      context?: ToolContext;
      /** Priority-ordered model projection; authorization is still `policy`. */
      visibleToolNames?: Iterable<string>;
    },
  ): ReturnType<ToolRegistry['getToolDeclarations']> {
    const effectivePolicy = options?.context?.executionBoundary === 'remote_restricted'
      ? restrictToolPolicyForExecutionBoundary(policy || {
          allowedTools: [],
          requireConfirmation: [],
          forbiddenTools: ['*'],
          maxIterations: 0,
        }, 'remote_restricted')
      : policy;
    if (!effectivePolicy && options?.failClosedWithoutPolicy) return [];
    const executable = new Set(
      this.getCapabilityManifest(effectivePolicy, { executableOnly: true, context: options?.context })
        .map(entry => entry.toolName),
    );
    const declarations = this.getToolDeclarations({ context: options?.context });
    if (options?.visibleToolNames) {
      const byName = new Map(declarations.map(declaration => [declaration.function.name, declaration]));
      const projected: ReturnType<ToolRegistry['getToolDeclarations']> = [];
      const seen = new Set<string>();
      for (const rawName of options.visibleToolNames) {
        const name = String(rawName || '').trim();
        if (!name || seen.has(name) || !executable.has(name)) continue;
        const declaration = byName.get(name);
        if (!declaration) continue;
        seen.add(name);
        projected.push(declaration);
      }
      return projected;
    }
    return declarations.filter(declaration => executable.has(declaration.function.name));
  }

  listForContext(
    context?: ToolVisibilityContext,
    filterPermission?: ToolPermission,
  ): ToolDefinition[] {
    return this.list(filterPermission).filter(tool => isToolVisibleToModelContext(tool, context));
  }

  /** Resolve effective security level for a tool given a personality's policy */
  resolveSecurity(toolName: string, policy?: ToolPolicy): EffectiveSecurity {
    const tool = this.get(toolName);
    const builtIn: SecurityLevel = tool?.securityLevel || 'confirm';
    const semanticToolName = String(tool?.semanticToolName || toolName);

    if (!policy) return { level: builtIn, reason: 'tool default' };

    // 1. forbiddenTools overrides everything
    if (
      policy.forbiddenTools?.includes('*')
      || policy.forbiddenTools?.includes(toolName)
      || (semanticToolName !== toolName && policy.forbiddenTools?.includes(semanticToolName))
    ) {
      return { level: 'forbidden', reason: 'personality forbiddenTools list' };
    }

    // 2. Explicit per-tool security override
    const proxyOverride = policy.securityOverrides?.[toolName];
    const semanticOverride = semanticToolName !== toolName
      ? policy.securityOverrides?.[semanticToolName]
      : undefined;
    const override = proxyOverride === 'forbidden' || semanticOverride === 'forbidden'
      ? 'forbidden'
      : proxyOverride === 'confirm' || semanticOverride === 'confirm'
        ? 'confirm'
        : proxyOverride || semanticOverride;
    if (override) {
      return { level: override, reason: 'personality security override' };
    }

    // 3. Legacy requireConfirmation promotes to confirm
    if (
      (policy.requireConfirmation.includes(toolName) || policy.requireConfirmation.includes(semanticToolName))
      && builtIn === 'safe'
    ) {
      return { level: 'confirm', reason: 'personality requireConfirmation list' };
    }

    // 4. allowedTools check — if '*' all allowed, otherwise specific list
    if (!isToolNameAllowedByPolicy(toolName, policy)) {
      return { level: 'forbidden', reason: 'not in allowedTools list' };
    }

    return { level: builtIn, reason: 'tool default' };
  }

  async execute(name: string, args: Record<string, any>, context?: ToolContext): Promise<string> {
    const finishMetric = beginToolMetric(name);
    const tool = this.get(name);
    if (!tool) {
      finishMetric('failed');
      throw new Error(`Tool "${name}" not found in registry`);
    }
    // Pin executable references at admission. Policy/manifest checks and the
    // adapter-start barrier may yield; later mutation of the registry object
    // must not swap the reviewed implementation for this execution.
    const pinnedHandler = tool.handler;
    const pinnedPreflight = tool.preflight;
    const pinnedReconcileExternalCommit = tool.reconcileExternalCommit;
    const pinnedLocalIdempotencyReplay = tool.localIdempotencyReplay || 'cached_result';
    const pinnedArgumentBinder = tool.serverOwnedArgumentBinder;
    const semanticToolName = String(tool.semanticToolName || name);

    try {
      assertToolPermission(tool, context);
    } catch (error) {
      finishMetric('forbidden');
      throw error;
    }

    let executionArgs = args || {};
    if (pinnedArgumentBinder) {
      try {
        executionArgs = pinnedArgumentBinder(structuredClone(executionArgs), context);
      } catch (error) {
        finishMetric('forbidden');
        throw error;
      }
    }

    // Resolve effective security level
    const policy = (context as any)?.toolPolicy as ToolPolicy | undefined;
    const effective = this.resolveSecurity(name, policy);

    if (effective.level === 'forbidden') {
      finishMetric('forbidden');
      throw new Error(`Tool "${name}" is forbidden: ${effective.reason}.`);
    }

    const capability = this.buildCapabilityManifestEntry(tool, policy);
    const constitutional = evaluateActionConstitution(
      semanticToolName,
      executionArgs,
      effective.level,
      context,
      capability,
    );
    if (constitutional.level === 'forbidden') {
      finishMetric('forbidden');
      throw new Error(`Tool "${name}" is forbidden: ${constitutional.reason}.`);
    }

    // Validate the frozen input before asking the user to approve it. This
    // prevents an impossible command (wrong platform, raw shell chaining, or
    // a non-allowlisted executable) from creating a confirmation that can only
    // fail when resumed. Handlers retain the same checks as defence in depth.
    if (pinnedPreflight) {
      try {
        await pinnedPreflight(executionArgs, context);
      } catch (error) {
        finishMetric('forbidden');
        throw error;
      }
    }

    let userConfirmed = false;

    if (constitutional.level === 'confirm') {
      if (context?.userConfirmed === true) {
        userConfirmed = true;
      } else if (context?.requestConfirmation) {
        const allowed = await context.requestConfirmation(name, executionArgs);
        if (!allowed) {
          finishMetric('waiting_confirmation');
          return `Tool "${name}" requires user confirmation and was not approved.`;
        }
        userConfirmed = true;
      } else {
        finishMetric('waiting_confirmation');
        throw new Error(`Tool "${name}" requires user confirmation: ${constitutional.reason}.`);
      }
      console.log(`[Tool] Executing confirmation-level tool: ${name} (${constitutional.reason})`);
    }

    const adapterPermit = beforeAdapterExecution({
      toolName: semanticToolName,
      capability,
      context,
    });
    if (!adapterPermit.allowed) {
      finishMetric('forbidden');
      throw new Error(`Tool "${name}" adapter circuit is open: ${adapterPermit.reason}.`);
    }

    // Wrap with timeouts to prevent hanging. Vision/CAD extraction needs more room than simple tools.
    const timeoutMs = getToolExecutionTimeoutMs(semanticToolName);
    const externalCommit = capability.sideEffects.some(effect => (
      effect.type === 'external_communication' || effect.type === 'external_state_change'
    ));
    const hasSideEffect = capability.operation === 'mutate'
      || capability.operation === 'create'
      || capability.operation === 'communicate'
      || capability.operation === 'unknown'
      || capability.sideEffects.some(effect => ![
        'local_read',
        'network_read',
        'none',
      ].includes(effect.type));
    const idempotencyKey = externalCommit ? executionIdempotencyKey(name, executionArgs, context) : '';
    const sideEffectFenceKey = !externalCommit && hasSideEffect
      ? localSideEffectFenceKey(name, context)
      : '';
    const sideEffectInputDigest = sideEffectFenceKey ? externalCommitInputDigest(name, executionArgs) : '';
    const inputDigest = externalCommit ? externalCommitInputDigest(name, executionArgs) : '';
    let claimToken = externalCommit ? crypto.randomUUID() : '';
    let releasePreparation: (() => void) | null = null;
    if (sideEffectFenceKey) {
      let existing = sideEffectAttempts.get(sideEffectFenceKey);
      if (existing?.expiresAt && existing.expiresAt <= Date.now() && !existing.promise) {
        sideEffectAttempts.delete(sideEffectFenceKey);
        existing = undefined;
      }
      if (existing && existing.inputDigest !== sideEffectInputDigest) {
        cancelAdapterExecutionPermit(adapterPermit);
        finishMetric('target_mismatch');
        throw new Error(`Tool "${name}" target mismatch: this idempotency key is already bound to different input.`);
      }
      if (existing?.state === 'verified') {
        cancelAdapterExecutionPermit(adapterPermit);
        finishMetric('verified_success');
        return existing.result || '';
      }
      if ((existing?.state === 'running' || existing?.state === 'unknown') && existing.promise) {
        cancelAdapterExecutionPermit(adapterPermit);
        try {
          const result = await existing.promise;
          finishMetric('verified_success');
          return result;
        } catch (error) {
          finishMetric(existing.state === 'unknown' ? 'unknown_outcome' : 'failed');
          throw error;
        }
      }
      if (existing?.state === 'unknown') {
        cancelAdapterExecutionPermit(adapterPermit);
        finishMetric('unknown_outcome');
        throw new Error(`Tool "${name}" has an unknown prior outcome for this idempotency key; automatic resend was stopped.`);
      }
    }
    if (externalCommit) {
      let existing = externalCommitAttempts.get(idempotencyKey);
      // A pending handler owns the idempotency fence until its exact promise
      // settles. TTL cleanup is only safe for terminal cache entries.
      if (existing?.expiresAt && existing.expiresAt <= Date.now() && !existing.promise) {
        externalCommitAttempts.delete(idempotencyKey);
        existing = undefined;
      } else if (existing?.state === 'preparing' && existing.ready) {
        await existing.ready;
        existing = externalCommitAttempts.get(idempotencyKey);
      }
      if (existing?.state === 'verified') {
        cancelAdapterExecutionPermit(adapterPermit);
        finishMetric('verified_success');
        return existing.result || '';
      } else if ((existing?.state === 'running' || existing?.state === 'unknown') && existing.promise) {
        cancelAdapterExecutionPermit(adapterPermit);
        try {
          const result = await existing.promise;
          finishMetric(externalResultIsVerified(result) ? 'verified_success' : 'unknown_outcome');
          return result;
        } catch (error) {
          finishMetric(/unknown|timed?\s*out|timeout/i.test(String((error as any)?.message || error))
            ? 'unknown_outcome'
            : 'failed');
          throw error;
        }
      } else if (existing?.state === 'unknown') {
        cancelAdapterExecutionPermit(adapterPermit);
        finishMetric('unknown_outcome');
        throw new Error(`Tool "${name}" has an unknown prior outcome for this idempotency key; automatic resend was stopped.`);
      }

      let release!: () => void;
      const ready = new Promise<void>(resolve => { release = resolve; });
      releasePreparation = release;
      externalCommitAttempts.set(idempotencyKey, {
        state: 'preparing',
        ready,
        expiresAt: Date.now() + 24 * 60 * 60_000,
      });

      let claim;
      try {
        const now = new Date().toISOString();
        claim = await claimExternalCommitAttempt({
          idempotencyKey,
          taskId: String(context?.taskId || ''),
          userId: String(context?.userId || ''),
          toolName: name,
          inputDigest,
          state: 'not_started',
          replayResult: '',
          claimToken,
          createdAt: now,
          updatedAt: now,
        });
      } catch (error: any) {
        externalCommitAttempts.delete(idempotencyKey);
        cancelAdapterExecutionPermit(adapterPermit);
        releasePreparation?.();
        releasePreparation = null;
        finishMetric('forbidden');
        throw new Error(
          `Tool "${name}" external commit was stopped before execution because the durable idempotency journal is unavailable: ${String(error?.message || error)}`,
        );
      }

      if (!claim.claimed) {
        const prior = claim.entry;
        if (prior.toolName !== name || prior.inputDigest !== inputDigest) {
          externalCommitAttempts.set(idempotencyKey, {
            state: 'unknown',
            expiresAt: Date.now() + 24 * 60 * 60_000,
          });
          releasePreparation?.();
          releasePreparation = null;
          cancelAdapterExecutionPermit(adapterPermit);
          finishMetric('target_mismatch');
          throw new Error(
            `Tool "${name}" target mismatch: this idempotency key is already bound to different external commit input.`,
          );
        }
        if (prior.state === 'verified') {
          const replay = prior.replayResult || persistedExternalCommitReplay('', idempotencyKey);
          externalCommitAttempts.set(idempotencyKey, {
            state: 'verified',
            result: replay,
            expiresAt: Date.now() + 24 * 60 * 60_000,
          });
          releasePreparation?.();
          releasePreparation = null;
          cancelAdapterExecutionPermit(adapterPermit);
          finishMetric('verified_success');
          return replay;
        }

        if (prior.state === 'not_started') {
          // A previous attempt durably proved that the adapter handler never
          // started. Reuse the same claim identity and arm it only at the next
          // handler-entry barrier.
          claimToken = prior.claimToken;
        } else {
        let reconciled: string | null = null;
        if (pinnedReconcileExternalCommit) {
          let reconciliationTimeout: ReturnType<typeof setTimeout> | undefined;
          try {
            reconciled = await Promise.race([
              pinnedReconcileExternalCommit(executionArgs, context, idempotencyKey),
              new Promise<null>(resolve => {
                reconciliationTimeout = setTimeout(() => resolve(null), 8_000);
              }),
            ]);
          } catch {
            reconciled = null;
          } finally {
            if (reconciliationTimeout) clearTimeout(reconciliationTimeout);
          }
        }
        if (reconciled && externalResultIsVerified(reconciled)) {
          const replay = persistedExternalCommitReplay(reconciled, idempotencyKey);
          await settleExternalCommitAttempt({
            idempotencyKey,
            claimToken: prior.claimToken,
            state: 'verified',
            replayResult: replay,
            updatedAt: new Date().toISOString(),
            recoverExisting: true,
          }).catch(() => false);
          externalCommitAttempts.set(idempotencyKey, {
            state: 'verified',
            result: reconciled,
            expiresAt: Date.now() + 24 * 60 * 60_000,
          });
          releasePreparation?.();
          releasePreparation = null;
          recordAdapterExecutionSuccess(adapterPermit);
          finishMetric('verified_success');
          return reconciled;
        }
        await settleExternalCommitAttempt({
          idempotencyKey,
          claimToken: prior.claimToken,
          state: 'unknown',
          replayResult: '',
          updatedAt: new Date().toISOString(),
          recoverExisting: true,
        }).catch(() => false);
        externalCommitAttempts.set(idempotencyKey, {
          state: 'unknown',
          expiresAt: Date.now() + 24 * 60 * 60_000,
        });
        releasePreparation?.();
        releasePreparation = null;
        cancelAdapterExecutionPermit(adapterPermit);
        finishMetric('unknown_outcome');
        throw externalCommitUnknownError(name, 'A prior running or unknown attempt could not be verified by read-only reconciliation.');
        }
      }
    }
    let timedOut = false;
    const executionContextBase: ToolContext = {
      ...(context || {}),
      toolRegistry: this,
      userConfirmed: context?.userConfirmed === true || userConfirmed,
    };
    const retryPolicy = getAdapterRetryPolicy(semanticToolName, capability);
    let handlerEntered = false;
    const execution = (async () => {
      let lastError: unknown;
      for (let attempt = 1; attempt <= retryPolicy.maxAttempts; attempt += 1) {
        timedOut = false;
        let attemptTimedOut = false;
        let attemptTimeoutHandle: ReturnType<typeof setTimeout> | null = null;
        let timeoutJournalPersistence: Promise<boolean> | null = null;
        const attemptAbortController = new AbortController();
        const upstreamSignal = context?.executionSignal;
        const abortFromUpstream = () => {
          if (!attemptAbortController.signal.aborted) {
            attemptAbortController.abort(upstreamSignal?.reason);
          }
        };
        if (upstreamSignal?.aborted) abortFromUpstream();
        else upstreamSignal?.addEventListener('abort', abortFromUpstream, { once: true });
        const executionContext: ToolContext = {
          ...executionContextBase,
          executionSignal: attemptAbortController.signal,
          isCancelled: () => (
            attemptTimedOut
            || upstreamSignal?.aborted === true
            || context?.isCancelled?.() === true
          ),
        };
        try {
          try {
            await executionContext.onAdapterStart?.({ name, attempt });
          } catch (error) {
            throw brandToolLifecyclePersistenceFailure(error);
          }
          if (externalCommit) {
            const armed = await settleExternalCommitAttempt({
              idempotencyKey,
              claimToken,
              state: 'running',
              replayResult: '',
              updatedAt: new Date().toISOString(),
            });
            if (!armed) {
              throw new Error(`Tool "${name}" external commit was stopped because its durable handler-entry barrier could not be armed.`);
            }
          }
          handlerEntered = true;
          attemptTimeoutHandle = setTimeout(() => {
            attemptTimedOut = true;
            timedOut = true;
            const timeoutError = new Error(`Tool "${name}" timed out after ${timeoutMs / 1000}s`);
            if (!attemptAbortController.signal.aborted) attemptAbortController.abort(timeoutError);
            if (externalCommit) {
              const active = externalCommitAttempts.get(idempotencyKey);
              if (active?.promise) {
                externalCommitAttempts.set(idempotencyKey, {
                  ...active,
                  state: 'unknown',
                  expiresAt: Date.now() + 24 * 60 * 60_000,
                });
              }
              timeoutJournalPersistence = settleExternalCommitAttempt({
                idempotencyKey,
                claimToken,
                state: 'unknown',
                replayResult: '',
                updatedAt: new Date().toISOString(),
              }).catch(() => false);
            }
            if (sideEffectFenceKey) {
              const active = sideEffectAttempts.get(sideEffectFenceKey);
              if (active?.promise) {
                sideEffectAttempts.set(sideEffectFenceKey, {
                  ...active,
                  state: 'unknown',
                  expiresAt: Date.now() + 24 * 60 * 60_000,
                });
              }
            }
          }, timeoutMs);
          attemptTimeoutHandle.unref?.();

          let handlerResult = '';
          let handlerFailure: unknown;
          let handlerRejected = false;
          try {
            // Normalize synchronous throws while retaining the exact pinned
            // handler promise as the sole owner of this execution attempt.
            handlerResult = await Promise.resolve().then(() => pinnedHandler(executionArgs, executionContext));
          } catch (error) {
            handlerRejected = true;
            handlerFailure = error;
          } finally {
            if (attemptTimeoutHandle) clearTimeout(attemptTimeoutHandle);
            if (timeoutJournalPersistence) await timeoutJournalPersistence;
          }

          try {
            await executionContext.onAdapterSettlement?.({
              name,
              attempt,
              status: handlerRejected ? 'rejected' : 'fulfilled',
              timedOut: attemptTimedOut,
              settledAt: new Date().toISOString(),
            });
          } catch (error) {
            throw brandToolLifecyclePersistenceFailure(error);
          }
          if (handlerRejected) {
            if (attemptTimedOut && !isToolLifecyclePersistenceFailure(handlerFailure)) {
              throw new ToolHandlerSettledAfterTimeoutError(name, timeoutMs, handlerFailure);
            }
            throw handlerFailure;
          }
          return handlerResult;
        } catch (error) {
          lastError = error;
          const canRetry = attempt < retryPolicy.maxAttempts
            && !isToolLifecyclePersistenceFailure(error)
            && adapterFailureIsTransient(error)
            && context?.isCancelled?.() !== true;
          if (!canRetry) throw error;
          recordToolRetry(name);
          await new Promise<void>(resolve => setTimeout(resolve, retryPolicy.jitterMs));
        } finally {
          if (attemptTimeoutHandle) clearTimeout(attemptTimeoutHandle);
          upstreamSignal?.removeEventListener('abort', abortFromUpstream);
        }
      }
      throw lastError instanceof Error ? lastError : new Error(String(lastError || 'Tool execution failed.'));
    })();

    const finalizeExecution = async (): Promise<string> => {
      try {
        const result = await execution;
        if (externalCommit) {
          if (externalResultIsVerified(result)) {
            const replayResult = persistedExternalCommitReplay(result, idempotencyKey);
            const settled = await settleExternalCommitAttempt({
              idempotencyKey,
              claimToken,
              state: 'verified',
              replayResult,
              updatedAt: new Date().toISOString(),
            }).catch(() => false);
            if (!settled) {
              externalCommitAttempts.set(idempotencyKey, {
                state: 'unknown',
                expiresAt: Date.now() + 24 * 60 * 60_000,
              });
              // The adapter handler returned a verified receipt. A later local
              // journal failure must keep the external outcome unknown and
              // block replay, but it is not evidence that the adapter itself
              // is unhealthy.
              recordAdapterExecutionSuccess(adapterPermit);
              finishMetric('unknown_outcome');
              throw externalCommitUnknownError(
                name,
                'The handler settled successfully, but its verified terminal state could not be persisted.',
              );
            }
            externalCommitAttempts.set(idempotencyKey, {
              state: 'verified',
              result,
              expiresAt: Date.now() + 24 * 60 * 60_000,
            });
            recordAdapterExecutionSuccess(adapterPermit);
          } else {
            await settleExternalCommitAttempt({
              idempotencyKey,
              claimToken,
              state: 'unknown',
              replayResult: '',
              updatedAt: new Date().toISOString(),
            }).catch(() => false);
            externalCommitAttempts.set(idempotencyKey, {
              state: 'unknown',
              expiresAt: Date.now() + 24 * 60 * 60_000,
            });
            // The handler fulfilled, so the adapter transport is healthy even
            // though the business outcome is not sufficiently verified. Keep
            // the durable attempt unknown (and therefore non-replayable), but
            // do not turn missing provider evidence into an adapter outage.
            recordAdapterExecutionSuccess(adapterPermit);
            finishMetric('unknown_outcome');
            return result;
          }
        }
        if (sideEffectFenceKey) {
          if (pinnedLocalIdempotencyReplay === 'durable_handler') {
            sideEffectAttempts.delete(sideEffectFenceKey);
          } else {
            sideEffectAttempts.set(sideEffectFenceKey, {
              state: 'verified',
              inputDigest: sideEffectInputDigest,
              result,
              expiresAt: Date.now() + 24 * 60 * 60_000,
            });
          }
        }
        if (!externalCommit) recordAdapterExecutionSuccess(adapterPermit);
        finishMetric('verified_success');
        return result;
      } catch (error: any) {
        if (error?.externalCommitUnknown === true) throw error;
        if (externalCommit) {
          if (!handlerEntered) {
            await settleExternalCommitAttempt({
              idempotencyKey,
              claimToken,
              state: 'not_started',
              replayResult: '',
              updatedAt: new Date().toISOString(),
            }).catch(() => false);
            externalCommitAttempts.delete(idempotencyKey);
            cancelAdapterExecutionPermit(adapterPermit);
            finishMetric('failed');
            throw error;
          }
          let reconciled: string | null = null;
          if (pinnedReconcileExternalCommit && !isToolLifecyclePersistenceFailure(error)) {
            let reconciliationTimeout: ReturnType<typeof setTimeout> | undefined;
            try {
              reconciled = await Promise.race([
                pinnedReconcileExternalCommit(executionArgs, context, idempotencyKey),
                new Promise<null>(resolve => {
                  reconciliationTimeout = setTimeout(() => resolve(null), 8_000);
                }),
              ]);
            } catch {
              // A failed read-only reconciliation leaves the outcome unknown.
              reconciled = null;
            } finally {
              if (reconciliationTimeout) clearTimeout(reconciliationTimeout);
            }
          }
          if (reconciled && externalResultIsVerified(reconciled)) {
            const replayResult = persistedExternalCommitReplay(reconciled, idempotencyKey);
            const settled = await settleExternalCommitAttempt({
              idempotencyKey,
              claimToken,
              state: 'verified',
              replayResult,
              updatedAt: new Date().toISOString(),
            }).catch(() => false);
            if (settled) {
              externalCommitAttempts.set(idempotencyKey, {
                state: 'verified',
                result: reconciled,
                expiresAt: Date.now() + 24 * 60 * 60_000,
              });
              recordAdapterExecutionSuccess(adapterPermit);
              finishMetric('verified_success');
              return reconciled;
            }
          }
          await settleExternalCommitAttempt({
            idempotencyKey,
            claimToken,
            state: 'unknown',
            replayResult: '',
            updatedAt: new Date().toISOString(),
          }).catch(() => false);
          externalCommitAttempts.set(idempotencyKey, {
            state: 'unknown',
            expiresAt: Date.now() + 24 * 60 * 60_000,
          });
          // Only transient adapter/transport failures contribute to the
          // resilience circuit. Business rejection and local lifecycle errors
          // still leave the external commit unknown, but must not poison the
          // shared adapter family for later read-only work.
          recordAdapterExecutionFailure(adapterPermit, error);
          finishMetric('unknown_outcome');
          if (isToolLifecyclePersistenceFailure(error)) throw error;
          throw externalCommitUnknownError(
            name,
            `${timedOut ? 'The call timed out.' : 'The handler failed after the durable claim.'} ${String(error?.message || error || '')}`,
          );
        } else {
          if (sideEffectFenceKey) {
            if (handlerEntered) {
              sideEffectAttempts.set(sideEffectFenceKey, {
                state: 'unknown',
                inputDigest: sideEffectInputDigest,
                expiresAt: Date.now() + 24 * 60 * 60_000,
              });
            } else {
              sideEffectAttempts.delete(sideEffectFenceKey);
            }
          }
          recordAdapterExecutionFailure(adapterPermit, error);
          finishMetric(timedOut ? 'timeout' : 'failed');
        }
        throw error;
      } finally {
        releasePreparation?.();
      }
    };

    const finalizedExecution = finalizeExecution();
    if (externalCommit) {
      externalCommitAttempts.set(idempotencyKey, {
        state: 'running',
        promise: finalizedExecution,
        expiresAt: Date.now() + 24 * 60 * 60_000,
      });
      releasePreparation?.();
      releasePreparation = null;
    }
    if (sideEffectFenceKey) {
      sideEffectAttempts.set(sideEffectFenceKey, {
        state: 'running',
        inputDigest: sideEffectInputDigest,
        promise: finalizedExecution,
        expiresAt: Date.now() + 24 * 60 * 60_000,
      });
    }
    return await finalizedExecution;
  }
}

export const toolRegistry = new ToolRegistry();
