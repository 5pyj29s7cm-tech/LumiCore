import { cnWorkTakeoverMessages } from "../../regions/messages/work_takeover_messages";
import { randomUUID } from 'node:crypto';
import { readDatabaseTables, commitDatabaseTables, flushDBOrThrow } from '../../../db_layer';
import { ensureBackgroundConversationActionTask, appendConversationActionReceipts } from '../../conversation/action_ledger';
import type { ToolRegistry } from '../registry';
import { executeToolCall } from '../execution_engine';
import { capabilityEvidence } from '../capability_contracts';
import type { ToolExecutionRecord } from '../types';
import { isWorkTakeoverTaskCurrent, registerWorkTakeoverExecutor, updateWorkTakeoverTask } from '../../work_takeover/tasks';
import { planWorkTakeoverExecution, normalizeWorkTakeoverExecutionMode } from '../../work_takeover/execution_planner';
import { requireTask, uniqueStrings, toolRunHistory, requirePersistedTask, taskStateContract, registerWorkTakeoverTool } from './work_takeover_shared';

export function registerWorkTakeoverExecutionTools(registry: ToolRegistry): void {
  registerWorkTakeoverTool(registry, {
    name: 'work_takeover_task_run_suggested_tool',
    description: 'Run one explicitly selected tool from the current work takeover execution plan step, then record the result back to the task. The requested tool must already be suggested by the plan step; task-state tools are intentionally excluded to avoid recursion. The underlying tool keeps its own safety and confirmation behavior.',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Optional work takeover task id. If omitted, uses the highest-priority active task.' },
        stepId: { type: 'string', description: 'Optional execution step id. Defaults to the plan nextStep.' },
        toolName: { type: 'string', description: 'Name of the suggested tool to run, e.g. work_product_plan, create_docx, create_ppt, cad_generate_dxf, wechat_prepare_reply.' },
        toolArgs: { type: 'object', description: 'Arguments to pass to the selected tool.' },
        mode: { type: 'string', description: 'plan_only, prepare_work, or visible_external_work.' },
        record: { type: 'boolean', description: 'Whether to write the tool result back to the task. Defaults to true.' },
      },
      required: ['toolName'],
    },
    handler: async (args, context) => {
      const { userId, domain, orgId, task } = requireTask(args, context);

      const toolName = String(args.toolName || '').trim();
      if (!toolName) throw new Error('toolName is required.');
      if (toolName.startsWith('work_takeover_task_')) {
        throw new Error('Use work_takeover_task_* tools directly; the suggested-tool bridge does not run task-state tools.');
      }

      const mode = normalizeWorkTakeoverExecutionMode(args.mode);
      const plan = planWorkTakeoverExecution(task, { mode });
      const step = args.stepId
        ? plan.steps.find(item => item.id === String(args.stepId))
        : plan.nextStep || plan.steps[0];
      if (!step) throw new Error('No execution step is available for this task.');
      if (!step.suggestedTools.includes(toolName)) {
        throw new Error(`Tool "${toolName}" is not suggested for step "${step.id}". Suggested tools: ${step.suggestedTools.join(', ') || 'none'}`);
      }

      const toolArgs = args.toolArgs && typeof args.toolArgs === 'object' ? args.toolArgs : {};
      const controller = new AbortController();
      const stop = () => controller.abort(new DOMException('Work takeover execution was cancelled or changed.', 'AbortError'));
      const unregister = registerWorkTakeoverExecutor(task, stop);
      const parentSignal = context?.executionSignal;
      parentSignal?.addEventListener('abort', stop, { once: true });
      if (parentSignal?.aborted || context?.isCancelled?.()) stop();
      const startedAt = new Date().toISOString();
      const requestId = `wt_request_${randomUUID()}`;
      const turnId = String(context?.turnId || `wt_turn_${randomUUID()}`);
      let executionRecord: ToolExecutionRecord | undefined;
      let result = '';
      try {
        const ledgerDb = readDatabaseTables(["conversationActionTasks","conversationActionReceipts","conversationActionTurns","conversations","interactions"]);
        const actionTask = ensureBackgroundConversationActionTask(ledgerDb, {
          taskId: task.id, userId, domain, orgId,
          conversationId: `work_takeover:${task.id}`,
          goal: task.title || task.summary || toolName,
          target: String(toolArgs.filePath || toolArgs.path || toolArgs.target || toolArgs.url || ''),
          requestId, source: 'work_takeover_task_run_suggested_tool',
          context: { taskId: task.id, executionOwner: 'work_takeover', ownerTaskId: task.id },
        });
        // An identity archive for canonical receipts, never a second task
        // controller. Runtime/focus project the owning takeover task instead.
        actionTask.status = 'created';
        actionTask.activeRequestId = '';
        actionTask.context = JSON.stringify({ taskId: task.id, executionOwner: 'work_takeover', ownerTaskId: task.id, source: 'work_takeover_task_run_suggested_tool' });
        commitDatabaseTables(ledgerDb);
        await flushDBOrThrow();
        if (controller.signal.aborted || !isWorkTakeoverTaskCurrent(task)) throw new Error('Work takeover execution stopped before adapter admission.');
        executionRecord = await executeToolCall({
          registry,
          name: toolName,
          arguments: toolArgs,
          context: {
            ...(context || {}),
            source: 'work_takeover_task_run_suggested_tool',
            taskId: task.id,
            requestId,
            turnId,
            executionSignal: controller.signal,
            isCancelled: () => controller.signal.aborted || context?.isCancelled?.() === true || !isWorkTakeoverTaskCurrent(task),
          },
        });
        const verificationFailure = executionRecord.error || (executionRecord.terminalVerification?.status !== 'verified'
          ? executionRecord.terminalVerification?.reason || 'The nested tool did not produce verified evidence.' : '');
        const receiptDb = readDatabaseTables(["conversationActionTasks","conversationActionReceipts","conversationActionTurns","conversations","interactions"]);
        appendConversationActionReceipts(receiptDb, {
          task: actionTask, records: [executionRecord], requestId, turnId,
        });
        commitDatabaseTables(receiptDb);
        await flushDBOrThrow();
        if (verificationFailure) throw new Error(verificationFailure);
        result = executionRecord.result;
        if (controller.signal.aborted || !isWorkTakeoverTaskCurrent(task)) {
          throw new Error('Work takeover execution stopped; a late result cannot replace the current task state.');
        }
      } catch (err: any) {
        const failure = {
          id: `wt_tool_run_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
          toolName,
          toolArgs,
          stepId: step.id,
          status: 'failed',
          startedAt,
          finishedAt: new Date().toISOString(),
          error: String(err?.message || err).slice(0, 4000),
        };
        if (args.record !== false && !controller.signal.aborted && isWorkTakeoverTaskCurrent(task)) {
          updateWorkTakeoverTask(userId, task.id, {
            expectedRevision: task.revision || 0,
            status: 'blocked',
            blockedBy: uniqueStrings([...task.blockedBy, cnWorkTakeoverMessages.toolFailed(toolName, failure.error)]),
            metadata: {
              workTakeoverToolRuns: toolRunHistory(task, failure),
            },
            note: `Suggested tool failed: ${toolName}`,
          } as any);
        }
        throw err;
      } finally {
        unregister();
        parentSignal?.removeEventListener('abort', stop);
      }

      const run = {
        id: `wt_tool_run_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
        toolName,
        toolArgs,
        stepId: step.id,
        status: 'completed',
        startedAt,
        finishedAt: new Date().toISOString(),
        result: String(result || '').slice(0, 12000),
      };
      const shouldRecord = args.record !== false;
      let updatedTask = task;
      if (shouldRecord) {
        updatedTask = updateWorkTakeoverTask(userId, task.id, {
          expectedRevision: task.revision || 0,
          status: task.status === 'queued' ? 'in_progress' : task.status,
          result: cnWorkTakeoverMessages.toolExecuted(toolName, run.result),
          artifact: {
            type: 'other',
            label: cnWorkTakeoverMessages.toolResultLabel(toolName),
            content: run.result,
            status: 'prepared',
          },
          metadata: {
            workTakeoverExecution: {
              lastPlan: plan,
              updatedAt: run.finishedAt,
            },
            workTakeoverToolRuns: toolRunHistory(task, run),
          },
          note: `Suggested tool executed: ${toolName}`,
        } as any) || task;
        updatedTask = requirePersistedTask(userId, updatedTask);
      }

      return JSON.stringify({
        ok: true,
        status: 'executed',
        persisted: shouldRecord,
        verified: true,
        task: updatedTask,
        plan,
        step,
        run,
        note: shouldRecord
          ? 'Suggested tool executed and recorded on the task.'
          : 'Suggested tool executed without recording.',
      }, null, 2);
    },
    securityLevel: 'confirm',
    capability: taskStateContract({
      id: 'work-takeover.task.run-suggested-tool',
      operation: 'mutate',
      successStatuses: ['executed'],
      risk: 'high',
      requiredFields: ['verified', 'run.id', 'run.toolName', 'run.status'],
      sideEffects: [
        { type: 'local_state_change', scope: 'work takeover execution ledger', reversible: true },
        { type: 'local_write', scope: 'selected tool output when applicable', reversible: false },
        { type: 'desktop_control', scope: 'selected suggested tool when applicable', reversible: false },
        { type: 'external_state_change', scope: 'selected suggested tool when applicable', reversible: false },
        { type: 'external_communication', scope: 'selected suggested tool when applicable', reversible: false },
        { type: 'process_execution', scope: 'selected suggested tool when applicable', reversible: false },
      ],
      limitations: ['Only tools explicitly suggested by the current plan step may run, and their own manifest contract remains authoritative.'],
    }),
    evidence: capabilityEvidence({
      id: 'work-takeover.task.run-suggested-tool',
      operation: 'mutate',
      subjectArgument: 'toolName',
      limitations: ['The nested tool receipt proves its own operation; this receipt proves it was also attached to the task ledger.'],
    }),
  });
}
