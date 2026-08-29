export type STTProvider = 'whisper' | 'qwen' | 'ark' | 'local-whisper' | 'relay';

export interface STTConfig {
  provider: STTProvider;
  /** Provider model identifier (used by OpenAI-compatible relay adapters). */
  model?: string;
  language?: string;
  interimResults?: boolean;
}

export interface STTSegment {
  text: string;
  beginMs?: number;
  endMs?: number;
  speakerId?: number | null;
  speakerLabel?: string | null;
  channelId?: number;
}

export interface STTResult {
  text: string;
  isFinal: boolean;
  model?: string;
  segments?: STTSegment[];
  speakerCount?: number;
  taskId?: string;
  /** True when the streaming provider reports that the user has finished speaking. */
  speechFinal?: boolean;
  /** True when the streaming provider reports the start of a new utterance. */
  speechStarted?: boolean;
  sentiment?: {
    sentiment: 'positive' | 'negative' | 'neutral';
    sentiment_score: number;
  };
}

/** Provider-neutral contract used by realtime voice sessions. */
export interface StreamingSTTSession {
  sendAudio(chunk: Buffer): void;
  end(): void;
  /** Flush the current utterance without closing a provider session, when supported. */
  flush?(): void;
  updateEndpointing?(silenceDurationMs: number): void;
  onResult(callback: (result: STTResult) => void): void;
  onError(callback: (err: Error) => void): void;
}
