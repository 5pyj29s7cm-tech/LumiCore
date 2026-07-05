import type { LumiCapabilitySelection } from '../cognition/capability_selection';
import type { LumiTurnFlow } from '../cognition/turn_flow';
import type { ToolExecutionRecord } from '../tools/types';
import {
  getWorkTakeoverTask,
  listWorkTakeoverTasks,
  updateWorkTakeoverTask,
  type WorkTakeoverTask,
  type WorkTakeoverStatus,
} from './tasks';

export type WorkTakeoverTurnExecutionStatus =
  | 'no_task'
  | 'no_execution'
  | 'ran'
  | 'failed'
  | 'waiting_confirmation'
  | 'blocked';

export interface WorkTakeoverTurnExecutionWritebackInput {
  userId: string;
  userText: string;
  assistantText: string;
  source: 'chat' | 'voice' | 'task' | 'workflow' | string;
  interactionId?: string;
  domain?: string;
  orgId?: string;
  flow: LumiTurnFlow;
  capabilitySelection?: LumiCapabilitySelection;
  toolRecords?: ToolExecutionRecord[];
}

export interface WorkTakeoverTurnExecutionWritebackResult {
  recorded: boolean;
  reason: string;
  taskId?: string;
  status: WorkTakeoverTurnExecutionStatus;
  resumeHint?: string;
}

interface ToolSummary {
  name: string;
  status: 'ok' | 'error';
  error?: string;
  resultPreview?: string;
}

interface TurnExecutionRecord {
  id: string;
  source: string;
  userText: string;
  assistantTextPreview: string;
  capabilityLane: string;
  primaryCapability: string;
  boundary: string;
  continuationIntent: string;
  continuationStrength: string;
  status: WorkTakeoverTurnExecutionStatus;
  toolCount: number;
  tools: ToolSummary[];
  failedTool?: ToolSummary;
  resumeHint: string;
  createdAt: string;
}

function compact(value: unknown, limit = 500): string {
  const text = typeof value === 'string' ? value : value == null ? '' : JSON.stringify(value);
  return text.replace(/\s+/g, ' ').trim().slice(0, limit);
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values.map(value => compact(value, 300)).filter(Boolean)));
}

function parseJsonObject(value: string): any | null {
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function findTaskIdInValue(value: unknown): string | null {
  if (!value) return null;
  if (typeof value === 'string') {
    const parsed = parseJsonObject(value);
    if (parsed) return findTaskIdInValue(parsed);
    const match = value.match(/\bwt_task_\d+_[a-z0-9]+\b/i);
    return match?.[0] || null;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findTaskIdInValue(item);
      if (found) return found;
    }
    return null;
  }
  if (typeof value === 'object') {
    const obj = value as Record<string, any>;
    if (typeof obj.id === 'string' && obj.id.startsWith('wt_task_')) return obj.id;
    if (typeof obj.taskId === 'string' && obj.taskId.startsWith('wt_task_')) return obj.taskId;
    if (obj.task) {
      const found = findTaskIdInValue(obj.task);
      if (found) return found;
    }
    for (const nested of Object.values(obj)) {
      const found = findTaskIdInValue(nested);
      if (found) return found;
    }
  }
  return null;
}

function findTaskIdFromTools(toolRecords: ToolExecutionRecord[] = []): string | null {
  for (const record of toolRecords) {
    const fromArgs = findTaskIdInValue(record.arguments);
    if (fromArgs) return fromArgs;
    const fromResult = findTaskIdInValue(record.result);
    if (fromResult) return fromResult;
  }
  return null;
}

function resolveTask(input: WorkTakeoverTurnExecutionWritebackInput): WorkTakeoverTask | null {
  const fromFlow = input.flow.workTakeover.latestTask?.id;
  if (fromFlow) {
    const task = getWorkTakeoverTask(input.userId, fromFlow);
    if (task) return task;
  }

  const fromTools = findTaskIdFromTools(input.toolRecords || []);
  if (fromTools) {
    const task = getWorkTakeoverTask(input.userId, fromTools);
    if (task) return task;
  }

  if (input.flow.channel === 'task') {
    return listWorkTakeoverTasks({
      userId: input.userId,
      domain: input.domain,
      orgId: input.orgId,
      status: 'active',
      limit: 1,
    })[0] || null;
  }

  return null;
}

function summarizeTools(toolRecords: ToolExecutionRecord[] = []): ToolSummary[] {
  return toolRecords.slice(-10).map(record => ({
    name: record.name,
    status: record.error ? 'error' : 'ok',
    error: record.error ? compact(record.error, 220) : undefined,
    resultPreview: record.error ? undefined : compact(record.result, 260),
  }));
}

function isConfirmationError(error: string): boolean {
  return /\b(confirm|confirmation|denied|timeout|permission|approval|captcha|2fa|otp|login|required)\b/i.test(error);
}

function inferStatus(toolRecords: ToolExecutionRecord[], failedTool?: ToolSummary): WorkTakeoverTurnExecutionStatus {
  if (failedTool?.error && isConfirmationError(failedTool.error)) return 'waiting_confirmation';
  if (failedTool) return toolRecords.some(record => !record.error) ? 'failed' : 'blocked';
  return toolRecords.length > 0 ? 'ran' : 'no_execution';
}

function buildResumeHint(input: {
  task: WorkTakeoverTask;
  status: WorkTakeoverTurnExecutionStatus;
  failedTool?: ToolSummary;
  selection?: LumiCapabilitySelection;
  flow: LumiTurnFlow;
}): string {
  if (input.failedTool) {
    return `Resume task ${input.task.id} from failed tool ${input.failedTool.name}: inspect the error, retry only the failed step or choose an alternate capability, then verify before claiming completion.`;
  }
  if (input.status === 'waiting_confirmation') {
    return `Resume task ${input.task.id} at the confirmation boundary. Ask for the missing confirmation or credential step, then continue without restarting.`;
  }
  if (input.flow.workTakeover.intent === 'status') {
    return `Use work_takeover_task_continue or work_takeover_task_verify_result for task ${input.task.id}, then report current result, blocker, and next confirmation.`;
  }
  if (input.selection?.lane === 'desktop_control') {
    return `Resume task ${input.task.id} by inspecting the active window/screen first, then continue visible desktop control from the last verified state.`;
  }
  if (input.selection?.lane === 'web_or_account') {
    return `Resume task ${input.task.id} by checking browser/account session state first, then continue the saved-login or browser step.`;
  }
  return `Use work_takeover_task_advance for task ${input.task.id}; continue from the recorded task state instead of starting over.`;
}

function nextStatus(current: WorkTakeoverStatus, turnStatus: WorkTakeoverTurnExecutionStatus): WorkTakeoverStatus | undefined {
  if (turnStatus === 'blocked') return 'blocked';
  if (turnStatus === 'waiting_confirmation') return 'waiting_confirmation';
  if (current === 'queued' && (turnStatus === 'ran' || turnStatus === 'failed' || turnStatus === 'no_execution')) return 'in_progress';
  return undefined;
}

function buildTurnRecord(
  input: WorkTakeoverTurnExecutionWritebackInput,
  task: WorkTakeoverTask,
): TurnExecutionRecord {
  const tools = summarizeTools(input.toolRecords || []);
  const failedTool = [...tools].reverse().find(tool => tool.status === 'error');
  const status = inferStatus(input.toolRecords || [], failedTool);
  const resumeHint = buildResumeHint({
    task,
    status,
    failedTool,
    selection: input.capabilitySelection,
    flow: input.flow,
  });

  return {
    id: input.interactionId || `turn_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    source: input.source,
    userText: compact(input.userText, 800),
    assistantTextPreview: compact(input.assistantText, 1000),
    capabilityLane: input.capabilitySelection?.lane || 'unknown',
    primaryCapability: input.capabilitySelection?.primary || '',
    boundary: input.flow.channel + '/' + input.flow.surface,
    continuationIntent: input.flow.workTakeover.intent || 'none',
    continuationStrength: input.flow.workTakeover.strength,
    status,
    toolCount: input.toolRecords?.length || 0,
    tools,
    failedTool,
    resumeHint,
    createdAt: new Date().toISOString(),
  };
}

export function persistWorkTakeoverTurnExecution(
  input: WorkTakeoverTurnExecutionWritebackInput,
): WorkTakeoverTurnExecutionWritebackResult {
  const task = resolveTask(input);
  if (!task) {
    return {
      recorded: false,
      reason: 'no active or tool-referenced work takeover task',
      status: 'no_task',
    };
  }

  const turn = buildTurnRecord(input, task);
  const existingExecution = task.metadata?.workTakeoverExecution && typeof task.metadata.workTakeoverExecution === 'object'
    ? task.metadata.workTakeoverExecution
    : {};
  const turnHistory = Array.isArray(existingExecution.turnHistory)
    ? existingExecution.turnHistory.slice(-20)
    : [];
  const failed = turn.failedTool;
  const lastFailure = failed
    ? {
        tool: failed.name,
        error: failed.error || 'Tool failed',
        source: input.source,
        interactionId: turn.id,
        capabilityLane: turn.capabilityLane,
        resumeHint: turn.resumeHint,
        createdAt: turn.createdAt,
      }
    : undefined;

  const blockedBy = failed
    ? unique([
        ...task.blockedBy,
        `${failed.name}: ${failed.error || 'Tool failed'}`,
      ]).slice(0, 20)
    : undefined;

  const updated = updateWorkTakeoverTask(input.userId, task.id, {
    status: nextStatus(task.status, turn.status),
    blockedBy,
    result: turn.assistantTextPreview || task.result,
    metadata: {
      workTakeoverExecution: {
        ...existingExecution,
        lastTurn: turn,
        lastFailure,
        lastCapabilityLane: turn.capabilityLane,
        resumeHint: turn.resumeHint,
        turnHistory: [...turnHistory, turn],
        updatedAt: turn.createdAt,
      },
    },
    note: `Turn execution recorded: lane=${turn.capabilityLane}, status=${turn.status}.`,
  });

  return {
    recorded: Boolean(updated),
    reason: updated ? 'turn execution recorded' : 'task update failed',
    taskId: task.id,
    status: turn.status,
    resumeHint: turn.resumeHint,
  };
}
