import { ToolDefinition, ToolPermission, SecurityLevel, ToolContext } from './types';
import { ToolPolicy } from '../personality/types';
import { evaluateActionConstitution } from './action_constitution';

export type EffectiveSecurity = { level: SecurityLevel; reason: string };

/**
 * Canonical tool-name visibility rule shared by model declarations, routed
 * workflows and the executor. Security level/confirmation is resolved later;
 * this function answers only whether the name exists in the effective policy.
 */
export function isToolNameAllowedByPolicy(toolName: string, policy?: ToolPolicy): boolean {
  if (!policy) return true;
  const forbidden = policy.forbiddenTools || [];
  if (forbidden.includes('*') || forbidden.includes(toolName)) return false;
  const allowed = policy.allowedTools || [];
  return allowed.includes('*') || allowed.includes(toolName);
}

export function getToolExecutionTimeoutMs(name: string): number {
  if (name === 'computer_use') return 10 * 60_000;
  if (name === 'generate_video') return 15 * 60_000;
  if (/^model_configuration_(?:update|test)$/i.test(name)) return 2 * 60_000;
  if (name === 'transcribe_audio_to_text_file') return 60 * 60_000;
  if (/^mcp_cad-drafting_autocad_playback_file$/i.test(name)) return 30 * 60_000;
  if (/^cad_prepare_autocad_operations$/i.test(name)) return 5 * 60_000;
  if (/^(web_login_|url_fetch_logged_in)/i.test(name)) return 5 * 60_000;
  if (name === 'legal_refresh_authoritative_sources') return 3 * 60_000;
  if (name === 'desktop_ai_roundtable') return 15 * 60_000;
  if (/^(wechat_|desktop_ai_)/i.test(name)) return 3 * 60_000;
  if (/^(work_takeover_|capability_gap_autofix|generate_skill|install_skill)/i.test(name)) return 10 * 60_000;
  if (/^desktop_/i.test(name)) return 90_000;
  if (/^floorplan_extract_geometry$/i.test(name)) return 10 * 60_000;
  if (/^(ocr_|cad_generate_dxf)$/i.test(name)) return 90_000;
  return 30_000;
}

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

  getEvidenceDescriptor(name: string): ToolDefinition['evidence'] | undefined {
    return this.tools.get(name)?.evidence;
  }

  /**
   * Generic lexical capability discovery. Domain vocabulary lives in each
   * tool description; the orchestrator does not need a branch per tool.
   */
  findRelevant(text: string, options?: {
    limit?: number;
    evidenceOperations?: Array<NonNullable<ToolDefinition['evidence']>['operation']>;
  }): ToolDefinition[] {
    const query = String(text || '').toLowerCase().trim();
    if (!query) return [];
    const ascii = query.match(/[a-z0-9_]{3,}/g) || [];
    const cjkRuns = query.match(/[\u3400-\u9fff]+/g) || [];
    const cjk: string[] = [];
    for (const run of cjkRuns) {
      for (let size = 2; size <= Math.min(4, run.length); size += 1) {
        for (let index = 0; index <= run.length - size; index += 1) {
          cjk.push(run.slice(index, index + size));
        }
      }
    }
    const tokens = Array.from(new Set([...ascii, ...cjk]));
    const allowedOperations = options?.evidenceOperations?.length
      ? new Set(options.evidenceOperations)
      : null;
    return this.list()
      .filter(tool => !allowedOperations || (tool.evidence && allowedOperations.has(tool.evidence.operation)))
      .map(tool => {
        const haystack = `${tool.name} ${tool.description} ${(tool.routingHints || []).join(' ')}`.toLowerCase();
        const score = tokens.reduce((total, token) => (
          total + (haystack.includes(token) ? Math.min(4, token.length) : 0)
        ), 0);
        return { tool, score };
      })
      .filter(item => item.score >= 4)
      .sort((left, right) => right.score - left.score)
      .slice(0, Math.max(1, options?.limit || 8))
      .map(item => item.tool);
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
    if (policy.forbiddenTools?.includes('*') || policy.forbiddenTools?.includes(toolName)) {
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
    if (!isToolNameAllowedByPolicy(toolName, policy)) {
      return { level: 'forbidden', reason: 'not in allowedTools list' };
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
      if (context?.userConfirmed === true) {
        userConfirmed = true;
      } else if (context?.requestConfirmation) {
        const allowed = await context.requestConfirmation(name, args);
        if (!allowed) {
          return `Tool "${name}" requires user confirmation and was not approved.`;
        }
        userConfirmed = true;
      } else {
        throw new Error(`Tool "${name}" requires user confirmation: ${constitutional.reason}.`);
      }
      console.log(`[Tool] Executing confirmation-level tool: ${name} (${constitutional.reason})`);
    }

    // Wrap with timeouts to prevent hanging. Vision/CAD extraction needs more room than simple tools.
    const timeoutMs = getToolExecutionTimeoutMs(name);
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
