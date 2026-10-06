import { WorkflowStateError } from './contracts';
import type { WorkflowRun } from './contracts';
import { workflowStepExecutionKey } from './execution_identity';
import { clone } from './values';

function valueAtPath(value: unknown, path: string): unknown {
  if (!path) return value;
  if (path.split('.').some(segment => ['__proto__', 'prototype', 'constructor'].includes(segment))) throw new WorkflowStateError('Unsafe workflow reference path.');
  return path.split('.').filter(Boolean).reduce<unknown>((current, segment) => {
    if (!current || typeof current !== 'object') return undefined;
    return (current as Record<string, unknown>)[segment];
  }, value);
}

/** Resolve persisted references from ephemeral run inputs without writing the secret back to the ledger. */
export function resolveWorkflowValue(template: unknown, ephemeralInputs: Record<string, unknown>, depth = 0, run?: WorkflowRun): unknown {
  if (depth > 8) throw new WorkflowStateError('Workflow argument template is nested too deeply.');
  rejectStringEncodedReference(template);
  if (Array.isArray(template)) return template.map(item => resolveWorkflowValue(item, ephemeralInputs, depth + 1, run));
  if (!template || typeof template !== 'object') return template;
  const record = template as Record<string, unknown>;
  if ('$stepOutputRef' in record) {
    const reference = parseStepOutputReference(record);
    if (!run) throw new WorkflowStateError('A step output reference requires the current workflow run.');
    const receipt = [...run.receipts].reverse().find(item => item.stepId === reference.stepId
      && item.idempotencyKey === workflowStepExecutionKey(run, reference.stepId) && item.status === 'verified');
    if (!receipt || receipt.resultReusable !== true) throw new WorkflowStateError(`Workflow output '${reference.stepId}' has no complete verified result in this run.`);
    const result = valueAtPath(receipt.result, reference.path);
    if (result === undefined) throw new WorkflowStateError(`Workflow output '${record.$stepOutputRef}' is missing.`);
    return clone(result);
  }
  const reference = typeof record.$secretRef === 'string'
    ? record.$secretRef
    : typeof record.$inputRef === 'string'
      ? record.$inputRef
      : '';
  if (reference && Object.keys(record).length === 1) {
    const direct = valueAtPath(ephemeralInputs, reference.replace(/^inputs\./, ''));
    const fallbackKey = reference.split('.').filter(Boolean).pop() || '';
    const fallback = fallbackKey ? ephemeralInputs[fallbackKey] : undefined;
    const resolved = direct === undefined ? fallback : direct;
    if (resolved === undefined) throw new WorkflowStateError(`Workflow input '${fallbackKey || reference}' must be supplied at run time.`);
    return resolved;
  }
  return Object.fromEntries(
    Object.entries(record).map(([key, item]) => [key, resolveWorkflowValue(item, ephemeralInputs, depth + 1, run)]),
  );
}

export function parseStepOutputReference(record: Record<string, unknown>): { stepId: string; path: string } {
  if (Object.keys(record).length !== 1 || typeof record.$stepOutputRef !== 'string'
    || !/^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*$/.test(record.$stepOutputRef)) throw new WorkflowStateError('A step output reference must be exactly { $stepOutputRef: "stepId.optional.path" }.');
  const parts = record.$stepOutputRef.split('.');
  if (parts.some(part => ['__proto__', 'prototype', 'constructor'].includes(part))) throw new WorkflowStateError('Unsafe workflow reference path.');
  return { stepId: parts[0], path: parts.slice(1).join('.') };
}

export function rejectStringEncodedReference(value: unknown): void {
  if (typeof value === 'string' && /^\s*\$?\{\s*["']?\$(?:inputRef|stepOutputRef|secretRef)["']?\s*:/u.test(value)) {
    throw new WorkflowStateError('Workflow references must be JSON objects, not strings containing reference syntax. Use {"$inputRef":"inputs.name"} or {"$stepOutputRef":"step_1"} as the argument value.');
  }
}
