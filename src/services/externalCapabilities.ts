import { apiFetch } from './apiClient';

export type ExternalCapabilityStage = 'configured' | 'connected' | 'verified' | 'automatic' | string;
export type ExternalCapabilityAvailability = 'ready' | 'unavailable' | string;

export interface ExternalCapabilityRuntimeRef {
  id: string;
  kind: 'builtin' | 'skill' | 'mcp' | 'signed_extension' | string;
  provider?: string;
  manifestDigest?: string;
}

export interface ExternalCapabilityAction {
  id: string;
  label: string;
  description: string;
  icon?: string;
  capabilityId: string;
  toolName: string;
  executionMode: 'manual' | 'assisted' | 'automatic_candidate' | string;
  requiresConfirmation: boolean;
  availability: ExternalCapabilityAvailability;
  verification: {
    status: 'never' | 'verified' | 'unverified' | 'failed' | string;
    lastVerifiedAt?: string;
    verifiedRuns: number;
  };
}

export interface ExternalCapabilityProjection {
  id: string;
  version: string;
  name: string;
  description: string;
  stage: ExternalCapabilityStage;
  availability: ExternalCapabilityAvailability;
  unavailableReason?: string;
  presentation: {
    icon?: string;
    label?: string;
    placements: string[];
    launchActionId?: string;
  };
  runtimeRefs: ExternalCapabilityRuntimeRef[];
  guidance: {
    whenToUse: string[];
    whenNotToUse: string[];
    triggerHints: string[];
    steps: string[];
    completionRules: string[];
  };
  actions: ExternalCapabilityAction[];
  activatedAt?: string;
  updatedAt?: string;
}

export interface ExternalCapabilityReview {
  reviewNonce: string;
  expiresAt?: string;
  packageDigest?: string;
  proposal: Record<string, unknown>;
  id: string;
  version: string;
  name: string;
  summary: string;
  documents: string[];
  permissions: string[];
  warnings: string[];
  runtimeRefs: ExternalCapabilityRuntimeRef[];
  actions: Array<{
    id: string;
    label: string;
    description: string;
    toolName: string;
    capabilityId: string;
    source?: string;
    provider?: string;
    executable: boolean;
    requiresConfirmation: boolean;
  }>;
}

export interface ExternalCapabilityExecution {
  receiptId: string;
  status: string;
  toolName: string;
  result?: unknown;
  error?: string;
  terminalVerification?: unknown;
}

export interface ExternalCapabilityExecutionCorrelation {
  requestId: string;
  idempotencyKey: string;
}

export function createExternalCapabilityExecutionCorrelation(): ExternalCapabilityExecutionCorrelation {
  const nextId = () => {
    if (typeof globalThis.crypto?.randomUUID === 'function') return globalThis.crypto.randomUUID();
    const bytes = new Uint8Array(16);
    globalThis.crypto?.getRandomValues?.(bytes);
    return Array.from(bytes, value => value.toString(16).padStart(2, '0')).join('');
  };
  return {
    requestId: `external-capability-${nextId()}`,
    idempotencyKey: `external-capability-${nextId()}`,
  };
}

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : {};
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function asBoolean(value: unknown): boolean {
  return value === true;
}

function asNonNegativeInteger(value: unknown): number {
  const normalized = Number(value);
  return Number.isInteger(normalized) && normalized >= 0 ? normalized : 0;
}

function stringList(value: unknown): string[] {
  if (typeof value === 'string') return value.trim() ? [value.trim()] : [];
  if (!Array.isArray(value)) return [];
  return value.map(item => asString(item)).filter(Boolean);
}

function normalizeRuntimeRef(value: unknown, fallbackId = ''): ExternalCapabilityRuntimeRef | null {
  const runtime = asRecord(value);
  const kind = asString(runtime.kind);
  if (!kind) return null;
  return {
    id: asString(runtime.id) || fallbackId || kind,
    kind,
    provider: asString(runtime.provider) || undefined,
    manifestDigest: asString(runtime.manifestDigest) || undefined,
  };
}

function normalizeRuntimeRefs(value: unknown, legacyRuntime?: unknown): ExternalCapabilityRuntimeRef[] {
  const refs = Array.isArray(value)
    ? value.map((item, index) => normalizeRuntimeRef(item, `runtime-${index + 1}`))
    : [];
  const normalized = refs.filter((item): item is ExternalCapabilityRuntimeRef => Boolean(item));
  if (normalized.length) return normalized;
  const legacy = normalizeRuntimeRef(legacyRuntime, 'runtime-1');
  return legacy ? [legacy] : [];
}

function placementList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map(item => {
    if (typeof item === 'string') return item.trim();
    const record = asRecord(item);
    return asString(record.id || record.placement || record.name);
  }).filter(Boolean);
}

function normalizeAction(value: unknown, capabilityId: string): ExternalCapabilityAction | null {
  const action = asRecord(value);
  const id = asString(action.id || action.actionId || action.name);
  if (!id) return null;
  const verification = asRecord(action.verification);
  return {
    id,
    label: asString(action.label || action.name) || id,
    description: asString(action.description),
    icon: asString(action.icon) || undefined,
    capabilityId: asString(action.capabilityId) || capabilityId,
    toolName: asString(action.toolName),
    executionMode: asString(action.executionMode) || 'manual',
    requiresConfirmation: asBoolean(action.requiresConfirmation),
    availability: asString(asRecord(action.availability).status || action.availability) || 'unavailable',
    verification: {
      status: asString(verification.status) || 'never',
      lastVerifiedAt: asString(verification.lastVerifiedAt) || undefined,
      verifiedRuns: asNonNegativeInteger(verification.verifiedRuns),
    },
  };
}

function normalizeActions(value: unknown, capabilityId: string): ExternalCapabilityAction[] {
  if (Array.isArray(value)) {
    return value.map(item => normalizeAction(item, capabilityId)).filter((item): item is ExternalCapabilityAction => Boolean(item));
  }
  const record = asRecord(value);
  return Object.entries(record).map(([id, item]) => normalizeAction({ id, ...asRecord(item) }, capabilityId)).filter((item): item is ExternalCapabilityAction => Boolean(item));
}

export function normalizeExternalCapability(value: unknown): ExternalCapabilityProjection | null {
  const item = asRecord(value);
  const id = asString(item.id || item.capabilityId || item.extensionId);
  if (!id) return null;
  const presentation = asRecord(item.presentation);
  const guidance = asRecord(item.guidance);
  const availability = asRecord(item.availability);
  return {
    id,
    version: asString(item.version) || '1.0.0',
    name: asString(item.name || item.label || presentation.label) || id,
    description: asString(item.description || item.summary),
    stage: asString(item.stage || item.lifecycleStage || item.status) || 'configured',
    availability: asString(availability.status || item.availability) || (item.usable === true ? 'ready' : 'unavailable'),
    unavailableReason: asString(item.unavailableReason || availability.reason) || undefined,
    presentation: {
      icon: asString(presentation.icon) || undefined,
      label: asString(presentation.label) || undefined,
      placements: placementList(presentation.placements),
      launchActionId: asString(presentation.launchActionId) || undefined,
    },
    runtimeRefs: normalizeRuntimeRefs(item.runtimeRefs, item.runtime || (
      item.runtimeKind ? { kind: item.runtimeKind, provider: item.provider } : undefined
    )),
    guidance: {
      whenToUse: stringList(guidance.whenToUse),
      whenNotToUse: stringList(guidance.whenNotToUse),
      triggerHints: stringList(guidance.triggerHints),
      steps: stringList(guidance.steps),
      completionRules: stringList(guidance.completionRules),
    },
    actions: normalizeActions(item.actions, id),
    activatedAt: asString(item.activatedAt) || undefined,
    updatedAt: asString(item.updatedAt) || undefined,
  };
}

export function normalizeExternalCapabilitiesPayload(value: unknown): ExternalCapabilityProjection[] {
  const payload = asRecord(value);
  const items = Array.isArray(value)
    ? value
    : Array.isArray(payload.capabilities)
      ? payload.capabilities
      : Array.isArray(payload.items)
        ? payload.items
        : [];
  return items.map(normalizeExternalCapability).filter((item): item is ExternalCapabilityProjection => Boolean(item));
}

function reviewDisplayList(value: unknown, kind: 'document' | 'permission'): string[] {
  if (Array.isArray(value)) {
    return value.map(item => {
      if (typeof item === 'string') return item.trim();
      const record = asRecord(item);
      if (kind === 'document') {
        return asString(record.label || record.title || record.name || record.url || record.ref || record.kind || record.type);
      }
      const permission = asString(record.permission || record.label || record.name || record.scope || record.type);
      const risk = asString(record.risk);
      return permission && risk ? `${permission} [${risk}]` : permission;
    }).filter(Boolean);
  }
  const record = asRecord(value);
  return Object.keys(record).filter(Boolean);
}

export function normalizeExternalCapabilityReview(
  value: unknown,
  fallbackProposal: Record<string, unknown>,
): ExternalCapabilityReview {
  const payload = asRecord(value);
  const review = asRecord(payload.review);
  const proposal = Object.keys(asRecord(payload.proposal)).length
    ? asRecord(payload.proposal)
    : Object.keys(asRecord(payload.package)).length
      ? asRecord(payload.package)
      : fallbackProposal;
  const proposalPresentation = asRecord(proposal.presentation);
  const proposalActions = Array.isArray(proposal.actions) ? proposal.actions.map(asRecord) : [];
  const rawActions = Array.isArray(review.resolvedActions)
    ? review.resolvedActions
    : Array.isArray(review.actions)
      ? review.actions
      : Array.isArray(proposal.actions)
        ? proposal.actions
        : [];
  const id = asString(review.id || proposal.id || proposal.capabilityId);
  const actions = rawActions.map(value => {
    const action = asRecord(value);
    const actionId = asString(action.actionId || action.id || action.name);
    if (!actionId) return null;
    const proposedAction = proposalActions.find(candidate => asString(candidate.id || candidate.actionId) === actionId) || {};
    return {
      id: actionId,
      label: asString(action.label || action.name || proposedAction.label) || actionId,
      description: asString(action.description || proposedAction.description),
      toolName: asString(action.toolName),
      capabilityId: asString(action.capabilityId) || id,
      source: asString(action.source) || undefined,
      provider: asString(action.provider) || undefined,
      executable: action.executable !== false,
      requiresConfirmation: asBoolean(action.requiresConfirmation),
    };
  }).filter((item): item is NonNullable<typeof item> => Boolean(item));
  return {
    reviewNonce: asString(payload.reviewNonce || payload.nonce),
    expiresAt: asString(payload.expiresAt || review.expiresAt) || undefined,
    packageDigest: asString(payload.packageDigest || review.packageDigest) || undefined,
    proposal,
    id,
    version: asString(review.version || proposal.version) || '1.0.0',
    name: asString(review.name || proposal.name || proposalPresentation.label) || id,
    summary: asString(review.summary || review.description || proposal.summary || proposal.description),
    documents: reviewDisplayList(review.documents || proposal.documents || proposal.documentation || proposal.docs, 'document'),
    permissions: reviewDisplayList(review.permissions || proposal.permissions, 'permission'),
    warnings: stringList(review.warnings || payload.warnings),
    runtimeRefs: normalizeRuntimeRefs(
      review.runtimeRefs || proposal.runtimeRefs,
      review.runtime || proposal.runtime,
    ),
    actions,
  };
}

async function responseJson(response: Response): Promise<JsonRecord> {
  return asRecord(await response.json().catch(() => ({})));
}

function apiError(data: JsonRecord, response: Response, fallback: string): Error {
  return new Error(asString(data.error || data.message) || `${fallback} (${response.status})`);
}

export async function fetchExternalCapabilities(): Promise<ExternalCapabilityProjection[]> {
  const response = await apiFetch('/api/external-capabilities');
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw apiError(asRecord(data), response, 'External capabilities could not be loaded');
  return normalizeExternalCapabilitiesPayload(data);
}

export async function reviewExternalCapability(
  proposal: Record<string, unknown>,
): Promise<ExternalCapabilityReview> {
  const response = await apiFetch('/api/external-capabilities/review', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ proposal }),
  });
  const data = await responseJson(response);
  if (!response.ok) throw apiError(data, response, 'External capability review failed');
  const review = normalizeExternalCapabilityReview(data, proposal);
  if (!review.reviewNonce) throw new Error('External capability review returned no approval nonce');
  return review;
}

export async function activateExternalCapability(
  proposal: Record<string, unknown>,
  reviewNonce: string,
): Promise<JsonRecord> {
  const response = await apiFetch('/api/external-capabilities/activate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ proposal, reviewNonce }),
  });
  const data = await responseJson(response);
  if (!response.ok) throw apiError(data, response, 'External capability activation failed');
  return data;
}

export async function deactivateExternalCapability(
  capabilityId: string,
): Promise<JsonRecord> {
  const response = await apiFetch(`/api/external-capabilities/${encodeURIComponent(capabilityId)}/deactivate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
  });
  const data = await responseJson(response);
  if (!response.ok) throw apiError(data, response, 'External capability deactivation failed');
  return data;
}

const FAILED_EXECUTION_STATUSES = new Set([
  'failed',
  'blocked',
  'cancelled',
  'canceled',
  'rejected',
  'unavailable',
  'unknown_outcome',
]);

export async function executeExternalCapabilityAction(
  capabilityId: string,
  actionId: string,
  args: Record<string, unknown> = {},
  correlation: ExternalCapabilityExecutionCorrelation = createExternalCapabilityExecutionCorrelation(),
): Promise<ExternalCapabilityExecution> {
  const response = await apiFetch(`/api/external-capabilities/${encodeURIComponent(capabilityId)}/actions/${encodeURIComponent(actionId)}/execute`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      arguments: args,
      requestId: correlation.requestId,
      idempotencyKey: correlation.idempotencyKey,
    }),
  });
  const data = await responseJson(response);
  if (!response.ok) throw apiError(data, response, 'External capability action failed');
  const execution = asRecord(data.execution);
  const status = asString(execution.status || data.status);
  const error = asString(execution.error || data.error);
  if (error || FAILED_EXECUTION_STATUSES.has(status.toLowerCase())) {
    throw new Error(error || `External capability action ended with status ${status}`);
  }
  const receiptId = asString(execution.receiptId || data.receiptId);
  if (!receiptId || !status) {
    throw new Error('External capability action returned no execution receipt');
  }
  return {
    receiptId,
    status,
    toolName: asString(execution.toolName || data.toolName),
    result: execution.result,
    error: error || undefined,
    terminalVerification: execution.terminalVerification,
  };
}

export function getExternalCapabilityLaunchAction(
  capability: ExternalCapabilityProjection,
): ExternalCapabilityAction | undefined {
  const launchActionId = capability.presentation.launchActionId;
  if (!launchActionId) return undefined;
  return capability.actions.find(action => action.id === launchActionId);
}

export function getDesktopExternalCapabilities(
  capabilities: ExternalCapabilityProjection[],
): Array<{ capability: ExternalCapabilityProjection; action: ExternalCapabilityAction }> {
  return capabilities.flatMap(capability => {
    if (capability.availability !== 'ready') return [];
    if (!capability.presentation.placements.some(placement => placement.toLowerCase() === 'desktop')) return [];
    const action = getExternalCapabilityLaunchAction(capability);
    return action?.availability === 'ready' ? [{ capability, action }] : [];
  });
}

export function canUseExternalCapabilitiesForSurface(input: {
  isTauri: boolean;
  workDomain: string;
  userId?: string | null;
}): boolean {
  return Boolean(input.isTauri && input.userId && input.workDomain === 'personal');
}
