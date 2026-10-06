import type { CapabilityManifestEntry } from '../tools/types';
import { restrictLumiExecutionTools, type LumiExecutionDecision } from './execution_decision';
import type { NormalizedActionIntent } from './normalized_action_intent';

const EXTERNAL_SIDE_EFFECTS = new Set([
  'external_state_change',
  'external_communication',
]);

export interface LumiExternalCapabilityBoundary {
  version: 1;
  blockedExternalTools: string[];
  aligned: boolean;
  externalCommitBlocked: boolean;
  reason: string;
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values.filter(Boolean)));
}

function isExternal(entry: CapabilityManifestEntry): boolean {
  return entry.sideEffects.some(effect => EXTERNAL_SIDE_EFFECTS.has(effect.type));
}

function isExpectedExternalTool(
  intent: NormalizedActionIntent,
  entry: CapabilityManifestEntry,
): boolean {
  if (!isExternal(entry)) return false;
  if (intent.kind === 'media_generation') return (intent.mediaTools || [intent.target]).includes(entry.toolName as any);
  if (intent.kind === 'messaging_send') {
    return entry.family === 'messaging'
      || entry.lane === 'messaging'
      || /(?:message|wechat|weixin|feishu|mail|slack|teams|send)/i.test(entry.toolName);
  }
  return true;
}

/**
 * Validate selected capabilities against the accepted normalized instruction.
 * A non-committing instruction or a missing matching capability can never
 * authorize an external side effect. Every policy view receives the same veto.
 */
export function validateExternalCapabilityBoundary(input: {
  normalizedIntent: NormalizedActionIntent;
  execution: LumiExecutionDecision;
  manifest: CapabilityManifestEntry[];
}): LumiExternalCapabilityBoundary {
  const routeNames = new Set(input.execution.toolRoute?.toolNames || []);
  const routedEntries = input.manifest.filter(entry => routeNames.has(entry.toolName));
  const externalEntries = routedEntries.filter(isExternal);
  const allExternalTools = unique(input.manifest.filter(isExternal).map(entry => entry.toolName));
  const expectsExternal = input.normalizedIntent.sideEffectClass === 'external_commit';
  const hasExpectedExternal = externalEntries.some(entry => (
    isExpectedExternalTool(input.normalizedIntent, entry)
  ));
  const unexpectedExternal = !expectsExternal && externalEntries.length > 0;
  const missingOrWrongExternal = expectsExternal && !hasExpectedExternal;
  const aligned = !unexpectedExternal && !missingOrWrongExternal;
  const externalCommitBlocked = !aligned && (
    expectsExternal || externalEntries.length > 0
  );
  const reason = aligned
    ? 'normalized intent and selected capabilities agree on external side effects'
    : unexpectedExternal
      ? `normalized ${input.normalizedIntent.kind} is non-committing but the selected route exposed external tools`
      : `normalized ${input.normalizedIntent.kind} requires an external commit but the selected route did not expose a matching external capability`;

  return {
    version: 1,
    blockedExternalTools: externalCommitBlocked ? allExternalTools
      : input.normalizedIntent.kind === 'media_generation'
        ? allExternalTools.filter(name => !(input.normalizedIntent.mediaTools || [input.normalizedIntent.target]).includes(name as any)) : [],
    aligned,
    externalCommitBlocked,
    reason,
  };
}

export function applyExternalCapabilityBoundary(
  execution: LumiExecutionDecision,
  comparison: LumiExternalCapabilityBoundary,
): LumiExecutionDecision {
  return restrictLumiExecutionTools(execution, comparison.blockedExternalTools, [
    '## External Commit Authorization Boundary',
    comparison.externalCommitBlocked
      ? `External commit tools are disabled for this turn because the selected capabilities do not match the accepted instruction: ${comparison.reason}.`
      : 'Only the explicitly requested media generator is authorized among external tools. Unrelated external actions remain disabled.',
    'Do not retry through a desktop, browser, or alternate-provider path.',
  ].join('\n'));
}
