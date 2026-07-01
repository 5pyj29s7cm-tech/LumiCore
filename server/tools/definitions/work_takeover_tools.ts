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
      const task = createWorkTakeoverTask({
        userId,
        domain,
        orgId,
        title: args.title,
        category: args.category || 'general_work',
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
}
