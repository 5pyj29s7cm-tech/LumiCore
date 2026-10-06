import type { ToolExecutionRecord, ToolContext } from "../../tools/types";
import type { NormalizedMessage } from "../providers";
import { buildToolExecutionEnvelope } from "../../tools/execution_envelope";
import { CN_EXECUTION_EVIDENCE_MESSAGES } from "../../regions/messages/execution_evidence_messages";
import type { LLMConfig, LLMUsageRecord, LLMResult } from './contracts';
import { recordWorkflowIfToolsUsed } from './workflow';
import { getPrimaryUserText } from './summaries';

/**
 * These are runtime safety ceilings, not personality permissions. Wildcard
 * tool access and a large iteration budget cannot raise them.
 */
export const HARD_MAX_TOOL_INVOCATIONS_PER_MODEL_RESPONSE = 8;

export const HARD_MAX_TOOL_INVOCATIONS_PER_TURN = 24;

export interface ToolInvocationBudgetState {
  /** Reserved invocation slots; reservations are atomic before a batch starts. */
  used: number;
  /** Canonical execution boundaries actually entered. */
  started: number;
  readonly perResponseLimit: number;
  readonly turnLimit: number;
  lastTouchedAt: number;
}

export const TOOL_INVOCATION_BUDGET_TTL_MS = 30 * 60_000;

export const turnInvocationBudgets = new Map<string, ToolInvocationBudgetState>();

export function newToolInvocationBudget(now = Date.now()): ToolInvocationBudgetState {
  return {
    used: 0,
    started: 0,
    perResponseLimit: HARD_MAX_TOOL_INVOCATIONS_PER_MODEL_RESPONSE,
    turnLimit: HARD_MAX_TOOL_INVOCATIONS_PER_TURN,
    lastTouchedAt: now,
  };
}

export function resolveToolInvocationBudget(context?: ToolContext): ToolInvocationBudgetState {
  const requestId = String(context?.requestId || context?.turnId || '').trim();
  const userId = String(context?.userId || '').trim();
  if (!requestId || !userId) return newToolInvocationBudget();
  const now = Date.now();
  for (const [key, budget] of turnInvocationBudgets.entries()) {
    if (now - budget.lastTouchedAt > TOOL_INVOCATION_BUDGET_TTL_MS) {
      turnInvocationBudgets.delete(key);
    }
  }
  const key = [
    userId,
    String(context?.domain || ''),
    String(context?.orgId || ''),
    String(context?.conversationId || ''),
    requestId,
  ].join('\u001f');
  const existing = turnInvocationBudgets.get(key);
  if (existing) {
    existing.lastTouchedAt = now;
    return existing;
  }
  const created = newToolInvocationBudget(now);
  turnInvocationBudgets.set(key, created);
  return created;
}

export type ToolInvocationBudgetBoundary = 'model_response' | 'turn';

export function buildToolInvocationBudgetRecord(input: {
  boundary: ToolInvocationBudgetBoundary;
  rawPlannedCalls: number;
  normalizedPlannedCalls: number;
  invocableCalls: number;
  budget: ToolInvocationBudgetState;
  context?: ToolContext;
}): ToolExecutionRecord {
  const limit = input.boundary === 'model_response'
    ? input.budget.perResponseLimit
    : input.budget.turnLimit;
  const enumExpansionApplied = input.normalizedPlannedCalls > input.rawPlannedCalls;
  const reason = input.boundary === 'model_response'
    ? `The model planned ${input.normalizedPlannedCalls} tool calls in one response, exceeding the hard per-response limit of ${limit}.`
    : `The next batch would raise this turn from ${input.budget.used} to ${input.budget.used + input.invocableCalls} tool invocations, exceeding the hard turn limit of ${limit}.`;
  const receipt = {
    ok: false,
    status: 'blocked',
    code: 'TOOL_INVOCATION_BUDGET_EXCEEDED',
    boundary: input.boundary,
    limit,
    executedInvocations: input.budget.started,
    reservedInvocations: input.budget.used,
    remainingInvocations: Math.max(0, input.budget.turnLimit - input.budget.used),
    rawPlannedCalls: input.rawPlannedCalls,
    normalizedPlannedCalls: input.normalizedPlannedCalls,
    invocableCalls: input.invocableCalls,
    enumExpansionApplied,
    appliesToOperations: ['observe', 'test', 'mutate', 'create', 'communicate', 'unknown'],
    overLimitBatchExecuted: false,
  };
  const record: ToolExecutionRecord = {
    id: `tool_budget_${Date.now().toString(36)}_${input.budget.used}`,
    taskId: input.context?.taskId,
    turnId: input.context?.turnId,
    requestId: input.context?.requestId,
    name: 'lumi_tool_invocation_budget',
    arguments: {
      boundary: input.boundary,
      requested: input.boundary === 'model_response'
        ? input.normalizedPlannedCalls
        : input.budget.used + input.invocableCalls,
      limit,
    },
    result: JSON.stringify(receipt),
    receipt,
    adapterStarted: false,
    error: `TOOL_INVOCATION_BUDGET_EXCEEDED: ${reason}`,
    terminalVerification: {
      status: 'failed',
      strategy: 'terminal_receipt',
      reason: `${reason} The over-limit batch was not executed.`,
    },
  };
  record.envelope = buildToolExecutionEnvelope(record, {
    taskId: input.context?.taskId,
    turnId: input.context?.turnId,
    requestId: input.context?.requestId,
  });
  return record;
}

export function buildToolInvocationBudgetSummary(
  task: string,
  record: ToolExecutionRecord,
): string {
  const receipt = record.receipt as Record<string, any>;
  const isZh = /[\u3400-\u9fff]/u.test(task);
  if (isZh) {
    return [
      CN_EXECUTION_EVIDENCE_MESSAGES.toolInvocationBudgetStopped(
        receipt.normalizedPlannedCalls,
        receipt.boundary,
        receipt.limit,
      ),
      CN_EXECUTION_EVIDENCE_MESSAGES.toolInvocationBudgetExecuted(receipt.executedInvocations),
      receipt.enumExpansionApplied ? CN_EXECUTION_EVIDENCE_MESSAGES.toolInvocationBudgetEnumExpanded : '',
      CN_EXECUTION_EVIDENCE_MESSAGES.toolInvocationBudgetNextStep,
    ].filter(Boolean).join('\n');
  }
  return [
    `Tool execution stopped safely before the over-limit batch ran: ${receipt.normalizedPlannedCalls} calls were planned, exceeding the hard ${receipt.boundary === 'model_response' ? 'per-response' : 'per-turn'} limit of ${receipt.limit}.`,
    `${receipt.executedInvocations} tool invocations ran in this turn; every call in the over-limit batch was left unexecuted.`,
    receipt.enumExpansionApplied ? 'Schema-enum expansion is included in the same hard budget.' : '',
    'The receipt is preserved. Narrow the scope or continue from verified progress in a new turn.',
  ].filter(Boolean).join('\n');
}

export async function stopForToolInvocationBudget(input: {
  boundary: ToolInvocationBudgetBoundary;
  rawPlannedCalls: number;
  normalizedPlannedCalls: number;
  invocableCalls: number;
  budget: ToolInvocationBudgetState;
  executionLog: ToolExecutionRecord[];
  messages: NormalizedMessage[];
  config: LLMConfig;
  usageRecords: LLMUsageRecord[];
  context?: ToolContext;
  onToolCall?: (record: ToolExecutionRecord) => unknown;
}): Promise<LLMResult> {
  const record = buildToolInvocationBudgetRecord(input);
  input.executionLog.push(record);
  await input.onToolCall?.(record);
  recordWorkflowIfToolsUsed(input.executionLog, input.messages, input.config);
  return {
    text: buildToolInvocationBudgetSummary(getPrimaryUserText(input.messages), record),
    toolCalls: input.executionLog,
    usageRecords: input.usageRecords,
  };
}
