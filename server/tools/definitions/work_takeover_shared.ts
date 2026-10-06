import type { ToolRegistry } from '../registry';
import { capabilityContract, capabilityEvidence } from '../capability_contracts';
import type { CapabilityOperation, CapabilityRisk, CapabilitySideEffect } from '../types';
import { getWorkTakeoverTask, getScopedWorkTakeoverTask } from '../../work_takeover/tasks';
import { planWorkTakeoverExecution } from '../../work_takeover/execution_planner';
import { type EvidenceWorkflowStepBlueprint } from '../../../shared/evidence_workflow';
import type { ToolDefinition } from '../types';

export function contextUser(context?: any): { userId: string; domain: string; orgId: string } {
  const scope = { userId: context?.userId || 'anonymous', domain: context?.domain || 'personal', orgId: context?.orgId || '' };
  if (scope.domain === 'work' && !scope.orgId) throw new Error('Work takeover requires the current organization scope.');
  return scope;
}

export function requireTask(args: Record<string, any>, context?: any, requireId = false) {
  const scope = contextUser(context);
  const task = getScopedWorkTakeoverTask(scope, args.id ? String(args.id) : requireId ? '' : undefined);
  if (!task) throw new Error(args.id ? 'Work takeover task not found in the current scope: ' + args.id : 'No active work takeover task found.');
  return { ...scope, task };
}

export function asStringArray(value: any): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (Array.isArray(value)) return value.map(item => String(item || '').trim()).filter(Boolean);
  return String(value)
    .split(/[\n;；]+/)
    .map(item => item.trim())
    .filter(Boolean);
}

export function compact(value: unknown): string {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

export function uniqueStrings(values: Array<string | undefined>): string[] {
  return Array.from(new Set(values.map(compact).filter(Boolean)));
}

export function evidenceBlueprints(value: unknown): EvidenceWorkflowStepBlueprint[] {
  if (!Array.isArray(value)) throw new Error('steps must be an array.');
  return value.map((item: any, index) => ({
    id: String(item?.id || '').trim(),
    label: String(item?.label || '').trim(),
    stage: String(item?.stage || '').trim(),
    order: Number.isFinite(Number(item?.order)) ? Number(item.order) : index,
    executionMode: String(item?.executionMode || 'automatic') as EvidenceWorkflowStepBlueprint['executionMode'],
    tool: item?.tool ? String(item.tool).trim() : undefined,
    verificationRequired: item?.verificationRequired === undefined
      ? undefined
      : item.verificationRequired === true,
    requiredEvidence: asStringArray(item?.requiredEvidence),
    confirmationRequired: asStringArray(item?.confirmationRequired),
    targetIdentity: item?.targetIdentity ? String(item.targetIdentity) : undefined,
  }));
}

export function planNextActions(plan: ReturnType<typeof planWorkTakeoverExecution>): string[] {
  return plan.steps.map(step => `${step.title}：${step.goal}`).slice(0, 12);
}

export function toolRunHistory(task: any, run: any): any[] {
  const current = task?.metadata?.workTakeoverToolRuns;
  return [...(Array.isArray(current) ? current.slice(-30) : []), run];
}

export function requirePersistedTask(userId: string, task: any): any {
  const persisted = task?.id ? getWorkTakeoverTask(userId, String(task.id)) : null;
  if (!persisted || persisted.updatedAt !== task.updatedAt) {
    throw new Error(`Work takeover task state was not persisted${task?.id ? `: ${task.id}` : '.'}`);
  }
  return persisted;
}

export function taskStateContract(input: {
  id: string;
  operation: Exclude<CapabilityOperation, 'unknown'>;
  successStatuses: string[];
  risk?: Exclude<CapabilityRisk, 'none'>;
  sideEffects?: CapabilitySideEffect[];
  requiredFields?: string[];
  limitations?: string[];
}) {
  return capabilityContract({
    id: input.id,
    family: 'work-takeover',
    lane: 'general',
    operation: input.operation,
    risk: input.risk || 'medium',
    sideEffects: input.sideEffects || [{ type: 'local_state_change', scope: 'persistent work takeover task ledger', reversible: true }],
    verification: {
      strategy: 'state_diff',
      required: true,
      requiredFields: ['ok', 'status', 'persisted', 'task.id', 'task.updatedAt', ...(input.requiredFields || [])],
      requiredValues: { ok: true },
      successStatuses: input.successStatuses,
      failureStatuses: ['blocked', 'failed', 'unverified'],
      successSignals: ['returned task state was reread from the persistent work takeover ledger'],
      limitations: input.limitations || ['A task-ledger update does not prove the external work outcome is complete.'],
    },
  });
}

export function taskStateEvidence(id: string, operation: Exclude<CapabilityOperation, 'unknown'>, subjectArgument = 'id') {
  return capabilityEvidence({
    id,
    operation,
    subjectArgument,
    limitations: ['This receipt proves the task state transition only; external completion requires domain-tool evidence.'],
  });
}

export function registerWorkTakeoverTool(registry: ToolRegistry, tool: Omit<ToolDefinition, 'permission' | 'securityLevel'> & { securityLevel?: ToolDefinition['securityLevel'] }): void {
  registry.register({ securityLevel: 'safe', ...tool, permission: 'user' });
}
