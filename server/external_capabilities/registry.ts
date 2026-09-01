import crypto from 'node:crypto';
import { flushDBOrThrow, readDB, writeDB } from '../../db_layer';
import { listExtensionRuntimeSnapshots } from '../extensions/registry';
import { executeToolCall, isCanonicalToolExecutionRecord } from '../tools/execution_engine';
import { externalCommitInputDigest, type ToolRegistry } from '../tools/registry';
import type { CapabilityManifestEntry, ToolContext, ToolDefinition, ToolExecutionRecord } from '../tools/types';
import { hasAutonomousHostAuthority } from '../tools/host_execution_authority';
import {
  assertExternalCapabilityArguments,
  externalCapabilityProposalDigest,
  normalizeExternalCapabilityProposal,
  type ExternalCapabilityActionProposal,
  type ExternalCapabilityPackageProposal,
} from './schema';
import {
  resolveExternalCapabilityCredentialBinding,
  sameExternalCapabilityCredentialRevision,
} from './credential_binding';

export type ExternalCapabilityStage = 'configured' | 'connected' | 'verified' | 'automatic';
export type ExternalCapabilityAvailability = 'ready' | 'unavailable';

interface ResolvedActionSnapshot {
  actionId: string;
  runtimeRef: string;
  toolName: string;
  proxyToolName: string;
  capabilityId: string;
  source: CapabilityManifestEntry['source'];
  provider: string;
  executable: boolean;
  requiresConfirmation: boolean;
  permission: CapabilityManifestEntry['permission'];
  risk: CapabilityManifestEntry['risk'];
  sideEffects: CapabilityManifestEntry['sideEffects'];
  runtimeIdentityDigest: string;
}

export interface ExternalCapabilityPackageRow {
  id: string;
  ownerUserId: string;
  capabilityId: string;
  version: string;
  status: 'reviewed' | 'active' | 'inactive';
  packageDigest: string;
  /** Installation-keyed internal revision; never project through routes/manifests. */
  credentialBindingRevision: string;
  proposal: ExternalCapabilityPackageProposal;
  resolvedActions: ResolvedActionSnapshot[];
  availability: ExternalCapabilityAvailability;
  unavailableReason: string;
  createdAt: string;
  reviewedAt: string;
  activatedAt: string;
  updatedAt: string;
  lastHydratedAt: string;
}

interface ExternalCapabilityReceiptRow {
  id: string;
  packageRowId: string;
  ownerUserId: string;
  capabilityId: string;
  actionId: string;
  kind: 'review' | 'activation' | 'execution';
  status: string;
  hostVerified: boolean;
  toolName: string;
  runtimeIdentityDigest?: string;
  credentialBindingRevision?: string;
  terminalVerification?: ToolExecutionRecord['terminalVerification'];
  envelope?: ToolExecutionRecord['envelope'];
  errorDigest?: string;
  requestId?: string;
  idempotencyKey?: string;
  inputDigest?: string;
  persistenceState?: 'persisted' | 'pending';
  canonicalOutcome?: {
    recordId: string;
    status: string;
    hostVerified: boolean;
    toolName: string;
    underlyingToolName: string;
    terminalVerification?: ToolExecutionRecord['terminalVerification'];
  };
  persistenceErrorDigest?: string;
  createdAt: string;
}

interface ReviewApproval {
  ownerUserId: string;
  packageRowId: string;
  capabilityId: string;
  version: string;
  packageDigest: string;
  credentialBindingRevision: string;
  desktopSessionDigest: string;
  expiresAt: number;
}

export interface ExternalCapabilityProjection {
  id: string;
  version: string;
  name: string;
  description: string;
  stage: ExternalCapabilityStage;
  availability: ExternalCapabilityAvailability;
  unavailableReason?: string;
  presentation: ExternalCapabilityPackageProposal['presentation'];
  runtimeRefs: ExternalCapabilityPackageProposal['runtimeRefs'];
  guidance: ExternalCapabilityPackageProposal['guidance'];
  actions: Array<{
    id: string;
    label: string;
    description: string;
    icon?: string;
    capabilityId: string;
    toolName: string;
    underlyingToolName: string;
    executionMode: ExternalCapabilityActionProposal['executionMode'];
    requiresConfirmation: boolean;
    availability: ExternalCapabilityAvailability;
    verification: {
      status: 'never' | 'verified' | 'unverified' | 'failed';
      lastVerifiedAt?: string;
      verifiedRuns: number;
    };
  }>;
  activatedAt: string;
  updatedAt: string;
}

const REVIEW_APPROVAL_TTL_MS = 15 * 60_000;
const PROXY_TOOL_PREFIX = 'external_capability_action_';
const reviewApprovals = new Map<string, ReviewApproval>();
const registeredProxyNames = new WeakMap<ToolRegistry, Set<string>>();
let persistenceOverride: (() => Promise<void>) | null = null;

async function persistStrict(): Promise<void> {
  await (persistenceOverride || flushDBOrThrow)();
}

function arrays(): {
  packages: ExternalCapabilityPackageRow[];
  receipts: ExternalCapabilityReceiptRow[];
} {
  const db = readDB();
  if (!Array.isArray(db.externalCapabilityPackages)) db.externalCapabilityPackages = [];
  if (!Array.isArray(db.externalCapabilityReceipts)) db.externalCapabilityReceipts = [];
  return {
    packages: db.externalCapabilityPackages,
    receipts: db.externalCapabilityReceipts,
  };
}

function stableRowId(
  ownerUserId: string,
  proposal: ExternalCapabilityPackageProposal,
  digest: string,
  actions: ResolvedActionSnapshot[],
  credentialBindingRevision: string,
): string {
  return `extcap_${crypto.createHash('sha256')
    .update(`${ownerUserId}\0${proposal.id}\0${proposal.version}\0${digest}\0${credentialBindingRevision}\0${actions.map(action => action.runtimeIdentityDigest).join(':')}`)
    .digest('hex')}`;
}

function proxyToolName(
  ownerUserId: string,
  capabilityId: string,
  actionId: string,
  packageDigest: string,
  runtimeDigest: string,
  credentialBindingRevision: string,
): string {
  return `${PROXY_TOOL_PREFIX}${crypto.createHash('sha256')
    .update(`${ownerUserId}\0${capabilityId}\0${actionId}\0${packageDigest}\0${runtimeDigest}\0${credentialBindingRevision}`)
    .digest('hex')
    .slice(0, 32)}`;
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value as Record<string, unknown>)
    .sort()
    .map(key => [key, stableValue((value as Record<string, unknown>)[key])]));
}

function runtimeIdentityDigest(manifest: CapabilityManifestEntry, definition: ToolDefinition): string {
  const functionDigest = (fn: unknown) => typeof fn === 'function'
    ? crypto.createHash('sha256').update(Function.prototype.toString.call(fn)).digest('hex')
    : '';
  return crypto.createHash('sha256').update(JSON.stringify(stableValue({
    toolName: manifest.toolName,
    capabilityId: manifest.capabilityId,
    source: manifest.source,
    provider: manifest.provider || '',
    family: manifest.family,
    lane: manifest.lane,
    permission: manifest.permission,
    securityLevel: definition.securityLevel,
    parameters: definition.parameters,
    operation: manifest.operation,
    modes: manifest.modes,
    modeSecurity: manifest.modeSecurity,
    domains: manifest.domains,
    intents: manifest.intents,
    risk: manifest.risk,
    sideEffects: manifest.sideEffects,
    assurance: manifest.assurance,
    evidence: manifest.evidence,
    verification: manifest.verification,
    fallbacks: manifest.fallbacks,
    provenance: manifest.provenance,
    adapter: manifest.adapter,
    reconciliation: manifest.reconciliation,
    deprecated: manifest.deprecated,
    replacedBy: manifest.replacedBy || '',
    prerequisites: manifest.prerequisites,
    handlerDigest: functionDigest(definition.handler),
    preflightDigest: functionDigest(definition.preflight),
    reconciliationDigest: functionDigest(definition.reconcileExternalCommit),
    serverOwnedArgumentBinderDigest: functionDigest(definition.serverOwnedArgumentBinder),
    semanticToolName: definition.semanticToolName || '',
    localIdempotencyReplay: definition.localIdempotencyReplay || 'cached_result',
  }))).digest('hex');
}

function runtimeSource(kind: ExternalCapabilityPackageProposal['runtimeRefs'][number]['kind']): CapabilityManifestEntry['source'] {
  return kind === 'signed_extension' ? 'adapter' : kind;
}

function requiredToolArguments(definition: ToolDefinition): string[] {
  const parameters = definition.parameters || {};
  if (parameters.type === 'object' && parameters.properties) {
    return Array.isArray(parameters.required) ? parameters.required.map(String) : [];
  }
  return Object.entries(parameters)
    .filter(([, descriptor]) => Boolean(
      descriptor && typeof descriptor === 'object' && (descriptor as Record<string, unknown>).required === true,
    ))
    .map(([name]) => name);
}

function resolveProposalActions(
  proposal: ExternalCapabilityPackageProposal,
  ownerUserId: string,
  registry: ToolRegistry,
  credentialBindingRevision: string,
): { actions: ResolvedActionSnapshot[]; availability: ExternalCapabilityAvailability; reason: string } {
  const signedSnapshots = proposal.runtimeRefs.some(runtime => runtime.kind === 'signed_extension')
    ? listExtensionRuntimeSnapshots({ userId: ownerUserId, toolRegistry: registry }, registry)
    : [];
  const actions: ResolvedActionSnapshot[] = [];
  for (const action of proposal.actions) {
    const runtimeRef = proposal.runtimeRefs.find(runtime => runtime.id === action.runtimeRef);
    if (!runtimeRef) {
      return { actions, availability: 'unavailable', reason: `Action '${action.id}' references a missing runtime.` };
    }
    if (action.executionMode === 'automatic_candidate' && runtimeRef.kind !== 'builtin') {
      return {
        actions,
        availability: 'unavailable',
        reason: 'Automatic execution is unavailable for provider-owned skill, MCP, or adapter runtimes without a host-corroborated completion path. Use assisted mode.',
      };
    }
    const expectedSource = runtimeSource(runtimeRef.kind);
    const signedRuntime = runtimeRef.kind === 'signed_extension'
      ? signedSnapshots.find(snapshot => (
        snapshot.extensionId === runtimeRef.provider
        && snapshot.manifestDigest === runtimeRef.manifestDigest
      ))
      : undefined;
    if (runtimeRef.kind === 'signed_extension' && (!signedRuntime || !signedRuntime.usable)) {
      return {
        actions,
        availability: 'unavailable',
        reason: `The exact reviewed signed-extension runtime '${runtimeRef.id}' is not active and usable.`,
      };
    }
    const manifest = registry.getCapabilityManifestEntry(action.tool.name);
    const definition = registry.get(action.tool.name);
    if (action.tool.name.startsWith(PROXY_TOOL_PREFIX)) {
      return { actions, availability: 'unavailable', reason: 'An external capability action cannot reference another package proxy.' };
    }
    if (!manifest || !definition) {
      return { actions, availability: 'unavailable', reason: `Tool '${action.tool.name}' is not registered.` };
    }
    if (manifest.capabilityId !== action.tool.capabilityId) {
      return { actions, availability: 'unavailable', reason: `Tool '${action.tool.name}' capability identity changed.` };
    }
    if (manifest.source !== expectedSource) {
      return { actions, availability: 'unavailable', reason: `Tool '${action.tool.name}' runtime source does not match the package.` };
    }
    if (runtimeRef.kind !== 'builtin' && manifest.provider !== runtimeRef.provider) {
      return { actions, availability: 'unavailable', reason: `Tool '${action.tool.name}' provider does not match the package.` };
    }
    if (manifest.permission === 'system') {
      return { actions, availability: 'unavailable', reason: `System tool '${action.tool.name}' cannot be exposed by an external capability package.` };
    }
    if (!manifest.executable) {
      return { actions, availability: 'unavailable', reason: `Tool '${action.tool.name}' is not currently executable.` };
    }
    const permittedArguments = new Set(manifest.parameterNames);
    const requestedArguments = [
      ...Object.keys(action.tool.fixedArguments),
      ...action.tool.userArgumentNames,
    ];
    const unsupportedArgument = requestedArguments.find(name => !permittedArguments.has(name));
    if (unsupportedArgument) {
      return {
        actions,
        availability: 'unavailable',
        reason: `Tool '${action.tool.name}' does not declare argument '${unsupportedArgument}'.`,
      };
    }
    if (
      signedRuntime
      && !signedRuntime.registeredToolNames.includes(action.tool.name)
    ) {
      return { actions, availability: 'unavailable', reason: `Tool '${action.tool.name}' is not owned by the pinned signed revision.` };
    }
    actions.push({
      actionId: action.id,
      runtimeRef: runtimeRef.id,
      toolName: manifest.toolName,
      proxyToolName: proxyToolName(
        ownerUserId,
        proposal.id,
        action.id,
        externalCapabilityProposalDigest(proposal),
        runtimeIdentityDigest(manifest, definition),
        credentialBindingRevision,
      ),
      capabilityId: manifest.capabilityId,
      source: manifest.source,
      provider: manifest.provider || '',
      executable: manifest.executable,
      requiresConfirmation: manifest.requiresConfirmation,
      permission: manifest.permission,
      risk: manifest.risk,
      sideEffects: manifest.sideEffects.map(effect => ({ ...effect })),
      runtimeIdentityDigest: runtimeIdentityDigest(manifest, definition),
    });
  }
  const launchActionId = proposal.presentation.launchActionId;
  if (proposal.presentation.placements.includes('desktop') && launchActionId) {
    const launchAction = proposal.actions.find(action => action.id === launchActionId)!;
    const launchSnapshot = actions.find(action => action.actionId === launchActionId)!;
    const launchDefinition = registry.get(launchSnapshot.toolName)!;
    const required = requiredToolArguments(launchDefinition);
    const missingFixed = required.filter(name => !Object.prototype.hasOwnProperty.call(launchAction.tool.fixedArguments, name));
    const hasExternalCommit = launchSnapshot.sideEffects.some(effect => (
      effect.type === 'external_communication' || effect.type === 'external_state_change'
    ));
    if (
      launchAction.tool.userArgumentNames.length > 0
      || launchSnapshot.requiresConfirmation
      || hasExternalCommit
      || missingFixed.length > 0
    ) {
      return {
        actions,
        availability: 'unavailable',
        reason: 'The desktop launch action must be safe, input-free, non-committing, and fully bound by server-owned fixed arguments.',
      };
    }
  }
  return { actions, availability: 'ready', reason: '' };
}

function resolveReviewedRowRuntime(
  row: ExternalCapabilityPackageRow,
  registry: ToolRegistry,
): { actions: ResolvedActionSnapshot[]; availability: ExternalCapabilityAvailability; reason: string } {
  try {
    const proposal = normalizeExternalCapabilityProposal(row?.proposal);
    if (externalCapabilityProposalDigest(proposal) !== String(row?.packageDigest || '').trim().toLowerCase()) {
      return {
        actions: [],
        availability: 'unavailable',
        reason: 'The persisted external capability package no longer matches its reviewed digest.',
      };
    }
    const credentialBinding = resolveExternalCapabilityCredentialBinding(
      String(row?.ownerUserId || ''),
      proposal.credentialRefs,
    );
    if (!credentialBinding.available) {
      return {
        actions: [],
        availability: 'unavailable',
        reason: credentialBinding.invalidReference
          ? 'The reviewed package contains a credential reference outside the approved secure key store.'
          : 'One or more reviewed credentials are not configured.',
      };
    }
    if (!sameExternalCapabilityCredentialRevision(row?.credentialBindingRevision, credentialBinding.revision)) {
      return {
        actions: [],
        availability: 'unavailable',
        reason: 'The reviewed credential revision changed. Review and activate the package again.',
      };
    }
    const current = resolveProposalActions(
      proposal,
      String(row?.ownerUserId || ''),
      registry,
      credentialBinding.revision,
    );
    if (current.availability !== 'ready') return current;
    const reviewedActions = Array.isArray(row?.resolvedActions) ? row.resolvedActions : [];
    const matchesReview = current.actions.length === reviewedActions.length
      && current.actions.every((action, index) => {
        const reviewed = reviewedActions[index];
        return reviewed
          && action.actionId === reviewed.actionId
          && action.runtimeRef === reviewed.runtimeRef
          && action.toolName === reviewed.toolName
          && action.proxyToolName === reviewed.proxyToolName
          && action.capabilityId === reviewed.capabilityId
          && action.source === reviewed.source
          && action.provider === reviewed.provider
          && action.runtimeIdentityDigest === reviewed.runtimeIdentityDigest;
      });
    return matchesReview
      ? current
      : {
          actions: [],
          availability: 'unavailable',
          reason: 'A referenced tool runtime changed after review; review and activate the package again.',
        };
  } catch {
    return {
      actions: [],
      availability: 'unavailable',
      reason: 'The persisted external capability package is invalid and was not loaded.',
    };
  }
}

function mergeActionArguments(
  action: ExternalCapabilityActionProposal,
  suppliedInput: unknown,
): Record<string, unknown> {
  const supplied = assertExternalCapabilityArguments(suppliedInput);
  const allowed = new Set(action.tool.userArgumentNames);
  const fixed = structuredClone(action.tool.fixedArguments);
  const userArguments: Record<string, unknown> = {};
  const unexpected: string[] = [];
  for (const [key, value] of Object.entries(supplied)) {
    if (Object.prototype.hasOwnProperty.call(fixed, key)) {
      if (JSON.stringify(stableValue(value)) !== JSON.stringify(stableValue(fixed[key]))) {
        throw new Error(`Server-owned action argument '${key}' cannot be overridden.`);
      }
      continue;
    }
    if (!allowed.has(key)) unexpected.push(key);
    else userArguments[key] = value;
  }
  if (unexpected.length) throw new Error(`Unsupported action argument(s): ${unexpected.join(', ')}.`);
  return {
    ...fixed,
    ...userArguments,
  };
}

function actionAutomaticReady(
  row: ExternalCapabilityPackageRow,
  actionId: string,
  registry: ToolRegistry,
): boolean {
  try {
    const projected = projectRow(row, registry, arrays().receipts);
    return projected.stage === 'automatic'
      && projected.availability === 'ready'
      && projected.actions.some(action => action.id === actionId && action.availability === 'ready');
  } catch {
    return false;
  }
}

function projectedActionParameters(
  definition: ToolDefinition,
  action: ExternalCapabilityActionProposal,
): Record<string, unknown> {
  const raw = definition.parameters || {};
  let properties: Record<string, unknown> = {};
  let required: string[] = [];
  if (raw.type === 'object' && raw.properties && typeof raw.properties === 'object') {
    properties = raw.properties;
    required = Array.isArray(raw.required) ? raw.required.map(String) : [];
  } else {
    properties = Object.fromEntries(Object.entries(raw).map(([name, descriptor]) => {
      const value = descriptor && typeof descriptor === 'object'
        ? descriptor as Record<string, unknown>
        : {};
      if (value.required === true) required.push(name);
      return [name, Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'required'))];
    }));
  }
  const exposed = new Set(action.tool.userArgumentNames);
  return {
    type: 'object',
    properties: Object.fromEntries(Object.entries(properties).filter(([name]) => exposed.has(name))),
    required: required.filter(name => exposed.has(name)),
    additionalProperties: false,
  };
}

function createActionProxy(
  row: ExternalCapabilityPackageRow,
  action: ExternalCapabilityActionProposal,
  snapshot: ResolvedActionSnapshot,
  registry: ToolRegistry,
): ToolDefinition {
  const pinnedTarget = registry.get(snapshot.toolName);
  const pinnedManifest = registry.getCapabilityManifestEntry(snapshot.toolName);
  if (!pinnedTarget || !pinnedManifest) throw new Error(`Underlying tool '${snapshot.toolName}' is unavailable.`);
  if (runtimeIdentityDigest(pinnedManifest, pinnedTarget) !== snapshot.runtimeIdentityDigest) {
    throw new Error(`Underlying tool '${snapshot.toolName}' changed after package review.`);
  }
  const assertPinnedRuntime = (context?: ToolContext): void => {
    const credentialBinding = resolveExternalCapabilityCredentialBinding(
      row.ownerUserId,
      row.proposal.credentialRefs,
    );
    if (!credentialBinding.available) {
      throw new Error('The reviewed external capability credentials are not configured.');
    }
    if (!sameExternalCapabilityCredentialRevision(row.credentialBindingRevision, credentialBinding.revision)) {
      throw new Error('The reviewed external capability credential revision changed; review and activate the package again.');
    }
    const trustedAutomaticTask = action.executionMode === 'automatic_candidate'
      && actionAutomaticReady(row, action.id, registry)
      && hasAutonomousHostAuthority(context, row.ownerUserId);
    if (!trustedAutomaticTask && (
      context?.authenticated !== true
      || context.userId !== row.ownerUserId
      || context.localExecution !== true
      || context.executionBoundary !== 'trusted_local'
    )) {
      throw new Error('External capability actions require the owning authenticated user on the trusted local desktop boundary.');
    }
    const currentTarget = registry.get(snapshot.toolName);
    const currentManifest = registry.getCapabilityManifestEntry(snapshot.toolName);
    if (
      currentTarget !== pinnedTarget
      || !currentManifest
      || runtimeIdentityDigest(currentManifest, currentTarget) !== snapshot.runtimeIdentityDigest
    ) {
      throw new Error(`External capability runtime for '${snapshot.toolName}' changed; review and activate the package again.`);
    }
  };
  return {
    name: snapshot.proxyToolName,
    internalVisibility: {
      ownerUserId: row.ownerUserId,
      personalOnly: true,
      modelAccess: action.executionMode === 'manual'
        ? 'hidden'
        : action.executionMode === 'assisted'
          ? 'foreground'
          : 'automatic_candidate',
      automaticReady: () => actionAutomaticReady(row, action.id, registry),
    },
    semanticToolName: snapshot.toolName,
    serverOwnedArgumentBinder: (args, context) => {
      assertPinnedRuntime(context);
      return mergeActionArguments(action, args);
    },
    description: [
      `${row.proposal.name} — ${action.description}`,
      row.proposal.guidance.whenToUse.slice(0, 3).length
        ? `Use when: ${row.proposal.guidance.whenToUse.slice(0, 3).join('; ')}`
        : '',
      row.proposal.guidance.whenNotToUse.slice(0, 2).length
        ? `Do not use when: ${row.proposal.guidance.whenNotToUse.slice(0, 2).join('; ')}`
        : '',
      row.proposal.guidance.steps.slice(0, 4).length
        ? `Steps: ${row.proposal.guidance.steps.slice(0, 4).join('; ')}`
        : '',
      row.proposal.guidance.completionRules.slice(0, 3).length
        ? `Completion requires: ${row.proposal.guidance.completionRules.slice(0, 3).join('; ')}`
        : '',
    ].filter(Boolean).join(' ').slice(0, 1_500),
    parameters: projectedActionParameters(pinnedTarget, action),
    permission: pinnedTarget.permission,
    securityLevel: pinnedTarget.securityLevel,
    routingHints: Array.from(new Set([
      ...(pinnedTarget.routingHints || []),
      ...row.proposal.guidance.triggerHints,
      action.label,
      row.proposal.name,
    ])).slice(0, 32),
    capability: {
      id: pinnedManifest.capabilityId,
      family: pinnedManifest.family,
      lane: pinnedManifest.lane,
      source: pinnedManifest.source,
      ...(pinnedManifest.provider ? { provider: pinnedManifest.provider } : {}),
      operation: pinnedManifest.operation,
      domains: [...pinnedManifest.domains],
      intents: [...pinnedManifest.intents],
      modes: [...pinnedManifest.modes],
      risk: pinnedManifest.risk,
      sideEffects: structuredClone(pinnedManifest.sideEffects),
      verification: structuredClone(pinnedManifest.verification),
      fallbacks: structuredClone(pinnedManifest.fallbacks),
      provenance: structuredClone(pinnedManifest.provenance),
      ...(pinnedManifest.adapter ? { adapter: structuredClone(pinnedManifest.adapter) } : {}),
      ...(pinnedManifest.reconciliation ? { reconciliation: structuredClone(pinnedManifest.reconciliation) } : {}),
      deprecated: pinnedManifest.deprecated,
      ...(pinnedManifest.replacedBy ? { replacedBy: pinnedManifest.replacedBy } : {}),
      modeSecurity: structuredClone(pinnedManifest.modeSecurity),
      prerequisites: Array.from(new Set([
        ...pinnedManifest.prerequisites,
        `reviewed external package ${row.packageDigest}`,
        `owner binding ${crypto.createHash('sha256').update(row.ownerUserId).digest('hex').slice(0, 24)}`,
      ])),
    },
    evidence: pinnedTarget.evidence
      ? structuredClone(pinnedTarget.evidence)
      : {
          capability: pinnedManifest.evidence?.capability || pinnedManifest.capabilityId,
          operation: pinnedManifest.operation === 'unknown' ? 'mutate' : pinnedManifest.operation,
          assurance: pinnedManifest.assurance === 'none' ? 'declared' : pinnedManifest.assurance,
          limitations: [
            ...(pinnedManifest.evidence?.limitations || []),
            'This reviewed package proxy preserves the underlying host verification contract.',
          ],
        },
    localIdempotencyReplay: pinnedTarget.localIdempotencyReplay,
    preflight: async (args, context) => {
      assertPinnedRuntime(context);
      const merged = mergeActionArguments(action, args);
      await pinnedTarget.preflight?.(merged, context);
    },
    handler: async (args, context) => {
      assertPinnedRuntime(context);
      return pinnedTarget.handler(mergeActionArguments(action, args), context);
    },
    ...(pinnedTarget.reconcileExternalCommit ? {
      reconcileExternalCommit: async (args: Record<string, any>, context: ToolContext | undefined, idempotencyKey: string) => {
        assertPinnedRuntime(context);
        return pinnedTarget.reconcileExternalCommit!(mergeActionArguments(action, args), context, idempotencyKey);
      },
    } : {}),
  };
}

function unregisterExternalCapabilityProxies(registry: ToolRegistry): void {
  const names = registeredProxyNames.get(registry);
  if (!names) return;
  for (const name of names) registry.unregister(name);
  registeredProxyNames.delete(registry);
}

function registerExternalCapabilityProxies(
  registry: ToolRegistry,
  activeRows: ExternalCapabilityPackageRow[],
): { registered: number; failed: number } {
  unregisterExternalCapabilityProxies(registry);
  const names = new Set<string>();
  let failed = 0;
  const newestRows: ExternalCapabilityPackageRow[] = [];
  const claimed = new Set<string>();
  for (const row of [...activeRows].sort((left, right) => String(right?.activatedAt || '').localeCompare(String(left?.activatedAt || '')))) {
    const identity = `${String(row?.ownerUserId || '')}\0${String(row?.capabilityId || '')}`;
    if (claimed.has(identity)) continue;
    claimed.add(identity);
    newestRows.push(row);
  }
  for (const row of newestRows) {
    const runtime = resolveReviewedRowRuntime(row, registry);
    if (runtime.availability !== 'ready') {
      failed += Array.isArray(row?.proposal?.actions) ? row.proposal.actions.length : 1;
      continue;
    }
    let proposal: ExternalCapabilityPackageProposal;
    try {
      proposal = normalizeExternalCapabilityProposal(row.proposal);
    } catch {
      failed += 1;
      continue;
    }
    for (const action of proposal.actions) {
      const snapshot = runtime.actions.find(candidate => candidate.actionId === action.id);
      if (!snapshot) {
        failed += 1;
        continue;
      }
      try {
        if (!registry.register(createActionProxy(row, action, snapshot, registry))) {
          throw new Error(`Proxy name '${snapshot.proxyToolName}' is already registered.`);
        }
        names.add(snapshot.proxyToolName);
      } catch {
        failed += 1;
      }
    }
  }
  registeredProxyNames.set(registry, names);
  return { registered: names.size, failed };
}

function receiptVerificationStatus(
  receipt: ExternalCapabilityReceiptRow | undefined,
): 'never' | 'verified' | 'unverified' | 'failed' {
  if (!receipt) return 'never';
  const status = receipt.terminalVerification?.status;
  return status === 'verified' || status === 'unverified' || status === 'failed' ? status : 'never';
}

function projectRow(
  row: ExternalCapabilityPackageRow,
  registry: ToolRegistry,
  receipts: ExternalCapabilityReceiptRow[],
): ExternalCapabilityProjection {
  const proposal = normalizeExternalCapabilityProposal(row.proposal);
  if (externalCapabilityProposalDigest(proposal) !== String(row.packageDigest || '').trim().toLowerCase()) {
    throw new Error('The persisted external capability package does not match its reviewed digest.');
  }
  const runtime = resolveReviewedRowRuntime(row, registry);
  const currentByAction = new Map(runtime.actions.map(action => [action.actionId, action]));
  const executionReceipts = receipts
    .map((receipt, index) => ({ receipt, index }))
    .filter(({ receipt }) => (
      receipt.kind === 'execution'
      && receipt.packageRowId === row.id
      && sameExternalCapabilityCredentialRevision(
        receipt.credentialBindingRevision,
        row.credentialBindingRevision,
      )
    ))
    .sort((left, right) => (
      right.receipt.createdAt.localeCompare(left.receipt.createdAt)
      || right.index - left.index
    ))
    .map(({ receipt }) => receipt);
  const latestByAction = new Map<string, ExternalCapabilityReceiptRow>();
  const db = readDB();
  const taskOwner = new Map((db.conversationActionTasks || []).map((task: any) => [String(task.id || ''), String(task.userId || '')]));
  const conversationReceipts = (db.conversationActionReceipts || []).flatMap((receipt: any, index: number) => {
    if (
      taskOwner.get(String(receipt.taskId || '')) !== row.ownerUserId
      || String(receipt.createdAt || '').localeCompare(row.activatedAt || '') < 0
    ) return [];
    let envelope: Record<string, any> = {};
    try {
      const parsed = typeof receipt.envelope === 'string' ? JSON.parse(receipt.envelope || '{}') : receipt.envelope;
      if (parsed && typeof parsed === 'object') envelope = parsed;
    } catch {}
    const status = String(envelope.status || receipt.outcome || 'unknown_outcome');
    const hostVerified = status === 'verified_success'
      && String(receipt.outcome || '') === 'verified_success'
      && envelope.verification?.status === 'verified'
      && envelope.verification?.basis === 'terminal_verification';
    return [{
      id: String(receipt.id || ''),
      toolName: String(receipt.toolName || ''),
      createdAt: String(receipt.createdAt || ''),
      status,
      hostVerified,
      verificationStatus: String(envelope.verification?.status || 'never'),
      index,
    }];
  });
  const verifiedRunCounts = new Map<string, number>();
  const latestConversationVerification = new Map<string, string>();
  const latestOutcomeRevokesAutomatic = new Map<string, boolean>();
  const latestActionVerificationStatus = new Map<string, 'never' | 'verified' | 'unverified' | 'failed'>();
  for (const action of Array.isArray(row.resolvedActions) ? row.resolvedActions : []) {
    const externalRelevant = executionReceipts.filter(receipt => (
      receipt.actionId === action.actionId
      && receipt.runtimeIdentityDigest === action.runtimeIdentityDigest
      && receipt.createdAt.localeCompare(row.activatedAt || '') >= 0
    ));
    const conversationRelevant = conversationReceipts.filter(receipt => receipt.toolName === action.proxyToolName);
    const externalRuns = externalRelevant.filter(receipt => (
      receipt.hostVerified
      && receipt.status === 'verified_success'
      && receipt.terminalVerification?.status === 'verified'
    ));
    const conversationRuns = conversationRelevant.filter(receipt => receipt.hostVerified);
    verifiedRunCounts.set(action.actionId, externalRuns.length + conversationRuns.length);
    const latest = [...externalRuns.map(receipt => receipt.createdAt), ...conversationRuns.map(receipt => receipt.createdAt)]
      .sort((left, right) => right.localeCompare(left))[0];
    if (latest) latestConversationVerification.set(action.actionId, latest);
    const latestExternalReceipt = externalRelevant[0];
    const latestConversationReceipt = [...conversationRelevant]
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt) || right.index - left.index)[0];
    const events = [
      ...(latestExternalReceipt ? [{
        createdAt: latestExternalReceipt.createdAt,
        status: latestExternalReceipt.status,
        verificationStatus: latestExternalReceipt.terminalVerification?.status || 'never',
        verified: latestExternalReceipt.hostVerified
          && latestExternalReceipt.status === 'verified_success'
          && latestExternalReceipt.terminalVerification?.status === 'verified',
      }] : []),
      ...(latestConversationReceipt ? [{
        createdAt: latestConversationReceipt.createdAt,
        status: latestConversationReceipt.status,
        verificationStatus: latestConversationReceipt.verificationStatus,
        verified: latestConversationReceipt.hostVerified,
      }] : []),
    ];
    const latestCreatedAt = events.map(event => event.createdAt)
      .sort((left, right) => right.localeCompare(left))[0];
    const latestEvents = latestCreatedAt
      ? events.filter(event => event.createdAt === latestCreatedAt)
      : [];
    // Equal timestamps are intentionally conservative: any terminal failure or
    // unknown at the newest instant revokes automation until a later verified run.
    const latestRevokes = latestEvents.some(event => !event.verified);
    latestOutcomeRevokesAutomatic.set(action.actionId, latestRevokes);
    if (latestEvents.length > 0 && latestRevokes) {
      const explicitlyFailed = latestEvents.some(event => (
        event.verificationStatus === 'failed'
        || /(?:failed|denied|blocked|cancelled|timeout|target_mismatch)/i.test(event.status)
      ));
      latestActionVerificationStatus.set(action.actionId, explicitlyFailed ? 'failed' : 'unverified');
    } else if (latestEvents.some(event => event.verified)) {
      latestActionVerificationStatus.set(action.actionId, 'verified');
    }
  }
  for (const receipt of executionReceipts) {
    if (!latestByAction.has(receipt.actionId)) latestByAction.set(receipt.actionId, receipt);
  }
  const acceptanceSatisfied = proposal.acceptance.requiredActionIds.every(actionId => (
    (verifiedRunCounts.get(actionId) || 0) >= proposal.acceptance.minimumVerifiedRuns
  ));
  const acceptanceCurrentlyHealthy = acceptanceSatisfied
    && proposal.acceptance.requiredActionIds.every(actionId => !latestOutcomeRevokesAutomatic.get(actionId));
  const automaticCandidates = proposal.actions.filter(action => action.executionMode === 'automatic_candidate');
  const automaticReady = acceptanceCurrentlyHealthy
    && automaticCandidates.length > 0
    && automaticCandidates.every(action => proposal.acceptance.requiredActionIds.includes(action.id))
    && automaticCandidates.every(action => !latestOutcomeRevokesAutomatic.get(action.id))
    && automaticCandidates.every(action => {
      const manifest = currentByAction.get(action.id);
      return manifest?.executable === true && manifest.requiresConfirmation === false;
    });
  const proxiesReady = runtime.availability === 'ready'
    && runtime.actions.length === proposal.actions.length
    && runtime.actions.every(action => Boolean(registry.get(action.proxyToolName)));
  const availability: ExternalCapabilityAvailability = proxiesReady ? 'ready' : 'unavailable';
  const unavailableReason = runtime.reason || (!proxiesReady ? 'The reviewed package proxy is not hydrated in the current runtime.' : '');
  const stage: ExternalCapabilityStage = availability !== 'ready'
    ? 'configured'
    : automaticReady
      ? 'automatic'
      : acceptanceCurrentlyHealthy
        ? 'verified'
        : 'connected';
  return {
    id: row.capabilityId,
    version: row.version,
    name: proposal.name,
    description: proposal.description,
    stage,
    availability,
    ...(unavailableReason ? { unavailableReason } : {}),
    presentation: structuredClone(proposal.presentation),
    runtimeRefs: structuredClone(proposal.runtimeRefs),
    guidance: structuredClone(proposal.guidance),
    actions: proposal.actions.map(action => {
      const resolved = currentByAction.get(action.id);
      const latest = latestByAction.get(action.id);
      const verifiedAt = latestConversationVerification.get(action.id);
      const verifiedRuns = verifiedRunCounts.get(action.id) || 0;
      return {
        id: action.id,
        label: action.label,
        description: action.description,
        ...(action.icon ? { icon: action.icon } : {}),
        capabilityId: action.tool.capabilityId,
        toolName: resolved?.proxyToolName || row.resolvedActions.find(item => item.actionId === action.id)?.proxyToolName || '',
        underlyingToolName: action.tool.name,
        executionMode: action.executionMode,
        requiresConfirmation: resolved?.requiresConfirmation ?? true,
        availability: resolved?.executable && Boolean(registry.get(resolved.proxyToolName)) ? 'ready' : 'unavailable',
        verification: {
          status: latestActionVerificationStatus.get(action.id)
            || (verifiedRuns > 0 ? 'verified' : receiptVerificationStatus(latest)),
          ...(verifiedAt ? { lastVerifiedAt: verifiedAt } : {}),
          verifiedRuns,
        },
      };
    }),
    activatedAt: row.activatedAt,
    updatedAt: row.updatedAt,
  };
}

function reviewPermissions(actions: ResolvedActionSnapshot[]) {
  return actions.map(action => ({
    actionId: action.actionId,
    proxyToolName: action.proxyToolName,
    underlyingToolName: action.toolName,
    permission: action.permission,
    risk: action.risk,
    requiresConfirmation: action.requiresConfirmation,
    sideEffects: action.sideEffects,
  }));
}

function desktopSessionDigest(proof: string): string {
  return crypto.createHash('sha256').update(proof).digest('hex');
}

function issueReviewApproval(input: {
  ownerUserId: string;
  row: ExternalCapabilityPackageRow;
  desktopSessionProof: string;
}) {
  const now = Date.now();
  for (const [nonce, approval] of reviewApprovals) {
    if (approval.expiresAt <= now) reviewApprovals.delete(nonce);
  }
  const reviewNonce = crypto.randomBytes(32).toString('base64url');
  const expiresAt = now + REVIEW_APPROVAL_TTL_MS;
  reviewApprovals.set(reviewNonce, {
    ownerUserId: input.ownerUserId,
    packageRowId: input.row.id,
    capabilityId: input.row.capabilityId,
    version: input.row.version,
    packageDigest: input.row.packageDigest,
    credentialBindingRevision: input.row.credentialBindingRevision,
    desktopSessionDigest: desktopSessionDigest(input.desktopSessionProof),
    expiresAt,
  });
  return { reviewNonce, expiresAt: new Date(expiresAt).toISOString() };
}

function consumeReviewApproval(input: {
  ownerUserId: string;
  reviewNonce: string;
  row: ExternalCapabilityPackageRow;
  desktopSessionProof: string;
}): void {
  const nonce = String(input.reviewNonce || '').trim();
  if (!nonce) throw new Error('A one-time external capability review nonce is required.');
  const approval = reviewApprovals.get(nonce);
  reviewApprovals.delete(nonce);
  if (!approval || approval.expiresAt <= Date.now()) {
    throw new Error('The external capability review expired or was already used. Review the package again.');
  }
  if (
    approval.ownerUserId !== input.ownerUserId
    || approval.packageRowId !== input.row.id
    || approval.capabilityId !== input.row.capabilityId
    || approval.version !== input.row.version
    || approval.packageDigest !== input.row.packageDigest
    || !sameExternalCapabilityCredentialRevision(
      approval.credentialBindingRevision,
      input.row.credentialBindingRevision,
    )
    || approval.desktopSessionDigest !== desktopSessionDigest(input.desktopSessionProof)
  ) {
    throw new Error('The external capability review is not bound to this user, package, or native desktop session.');
  }
}

function persistRows(): void {
  writeDB(readDB());
}

function snapshotExternalCapabilityStore(): {
  packages: ExternalCapabilityPackageRow[];
  receipts: ExternalCapabilityReceiptRow[];
} {
  const store = arrays();
  return {
    packages: structuredClone(store.packages),
    receipts: structuredClone(store.receipts),
  };
}

function restoreExternalCapabilityStore(snapshot: {
  packages: ExternalCapabilityPackageRow[];
  receipts: ExternalCapabilityReceiptRow[];
}): void {
  const db = readDB();
  db.externalCapabilityPackages = structuredClone(snapshot.packages);
  db.externalCapabilityReceipts = structuredClone(snapshot.receipts);
  writeDB(db);
}

export async function reviewExternalCapabilityProposal(input: {
  ownerUserId: string;
  proposal: unknown;
  desktopSessionProof: string;
  registry: ToolRegistry;
}) {
  const proposal = normalizeExternalCapabilityProposal(input.proposal);
  const packageDigest = externalCapabilityProposalDigest(proposal);
  const credentialBinding = resolveExternalCapabilityCredentialBinding(
    input.ownerUserId,
    proposal.credentialRefs,
  );
  if (!credentialBinding.available) {
    throw new Error(credentialBinding.invalidReference
      ? 'Credential references must name approved secure key-store or environment entries.'
      : 'One or more required external capability credentials are not configured.');
  }
  const runtime = resolveProposalActions(
    proposal,
    input.ownerUserId,
    input.registry,
    credentialBinding.revision,
  );
  if (runtime.availability !== 'ready' || runtime.actions.length !== proposal.actions.length) {
    throw new Error(runtime.reason || 'The external capability package does not resolve to exact registered tools.');
  }
  const store = arrays();
  const before = snapshotExternalCapabilityStore();
  const now = new Date().toISOString();
  const rowId = stableRowId(
    input.ownerUserId,
    proposal,
    packageDigest,
    runtime.actions,
    credentialBinding.revision,
  );
  const existing = store.packages.find(row => row.id === rowId);
  const row: ExternalCapabilityPackageRow = {
    id: rowId,
    ownerUserId: input.ownerUserId,
    capabilityId: proposal.id,
    version: proposal.version,
    status: existing?.status === 'active' ? 'active' : 'reviewed',
    packageDigest,
    credentialBindingRevision: credentialBinding.revision,
    proposal,
    resolvedActions: runtime.actions,
    availability: runtime.availability,
    unavailableReason: runtime.reason,
    createdAt: existing?.createdAt || now,
    reviewedAt: now,
    activatedAt: existing?.activatedAt || '',
    updatedAt: now,
    lastHydratedAt: now,
  };
  if (existing) Object.assign(existing, row);
  else store.packages.push(row);
  const receipt: ExternalCapabilityReceiptRow = {
    id: crypto.randomUUID(),
    packageRowId: row.id,
    ownerUserId: row.ownerUserId,
    capabilityId: row.capabilityId,
    actionId: '',
    kind: 'review',
    status: 'reviewed',
    hostVerified: false,
    toolName: '',
    credentialBindingRevision: row.credentialBindingRevision,
    createdAt: now,
  };
  store.receipts.push(receipt);
  try {
    persistRows();
    await persistStrict();
  } catch (error) {
    restoreExternalCapabilityStore(before);
    throw error;
  }
  const approval = issueReviewApproval({
    ownerUserId: input.ownerUserId,
    row,
    desktopSessionProof: input.desktopSessionProof,
  });
  return {
    ...approval,
    packageDigest,
    review: {
      id: proposal.id,
      version: proposal.version,
      name: proposal.name,
      description: proposal.description,
      actionCount: proposal.actions.length,
      runtimeRefs: structuredClone(proposal.runtimeRefs),
      documents: proposal.documents.map(document => ({
        kind: document.kind,
        label: document.label,
        sha256: document.sha256,
      })),
      permissions: reviewPermissions(runtime.actions),
      resolvedActions: structuredClone(runtime.actions),
      warnings: runtime.actions
        .filter(action => action.requiresConfirmation)
        .map(action => `Action '${action.actionId}' retains its underlying tool confirmation boundary.`),
    },
  };
}

function reviewedRow(input: {
  ownerUserId: string;
  reviewNonce: string;
  proposal?: unknown;
  id?: string;
  version?: string;
  packageDigest?: string;
}): ExternalCapabilityPackageRow {
  const store = arrays();
  const approval = reviewApprovals.get(String(input.reviewNonce || '').trim());
  let proposal: ExternalCapabilityPackageProposal | undefined;
  let digest = String(input.packageDigest || '').trim().toLowerCase();
  if (input.proposal !== undefined) {
    proposal = normalizeExternalCapabilityProposal(input.proposal);
    digest = externalCapabilityProposalDigest(proposal);
  }
  const id = proposal?.id || String(input.id || '').trim().toLowerCase();
  const version = proposal?.version || String(input.version || '').trim();
  const row = store.packages.find(candidate => (
    candidate.id === approval?.packageRowId
    && approval.ownerUserId === input.ownerUserId
    && candidate.ownerUserId === input.ownerUserId
    && candidate.capabilityId === id
    && candidate.version === version
    && candidate.packageDigest === digest
    && (candidate.status === 'reviewed' || candidate.status === 'active')
  ));
  if (!row) throw new Error('No matching reviewed external capability package was found.');
  return row;
}

export async function activateExternalCapabilityProposal(input: {
  ownerUserId: string;
  proposal?: unknown;
  id?: string;
  version?: string;
  packageDigest?: string;
  reviewNonce: string;
  desktopSessionProof: string;
  registry: ToolRegistry;
}) {
  const row = reviewedRow(input);
  const before = snapshotExternalCapabilityStore();
  consumeReviewApproval({
    ownerUserId: input.ownerUserId,
    reviewNonce: input.reviewNonce,
    row,
    desktopSessionProof: input.desktopSessionProof,
  });
  const runtime = resolveReviewedRowRuntime(row, input.registry);
  if (runtime.availability !== 'ready' || runtime.actions.length !== row.proposal.actions.length) {
    throw new Error(runtime.reason || 'The reviewed external capability runtime changed before activation.');
  }
  const reviewedIdentityChanged = runtime.actions.some((action, index) => {
    const reviewed = row.resolvedActions[index];
    return !reviewed
      || action.actionId !== reviewed.actionId
      || action.runtimeRef !== reviewed.runtimeRef
      || action.toolName !== reviewed.toolName
      || action.proxyToolName !== reviewed.proxyToolName
      || action.capabilityId !== reviewed.capabilityId
      || action.source !== reviewed.source
      || action.provider !== reviewed.provider
      || action.runtimeIdentityDigest !== reviewed.runtimeIdentityDigest;
  });
  if (reviewedIdentityChanged) {
    throw new Error('The registered capability identity changed after review. Review the package again.');
  }
  const store = arrays();
  const now = new Date().toISOString();
  for (const candidate of store.packages) {
    if (
      candidate.ownerUserId === row.ownerUserId
      && candidate.capabilityId === row.capabilityId
      && candidate.id !== row.id
      && candidate.status === 'active'
    ) {
      candidate.status = 'inactive';
      candidate.updatedAt = now;
    }
  }
  row.status = 'active';
  row.resolvedActions = runtime.actions;
  row.availability = 'ready';
  row.unavailableReason = '';
  row.activatedAt = now;
  row.updatedAt = now;
  row.lastHydratedAt = now;
  const activationReceiptId = crypto.randomUUID();
  store.receipts.push({
    id: activationReceiptId,
    packageRowId: row.id,
    ownerUserId: row.ownerUserId,
    capabilityId: row.capabilityId,
    actionId: '',
    kind: 'activation',
    status: 'active',
    hostVerified: false,
    toolName: '',
    credentialBindingRevision: row.credentialBindingRevision,
    createdAt: now,
  });
  try {
    persistRows();
    await persistStrict();
  } catch (error) {
    restoreExternalCapabilityStore(before);
    registerExternalCapabilityProxies(input.registry, arrays().packages.filter(candidate => candidate.status === 'active'));
    throw error;
  }
  await hydrateExternalCapabilities(input.registry);
  return {
    capability: projectRow(row, input.registry, store.receipts),
    activationReceiptId,
  };
}

/**
 * Durably revoke one owner's active capability before removing its runtime
 * proxy. The store and proxy registry move together: a failed strict write
 * restores both to the exact pre-deactivation state.
 */
export async function deactivateExternalCapability(input: {
  ownerUserId: string;
  capabilityId: string;
  registry: ToolRegistry;
}) {
  const ownerUserId = String(input.ownerUserId || '').trim();
  const capabilityId = String(input.capabilityId || '').trim().toLowerCase();
  if (!ownerUserId || !capabilityId) {
    throw new Error('An owning user and external capability id are required for deactivation.');
  }

  const store = arrays();
  const activeRows = store.packages
    .filter(row => (
      row
      && row.ownerUserId === ownerUserId
      && row.capabilityId === capabilityId
      && row.status === 'active'
    ))
    .sort((left, right) => String(right.activatedAt || '').localeCompare(String(left.activatedAt || '')));
  if (!activeRows.length) throw new Error('External capability is not active for this user.');

  const before = snapshotExternalCapabilityStore();
  const now = new Date().toISOString();
  const deactivationReceiptId = crypto.randomUUID();
  for (const row of activeRows) {
    row.status = 'inactive';
    row.availability = 'unavailable';
    row.unavailableReason = 'Deactivated by the owning user.';
    row.updatedAt = now;
  }
  store.receipts.push({
    id: deactivationReceiptId,
    packageRowId: activeRows[0].id,
    ownerUserId,
    capabilityId,
    actionId: '',
    kind: 'activation',
    status: 'inactive',
    hostVerified: false,
    toolName: '',
    credentialBindingRevision: activeRows[0].credentialBindingRevision,
    createdAt: now,
  });

  try {
    persistRows();
    await persistStrict();
  } catch (error) {
    restoreExternalCapabilityStore(before);
    registerExternalCapabilityProxies(
      input.registry,
      arrays().packages.filter(row => row.status === 'active'),
    );
    throw error;
  }

  // A successful durable revoke also invalidates any still-live review nonce
  // for this owner/capability, then rebuilds proxies only from remaining active
  // rows. Desktop launchers disappear from the owner projection on refresh.
  for (const [nonce, approval] of reviewApprovals) {
    if (approval.ownerUserId === ownerUserId && approval.capabilityId === capabilityId) {
      reviewApprovals.delete(nonce);
    }
  }
  const hydration = registerExternalCapabilityProxies(
    input.registry,
    store.packages.filter(row => row.status === 'active'),
  );

  return {
    capabilityId,
    status: 'inactive' as const,
    deactivatedAt: now,
    deactivationReceiptId,
    proxies: hydration.registered,
  };
}

export function listActiveExternalCapabilities(
  ownerUserId: string,
  registry: ToolRegistry,
): ExternalCapabilityProjection[] {
  const store = arrays();
  return store.packages
    .filter(row => row && row.ownerUserId === ownerUserId && row.status === 'active')
    .sort((left, right) => String(right?.updatedAt || '').localeCompare(String(left?.updatedAt || '')))
    .flatMap(row => {
      try {
        return [projectRow(row, registry, store.receipts)];
      } catch {
        return [];
      }
    });
}

export async function hydrateExternalCapabilities(registry: ToolRegistry): Promise<{
  active: number;
  ready: number;
  unavailable: number;
  proxies: number;
}> {
  let store: ReturnType<typeof arrays>;
  try {
    store = arrays();
  } catch {
    return { active: 0, ready: 0, unavailable: 0, proxies: 0 };
  }
  const active = store.packages.filter(row => row && typeof row === 'object' && row.status === 'active');
  const before = snapshotExternalCapabilityStore();
  const now = new Date().toISOString();
  let changed = false;
  const runtimes = new Map<string, ReturnType<typeof resolveReviewedRowRuntime>>();
  for (const row of active) {
    const runtime = resolveReviewedRowRuntime(row, registry);
    runtimes.set(String(row.id || ''), runtime);
  }
  const proxyHydration = registerExternalCapabilityProxies(registry, active);
  let ready = 0;
  for (const row of active) {
    const runtime = runtimes.get(String(row.id || '')) || {
      actions: [],
      availability: 'unavailable' as const,
      reason: 'The persisted package could not be resolved.',
    };
    const proxiesReady = runtime.availability === 'ready'
      && runtime.actions.length > 0
      && runtime.actions.every(action => Boolean(registry.get(action.proxyToolName)));
    const availability: ExternalCapabilityAvailability = proxiesReady ? 'ready' : 'unavailable';
    const reason = runtime.reason || (!proxiesReady ? 'The reviewed package proxy could not be hydrated.' : '');
    if (availability === 'ready') ready += 1;
    if (
      row.availability !== availability
      || row.unavailableReason !== reason
    ) {
      row.availability = availability;
      row.unavailableReason = reason;
      row.updatedAt = now;
      row.lastHydratedAt = now;
      changed = true;
    }
  }
  if (changed) {
    try {
      persistRows();
      await persistStrict();
    } catch (error) {
      restoreExternalCapabilityStore(before);
      registerExternalCapabilityProxies(registry, arrays().packages.filter(row => row.status === 'active'));
      throw error;
    }
  }
  return { active: active.length, ready, unavailable: active.length - ready, proxies: proxyHydration.registered };
}

function externalCapabilityExecutionRow(
  ownerUserId: string,
  capabilityId: string,
): ExternalCapabilityPackageRow {
  const row = arrays().packages.find(candidate => (
    candidate
    && candidate.ownerUserId === ownerUserId
    && candidate.capabilityId === capabilityId
    && candidate.status === 'active'
  ));
  if (!row) throw new Error('External capability is not active for this user.');
  return row;
}

export async function executeExternalCapabilityAction(input: {
  ownerUserId: string;
  capabilityId: string;
  actionId: string;
  arguments?: unknown;
  requestId: string;
  idempotencyKey: string;
  registry: ToolRegistry;
  context: ToolContext;
}) {
  const row = externalCapabilityExecutionRow(input.ownerUserId, input.capabilityId);
  const proposal = normalizeExternalCapabilityProposal(row.proposal);
  if (externalCapabilityProposalDigest(proposal) !== String(row.packageDigest || '').trim().toLowerCase()) {
    throw new Error('External capability package data changed after review.');
  }
  const action = proposal.actions.find(candidate => candidate.id === input.actionId);
  if (!action) throw new Error('External capability action was not found.');
  const runtime = resolveReviewedRowRuntime(row, input.registry);
  const resolved = runtime.actions.find(candidate => candidate.actionId === action.id);
  if (runtime.availability !== 'ready' || !resolved?.executable) {
    throw new Error(runtime.reason || 'External capability action is unavailable.');
  }
  if (resolved.requiresConfirmation) {
    const error = new Error('This action retains the underlying tool confirmation boundary and cannot be executed by a bare icon request.') as Error & { statusCode?: number };
    error.statusCode = 409;
    throw error;
  }
  const supplied = assertExternalCapabilityArguments(input.arguments);
  const proxyName = resolved.proxyToolName;
  if (!input.registry.get(proxyName)) throw new Error('External capability proxy is not hydrated in the current runtime.');
  const reviewedArguments = mergeActionArguments(action, supplied);
  const inputDigest = externalCommitInputDigest(proxyName, reviewedArguments);
  const store = arrays();
  const priorReceipt = [...store.receipts].reverse().find(receipt => (
    receipt.kind === 'execution'
    && receipt.packageRowId === row.id
    && receipt.ownerUserId === input.ownerUserId
    && receipt.actionId === action.id
    && receipt.runtimeIdentityDigest === resolved.runtimeIdentityDigest
    && sameExternalCapabilityCredentialRevision(
      receipt.credentialBindingRevision,
      row.credentialBindingRevision,
    )
    && receipt.idempotencyKey === input.idempotencyKey
    && (receipt.persistenceState === 'pending'
      || receipt.status === 'verified_success'
      || receipt.status === 'unknown_outcome')
  ));
  const persistenceUnknownMessage = 'The action may have completed, but its durable capability receipt is not yet available. Automatic resend was stopped; retry with the same request key to reconcile it.';
  const pendingExecution = (receipt: ExternalCapabilityReceiptRow) => ({
    execution: {
      receiptId: receipt.id,
      recordId: receipt.canonicalOutcome?.recordId || '',
      status: 'unknown_outcome',
      toolName: receipt.canonicalOutcome?.toolName || proxyName,
      underlyingToolName: receipt.canonicalOutcome?.underlyingToolName || action.tool.name,
      result: '',
      error: persistenceUnknownMessage,
      terminalVerification: receipt.terminalVerification,
      recovery: {
        pendingPersistence: true,
        requestId: input.requestId,
        idempotencyKey: input.idempotencyKey,
      },
    },
    capability: projectRow(row, input.registry, store.receipts),
  });
  if (priorReceipt) {
    if (priorReceipt.inputDigest && priorReceipt.inputDigest !== inputDigest) {
      throw new Error('External capability idempotency key is already bound to different reviewed arguments.');
    }
    if (priorReceipt.persistenceState === 'pending') {
      const pendingSnapshot = structuredClone(priorReceipt);
      const canonical = priorReceipt.canonicalOutcome;
      if (!canonical) return pendingExecution(priorReceipt);
      priorReceipt.status = canonical.status;
      priorReceipt.hostVerified = canonical.hostVerified;
      priorReceipt.terminalVerification = canonical.terminalVerification;
      priorReceipt.persistenceState = 'persisted';
      delete priorReceipt.persistenceErrorDigest;
      persistRows();
      try {
        await persistStrict();
      } catch (error) {
        Object.assign(priorReceipt, pendingSnapshot);
        persistRows();
        return pendingExecution(priorReceipt);
      }
      return {
        execution: {
          receiptId: priorReceipt.id,
          recordId: canonical.recordId,
          status: canonical.status,
          toolName: canonical.toolName,
          underlyingToolName: canonical.underlyingToolName,
          result: JSON.stringify({ deduplicated: true, recovered: true }),
          error: undefined,
          terminalVerification: canonical.terminalVerification,
          recovery: {
            pendingPersistence: false,
            deduplicated: true,
            recovered: true,
            requestId: input.requestId,
            idempotencyKey: input.idempotencyKey,
          },
        },
        capability: projectRow(row, input.registry, store.receipts),
      };
    }
    const canonical = priorReceipt.canonicalOutcome;
    return {
      execution: {
        receiptId: priorReceipt.id,
        recordId: canonical?.recordId || '',
        status: priorReceipt.status,
        toolName: canonical?.toolName || priorReceipt.toolName || proxyName,
        underlyingToolName: canonical?.underlyingToolName || action.tool.name,
        result: JSON.stringify({ deduplicated: true }),
        error: undefined,
        terminalVerification: priorReceipt.terminalVerification,
        recovery: {
          pendingPersistence: false,
          deduplicated: true,
          requestId: input.requestId,
          idempotencyKey: input.idempotencyKey,
        },
      },
      capability: projectRow(row, input.registry, store.receipts),
    };
  }
  const receiptId = crypto.randomUUID();
  const now = new Date().toISOString();
  const beforePreclaim = snapshotExternalCapabilityStore();
  const receipt: ExternalCapabilityReceiptRow = {
    id: receiptId,
    packageRowId: row.id,
    ownerUserId: row.ownerUserId,
    capabilityId: row.capabilityId,
    actionId: action.id,
    kind: 'execution',
    status: 'unknown_outcome',
    hostVerified: false,
    toolName: proxyName,
    requestId: input.requestId,
    idempotencyKey: input.idempotencyKey,
    inputDigest,
    persistenceState: 'pending',
    runtimeIdentityDigest: resolved.runtimeIdentityDigest,
    credentialBindingRevision: row.credentialBindingRevision,
    terminalVerification: {
      status: 'unverified',
      strategy: 'none',
      reason: 'The durable execution preclaim exists, but the reviewed action has not reached a canonical terminal receipt.',
    },
    createdAt: now,
  };
  store.receipts.push(receipt);
  row.updatedAt = now;
  try {
    // This durable preclaim is the outer action fence. If it cannot be stored,
    // the handler is never entered. A crash or later flush failure therefore
    // leaves a restart-visible unknown record rather than permitting a resend.
    persistRows();
    await persistStrict();
  } catch (error) {
    restoreExternalCapabilityStore(beforePreclaim);
    throw new Error(
      `External capability execution was stopped before the action started because its durable idempotency preclaim could not be stored: ${String((error as Error)?.message || error)}`,
    );
  }
  const durablePreclaim = structuredClone(receipt);
  const reviewedTargetEntries = ['url', 'target', 'path', 'filePath', 'applicationTarget', 'executable']
    .flatMap(key => typeof reviewedArguments[key] === 'string' && String(reviewedArguments[key]).trim()
      ? [{ key, value: String(reviewedArguments[key]).trim().slice(0, 1_000) }]
      : []);
  const primaryReviewedTarget = reviewedTargetEntries[0];
  // Target extraction is intentionally fed the server-owned reviewed target
  // before any natural-language package copy. Otherwise text such as "open the
  // customer tool" can be parsed as the target and incorrectly reject the
  // exact fixed URL/path during the canonical semantic guard.
  const routedActionIntent = [
    primaryReviewedTarget
      ? `Open ${primaryReviewedTarget.value}`
      : '',
    `${proposal.name}: ${action.description}`,
    reviewedTargetEntries.length
      ? `Reviewed action target: ${reviewedTargetEntries.map(entry => `${entry.key}=${entry.value}`).join('; ')}`
      : '',
  ].filter(Boolean).join('\n');
  let record: ToolExecutionRecord;
  try {
    record = await executeToolCall({
      registry: input.registry,
      name: proxyName,
      arguments: supplied,
      id: crypto.randomUUID(),
      executionOrigin: 'deterministic_route',
      context: {
        ...input.context,
        userId: input.ownerUserId,
        authenticated: true,
        taskId: `external-capability:${row.capabilityId}:${action.id}:${input.requestId}`,
        requestId: input.requestId,
        idempotencyKey: input.idempotencyKey,
        currentTurnExecutionRequested: true,
        actionIntent: routedActionIntent,
        routedTaskText: routedActionIntent,
        toolRegistry: input.registry,
        source: 'external-capability-icon',
      },
    });
  } catch (error) {
    receipt.persistenceErrorDigest = crypto.createHash('sha256')
      .update(String((error as Error)?.message || error || 'execution boundary failure'))
      .digest('hex');
    persistRows();
    return pendingExecution(receipt);
  }
  const canonical = isCanonicalToolExecutionRecord(record);
  const hostVerified = canonical && record.terminalVerification?.status === 'verified';
  const canonicalStatus = record.envelope?.status || (record.error ? 'failed' : 'unknown_outcome');
  receipt.status = canonicalStatus;
  receipt.hostVerified = hostVerified;
  receipt.persistenceState = 'persisted';
  receipt.canonicalOutcome = {
    recordId: record.id,
    status: canonicalStatus,
    hostVerified,
    toolName: record.name,
    underlyingToolName: action.tool.name,
    terminalVerification: record.terminalVerification,
  };
  receipt.terminalVerification = record.terminalVerification ? { ...record.terminalVerification } : undefined;
  receipt.envelope = record.envelope ? structuredClone(record.envelope) : undefined;
  if (record.error) {
    receipt.errorDigest = crypto.createHash('sha256').update(record.error).digest('hex');
  }
  try {
    persistRows();
    await persistStrict();
  } catch (error) {
    const operation = record.capability?.operation;
    const sideEffectingAction = ['mutate', 'create', 'communicate', 'unknown'].includes(String(operation || ''))
      || resolved.sideEffects.some(effect => !['none', 'local_read', 'network_read'].includes(effect.type));
    const handlerMayHaveRun = record.adapterStarted === true
      || Boolean(record.adapterSettlements?.length);
    const sideEffectMayHaveOccurred = canonicalStatus === 'verified_success'
      || canonicalStatus === 'unknown_outcome'
      || (sideEffectingAction && handlerMayHaveRun);
    const pendingTerminalVerification: ToolExecutionRecord['terminalVerification'] = {
      status: 'unverified',
      strategy: record.terminalVerification?.strategy || 'none',
      reason: persistenceUnknownMessage,
    };
    const recoverableCanonicalOutcome = {
      recordId: record.id,
      status: sideEffectMayHaveOccurred && canonicalStatus === 'failed'
        ? 'unknown_outcome'
        : canonicalStatus,
      hostVerified: sideEffectMayHaveOccurred && canonicalStatus === 'failed'
        ? false
        : hostVerified,
      toolName: record.name,
      underlyingToolName: action.tool.name,
      terminalVerification: sideEffectMayHaveOccurred && canonicalStatus === 'failed'
        ? pendingTerminalVerification
        : record.terminalVerification,
    };
    Object.assign(receipt, durablePreclaim);
    delete receipt.envelope;
    delete receipt.errorDigest;
    receipt.canonicalOutcome = recoverableCanonicalOutcome;
    receipt.persistenceErrorDigest = crypto.createHash('sha256')
      .update(String((error as Error)?.message || error || 'persistence failure'))
      .digest('hex');
    receipt.terminalVerification = pendingTerminalVerification;
    // The already-durable preclaim remains authoritative on disk. Keep the
    // richer canonical outcome only in memory until a same-key retry can flush
    // it; neither a process restart nor an immediate retry may re-enter handler.
    persistRows();
    return pendingExecution(receipt);
  }
  return {
    execution: {
      receiptId,
      recordId: record.id,
      status: record.envelope?.status || (record.error ? 'failed' : 'unknown_outcome'),
      toolName: record.name,
      underlyingToolName: action.tool.name,
      arguments: structuredClone(record.arguments || {}),
      evidence: record.evidence ? structuredClone(record.evidence) : undefined,
      result: String(record.result || '').slice(0, 64 * 1024),
      error: record.error ? String(record.error).slice(0, 1_000) : undefined,
      terminalVerification: record.terminalVerification,
    },
    capability: projectRow(row, input.registry, store.receipts),
  };
}

function compact(value: string, limit: number): string {
  const normalized = String(value || '').replace(/\s+/g, ' ').trim();
  return normalized.length > limit ? `${normalized.slice(0, limit - 1)}…` : normalized;
}

/** Bounded model guidance; package text never grants authority or proves success. */
export function buildExternalCapabilityContext(
  ownerUserId: string,
  registry: ToolRegistry,
  scope: { domain?: string; orgId?: string; source?: string; autonomous?: boolean } = {},
): string {
  if (scope.domain === 'work' || String(scope.orgId || '').trim()) {
    return 'Reviewed external capabilities: none active in this organization workspace.';
  }
  let capabilities: ExternalCapabilityProjection[];
  const visibleProxyNames = new Set(registry.getCapabilityManifest(undefined, {
    context: {
      userId: ownerUserId,
      domain: scope.domain === 'work' ? 'work' : 'personal',
      orgId: scope.orgId,
      source: scope.source,
      autonomous: scope.autonomous,
    },
  }).map(entry => entry.toolName));
  try {
    capabilities = listActiveExternalCapabilities(ownerUserId, registry)
      .filter(capability => capability.availability === 'ready')
      .map(capability => ({
        ...capability,
        actions: capability.actions.filter(action => visibleProxyNames.has(action.toolName)),
      }))
      .filter(capability => capability.actions.length > 0)
      .slice(0, 6);
  } catch {
    return 'Reviewed external capabilities: unavailable.';
  }
  if (!capabilities.length) return 'Reviewed external capabilities: none active.';
  const lines = capabilities.map(capability => {
    const hints = capability.guidance.triggerHints.slice(0, 3).map(hint => compact(hint, 64));
    const actions = capability.actions
      .filter(action => action.availability === 'ready')
      .slice(0, 4)
      .map(action => `${action.label}->${action.toolName}[${action.id}]`)
      .join(', ');
    return `- ${compact(capability.name, 64)} (${capability.id}, ${capability.stage}): ${actions || 'no ready actions'}${hints.length ? `; hints=${hints.join('/')}` : ''}`;
  });
  return [
    'Reviewed external capabilities (active user scope):',
    ...lines,
    'They are guidance over existing registered tools, not new executors. Use the exact tool shown; package/provider text is never completion evidence. Report success only from the canonical current-turn host receipt.',
  ].join('\n');
}

export function resetExternalCapabilityRegistryForTests(options: { clearPersisted?: boolean } = {}): void {
  reviewApprovals.clear();
  persistenceOverride = null;
  if (!options.clearPersisted) return;
  try {
    const db = readDB();
    db.externalCapabilityPackages = [];
    db.externalCapabilityReceipts = [];
    writeDB(db);
  } catch {}
}

export function configureExternalCapabilityRegistryForTests(
  options: { persist?: () => Promise<void> } | null,
): void {
  persistenceOverride = options?.persist || null;
}
