import type { ToolExecutionRecord } from '../tools/types';
import type { LumiTurnFlow } from './turn_flow';
import { type CompletionGuardResult } from '../work_product/completion_guard';

export interface LumiResultFinalizerInput {
  taskText: string;
  responseText: string;
  toolRecords?: ToolExecutionRecord[];
  source: 'chat' | 'voice' | 'task' | 'workflow' | string;
  flow?: LumiTurnFlow;
  /** Optional durable fences for status-bearing receipts. */
  taskId?: string;
  requestId?: string;
  completionGuard?: CompletionGuardResult;
}

export interface LumiResultFinalizerResult {
  text: string;
  blocked: boolean;
  reason?: string;
  /** Receipt-derived progress already adjudicated by this finalizer. */
  progress?: ReturnType<typeof import('./artifact_progress').artifactProgressFeedback>;
  notification?: {
    type: 'work_product_guard';
    level: 'warning';
    message: string;
  };
}
