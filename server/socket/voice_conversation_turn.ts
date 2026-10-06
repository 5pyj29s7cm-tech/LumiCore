import type { Server, Socket } from "socket.io";
import type { AudioSession, VoiceInputTiming } from "./voice/session";
import type { LLMGetters as LlmGetters } from "../llm/dispatch";
import type { ConversationResourceLifetime } from "../cognition/conversation_execution";
import { logger } from "../../logger";
import { isTtsCancellationError } from "../tts/adapter";
import { CN_VOICE_WORK_MESSAGES } from "../regions/messages/voice_fast_path_messages";
import { prepareVoiceIdentityAndAdmission } from './voice/turn/prepare_voice_identity_and_admission';
import { prepareVoiceContextAndRouting } from './voice/turn/prepare_voice_context_and_routing';
import { prepareVoiceExecutionAndPrompt } from './voice/turn/prepare_voice_execution_and_prompt';
import { prepareVoiceReceiptsAndTools } from './voice/turn/prepare_voice_receipts_and_tools';
import { prepareVoiceSpeech } from './voice/turn/prepare_voice_speech';
import { prepareVoiceRelease } from './voice/turn/prepare_voice_release';
import { executeVoiceConfirmedAndDeterministicTurn } from './voice/turn/execute_voice_confirmed_and_deterministic_turn';
import { executeVoiceModeAndMessagingTurn } from './voice/turn/execute_voice_mode_and_messaging_turn';
import { executeVoiceModelTurn } from './voice/turn/execute_voice_model_turn';
import { finalizeVoiceModelTurn } from './voice/turn/finalize_voice_model_turn';

export { respondAlongsideActiveVoiceWork } from "./voice_side_response";

async function processAdmittedVoiceTurn(socket: Socket, session: AudioSession, userText: string, llmGetters: LlmGetters, sensoryFn: (uid: string) => any, io: Server, userReceivedAt = new Date().toISOString(), voiceAuthorized = false, inputTiming: VoiceInputTiming = {}, resources: ConversationResourceLifetime = {}): Promise<void> {
  const prepareVoiceIdentityAndAdmissionResult = await prepareVoiceIdentityAndAdmission(socket, session, userText, llmGetters, sensoryFn, io, userReceivedAt, voiceAuthorized, inputTiming, resources);
  if (prepareVoiceIdentityAndAdmissionResult.terminal) return;
  const prepareVoiceContextAndRoutingResult = await prepareVoiceContextAndRouting(prepareVoiceIdentityAndAdmissionResult.context);
  if (prepareVoiceContextAndRoutingResult.terminal) return;
  const prepareVoiceExecutionAndPromptResult = await prepareVoiceExecutionAndPrompt(prepareVoiceContextAndRoutingResult.context);
  if (prepareVoiceExecutionAndPromptResult.terminal) return;
  const prepareVoiceReceiptsAndToolsResult = await prepareVoiceReceiptsAndTools(prepareVoiceExecutionAndPromptResult.context);
  if (prepareVoiceReceiptsAndToolsResult.terminal) return;
  const prepareVoiceSpeechResult = await prepareVoiceSpeech(prepareVoiceReceiptsAndToolsResult.context);
  if (prepareVoiceSpeechResult.terminal) return;
  const prepareVoiceReleaseResult = await prepareVoiceRelease(prepareVoiceSpeechResult.context);
  if (prepareVoiceReleaseResult.terminal) return;
  const context = prepareVoiceReleaseResult.context;
  try {
  const executeVoiceConfirmedAndDeterministicTurnResult = await executeVoiceConfirmedAndDeterministicTurn(context);
  if (executeVoiceConfirmedAndDeterministicTurnResult.terminal) return;
  const executeVoiceModeAndMessagingTurnResult = await executeVoiceModeAndMessagingTurn(executeVoiceConfirmedAndDeterministicTurnResult.context);
  if (executeVoiceModeAndMessagingTurnResult.terminal) return;
  const executeVoiceModelTurnResult = await executeVoiceModelTurn(executeVoiceModeAndMessagingTurnResult.context);
  if (executeVoiceModelTurnResult.terminal) return;
  const finalizeVoiceModelTurnResult = await finalizeVoiceModelTurn(executeVoiceModelTurnResult.context);
  if (finalizeVoiceModelTurnResult.terminal) return;

  }  catch (err: any) {
    if (isTtsCancellationError(err, context.pipelineAbort.signal)) {
      logger.info('[Audio] Pipeline aborted (barge-in or stop)');
    } else {
      logger.error("[Audio Error]:", err);
      if (context.finalAgentResponseDelivered) {
        logger.warn('[Audio] Post-response persistence failed; suppressing a contradictory UI error');
      } else {
        const failureText = CN_VOICE_WORK_MESSAGES.processingFailed;
        await context.finishVoiceTerminal({
          text: failureText,
          source: 'voice_error',
          blocked: true,
          reason: 'voice_processing_failed',
          cognitiveIntent: 'voice_processing_failed',
          llmWasCalled: false,
          toolCalls: context.toolResults,
          speechText: failureText,
        });
      }
    }
  } finally {

    await context.releaseVoiceTurnResources('Voice model/tool pipeline reached its finally boundary.');
  }
}

export async function processVoiceInput(
  socket: Socket,
  session: AudioSession,
  userText: string,
  llmGetters: LlmGetters,
  sensoryFn: (uid: string) => any,
  io: Server,
  userReceivedAt = new Date().toISOString(),
  voiceAuthorized = false,
  inputTiming: VoiceInputTiming = {},
  resources: ConversationResourceLifetime = {},
): Promise<void> {
  return processAdmittedVoiceTurn(socket, session, userText, llmGetters, sensoryFn, io, userReceivedAt, voiceAuthorized, inputTiming, resources);
}
