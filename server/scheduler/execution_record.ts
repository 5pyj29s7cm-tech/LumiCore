import type { CapabilityExecutionPlan } from "../cognition/capability_execution_plan";
import type { ToolExecutionRecord } from "../tools/types";
import type { ScheduledTaskExecutionContract } from './contracts';
import { redactSchedulerDiagnostic } from './diagnostics';

export function buildScheduledTaskRecord(
    plan: CapabilityExecutionPlan,
    input: {
      verified: boolean;
      status: 'verified' | 'blocked' | 'failed' | 'unknown';
      error?: string;
      delivery?: { deliveryCount: number; persistedCount: number; emittedCount: number; withheldCount: number };
      durationMs: number;
      contract: ScheduledTaskExecutionContract;
      stoppingReason: string;
    },
  ): ToolExecutionRecord {
    const node = plan.nodes.find(candidate => candidate.toolName === 'scheduler_task_handler');
    if (!node) throw new Error('Scheduled capability plan is missing its handler adapter.');
    const receipt = {
      status: input.status,
      verified: input.verified,
      scheduledTaskId: plan.intent.target,
      durationMs: input.durationMs,
      outcome: input.verified ? 'accepted' : input.status,
      successCriteria: input.contract.successCriteria,
      successCriteriaMet: input.verified ? input.contract.successCriteria : [],
      evidence: input.contract.evidence,
      stoppingReason: input.stoppingReason,
      retry: input.contract.retry,
      concurrency: input.contract.concurrency,
      finalAcceptance: input.contract.finalAcceptance,
      ...(input.delivery || {}),
    };
    return {
      id: `receipt_${plan.taskId}_${input.status}`,
      taskId: plan.taskId,
      turnId: plan.taskId,
      requestId: plan.taskId,
      resolutionId: 'resolution:' + plan.taskId,
      idempotencyKey: `${plan.taskId}:scheduler_task_handler:${input.status}`,
      name: 'scheduler_task_handler',
      arguments: { scheduledTaskId: plan.intent.target, executionId: plan.taskId },
      result: JSON.stringify(receipt),
      receipt,
      ...(input.error ? { error: redactSchedulerDiagnostic(input.error) } : {}),
      capability: {
        capabilityId: node.capabilityId,
        lane: node.lane,
        operation: node.operation,
        risk: node.risk,
        sideEffects: node.sideEffects.map(effect => ({ ...effect })),
        verification: {
          ...node.verification,
          requiredFields: [...node.verification.requiredFields],
          requiredValues: node.verification.requiredValues ? { ...node.verification.requiredValues } : undefined,
          requiredArtifacts: [...(node.verification.requiredArtifacts || [])],
          requiredArtifactCollections: [...(node.verification.requiredArtifactCollections || [])],
          successStatuses: [...(node.verification.successStatuses || [])],
          failureStatuses: [...(node.verification.failureStatuses || [])],
          successSignals: [...node.verification.successSignals],
          limitations: [...node.verification.limitations],
        },
      },
      terminalVerification: {
        status: input.verified ? 'verified' : input.status === 'failed' ? 'failed' : 'unverified',
        strategy: 'terminal_receipt',
        reason: input.verified
          ? 'Main scheduler accepted the outcome after persisting its verified terminal receipt.'
          : input.error ? redactSchedulerDiagnostic(input.error) : input.status,
      },
    };
  }
