import fs from 'node:fs';
import path from 'node:path';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { getDataRoot } from '../config/data_path';

export interface LayaShadowConfig { enabled: boolean; pythonPath: string; modelPath: string; }
export interface LayaShadowSample {
  text: string;
  task?: { goal: string; status?: string; unfinished: boolean; latestBlocker: string };
  decision: { followup: string; skill: string; executionRequested: boolean };
}
type State = 'off' | 'starting' | 'ready' | 'busy' | 'failed';
type Decision = { choice: string; confidence: number };

/** Local, advisory-only IPC. No returned value can enter the execution pipeline. */
export class LayaShadowObserver {
  private child: ChildProcessWithoutNullStreams | null = null;
  private state: State = 'off';
  private pending: { id: number; sample: LayaShadowSample; started: number } | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private buffer = '';
  private serial = 0;
  private retryAt = 0;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private stats = { observed: 0, completed: 0, skipped: 0, disagreements: 0, failures: 0 };
  private last: { elapsedMs: number; followup: Decision; skill: Decision; agrees: boolean } | null = null;
  private failure: string | null = null;
  constructor(private readonly config: LayaShadowConfig, private readonly options: {
    workerPath: string; spawnProcess?: typeof spawn; startupMs?: number; inferenceMs?: number; idleMs?: number;
  }) {}

  status() { return { mode: 'shadow' as const, enabled: this.config.enabled, state: this.state,
    ...this.stats, last: this.last, failure: this.failure, controlsExecution: false as const }; }

  observe(sample: LayaShadowSample): void {
    if (!this.config.enabled) return;
    this.stats.observed++;
    if (sample.text.length > 700 || (sample.task && (sample.task.goal.length > 700 || sample.task.latestBlocker.length > 200))) {
      this.stats.skipped++; return;
    }
    if (this.state === 'busy' || this.state === 'starting' || Date.now() < this.retryAt) { this.stats.skipped++; return; }
    if (!this.child) {
      // Retain at most one bounded request during cold start. Never block the
      // chat turn, and never accumulate old decisions behind an active one.
      this.pending = { id: ++this.serial, sample: this.bound(sample), started: 0 };
      this.start();
      return;
    }
    this.pending = { id: ++this.serial, sample: this.bound(sample), started: 0 };
    this.send();
  }

  private bound(sample: LayaShadowSample): LayaShadowSample {
    return { text: sample.text.slice(0, 700), decision: { ...sample.decision },
      ...(sample.task ? { task: { goal: sample.task.goal.slice(0, 700), status: sample.task.status?.slice(0, 40),
        unfinished: sample.task.unfinished, latestBlocker: sample.task.latestBlocker.slice(0, 200) } } : {}) };
  }
  private start(): void {
    if (!path.isAbsolute(this.config.pythonPath) || !path.isAbsolute(this.config.modelPath)) { this.fail('invalid_local_paths'); return; }
    this.state = 'starting'; this.buffer = ''; this.failure = null;
    try {
      const child = (this.options.spawnProcess || spawn)(this.config.pythonPath,
        ['-u', this.options.workerPath, this.config.modelPath], { windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'],
          env: { ...process.env, HF_HUB_OFFLINE: '1', TRANSFORMERS_OFFLINE: '1', HF_HUB_DISABLE_TELEMETRY: '1', TOKENIZERS_PARALLELISM: 'false', PYTHONIOENCODING: 'utf-8', USE_TF: '0' },
        }) as ChildProcessWithoutNullStreams;
      this.child = child;
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => { if (this.child === child) this.receive(chunk); });
      // Third-party diagnostics can contain local content or paths. Drain but
      // do not publish raw stderr or conversation text to the runtime log.
      child.stderr.resume();
      child.stdin.on('error', () => { if (this.child === child) this.fail('worker_input_failed'); });
      child.once('error', () => { if (this.child === child) this.fail('worker_start_failed'); });
      child.once('exit', () => { if (this.child === child) this.fail('worker_exited'); });
      this.deadline(this.options.startupMs ?? 30_000, 'startup_timeout');
    } catch { this.fail('worker_start_failed'); }
  }
  private send(): void {
    if (!this.child || !this.pending) return;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.state = 'busy'; this.pending.started = performance.now();
    this.deadline(this.options.inferenceMs ?? 2_000, 'inference_timeout');
    const { id, sample } = this.pending;
    try {
      this.child.stdin.write(JSON.stringify({ id, state: { current_user_message: sample.text, existing_task: sample.task || null } }) + '\n');
    } catch { this.fail('worker_input_failed'); }
  }
  private receive(chunk: string): void {
    this.buffer += chunk;
    if (this.buffer.length > 16_384) { this.fail('worker_protocol_overflow'); return; }
    let end: number;
    while ((end = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, end); this.buffer = this.buffer.slice(end + 1);
      let reply: any;
      try { reply = JSON.parse(line); } catch { this.fail('worker_protocol_invalid'); return; }
      if (reply.ready === true && this.state === 'starting') { this.send(); continue; }
      if (!this.pending || this.state !== 'busy' || reply.id !== this.pending.id) { this.fail('worker_response_mismatch'); return; }
      if (reply.error) { this.fail(reply.error === 'input_too_long' ? 'input_too_long' : 'worker_inference_failed'); return; }
      const followup = this.decision(reply.followup, ['execute', 'status', 'repeat', 'none']);
      const skill = this.decision(reply.skill, ['save', 'generate', 'use', 'install', 'publish', 'none']);
      if (!followup || !skill) { this.fail('worker_response_invalid'); return; }
      const agrees = followup.choice === this.pending.sample.decision.followup && skill.choice === this.pending.sample.decision.skill;
      this.last = { elapsedMs: Math.round(performance.now() - this.pending.started), followup, skill, agrees };
      this.stats.completed++; if (!agrees) this.stats.disagreements++;
      this.pending = null; this.state = 'ready'; this.clearDeadline();
      this.idleTimer = setTimeout(() => this.stop(), this.options.idleMs ?? 300_000); this.idleTimer.unref();
    }
  }
  private decision(value: any, choices: string[]): Decision | null {
    return value && choices.includes(value.choice) && typeof value.confidence === 'number' && Number.isFinite(value.confidence)
      && value.confidence >= 0 && value.confidence <= 1 ? { choice: value.choice, confidence: value.confidence } : null;
  }
  private deadline(ms: number, reason: string): void {
    this.clearDeadline(); this.timer = setTimeout(() => this.fail(reason), ms); this.timer.unref();
  }
  private clearDeadline(): void { if (this.timer) clearTimeout(this.timer); this.timer = null; }
  private fail(reason: string): void {
    this.stop(); this.state = 'failed'; this.failure = reason; this.stats.failures++; this.retryAt = Date.now() + 30_000;
  }
  stop(): void {
    const child = this.child; this.child = null; this.pending = null; this.buffer = ''; this.state = 'off';
    this.clearDeadline(); if (this.idleTimer) clearTimeout(this.idleTimer); this.idleTimer = null;
    if (child) {
      // Windows venv launchers can own a second Python process. Terminate
      // only this still-live owned tree so a stalled inference cannot linger.
      if (process.platform === 'win32' && child.pid && child.exitCode === null && !child.killed) {
        const cleanup = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, shell: false, stdio: 'ignore' });
        cleanup.once('error', () => child.kill()); cleanup.unref();
      } else child.kill();
      child.stdin.destroy();
    }
  }
}

let observer: LayaShadowObserver | null = null;
let configKey = '';
let checkedAt = 0;
let stopped = false;
let queued: LayaShadowSample | null = null;
function configuredObserver(): LayaShadowObserver | null {
  if (stopped) return null;
  if (Date.now() - checkedAt < 10_000) return observer;
  checkedAt = Date.now();
  const file = process.env.LUMI_LAYA_CONFIG || path.join(getDataRoot(), 'data', 'laya-shadow.json');
  let raw: any = null;
  try { if (fs.statSync(file).size <= 8_192) raw = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/u, '')); } catch {}
  const config: LayaShadowConfig = { enabled: raw?.enabled === true && raw?.mode === 'shadow',
    pythonPath: typeof raw?.pythonPath === 'string' ? raw.pythonPath : '', modelPath: typeof raw?.modelPath === 'string' ? raw.modelPath : '' };
  const key = JSON.stringify(config);
  if (key === configKey) return observer;
  observer?.stop(); observer = null; configKey = key;
  if (config.enabled) {
    const workerPath = process.env.LUMI_RUNTIME_META_FILE
      ? path.join(path.dirname(process.env.LUMI_RUNTIME_META_FILE), 'laya-shadow-worker.py')
      : path.join(process.cwd(), 'server', 'runtime', 'laya_shadow_worker.py');
    observer = new LayaShadowObserver(config, { workerPath });
  }
  return observer;
}

/** Deliberately returns void; model output cannot select, authorize or retry tools. */
export function observeLayaDecision(sample: LayaShadowSample): void {
  if (stopped || queued) return;
  queued = sample;
  // Even local process creation can take tens of milliseconds on Windows.
  // Defer config I/O and cold start until the canonical planner has returned.
  setImmediate(() => {
    const next = queued; queued = null;
    try { if (!stopped && next) configuredObserver()?.observe(next); } catch { /* Optional shadow work must not fail a user turn. */ }
  }).unref();
}
export function getLayaShadowStatus() {
  return configuredObserver()?.status() || { mode: 'shadow', enabled: false, state: 'off', controlsExecution: false };
}
export function stopLayaShadow(): void { stopped = true; queued = null; observer?.stop(); }
