export type STTProvider = 'whisper' | 'qwen' | 'ark' | 'local-whisper';

export interface STTConfig {
  provider: STTProvider;
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
  sentiment?: {
    sentiment: 'positive' | 'negative' | 'neutral';
    sentiment_score: number;
  };
}
