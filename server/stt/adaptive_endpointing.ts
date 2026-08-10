export interface AdaptiveEndpointInput {
  transcript: string;
  speechDurationMs?: number;
  previousSilenceMs?: number;
}

const MIN_ENDPOINT_MS = 650;
const MAX_ENDPOINT_MS = 1_100;
const DEFAULT_ENDPOINT_MS = 850;

export function clampEndpointSilenceMs(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_ENDPOINT_MS;
  return Math.max(MIN_ENDPOINT_MS, Math.min(MAX_ENDPOINT_MS, Math.round(value / 50) * 50));
}

/** Learns a conservative next-turn pause window from the previous utterance. */
export function computeAdaptiveEndpointSilenceMs(input: AdaptiveEndpointInput): number {
  const transcript = String(input.transcript || '').replace(/\s+/g, ' ').trim();
  const durationMs = Math.max(0, Number(input.speechDurationMs) || 0);
  const units = Array.from(transcript).length;
  // i18n-allow -- multilingual input-recognition literals, not user-visible copy.
  const continuationLanguage = /(?:然后|接着|另外|还有|首先|其次|最后|and then|also|next|first|second)/i.test(transcript);

  let target = DEFAULT_ENDPOINT_MS;
  if (units <= 16 && (durationMs === 0 || durationMs <= 2_500) && !continuationLanguage) {
    target = 680;
  } else if (units >= 42 || durationMs >= 7_000 || continuationLanguage) {
    target = 1_020;
  } else if (units <= 28 && durationMs <= 4_500) {
    target = 780;
  }

  const previous = clampEndpointSilenceMs(input.previousSilenceMs ?? DEFAULT_ENDPOINT_MS);
  return clampEndpointSilenceMs((previous * 0.3) + (target * 0.7));
}
