import { guardCompletionClaims } from '../work_product/completion_guard';
import type { ToolExecutionRecord } from '../tools/types';
import type { LumiTurnFlow } from './turn_flow';

export interface LumiResultFinalizerInput {
  taskText: string;
  responseText: string;
  toolRecords?: ToolExecutionRecord[];
  source: 'chat' | 'voice' | 'task' | 'workflow' | 'background_delegation' | string;
  flow?: LumiTurnFlow;
}

export interface LumiResultFinalizerResult {
  text: string;
  blocked: boolean;
  reason?: string;
  notification?: {
    type: 'work_product_guard';
    level: 'warning';
    message: string;
  };
}

export function finalizeLumiResponse(input: LumiResultFinalizerInput): LumiResultFinalizerResult {
  const guard = guardCompletionClaims({
    task: input.taskText,
    response: input.responseText,
    toolCalls: input.toolRecords || [],
    source: input.source,
  });

  if (!guard.blocked) {
    return { text: input.responseText, blocked: false };
  }

  return {
    text: guard.text,
    blocked: true,
    reason: guard.reason,
    notification: {
      type: 'work_product_guard',
      level: 'warning',
      message: guard.reason || 'Completion claim needs verification.',
    },
  };
}
