import { useVoiceSessionState } from './voice_call/useVoiceSessionState';
import { useVoiceCaptureRuntime } from './voice_call/useVoiceCaptureRuntime';
import { useVoiceSocketEvents } from './voice_call/useVoiceSocketEvents';
import { useVoiceCallControls } from './voice_call/useVoiceCallControls';

export type { CallState } from './voice_call/contracts';
export type { VoiceTranscriptMeta } from './voice_call/contracts';
export { LUMI_VOICE_TRANSCRIPT_EVENT } from './voice_call/protocol';
export type { VoiceTranscriptEventDetail } from './voice_call/contracts';
export type { VoiceStartPayload } from './voice_call/contracts';
export type { VoiceSwitchPayload } from './voice_call/contracts';
export type { VoiceSwitchTransition } from './voice_call/contracts';
export { normalizeSelectedVoiceId } from './voice_call/protocol';
export { prepareVoiceSwitch } from './voice_call/protocol';
export { normalizeVoiceAudioBuffer } from './voice_call/protocol';
export { shouldAcceptVoiceStatus } from './voice_call/protocol';
export { waitForVoiceSocket } from './voice_call/protocol';

export function useVoiceCall(props: Parameters<typeof useVoiceSessionState>[0]) {
  const state0 = useVoiceSessionState(props);
  const state1 = useVoiceCaptureRuntime(state0);
  const state2 = useVoiceSocketEvents(state1);
  return useVoiceCallControls(state2);
}
