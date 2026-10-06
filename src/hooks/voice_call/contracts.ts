

export type CallState = 'idle' | 'connecting' | 'listening' | 'thinking' | 'speaking' | 'queued' | 'passive';

export interface VoiceTranscriptMeta {
  requestId?: string;
  speakerLabel?: string | null;
  speakerConfidence?: number;
  speakerSource?: string;
  speakerMatched?: boolean;
}

export interface VoiceTranscriptEventDetail extends VoiceTranscriptMeta {
  text: string;
  isFinal: boolean;
  source: 'confirm' | 'transcript';
}

export interface UseVoiceCallOptions {
  socket: any;
  onTranscript?: (text: string, isFinal: boolean, meta?: VoiceTranscriptMeta) => void;
  onResponse?: (text: string, meta?: { requestId?: string }) => void;
  /** Private personas do not feed the main Lumi perception/learning bus. */
  privateCapture?: boolean;
  canSendMicAudio?: () => boolean;
  /** Keep a compatibility hook mounted without owning sockets or microphone state. */
  disabled?: boolean;
  /** Only the signed-in main desktop owns unsolicited speech. */
  proactive?: { userId: string; domain: 'personal' | 'work'; orgId?: string; voiceId?: string; outputMuted?: boolean };
}

export interface StartCallOptions {
  transcriptionOnly?: boolean;
  meetingId?: string;
  conversationId?: string;
  domain?: 'personal' | 'work';
  orgId?: string;
}

export interface EndCallOptions {
  refineTranscript?: boolean;
  preserveMeeting?: boolean;
  refinementId?: string;
}

export interface VoiceStartPayload {
  voiceId?: string;
  personalityId: string;
  agentId?: string;
  transcriptionOnly: boolean;
  meetingId?: string;
  conversationId?: string;
  domain: 'personal' | 'work';
  orgId?: string;
  sessionId: string;
  /** Declares the browser capture path; the server accepts it as physical only
   * when the socket is proof-bound to the registered Tauri client and PCM
   * chunks are observed before the STT final. */
  audioInputKind: 'physical_microphone';
  captureSessionId: string;
}

export interface VoiceSwitchPayload {
  voiceId: string;
  sessionId: string;
}

export interface VoiceSwitchTransition {
  nextPayload: VoiceStartPayload;
  event: VoiceSwitchPayload | null;
}

export interface VoiceAudioResponse {
  buffer: ArrayBuffer;
  format?: string;
  volumeGain?: number;
  requestId?: string;
  lane?: string;
  sessionId?: string;
  /** Client-local timing and preparation, never trusted from socket metadata. */
  receivedAt?: number;
  preparedAudio?: {
    context: AudioContext;
    startedAt: number;
    finishedAt?: number;
    promise: Promise<{ decoded?: AudioBuffer; error?: unknown }>;
  };
}
