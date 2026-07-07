export type STTProvider = 'whisper' | 'qwen' | 'ark' | 'local-whisper';

export interface STTConfig {
  provider: STTProvider;
  language?: string;
  interimResults?: boolean;
}

export interface STTResult {
  text: string;
  isFinal: boolean;
  /** True when the streaming provider reports that the user has finished speaking. */
  speechFinal?: boolean;
  sentiment?: {
    sentiment: 'positive' | 'negative' | 'neutral';
    sentiment_score: number;
  };
}
