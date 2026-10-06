import type { ToolRegistry } from "../../registry";
import { createHash } from "crypto";
import type { CapabilityManifestEntry } from "../../types";
import { attachedExternalCommitReconciliationFingerprint } from "../../execution_engine";

function canonicalContractJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalContractJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalContractJson(item)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

export function frozenCapabilitySnapshot(manifest: CapabilityManifestEntry, parameterSchema: Record<string, unknown> = {}) {
  const contract = {
    capabilityId: manifest.capabilityId,
    operation: manifest.operation,
    risk: manifest.risk,
    sideEffects: [...manifest.sideEffects]
      .map(effect => ({ type: effect.type, scope: effect.scope, reversible: effect.reversible }))
      .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right))),
    configuredSecurityLevel: manifest.configuredSecurityLevel,
    parameterNames: [...manifest.parameterNames].sort(),
    prerequisites: [...manifest.prerequisites].sort(),
    parameterSchemaHash: createHash('sha256').update(canonicalContractJson(parameterSchema)).digest('hex'),
    verificationHash: createHash('sha256').update(canonicalContractJson(manifest.verification)).digest('hex'),
    provider: manifest.provider,
    trust: manifest.trust,
    deprecated: manifest.deprecated,
    replacedBy: manifest.replacedBy,
    adapter: manifest.adapter
      ? { id: manifest.adapter.id, operations: [...manifest.adapter.operations].sort() }
      : undefined,
  };
  return {
    ...contract,
    contractHash: createHash('sha256').update(canonicalContractJson(contract)).digest('hex'),
  };
}

export function capabilityContractStillCompatible(
  step: { capabilitySnapshot?: { contractHash: string } },
  manifest?: CapabilityManifestEntry,
  parameterSchema: Record<string, unknown> = {},
): boolean {
  if (!step.capabilitySnapshot || !manifest) return false;
  return frozenCapabilitySnapshot(manifest, parameterSchema).contractHash === step.capabilitySnapshot.contractHash;
}

export function attachedReconciliationContract(
  definition: ReturnType<ToolRegistry['get']>,
  manifest: CapabilityManifestEntry,
  capabilitySnapshot: ReturnType<typeof frozenCapabilitySnapshot>,
) {
  if (!definition?.reconcileExternalCommit) return undefined;
  return {
    kind: 'tool_definition_hook' as const,
    toolName: definition.name,
    capabilityId: manifest.capabilityId,
    hookVersion: 1 as const,
    implementationFingerprint: attachedExternalCommitReconciliationFingerprint({
      toolName: definition.name,
      capabilityId: manifest.capabilityId,
      capabilityContractHash: capabilitySnapshot.contractHash,
      hook: definition.reconcileExternalCommit,
    }),
  };
}
