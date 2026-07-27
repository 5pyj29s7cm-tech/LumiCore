import type { ToolRegistry } from '../tools/registry';
import type { ToolContext, ToolExecutionRecord } from '../tools/types';
import { executeToolCall } from '../tools/execution_engine';
import type { NormalizedActionIntent } from './normalized_action_intent';

export type ForegroundMessagingAction = 'read' | 'send';

export interface ForegroundMessagingLifecycleEvent {
  phase: 'start' | 'finish';
  correlationId: string;
  name: 'wechat_read_recent_chat' | 'wechat_send_message';
  arguments: Record<string, any>;
  result?: string;
  error?: string;
}

export interface ForegroundMessagingExecutionResult {
  action: ForegroundMessagingAction;
  correlationId: string;
  toolName: ForegroundMessagingLifecycleEvent['name'];
  record: ToolExecutionRecord;
  parsed: Record<string, any>;
  verified: boolean;
}

function normalizeSlot(value: unknown): string {
  return String(value || '')
    .replace(/^[\s“”‘’「」『』"']+|[\s“”‘’「」『』"'，。！？!?、]+$/gu, '')
    .trim();
}

function validateSemanticBinding(
  action: ForegroundMessagingAction,
  intent: NormalizedActionIntent,
  args: Record<string, any>,
): string {
  if (action === 'read') {
    if (intent.kind !== 'messaging_read' || intent.sideEffectClass !== 'none') {
      return `Foreground messaging read rejected normalized intent '${intent.kind}/${intent.sideEffectClass}'.`;
    }
    const requestedTarget = normalizeSlot(intent.target);
    const executionTarget = normalizeSlot(args.contact);
    if (requestedTarget && requestedTarget !== executionTarget) {
      return 'Foreground messaging read target does not match the normalized sender.';
    }
    return '';
  }

  if (intent.kind !== 'messaging_send' || intent.sideEffectClass !== 'external_commit') {
    return `Foreground messaging send rejected normalized intent '${intent.kind}/${intent.sideEffectClass}'.`;
  }
  const requestedTarget = normalizeSlot(intent.target);
  const executionTarget = normalizeSlot(args.contact);
  const requestedPayload = normalizeSlot(intent.payload);
  const executionPayload = normalizeSlot(args.message || args.draft);
  if (!requestedTarget || requestedTarget !== executionTarget) {
    return 'Foreground messaging recipient does not match the immutable normalized target.';
  }
  if (!requestedPayload || requestedPayload !== executionPayload) {
    return 'Foreground messaging body does not match the immutable normalized payload.';
  }
  return '';
}

/**
 * Channel-independent deterministic entry for foreground messaging. Chat and
 * voice may present receipts differently, but semantic binding, permission,
 * confirmation, idempotency, execution and verification all pass here.
 */
export async function executeForegroundMessagingAction(input: {
  action: ForegroundMessagingAction;
  normalizedIntent: NormalizedActionIntent;
  arguments: Record<string, any>;
  registry: ToolRegistry;
  context: ToolContext;
  correlationId?: string;
  correlationPrefix?: string;
  onLifecycle?: (event: ForegroundMessagingLifecycleEvent) => void;
}): Promise<ForegroundMessagingExecutionResult> {
  const toolName = input.action === 'read'
    ? 'wechat_read_recent_chat'
    : 'wechat_send_message';
  const correlationId = input.correlationId
    || `${input.correlationPrefix || 'foreground-messaging'}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  try {
    input.onLifecycle?.({
      phase: 'start',
      correlationId,
      name: toolName,
      arguments: input.arguments,
    });
  } catch {
    // Observability callbacks cannot affect an execution outcome.
  }
  const record = await executeToolCall({
    registry: input.registry,
    id: correlationId,
    name: toolName,
    arguments: input.arguments,
    context: input.context,
    preflight: (_name, args) => {
      const reason = validateSemanticBinding(input.action, input.normalizedIntent, args);
      return reason
        ? { allowed: false, arguments: args, reason }
        : { allowed: true, arguments: args };
    },
  });
  let parsed: Record<string, any> = {};
  try {
    parsed = JSON.parse(record.result || '{}');
  } catch {
    parsed = {};
  }
  const verified = !record.error
    && record.terminalVerification?.status === 'verified'
    && (input.action === 'read'
      ? parsed.read === true
      : parsed.sent === true && parsed.verificationStatus === 'verified');
  try {
    input.onLifecycle?.({
      phase: 'finish',
      correlationId,
      name: toolName,
      arguments: input.arguments,
      result: record.result,
      error: record.error,
    });
  } catch {
    // Observability callbacks cannot affect an execution outcome.
  }
  return {
    action: input.action,
    correlationId,
    toolName,
    record,
    parsed,
    verified,
  };
}
