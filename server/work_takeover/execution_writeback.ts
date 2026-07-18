import type { LumiCapabilitySelection } from '../cognition/capability_selection';
import type { LumiTurnFlow } from '../cognition/turn_flow';
import type { ToolExecutionRecord } from '../tools/types';
import { isConfirmationBlockedToolRecord } from '../tools/confirmation_block';
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
  /**
   * True when the shared result finalizer replaced the assistant candidate.
   * A guard response is delivery metadata, not a trustworthy task result.
   */
  finalizationBlocked?: boolean;
  /**
   * Whether assistantText may be persisted as the task result/turn preview.
   * Defaults to false for blocked finalization and true otherwise.
   */
  assistantTextTrusted?: boolean;
  finalizationReason?: string;
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
  confirmationBlocked?: boolean;
}

const SEMANTIC_FAILURE_STATUS_RE = /^(?:error|failed|failure|blocked|denied|rejected|forbidden|timeout|timed_out|cancelled|canceled|incomplete|partial|pending|queued|in_progress|not_ready|not_supported|unsupported|unavailable|requires_confirmation|needs_confirmation|waiting_confirmation|requires_setup|submitted_unverified|unverified|not_verified)$/i;
const CONFIRMATION_STATUS_RE = /^(?:requires_confirmation|needs_confirmation|waiting_confirmation)$/i;

interface TurnExecutionRecord {
  id: string;
  source: string;
  userText: string;
  assistantTextPreview: string;
  assistantTextTrusted: boolean;
  finalizationBlocked: boolean;
  finalizationReason?: string;
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
  let parsed: unknown = value;
  for (let attempt = 0; attempt < 3 && typeof parsed === 'string'; attempt += 1) {
    try {
      parsed = JSON.parse(parsed);
    } catch {
      return null;
    }
  }
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
}

const TASK_QUERY_TOOL_NAMES = new Set([
  'work_takeover_task_list',
  'work_takeover_task_get',
]);

const TASK_BINDING_TOOL_NAMES = new Set([
  'work_takeover_task_create',
  'work_takeover_task_from_wechat',
  'work_takeover_task_from_clipboard',
  'work_takeover_task_update',
  'work_takeover_task_continue',
  'work_takeover_task_orchestrate',
  'work_takeover_task_execute_step',
  'work_takeover_task_advance',
  'work_takeover_task_export_packet',
  'work_takeover_task_verify_result',
  'work_takeover_task_autorun',
  'work_takeover_capability_reuse_probe',
  'work_takeover_task_run_suggested_tool',
]);

function asStructuredObject(value: unknown): Record<string, any> | null {
  if (!value) return null;
  if (typeof value === 'string') return parseJsonObject(value);
  return typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, any>
    : null;
}

function validTaskId(value: unknown): string | null {
  const taskId = typeof value === 'string' ? value.trim() : '';
  return /^wt_task_\d+_[a-z0-9]+$/i.test(taskId) ? taskId : null;
}

/**
 * Read only the direct identity fields of one structured task-operation
 * envelope. Never search arrays, arbitrary nested values, or free text: a
 * task-list/read result may legitimately mention many task ids without
 * addressing any of them for execution.
 */
function directStructuredTaskId(value: unknown): string | null {
  const obj = asStructuredObject(value);
  if (!obj) return null;
  const direct = validTaskId(obj.taskId) || validTaskId(obj.id);
  if (direct) return direct;
  const task = asStructuredObject(obj.task);
  return task ? validTaskId(task.taskId) || validTaskId(task.id) : null;
}

function findTaskIdFromTools(toolRecords: ToolExecutionRecord[] = []): string | null {
  for (const record of toolRecords) {
    const toolName = String(record.name || '').toLowerCase();
    if (!TASK_BINDING_TOOL_NAMES.has(toolName)) continue;
    const fromArgs = directStructuredTaskId(record.arguments);
    if (fromArgs) return fromArgs;
    const fromResult = directStructuredTaskId(record.result);
    if (fromResult) return fromResult;
  }
  return null;
}

function isPureTaskQuery(input: WorkTakeoverTurnExecutionWritebackInput): boolean {
  const toolNames = (input.toolRecords || [])
    .map(record => String(record.name || '').toLowerCase())
    .filter(Boolean);
  if (toolNames.length === 0) return false;
  if (toolNames.every(name => TASK_QUERY_TOOL_NAMES.has(name))) return true;
  return input.flow.workTakeover.intent === 'status'
    && toolNames.every(name => TASK_QUERY_TOOL_NAMES.has(name) || name === 'work_takeover_task_continue');
}

function resolveTask(input: WorkTakeoverTurnExecutionWritebackInput): WorkTakeoverTask | null {
  // Merely having an unfinished task in the user's task center does not bind
  // every later tool action to it. Only a direct continuation may use the
  // flow pointer; task-id-bearing tool receipts remain an explicit binding.
  const fromFlow = input.flow.workTakeover.shouldResumeTask
    ? input.flow.workTakeover.latestTask?.id
    : undefined;
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

function summarizeToolFailure(record: ToolExecutionRecord): {
  error?: string;
  confirmationBlocked: boolean;
} {
  const explicitError = compact(record.error, 220);
  const sharedConfirmationBlock = isConfirmationBlockedToolRecord(record);
  if (explicitError) {
    return {
      error: explicitError,
      confirmationBlocked: sharedConfirmationBlock || isConfirmationError(explicitError),
    };
  }
  if (sharedConfirmationBlock) {
    return {
      error: compact(record.result, 220) || 'Tool requires user confirmation.',
      confirmationBlocked: true,
    };
  }

  const payload = parseJsonObject(String(record.result || '').trim());
  if (!payload) return { confirmationBlocked: false };

  const verification = payload.verification && typeof payload.verification === 'object'
    ? payload.verification
    : {};
  const status = compact(payload.status || verification.status, 120).toLowerCase();
  const confirmationBlocked = CONFIRMATION_STATUS_RE.test(status)
    || payload.requiresConfirmation === true
    || payload.confirmationRequired === true;
  const semanticFailure = payload.ok === false
    || payload.success === false
    || payload.verified === false
    || payload.completed === false
    || SEMANTIC_FAILURE_STATUS_RE.test(status);
  if (!semanticFailure && !confirmationBlocked) return { confirmationBlocked: false };

  return {
    error: compact(
      payload.error
      || payload.reason
      || payload.message
      || verification.error
      || verification.reason
      || verification.message
      || status
      || 'Tool did not complete successfully.',
      220,
    ),
    confirmationBlocked,
  };
}

function summarizeTools(toolRecords: ToolExecutionRecord[] = []): ToolSummary[] {
  return toolRecords.slice(-10).map(record => {
    const failure = summarizeToolFailure(record);
    const error = failure.error;
    return {
      name: record.name,
      status: error ? 'error' : 'ok',
      error,
      resultPreview: error ? undefined : compact(record.result, 260),
      confirmationBlocked: failure.confirmationBlocked || undefined,
    };
  });
}

function isConfirmationError(error: string): boolean {
  return /\b(?:confirm(?:ation)?|approval|captcha|2fa|otp)\b|\b(?:login|credential)\s+required\b|\buser\s+denied\b/i.test(error);
}

function inferStatus(tools: ToolSummary[]): WorkTakeoverTurnExecutionStatus {
  if (tools.some(tool => tool.confirmationBlocked)) return 'waiting_confirmation';
  const hasFailure = tools.some(tool => tool.status === 'error');
  if (hasFailure) return tools.some(tool => tool.status === 'ok') ? 'failed' : 'blocked';
  return tools.length > 0 ? 'ran' : 'no_execution';
}

function buildResumeHint(input: {
  task: WorkTakeoverTask;
  status: WorkTakeoverTurnExecutionStatus;
  failedTool?: ToolSummary;
  selection?: LumiCapabilitySelection;
  flow: LumiTurnFlow;
}): string {
  if (input.status === 'waiting_confirmation') {
    return `Resume task ${input.task.id} at the confirmation boundary. Ask for the missing confirmation or credential step, then continue without restarting.`;
  }
  if (input.failedTool) {
    return `Resume task ${input.task.id} from failed tool ${input.failedTool.name}: inspect the error, retry only the failed step or choose an alternate capability, then verify before claiming completion.`;
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
  const status = inferStatus(tools);
  const failedTool = status === 'waiting_confirmation'
    ? [...tools].reverse().find(tool => tool.confirmationBlocked)
    : [...tools].reverse().find(tool => tool.status === 'error');
  const finalizationBlocked = input.finalizationBlocked === true;
  const assistantTextTrusted = !finalizationBlocked && input.assistantTextTrusted !== false;
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
    assistantTextPreview: assistantTextTrusted ? compact(input.assistantText, 1000) : '',
    assistantTextTrusted,
    finalizationBlocked,
    finalizationReason: finalizationBlocked ? compact(input.finalizationReason, 300) || undefined : undefined,
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
  if (isPureTaskQuery(input)) {
    return {
      recorded: false,
      reason: 'task query/status lookup has no execution evidence to write back',
      status: 'no_execution',
    };
  }

  const task = resolveTask(input);
  if (!task) {
    return {
      recorded: false,
      reason: 'no active or tool-referenced work takeover task',
      status: 'no_task',
    };
  }

  if (input.finalizationBlocked && (input.toolRecords?.length || 0) === 0) {
    return {
      recorded: false,
      reason: 'finalization blocked without tool execution evidence',
      taskId: task.id,
      status: 'no_execution',
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
    result: turn.assistantTextTrusted && turn.assistantTextPreview
      ? turn.assistantTextPreview
      : task.result,
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
