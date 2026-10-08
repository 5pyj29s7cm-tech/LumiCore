import { finalizeLumiResponse } from './result_finalizer';
import { shouldBlockForDesktopControlPause } from './desktop_control_pause';
import { formatDesktopControlPausePresentation } from "../regions/messages/desktop_control_messages";
import { formatPendingConfirmationRequest, type PendingToolConfirmation } from '../tools/pending_confirmation';
import type { ToolExecutionRecord } from '../tools/types';

type FinalizerInput = Parameters<typeof finalizeLumiResponse>[0];

/** One decision for normal output and recovery: confirmation, evidence, then physical-input pause. */
export function createTurnResponseFinalizer(input: Pick<FinalizerInput, 'taskText' | 'flow' | 'taskId' | 'requestId'> & {
  pendingConfirmation: () => PendingToolConfirmation | null;
  controlPauseReason: () => string | null;
  pauseTaskText?: string;
}) {
  const { pendingConfirmation, controlPauseReason, pauseTaskText, ...context } = input;
  const isDesktopPaused = (toolRecords: ToolExecutionRecord[]) => shouldBlockForDesktopControlPause({
    pauseReason: controlPauseReason(),
    waitingForConfirmation: Boolean(pendingConfirmation()),
    taskText: input.flow?.routeText || input.taskText,
    acceptedActionContract: input.flow?.acceptedActionContract,
    acceptedTaskTarget: input.flow?.acceptedTaskTarget,
    requestId: input.requestId, taskId: input.taskId,
    toolRecords,
  });
  return {
    isDesktopPaused,
    confirmationRequestText: () => {
      const pending = input.pendingConfirmation();
      return pending ? formatPendingConfirmationRequest(pending) : undefined;
    },
    finalize: (candidate: Pick<FinalizerInput, 'responseText' | 'completionGuard' | 'toolRecords' | 'source'>): ReturnType<typeof finalizeLumiResponse> => {
      const pending = input.pendingConfirmation();
      const result = pending
        ? { text: formatPendingConfirmationRequest(pending), blocked: false, reason: 'waiting_confirmation', notification: undefined }
        : finalizeLumiResponse({ ...context, ...candidate });
      if (!isDesktopPaused(candidate.toolRecords || [])) return result;
      const pause = formatDesktopControlPausePresentation(pauseTaskText ?? input.taskText);
      return { ...result, text: pause.text, blocked: true, reason: pause.reason };
    },
  };
}
