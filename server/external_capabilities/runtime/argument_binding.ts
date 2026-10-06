import { stableValue } from '../../../shared/stable_json';
import { cloneDatabaseValue } from "../../db/snapshot_changes";
import type { ToolDefinition } from "../../tools/types";
import { assertExternalCapabilityArguments, type ExternalCapabilityActionProposal } from "../schema";

export function mergeActionArguments(
  action: ExternalCapabilityActionProposal,
  suppliedInput: unknown,
): Record<string, unknown> {
  const supplied = assertExternalCapabilityArguments(suppliedInput);
  const allowed = new Set(action.tool.userArgumentNames);
  const fixed = cloneDatabaseValue(action.tool.fixedArguments);
  const userArguments: Record<string, unknown> = {};
  const unexpected: string[] = [];
  for (const [key, value] of Object.entries(supplied)) {
    if (Object.prototype.hasOwnProperty.call(fixed, key)) {
      if (JSON.stringify(stableValue(value)) !== JSON.stringify(stableValue(fixed[key]))) {
        throw new Error(`Server-owned action argument '${key}' cannot be overridden.`);
      }
      continue;
    }
    if (!allowed.has(key)) unexpected.push(key);
    else userArguments[key] = value;
  }
  if (unexpected.length) throw new Error(`Unsupported action argument(s): ${unexpected.join(', ')}.`);
  return {
    ...fixed,
    ...userArguments,
  };
}

export function projectedActionParameters(
  definition: ToolDefinition,
  action: ExternalCapabilityActionProposal,
): Record<string, unknown> {
  const raw = definition.parameters || {};
  let properties: Record<string, unknown> = {};
  let required: string[] = [];
  if (raw.type === 'object' && raw.properties && typeof raw.properties === 'object') {
    properties = raw.properties;
    required = Array.isArray(raw.required) ? raw.required.map(String) : [];
  } else {
    properties = Object.fromEntries(Object.entries(raw).map(([name, descriptor]) => {
      const value = descriptor && typeof descriptor === 'object'
        ? descriptor as Record<string, unknown>
        : {};
      if (value.required === true) required.push(name);
      return [name, Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'required'))];
    }));
  }
  const exposed = new Set(action.tool.userArgumentNames);
  return {
    type: 'object',
    properties: Object.fromEntries(Object.entries(properties).filter(([name]) => exposed.has(name))),
    required: required.filter(name => exposed.has(name)),
    additionalProperties: false,
  };
}
