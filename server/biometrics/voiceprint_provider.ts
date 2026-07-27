import { spawn, ChildProcessWithoutNullStreams } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { logger } from '../../logger';
import { getDataDirectory } from '../config/data_path';
import { SupervisedProcessResourceMonitor } from '../runtime/process_resource_monitor';

export interface VoiceprintEmbeddingInput {
  pcm16Base64?: string;
  sampleRate?: number;
}

export interface VoiceprintEmbeddingResult {
  ok: boolean;
  provider?: 'speechbrain-ecapa';
  model?: string;
  embedding?: number[];
  embeddingDim?: number;
  durationSec?: number;
  reason?: string;
  error?: string;
  install?: string;
}

type PendingRequest = {
  resolve: (value: any) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

type QueuedRequest = {
  payload: Record<string, unknown>;
  timeoutMs: number;
  resolve: (value: any) => void;
  reject: (error: Error) => void;
};

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SIDECAR_SCRIPT = path.join(__dirname, 'voiceprint_sidecar.py');
const DEFAULT_TIMEOUT_MS = 45000;
const UNAVAILABLE_RETRY_MS = 60000;
const MAX_PCM_BASE64_CHARS = 800000;
const MAX_CONCURRENT_REQUESTS = Math.max(1, Number(process.env.LUMI_VOICEPRINT_CONCURRENCY) || 2);
const SIDECAR_IDLE_MS = Math.max(30_000, Number(process.env.LUMI_VOICEPRINT_IDLE_MS) || 5 * 60_000);
const SIDECAR_MEMORY_BUDGET_BYTES = Math.max(256, Number(process.env.LUMI_VOICEPRINT_MEMORY_BUDGET_MB) || 1_024) * 1024 * 1024;
const SIDECAR_PRIVATE_MEMORY_BUDGET_BYTES = Math.max(512, Number(process.env.LUMI_VOICEPRINT_PRIVATE_MEMORY_BUDGET_MB) || 3_072) * 1024 * 1024;
let providerCooldownUntil = 0;
let providerCooldownReason = '';

export function resolveVoiceprintPython(): string {
  if (process.env.LUMI_VOICEPRINT_PYTHON?.trim()) {
    return process.env.LUMI_VOICEPRINT_PYTHON.trim();
  }

  const projectRoot = path.resolve(__dirname, '..', '..');
  const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
  const roots = [projectRoot, process.cwd(), resourcesPath].filter((value): value is string => Boolean(value));
  const relativeCandidates = process.platform === 'win32'
    ? [
        path.join('gpt-sovits-src', 'venv', 'Scripts', 'python.exe'),
        path.join('resources', 'voiceprint', 'venv', 'Scripts', 'python.exe'),
      ]
    : [
        path.join('gpt-sovits-src', 'venv', 'bin', 'python3'),
        path.join('resources', 'voiceprint', 'venv', 'bin', 'python3'),
      ];

  for (const root of roots) {
    for (const relativePath of relativeCandidates) {
      const candidate = path.resolve(root, relativePath);
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  return process.platform === 'win32' ? 'python' : 'python3';
}

class SpeechBrainSidecarClient {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private pending = new Map<string, PendingRequest>();
  private seq = 0;
  private unavailableUntil = 0;
  private lastError = '';
  private queue: QueuedRequest[] = [];
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private restartCount = 0;
  private lastUsedAt = '';
  private resourceMonitor = new SupervisedProcessResourceMonitor({
    budgetBytes: SIDECAR_MEMORY_BUDGET_BYTES,
    privateBudgetBytes: SIDECAR_PRIVATE_MEMORY_BUDGET_BYTES,
    intervalMs: 5_000,
    onBudgetExceeded: snapshot => {
      const proc = this.proc;
      if (!proc || proc.killed) return;
      const error = new Error(snapshot.rssBytes > snapshot.budgetBytes
        ? `SpeechBrain working set ${snapshot.rssBytes} exceeded budget ${snapshot.budgetBytes}`
        : `SpeechBrain private memory ${snapshot.privateBytes} exceeded budget ${snapshot.privateBudgetBytes}`);
      logger.warn(`[Voiceprint] ${error.message}; stopping supervised process tree.`);
      this.markUnavailable(error);
      this.resourceMonitor.stop();
      proc.kill();
    },
  });

  request(payload: Record<string, unknown>, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<any> {
    if (Date.now() < this.unavailableUntil) {
      return Promise.reject(new Error(this.lastError || 'SpeechBrain sidecar is temporarily unavailable'));
    }

    this.clearIdleTimer();
    this.lastUsedAt = new Date().toISOString();
    if (this.pending.size >= MAX_CONCURRENT_REQUESTS) {
      return new Promise((resolve, reject) => {
        this.queue.push({ payload, timeoutMs, resolve, reject });
      });
    }
    return this.dispatch(payload, timeoutMs);
  }

  private dispatch(payload: Record<string, unknown>, timeoutMs: number): Promise<any> {
    this.ensureProcess();
    if (!this.proc || !this.proc.stdin.writable) {
      return Promise.reject(new Error('SpeechBrain sidecar is not writable'));
    }

    const id = `vp_${Date.now()}_${++this.seq}`;
    const message = JSON.stringify({ ...payload, id }) + '\n';

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('SpeechBrain sidecar request timed out'));
        this.drainQueue();
        this.scheduleIdleStop();
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.proc?.stdin.write(message, 'utf8', (err) => {
        if (err) {
          const pending = this.pending.get(id);
          if (pending) {
            clearTimeout(pending.timer);
            this.pending.delete(id);
            pending.reject(err);
            this.drainQueue();
            this.scheduleIdleStop();
          }
        }
      });
    });
  }

  private drainQueue(): void {
    while (this.queue.length > 0 && this.pending.size < MAX_CONCURRENT_REQUESTS) {
      const queued = this.queue.shift()!;
      this.dispatch(queued.payload, queued.timeoutMs).then(queued.resolve, queued.reject);
    }
  }

  private clearIdleTimer(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }

  private scheduleIdleStop(): void {
    this.clearIdleTimer();
    if (this.pending.size > 0 || this.queue.length > 0 || !this.proc) return;
    this.idleTimer = setTimeout(() => {
      if (this.pending.size === 0 && this.queue.length === 0 && this.proc && !this.proc.killed) {
        logger.info(`[Voiceprint] Sidecar idle for ${SIDECAR_IDLE_MS}ms; releasing model process.`);
        this.proc.kill();
        this.proc = null;
      }
    }, SIDECAR_IDLE_MS);
    this.idleTimer.unref?.();
  }

  private ensureProcess(): void {
    if (this.proc && !this.proc.killed) return;

    const python = resolveVoiceprintPython();
    this.proc = spawn(python, [SIDECAR_SCRIPT], {
      cwd: path.resolve(__dirname, '..', '..'),
      env: {
        ...process.env,
        PYTHONUTF8: '1',
        LUMI_VOICEPRINT_MODEL_DIR: process.env.LUMI_VOICEPRINT_MODEL_DIR?.trim()
          || getDataDirectory('voiceprint_models'),
      },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    if (this.proc.pid) this.resourceMonitor.start(this.proc.pid);

    const rl = readline.createInterface({ input: this.proc.stdout });
    rl.on('line', (line) => this.handleLine(line));

    this.proc.stderr.setEncoding('utf8');
    this.proc.stderr.on('data', (chunk) => {
      const text = String(chunk).trim();
      if (text) logger.warn(`[Voiceprint] SpeechBrain sidecar: ${text.slice(0, 600)}`);
    });

    this.proc.on('error', (err) => this.markUnavailable(err));
    this.proc.on('exit', (code, signal) => {
      this.resourceMonitor.stop();
      this.proc = null;
      const err = new Error(`SpeechBrain sidecar exited (${code ?? signal ?? 'unknown'})`);
      for (const [id, pending] of this.pending.entries()) {
        clearTimeout(pending.timer);
        pending.reject(err);
        this.pending.delete(id);
      }
      if (code !== 0 && code !== null) this.markUnavailable(err);
      else this.scheduleIdleStop();
    });
  }

  private handleLine(line: string): void {
    let data: any;
    try {
      data = JSON.parse(line);
    } catch (err: any) {
      logger.warn(`[Voiceprint] Invalid sidecar JSON: ${err?.message || err}`);
      return;
    }

    const id = data?.id;
    const pending = typeof id === 'string' ? this.pending.get(id) : undefined;
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(id);
    pending.resolve(data);
    this.lastUsedAt = new Date().toISOString();
    this.restartCount = 0;
    this.drainQueue();
    this.scheduleIdleStop();
  }

  private markUnavailable(err: Error): void {
    this.lastError = err.message;
    this.restartCount += 1;
    this.unavailableUntil = Date.now() + Math.max(
      UNAVAILABLE_RETRY_MS,
      Math.min(5 * 60_000, 2 ** Math.min(this.restartCount, 8) * 1_000),
    );
    for (const [id, pending] of this.pending.entries()) {
      clearTimeout(pending.timer);
      pending.reject(err);
      this.pending.delete(id);
    }
    for (const queued of this.queue.splice(0)) queued.reject(err);
    logger.warn(`[Voiceprint] SpeechBrain sidecar unavailable: ${err.message}`);
  }

  status() {
    return {
      running: Boolean(this.proc && !this.proc.killed),
      pid: this.proc?.pid || null,
      inFlight: this.pending.size,
      queueLength: this.queue.length,
      concurrency: MAX_CONCURRENT_REQUESTS,
      idleTimeoutMs: SIDECAR_IDLE_MS,
      lastUsedAt: this.lastUsedAt,
      restartCount: this.restartCount,
      unavailableUntil: this.unavailableUntil ? new Date(this.unavailableUntil).toISOString() : '',
      lastError: this.lastError,
      resources: this.resourceMonitor.status(),
    };
  }

  async stop(): Promise<void> {
    this.clearIdleTimer();
    const proc = this.proc;
    this.proc = null;
    this.resourceMonitor.stop();
    const error = new Error('SpeechBrain sidecar stopped during runtime shutdown');
    for (const [id, pending] of this.pending.entries()) {
      clearTimeout(pending.timer);
      pending.reject(error);
      this.pending.delete(id);
    }
    for (const queued of this.queue.splice(0)) queued.reject(error);
    if (!proc || proc.exitCode !== null || proc.signalCode !== null) return;

    const exited = new Promise<void>(resolve => proc.once('exit', () => resolve()));
    proc.kill('SIGTERM');
    const graceful = await Promise.race([
      exited.then(() => true),
      new Promise<boolean>(resolve => setTimeout(() => resolve(false), 2_000)),
    ]);
    if (!graceful && proc.exitCode === null && proc.signalCode === null) {
      proc.kill('SIGKILL');
      await Promise.race([
        exited,
        new Promise<void>(resolve => setTimeout(resolve, 2_000)),
      ]);
    }
  }
}

let client: SpeechBrainSidecarClient | null = null;

function getClient(): SpeechBrainSidecarClient {
  if (!client) client = new SpeechBrainSidecarClient();
  return client;
}

export function getVoiceprintRuntimeStatus() {
  return client?.status() || {
    running: false,
    pid: null,
    inFlight: 0,
    queueLength: 0,
    concurrency: MAX_CONCURRENT_REQUESTS,
    idleTimeoutMs: SIDECAR_IDLE_MS,
    lastUsedAt: '',
    restartCount: 0,
    unavailableUntil: '',
    lastError: '',
    resources: {
      pid: null,
      processCount: 0,
      rssBytes: 0,
      privateBytes: 0,
      peakRssBytes: 0,
      peakPrivateBytes: 0,
      budgetBytes: SIDECAR_MEMORY_BUDGET_BYTES,
      privateBudgetBytes: SIDECAR_PRIVATE_MEMORY_BUDGET_BYTES,
      budgetExceededCount: 0,
      sampledAt: '',
      lastError: '',
    },
  };
}

export async function stopVoiceprintRuntime(): Promise<void> {
  const activeClient = client;
  client = null;
  if (activeClient) await activeClient.stop();
}

function sanitizeEmbedding(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  const out = value.map(Number).filter(Number.isFinite);
  if (out.length < 32 || out.length > 4096) return [];
  const norm = Math.sqrt(out.reduce((sum, item) => sum + item * item, 0));
  if (norm < 1e-12) return [];
  return out.map(item => item / norm);
}

export async function extractSpeechBrainEmbedding(
  input: VoiceprintEmbeddingInput,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<VoiceprintEmbeddingResult> {
  const provider = (process.env.LUMI_VOICEPRINT_PROVIDER || 'speechbrain').toLowerCase();
  if (provider === 'off' || provider === 'none' || provider === 'mfcc') {
    return { ok: false, reason: 'provider_disabled' };
  }
  if (Date.now() < providerCooldownUntil) {
    return { ok: false, reason: providerCooldownReason || 'provider_cooling_down' };
  }

  const pcm16Base64 = typeof input.pcm16Base64 === 'string' ? input.pcm16Base64 : '';
  if (!pcm16Base64) return { ok: false, reason: 'no_audio' };
  if (pcm16Base64.length > MAX_PCM_BASE64_CHARS) return { ok: false, reason: 'audio_window_too_large' };

  try {
    const response = await getClient().request({
      action: 'embed',
      pcm16Base64,
      sampleRate: Number(input.sampleRate) || 16000,
    }, timeoutMs);

    if (response?.ok === true) {
      const embedding = sanitizeEmbedding(response.embedding);
      if (embedding.length > 0) {
        providerCooldownUntil = 0;
        providerCooldownReason = '';
        return {
          ok: true,
          provider: 'speechbrain-ecapa',
          model: String(response.model || 'speechbrain/spkrec-ecapa-voxceleb'),
          embedding,
          embeddingDim: embedding.length,
          durationSec: Number(response.durationSec) || undefined,
        };
      }
      return { ok: false, reason: 'invalid_embedding', error: 'Sidecar returned an invalid embedding' };
    }

    const reason = String(response?.code || 'sidecar_failed');
    if (reason === 'missing_dependency' || reason === 'sidecar_failed') {
      providerCooldownUntil = Date.now() + UNAVAILABLE_RETRY_MS;
      providerCooldownReason = reason;
    }
    return {
      ok: false,
      reason,
      error: typeof response?.error === 'string' ? response.error : undefined,
      install: typeof response?.install === 'string' ? response.install : undefined,
    };
  } catch (err: any) {
    providerCooldownUntil = Date.now() + UNAVAILABLE_RETRY_MS;
    providerCooldownReason = 'sidecar_unavailable';
    return { ok: false, reason: 'sidecar_unavailable', error: err?.message || String(err) };
  }
}

export function cosineEmbedding(a: number[], b: number[]): number {
  const len = Math.min(a.length, b.length);
  if (len === 0) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < len; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA < 1e-12 || normB < 1e-12) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}
