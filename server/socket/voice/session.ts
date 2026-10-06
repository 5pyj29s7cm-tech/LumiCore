import { createResilientStreamingSession } from "../../stt/adapter";
import { captureChatAuthorization } from "../chat_authorization";
import { type ForegroundRequestIdentity as VoiceForegroundRequestIdentity } from "../../conversation/manager";
import { type VoiceExecutionReceiptCollector } from "../voice_execution_receipts";
import { type PendingInterruptedVoiceTurn } from "../voice_turn_state";
import { type MeetingCapture } from "../meeting_recordings";
import { type VoiceCaptureProvenanceState, type VoiceTurnProvenance, createVoiceCaptureProvenance } from "../voice_provenance";
import { Socket } from "socket.io";
import { scopedEmotionalStateKey } from "../scope";

export interface AudioSession {
  sttSession: ReturnType<typeof createResilientStreamingSession> | null;
  isActive: boolean;
  ttsAbortController: AbortController | null;
  currentVoiceId: string | null;
  voiceSwitchGeneration: number;
  /** Call lifecycle ownership, independent of an in-call voice selection. */
  callControlGeneration: number;
  voiceTurnGeneration: number;
  personalityId: string;
  userId: string;
  agentId: string;
  /** Transcript selected by this call; independent of the current active chat. */
  conversationId?: string;
  domain: 'personal' | 'work';
  orgId: string;
  authorization?: ReturnType<typeof captureChatAuthorization>;
  stopAuthorizationWatch?: () => void;
  cancelAuthorizationTurn?: (requestId: string) => Promise<void>;
  accumulatedText: string;
  /** TTS is actively playing audio — user can barge-in */
  isSpeaking: boolean;
  /** Tool iteration loop is running — new input is queued, not dropped */
  isProcessing: boolean;
  /** AbortController for the full LLM+tool pipeline — aborted on barge-in */
  pipelineAbortController: AbortController | null;
  /** Independent conversational response while the work pipeline keeps running. */
  sidecarAbortController: AbortController | null;
  sidecarGeneration: number;
  sidecarHistory: Array<{
    userText: string;
    responseText: string;
    userReceivedAt: string;
    responseAt: string;
    cognitiveIntent: string;
    llmWasCalled: boolean;
    persist: boolean;
  }>;
  /** User-visible text for the pipeline that currently owns the session. */
  activeTurnText: string;
  /** Stable identity for the voice turn that currently owns agent events. */
  activeTurnRequestId: string | null;
  /** Durable conversation task lease owned by the active execution request. */
  activeTaskConversationId: string | null;
  activeTaskRequestId: string | null;
  activeTaskId: string | null;
  /** Immutable durable task/request fence owned by this voice executor. */
  activeForegroundRequestIdentity: VoiceForegroundRequestIdentity | null;
  /** Canonical evidence belongs to the captured request, not the next voice turn. */
  activeExecutionReceipts?: VoiceExecutionReceiptCollector;
  /** Action text used for routing, including a just-in-time correction when applicable. */
  activeRoutingText: string;
  /** Last action interrupted by real user speech; consumed only by an explicit correction. */
  pendingInterruptedTurn: PendingInterruptedVoiceTurn | null;
  /** Independent action requests accepted while another voice work lane is active. */
  inputQueue: Array<{
    text: string;
    queuedAt: string;
    voiceAuthorized: boolean;
    inputTiming: VoiceInputTiming;
  }>;
  /** True when background agent is executing tools (barge-in requires wake word) */
  isBackgroundWork: boolean;
  activeWorkStatus: 'idle' | 'planning' | 'executing' | 'waiting_confirmation' | 'completed';
  activeWorkStep: string;
  activeWorkToolCalls: number;
  /** Server-owned liveness for a real work lease; UI timers may observe but never cancel it. */
  workHeartbeatTimer: ReturnType<typeof setInterval> | null;
  /** Incremented on each new command — only latest generation gets TTS output */
  bgGeneration: number;
  /** Timestamp of last audio chunk for STT latency measurement */
  lastChunkTime: number;
  /** Provider endpoint timestamp for the current utterance. */
  lastSpeechEndedAt: number;
  lastSpeechStartedAt: number;
  endpointSilenceMs: number;
  /** Timer to auto-close STT session after prolonged silence (5min) */
  silenceTimer: ReturnType<typeof setTimeout> | null;
  /** Tracked TTS decay timers — cleared on stop/disconnect to prevent post-session mutations */
  ttsDecayTimers: ReturnType<typeof setTimeout>[];
  /** Client-confirmed playback window; synthesis can finish before speakers do. */
  ttsPlaybackUntil: number;
  /** Barge-in confirmation delay timer — cleared on stop/disconnect */
  bargeinTimer: ReturnType<typeof setTimeout> | null;
  /** Voiceprint verification: true when owner's voice is recognized */
  voiceprintMatched: boolean;
  voiceprintConfidence: number;
  voiceprintSpeakerLabel: string | null;
  voiceprintSource: string;
  voiceprintRequired: boolean;
  voiceprintLastAt: number;
  /** Owner match accumulated for the current STT utterance. */
  voiceprintUtteranceEpoch: number;
  utteranceVoiceprintDecided: boolean;
  utteranceVoiceprintMatched: boolean;
  utteranceVoiceprintConfidence: number;
  utteranceVoiceprintQuality: number;
  utteranceVoiceprintFrameCount: number;
  utteranceVoiceprintSpeakerLabel: string | null;
  utteranceVoiceprintSource: string;
  utteranceVoiceprintLastAt: number;
  /** Meeting mode: STT only, no LLM/TTS/tool processing. */
  transcriptionOnly: boolean;
  /** Meeting mode raw PCM recording for high-accuracy final transcription. */
  meetingPcmPath: string | null;
  meetingId?: string;
  meetingCapture?: MeetingCapture;
  meetingPcmBytes: number;
  meetingStartedAt: number;
  sessionId: string;
  /** Server-owned native microphone/STT provenance for this call. */
  voiceCaptureProvenance: VoiceCaptureProvenanceState;
  activeTurnProvenance: VoiceTurnProvenance | null;
  /** Last command admitted to the execution lane; deduplicates repeated STT finals. */
  lastAcceptedCommandKey: string;
  lastAcceptedCommandAt: number;
  /** Audio-chunk watermark for the accepted final; repeated provider finals
   * without new microphone input must not start another turn. */
  lastAcceptedCommandChunkAt: number;
  /** Requests whose remaining speech was stopped while their work kept running. */
  suppressedSpeechRequestIds: Set<string>;
}


export interface VoiceInputTiming {
  speechEndedAt?: number;
  asrFinalAt?: number;
  sttProvider?: string;
  /** Monotonic server-observed PCM watermark captured with this STT final. */
  captureChunkSequence?: number;
}


export function getAudioSession(socket: Socket): AudioSession {
  if (!socket.data.audioSession) {
    socket.data.audioSession = {
      sttSession: null,
      isActive: false,
      ttsAbortController: null,
      currentVoiceId: null,
      voiceSwitchGeneration: 0,
      callControlGeneration: 0,
      voiceTurnGeneration: 0,
      personalityId: 'lumi',
      accumulatedText: '',
      isSpeaking: false,
      isProcessing: false,
      isBackgroundWork: false,
      activeWorkStatus: 'idle',
      activeWorkStep: '',
      activeWorkToolCalls: 0,
      workHeartbeatTimer: null,
      bgGeneration: 0,
      pipelineAbortController: null,
      sidecarAbortController: null,
      sidecarGeneration: 0,
      sidecarHistory: [],
      activeTurnText: '',
      activeTurnRequestId: null,
      activeTaskConversationId: null,
      activeTaskRequestId: null,
      activeTaskId: null,
      activeForegroundRequestIdentity: null,
      activeRoutingText: '',
      pendingInterruptedTurn: null,
      inputQueue: [],
      lastChunkTime: 0,
      lastSpeechEndedAt: 0,
      lastSpeechStartedAt: 0,
      endpointSilenceMs: 850,
      silenceTimer: null,
      ttsDecayTimers: [],
      ttsPlaybackUntil: 0,
      bargeinTimer: null,
      userId: '',
      agentId: 'lumi',
      domain: 'personal',
      orgId: '',
      voiceprintMatched: true,  // default: allow (no voiceprints enrolled yet)
      voiceprintConfidence: 0,
      voiceprintSpeakerLabel: null,
      voiceprintSource: '',
      voiceprintRequired: false,
      voiceprintLastAt: 0,
      voiceprintUtteranceEpoch: 0,
      utteranceVoiceprintDecided: false,
      utteranceVoiceprintMatched: false,
      utteranceVoiceprintConfidence: 0,
      utteranceVoiceprintQuality: 0,
      utteranceVoiceprintFrameCount: 0,
      utteranceVoiceprintSpeakerLabel: null,
      utteranceVoiceprintSource: '',
      utteranceVoiceprintLastAt: 0,
      transcriptionOnly: false,
      meetingPcmPath: null,
      meetingPcmBytes: 0,
      meetingStartedAt: 0,
      sessionId: '',
      voiceCaptureProvenance: createVoiceCaptureProvenance({}),
      activeTurnProvenance: null,
      lastAcceptedCommandKey: '',
      lastAcceptedCommandAt: 0,
      lastAcceptedCommandChunkAt: 0,
      suppressedSpeechRequestIds: new Set<string>(),
    };
  }
  return socket.data.audioSession as AudioSession;
}


export function getVoiceStateKey(session: AudioSession): string {
  return scopedEmotionalStateKey(session.userId, { domain: session.domain, orgId: session.orgId });
}


export function normalizeVoiceSessionId(value: unknown): string {
  const normalized = String(value || '').trim().replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 80);
  return normalized || `${Date.now()}_${Math.random().toString(36).slice(2)}`;
}
