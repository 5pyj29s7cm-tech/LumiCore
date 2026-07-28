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
import { beginToolMetric } from '../runtime/tool_metrics';
import {
  claimExternalCommitAttempt,
  settleExternalCommitAttempt,
} from './external_commit_journal';

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

/** Test-only process restart simulation; durable journal rows are preserved. */
export function resetExternalCommitRuntimeCacheForTests(): void {
  externalCommitAttempts.clear();
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

function externalCommitInputDigest(name: string, args: Record<string, any>): string {
  return crypto.createHash('sha256').update(JSON.stringify(stableValue({ name, args }))).digest('hex');
}

function persistedExternalCommitReplay(result: string, idempotencyKey: string): string {
  const safeKeys = /^(?:sent|submitted|published|verified|verificationStatus|verificationMethod|verificationConfidence|verificationReason|providerReceipt|messageId|submissionId|publicationId|paymentId|signatureId|status|targetMatched|conversationVerified|contactVerified|sendAttempted|completedAt|timestamp)$/i;
  try {
    const parsed = JSON.parse(result || '{}');
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const safe = Object.fromEntries(
        Object.entries(parsed)
          .filter(([key]) => safeKeys.test(key))
          .slice(0, 40)
          .map(([key, value]) => [key, typeof value === 'string' ? value.slice(0, 500) : value]),
      );
      return JSON.stringify({
        ...safe,
        verified: true,
        verificationStatus: 'verified',
        deduplicated: true,
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

function externalResultIsVerified(result: string): boolean {
  try {
    const payload = JSON.parse(result || '{}');
    if (payload.sent === false || payload.submitted === false || payload.published === false) return false;
    if (payload.verificationStatus) return payload.verificationStatus === 'verified';
    if (payload.verified !== undefined) return payload.verified === true;
  } catch {}
  return true;
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
  if (/^model_configuration_(?:update|test)$/i.test(name)) return 2 * 60_000;
  if (name === 'transcribe_audio_to_text_file') return 60 * 60_000;
  if (/^mcp_cad-drafting_autocad_playback_file$/i.test(name)) return 30 * 60_000;
  if (name === 'cad_draw_floorplan_in_autocad') return 45 * 60_000;
  if (/^cad_prepare_autocad_operations$/i.test(name)) return 5 * 60_000;
  if (/^(web_login_|url_fetch_logged_in)/i.test(name)) return 5 * 60_000;
  if (name === 'legal_refresh_authoritative_sources') return 3 * 60_000;
  if (name === 'desktop_ai_roundtable') return 15 * 60_000;
  if (/^(wechat_|desktop_ai_)/i.test(name)) return 3 * 60_000;
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
      requiredFields: ['status'],
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
      requiredFields: ['status'],
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

  getEvidenceDescriptor(name: string): ToolDefinition['evidence'] | undefined {
    return this.tools.get(name)?.evidence;
  }

  getCapabilityManifestEntry(
    name: string,
    policy?: ToolPolicy,
  ): CapabilityManifestEntry | undefined {
    const tool = this.tools.get(name);
    return tool ? this.buildCapabilityManifestEntry(tool, policy) : undefined;
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
   * tool description; the orchestrator does not need a branch per tool.
   */
  findRelevant(text: string, options?: {
    limit?: number;
    evidenceOperations?: Array<NonNullable<ToolDefinition['evidence']>['operation']>;
  }): ToolDefinition[] {
    const query = String(text || '').toLowerCase().trim();
    if (!query) return [];
    const ascii = query.match(/[a-z0-9_]{3,}/g) || [];
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
      .filter(tool => !allowedOperations || (tool.evidence && allowedOperations.has(tool.evidence.operation)))
      .map(tool => {
        const haystack = `${tool.name} ${tool.description} ${(tool.routingHints || []).join(' ')}`.toLowerCase();
        const score = tokens.reduce((total, token) => (
          total + (haystack.includes(token) ? Math.min(4, token.length) : 0)
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
    options?: { executableOnly?: boolean },
  ): CapabilityManifestEntry[] {
    const entries = this.list().map(tool => this.buildCapabilityManifestEntry(tool, policy));
    return options?.executableOnly ? entries.filter(entry => entry.executable) : entries;
  }

  getToolDeclarations(): Array<{
    type: 'function';
    function: { name: string; description: string; parameters: Record<string, any> };
  }> {
    return this.list().map(t => ({
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
    options?: { failClosedWithoutPolicy?: boolean },
  ): ReturnType<ToolRegistry['getToolDeclarations']> {
    if (!policy && options?.failClosedWithoutPolicy) return [];
    const executable = new Set(
      this.getCapabilityManifest(policy, { executableOnly: true })
        .map(entry => entry.toolName),
    );
    return this.getToolDeclarations().filter(declaration => (
      executable.has(declaration.function.name)
    ));
  }

  /** Resolve effective security level for a tool given a personality's policy */
  resolveSecurity(toolName: string, policy?: ToolPolicy): EffectiveSecurity {
    const tool = this.get(toolName);
    const builtIn: SecurityLevel = tool?.securityLevel || 'confirm';

    if (!policy) return { level: builtIn, reason: 'tool default' };

    // 1. forbiddenTools overrides everything
    if (policy.forbiddenTools?.includes('*') || policy.forbiddenTools?.includes(toolName)) {
      return { level: 'forbidden', reason: 'personality forbiddenTools list' };
    }

    // 2. Explicit per-tool security override
    if (policy.securityOverrides?.[toolName]) {
      return { level: policy.securityOverrides[toolName], reason: 'personality security override' };
    }

    // 3. Legacy requireConfirmation promotes to confirm
    if (policy.requireConfirmation.includes(toolName) && builtIn === 'safe') {
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

    // Resolve effective security level
    const policy = (context as any)?.toolPolicy as ToolPolicy | undefined;
    const effective = this.resolveSecurity(name, policy);

    if (effective.level === 'forbidden') {
      finishMetric('forbidden');
      throw new Error(`Tool "${name}" is forbidden: ${effective.reason}.`);
    }

    const capability = this.buildCapabilityManifestEntry(tool, policy);
    const constitutional = evaluateActionConstitution(
      name,
      args,
      effective.level,
      context,
      capability,
    );
    if (constitutional.level === 'forbidden') {
      finishMetric('forbidden');
      throw new Error(`Tool "${name}" is forbidden: ${constitutional.reason}.`);
    }

    let userConfirmed = false;

    if (constitutional.level === 'confirm') {
      if (context?.userConfirmed === true) {
        userConfirmed = true;
      } else if (context?.requestConfirmation) {
        const allowed = await context.requestConfirmation(name, args);
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

    // Wrap with timeouts to prevent hanging. Vision/CAD extraction needs more room than simple tools.
    const timeoutMs = getToolExecutionTimeoutMs(name);
    const externalCommit = capability.sideEffects.some(effect => (
      effect.type === 'external_communication' || effect.type === 'external_state_change'
    ));
    const idempotencyKey = externalCommit ? executionIdempotencyKey(name, args, context) : '';
    const inputDigest = externalCommit ? externalCommitInputDigest(name, args) : '';
    const claimToken = externalCommit ? crypto.randomUUID() : '';
    let releasePreparation: (() => void) | null = null;
    if (externalCommit) {
      let existing = externalCommitAttempts.get(idempotencyKey);
      if (existing?.expiresAt && existing.expiresAt <= Date.now()) {
        externalCommitAttempts.delete(idempotencyKey);
        existing = undefined;
      }
      else if (existing?.state === 'preparing' && existing.ready) {
        await existing.ready;
        existing = externalCommitAttempts.get(idempotencyKey);
      }
      if (existing?.state === 'verified') {
        finishMetric('verified_success');
        return existing.result || '';
      } else if (existing?.state === 'unknown') {
        finishMetric('unknown_outcome');
        throw new Error(`Tool "${name}" has an unknown prior outcome for this idempotency key; automatic resend was stopped.`);
      } else if (existing?.state === 'running' && existing.promise) {
        try {
          const result = await existing.promise;
          finishMetric(externalResultIsVerified(result) ? 'verified_success' : 'failed');
          return result;
        } catch (error) {
          finishMetric(/unknown|timed?\s*out|timeout/i.test(String((error as any)?.message || error))
            ? 'unknown_outcome'
            : 'failed');
          throw error;
        }
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
          state: 'running',
          replayResult: '',
          claimToken,
          createdAt: now,
          updatedAt: now,
        });
      } catch (error: any) {
        externalCommitAttempts.delete(idempotencyKey);
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
          finishMetric('verified_success');
          return replay;
        }

        let reconciled: string | null = null;
        if (tool.reconcileExternalCommit) {
          let reconciliationTimeout: ReturnType<typeof setTimeout> | undefined;
          try {
            reconciled = await Promise.race([
              tool.reconcileExternalCommit(args, context, idempotencyKey),
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
        finishMetric('unknown_outcome');
        throw externalCommitUnknownError(name, 'A prior running or unknown attempt could not be verified by read-only reconciliation.');
      }
    }
    let timedOut = false;
    const executionContext: ToolContext = {
      ...(context || {}),
      toolRegistry: this,
      userConfirmed: context?.userConfirmed === true || userConfirmed,
      isCancelled: () => timedOut || context?.isCancelled?.() === true,
    };
    let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
    const execution = Promise.race([
        tool.handler(args, executionContext),
        new Promise<string>((_, reject) => {
          timeoutHandle = setTimeout(() => {
            timedOut = true;
            reject(new Error(`Tool "${name}" timed out after ${timeoutMs / 1000}s`));
          }, timeoutMs);
        }),
      ]);
    if (externalCommit) {
      externalCommitAttempts.set(idempotencyKey, {
        state: 'running',
        promise: execution,
        expiresAt: Date.now() + 24 * 60 * 60_000,
      });
      releasePreparation?.();
      releasePreparation = null;
    }
    try {
      const result = await execution;
      if (externalCommit) {
        if (externalResultIsVerified(result)) {
          const replayResult = persistedExternalCommitReplay(result, idempotencyKey);
          await settleExternalCommitAttempt({
            idempotencyKey,
            claimToken,
            state: 'verified',
            replayResult,
            updatedAt: new Date().toISOString(),
          }).catch(() => false);
          externalCommitAttempts.set(idempotencyKey, {
            state: 'verified',
            result,
            expiresAt: Date.now() + 24 * 60 * 60_000,
          });
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
          finishMetric('unknown_outcome');
          return result;
        }
      }
      finishMetric('verified_success');
      return result;
    } catch (error: any) {
      if (error?.externalCommitUnknown === true) throw error;
      if (externalCommit) {
        let reconciled: string | null = null;
        if (tool.reconcileExternalCommit) {
          let reconciliationTimeout: ReturnType<typeof setTimeout> | undefined;
          try {
            reconciled = await Promise.race([
              tool.reconcileExternalCommit(args, context, idempotencyKey),
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
          await settleExternalCommitAttempt({
            idempotencyKey,
            claimToken,
            state: 'verified',
            replayResult,
            updatedAt: new Date().toISOString(),
          }).catch(() => false);
          externalCommitAttempts.set(idempotencyKey, {
            state: 'verified',
            result: reconciled,
            expiresAt: Date.now() + 24 * 60 * 60_000,
          });
          finishMetric('verified_success');
          return reconciled;
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
        finishMetric('unknown_outcome');
        throw externalCommitUnknownError(
          name,
          `${timedOut ? 'The call timed out.' : 'The handler failed after the durable claim.'} ${String(error?.message || error || '')}`,
        );
      } else {
        finishMetric(timedOut ? 'timeout' : 'failed');
      }
      throw error;
    } finally {
      if (timeoutHandle) clearTimeout(timeoutHandle);
      releasePreparation?.();
    }
  }
}

export const toolRegistry = new ToolRegistry();
