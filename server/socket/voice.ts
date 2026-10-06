import type { Server, Socket } from "socket.io";
import type { LLMGetters as LlmGetters } from "../llm/dispatch";
import { registerMemoryAvatarVoiceHandlers } from "./memory_avatar_voice";
import { createVoiceConnectionRuntime } from './voice/connection/connection';
import type { StandardVoiceStartRequest } from './voice/connection/start';
import { handleStandardVoiceStart } from './voice/connection/start';
import { registerVoiceCaptureAndControl } from './voice/connection/capture_control';
import { registerVoiceProactiveOutput } from './voice/connection/proactive';
import { registerVoiceConnectionCleanup } from './voice/connection/cleanup';

export { type VoiceSwitchRequest, type VoiceSwitchSession, clearVoiceSessionTtsSelection, type VoiceStartAsyncFence, resolveVoiceStartAsyncFence, type VoiceSwitchResolution, applyVoiceSwitchRequest, type ProviderVoiceResolution, type LockedVoiceTurnTtsRoute, lockVoiceTurnTtsRoute, canFallbackVoiceTurnTtsRoute, chooseVoiceForProvider } from "./voice/selection";
export { addEchoText, isEchoText, isPureInterruptCommand, isVoiceCallEndCommand, isEchoedImmediateVoiceControl } from "./voice/echo";
export { type VoiceprintUtteranceDecision, isVoiceprintUtteranceAccepted } from "./voice/voiceprint";
export { normalizeVoiceHistory, normalizeVoiceHistoryRecord } from './voice_history';
export type {
  ForegroundRequestIdentity as VoiceForegroundRequestIdentity,
  ForegroundRequestReleaseResult as VoiceForegroundRequestReleaseResult,
} from '../conversation/manager';
export { convergeVoiceForegroundRequestBeforeRelease, isTtsPlaying, quiesceActiveVoiceTransport, reservePriorityVoiceHandoff } from "./voice_transport_runtime";

export function registerVoiceHandlers(socket: Socket, llmGetters: LlmGetters, sensoryFn: (uid: string) => any, getUserId: (s: Socket) => string, io: Server) {
  const runtime = createVoiceConnectionRuntime(socket, llmGetters, sensoryFn, getUserId, io);

  registerMemoryAvatarVoiceHandlers(runtime.socket, runtime.llmGetters, runtime.getUserId, runtime.callAdmission);
  runtime.socket.on("audio:start", (data: StandardVoiceStartRequest) => handleStandardVoiceStart(runtime, data));
  registerVoiceCaptureAndControl(runtime);
  registerVoiceProactiveOutput(runtime);
  registerVoiceConnectionCleanup(runtime);
}
