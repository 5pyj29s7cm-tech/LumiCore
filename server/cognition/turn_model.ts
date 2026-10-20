import { inspectPersistedToolExecutionReceipt } from '../tools/persisted_execution_receipt';
import { isCanonicalToolExecutionRecord } from '../tools/execution_engine';
import { taskReceiptsToRecords } from './task_execution_ledger';
import { parseObject, digest } from '../conversation/ledger/serialization';
import { getConversationCompletionSnapshot } from '../conversation/conversation_lifecycle';
import { runLumiTurn, type ConversationTurnInput, type ToolSessionOptions } from '../llm/lumi_turn';
import { createModelTurnState } from '../llm/model_turn_state';
import type { LumiExecutionPipeline } from './execution_pipeline';
import type { LLMResult } from '../llm/adapter';
import { buildCapabilityExecutionPlan } from './capability_execution_plan';
import { persistConversationExecutionPlan } from '../conversation/manager/execution_preparation';

export type ResolvedTurnModelInput = (ToolSessionOptions | ConversationTurnInput) & {
  /** The server-owned plan resolved after conversation admission. */
  execution: LumiExecutionPipeline;
  assertCurrent?: () => void;
  isCancelled?: () => boolean;
  taskText?: string;
  streaming?: boolean;
};

const modelTurnStates = new WeakMap<LumiExecutionPipeline, ReturnType<typeof createModelTurnState>>();

/**
 * The admitted plan selects conversation or tool execution for every entry.
 * A visible registry cannot open the tool loop. Model retries retain the same
 * accepted identity and provider budget even when the transport is stateless.
 */
export function runResolvedLumiTurn(input: ResolvedTurnModelInput): Promise<LLMResult> {
  input.assertCurrent?.();
  const { execution } = input;
  const requestId = execution.resolution.requestId;
  if (input.config.requestId && input.config.requestId !== requestId) {
    throw new Error('Model execution does not belong to the accepted turn');
  }
  const priorState = modelTurnStates.get(execution);
  const suppliedState = input.config.modelTurnState;
  if (priorState && suppliedState && priorState !== suppliedState) {
    throw new Error('Model recovery cannot replace its accepted turn budget');
  }
  const modelTurnState = priorState || suppliedState || createModelTurnState();
  modelTurnStates.set(execution, modelTurnState);
  const config = { ...input.config, requestId, modelTurnState };
  const conversation = 'registry' in input ? undefined : input;
  const toolSession = 'registry' in input ? input : undefined;
  if (!execution.executionRequested) {
    return runLumiTurn({
      messages: input.messages,
      config,
      getters: input.getters || {},
      taskText: input.taskText || execution.resolution.userText,
      streaming: input.streaming,
      onChunk: conversation?.onChunk || toolSession?.onStreamChunk,
      assertCurrent: input.assertCurrent,
      isCancelled: input.isCancelled || toolSession?.context?.isCancelled,
    });
  }
  if (!toolSession) throw new Error('An executable turn requires its admitted registry');
  const onToolCall = toolSession.onToolCall;
  const snapshot = getConversationCompletionSnapshot({ userId:toolSession.context?.userId, conversationId:toolSession.context?.conversationId,
    domain:toolSession.context?.domain, orgId:toolSession.context?.orgId, taskId:toolSession.context?.taskId || execution.taskId, requestId });
  const task = snapshot?.task, root = snapshot?.root, currentTurn = snapshot?.currentTurn;
  const history = root && currentTurn && task.activeRequestId === requestId && execution.trustedActionContinuation
    ? taskReceiptsToRecords(parseObject(task.context).actionState?.receipts || []).flatMap(record => {
      if (!record.id || !record.requestId || record.requestId === requestId || !record.capability || !record.envelope) return [];
      const rows = (snapshot?.receipts || []).filter((row: any) => row.taskId === task.id && row.conversationId === task.conversationId
        && row.requestId === record.requestId && row.toolName === record.name && row.idempotencyKey === record.envelope?.idempotencyKey);
      if (rows.length !== 1) return [];
      const row = rows[0];const priorTurn = (snapshot?.turns || []).find((turn: any) => turn.id === row.turnRowId && turn.taskId === task.id
        && turn.requestId === row.requestId && turn.userId === task.userId && turn.conversationId === task.conversationId
        && (turn.domain || 'personal') === (task.domain || 'personal') && (turn.orgId || '') === (task.orgId || ''));
      const canonical = inspectPersistedToolExecutionReceipt(row, { rowTaskId: task.id, requestId: record.requestId, toolName: record.name });
      const typed = inspectPersistedToolExecutionReceipt({ ...row, envelope: record.envelope });
      if (!priorTurn || !row.inputDigest || !canonical.valid || !typed.valid || canonical.envelope?.status !== typed.envelope?.status) return [];
      const envelope = canonical.envelope!;
      return [{ id: 'prior:' + row.id, argumentsVerified: digest(record.arguments || {}) === row.inputDigest, record: { ...record, envelope, result: typeof envelope.result === 'string' ? envelope.result : envelope.result === undefined ? record.result : JSON.stringify(envelope.result) } }];
    }) : [];
  return runLumiTurn({
    ...toolSession,
    config,
    onToolCall: onToolCall ? async record => {
      const entry = toolSession.registry.getCapabilityManifestEntry(record.name, execution.authorizationPolicy, toolSession.context);
      if (entry && record.capability && record.envelope) execution.executionPlan = buildCapabilityExecutionPlan({
        record, capability: { ...entry, ...record.capability }, previousPlan: execution.executionPlan,
        taskId: toolSession.context?.taskId || execution.taskId || requestId,
      });
      await onToolCall(record);
      if (execution.turnIntent.boundary !== 'task_center' && execution.executionPlan
        && (toolSession.context?.taskId || execution.taskId) && toolSession.context?.conversationId && toolSession.context.userId) {
        if (!persistConversationExecutionPlan({ conversationId: toolSession.context.conversationId,
          userId: toolSession.context.userId, plan: execution.executionPlan })) {
          throw new Error('The observed bound-call plan could not be attached to its exact task');
        }
      }
    } : undefined,
    maxIterations: Math.min(toolSession.maxIterations ?? execution.authorizationPolicy.maxIterations,
      execution.authorizationPolicy.maxIterations),
    context: {
      ...toolSession.context,
      requestId, turnId: requestId, resolutionId: execution.resolution.id,
      toolPolicy: execution.authorizationPolicy,
      modelToolProjection: execution.modelToolProjection,
      currentTurnExecutionRequested: true,
      completionRequest: { currentText: execution.resolution.userText, ...(root ? { rootText: String(root.message || '') } : {}), history },
      priorToolRecords: [...history.map(item => item.record), ...(toolSession.context?.priorToolRecords || []).filter(record => record.requestId === requestId && isCanonicalToolExecutionRecord(record))],
      acceptedActionContract: execution.turnIntent.flow.acceptedActionContract,
      trustedActionContinuation: execution.trustedActionContinuation,
      actionIntent: toolSession.context?.actionIntent ?? execution.resolution.userText,
      routedTaskText: toolSession.context?.routedTaskText ?? execution.turnIntent.flow.routeText,
      acceptedTaskTarget: toolSession.context?.acceptedTaskTarget ?? execution.turnIntent.flow.acceptedTaskTarget,
      currentAppTarget: toolSession.context?.currentAppTarget ?? execution.turnIntent.flow.currentAppEditTarget,
    },
  });
}
