import type {
  CapabilityLane,
  CapabilityOperation,
  CapabilityRisk,
  CapabilitySideEffect,
  CapabilityVerification,
  ToolCapabilityMetadata,
  ToolDefinition,
} from './types';

export interface CapabilityContractInput {
  id: string;
  family: string;
  lane: CapabilityLane;
  operation: Exclude<CapabilityOperation, 'unknown'>;
  risk: Exclude<CapabilityRisk, 'none'>;
  sideEffects: CapabilitySideEffect[];
  verification: CapabilityVerification;
}

export interface CapabilityEvidenceInput {
  id: string;
  operation: Exclude<CapabilityOperation, 'unknown'>;
  assurance?: NonNullable<ToolDefinition['evidence']>['assurance'];
  subjectArgument?: string;
  limitations?: string[];
}

/**
 * Keeps contract shape consistent while leaving the semantic declaration next
 * to the owning tool. This is intentionally not a tool-name catalog: callers
 * must supply every risk, side effect, and receipt condition explicitly.
 */
export function capabilityContract(input: CapabilityContractInput): ToolCapabilityMetadata {
  return {
    id: input.id,
    family: input.family,
    lane: input.lane,
    operation: input.operation,
    risk: input.risk,
    sideEffects: input.sideEffects,
    verification: input.verification,
  };
}

export function capabilityEvidence(
  input: CapabilityEvidenceInput,
): NonNullable<ToolDefinition['evidence']> {
  return {
    capability: input.id,
    operation: input.operation,
    assurance: input.assurance || 'verified',
    subjectArgument: input.subjectArgument,
    limitations: input.limitations,
  };
}
