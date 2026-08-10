import {
  persistLumiLearningTurn,
  type LumiLearningChannel,
  type LumiLearningTurnResult,
} from './learning_interface';
import type { ToolExecutionRecord } from '../tools/types';
import type { LumiTurnFlow } from './turn_flow';
import {
  recordReadOnlyToolPattern,
  type ReadOnlyToolPatternRow,
} from '../context/read_only_tool_learning';

type LogFn = (message: string, ...args: any[]) => void;

export interface LumiPostTurnLearningContext {
  userId: string;
  userText: string;
  defaultChannel: LumiLearningChannel;
  flow?: LumiTurnFlow;
  getToolNames: () => string[];
  domain?: string;
  orgId?: string;
  defaultSourceInteractionId?: string;
  agentId?: string;
  log?: {
    info?: LogFn;
    warn?: LogFn;
  };
}

export interface LumiPostTurnLearningOptions {
  channel?: LumiLearningChannel;
  toolRecords?: ToolExecutionRecord[];
  sourceInteractionId?: string;
  logLabel?: string;
}

export interface LumiPostTurnLearningOutcome {
  ok: boolean;
  result?: LumiLearningTurnResult;
  readOnlyPattern?: {
    recorded: boolean;
    reason: string;
    pattern?: ReadOnlyToolPatternRow;
  };
  error?: string;
}

export function persistLumiPostTurnLearning(
  context: LumiPostTurnLearningContext,
  assistantText: string,
  options: LumiPostTurnLearningOptions = {},
): LumiPostTurnLearningOutcome {
  const channel = options.channel || context.defaultChannel;
  const label = options.logLabel || channel;

  try {
    const result = persistLumiLearningTurn({
      userId: context.userId,
      userText: context.userText,
      assistantText,
      channel,
      flow: context.flow,
      toolNames: context.getToolNames(),
      toolRecords: options.toolRecords || [],
      domain: context.domain,
      orgId: context.orgId,
      sourceInteractionId: options.sourceInteractionId || context.defaultSourceInteractionId,
      agentId: context.agentId || '',
    });

    const readOnlyPattern = recordReadOnlyToolPattern({
      userId: context.userId,
      userText: context.userText,
      toolRecords: options.toolRecords || [],
      domain: context.domain,
      orgId: context.orgId,
      observationRef: options.sourceInteractionId || context.defaultSourceInteractionId,
    });

    if (result.shouldPersist) {
      const info = context.log?.info || console.log;
      info(`[LumiLearningInterface] ${label} persisted memories=${result.storedMemories} capability=${result.capabilityRecord?.id || 'none'} reasons=${result.reasons.join(',')}`);
    }
    return { ok: true, result, readOnlyPattern };
  } catch (err: any) {
    const error = err?.message || String(err);
    const warn = context.log?.warn || console.warn;
    warn(`[LumiLearningInterface] ${label} persistence failed:`, error);
    return { ok: false, error };
  }
}
