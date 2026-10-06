import { flushDBOrThrow } from '../../db_layer';
import { addMessageIdempotent, getConversationForScope, getMessages, startConversationActionExecutionHeartbeat } from '../conversation/manager';
import { preparePlannedConversationExecution } from '../conversation/planned_execution';
import { createConversationReceiptObserver } from '../conversation/execution_receipt_archive';
import type { RequestAuthorization } from '../conversation/lifecycle';
import { buildLumiExecutionPipeline, type BuildLumiExecutionPipelineInput, type LumiExecutionPipeline } from './execution_pipeline';
import { reserveConversationExecution } from './conversation_execution';
import { mergeToolExecutionRecords } from './task_execution_ledger';
import { runResolvedLumiTurn, type ResolvedTurnModelInput } from './turn_model';
import { runPreparedLumiTurn } from './prepared_turn';
import type { LumiResultFinalizerResult } from './result_finalizer_types';
import type { ToolExecutionRecord } from '../tools/types';
import type { NormalizedMessage } from '../llm/providers';
import type { MemoryReceipt } from '../memory/turn_memory';
import type { ConversationTurnInput, ToolSessionOptions } from '../llm/lumi_turn';
import { TASK_TARGET_HISTORY_LIMIT } from '../conversation/task_target_anchor';

export interface LumiTurnEntryDescriptor {
  source: string;
  queueSource?: string;
  channel: string;
  historyLimit: number;
  failureText: string;
  failureReason: string;
}
export interface LumiTurnExecutionIdentity {
  userId: string; agentId: string; conversationId: string; requestId: string;
  domain: 'personal' | 'work'; orgId: string;
}
export interface AssembledLumiTurnData {
  systemPrompt: string;
  model: (Omit<ToolSessionOptions, 'messages'> & { streaming?: boolean; taskText?: string }) | Omit<ConversationTurnInput, 'messages'>;
  /** Stateless external entries supply their already normalized provider messages. */
  messages?: NormalizedMessage[];
}
export interface ExecutedLumiTurn {
  execution: LumiExecutionPipeline;
  taskId?: string;
  turnRowId?: string;
  finalized: LumiResultFinalizerResult;
  toolRecords: ToolExecutionRecord[];
  usageRecords: Awaited<ReturnType<typeof runResolvedLumiTurn>>['usageRecords'];
}
export interface LumiEntryTurnInput<T> {
  entry: LumiTurnEntryDescriptor;
  identity: LumiTurnExecutionIdentity;
  userText: string;
  /** External ledgers keep their existing durable task and transcript ownership. */
  persistence?: 'conversation' | 'external';
  externalTask?: { taskId?: string; turnRowId?: string };
  authorization: RequestAuthorization;
  controller: AbortController;
  planning: Omit<BuildLumiExecutionPipelineInput, 'requestId' | 'actionTaskState' | 'persistedConversationHistory'>;
  /** Entry enrichment returns data; ownership, planning and execution remain here. */
  assemble(execution: LumiExecutionPipeline): AssembledLumiTurnData | Promise<AssembledLumiTurnData>;
  explicitMemory?: () => Promise<MemoryReceipt>;
  beforeCommit?: (result: ExecutedLumiTurn) => Promise<void> | void;
  deliverySource?: () => string;
  deliver(result: ExecutedLumiTurn): Promise<T> | T;
}

/** One owner drives FIFO admission, current-plan resolution, assembly, execution and durable delivery. */
export async function runLumiEntryTurn<T>(input: LumiEntryTurnInput<T>): Promise<T> {
  const { authorization, controller } = input;
  const identity = Object.freeze({ ...input.identity });
  const entry = Object.freeze({ ...input.entry });
  const userText = input.userText;
  const conversationPersistence = input.persistence !== 'external';
  const externalTask = Object.freeze({ ...input.externalTask });
  const planning = { ...input.planning, dispatch: { ...input.planning.dispatch } };
  authorization.assertCurrent();
  const admission = identity.conversationId ? reserveConversationExecution({ ...identity, source: entry.queueSource || entry.source }, identity.requestId, controller.signal,
    { authorization, abort: reason => { if (!controller.signal.aborted) controller.abort(reason); } }) : undefined;
  if (conversationPersistence && !identity.conversationId) throw new Error('A conversation entry requires its accepted transcript');
  let heartbeat: ReturnType<typeof startConversationActionExecutionHeartbeat> | undefined;
  let taskId: string | undefined;
  let turnRowId: string | undefined;
  let userMessageId: string | undefined;
  let toolRecords: ToolExecutionRecord[] = [];
  const assertCurrent = () => { controller.signal.throwIfAborted(); authorization.assertCurrent(); };
  const commit = async (finalized: LumiResultFinalizerResult, reason: string) => {
    authorization.assertCurrent();
    if (!conversationPersistence) { if (identity.conversationId) await flushDBOrThrow(); return; }
    addMessageIdempotent({ ...identity, source: entry.source, channel: entry.channel, role: 'assistant', content: finalized.text,
      toolCalls: toolRecords, cognitiveIntent: reason,
      ...(finalized.blocked && taskId ? { terminalTaskDisposition: { outcome: 'blocked' as const, taskId,
        requestId: identity.requestId, reason: finalized.reason || reason } } : {}),
    });
    await flushDBOrThrow();
    authorization.assertCurrent();
  };
  try {
    await admission?.waitForTurn(); assertCurrent();
    const conversation = identity.conversationId ? getConversationForScope(identity.conversationId, identity.userId, identity.domain, identity.orgId) : null;
    if (identity.conversationId && !conversation) throw Object.assign(new Error('The accepted conversation is unavailable'), { code: 'CONVERSATION_ENTRY_UNAVAILABLE' });
    const execution = buildLumiExecutionPipeline({ ...planning, requestId: identity.requestId,
      ...(conversationPersistence && conversation ? { actionTaskState: conversation.actionContinuationState,
        persistedConversationHistory: getMessages(identity.conversationId, TASK_TARGET_HISTORY_LIMIT) } : {}),
    });
    if (conversationPersistence) {
    userMessageId = addMessageIdempotent({ ...identity, source: entry.source, channel: entry.channel, role: 'user',
      content: userText, deferActionPreparation: true });
    const prepared = preparePlannedConversationExecution({ ...identity, execution, userText, userMessageId, bindConversationTurn: true });
    if ('bindingFailure' in prepared) throw new Error('Conversation turn cannot be admitted');
    taskId = prepared.state?.taskId; turnRowId = prepared.turnRowId;
    await flushDBOrThrow(); assertCurrent();
    heartbeat = startConversationActionExecutionHeartbeat({ ...identity, abortController: controller });
    } else { taskId = externalTask.taskId; turnRowId = externalTask.turnRowId; }
    const receiptObserver = conversationPersistence ? createConversationReceiptObserver({ ...identity, taskId, turnRowId }, authorization.isCurrent) : undefined;
    const assembled = await input.assemble(execution); assertCurrent();
    if (assembled.model.config.requestId && assembled.model.config.requestId !== identity.requestId) throw new Error('Model data does not belong to the accepted request');
    if (assembled.model.config.conversationId && assembled.model.config.conversationId !== identity.conversationId) throw new Error('Model data does not belong to the accepted conversation');
    const messages: NormalizedMessage[] = !conversationPersistence && assembled.messages ? assembled.messages : [
      { role: 'system', content: assembled.systemPrompt },
      ...getMessages(identity.conversationId, entry.historyLimit + 1).filter(row => row.requestId !== identity.requestId && (row.role === 'user' || row.role === 'assistant'))
        .map(row => ({ role: row.role as 'user' | 'assistant', content: row.message })),
      { role: 'user', content: userText },
    ];
    const toolModel = 'registry' in assembled.model ? assembled.model : undefined;
    const model: ResolvedTurnModelInput = { ...assembled.model, execution, messages, assertCurrent,
      config: { ...assembled.model.config, conversationId: identity.conversationId, requestId: identity.requestId, signal: controller.signal },
      ...(toolModel ? { context: { ...toolModel.context, ...identity, taskId, turnRowId,
        source: entry.source, executionSignal: controller.signal, isCancelled: () => controller.signal.aborted || !authorization.isCurrent(),
        onToolRecord: async record => { await receiptObserver?.onToolRecord(record); await toolModel.context?.onToolRecord?.(record); },
      }, onToolCall: async record => { toolRecords = mergeToolExecutionRecords(toolRecords, [record]); await toolModel.onToolCall?.(record); } } : {}),
    };
    const completed = await runPreparedLumiTurn({ model, taskText: userText, taskId, requestId: identity.requestId,
      source: input.deliverySource || entry.source, skipModel: Boolean(input.explicitMemory),
      projectRecords: records => mergeToolExecutionRecords(toolRecords, records) });
    toolRecords = completed.toolRecords;
    const usageRecords = completed.usageRecords;
    let finalized = completed.finalized; assertCurrent();
    if (input.explicitMemory) {
      const receipt = await input.explicitMemory(); assertCurrent();
      finalized = { ...finalized, text: receipt.text || entry.failureText,
        blocked: receipt.status === 'failed' || receipt.status === 'skipped', reason: 'memory_' + receipt.status };
    }
    const executed = { execution, taskId, turnRowId, finalized, toolRecords, usageRecords };
    await input.beforeCommit?.(executed); assertCurrent();
    await commit(finalized, finalized.reason || entry.source); assertCurrent();
    return await input.deliver(executed);
  } catch (error) {
    if (userMessageId && authorization.isCurrent()) await commit({ text: entry.failureText, blocked: true, reason: entry.failureReason }, entry.failureReason);
    throw error;
  } finally { heartbeat?.stop(); admission?.release(); }
}
