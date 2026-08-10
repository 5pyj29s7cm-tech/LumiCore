export type VoiceLatencyMilestone =
  | 'speechEndedAt'
  | 'asrFinalAt'
  | 'pipelineStartedAt'
  | 'firstModelTokenAt'
  | 'firstTtsReadyAt'
  | 'firstPlaybackAt';

export interface VoiceLatencyTrace {
  requestId: string;
  provider?: string;
  domain?: 'personal' | 'work';
  createdAt: number;
  completedAt?: number;
  speechEndedAt?: number;
  asrFinalAt?: number;
  pipelineStartedAt?: number;
  firstModelTokenAt?: number;
  firstTtsReadyAt?: number;
  firstPlaybackAt?: number;
}

interface StageStats {
  avgMs: number;
  p50Ms: number;
  p95Ms: number;
  lastMs: number;
  count: number;
}

const ACTIVE_TRACE_TTL_MS = 10 * 60_000;
const STATS_WINDOW_MS = 15 * 60_000;
const MAX_COMPLETED_TRACES = 300;
const activeTraces = new Map<string, VoiceLatencyTrace>();
const completedTraces: VoiceLatencyTrace[] = [];

function prune(now = Date.now()): void {
  for (const [requestId, trace] of activeTraces) {
    if (now - trace.createdAt > ACTIVE_TRACE_TTL_MS) activeTraces.delete(requestId);
  }
  while (completedTraces.length > MAX_COMPLETED_TRACES) completedTraces.shift();
}

export function startVoiceLatencyTrace(input: {
  requestId: string;
  provider?: string;
  domain?: 'personal' | 'work';
  speechEndedAt?: number;
  asrFinalAt?: number;
  pipelineStartedAt?: number;
}): void {
  const now = Date.now();
  prune(now);
  activeTraces.set(input.requestId, {
    requestId: input.requestId,
    provider: input.provider,
    domain: input.domain,
    createdAt: now,
    speechEndedAt: input.speechEndedAt,
    asrFinalAt: input.asrFinalAt,
    pipelineStartedAt: input.pipelineStartedAt ?? now,
  });
}

export function markVoiceLatencyMilestone(
  requestId: string,
  milestone: VoiceLatencyMilestone,
  timestamp = Date.now(),
): void {
  const trace = activeTraces.get(requestId);
  if (!trace || trace[milestone] !== undefined) return;
  trace[milestone] = timestamp;
  if (milestone === 'firstPlaybackAt') {
    trace.completedAt = timestamp;
    activeTraces.delete(requestId);
    completedTraces.push({ ...trace });
    prune(timestamp);
  }
}

function percentile(sorted: number[], ratio: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * ratio) - 1));
  return sorted[index];
}

function computeStage(
  traces: VoiceLatencyTrace[],
  start: keyof VoiceLatencyTrace,
  end: keyof VoiceLatencyTrace,
): StageStats {
  const values = traces
    .map(trace => {
      const startValue = trace[start];
      const endValue = trace[end];
      return typeof startValue === 'number' && typeof endValue === 'number'
        ? Math.max(0, endValue - startValue)
        : null;
    })
    .filter((value): value is number => value !== null);
  if (values.length === 0) return { avgMs: 0, p50Ms: 0, p95Ms: 0, lastMs: 0, count: 0 };
  const sorted = [...values].sort((a, b) => a - b);
  return {
    avgMs: Math.round(values.reduce((sum, value) => sum + value, 0) / values.length),
    p50Ms: Math.round(percentile(sorted, 0.5)),
    p95Ms: Math.round(percentile(sorted, 0.95)),
    lastMs: Math.round(values[values.length - 1]),
    count: values.length,
  };
}

export function getVoiceLatencyStats(now = Date.now()) {
  prune(now);
  const recent = completedTraces.filter(trace => (trace.completedAt || trace.createdAt) >= now - STATS_WINDOW_MS);
  return {
    windowMs: STATS_WINDOW_MS,
    completedTurns: recent.length,
    activeTurns: activeTraces.size,
    stages: {
      endpointToAsrFinal: computeStage(recent, 'speechEndedAt', 'asrFinalAt'),
      asrFinalToPipeline: computeStage(recent, 'asrFinalAt', 'pipelineStartedAt'),
      pipelineToFirstModelToken: computeStage(recent, 'pipelineStartedAt', 'firstModelTokenAt'),
      pipelineToFirstTtsReady: computeStage(recent, 'pipelineStartedAt', 'firstTtsReadyAt'),
      ttsReadyToFirstPlayback: computeStage(recent, 'firstTtsReadyAt', 'firstPlaybackAt'),
      endpointToFirstPlayback: computeStage(recent, 'speechEndedAt', 'firstPlaybackAt'),
    },
  };
}

export function resetVoiceLatencyStoreForTests(): void {
  activeTraces.clear();
  completedTraces.length = 0;
}
