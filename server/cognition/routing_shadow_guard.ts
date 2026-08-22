import type { ToolPolicy } from '../personality/types';
import type { CapabilityManifestEntry } from '../tools/types';
import type { LumiExecutionDecision } from './execution_decision';
import type { NormalizedActionIntent, NormalizedSideEffectClass } from './normalized_action_intent';

const EXTERNAL_SIDE_EFFECTS = new Set([
  'external_state_change',
  'external_communication',
]);

export interface LumiRoutingShadowComparison {
  version: 1;
  normalizedClass: NormalizedSideEffectClass;
  legacyClass: NormalizedSideEffectClass;
  normalizedKind: NormalizedActionIntent['kind'];
  legacyExternalTools: string[];
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

function isLocalMutation(entry: CapabilityManifestEntry): boolean {
  return entry.sideEffects.some(effect => (
    effect.type === 'local_write'
    || effect.type === 'local_state_change'
    || effect.type === 'desktop_control'
    || effect.type === 'process_execution'
    || effect.type === 'installation'
  ));
}

function classifyLegacyRoute(entries: CapabilityManifestEntry[]): NormalizedSideEffectClass {
  if (entries.some(isExternal)) return 'external_commit';
  if (entries.some(isLocalMutation)) return 'local_write';
  return 'none';
}

function isExpectedExternalTool(
  intent: NormalizedActionIntent,
  entry: CapabilityManifestEntry,
): boolean {
  if (!isExternal(entry)) return false;
  if (intent.kind === 'messaging_send') {
    return entry.family === 'messaging'
      || entry.lane === 'messaging'
      || /(?:message|wechat|weixin|feishu|mail|slack|teams|send)/i.test(entry.toolName);
  }
  return true;
}

/**
 * Compare the normalized safety route with the legacy capability route used
 * during the internal rollout. A disagreement can never authorize an external
 * side effect: all external-capability tools are removed from the executor
 * policy until both routes agree.
 */
export function compareLumiRoutingShadow(input: {
  normalizedIntent: NormalizedActionIntent;
  execution: LumiExecutionDecision;
  manifest: CapabilityManifestEntry[];
}): LumiRoutingShadowComparison {
  const routeNames = new Set(input.execution.toolRoute?.toolNames || []);
  const routedEntries = input.manifest.filter(entry => routeNames.has(entry.toolName));
  const legacyExternalEntries = routedEntries.filter(isExternal);
  const allExternalTools = unique(input.manifest.filter(isExternal).map(entry => entry.toolName));
  const normalizedClass = input.normalizedIntent.sideEffectClass;
  const legacyClass = classifyLegacyRoute(routedEntries);
  const expectsExternal = normalizedClass === 'external_commit';
  const hasExpectedExternal = legacyExternalEntries.some(entry => (
    isExpectedExternalTool(input.normalizedIntent, entry)
  ));
  const unexpectedExternal = !expectsExternal && legacyExternalEntries.length > 0;
  const missingOrWrongExternal = expectsExternal && !hasExpectedExternal;
  const aligned = !unexpectedExternal && !missingOrWrongExternal;
  const externalCommitBlocked = !aligned && (
    expectsExternal || legacyExternalEntries.length > 0
  );
  const reason = aligned
    ? 'normalized intent and legacy capability route agree on external side effects'
    : unexpectedExternal
      ? `normalized ${input.normalizedIntent.kind} is non-committing but the legacy route exposed external tools`
      : `normalized ${input.normalizedIntent.kind} requires an external commit but the legacy route did not expose a matching external capability`;

  return {
    version: 1,
    normalizedClass,
    legacyClass,
    normalizedKind: input.normalizedIntent.kind,
    legacyExternalTools: legacyExternalEntries.map(entry => entry.toolName),
    blockedExternalTools: externalCommitBlocked ? allExternalTools : [],
    aligned,
    externalCommitBlocked,
    reason,
  };
}

function blockPolicyExternalTools(
  policy: ToolPolicy,
  blockedTools: string[],
): ToolPolicy {
  const blocked = new Set(blockedTools);
  return {
    ...policy,
    allowedTools: (policy.allowedTools || []).filter(name => name === '*' || !blocked.has(name)),
    forbiddenTools: unique([...(policy.forbiddenTools || []), ...blockedTools]),
    requireConfirmation: (policy.requireConfirmation || []).filter(name => !blocked.has(name)),
  };
}

export function applyLumiRoutingShadowGuard(
  execution: LumiExecutionDecision,
  comparison: LumiRoutingShadowComparison,
): LumiExecutionDecision {
  if (!comparison.externalCommitBlocked) return execution;
  const blocked = new Set(comparison.blockedExternalTools);
  const toolPolicy = blockPolicyExternalTools(execution.toolPolicy, comparison.blockedExternalTools);
  const baseToolPolicy = blockPolicyExternalTools(execution.baseToolPolicy, comparison.blockedExternalTools);
  const toolRoute = execution.toolRoute
    ? {
        ...execution.toolRoute,
        toolNames: execution.toolRoute.toolNames.filter(name => !blocked.has(name)),
        forbiddenToolNames: unique([
          ...(execution.toolRoute.forbiddenToolNames || []),
          ...comparison.blockedExternalTools,
        ]),
        reasons: unique([
          ...execution.toolRoute.reasons,
          `shadow route blocked external commit: ${comparison.reason}`,
        ]),
      }
    : execution.toolRoute;
  return {
    ...execution,
    baseToolPolicy,
    selfRepairToolPolicy: execution.selfRepairToolPolicy
      ? blockPolicyExternalTools(execution.selfRepairToolPolicy, comparison.blockedExternalTools)
      : null,
    clientActionToolPolicy: execution.clientActionToolPolicy
      ? blockPolicyExternalTools(execution.clientActionToolPolicy, comparison.blockedExternalTools)
      : null,
    toolPolicy,
    toolRoute,
    promptOverlay: [
      execution.promptOverlay,
      '## External Commit Shadow Gate',
      `External commit tools are disabled for this turn because route comparison diverged: ${comparison.reason}.`,
      'Do not retry through a legacy, desktop, browser, or alternate-provider path.',
    ].filter(Boolean).join('\n'),
  };
}
