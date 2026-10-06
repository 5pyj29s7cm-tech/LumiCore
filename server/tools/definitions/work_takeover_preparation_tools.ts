import { recordWorkTakeoverPacket } from '../../work_takeover/packet_recording';
import fs from 'fs';
import type { ToolRegistry } from '../registry';
import { capabilityEvidence } from '../capability_contracts';
import { updateWorkTakeoverTask, recordWorkTakeoverStepExecution } from '../../work_takeover/tasks';
import { executeWorkTakeoverPlanStep, getWorkTakeoverExecutionProgress, planWorkTakeoverExecution, normalizeWorkTakeoverExecutionMode } from '../../work_takeover/execution_planner';
import { exportWorkTakeoverPacket } from '../../work_takeover/task_packet';
import { requireTask, uniqueStrings, planNextActions, requirePersistedTask, taskStateContract, taskStateEvidence, registerWorkTakeoverTool } from './work_takeover_shared';

export function registerWorkTakeoverPreparationTools(registry: ToolRegistry): void {
  registerWorkTakeoverTool(registry, {
    name: 'work_takeover_task_orchestrate',
    description: 'Choose and record a reusable execution plan for a persistent work takeover task. This bridges the task hub to capability selection: it inspects the task goal, artifacts, risks, and context, then selects tools/workflows without hard-coding one industry script. It changes Lumi internal task state only and does not perform external side effects.',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Optional work takeover task id. If omitted, uses the highest-priority active task.' },
        mode: { type: 'string', description: 'plan_only, prepare_work, or visible_external_work.' },
        record: { type: 'boolean', description: 'Whether to write the execution plan back to the task metadata. Defaults to true.' },
        refreshNextActions: { type: 'boolean', description: 'Replace task nextActions with the plan steps. Defaults to false unless the task has no nextActions.' },
      },
      required: [],
    },
    handler: async (args, context) => {
      const { userId, task } = requireTask(args, context);

      const mode = normalizeWorkTakeoverExecutionMode(args.mode);
      const plan = planWorkTakeoverExecution(task, { mode });
      const shouldRecord = args.record !== false;
      let updatedTask = task;

      if (shouldRecord) {
        const shouldRefreshNextActions = args.refreshNextActions === true || task.nextActions.length === 0;
        updatedTask = updateWorkTakeoverTask(userId, task.id, {
          status: plan.blockers.length ? 'blocked' : (task.status === 'queued' ? 'in_progress' : task.status),
          nextActions: shouldRefreshNextActions ? planNextActions(plan) : undefined,
          allowedNow: uniqueStrings([...task.allowedNow, ...plan.safeActions]),
          confirmationRequired: uniqueStrings([...task.confirmationRequired, ...plan.confirmationRequired]),
          blockedBy: plan.blockers.length ? uniqueStrings([...task.blockedBy, ...plan.blockers]) : undefined,
          metadata: {
            workTakeoverExecution: {
              lastPlan: plan,
              updatedAt: plan.generatedAt,
            },
          },
          note: `Execution orchestration selected ${plan.capabilities.map(capability => capability.label).join(' / ') || 'basic task handling'}.`,
        } as any) || task;
      }

      if (shouldRecord) updatedTask = requirePersistedTask(userId, updatedTask);
      const status = plan.blockers.length ? 'blocked' : shouldRecord ? 'orchestrated' : 'planned';

      return JSON.stringify({
        ok: status !== 'blocked',
        status,
        persisted: shouldRecord,
        task: updatedTask,
        plan,
        nextStep: plan.nextStep,
        note: shouldRecord
          ? 'Execution plan recorded on the task. Use the nextStep and suggestedTools to continue; external side effects remain confirmation-gated.'
          : 'Execution plan generated without recording. External side effects remain confirmation-gated.',
      }, null, 2);
    },
    capability: taskStateContract({
      id: 'work-takeover.task.orchestrate',
      operation: 'mutate',
      successStatuses: ['planned', 'orchestrated'],
      requiredFields: ['plan.generatedAt'],
      limitations: ['The orchestration plan selects routes but does not execute its suggested domain tools.'],
    }),
    evidence: taskStateEvidence('work-takeover.task.orchestrate', 'mutate'),
  });

  registerWorkTakeoverTool(registry, {
    name: 'work_takeover_task_execute_step',
    description: 'Execute one safe preparation step from a work takeover execution plan and write the result back to the task. This prepares internal artifacts, drafts, verification notes, and next instructions only; it does not send messages, publish, submit, pay, sign, or operate external software by itself.',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Optional work takeover task id. If omitted, uses the highest-priority active task.' },
        stepId: { type: 'string', description: 'Optional execution step id: understand_context, prepare_artifacts, external_tool_handoff, communication_handoff, verify_and_record.' },
        mode: { type: 'string', description: 'plan_only, prepare_work, or visible_external_work.' },
        record: { type: 'boolean', description: 'Whether to write the execution result back to the task. Defaults to true.' },
      },
      required: [],
    },
    handler: async (args, context) => {
      const { userId, task } = requireTask(args, context);

      const mode = normalizeWorkTakeoverExecutionMode(args.mode);
      const plan = planWorkTakeoverExecution(task, { mode });
      const execution = executeWorkTakeoverPlanStep(task, plan, {
        stepId: args.stepId ? String(args.stepId) : undefined,
      });
      const shouldRecord = args.record !== false;
      let updatedTask = task;

      if (shouldRecord) {
        updatedTask = recordWorkTakeoverStepExecution(userId, task, plan, execution);
        updatedTask = requirePersistedTask(userId, updatedTask);
      }

      const status = execution.status === 'blocked'
        ? 'blocked'
        : execution.status === 'waiting_confirmation'
          ? 'waiting_confirmation'
          : shouldRecord ? 'step_recorded' : 'step_prepared';

      return JSON.stringify({
        ok: status !== 'blocked',
        status,
        persisted: shouldRecord,
        task: updatedTask,
        plan,
        execution,
        note: shouldRecord
          ? 'Execution step recorded on the task. Continue with the suggested tools if the user confirms any gated action.'
          : 'Execution step generated without recording. External side effects remain confirmation-gated.',
      }, null, 2);
    },
    capability: taskStateContract({
      id: 'work-takeover.task.execute-step',
      operation: 'mutate',
      successStatuses: ['step_prepared', 'step_recorded', 'waiting_confirmation'],
      requiredFields: ['execution.step.id', 'execution.status'],
      limitations: ['This executes a local preparation step only; suggested external tools remain separate verified calls.'],
    }),
    evidence: taskStateEvidence('work-takeover.task.execute-step', 'mutate'),
  });

  registerWorkTakeoverTool(registry, {
    name: 'work_takeover_task_advance',
    description: 'Advance a persistent work takeover task by one reusable safe step. It continues the task, orchestrates a plan, selects the next unprepared step from execution history, executes that preparation step, and records the result. If all steps are prepared, it can export a local task packet instead. It does not send, publish, submit, pay, sign, or operate external apps by itself.',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Optional work takeover task id. If omitted, uses the highest-priority active task.' },
        mode: { type: 'string', description: 'plan_only, prepare_work, or visible_external_work.' },
        exportWhenComplete: { type: 'boolean', description: 'When all plan steps have been prepared, export the local task packet. Defaults to true.' },
        outputDirectory: { type: 'string', description: 'Optional folder for the packet if exportWhenComplete is true. Defaults to the Desktop.' },
        record: { type: 'boolean', description: 'Whether to write results back to the task. Defaults to true.' },
      },
      required: [],
    },
    handler: async (args, context) => {
      const { userId, task } = requireTask(args, context);

      const mode = normalizeWorkTakeoverExecutionMode(args.mode);
      const plan = planWorkTakeoverExecution(task, { mode });
      const progress = getWorkTakeoverExecutionProgress(task, plan);
      const shouldRecord = args.record !== false;

      if (progress.complete && args.exportWhenComplete !== false) {
        const packet = exportWorkTakeoverPacket(task, {
          outputDirectory: args.outputDirectory ? String(args.outputDirectory) : undefined,
          plan,
        });
        let updatedTask = task;
        if (shouldRecord) {
          updatedTask = recordWorkTakeoverPacket(userId, task, plan, packet, {
            workTakeoverExecution: {
              lastPlan: plan,
              progress,
              updatedAt: packet.createdAt,
            },
          });
          updatedTask = requirePersistedTask(userId, updatedTask);
        }
        if (!fs.existsSync(packet.folderPath)) {
          throw new Error(`Work takeover packet was not created: ${packet.folderPath}`);
        }
        return JSON.stringify({
          ok: true,
          status: 'packet_exported',
          persisted: shouldRecord,
          task: updatedTask,
          plan,
          progress,
          packet,
          action: 'exported_packet',
          note: 'All safe preparation steps were already covered, so a local task packet was exported.',
        }, null, 2);
      }

      const execution = executeWorkTakeoverPlanStep(task, plan, {
        stepId: progress.nextStep?.id,
      });
      let updatedTask = shouldRecord ? recordWorkTakeoverStepExecution(userId, task, plan, execution) : task;
      if (shouldRecord) updatedTask = requirePersistedTask(userId, updatedTask);
      const status = execution.status === 'blocked'
        ? 'blocked'
        : execution.status === 'waiting_confirmation'
          ? 'waiting_confirmation'
          : shouldRecord ? 'step_recorded' : 'step_prepared';
      return JSON.stringify({
        ok: status !== 'blocked',
        status,
        persisted: shouldRecord,
        task: updatedTask,
        plan,
        progress,
        execution,
        action: 'executed_step',
        note: shouldRecord
          ? 'Advanced one work takeover step and recorded the result.'
          : 'Advanced one work takeover step without recording.',
      }, null, 2);
    },
    capability: taskStateContract({
      id: 'work-takeover.task.advance',
      operation: 'mutate',
      successStatuses: ['step_prepared', 'step_recorded', 'waiting_confirmation', 'packet_exported'],
      requiredFields: ['action'],
      sideEffects: [
        { type: 'local_state_change', scope: 'persistent work takeover task ledger', reversible: true },
        { type: 'local_write', scope: 'optional exported work takeover packet', reversible: true },
      ],
    }),
    evidence: taskStateEvidence('work-takeover.task.advance', 'mutate'),
  });

  registerWorkTakeoverTool(registry, {
    name: 'work_takeover_task_export_packet',
    description: 'Export a persistent work takeover task into a local file packet containing task summary, execution plan, artifact checklist, communication drafts, verification/risk checklist, and structured JSON. This materializes task-center work into local files without sending, publishing, submitting, paying, signing, or controlling external apps.',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Optional work takeover task id. If omitted, uses the highest-priority active task.' },
        outputDirectory: { type: 'string', description: 'Optional folder where the packet folder should be created. Defaults to the Desktop.' },
        mode: { type: 'string', description: 'plan_only, prepare_work, or visible_external_work.' },
        record: { type: 'boolean', description: 'Whether to write the packet path back to the task. Defaults to true.' },
      },
      required: [],
    },
    handler: async (args, context) => {
      const { userId, task } = requireTask(args, context);

      const mode = normalizeWorkTakeoverExecutionMode(args.mode);
      const plan = planWorkTakeoverExecution(task, { mode });
      const packet = exportWorkTakeoverPacket(task, {
        outputDirectory: args.outputDirectory ? String(args.outputDirectory) : undefined,
        plan,
      });
      if (!fs.existsSync(packet.folderPath)) {
        throw new Error(`Work takeover packet was not created: ${packet.folderPath}`);
      }
      const shouldRecord = args.record !== false;
      let updatedTask = task;

      if (shouldRecord) {
        updatedTask = recordWorkTakeoverPacket(userId, task, plan, packet);
        updatedTask = requirePersistedTask(userId, updatedTask);
      }

      return JSON.stringify({
        ok: true,
        status: 'exported',
        persisted: shouldRecord,
        task: updatedTask,
        plan,
        packet,
        note: shouldRecord
          ? 'Task packet exported and recorded on the task. The packet is local only; external side effects remain confirmation-gated.'
          : 'Task packet exported without recording. The packet is local only; external side effects remain confirmation-gated.',
      }, null, 2);
    },
    capability: taskStateContract({
      id: 'work-takeover.task.export-packet',
      operation: 'create',
      successStatuses: ['exported'],
      requiredFields: ['packet.folderPath', 'packet.createdAt'],
      sideEffects: [
        { type: 'local_write', scope: 'work takeover task packet files', reversible: true },
        { type: 'local_state_change', scope: 'optional task packet receipt', reversible: true },
      ],
      limitations: ['The packet is a local coordination artifact and is not evidence of external delivery.'],
    }),
    evidence: capabilityEvidence({
      id: 'work-takeover.task.export-packet',
      operation: 'create',
      subjectArgument: 'outputDirectory',
      limitations: ['Exports local packet files only.'],
    }),
  });
}
