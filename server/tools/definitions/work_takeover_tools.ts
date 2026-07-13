import { ToolRegistry } from '../registry';
import { analyzeWechatIntake } from '../../work_takeover/wechat_intake';
import {
  continueWorkTakeoverTask,
  createWorkTakeoverTask,
  createWorkTakeoverTaskFromWechatIntake,
  getWorkTakeoverTask,
  listWorkTakeoverTasks,
  updateWorkTakeoverTask,
  type WorkTakeoverStatus,
} from '../../work_takeover/tasks';
import { executeWorkTakeoverPlanStep, getWorkTakeoverExecutionProgress, planWorkTakeoverExecution, type WorkTakeoverExecutionMode } from '../../work_takeover/execution_planner';
import { exportWorkTakeoverPacket } from '../../work_takeover/task_packet';
import { verifyWorkTakeoverResult, type WorkTakeoverExpectedSurface } from '../../work_takeover/result_verifier';
import { getTaskIndustryParameters, parseWorkTakeoverIndustryParameters } from '../../work_takeover/industry_parameters';
import { runWorkTakeoverCapabilityReuseProbe } from '../../work_takeover/capability_reuse_probe';

function contextUser(context?: any): { userId: string; domain: string; orgId: string } {
  return {
    userId: context?.userId || 'anonymous',
    domain: context?.domain || 'personal',
    orgId: context?.orgId || '',
  };
}

function asStringArray(value: any): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (Array.isArray(value)) return value.map(item => String(item || '').trim()).filter(Boolean);
  return String(value)
    .split(/[\n;；]+/)
    .map(item => item.trim())
    .filter(Boolean);
}

function compact(value: unknown): string {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function uniqueStrings(values: Array<string | undefined>): string[] {
  return Array.from(new Set(values.map(compact).filter(Boolean)));
}

function planNextActions(plan: ReturnType<typeof planWorkTakeoverExecution>): string[] {
  return plan.steps.map(step => `${step.title}：${step.goal}`).slice(0, 12);
}

function executionHistory(task: any, execution: ReturnType<typeof executeWorkTakeoverPlanStep>): any[] {
  const current = task?.metadata?.workTakeoverExecution?.history;
  return [...(Array.isArray(current) ? current.slice(-20) : []), execution];
}

function toolRunHistory(task: any, run: any): any[] {
  const current = task?.metadata?.workTakeoverToolRuns;
  return [...(Array.isArray(current) ? current.slice(-30) : []), run];
}

function recordStepExecution(userId: string, task: any, plan: any, execution: ReturnType<typeof executeWorkTakeoverPlanStep>): any {
  let updatedTask = updateWorkTakeoverTask(userId, task.id, {
    status: execution.status === 'blocked'
      ? 'blocked'
      : execution.status === 'waiting_confirmation'
      ? 'waiting_confirmation'
      : 'in_progress',
    allowedNow: uniqueStrings([...task.allowedNow, ...plan.safeActions]),
    confirmationRequired: uniqueStrings([...task.confirmationRequired, ...execution.confirmationRequired]),
    blockedBy: execution.blockers.length ? uniqueStrings([...task.blockedBy, ...execution.blockers]) : undefined,
    result: execution.nextInstruction,
    metadata: {
      workTakeoverExecution: {
        lastPlan: plan,
        lastExecution: execution,
        history: executionHistory(task, execution),
        updatedAt: execution.executedAt,
      },
    },
    note: execution.summary,
  } as any) || task;

  for (const artifact of execution.artifacts) {
    updatedTask = updateWorkTakeoverTask(userId, task.id, {
      artifact,
    } as any) || updatedTask;
  }

  if (execution.draftReply && !task.drafts.some((draft: any) => draft.text === execution.draftReply)) {
    updatedTask = updateWorkTakeoverTask(userId, task.id, {
      draftReply: execution.draftReply,
    } as any) || updatedTask;
  }

  return updatedTask;
}

function recordPacket(userId: string, task: any, plan: any, packet: ReturnType<typeof exportWorkTakeoverPacket>, extraMetadata: Record<string, any> = {}): any {
  const existingExecution = task?.metadata?.workTakeoverExecution && typeof task.metadata.workTakeoverExecution === 'object'
    ? task.metadata.workTakeoverExecution
    : {};
  const extraExecution = extraMetadata.workTakeoverExecution && typeof extraMetadata.workTakeoverExecution === 'object'
    ? extraMetadata.workTakeoverExecution
    : {};
  const { workTakeoverExecution: _unused, ...restExtraMetadata } = extraMetadata;
  return updateWorkTakeoverTask(userId, task.id, {
    status: task.status === 'queued' ? 'in_progress' : task.status,
    artifact: {
      type: 'file',
      label: '工作接管任务包',
      path: packet.folderPath,
      content: packet.summary,
      status: 'prepared',
    },
    metadata: {
      ...restExtraMetadata,
      workTakeoverExecution: {
        ...existingExecution,
        lastPlan: plan,
        updatedAt: packet.createdAt,
        ...extraExecution,
      },
      workTakeoverPacket: packet,
    },
    note: packet.summary,
  } as any) || task;
}

export function registerWorkTakeoverTools(registry: ToolRegistry): void {
  registry.register({
    name: 'work_takeover_task_create',
    description: 'Create a persistent work takeover task that Lumi can continue later. Use for customer, store, account, case-filing, video-publishing, design/CAD/Revit delivery, or other current-stage work takeover.',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Short task title.' },
        category: { type: 'string', description: 'customer, store, account, legal_case, video_publish, design_delivery, general_work, personal, unknown.' },
        source: { type: 'string', description: 'wechat, clipboard, manual, voice, chat, etc.' },
        sourceMessage: { type: 'string', description: 'Original message or user request that created the task.' },
        contact: { type: 'string', description: 'Sender/customer/contact name.' },
        summary: { type: 'string', description: 'Task summary.' },
        urgency: { type: 'string', description: 'low, normal, high, urgent.' },
        priority: { type: 'number', description: 'Numeric priority, 0-100.' },
        recommendedWorkflow: { type: 'string', description: 'Workflow id/name Lumi should use next.' },
        nextActions: { type: 'array', description: 'Ordered next actions.' },
        draftReply: { type: 'string', description: 'Initial message draft, if any.' },
        artifactsToPrepare: { type: 'array', description: 'Materials/files/results Lumi should prepare.' },
        allowedNow: { type: 'array', description: 'Actions Lumi can do now.' },
        confirmationRequired: { type: 'array', description: 'Actions that require confirmation.' },
        blockedBy: { type: 'array', description: 'Current blockers.' },
        risks: { type: 'array', description: 'Known risks.' },
      },
      required: ['category'],
    },
    handler: async (args, context) => {
      const { userId, domain, orgId } = contextUser(context);
      const category = args.category || 'general_work';
      const sourceMessage = compact(args.sourceMessage || args.summary || args.title || '');
      const parsedParameters = sourceMessage
        ? parseWorkTakeoverIndustryParameters(sourceMessage, category as any)
        : undefined;
      const task = createWorkTakeoverTask({
        userId,
        domain,
        orgId,
        title: args.title,
        category,
        source: args.source || context?.source || 'manual',
        sourceMessage: args.sourceMessage,
        contact: args.contact,
        summary: args.summary,
        urgency: args.urgency || 'normal',
        priority: args.priority,
        recommendedWorkflow: args.recommendedWorkflow,
        nextActions: asStringArray(args.nextActions),
        draftReply: args.draftReply,
        artifactsToPrepare: asStringArray(args.artifactsToPrepare),
        allowedNow: asStringArray(args.allowedNow),
        confirmationRequired: asStringArray(args.confirmationRequired),
        blockedBy: asStringArray(args.blockedBy),
        risks: asStringArray(args.risks),
        metadata: parsedParameters ? { industryParameters: parsedParameters } : undefined,
      } as any);
      return JSON.stringify({ task, note: 'Work takeover task created and can be continued later.' }, null, 2);
    },
    permission: 'user',
    securityLevel: 'safe',
  });

  registry.register({
    name: 'work_takeover_task_from_wechat',
    description: 'Analyze a WeChat/message intake and create a persistent work takeover task from it. This is the bridge from WeChat information to Lumi work takeover. It never sends messages.',
    parameters: {
      type: 'object',
      properties: {
        message: { type: 'string', description: 'The WeChat/message content.' },
        contact: { type: 'string', description: 'Sender/contact/group name.' },
        source: { type: 'string', description: 'manual, clipboard, selected_text, wechat.' },
        takeoverMode: { type: 'string', description: 'Optional forced category or auto.' },
        userRules: { type: 'string', description: 'User rules/boundaries to apply.' },
        title: { type: 'string', description: 'Optional task title.' },
      },
      required: ['message'],
    },
    handler: async (args, context) => {
      const { userId, domain, orgId } = contextUser(context);
      const message = String(args.message || '').trim();
      if (!message) throw new Error('message is required.');
      const intake = analyzeWechatIntake({
        message,
        contact: args.contact ? String(args.contact) : undefined,
        source: args.source ? String(args.source) : 'wechat',
        takeoverMode: args.takeoverMode ? String(args.takeoverMode) as any : 'auto',
        userRules: args.userRules ? String(args.userRules) : undefined,
      });
      const task = createWorkTakeoverTaskFromWechatIntake(userId, intake, {
        domain,
        orgId,
        sourceMessage: message,
        title: args.title ? String(args.title) : undefined,
      });
      return JSON.stringify({
        intake,
        task,
        note: 'WeChat/message intake has been promoted into a persistent work takeover task. Drafts are prepared only; sending remains confirmation-gated.',
      }, null, 2);
    },
    permission: 'user',
    securityLevel: 'safe',
  });

  registry.register({
    name: 'work_takeover_task_from_clipboard',
    description: 'Read the clipboard as a copied WeChat/message intake, analyze it, and create a persistent work takeover task. Use when the user says they copied a WeChat message or asks Lumi to take over this message. This never sends messages.',
    parameters: {
      type: 'object',
      properties: {
        contact: { type: 'string', description: 'Sender/contact/group name.' },
        takeoverMode: { type: 'string', description: 'Optional forced category or auto.' },
        userRules: { type: 'string', description: 'User rules/boundaries to apply.' },
        title: { type: 'string', description: 'Optional task title.' },
      },
      required: [],
    },
    handler: async (args, context) => {
      if (!context?.desktopRelay) {
        throw new Error('Clipboard-based takeover requires the Lumi desktop client relay.');
      }
      const { userId, domain, orgId } = contextUser(context);
      const message = String(await context.desktopRelay('desktop_clipboard_read', {}) || '').trim();
      if (!message) throw new Error('Clipboard is empty. Copy the WeChat/message text first.');
      const intake = analyzeWechatIntake({
        message,
        contact: args.contact ? String(args.contact) : undefined,
        source: 'clipboard',
        takeoverMode: args.takeoverMode ? String(args.takeoverMode) as any : 'auto',
        userRules: args.userRules ? String(args.userRules) : undefined,
      });
      const task = createWorkTakeoverTaskFromWechatIntake(userId, intake, {
        domain,
        orgId,
        sourceMessage: message,
        title: args.title ? String(args.title) : undefined,
      });
      return JSON.stringify({
        intake,
        task,
        note: 'Clipboard message has been promoted into a persistent work takeover task. Drafts are prepared only; sending remains confirmation-gated.',
      }, null, 2);
    },
    permission: 'user',
    securityLevel: 'safe',
  });

  registry.register({
    name: 'work_takeover_task_list',
    description: 'List persistent work takeover tasks. Use when the user says continue the previous task, show takeover tasks, or asks what Lumi is managing.',
    parameters: {
      type: 'object',
      properties: {
        status: { type: 'string', description: 'queued, in_progress, waiting_confirmation, delivered, blocked, cancelled, or active.' },
        category: { type: 'string', description: 'Optional category filter.' },
        limit: { type: 'number', description: 'Maximum tasks to return.' },
      },
      required: [],
    },
    handler: async (args, context) => {
      const { userId, domain, orgId } = contextUser(context);
      const tasks = listWorkTakeoverTasks({
        userId,
        domain,
        orgId,
        status: args.status as any,
        category: args.category as any,
        limit: args.limit || 20,
      });
      return JSON.stringify({ tasks, count: tasks.length }, null, 2);
    },
    permission: 'user',
    securityLevel: 'safe',
  });

  registry.register({
    name: 'work_takeover_task_get',
    description: 'Get one persistent work takeover task by id, including drafts, artifacts, actions, blockers, and confirmation boundaries.',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Work takeover task id.' },
      },
      required: ['id'],
    },
    handler: async (args, context) => {
      const task = getWorkTakeoverTask(context?.userId || 'anonymous', String(args.id || ''));
      if (!task) throw new Error(`Work takeover task not found: ${args.id}`);
      return JSON.stringify({ task }, null, 2);
    },
    permission: 'user',
    securityLevel: 'safe',
  });

  registry.register({
    name: 'work_takeover_task_update',
    description: 'Update a persistent work takeover task: status, next actions, draft, artifact, blockers, risks, result, or notes. This changes Lumi internal task state only and does not perform external side effects.',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Work takeover task id.' },
        status: { type: 'string', description: 'queued, in_progress, waiting_confirmation, delivered, blocked, cancelled.' },
        title: { type: 'string' },
        summary: { type: 'string' },
        urgency: { type: 'string' },
        priority: { type: 'number' },
        nextActions: { type: 'array' },
        appendNextAction: { type: 'string' },
        currentActionIndex: { type: 'number' },
        draftReply: { type: 'string' },
        artifact: { type: 'object', description: 'Artifact to append: {type,label,path,content,status}.' },
        allowedNow: { type: 'array' },
        confirmationRequired: { type: 'array' },
        blockedBy: { type: 'array' },
        risks: { type: 'array' },
        result: { type: 'string' },
        note: { type: 'string' },
      },
      required: ['id'],
    },
    handler: async (args, context) => {
      const task = updateWorkTakeoverTask(context?.userId || 'anonymous', String(args.id || ''), {
        status: args.status as WorkTakeoverStatus | undefined,
        title: args.title,
        summary: args.summary,
        urgency: args.urgency,
        priority: args.priority,
        nextActions: asStringArray(args.nextActions),
        appendNextAction: args.appendNextAction,
        currentActionIndex: args.currentActionIndex,
        draftReply: args.draftReply,
        artifact: args.artifact,
        allowedNow: asStringArray(args.allowedNow),
        confirmationRequired: asStringArray(args.confirmationRequired),
        blockedBy: asStringArray(args.blockedBy),
        risks: asStringArray(args.risks),
        result: args.result,
        note: args.note,
      } as any);
      if (!task) throw new Error(`Work takeover task not found: ${args.id}`);
      return JSON.stringify({ task, note: 'Work takeover task updated.' }, null, 2);
    },
    permission: 'user',
    securityLevel: 'safe',
  });

  registry.register({
    name: 'work_takeover_task_continue',
    description: 'Continue a persistent work takeover task. If no id is provided, continue the highest-priority active task for the user. This returns the current action, draft, and confirmation boundaries; it does not execute external side effects.',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Optional work takeover task id.' },
      },
      required: [],
    },
    handler: async (args, context) => {
      const result = continueWorkTakeoverTask(context?.userId || 'anonymous', args.id ? String(args.id) : undefined);
      if (!result) throw new Error('No active work takeover task found.');
      return JSON.stringify(result, null, 2);
    },
    permission: 'user',
    securityLevel: 'safe',
  });

  registry.register({
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
      const { userId, domain, orgId } = contextUser(context);
      const task = args.id
        ? getWorkTakeoverTask(userId, String(args.id))
        : listWorkTakeoverTasks({ userId, domain, orgId, status: 'active', limit: 1 })[0] || null;
      if (!task) throw new Error(args.id ? `Work takeover task not found: ${args.id}` : 'No active work takeover task found.');

      const mode = ['plan_only', 'prepare_work', 'visible_external_work'].includes(String(args.mode || ''))
        ? String(args.mode) as WorkTakeoverExecutionMode
        : 'prepare_work';
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

      return JSON.stringify({
        task: updatedTask,
        plan,
        nextStep: plan.nextStep,
        note: shouldRecord
          ? 'Execution plan recorded on the task. Use the nextStep and suggestedTools to continue; external side effects remain confirmation-gated.'
          : 'Execution plan generated without recording. External side effects remain confirmation-gated.',
      }, null, 2);
    },
    permission: 'user',
    securityLevel: 'safe',
  });

  registry.register({
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
      const { userId, domain, orgId } = contextUser(context);
      const task = args.id
        ? getWorkTakeoverTask(userId, String(args.id))
        : listWorkTakeoverTasks({ userId, domain, orgId, status: 'active', limit: 1 })[0] || null;
      if (!task) throw new Error(args.id ? `Work takeover task not found: ${args.id}` : 'No active work takeover task found.');

      const mode = ['plan_only', 'prepare_work', 'visible_external_work'].includes(String(args.mode || ''))
        ? String(args.mode) as WorkTakeoverExecutionMode
        : 'prepare_work';
      const plan = planWorkTakeoverExecution(task, { mode });
      const execution = executeWorkTakeoverPlanStep(task, plan, {
        stepId: args.stepId ? String(args.stepId) : undefined,
      });
      const shouldRecord = args.record !== false;
      let updatedTask = task;

      if (shouldRecord) {
        updatedTask = recordStepExecution(userId, task, plan, execution);
      }

      return JSON.stringify({
        task: updatedTask,
        plan,
        execution,
        note: shouldRecord
          ? 'Execution step recorded on the task. Continue with the suggested tools if the user confirms any gated action.'
          : 'Execution step generated without recording. External side effects remain confirmation-gated.',
      }, null, 2);
    },
    permission: 'user',
    securityLevel: 'safe',
  });

  registry.register({
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
      const { userId, domain, orgId } = contextUser(context);
      const task = args.id
        ? getWorkTakeoverTask(userId, String(args.id))
        : listWorkTakeoverTasks({ userId, domain, orgId, status: 'active', limit: 1 })[0] || null;
      if (!task) throw new Error(args.id ? `Work takeover task not found: ${args.id}` : 'No active work takeover task found.');

      const mode = ['plan_only', 'prepare_work', 'visible_external_work'].includes(String(args.mode || ''))
        ? String(args.mode) as WorkTakeoverExecutionMode
        : 'prepare_work';
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
          updatedTask = recordPacket(userId, task, plan, packet, {
            workTakeoverExecution: {
              lastPlan: plan,
              progress,
              updatedAt: packet.createdAt,
            },
          });
        }
        return JSON.stringify({
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
      const updatedTask = shouldRecord ? recordStepExecution(userId, task, plan, execution) : task;
      return JSON.stringify({
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
    permission: 'user',
    securityLevel: 'safe',
  });

  registry.register({
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
      const { userId, domain, orgId } = contextUser(context);
      const task = args.id
        ? getWorkTakeoverTask(userId, String(args.id))
        : listWorkTakeoverTasks({ userId, domain, orgId, status: 'active', limit: 1 })[0] || null;
      if (!task) throw new Error(args.id ? `Work takeover task not found: ${args.id}` : 'No active work takeover task found.');

      const mode = ['plan_only', 'prepare_work', 'visible_external_work'].includes(String(args.mode || ''))
        ? String(args.mode) as WorkTakeoverExecutionMode
        : 'prepare_work';
      const plan = planWorkTakeoverExecution(task, { mode });
      const packet = exportWorkTakeoverPacket(task, {
        outputDirectory: args.outputDirectory ? String(args.outputDirectory) : undefined,
        plan,
      });
      const shouldRecord = args.record !== false;
      let updatedTask = task;

      if (shouldRecord) {
        updatedTask = recordPacket(userId, task, plan, packet);
      }

      return JSON.stringify({
        task: updatedTask,
        plan,
        packet,
        note: shouldRecord
          ? 'Task packet exported and recorded on the task. The packet is local only; external side effects remain confirmation-gated.'
          : 'Task packet exported without recording. The packet is local only; external side effects remain confirmation-gated.',
      }, null, 2);
    },
    permission: 'user',
    securityLevel: 'safe',
  });

  registry.register({
    name: 'work_takeover_task_verify_result',
    description: 'Verify a work takeover task after visible work or tool execution. It checks task context, confirmation boundaries, drafts, file paths, artifact content quality, and current desktop/window/process/screenshot state, then writes a verification record back to the task center. Use this before claiming a real workflow is complete.',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Optional work takeover task id. If omitted, uses the highest-priority active task.' },
        expectedSurfaces: {
          type: 'array',
          items: { type: 'string' },
          description: 'Expected visible surfaces, e.g. wechat, browser, office, spreadsheet, cad, bim, video_editor, store_platform, creator_platform, file_explorer, lumi.',
        },
        filePaths: {
          type: 'array',
          items: { type: 'string' },
          description: 'Additional exact local file/folder paths that should exist.',
        },
        draftRequired: { type: 'boolean', description: 'Whether a communication draft must be present.' },
        requireActiveWindow: { type: 'boolean', description: 'Whether reading any active window is required even when no expectedSurfaces are provided.' },
        requireScreenEvidence: { type: 'boolean', description: 'Whether a fresh screenshot must be captured and readable. Defaults to true.' },
        requiredArtifactLabels: {
          type: 'array',
          items: { type: 'string' },
          description: 'Artifact labels that must be recorded on the task, such as PPT, CAD DXF, WeChat draft, publish checklist.',
        },
        expectedContentTerms: {
          type: 'array',
          items: { type: 'string' },
          description: 'Domain words that should appear in generated artifacts/result/drafts, e.g. product name, customer need, style, budget, platform, case facts.',
        },
        minMatchedContentTerms: { type: 'number', description: 'Minimum expectedContentTerms/category terms that must be found. Defaults to 2 when terms exist.' },
        minFileBytes: { type: 'number', description: 'Minimum bytes for local artifact files to avoid accepting empty shells. Defaults to 16.' },
        requireExternalOutcome: { type: 'boolean', description: 'Require recorded evidence of the requested customer/platform/CAD/BIM/publishing action. Defaults to true for customer, store, account, video_publish, and design_delivery tasks unless the source request explicitly asks for drafts/preparation only.' },
        record: { type: 'boolean', description: 'Whether to write verification back to the task. Defaults to true.' },
      },
      required: [],
    },
    handler: async (args, context) => {
      const { userId, domain, orgId } = contextUser(context);
      const task = args.id
        ? getWorkTakeoverTask(userId, String(args.id))
        : listWorkTakeoverTasks({ userId, domain, orgId, status: 'active', limit: 1 })[0] || null;
      if (!task) throw new Error(args.id ? `Work takeover task not found: ${args.id}` : 'No active work takeover task found.');

      let activeWindowRaw = '';
      let runningProcessesRaw = '';
      let screenRaw = '';
      if (context?.desktopRelay) {
        try {
          activeWindowRaw = await context.desktopRelay('desktop_active_window', {});
        } catch {}
        try {
          runningProcessesRaw = await context.desktopRelay('desktop_running_processes', { top: 80 });
        } catch {}
        try {
          screenRaw = await context.desktopRelay('desktop_capture_screen', { quality: 35 });
        } catch {}
      }

      const params = getTaskIndustryParameters(task);
      const expectedSurfaces = (asStringArray(args.expectedSurfaces) || params?.expectedSurfaces || [])
        .map(surface => surface as WorkTakeoverExpectedSurface)
        .filter(Boolean);
      const filePaths = asStringArray(args.filePaths) || [];
      const requiredArtifactLabels = asStringArray(args.requiredArtifactLabels) || params?.requiredArtifactLabels || [];
      const expectedContentTerms = asStringArray(args.expectedContentTerms) || params?.expectedContentTerms || [];
      const taskIntentText = `${task.title} ${task.summary} ${task.sourceMessage}`;
      const preparationOnly = /(?:\u8349\u7a3f|\u51c6\u5907|\u9884\u6848|\u4e0d\u53d1\u9001|\u4e0d\u53d1\u5e03|\u6682\u4e0d\u64cd\u4f5c|draft|preparation|do\s+not\s+(?:send|publish|operate))/iu.test(taskIntentText);
      const externalCategory = ['customer', 'store', 'account', 'video_publish', 'design_delivery'].includes(task.category);
      const requireExternalOutcome = typeof args.requireExternalOutcome === 'boolean'
        ? args.requireExternalOutcome
        : externalCategory && !preparationOnly;
      const verification = verifyWorkTakeoverResult(task, {
        activeWindowRaw,
        runningProcessesRaw,
        screenRaw,
        expectedSurfaces,
        filePaths,
        draftRequired: args.draftRequired === true,
        requireActiveWindow: args.requireActiveWindow === true,
        requireScreenEvidence: args.requireScreenEvidence !== false,
        requiredArtifactLabels,
        expectedContentTerms,
        minMatchedContentTerms: args.minMatchedContentTerms,
        minFileBytes: args.minFileBytes,
        requireExternalOutcome,
      });

      let updatedTask = task;
      if (args.record !== false) {
        const status: WorkTakeoverStatus = verification.status === 'blocked'
          ? 'blocked'
          : verification.status === 'needs_review'
          ? 'waiting_confirmation'
          : task.status === 'queued'
          ? 'in_progress'
          : task.status;
        updatedTask = updateWorkTakeoverTask(userId, task.id, {
          status,
          result: verification.summary,
          blockedBy: verification.status === 'blocked'
            ? uniqueStrings([...task.blockedBy, ...verification.blockers])
            : undefined,
          artifact: {
            type: 'checklist',
            label: '任务结果验证记录',
            content: [
              verification.summary,
              '',
              ...verification.checks.map(item => `- ${item.passed ? '通过' : '待复核'}｜${item.label}：${item.detail}`),
              verification.activeWindow
                ? `\n活动窗口：${verification.activeWindow.processName} ${verification.activeWindow.title}`
                : '\n活动窗口：未读取',
              verification.screen?.captured
                ? `屏幕截图：${verification.screen.width || '?'}x${verification.screen.height || '?'} ${verification.screen.format || ''}`.trim()
                : '屏幕截图：未读取',
              verification.detectedSurfaces.length
                ? `检测到的外部表面：${verification.detectedSurfaces.join('、')}`
                : '检测到的外部表面：暂无',
            ].join('\n'),
            status: verification.passed ? 'prepared' : 'needs_review',
          },
          metadata: {
            workTakeoverVerification: verification,
          },
          note: verification.summary,
        } as any) || task;
      }

      return JSON.stringify({
        task: updatedTask,
        verification,
        note: args.record === false
          ? 'Verification generated without recording.'
          : 'Verification recorded on the work takeover task.',
      }, null, 2);
    },
    permission: 'user',
    securityLevel: 'safe',
  });

  registry.register({
    name: 'work_takeover_task_autorun',
    description: 'Run a bounded local coordination loop for work takeover. It can create or continue a task, orchestrate safe planning steps, stop on blockers or confirmation boundaries, export a task packet, and record progress. Concrete customer, ecommerce, design, CAD, BIM, publishing, and messaging outcomes must be executed separately through their real domain tools and verified.',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Optional existing work takeover task id. If omitted, message/clipboard/active task is used.' },
        message: { type: 'string', description: 'Optional WeChat/customer message text to create a new task before autorun.' },
        fromClipboard: { type: 'boolean', description: 'Read message text from desktop clipboard when message is omitted. Requires desktop client relay.' },
        contact: { type: 'string', description: 'Optional contact/customer name.' },
        source: { type: 'string', description: 'manual, clipboard, selected_text, wechat, voice, chat.' },
        takeoverMode: { type: 'string', description: 'Optional forced task category or auto.' },
        userRules: { type: 'string', description: 'Optional user rules/boundaries to apply.' },
        title: { type: 'string', description: 'Optional task title if creating from message.' },
        maxSteps: { type: 'number', description: 'Maximum safe preparation steps to advance. Defaults to 3, max 6.' },
        mode: { type: 'string', description: 'plan_only, prepare_work, or visible_external_work.' },
        stopOnConfirmation: { type: 'boolean', description: 'Stop after a step that reaches confirmation boundary. Defaults to true.' },
        exportPacket: { type: 'boolean', description: 'Export a local task packet at the end. Defaults to true.' },
        outputDirectory: { type: 'string', description: 'Optional folder for exported packet. Defaults to the Desktop.' },
        record: { type: 'boolean', description: 'Whether to write autorun results back to the task. Defaults to true.' },
      },
      required: [],
    },
    handler: async (args, context) => {
      const { userId, domain, orgId } = contextUser(context);
      const mode = ['plan_only', 'prepare_work', 'visible_external_work'].includes(String(args.mode || ''))
        ? String(args.mode) as WorkTakeoverExecutionMode
        : 'prepare_work';
      const shouldRecord = args.record !== false;
      const stopOnConfirmation = args.stopOnConfirmation !== false;
      const maxSteps = Math.max(1, Math.min(Number(args.maxSteps) || 3, 6));

      let task = args.id
        ? getWorkTakeoverTask(userId, String(args.id))
        : null;
      let intake: ReturnType<typeof analyzeWechatIntake> | undefined;
      let createdTask = false;
      let message = compact(args.message);

      if (!task && args.fromClipboard === true) {
        if (!context?.desktopRelay) throw new Error('Clipboard autorun requires the Lumi desktop client relay.');
        message = compact(await context.desktopRelay('desktop_clipboard_read', {}) || '');
        if (!message) throw new Error('Clipboard is empty. Copy the WeChat/customer message first.');
      }

      if (!task && message) {
        intake = analyzeWechatIntake({
          message,
          contact: args.contact ? String(args.contact) : undefined,
          source: args.source ? String(args.source) : (args.fromClipboard ? 'clipboard' : 'manual'),
          takeoverMode: args.takeoverMode ? String(args.takeoverMode) as any : 'auto',
          userRules: args.userRules ? String(args.userRules) : undefined,
        });
        task = createWorkTakeoverTaskFromWechatIntake(userId, intake, {
          domain,
          orgId,
          sourceMessage: message,
          title: args.title ? String(args.title) : undefined,
        });
        createdTask = true;
      }

      if (!task) {
        task = listWorkTakeoverTasks({ userId, domain, orgId, status: 'active', limit: 1 })[0] || null;
      }
      if (!task) throw new Error('No work takeover task found. Provide id, message, fromClipboard, or create a task first.');

      const executions: any[] = [];
      const stopReasons: string[] = [];
      let currentTask: any = task;
      let plan = planWorkTakeoverExecution(currentTask, { mode });
      let progress = getWorkTakeoverExecutionProgress(currentTask, plan);

      for (let i = 0; i < maxSteps; i++) {
        plan = planWorkTakeoverExecution(currentTask, { mode });
        progress = getWorkTakeoverExecutionProgress(currentTask, plan);
        if (progress.complete) {
          stopReasons.push('safe_steps_complete');
          break;
        }

        const execution = executeWorkTakeoverPlanStep(currentTask, plan, {
          stepId: progress.nextStep?.id,
        });
        executions.push(execution);

        if (shouldRecord) {
          currentTask = recordStepExecution(userId, currentTask, plan, execution);
        }

        if (execution.status === 'blocked') {
          stopReasons.push('blocked');
          break;
        }
        if (stopOnConfirmation && execution.status === 'waiting_confirmation') {
          stopReasons.push('waiting_confirmation');
          break;
        }
      }

      plan = planWorkTakeoverExecution(currentTask, { mode });
      progress = getWorkTakeoverExecutionProgress(currentTask, plan);
      let packet: ReturnType<typeof exportWorkTakeoverPacket> | undefined;
      if (args.exportPacket !== false) {
        packet = exportWorkTakeoverPacket(currentTask, {
          outputDirectory: args.outputDirectory ? String(args.outputDirectory) : undefined,
          plan,
        });
        if (shouldRecord) {
          currentTask = recordPacket(userId, currentTask, plan, packet, {
            workTakeoverAutorun: {
              createdTask,
              intake,
              executions,
              progress,
              stopReasons,
              maxSteps,
              updatedAt: packet.createdAt,
            },
          });
        }
      } else if (shouldRecord) {
        currentTask = updateWorkTakeoverTask(userId, currentTask.id, {
          metadata: {
            workTakeoverAutorun: {
              createdTask,
              intake,
              executions,
              progress,
              stopReasons,
              maxSteps,
              updatedAt: new Date().toISOString(),
            },
          },
          note: `Autorun completed ${executions.length} safe step(s).`,
        } as any) || currentTask;
      }

      const report = {
        createdTask,
        taskId: currentTask.id,
        title: currentTask.title,
        category: currentTask.category,
        status: currentTask.status,
        executedSteps: executions.map(item => ({
          stepId: item.step.id,
          title: item.step.title,
          status: item.status,
          summary: item.summary,
        })),
        stopReasons: stopReasons.length ? stopReasons : ['max_steps_reached'],
        remainingStepIds: progress.remainingStepIds,
        confirmationRequired: currentTask.confirmationRequired || [],
        blockers: currentTask.blockedBy || [],
        packetPath: packet?.folderPath,
      };

      return JSON.stringify({
        intake,
        task: currentTask,
        plan,
        progress,
        executions,
        packet,
        report,
        note: 'Autorun finished the bounded safe loop. Review report.stopReasons, confirmationRequired, blockers, and packetPath for the next decision.',
      }, null, 2);
    },
    permission: 'user',
    securityLevel: 'safe',
  });

  registry.register({
    name: 'work_takeover_capability_reuse_probe',
    description: 'Run a safe capability-reuse pressure test for a work takeover task. It creates or continues a task, builds the normal execution plan, audits every selected capability with self_extension_plan, optionally advances safe local coordination steps, exports a task packet, verifies that coordination output, and writes a concise diagnostic back to the task center. It never substitutes generated demo packages for domain execution.',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Optional existing work takeover task id. If omitted, message/clipboard/active task is used.' },
        message: { type: 'string', description: 'Optional customer/WeChat message text to create a new task before the probe.' },
        fromClipboard: { type: 'boolean', description: 'Read message text from desktop clipboard when message is omitted. Requires desktop client relay.' },
        contact: { type: 'string', description: 'Optional contact/customer name.' },
        source: { type: 'string', description: 'manual, clipboard, selected_text, wechat, voice, chat.' },
        takeoverMode: { type: 'string', description: 'Optional forced task category or auto.' },
        userRules: { type: 'string', description: 'Optional user rules/boundaries to apply.' },
        title: { type: 'string', description: 'Optional task title if creating from message.' },
        maxSteps: { type: 'number', description: 'Maximum safe preparation steps to advance. Defaults to 2, max 5.' },
        mode: { type: 'string', description: 'plan_only, prepare_work, or visible_external_work. Defaults to prepare_work.' },
        runSafeLoop: { type: 'boolean', description: 'Advance bounded safe local steps. Defaults true.' },
        stopOnConfirmation: { type: 'boolean', description: 'Stop after a step reaches a confirmation boundary. Defaults true.' },
        exportPacket: { type: 'boolean', description: 'Export a local task packet at the end. Defaults true.' },
        outputDirectory: { type: 'string', description: 'Optional folder for exported package/packet. Defaults to the Desktop.' },
        record: { type: 'boolean', description: 'Whether to write the probe result back to the task. Defaults true.' },
      },
      required: [],
    },
    handler: async (args, context) => {
      const { userId, domain, orgId } = contextUser(context);
      const result = await runWorkTakeoverCapabilityReuseProbe({
        userId,
        domain,
        orgId,
        id: args.id ? String(args.id) : undefined,
        message: args.message ? String(args.message) : undefined,
        fromClipboard: args.fromClipboard === true,
        contact: args.contact ? String(args.contact) : undefined,
        source: args.source ? String(args.source) : undefined,
        takeoverMode: args.takeoverMode ? String(args.takeoverMode) : undefined,
        userRules: args.userRules ? String(args.userRules) : undefined,
        title: args.title ? String(args.title) : undefined,
        maxSteps: args.maxSteps,
        mode: args.mode ? String(args.mode) as WorkTakeoverExecutionMode : undefined,
        runSafeLoop: args.runSafeLoop !== false,
        stopOnConfirmation: args.stopOnConfirmation !== false,
        exportPacket: args.exportPacket !== false,
        outputDirectory: args.outputDirectory ? String(args.outputDirectory) : undefined,
        record: args.record !== false,
        tools: registry.list(),
        desktopRelay: context?.desktopRelay,
      });
      return JSON.stringify(result, null, 2);
    },
    permission: 'user',
    securityLevel: 'safe',
  });

  registry.register({
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
      const { userId, domain, orgId } = contextUser(context);
      const task = args.id
        ? getWorkTakeoverTask(userId, String(args.id))
        : listWorkTakeoverTasks({ userId, domain, orgId, status: 'active', limit: 1 })[0] || null;
      if (!task) throw new Error(args.id ? `Work takeover task not found: ${args.id}` : 'No active work takeover task found.');

      const toolName = String(args.toolName || '').trim();
      if (!toolName) throw new Error('toolName is required.');
      if (toolName.startsWith('work_takeover_task_')) {
        throw new Error('Use work_takeover_task_* tools directly; the suggested-tool bridge does not run task-state tools.');
      }

      const mode = ['plan_only', 'prepare_work', 'visible_external_work'].includes(String(args.mode || ''))
        ? String(args.mode) as WorkTakeoverExecutionMode
        : 'prepare_work';
      const plan = planWorkTakeoverExecution(task, { mode });
      const step = args.stepId
        ? plan.steps.find(item => item.id === String(args.stepId))
        : plan.nextStep || plan.steps[0];
      if (!step) throw new Error('No execution step is available for this task.');
      if (!step.suggestedTools.includes(toolName)) {
        throw new Error(`Tool "${toolName}" is not suggested for step "${step.id}". Suggested tools: ${step.suggestedTools.join(', ') || 'none'}`);
      }

      const toolArgs = args.toolArgs && typeof args.toolArgs === 'object' ? args.toolArgs : {};
      const startedAt = new Date().toISOString();
      let result = '';
      try {
        result = await registry.execute(toolName, toolArgs, {
          ...(context || {}),
          source: 'work_takeover_task_run_suggested_tool',
        });
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
        if (args.record !== false) {
          updateWorkTakeoverTask(userId, task.id, {
            status: 'blocked',
            blockedBy: uniqueStrings([...task.blockedBy, `工具 ${toolName} 执行失败：${failure.error}`]),
            metadata: {
              workTakeoverToolRuns: toolRunHistory(task, failure),
            },
            note: `Suggested tool failed: ${toolName}`,
          } as any);
        }
        throw err;
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
          status: task.status === 'queued' ? 'in_progress' : task.status,
          result: `工具 ${toolName} 已执行。\n${run.result}`,
          artifact: {
            type: 'other',
            label: `工具执行结果：${toolName}`,
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
      }

      return JSON.stringify({
        task: updatedTask,
        plan,
        step,
        run,
        note: shouldRecord
          ? 'Suggested tool executed and recorded on the task.'
          : 'Suggested tool executed without recording.',
      }, null, 2);
    },
    permission: 'user',
    securityLevel: 'confirm',
  });
}
