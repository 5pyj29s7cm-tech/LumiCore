import { ToolDefinition, ToolPermission, SecurityLevel, ToolContext } from './types';
import { ToolPolicy } from '../personality/types';
import { evaluateActionConstitution } from './action_constitution';

export type EffectiveSecurity = { level: SecurityLevel; reason: string };

function normalizeJsonSchema(params: Record<string, any>): Record<string, any> {
  if (!params || Object.keys(params).length === 0) {
    return { type: 'object', properties: {} };
  }

  // Already standard JSON Schema format
  if (params.type === 'object' && params.properties) {
    return params;
  }

  // Flat format (used by MCP tools): { key: { type, description, required } }
  // Convert to standard JSON Schema: { type: 'object', properties: {...}, required: [...] }
  const properties: Record<string, any> = {};
  const required: string[] = [];

  for (const [key, def] of Object.entries(params)) {
    const val = def as Record<string, any>;
    const propDef: Record<string, any> = {};
    if (val.type) propDef.type = val.type;
    if (val.description) propDef.description = val.description;
    if (val.enum) propDef.enum = val.enum;
    properties[key] = propDef;
    if (val.required) required.push(key);
  }

  const schema: Record<string, any> = { type: 'object', properties };
  if (required.length > 0) schema.required = required;
  return schema;
}

export class ToolRegistry {
  private tools: Map<string, ToolDefinition> = new Map();

  register(tool: ToolDefinition): boolean {
    if (this.tools.has(tool.name)) {
      console.warn(`[ToolRegistry] "${tool.name}" already registered — skipping duplicate`);
      return false;
    }
    this.tools.set(tool.name, tool);
    return true;
  }

  get(name: string): ToolDefinition | undefined {
    return this.tools.get(name);
  }

  unregister(name: string): boolean {
    return this.tools.delete(name);
  }

  unregisterByPrefix(prefix: string): string[] {
    const removed: string[] = [];
    for (const [name] of this.tools) {
      if (name.startsWith(prefix)) {
        this.tools.delete(name);
        removed.push(name);
      }
    }
    if (removed.length > 0) {
      console.log(`[ToolRegistry] Unregistered ${removed.length} tools with prefix "${prefix}"`);
    }
    return removed;
  }

  list(filterPermission?: ToolPermission): ToolDefinition[] {
    const all = Array.from(this.tools.values());
    if (!filterPermission) return all;
    return all.filter(t => t.permission === filterPermission || t.permission === 'public');
  }

  getToolDeclarations(): Array<{
    type: 'function';
    function: { name: string; description: string; parameters: Record<string, any> };
  }> {
    return this.list().map(t => ({
      type: 'function' as const,
      function: {
        name: t.name,
        description: t.description,
        parameters: normalizeJsonSchema(t.parameters),
      },
    }));
  }

  /** Resolve effective security level for a tool given a personality's policy */
  resolveSecurity(toolName: string, policy?: ToolPolicy): EffectiveSecurity {
    const tool = this.get(toolName);
    const builtIn: SecurityLevel = tool?.securityLevel || 'confirm';

    if (!policy) return { level: builtIn, reason: 'tool default' };

    // 1. forbiddenTools overrides everything
    if (policy.forbiddenTools?.includes(toolName)) {
      return { level: 'forbidden', reason: 'personality forbiddenTools list' };
    }

    // 2. Explicit per-tool security override
    if (policy.securityOverrides?.[toolName]) {
      return { level: policy.securityOverrides[toolName], reason: 'personality security override' };
    }

    // 3. Legacy requireConfirmation promotes to confirm
    if (policy.requireConfirmation.includes(toolName) && builtIn === 'safe') {
      return { level: 'confirm', reason: 'personality requireConfirmation list' };
    }

    // 4. allowedTools check — if '*' all allowed, otherwise specific list
    if (policy.allowedTools[0] !== '*') {
      if (!policy.allowedTools.includes(toolName)) {
        return { level: 'forbidden', reason: 'not in allowedTools list' };
      }
    }

    return { level: builtIn, reason: 'tool default' };
  }

  async execute(name: string, args: Record<string, any>, context?: ToolContext): Promise<string> {
    const tool = this.get(name);
    if (!tool) throw new Error(`Tool "${name}" not found in registry`);

    // Resolve effective security level
    const policy = (context as any)?.toolPolicy as ToolPolicy | undefined;
    const effective = this.resolveSecurity(name, policy);

    if (effective.level === 'forbidden') {
      throw new Error(`Tool "${name}" is forbidden: ${effective.reason}.`);
    }

    const constitutional = evaluateActionConstitution(name, args, effective.level, context);
    if (constitutional.level === 'forbidden') {
      throw new Error(`Tool "${name}" is forbidden: ${constitutional.reason}.`);
    }

    let userConfirmed = false;

    if (constitutional.level === 'confirm') {
      if (context?.requestConfirmation) {
        const allowed = await context.requestConfirmation(name, args);
        if (!allowed) {
          return `Tool "${name}" execution was declined by the user.`;
        }
        userConfirmed = true;
      } else if (effective.level === 'safe' && constitutional.requiresUserConfirmation) {
        throw new Error(`Tool "${name}" requires user confirmation: ${constitutional.reason}.`);
      }
      console.log(`[Tool] Executing confirmation-level tool: ${name} (${constitutional.reason})`);
    }

    // Wrap with timeouts to prevent hanging. Vision/CAD extraction needs more room than simple tools.
    const timeoutMs =
      name === 'computer_use' ? 180_000 :
      name.startsWith('web_login_') || name === 'url_fetch_logged_in' ? 180_000 :
      name === 'transcribe_audio_to_text_file' ? 180_000 :
      /^(ocr_|floorplan_extract_geometry|cad_generate_dxf)$/i.test(name) ? 90_000 :
      30_000;
    let timedOut = false;
    const executionContext = context
      ? {
          ...context,
          userConfirmed: context.userConfirmed === true || userConfirmed,
          isCancelled: () => timedOut || context.isCancelled?.() === true,
        }
      : context;
    let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
    try {
      const result = await Promise.race([
        tool.handler(args, executionContext),
        new Promise<string>((_, reject) => {
          timeoutHandle = setTimeout(() => {
            timedOut = true;
            reject(new Error(`Tool "${name}" timed out after ${timeoutMs / 1000}s`));
          }, timeoutMs);
        }),
      ]);

      return result;
    } finally {
      if (timeoutHandle) clearTimeout(timeoutHandle);
    }
  }
}

export const toolRegistry = new ToolRegistry();
