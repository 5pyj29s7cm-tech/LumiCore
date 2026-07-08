export type TTSProvider = 'local-cosyvoice' | 'gptsovits' | 'cosyvoice' | 'ark';

export interface TTSConfig {
  provider: TTSProvider;
  voiceId: string;
  model?: string;
  stability?: number;
  similarityBoost?: number;
  signal?: AbortSignal;
  /** Speech rate 0.5–2.0, default 1.0 (CosyVoice only) */
  speechRate?: number;
  /** Pitch shift 0.5–2.0, default 1.0 (CosyVoice only) */
  pitch?: number;
  /** Volume 0.1–2.0, default 1.0 (CosyVoice only) */
  volume?: number;
}

export interface TTSResult {
  audioBuffer: Buffer;
  format: string;
}

export interface VoiceCloneRequest {
  sampleUrls: string[];
  name: string;
}

export interface VoiceListItem {
  voiceId: string;
  name: string;
  category: 'cloned' | 'premade';
  language?: string;
  model?: string;
}
