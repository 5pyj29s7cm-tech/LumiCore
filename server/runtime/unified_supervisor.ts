export type UnifiedSupervisorOutcome = 'idle' | 'ok' | 'failed' | 'timeout';

export interface UnifiedSupervisorJob {
  id: string;
  intervalMs: number;
  timeoutMs: number;
  run: () => unknown | Promise<unknown>;
}

export interface UnifiedSupervisorJobStatus {
  id: string;
  outcome: UnifiedSupervisorOutcome;
  inFlight: boolean;
  runs: number;
  failures: number;
  consecutiveFailures: number;
  lastStartedAt: string;
  lastCompletedAt: string;
  lastDurationMs: number;
  lastError: string;
  nextRunAt: string;
  lastResult: unknown;
}

export interface UnifiedRuntimeSupervisorStatus {
  running: boolean;
  startedAt: string;
  stoppedAt: string;
  ticks: number;
  jobs: UnifiedSupervisorJobStatus[];
}

interface JobRuntime extends UnifiedSupervisorJobStatus {
  definition: UnifiedSupervisorJob;
  nextRunMs: number;
}

function compactResult(value: unknown): unknown {
  if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) {
    return typeof value === 'string' ? value.slice(0, 300) : value;
  }
  if (Array.isArray(value)) return value.slice(0, 20).map(compactResult);
  if (!value || typeof value !== 'object') return undefined;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .slice(0, 30)
    .map(([key, item]) => [key, compactResult(item)]));
}

function iso(value: number): string {
  return value > 0 ? new Date(value).toISOString() : '';
}

export class UnifiedRuntimeSupervisor {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private ticks = 0;
  private startedAt = '';
  private stoppedAt = '';
  private jobs = new Map<string, JobRuntime>();

  constructor(definitions: UnifiedSupervisorJob[], private readonly pollMs = 250) {
    for (const definition of definitions) {
      if (!definition.id || this.jobs.has(definition.id)) throw new Error(`duplicate supervisor job: ${definition.id}`);
      this.jobs.set(definition.id, {
        definition: {
          ...definition,
          intervalMs: Math.max(100, Number(definition.intervalMs) || 1_000),
          timeoutMs: Math.max(50, Number(definition.timeoutMs) || 1_000),
        },
        id: definition.id,
        outcome: 'idle',
        inFlight: false,
        runs: 0,
        failures: 0,
        consecutiveFailures: 0,
        lastStartedAt: '',
        lastCompletedAt: '',
        lastDurationMs: 0,
        lastError: '',
        nextRunAt: '',
        lastResult: undefined,
        nextRunMs: 0,
      });
    }
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.startedAt = new Date().toISOString();
    this.stoppedAt = '';
    this.timer = setInterval(() => { void this.tick(); }, Math.max(50, this.pollMs));
    this.timer.unref?.();
    void this.tick();
  }

  async tick(): Promise<number> {
    if (!this.running) return 0;
    this.ticks += 1;
    const now = Date.now();
    const due = [...this.jobs.values()].filter(job => !job.inFlight && job.nextRunMs <= now);
    for (const job of due) void this.runJob(job);
    return due.length;
  }

  async runOnce(id: string): Promise<UnifiedSupervisorJobStatus> {
    const job = this.jobs.get(id);
    if (!job) throw new Error(`unknown supervisor job: ${id}`);
    if (!job.inFlight) await this.runJob(job);
    return this.project(job);
  }

  private async runJob(job: JobRuntime): Promise<void> {
    if (job.inFlight) return;
    const started = Date.now();
    job.inFlight = true;
    job.runs += 1;
    job.lastStartedAt = iso(started);
    let terminalRecorded = false;
    let timeout: ReturnType<typeof setTimeout> | null = null;
    const work = Promise.resolve().then(job.definition.run);
    const timeoutResult = new Promise<{ timedOut: true }>(resolve => {
      timeout = setTimeout(() => resolve({ timedOut: true }), job.definition.timeoutMs);
      timeout.unref?.();
    });
    try {
      const result = await Promise.race([
        work.then(value => ({ timedOut: false as const, value })),
        timeoutResult,
      ]);
      const completed = Date.now();
      terminalRecorded = true;
      if (result.timedOut) {
        job.outcome = 'timeout';
        job.failures += 1;
        job.consecutiveFailures += 1;
        job.lastError = `job exceeded ${job.definition.timeoutMs}ms`;
      } else {
        job.outcome = 'ok';
        job.consecutiveFailures = 0;
        job.lastError = '';
        job.lastResult = compactResult('value' in result ? result.value : undefined);
      }
      job.lastCompletedAt = iso(completed);
      job.lastDurationMs = Math.max(0, completed - started);
    } catch (error: any) {
      const completed = Date.now();
      terminalRecorded = true;
      job.outcome = 'failed';
      job.failures += 1;
      job.consecutiveFailures += 1;
      job.lastError = String(error?.message || error || 'supervisor job failed').slice(0, 500);
      job.lastCompletedAt = iso(completed);
      job.lastDurationMs = Math.max(0, completed - started);
    } finally {
      if (timeout) clearTimeout(timeout);
      // A timed-out operation is not cancelled and may still own resources.
      // Keep the no-overlap lease until it really settles.
      if (terminalRecorded && job.outcome === 'timeout') await work.catch(() => undefined);
      job.inFlight = false;
      const multiplier = job.consecutiveFailures > 0
        ? Math.min(16, 2 ** Math.min(job.consecutiveFailures, 4))
        : 1;
      job.nextRunMs = Date.now() + job.definition.intervalMs * multiplier;
      job.nextRunAt = iso(job.nextRunMs);
    }
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.running = false;
    this.stoppedAt = new Date().toISOString();
  }

  private project(job: JobRuntime): UnifiedSupervisorJobStatus {
    const { definition: _definition, nextRunMs: _nextRunMs, ...status } = job;
    return { ...status, lastResult: compactResult(status.lastResult) };
  }

  status(): UnifiedRuntimeSupervisorStatus {
    return {
      running: this.running,
      startedAt: this.startedAt,
      stoppedAt: this.stoppedAt,
      ticks: this.ticks,
      jobs: [...this.jobs.values()].map(job => this.project(job)),
    };
  }
}

let activeSupervisor: UnifiedRuntimeSupervisor | null = null;

export function setUnifiedRuntimeSupervisor(supervisor: UnifiedRuntimeSupervisor | null): void {
  activeSupervisor = supervisor;
}

export function getUnifiedRuntimeSupervisorStatus(): UnifiedRuntimeSupervisorStatus {
  return activeSupervisor?.status() || {
    running: false,
    startedAt: '',
    stoppedAt: '',
    ticks: 0,
    jobs: [],
  };
}
