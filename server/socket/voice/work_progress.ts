import { CN_VOICE_WORK_MESSAGES } from "../../regions/messages/voice_fast_path_messages";
import { Socket } from "socket.io";
import { updateConversationActionFocus } from "../../conversation/manager";
import { type AudioSession } from "./session";
export function buildActiveVoiceWorkProgressReply(session: AudioSession, userText: string): string {
  const task = session.activeRoutingText.replace(/\s+/g, ' ').trim().slice(0, 32);
  const isEnglish = /[a-z]/i.test(userText) && !/[\u3400-\u9fff]/u.test(userText);
  const rawStep = session.activeWorkStep.replace(/\s+/g, ' ').trim().slice(0, 80);
  const toolStep = rawStep.match(/^(?:Running\s+)?([a-z][\w-]+?)(?:\s+(completed|failed))?$/i);
  const step = (() => {
    if (!toolStep) {
      if (!rawStep) return '';
      if (!isEnglish && !/[\u3400-\u9fff]/u.test(rawStep)) return CN_VOICE_WORK_MESSAGES.executingCurrentStep;
      return rawStep.slice(0, 36);
    }
    const toolName = toolStep[1].toLowerCase();
    const phase = toolStep[2]?.toLowerCase();
    const category = /cad|autocad|drawing/.test(toolName)
      ? ['the drawing', CN_VOICE_WORK_MESSAGES.drawingStep]
      : /browser|web/.test(toolName)
        ? ['the web step', CN_VOICE_WORK_MESSAGES.webStep]
        : /wechat|message|mail/.test(toolName)
          ? ['the message', CN_VOICE_WORK_MESSAGES.messageStep]
          : /knowledge|search|retrieve/.test(toolName)
            ? ['the research step', CN_VOICE_WORK_MESSAGES.researchStep]
            : /file|document|pdf|ppt|presentation|spreadsheet|excel/.test(toolName)
              ? ['the document step', CN_VOICE_WORK_MESSAGES.documentStep]
              : /desktop/.test(toolName)
                ? ['the desktop step', CN_VOICE_WORK_MESSAGES.desktopStep]
                : /client/.test(toolName)
                  ? ['the client check', CN_VOICE_WORK_MESSAGES.clientStep]
                  : ['the current step', CN_VOICE_WORK_MESSAGES.currentStep];
    if (isEnglish) {
      if (phase === 'completed') return `finishing ${category[0]}`;
      if (phase === 'failed') return `recovering from an issue in ${category[0]}`;
      return `working on ${category[0]}`;
    }
    if (phase === 'completed') return CN_VOICE_WORK_MESSAGES.completedStep(category[1]);
    if (phase === 'failed') return CN_VOICE_WORK_MESSAGES.failedStep(category[1]);
    return CN_VOICE_WORK_MESSAGES.runningStep(category[1]);
  })();
  if (isEnglish) {
    if (step) return `Still working on ${task || 'it'}; I'm ${step}.`;
    return `Still working on ${task || 'it'}; it hasn't stopped.`;
  }
  return step
    ? CN_VOICE_WORK_MESSAGES.progressWithStep(step)
    : CN_VOICE_WORK_MESSAGES.continuingTask(task);
}


export function stopVoiceWorkHeartbeat(session: AudioSession): void {
  if (!session.workHeartbeatTimer) return;
  clearInterval(session.workHeartbeatTimer);
  session.workHeartbeatTimer = null;
}


export function emitVoiceWorkProgress(
  socket: Socket,
  session: AudioSession,
  requestId: string,
  phase: string,
  text?: string,
  heartbeat = false,
): void {
  if (session.activeTurnRequestId !== requestId) return;
  if (!heartbeat && session.activeTaskId) {
    try {
      updateConversationActionFocus({
        taskId: session.activeTaskId,
        userId: session.userId,
        domain: session.domain,
        orgId: session.orgId,
        nextAction: session.activeWorkStep || text || phase,
        waitingFor: phase === 'waiting_confirmation' ? 'user_confirmation' : '',
      });
    } catch {}
  }
  socket.emit('audio:work_progress', {
    requestId,
    text: text || buildActiveVoiceWorkProgressReply(session, session.activeTurnText),
    phase,
    heartbeat,
    active: session.isProcessing && session.isBackgroundWork,
    at: new Date().toISOString(),
  });
}


export function startVoiceWorkHeartbeat(socket: Socket, session: AudioSession, requestId: string): void {
  stopVoiceWorkHeartbeat(session);
  session.workHeartbeatTimer = setInterval(() => {
    if (
      !session.isActive
      || !session.isProcessing
      || !session.isBackgroundWork
      || session.activeTurnRequestId !== requestId
      || session.activeWorkStatus === 'completed'
    ) {
      stopVoiceWorkHeartbeat(session);
      return;
    }
    emitVoiceWorkProgress(
      socket,
      session,
      requestId,
      session.activeWorkStatus,
      undefined,
      true,
    );
  }, 8_000);
}
