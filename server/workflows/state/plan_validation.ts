import { WorkflowStateError } from './contracts';
import { rejectStringEncodedReference, parseStepOutputReference } from './input_resolution';
import type { WorkflowStepDefinition } from './contracts';
import { clone, redactWorkflowValue } from './values';

function stepOutputDependencies(value: unknown, depth = 0): string[] {
  if (depth > 8) throw new WorkflowStateError('Workflow reference is nested too deeply.');
  rejectStringEncodedReference(value);
  if (!value || typeof value !== 'object') return [];
  if ('$stepOutputRef' in value) return [parseStepOutputReference(value as Record<string, unknown>).stepId];
  return Object.values(value).flatMap(item => stepOutputDependencies(item, depth + 1));
}

function normalizeStep(step: WorkflowStepDefinition, index: number): WorkflowStepDefinition {
  const stepId = String(step.stepId || `step_${index + 1}`).trim();
  const capabilityId = String(step.capabilityId || '').trim();
  if (!stepId) throw new WorkflowStateError(`Workflow step ${index + 1} is missing stepId.`);
  if (!capabilityId) throw new WorkflowStateError(`Workflow step ${stepId} is missing capabilityId.`);
  // Validate before redaction can turn a malformed literal into an input placeholder.
  stepOutputDependencies(step.argumentsTemplate);
  return {
    ...clone(step),
    stepId,
    capabilityId,
    dependsOn: [...new Set((step.dependsOn || []).map(String))],
    argumentsTemplate: redactWorkflowValue(step.argumentsTemplate || {}, `definition.steps.${stepId}.arguments`) as Record<string, unknown>,
  };
}

export function validateWorkflowSteps(steps: WorkflowStepDefinition[]): WorkflowStepDefinition[] {
  if (!Array.isArray(steps) || steps.length === 0) throw new WorkflowStateError('A workflow requires at least one step.');
  const normalized = steps.map(normalizeStep);
  const ids = new Set<string>();
  for (const step of normalized) {
    if (ids.has(step.stepId)) throw new WorkflowStateError(`Duplicate workflow stepId '${step.stepId}'.`);
    ids.add(step.stepId);
  }
  for (const step of normalized) {
    for (const dependency of step.dependsOn || []) {
      if (!ids.has(dependency)) throw new WorkflowStateError(`Workflow step '${step.stepId}' depends on missing step '${dependency}'.`);
      if (dependency === step.stepId) throw new WorkflowStateError(`Workflow step '${step.stepId}' cannot depend on itself.`);
    }
  }
  topologicallyOrderWorkflowSteps(normalized);
  const ancestors = (step: WorkflowStepDefinition): Set<string> => new Set((step.dependsOn || []).flatMap(id => [id, ...ancestors(normalized.find(item => item.stepId === id)!)]));
  for (const step of normalized) {
    const allowed = ancestors(step);
    for (const reference of stepOutputDependencies(step.argumentsTemplate)) {
      if (!allowed.has(reference)) throw new WorkflowStateError(`Workflow step '${step.stepId}' may reference only an earlier declared dependency, not '${reference}'.`);
    }
  }
  return normalized;
}

export function topologicallyOrderWorkflowSteps(steps: WorkflowStepDefinition[]): WorkflowStepDefinition[] {
  const byId = new Map(steps.map(step => [step.stepId, step]));
  const pending = new Map(steps.map((step, index) => [step.stepId, {
    step,
    index,
    dependencies: new Set(step.dependsOn || []),
  }]));
  const completed = new Set<string>();
  const ordered: WorkflowStepDefinition[] = [];
  while (pending.size > 0) {
    const ready = Array.from(pending.values())
      .filter(item => Array.from(item.dependencies).every(dependency => completed.has(dependency)))
      .sort((left, right) => left.index - right.index);
    if (ready.length === 0) {
      const unresolved = Array.from(pending.keys()).join(', ');
      throw new WorkflowStateError(`Workflow dependency cycle detected among: ${unresolved}.`);
    }
    for (const item of ready) {
      if (!byId.has(item.step.stepId)) continue;
      pending.delete(item.step.stepId);
      completed.add(item.step.stepId);
      ordered.push(clone(item.step));
    }
  }
  return ordered;
}
