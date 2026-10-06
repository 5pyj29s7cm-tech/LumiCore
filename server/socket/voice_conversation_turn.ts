import type { Server, Socket } from "socket.io";
import type { AudioSession, VoiceInputTiming, VoiceInputResources } from "./voice/session";
import type { LLMGetters as LlmGetters } from "../llm/dispatch";
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
import { prepareVoiceModelTurn } from './voice/turn/execute_voice_model_turn';
import { runLumiEntryTurn } from '../cognition/turn_execution';
import { finalizeVoiceModelTurn } from './voice/turn/finalize_voice_model_turn';

export { respondAlongsideActiveVoiceWork } from "./voice_side_response";

async function processAdmittedVoiceTurn(socket: Socket, session: AudioSession, userText: string, llmGetters: LlmGetters, sensoryFn: (uid: string) => any, io: Server, userReceivedAt = new Date().toISOString(), voiceAuthorized = false, inputTiming: VoiceInputTiming = {}, resources: VoiceInputResources = {}): Promise<void> {
  const prepareVoiceIdentityAndAdmissionResult = await prepareVoiceIdentityAndAdmission(socket, session, userText, llmGetters, sensoryFn, io, userReceivedAt, voiceAuthorized, inputTiming, resources);
  if (prepareVoiceIdentityAndAdmissionResult.terminal) return;
  const accepted = prepareVoiceIdentityAndAdmissionResult;
  const entry = accepted.entry!;
  let routingSetup: Extract<Awaited<ReturnType<typeof prepareVoiceContextAndRouting>>, { terminal: false }> | undefined;
  let releaseContext: NonNullable<Awaited<ReturnType<typeof prepareVoiceRelease>>['context']> | undefined;
  let modelContext: NonNullable<Awaited<ReturnType<typeof executeVoiceModeAndMessagingTurn>>['context']> | undefined;
  await runLumiEntryTurn<void>({
    entry: { source: 'voice', channel: 'voice', historyLimit: 0, failureText: 'The voice turn could not finish.', failureReason: 'voice_processing_failed' },
    identity: { userId: entry.session.userId, agentId: entry.conversationTurn.conversation.agentId,
      conversationId: entry.conversationTurn.conversation.id, requestId: entry.requestId, domain: entry.voiceScope.domain, orgId: entry.voiceScope.orgId },
    userText: entry.userText, persistence: 'preaccepted', authorization: entry.turnAuthorization, controller: entry.pipelineAbort,
    // Early preparation failures settle in runVoiceInputPipeline; prepared turns use their durable release gate.
    resource: { admission: entry.resources.admission, ownedByDurableRelease: true },
    planning: async () => {
      const identity = await accepted.resume!();
      if (identity.terminal === true) return { terminal: undefined };
      const routing = await prepareVoiceContextAndRouting(identity.context);
      routingSetup = routing;
      return routing.planning;
    },
    assemble: async execution => {
      const routing = await routingSetup!.resume(execution);
      if (routing.terminal === true) return { terminal: undefined };
      const prompt = await prepareVoiceExecutionAndPrompt(routing.context);
      if (prompt.terminal) return { terminal: undefined };
      const tools = await prepareVoiceReceiptsAndTools(prompt.context);
      if (tools.terminal) return { terminal: undefined };
      const speech = await prepareVoiceSpeech(tools.context);
      if (speech.terminal) return { terminal: undefined };
      const release = await prepareVoiceRelease(speech.context);
      if (release.terminal) return { terminal: undefined };
      releaseContext = release.context;
      const confirmed = await executeVoiceConfirmedAndDeterministicTurn(release.context);
      if (confirmed.terminal) return { terminal: undefined };
      const mode = await executeVoiceModeAndMessagingTurn(confirmed.context);
      if (mode.terminal) return { terminal: undefined };
      modelContext = mode.context;
      return prepareVoiceModelTurn(modelContext);
    },
    deliver: async result => { await finalizeVoiceModelTurn(modelContext!, result); },
    onFailure: async (err: any) => {
      if (!releaseContext) throw err;
      const context = releaseContext;
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
    },
    settle: async () => {
      if (releaseContext) await releaseContext.releaseVoiceTurnResources('Voice model/tool pipeline reached its finally boundary.');
    },
  });
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
  resources: VoiceInputResources = {},
): Promise<void> {
  return processAdmittedVoiceTurn(socket, session, userText, llmGetters, sensoryFn, io, userReceivedAt, voiceAuthorized, inputTiming, resources);
}
