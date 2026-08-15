export type TTSProvider = 'local-cosyvoice' | 'gptsovits' | 'cosyvoice' | 'ark';

export interface TTSConfig {
  provider: TTSProvider;
  voiceId: string;
  model?: string;
  stability?: number;
  similarityBoost?: number;
  signal?: AbortSignal;
  /** Retry the same utterance through the next healthy provider when this one fails. */
  allowFallback?: boolean;
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
  /** Existing prepaid Doubao speaker ID. Omit to create a postpaid custom speaker. */
  speakerId?: string;
  /** Stable custom speaker ID used by the Doubao postpaid workflow. */
  customSpeakerId?: string;
  language?: number;
  sampleText?: string;
  demoText?: string;
  enableAudioDenoise?: boolean;
  disableVolumeNormalization?: boolean;
}

export type VoiceCloneStatus = 'not_found' | 'training' | 'ready' | 'failed';

export interface VoiceCloneResult {
  voiceId: string;
  status: VoiceCloneStatus;
  model?: string;
  demoAudio?: string;
  availableTrainingTimes?: number;
  createdAt?: number;
  message?: string;
  billingMode?: 'prepaid' | 'postpaid';
}

export interface VoiceListItem {
  voiceId: string;
  name: string;
  category: 'cloned' | 'premade';
  language?: string;
  model?: string;
}
