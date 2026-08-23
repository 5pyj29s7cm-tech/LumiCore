import type { ToolPolicy } from '../personality/types';
import type { ToolContext } from './types';

/**
 * Network model/tool surfaces are deliberately capability-poor.  An
 * authenticated remote caller may converse with the model and perform a
 * fixed-endpoint public web search, but it may not inherit the host machine,
 * credentials, settings, desktop, process or communication capabilities of a
 * signed-in native Lumi client.
 */
export const REMOTE_RESTRICTED_TOOL_ALLOWLIST = Object.freeze([
  'web_search',
] as const);

const REMOTE_RESTRICTED_TOOL_SET = new Set<string>(REMOTE_RESTRICTED_TOOL_ALLOWLIST);

export function isRemoteRestrictedToolAllowed(toolName: unknown): boolean {
  return REMOTE_RESTRICTED_TOOL_SET.has(String(toolName || '').trim());
}

export function isRemoteRestrictedExecution(context?: ToolContext): boolean {
  return context?.executionBoundary === 'remote_restricted';
}

type VisibleToolRoute = {
  toolNames: string[];
  categories: string[];
  reasons: string[];
  totalAvailable: number;
  maxTools: number;
  truncated: boolean;
  unavailableMcpServers?: string[];
  forbiddenToolNames?: string[];
};

/**
 * Tool routing is also observable state: it is sent to socket clients and is
 * summarized into model prompts. Keep that projection behind the same
 * immutable boundary as declarations/execution so a remote caller cannot use
 * routing diagnostics as a host-capability inventory.
 */
export function restrictVisibleToolRouteForExecutionBoundary<T extends VisibleToolRoute>(
  route: T | null,
  boundary: ToolContext['executionBoundary'],
): T | null {
  if (!route || boundary !== 'remote_restricted') return route;

  const toolNames = route.toolNames.filter(isRemoteRestrictedToolAllowed);
  return {
    ...route,
    toolNames,
    categories: toolNames.length > 0 ? ['web'] : [],
    reasons: ['remote execution boundary applied'],
    totalAvailable: toolNames.length,
    maxTools: Math.min(route.maxTools, REMOTE_RESTRICTED_TOOL_ALLOWLIST.length),
    truncated: false,
    unavailableMcpServers: [],
    forbiddenToolNames: [],
  };
}

export const REMOTE_RESTRICTED_PROMPT_OVERLAY = [
  '## Remote execution boundary',
  'This network session has a deliberately minimal capability set.',
  'Use only tools actually declared for this turn. Do not infer, enumerate, delegate to, or claim access to capabilities that are not declared.',
].join('\n');

const REMOTE_RESTRICTED_SYSTEM_PROMPT = [
  'You are Lumi. Be helpful, honest, concise, and conversational.',
  'Preserve the current conversation context and answer in the language used by the user.',
  'Never claim an action completed without a successful current-turn receipt.',
  REMOTE_RESTRICTED_PROMPT_OVERLAY,
].join('\n');

/**
 * Native personality prompts intentionally describe Lumi's complete local
 * body. That is useful inside the desktop client but is itself a capability
 * inventory on a network session, so remote surfaces receive a compact
 * conversation prompt instead of attempting brittle line-by-line redaction.
 */
export function restrictSystemPromptForExecutionBoundary(
  original: string,
  boundary: ToolContext['executionBoundary'],
): string {
  return boundary === 'remote_restricted'
    ? REMOTE_RESTRICTED_SYSTEM_PROMPT
    : original;
}

export function executionBoundaryPromptOverlay(
  original: string,
  boundary: ToolContext['executionBoundary'],
): string {
  return boundary === 'remote_restricted'
    ? REMOTE_RESTRICTED_PROMPT_OVERLAY
    : original;
}

export function restrictVisibleToolNamesForExecutionBoundary(
  names: readonly string[],
  boundary: ToolContext['executionBoundary'],
): string[] {
  return boundary === 'remote_restricted'
    ? names.filter(isRemoteRestrictedToolAllowed)
    : [...names];
}

/**
 * Intersect an entry-owned policy with the immutable remote allowlist.  This
 * is used for model declarations; ToolRegistry separately enforces the same
 * allowlist at execution time so a forged tool call cannot bypass discovery.
 */
export function restrictToolPolicyForExecutionBoundary(
  policy: ToolPolicy,
  boundary: ToolContext['executionBoundary'],
): ToolPolicy {
  if (boundary !== 'remote_restricted') {
    return {
      ...policy,
      allowedTools: [...(policy.allowedTools || [])],
      requireConfirmation: [...(policy.requireConfirmation || [])],
      forbiddenTools: [...(policy.forbiddenTools || [])],
      securityOverrides: policy.securityOverrides
        ? { ...policy.securityOverrides }
        : undefined,
    };
  }

  const originallyAllowed = new Set(policy.allowedTools || []);
  const allowsAll = originallyAllowed.has('*');
  const allowedTools = REMOTE_RESTRICTED_TOOL_ALLOWLIST.filter(name => (
    (allowsAll || originallyAllowed.has(name))
    && !(policy.forbiddenTools || []).includes('*')
    && !(policy.forbiddenTools || []).includes(name)
  ));
  const allowed = new Set<string>(allowedTools);

  return {
    ...policy,
    allowedTools: [...allowedTools],
    requireConfirmation: (policy.requireConfirmation || []).filter(name => allowed.has(name)),
    forbiddenTools: Array.from(new Set(policy.forbiddenTools || [])),
    maxIterations: Math.max(0, Math.min(4, Number(policy.maxIterations) || 0)),
    securityOverrides: policy.securityOverrides
      ? Object.fromEntries(Object.entries(policy.securityOverrides).filter(([name]) => allowed.has(name)))
      : undefined,
  };
}
