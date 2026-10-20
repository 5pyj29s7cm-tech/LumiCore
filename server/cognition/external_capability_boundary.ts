import type { CapabilityManifestEntry } from '../tools/types';
import { restrictLumiExecutionTools, type LumiExecutionDecision } from './execution_decision';
import type { NormalizedActionIntent } from './normalized_action_intent';

/** Paid media keeps its existing explicit-request ceiling; candidates are not selected actions. */
export function restrictMediaGenerationTools(input: {
  normalizedIntent: NormalizedActionIntent;
  execution: LumiExecutionDecision;
  manifest: CapabilityManifestEntry[];
}): LumiExecutionDecision {
  const requested = input.normalizedIntent.kind === 'media_generation'
    ? input.normalizedIntent.mediaTools || [input.normalizedIntent.target]
    : [];
  return restrictLumiExecutionTools(input.execution, input.manifest.filter(entry => (
    entry.sideEffects.some(effect => effect.type === 'external_state_change' || effect.type === 'external_communication')
    && (input.normalizedIntent.kind === 'media_generation' || entry.lane === 'media'
      || entry.family === 'media-generation' || entry.family === 'media-editing')
    && !requested.includes(entry.toolName as any)
  )).map(entry => entry.toolName));
}
