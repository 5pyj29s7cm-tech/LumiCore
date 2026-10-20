import { saveStoredDesktopExecutionPreference } from '../cognition/operation_mode_store';
import { broadcastPreferenceChange } from '../memory';
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
  const switchToExternalExecution = input.pending.safeArgs.switchToExternalExecution === true;
  const externalDesktopHandoff = switchToExternalExecution || input.pending.safeArgs.externalDesktopHandoff === true;
  const exactArgs = structuredClone(input.pending.exactArgs || {});
  const consumed = await consumePendingConfirmationDurably(input.userId, pendingId, toolName, exactArgs, input.scope);
  input.onReady?.();
  let handoffStarted = false;
  let handoffError = '';
  try {
    if (consumed && externalDesktopHandoff && !input.context?.isCancelled?.() && !input.context?.executionSignal?.aborted) {
      if (!input.context?.desktopRelay) handoffError = 'The desktop client is unavailable for the confirmed handoff.';
      if (!handoffError && switchToExternalExecution) {
        try {
          await saveStoredDesktopExecutionPreference(input.userId, 'external');
          broadcastPreferenceChange(input.userId, 'desktop_execution', { preference: 'external' }, { domain: input.context?.domain, orgId: input.context?.orgId });
        } catch { handoffError = 'External execution preference could not be saved; the action did not start.'; }
      }
      if (!handoffError && !input.context?.isCancelled?.() && !input.context?.executionSignal?.aborted) try {
        await input.context!.desktopRelay!('desktop_set_wallpaper_mode', { enabled: true, source: 'confirmed_action', timeoutMs: 600_000 });
        handoffStarted = true;
      } catch { handoffError = 'The confirmed external desktop handoff could not be established.'; }
    }
  return await executeToolCall({
    registry: input.registry, id: input.id, name: toolName, arguments: exactArgs,
    executionOrigin: 'confirmed_action_resume',
    context: { ...input.context, userId: input.userId, userConfirmed: true, desktopPresentationManaged: externalDesktopHandoff },
    preflight: () => !consumed
      ? { allowed: false, arguments: exactArgs, reason: 'The one-time confirmation expired before execution.' }
      : handoffError
        ? { allowed: false, arguments: exactArgs, reason: handoffError }
        : { allowed: true, arguments: exactArgs },
  });
  } finally {
    if (handoffStarted) await input.context!.desktopRelay!('desktop_set_wallpaper_mode', { enabled: false, source: 'confirmed_action' }).catch(() => undefined);
  }
}
