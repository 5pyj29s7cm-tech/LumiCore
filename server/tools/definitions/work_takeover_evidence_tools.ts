import type { ToolRegistry } from '../registry';
import { getAuditedTaskEvidenceWorkflow, listTaskEvidenceWorkflowEligibleReceipts, promoteTaskEvidenceWorkflow, startTaskEvidenceWorkflow, transitionTaskEvidenceWorkflowStep } from '../../work_takeover/evidence_workflow';
import { getEvidenceWorkflowCompletion, getNextEvidenceWorkflowStep, type EvidenceWorkflowStepStatus } from '../../../shared/evidence_workflow';
import { requireTask, asStringArray, evidenceBlueprints, taskStateContract, taskStateEvidence, registerWorkTakeoverTool } from './work_takeover_shared';

export function registerWorkTakeoverEvidenceTools(registry: ToolRegistry): void {
  registerWorkTakeoverTool(registry, {
    name: 'work_takeover_evidence_start',
    description: 'Attach a persistent, generic evidence workflow to an active work takeover task. Each automatic step may name the exact tool whose verified action receipt is required before completion.',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Work takeover task id.' },
        definitionId: { type: 'string', description: 'Stable workflow definition id.' },
        stagesInScope: { type: 'array', description: 'Workflow stages to activate initially.' },
        steps: {
          type: 'array',
          description: 'Ordered evidence step definitions.',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              label: { type: 'string' },
              stage: { type: 'string' },
              order: { type: 'number' },
              executionMode: { type: 'string', description: 'automatic, assisted, or manual.' },
              tool: { type: 'string', description: 'Exact tool name whose persisted verified receipt proves this step.' },
              verificationRequired: { type: 'boolean' },
              requiredEvidence: { type: 'array' },
              confirmationRequired: { type: 'array' },
              targetIdentity: { type: 'string', description: 'Exact intended artifact/resource identity before execution. Required for tool-backed completion; never copy an unrelated receipt target.' },
            },
            required: ['id', 'label', 'stage', 'executionMode'],
          },
        },
      },
      required: ['id', 'definitionId', 'steps'],
    },
    handler: async (args, context) => {
      const { userId, task } = requireTask(args, context, true);
      const result = startTaskEvidenceWorkflow({
        userId,
        taskId: task.id,
        definitionId: String(args.definitionId || ''),
        blueprints: evidenceBlueprints(args.steps),
        stagesInScope: asStringArray(args.stagesInScope),
      });
      return JSON.stringify({
        ok: true,
        status: 'started',
        persisted: true,
        task: result.task,
        workflow: result.workflow,
      }, null, 2);
    },
    capability: taskStateContract({
      id: 'work-takeover.evidence.start',
      operation: 'create',
      successStatuses: ['started'],
      requiredFields: ['workflow.id', 'workflow.status'],
    }),
    evidence: taskStateEvidence('work-takeover.evidence.start', 'create'),
  });

  registerWorkTakeoverTool(registry, {
    name: 'work_takeover_evidence_update',
    description: 'Advance one evidence-workflow step on an active work takeover task. A verification-required completion succeeds only when the server finds a matching verified receipt in the scoped conversation action ledger.',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Work takeover task id.' },
        stepId: { type: 'string', description: 'Evidence workflow step id.' },
        status: { type: 'string', description: 'pending, running, waiting_confirmation, waiting_human, completed, skipped, or failed.' },
        receiptIds: { type: 'array', description: 'Exact verified action receipt ids bound to this task and the step target. May be omitted only when exactly one eligible receipt exists.' },
        outputSummary: { type: 'string' },
        blocker: { type: 'string' },
      },
      required: ['id', 'stepId', 'status'],
    },
    handler: async (args, context) => {
      const { userId, task } = requireTask(args, context, true);
      const result = transitionTaskEvidenceWorkflowStep({
        userId,
        taskId: task.id,
        stepId: String(args.stepId || ''),
        status: String(args.status || '') as EvidenceWorkflowStepStatus,
        receiptIds: asStringArray(args.receiptIds),
        outputSummary: args.outputSummary ? String(args.outputSummary) : undefined,
        blocker: args.blocker ? String(args.blocker) : undefined,
      });
      return JSON.stringify({
        ok: true,
        status: 'updated',
        persisted: true,
        task: result.task,
        workflow: result.workflow,
      }, null, 2);
    },
    capability: taskStateContract({
      id: 'work-takeover.evidence.update',
      operation: 'mutate',
      successStatuses: ['updated'],
      requiredFields: ['workflow.id', 'workflow.status'],
      limitations: ['Completion is accepted only after the server validates a matching verified action receipt in the same user/domain/organization scope.'],
    }),
    evidence: taskStateEvidence('work-takeover.evidence.update', 'mutate'),
  });

  registerWorkTakeoverTool(registry, {
    name: 'work_takeover_evidence_status',
    description: 'Read an evidence workflow, its next step, completion, and currently eligible verified receipts from the persistent ledgers.',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Work takeover task id.' },
      },
      required: ['id'],
    },
    handler: async (args, context) => {
      const { userId, task } = requireTask(args, context, true);
      const workflow = getAuditedTaskEvidenceWorkflow(task);
      if (!workflow) throw new Error(`Task ${task.id} has no evidence workflow.`);
      const nextStep = getNextEvidenceWorkflowStep(workflow);
      const eligibleReceipts = nextStep
        ? listTaskEvidenceWorkflowEligibleReceipts({ userId, taskId: task.id, stepId: nextStep.id })
        : [];
      return JSON.stringify({
        ok: true,
        status: workflow.status,
        persisted: true,
        task,
        workflow,
        completion: getEvidenceWorkflowCompletion(workflow),
        nextStep,
        eligibleReceipts,
      }, null, 2);
    },
    capability: taskStateContract({
      id: 'work-takeover.evidence.status',
      operation: 'observe',
      successStatuses: ['ready', 'running', 'waiting_confirmation', 'waiting_human', 'blocked', 'completed'],
      risk: 'low',
      sideEffects: [{ type: 'local_read', scope: 'persistent work takeover and action receipt ledgers', reversible: true }],
      requiredFields: ['workflow.id', 'workflow.status', 'completion.total'],
    }),
    evidence: taskStateEvidence('work-takeover.evidence.status', 'observe'),
  });

  registerWorkTakeoverTool(registry, {
    name: 'work_takeover_evidence_promote',
    description: 'Expand an active evidence workflow into additional predefined stages without replacing its verified prior evidence.',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Work takeover task id.' },
        stages: { type: 'array', description: 'Additional stage ids to activate.' },
      },
      required: ['id', 'stages'],
    },
    handler: async (args, context) => {
      const { userId, task } = requireTask(args, context, true);
      const result = promoteTaskEvidenceWorkflow({
        userId,
        taskId: task.id,
        stages: asStringArray(args.stages) || [],
      });
      return JSON.stringify({
        ok: true,
        status: 'promoted',
        persisted: true,
        task: result.task,
        workflow: result.workflow,
      }, null, 2);
    },
    capability: taskStateContract({
      id: 'work-takeover.evidence.promote',
      operation: 'mutate',
      successStatuses: ['promoted'],
      requiredFields: ['workflow.id', 'workflow.stagesInScope'],
    }),
    evidence: taskStateEvidence('work-takeover.evidence.promote', 'mutate'),
  });
}
