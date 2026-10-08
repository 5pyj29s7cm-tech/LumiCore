import { runLumiTurn, type ConversationTurnInput, type ToolSessionOptions } from '../llm/lumi_turn';
import { createModelTurnState } from '../llm/model_turn_state';
import type { LumiExecutionPipeline } from './execution_pipeline';
import type { LLMResult } from '../llm/adapter';

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
  return runLumiTurn({
    ...toolSession,
    config,
    maxIterations: Math.min(toolSession.maxIterations ?? execution.authorizationPolicy.maxIterations,
      execution.authorizationPolicy.maxIterations),
    context: {
      ...toolSession.context,
      requestId, turnId: requestId, resolutionId: execution.resolution.id,
      toolPolicy: execution.authorizationPolicy,
      modelToolProjection: execution.modelToolProjection,
      currentTurnExecutionRequested: true,
      acceptedActionContract: execution.turnIntent.flow.acceptedActionContract,
      trustedActionContinuation: execution.trustedActionContinuation,
      actionIntent: toolSession.context?.actionIntent ?? execution.resolution.userText,
      routedTaskText: toolSession.context?.routedTaskText ?? execution.turnIntent.flow.routeText,
      acceptedTaskTarget: toolSession.context?.acceptedTaskTarget ?? execution.turnIntent.flow.acceptedTaskTarget,
      currentAppTarget: toolSession.context?.currentAppTarget ?? execution.turnIntent.flow.currentAppEditTarget,
    },
  });
}
