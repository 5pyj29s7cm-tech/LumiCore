import type { ParsedToolCall, ToolExecutionRecord } from '../tools/types';
import type { ToolRegistry } from '../tools/registry';

type PlannedToolCall = ParsedToolCall & { id: string };

// This recognizes a language-level quantifier only. Tool names, domains and
// enum members come exclusively from each registered tool's schema.
const BROAD_SCOPE_RE = /(?:\u6240\u6709|\u5168\u90e8|\u5168\u90e8\u7684|\u5404\u7c7b|\u5404\u4e2a|\u6bcf\u4e2a|\u6bcf\u4e00|\u5176\u4ed6|\u5176\u4f59|\u5269\u4e0b|\u5b8c\u6574|\b(?:all|every|each|other|remaining|rest of)\b)/iu;

function normalizedSchema(registry: ToolRegistry, toolName: string): Record<string, any> {
  const parameters = registry.get(toolName)?.parameters || {};
  if (parameters.type === 'object' && parameters.properties) return parameters;
  const properties: Record<string, any> = {};
  const required: string[] = [];
  for (const [name, value] of Object.entries(parameters)) {
    const definition = value as Record<string, any>;
    properties[name] = definition;
    if (definition?.required) required.push(name);
  }
  return { type: 'object', properties, ...(required.length ? { required } : {}) };
}

/**
 * Preserve an explicitly broad user scope after the model has selected a
 * capability. This is deliberately domain agnostic: it reads only the chosen
 * tool's evidence descriptor and parameter enum.
 */
export function normalizePlannedToolScope(
  calls: PlannedToolCall[],
  registry: ToolRegistry,
  taskText: string,
): PlannedToolCall[] {
  if (!BROAD_SCOPE_RE.test(String(taskText || ''))) return calls;

  const normalized: PlannedToolCall[] = [];
  for (const call of calls) {
    const tool = registry.get(call.name);
    const descriptor = tool?.evidence;
    const subjectArgument = descriptor?.subjectArgument;
    if (!tool || !descriptor || !subjectArgument || !['observe', 'test'].includes(descriptor.operation)) {
      normalized.push(call);
      continue;
    }

    const schema = normalizedSchema(registry, call.name);
    const values = schema.properties?.[subjectArgument]?.enum;
    if (!Array.isArray(values) || values.length === 0) {
      normalized.push(call);
      continue;
    }

    const required = Array.isArray(schema.required) && schema.required.includes(subjectArgument);
    if (!required) {
      const args = { ...(call.arguments || {}) };
      delete args[subjectArgument];
      normalized.push({ ...call, arguments: args });
      continue;
    }

    for (const [index, value] of values.entries()) {
      normalized.push({
        ...call,
        id: index === 0 ? call.id : `${call.id}_scope_${index}`,
        arguments: { ...(call.arguments || {}), [subjectArgument]: value },
      });
    }
  }
  return normalized;
}

/** Attach an auditable, generic evidence envelope to a terminal receipt. */
export function buildToolEvidenceRecord(
  registry: ToolRegistry,
  toolName: string,
  args: Record<string, any>,
): ToolExecutionRecord['evidence'] | undefined {
  const descriptor = registry.getEvidenceDescriptor(toolName);
  if (!descriptor) return undefined;
  const schema = normalizedSchema(registry, toolName);
  const subjectArgument = descriptor.subjectArgument;
  const declaredScope = subjectArgument
    ? schema.properties?.[subjectArgument]?.enum
    : undefined;
  const selected = subjectArgument ? args?.[subjectArgument] : undefined;
  const scope = selected !== undefined && selected !== null && String(selected).trim()
    ? [String(selected)]
    : Array.isArray(declaredScope)
      ? declaredScope.map(value => String(value))
      : [];
  return {
    capability: descriptor.capability,
    operation: descriptor.operation,
    assurance: descriptor.assurance,
    scope,
    ...(descriptor.limitations?.length ? { limitations: [...descriptor.limitations] } : {}),
  };
}

export const GENERIC_TOOL_PLANNING_PROMPT = [
  '## Tool planning and execution',
  '- You are the planner: understand the user goal, decompose it, select declared tools, execute them now, inspect receipts, and continue until the requested result is complete or a real blocker is proven.',
  '- Preserve scope words exactly. A request for all/every/each/other/remaining items must not silently become one default item; use an all-scope call when supported or call the selected tool for every declared enum member.',
  '- Do not announce that you will run a tool and then stop. When work is requested and an appropriate declared tool exists, call it in this turn.',
  '- Tool descriptions and schemas are the capability source of truth. Do not invent modes, tools, settings, execution, or results.',
  '- After tool output, report only what the receipts support, include real blockers and relevant limitations, and distinguish observed state from live verification.',
].join('\n');

export const GENERIC_TOOL_REPLAN_PROMPT = [
  'Your previous response stopped before using a relevant evidence-producing tool that is declared for this turn.',
  'Re-plan from the user goal now. Call the appropriate tool(s), preserve the requested scope, inspect the receipts, and only then answer.',
  'If none of the declared tools can actually satisfy the goal, state the concrete capability gap instead of promising future execution.',
].join(' ');

export function hasRelevantEvidenceTool(
  registry: ToolRegistry,
  taskText: string,
  exposedToolNames: Iterable<string>,
): boolean {
  const exposed = new Set(exposedToolNames);
  return registry.findRelevant(taskText, {
    limit: 8,
    evidenceOperations: ['observe', 'test'],
  }).some(tool => exposed.has(tool.name));
}
