import {
  persistLumiLearningTurn,
  type LumiLearningChannel,
  type LumiLearningTurnResult,
} from './learning_interface';
import type { ToolExecutionRecord } from '../tools/types';
import type { LumiTurnFlow } from './turn_flow';

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

    if (result.shouldPersist) {
      const info = context.log?.info || console.log;
      info(`[LumiLearningInterface] ${label} persisted memories=${result.storedMemories} capability=${result.capabilityRecord?.id || 'none'} reasons=${result.reasons.join(',')}`);
    }
    return { ok: true, result };
  } catch (err: any) {
    const error = err?.message || String(err);
    const warn = context.log?.warn || console.warn;
    warn(`[LumiLearningInterface] ${label} persistence failed:`, error);
    return { ok: false, error };
  }
}
