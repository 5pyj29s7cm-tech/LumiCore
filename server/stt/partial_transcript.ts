export function normalizeStreamingTranscript(text: string): string {
  return String(text || '').replace(/\s+/g, ' ').trim();
}

/** Avoids exact repeats and temporary provider regressions in live subtitles. */
export function shouldEmitStreamingPartial(previous: string, next: string): boolean {
  const prior = normalizeStreamingTranscript(previous);
  const candidate = normalizeStreamingTranscript(next);
  if (!candidate || candidate === prior) return false;
  if (prior && prior.startsWith(candidate) && candidate.length < prior.length) return false;
  return true;
}
