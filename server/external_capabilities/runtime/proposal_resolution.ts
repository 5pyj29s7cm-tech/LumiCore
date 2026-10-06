import { listExtensionRuntimeSnapshots } from "../../extensions/registry";
import type { ToolRegistry } from "../../tools/registry";
import { externalCapabilityProposalDigest, normalizeExternalCapabilityProposal, type ExternalCapabilityPackageProposal } from "../schema";
import { resolveExternalCapabilityCredentialBinding, sameExternalCapabilityCredentialRevision } from "../credential_binding";
import type { ResolvedActionSnapshot, ExternalCapabilityAvailability, ExternalCapabilityPackageRow } from './contracts';
import { runtimeSource, PROXY_TOOL_PREFIX, proxyToolName, runtimeIdentityDigest, requiredToolArguments } from './runtime_identity';

export function resolveProposalActions(
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

export function resolveReviewedRowRuntime(
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
