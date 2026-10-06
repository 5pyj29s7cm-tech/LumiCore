import { cloneDatabaseValue } from "../db/snapshot_changes";
import crypto from "node:crypto";
import type { ToolRegistry } from "../tools/registry";
import { externalCapabilityProposalDigest, normalizeExternalCapabilityProposal } from "./schema";
import { resolveExternalCapabilityCredentialBinding } from "./credential_binding";
import { resolveProposalActions, resolveReviewedRowRuntime } from './runtime/proposal_resolution';
import { arrays, snapshotExternalCapabilityStore, persistRows, restoreExternalCapabilityStore } from './runtime/store';
import { stableRowId } from './runtime/runtime_identity';
import type { ExternalCapabilityPackageRow, ExternalCapabilityReceiptRow, ExternalCapabilityAvailability } from './runtime/contracts';
import { persistStrict } from './runtime/persistence';
import { issueReviewApproval, reviewPermissions, reviewedRow, consumeReviewApproval, reviewApprovals } from './runtime/review_approval';
import { registerExternalCapabilityProxies } from './runtime/proxy_registration';
import { projectRow } from './runtime/projection';

export type { ExternalCapabilityStage } from './runtime/contracts';
export type { ExternalCapabilityAvailability } from './runtime/contracts';
export type { ExternalCapabilityPackageRow } from './runtime/contracts';
export type { ExternalCapabilityProjection } from './runtime/contracts';
export { listActiveExternalCapabilities } from './runtime/context';
export { executeExternalCapabilityAction } from './runtime/execution';
export { buildExternalCapabilityContext } from './runtime/context';
export { resetExternalCapabilityRegistryForTests } from './runtime/persistence';
export { configureExternalCapabilityRegistryForTests } from './runtime/persistence';

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
    persistRows(store);
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
      runtimeRefs: cloneDatabaseValue(proposal.runtimeRefs),
      documents: proposal.documents.map(document => ({
        kind: document.kind,
        label: document.label,
        sha256: document.sha256,
      })),
      permissions: reviewPermissions(runtime.actions),
      resolvedActions: cloneDatabaseValue(runtime.actions),
      warnings: runtime.actions
        .filter(action => action.requiresConfirmation)
        .map(action => `Action '${action.actionId}' retains its underlying tool confirmation boundary.`),
    },
  };
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
  const store = arrays();
  const row = reviewedRow(input, store);
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
    persistRows(store);
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
    persistRows(store);
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
      persistRows(store);
      await persistStrict();
    } catch (error) {
      restoreExternalCapabilityStore(before);
      registerExternalCapabilityProxies(registry, arrays().packages.filter(row => row.status === 'active'));
      throw error;
    }
  }
  return { active: active.length, ready, unavailable: active.length - ready, proxies: proxyHydration.registered };
}
