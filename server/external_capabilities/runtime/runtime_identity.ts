import { stableValue } from '../../../shared/stable_json';
import crypto from "node:crypto";
import type { CapabilityManifestEntry, ToolDefinition } from "../../tools/types";
import type { ExternalCapabilityPackageProposal } from "../schema";
import type { ResolvedActionSnapshot } from './contracts';

export const PROXY_TOOL_PREFIX = 'external_capability_action_';

export function stableRowId(
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

export function proxyToolName(
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

export function runtimeIdentityDigest(manifest: CapabilityManifestEntry, definition: ToolDefinition): string {
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

export function runtimeSource(kind: ExternalCapabilityPackageProposal['runtimeRefs'][number]['kind']): CapabilityManifestEntry['source'] {
  return kind === 'signed_extension' ? 'adapter' : kind;
}

export function requiredToolArguments(definition: ToolDefinition): string[] {
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
