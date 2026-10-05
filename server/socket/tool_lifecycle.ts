import type { ToolContext, ToolExecutionRecord } from '../tools/types';
import type { MediaArtifactReceipt } from './media_artifact_receipt';
import { isDirectDesktopTool } from './desktop_relay';

export interface ToolLifecyclePayload {
  correlationId: string;
  name: string;
  arguments: Record<string, any>;
  result?: string;
  error?: string;
  artifactReceipt?: MediaArtifactReceipt;
}

/** Observe every receipt; only the current turn may publish non-desktop lifecycle events. */
export function createToolLifecycleCallbacks(input: {
  emit: (payload: ToolLifecyclePayload) => unknown;
  correlationPrefix: string;
  formatResult: (result?: string) => string;
  isCurrent?: () => boolean;
  onStart?: ToolContext['onToolStart'];
  onRecord?: (record: ToolExecutionRecord) => void;
  artifactReceipt?: (record: ToolExecutionRecord) => MediaArtifactReceipt | undefined;
  includeFailedResult?: boolean;
}) {
  const canPublish = (name: string) => (!input.isCurrent || input.isCurrent()) && !isDirectDesktopTool(name);
  const correlationId = (id?: string) => id || `${input.correlationPrefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  return {
    onToolStart: (call: Parameters<NonNullable<ToolContext['onToolStart']>>[0]) => {
      input.onStart?.(call);
      if (!canPublish(call.name)) return;
      input.emit({ correlationId: correlationId(call.id), name: call.name, arguments: call.arguments });
    },
    onToolCall: (record: ToolExecutionRecord) => {
      input.onRecord?.(record);
      if (!record?.name || !canPublish(record.name)) return;
      input.emit({
        correlationId: correlationId(record.id), name: record.name, arguments: record.arguments,
        result: record.error && !input.includeFailedResult ? undefined : input.formatResult(record.result),
        error: record.error, artifactReceipt: input.artifactReceipt?.(record),
      });
    },
  };
}
