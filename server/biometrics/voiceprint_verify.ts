import { getVoiceprints, touchVoiceprint } from './store';
import type { VoiceprintMatch, VoiceprintVerificationResult } from './types';
import { cosineEmbedding, extractSpeechBrainEmbedding, sanitizeEmbedding } from './voiceprint_provider';

export interface VoiceprintVerifyOptions {
  minFrames?: number;
  matchThreshold?: number;
}

export interface VoiceprintAudioInput {
  pcm16Base64?: string;
  sampleRate?: number;
}

export type VoiceprintVerifyResult = VoiceprintVerificationResult & {
  quality: number;
  frameCount: number;
  reason?: string;
  provider?: string;
  model?: string;
  fallbackReason?: string;
};

const COEFF_COUNT = 13;
const DEFAULT_MIN_FRAMES = 5;
const DEFAULT_MATCH_THRESHOLD = 0.68;
const SPEECHBRAIN_RAW_THRESHOLD = 0.25;

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function sanitizeFrames(value: unknown): number[][] {
  if (!Array.isArray(value)) return [];
  return value
    .map((frame) => Array.isArray(frame)
      ? frame.slice(0, COEFF_COUNT).map(Number)
      : [])
    .filter((frame) => frame.length === COEFF_COUNT && frame.every(Number.isFinite))
    .slice(-80);
}

function normalizedCepstral(frame: number[]): number[] {
  // Drop C0-like energy coefficient and z-normalize the cepstral shape.
  const values = frame.slice(1, COEFF_COUNT);
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length;
  const std = Math.sqrt(Math.max(variance, 1e-8));
  return values.map(value => (value - mean) / std);
}

function centroid(frames: number[][]): number[] {
  const out = new Array(COEFF_COUNT).fill(0);
  for (const frame of frames) {
    for (let i = 0; i < COEFF_COUNT; i++) out[i] += frame[i];
  }
  for (let i = 0; i < COEFF_COUNT; i++) out[i] /= Math.max(1, frames.length);
  return out;
}

function average(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function topKAverage(values: number[], ratio = 0.45): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => b - a);
  const take = Math.max(1, Math.ceil(sorted.length * ratio));
  return average(sorted.slice(0, take));
}

function stabilityScore(frames: number[][]): number {
  if (frames.length < 3) return 0.35;
  const center = normalizedCepstral(centroid(frames));
  const sims = frames.map(frame => clamp01((cosineEmbedding(normalizedCepstral(frame), center) + 1) / 2));
  return clamp01(average(sims));
}

function compareToTemplate(probeFrames: number[][], templateFrames: number[][]): number {
  if (probeFrames.length === 0 || templateFrames.length === 0) return 0;

  const probeCenter = normalizedCepstral(centroid(probeFrames));
  const templateCenter = normalizedCepstral(centroid(templateFrames));
  const centroidScore = clamp01((cosineEmbedding(probeCenter, templateCenter) + 1) / 2);

  const normalizedTemplateFrames = templateFrames.map(normalizedCepstral);
  const frameScores = probeFrames.map((probe) => {
    const normalizedProbe = normalizedCepstral(probe);
    let best = 0;
    for (const tplFrame of normalizedTemplateFrames) {
      best = Math.max(best, clamp01((cosineEmbedding(normalizedProbe, tplFrame) + 1) / 2));
    }
    return best;
  });

  const frameScore = topKAverage(frameScores, 0.55);
  const stability = stabilityScore(probeFrames);
  const lengthScore = clamp01(probeFrames.length / 12);

  return clamp01((centroidScore * 0.48) + (frameScore * 0.34) + (stability * 0.12) + (lengthScore * 0.06));
}

function thresholdLabel(confidence: number): VoiceprintVerificationResult['threshold'] {
  if (confidence >= 0.82) return 'high';
  if (confidence >= DEFAULT_MATCH_THRESHOLD) return 'medium';
  if (confidence >= 0.52) return 'low';
  return 'reject';
}

function calibratedSpeechBrainConfidence(rawScore: number): number {
  // SpeechBrain's ECAPA verification uses raw cosine threshold around 0.25.
  // Keep the UI/server gate on the existing 0..1 confidence scale.
  return clamp01((rawScore + 0.15) / 0.60);
}

function compareSpeechBrainEmbedding(
  uid: string,
  probeEmbedding: number[],
  options: VoiceprintVerifyOptions,
  metadata: { provider?: string; model?: string; durationSec?: number },
): VoiceprintVerifyResult | null {
  const enrolled = getVoiceprints(uid);
  const matchThreshold = options.matchThreshold ?? DEFAULT_MATCH_THRESHOLD;
  const scoredMatches = enrolled
    .map((template): (VoiceprintMatch & { rawScore: number }) | null => {
      const embedding = sanitizeEmbedding(template.embedding);
      if (embedding.length === 0) return null;
      const rawScore = cosineEmbedding(probeEmbedding, embedding);
      return {
        voiceprintId: template.voiceprintId,
        uid: template.uid,
        label: template.label,
        confidence: calibratedSpeechBrainConfidence(rawScore),
        rawScore,
      };
    })
    .filter((match): match is VoiceprintMatch & { rawScore: number } => Boolean(match))
    .sort((a, b) => b.confidence - a.confidence);

  if (scoredMatches.length === 0) return null;

  const topMatch = scoredMatches[0];
  const confidence = topMatch ? Math.round(topMatch.confidence * 1000) / 1000 : 0;
  const quality = clamp01((metadata.durationSec || 0) / 1.2);
  const matched = Boolean(
    topMatch &&
    confidence >= matchThreshold &&
    topMatch.rawScore >= SPEECHBRAIN_RAW_THRESHOLD,
  );

  if (matched && topMatch) touchVoiceprint(uid, topMatch.voiceprintId);
  const publicTopMatch = topMatch
    ? {
        voiceprintId: topMatch.voiceprintId,
        uid: topMatch.uid,
        label: topMatch.label,
        confidence,
      }
    : undefined;

  return {
    matched,
    isOwner: matched,
    isStranger: !matched,
    topMatch: publicTopMatch,
    allMatches: scoredMatches.map(({ rawScore: _rawScore, ...match }) => ({
      ...match,
      confidence: Math.round(match.confidence * 1000) / 1000,
    })),
    threshold: thresholdLabel(confidence),
    source: 'speechbrain',
    quality: Math.round(quality * 1000) / 1000,
    frameCount: 0,
    provider: metadata.provider,
    model: metadata.model,
    reason: matched ? undefined : 'below_speechbrain_threshold',
  };
}

export function verifyVoiceprintFrames(
  uid: string,
  rawFrames: unknown,
  options: VoiceprintVerifyOptions = {},
): VoiceprintVerifyResult {
  const minFrames = options.minFrames ?? DEFAULT_MIN_FRAMES;
  const matchThreshold = options.matchThreshold ?? DEFAULT_MATCH_THRESHOLD;
  const probeFrames = sanitizeFrames(rawFrames);
  const enrolled = getVoiceprints(uid);

  if (enrolled.length === 0) {
    return {
      matched: false,
      isOwner: false,
      isStranger: false,
      allMatches: [],
      threshold: 'reject',
      source: 'local',
      quality: 0,
      frameCount: probeFrames.length,
      reason: 'no_voiceprints',
    };
  }

  if (probeFrames.length < minFrames) {
    return {
      matched: false,
      isOwner: false,
      isStranger: false,
      allMatches: [],
      threshold: 'reject',
      source: 'local',
      quality: 0,
      frameCount: probeFrames.length,
      reason: 'not_enough_speech',
    };
  }

  const quality = stabilityScore(probeFrames);
  const allMatches: VoiceprintMatch[] = enrolled
    .map((template) => {
      const templateFrames = sanitizeFrames(template.mfccFeatures);
      return {
        voiceprintId: template.voiceprintId,
        uid: template.uid,
        label: template.label,
        confidence: compareToTemplate(probeFrames, templateFrames),
      };
    })
    .sort((a, b) => b.confidence - a.confidence);

  const topMatch = allMatches[0];
  const confidence = topMatch ? Math.round(topMatch.confidence * 1000) / 1000 : 0;
  const matched = Boolean(topMatch && confidence >= matchThreshold && quality >= 0.50);

  if (matched && topMatch) touchVoiceprint(uid, topMatch.voiceprintId);

  return {
    matched,
    isOwner: matched,
    isStranger: !matched,
    topMatch: topMatch ? { ...topMatch, confidence } : undefined,
    allMatches: allMatches.map(match => ({ ...match, confidence: Math.round(match.confidence * 1000) / 1000 })),
    threshold: thresholdLabel(confidence),
    source: 'local',
    quality: Math.round(quality * 1000) / 1000,
    frameCount: probeFrames.length,
    reason: matched ? undefined : (quality < 0.50 ? 'unstable_or_noisy_speech' : 'below_threshold'),
  };
}

export async function verifyVoiceprintAudio(
  uid: string,
  rawFrames: unknown,
  audio: VoiceprintAudioInput = {},
  options: VoiceprintVerifyOptions = {},
): Promise<VoiceprintVerifyResult> {
  const probeFrames = sanitizeFrames(rawFrames);
  const embeddingResult = await extractSpeechBrainEmbedding({
    pcm16Base64: audio.pcm16Base64,
    sampleRate: audio.sampleRate,
  });

  if (embeddingResult.ok && embeddingResult.embedding) {
    const speechBrainResult = compareSpeechBrainEmbedding(uid, embeddingResult.embedding, options, {
      provider: embeddingResult.provider,
      model: embeddingResult.model,
      durationSec: embeddingResult.durationSec,
    });
    if (speechBrainResult) {
      return { ...speechBrainResult, frameCount: probeFrames.length };
    }
    const fallback = verifyVoiceprintFrames(uid, rawFrames, options);
    return { ...fallback, fallbackReason: 'no_speechbrain_templates' };
  }

  const fallback = verifyVoiceprintFrames(uid, rawFrames, options);
  return { ...fallback, fallbackReason: embeddingResult.reason || 'speechbrain_unavailable' };
}
