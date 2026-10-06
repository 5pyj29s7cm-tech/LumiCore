import { consumePendingConfirmationDurably, type PendingToolConfirmation, type PendingConfirmationScope } from './pending_confirmation';
import { executeToolCall, type ExecuteToolCallInput } from './execution_engine';

export interface ConfirmedToolStepInput extends Pick<ExecuteToolCallInput, 'registry' | 'id' | 'context'> {
  userId: string;
  pending: PendingToolConfirmation;
  scope?: PendingConfirmationScope;
  /** Transport progress only; called after the durable grant is consumed. */
  onReady?: () => void;
}

/** Consume one exact durable grant, then execute its owned arguments once. */
export async function executeConfirmedToolStep(input: ConfirmedToolStepInput) {
  if (input.context?.userId && input.context.userId !== input.userId) throw new Error('Confirmed execution owner does not match its grant');
  const { id: pendingId, toolName } = input.pending;
  const exactArgs = structuredClone(input.pending.exactArgs || {});
  const consumed = await consumePendingConfirmationDurably(input.userId, pendingId, toolName, exactArgs, input.scope);
  input.onReady?.();
  return executeToolCall({
    registry: input.registry, id: input.id, name: toolName, arguments: exactArgs,
    executionOrigin: 'confirmed_action_resume',
    context: { ...input.context, userId: input.userId, userConfirmed: true },
    preflight: () => consumed
      ? { allowed: true, arguments: exactArgs }
      : { allowed: false, arguments: exactArgs, reason: 'The one-time confirmation expired before execution.' },
  });
}
