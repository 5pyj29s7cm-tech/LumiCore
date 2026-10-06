import { cloneDatabaseValue } from "../../db/snapshot_changes";
import crypto from "node:crypto";
import type { ToolRegistry } from "../../tools/registry";
import type { ToolContext, ToolDefinition } from "../../tools/types";
import { hasAutonomousHostAuthority } from "../../tools/host_execution_authority";
import { normalizeExternalCapabilityProposal, type ExternalCapabilityActionProposal, type ExternalCapabilityPackageProposal } from "../schema";
import { resolveExternalCapabilityCredentialBinding, sameExternalCapabilityCredentialRevision } from "../credential_binding";
import type { ExternalCapabilityPackageRow, ResolvedActionSnapshot } from './contracts';
import { runtimeIdentityDigest } from './runtime_identity';
import { actionAutomaticReady } from './projection';
import { mergeActionArguments, projectedActionParameters } from './argument_binding';
import { resolveReviewedRowRuntime } from './proposal_resolution';

const registeredProxyNames = new WeakMap<ToolRegistry, Set<string>>();

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
      sideEffects: cloneDatabaseValue(pinnedManifest.sideEffects),
      verification: cloneDatabaseValue(pinnedManifest.verification),
      fallbacks: cloneDatabaseValue(pinnedManifest.fallbacks),
      provenance: cloneDatabaseValue(pinnedManifest.provenance),
      ...(pinnedManifest.adapter ? { adapter: cloneDatabaseValue(pinnedManifest.adapter) } : {}),
      ...(pinnedManifest.reconciliation ? { reconciliation: cloneDatabaseValue(pinnedManifest.reconciliation) } : {}),
      deprecated: pinnedManifest.deprecated,
      ...(pinnedManifest.replacedBy ? { replacedBy: pinnedManifest.replacedBy } : {}),
      modeSecurity: cloneDatabaseValue(pinnedManifest.modeSecurity),
      prerequisites: Array.from(new Set([
        ...pinnedManifest.prerequisites,
        `reviewed external package ${row.packageDigest}`,
        `owner binding ${crypto.createHash('sha256').update(row.ownerUserId).digest('hex').slice(0, 24)}`,
      ])),
    },
    evidence: pinnedTarget.evidence
      ? cloneDatabaseValue(pinnedTarget.evidence)
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

export function registerExternalCapabilityProxies(
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
