import type { ToolRegistry } from '../registry';
import type { ToolContext } from '../types';
import type { ToolDefinition } from '../types';

export function selfImprovementScope(context?: ToolContext) {
  return {
    userId: context?.userId || 'anonymous',
    domain: context?.domain === 'work' ? 'work' as const : 'personal' as const,
    orgId: context?.domain === 'work' ? context?.orgId : '',
  };
}

function assertLocalSelfImprovementContext(context?: ToolContext): void {
  if (context?.localExecution !== true) {
    throw new Error('Self-improvement source operations are restricted to the authenticated local desktop administrator.');
  }
  if (context?.domain === 'work') {
    throw new Error('Host source self-improvement is available only in the local personal administrator workspace.');
  }
}

export function registerLocalSelfImprovementTool(registry: ToolRegistry, tool: Omit<ToolDefinition, 'permission'>): void {
  registry.register({ ...tool, permission: 'admin', handler: async (args, context) => {
    assertLocalSelfImprovementContext(context);
    return tool.handler(args, context);
  } });
}

export function capabilityLearningScope(context?: ToolContext) {
  return {
    userId: context?.userId || 'anonymous',
    scopeDomain: context?.domain === 'work' && context?.orgId ? 'work' as const : 'personal' as const,
    orgId: context?.domain === 'work' ? context?.orgId : '',
  };
}