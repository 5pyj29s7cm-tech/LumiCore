import type { ToolExecutionEnvelopeStatus } from '../tools/types';

interface ToolCounter {
  calls: number;
  inFlight: number;
  durationMs: number;
  outcomes: Record<ToolExecutionEnvelopeStatus, number>;
}

const STATUSES: ToolExecutionEnvelopeStatus[] = [
  'verified_success',
  'failed',
  'timeout',
  'forbidden',
  'waiting_confirmation',
  'unknown_outcome',
  'target_mismatch',
];

function emptyOutcomes(): Record<ToolExecutionEnvelopeStatus, number> {
  return Object.fromEntries(STATUSES.map(status => [status, 0])) as Record<ToolExecutionEnvelopeStatus, number>;
}

const totals: ToolCounter = { calls: 0, inFlight: 0, durationMs: 0, outcomes: emptyOutcomes() };
const byTool = new Map<string, ToolCounter>();

function counterFor(name: string): ToolCounter {
  let counter = byTool.get(name);
  if (!counter) {
    counter = { calls: 0, inFlight: 0, durationMs: 0, outcomes: emptyOutcomes() };
    byTool.set(name, counter);
  }
  return counter;
}

export function beginToolMetric(name: string): (status: ToolExecutionEnvelopeStatus) => void {
  const startedAt = Date.now();
  const tool = counterFor(name);
  totals.calls += 1;
  totals.inFlight += 1;
  tool.calls += 1;
  tool.inFlight += 1;
  let finished = false;
  return status => {
    if (finished) return;
    finished = true;
    const duration = Math.max(0, Date.now() - startedAt);
    totals.inFlight = Math.max(0, totals.inFlight - 1);
    tool.inFlight = Math.max(0, tool.inFlight - 1);
    totals.durationMs += duration;
    tool.durationMs += duration;
    totals.outcomes[status] += 1;
    tool.outcomes[status] += 1;
  };
}

function snapshotCounter(counter: ToolCounter) {
  const failures = counter.outcomes.failed
    + counter.outcomes.timeout
    + counter.outcomes.forbidden
    + counter.outcomes.unknown_outcome
    + counter.outcomes.target_mismatch;
  return {
    calls: counter.calls,
    inFlight: counter.inFlight,
    averageDurationMs: counter.calls ? Math.round(counter.durationMs / counter.calls) : 0,
    errorRate: counter.calls ? Number((failures / counter.calls).toFixed(4)) : 0,
    timeoutRate: counter.calls ? Number(((counter.outcomes.timeout + counter.outcomes.unknown_outcome) / counter.calls).toFixed(4)) : 0,
    outcomes: { ...counter.outcomes },
  };
}

export function getToolRuntimeMetrics() {
  return {
    generatedAt: new Date().toISOString(),
    totals: snapshotCounter(totals),
    tools: Object.fromEntries(
      [...byTool.entries()]
        .sort((left, right) => right[1].calls - left[1].calls)
        .slice(0, 80)
        .map(([name, counter]) => [name, snapshotCounter(counter)]),
    ),
  };
}

export function resetToolRuntimeMetricsForTests(): void {
  totals.calls = 0;
  totals.inFlight = 0;
  totals.durationMs = 0;
  totals.outcomes = emptyOutcomes();
  byTool.clear();
}
