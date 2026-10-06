import type { ExactToolScope } from './exact_tool_scope';

/** One owner combines candidate tools, the winning scope and explicit denials. */
export function createToolRouteSelection(availableNames: string[]) {
  const selected = new Set<string>();
  const forbiddenToolNames = new Set<string>();
  const categories: string[] = [];
  const reasons: string[] = [];

  function resolve(scope?: ExactToolScope) {
    const allowed = scope ? new Set(scope.toolNames) : selected;
    const toolNames = availableNames.filter(name => allowed.has(name) && !forbiddenToolNames.has(name));
    if (scope?.category) categories.splice(0, categories.length, scope.category);
    if (scope?.replaceReasons) reasons.splice(0, reasons.length, scope.reason);
    else if (scope) reasons.push(scope.reason);
    const forbidden = availableNames.filter(name => forbiddenToolNames.has(name) || scope && !allowed.has(name));
    return {
      toolNames,
      forbiddenToolNames: forbidden.length ? forbidden : undefined,
      hardAllowlist: scope ? true : undefined,
      maxIterations: typeof scope?.iterations === 'function' ? scope.iterations(toolNames.length) : scope?.iterations,
    };
  }
  return { selected, forbiddenToolNames, categories, reasons, resolve };
}
