import { createWorkTakeoverTaskFromMessage } from '../../work_takeover/intake';
import type { ToolRegistry } from '../registry';
import { continueWorkTakeoverTask, createWorkTakeoverTask, listWorkTakeoverTasks, updateWorkTakeoverTask, type WorkTakeoverStatus } from '../../work_takeover/tasks';
import { parseWorkTakeoverIndustryParameters } from '../../work_takeover/industry_parameters';
import { contextUser, requireTask, asStringArray, compact, requirePersistedTask, taskStateContract, taskStateEvidence, registerWorkTakeoverTool } from './work_takeover_shared';

export function registerWorkTakeoverTaskTools(registry: ToolRegistry): void {
  registerWorkTakeoverTool(registry, {
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
      const requestedTitle = compact(args.title);
      const recentReplay = sourceMessage && requestedTitle
        ? listWorkTakeoverTasks({ userId, domain, orgId, limit: 200 }).find(existing => (
            compact(existing.title) === requestedTitle
            && compact(existing.sourceMessage) === sourceMessage
            && Date.now() - Date.parse(existing.createdAt) <= 15 * 60_000
          ))
        : undefined;
      if (recentReplay) {
        return JSON.stringify({
          ok: true,
          status: 'created',
          persisted: true,
          replayed: true,
          task: requirePersistedTask(userId, recentReplay),
          note: 'Replayed the persisted task receipt without creating a duplicate.',
        }, null, 2);
      }
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
      const persistedTask = requirePersistedTask(userId, task);
      return JSON.stringify({ ok: true, status: 'created', persisted: true, task: persistedTask, note: 'Work takeover task created and can be continued later.' }, null, 2);
    },
    capability: taskStateContract({ id: 'work-takeover.task.create', operation: 'create', successStatuses: ['created'] }),
    evidence: taskStateEvidence('work-takeover.task.create', 'create', 'title'),
  });

  registerWorkTakeoverTool(registry, {
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
      const { intake, task } = createWorkTakeoverTaskFromMessage({ userId, domain, orgId }, args, message, args.source ? String(args.source) : 'wechat');
      const persistedTask = requirePersistedTask(userId, task);
      return JSON.stringify({
        ok: true,
        status: 'created',
        persisted: true,
        intake,
        task: persistedTask,
        note: 'WeChat/message intake has been promoted into a persistent work takeover task. Drafts are prepared only; sending remains confirmation-gated.',
      }, null, 2);
    },
    capability: taskStateContract({ id: 'work-takeover.task.create-from-message', operation: 'create', successStatuses: ['created'] }),
    evidence: taskStateEvidence('work-takeover.task.create-from-message', 'create', 'message'),
  });

  registerWorkTakeoverTool(registry, {
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
      const { intake, task } = createWorkTakeoverTaskFromMessage({ userId, domain, orgId }, args, message, 'clipboard');
      const persistedTask = requirePersistedTask(userId, task);
      return JSON.stringify({
        ok: true,
        status: 'created',
        persisted: true,
        intake,
        task: persistedTask,
        note: 'Clipboard message has been promoted into a persistent work takeover task. Drafts are prepared only; sending remains confirmation-gated.',
      }, null, 2);
    },
    capability: taskStateContract({
      id: 'work-takeover.task.create-from-clipboard',
      operation: 'create',
      successStatuses: ['created'],
      sideEffects: [
        { type: 'local_read', scope: 'desktop clipboard text', reversible: true },
        { type: 'local_state_change', scope: 'persistent work takeover task ledger', reversible: true },
      ],
    }),
    evidence: taskStateEvidence('work-takeover.task.create-from-clipboard', 'create'),
  });

  registerWorkTakeoverTool(registry, {
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
  });

  registerWorkTakeoverTool(registry, {
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
      const { task } = requireTask(args, context, true);
      return JSON.stringify({ task }, null, 2);
    },
  });

  registerWorkTakeoverTool(registry, {
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
      const { userId, task: target } = requireTask(args, context, true);
      const task = updateWorkTakeoverTask(userId, target.id, {
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
      const persistedTask = requirePersistedTask(userId, task);
      return JSON.stringify({ ok: true, status: 'updated', persisted: true, task: persistedTask, note: 'Work takeover task updated.' }, null, 2);
    },
    capability: taskStateContract({ id: 'work-takeover.task.update', operation: 'mutate', successStatuses: ['updated'] }),
    evidence: taskStateEvidence('work-takeover.task.update', 'mutate'),
  });

  registerWorkTakeoverTool(registry, {
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
      const { userId, task: target } = requireTask(args, context);
      const result = continueWorkTakeoverTask(userId, target.id);
      if (!result) throw new Error('No active work takeover task found.');
      const task = requirePersistedTask(userId, result.task);
      return JSON.stringify({ ok: true, status: 'continued', persisted: true, ...result, task }, null, 2);
    },
    capability: taskStateContract({ id: 'work-takeover.task.continue', operation: 'mutate', successStatuses: ['continued'] }),
    evidence: taskStateEvidence('work-takeover.task.continue', 'mutate'),
  });
}
