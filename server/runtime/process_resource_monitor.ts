import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface SupervisedProcessResourceSnapshot {
  pid: number | null;
  rssBytes: number;
  privateBytes: number;
  peakRssBytes: number;
  budgetBytes: number;
  budgetExceededCount: number;
  sampledAt: string;
  lastError: string;
}

async function sampleWindowsProcess(pid: number): Promise<{ rssBytes: number; privateBytes: number }> {
  const script = [
    `$p = Get-Process -Id ${pid} -ErrorAction Stop`,
    '[pscustomobject]@{rss=[int64]$p.WorkingSet64;private=[int64]$p.PrivateMemorySize64} | ConvertTo-Json -Compress',
  ].join('; ');
  const { stdout } = await execFileAsync(
    'powershell',
    ['-NoProfile', '-NonInteractive', '-Command', script],
    { timeout: 5_000, windowsHide: true, encoding: 'utf8' },
  );
  const parsed = JSON.parse(String(stdout || '{}'));
  return {
    rssBytes: Math.max(0, Number(parsed.rss) || 0),
    privateBytes: Math.max(0, Number(parsed.private) || 0),
  };
}

async function sampleProcStatus(pid: number): Promise<{ rssBytes: number; privateBytes: number }> {
  const status = await fs.readFile(`/proc/${pid}/status`, 'utf8');
  const kib = (name: string) => Number(status.match(new RegExp(`^${name}:\\s+(\\d+)\\s+kB$`, 'm'))?.[1] || 0);
  return {
    rssBytes: kib('VmRSS') * 1024,
    privateBytes: kib('RssAnon') * 1024,
  };
}

async function samplePosixProcess(pid: number): Promise<{ rssBytes: number; privateBytes: number }> {
  if (process.platform === 'linux') return sampleProcStatus(pid);
  const { stdout } = await execFileAsync(
    'ps',
    ['-o', 'rss=', '-p', String(pid)],
    { timeout: 5_000, encoding: 'utf8' },
  );
  const rssBytes = Math.max(0, Number(String(stdout || '').trim()) || 0) * 1024;
  return { rssBytes, privateBytes: rssBytes };
}

async function sampleProcess(pid: number): Promise<{ rssBytes: number; privateBytes: number }> {
  return process.platform === 'win32' ? sampleWindowsProcess(pid) : samplePosixProcess(pid);
}

export class SupervisedProcessResourceMonitor {
  private pid: number | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private sampling = false;
  private rssBytes = 0;
  private privateBytes = 0;
  private peakRssBytes = 0;
  private budgetExceededCount = 0;
  private sampledAt = '';
  private lastError = '';

  constructor(private readonly options: {
    budgetBytes: number;
    intervalMs?: number;
    onBudgetExceeded?: (snapshot: SupervisedProcessResourceSnapshot) => void;
  }) {}

  start(pid: number): void {
    this.stop();
    this.pid = pid;
    void this.sample();
    this.timer = setInterval(() => void this.sample(), Math.max(5_000, this.options.intervalMs || 30_000));
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.pid = null;
    this.rssBytes = 0;
    this.privateBytes = 0;
  }

  private async sample(): Promise<void> {
    const pid = this.pid;
    if (!pid || this.sampling) return;
    this.sampling = true;
    try {
      const usage = await sampleProcess(pid);
      if (this.pid !== pid) return;
      this.rssBytes = usage.rssBytes;
      this.privateBytes = usage.privateBytes;
      this.peakRssBytes = Math.max(this.peakRssBytes, usage.rssBytes);
      this.sampledAt = new Date().toISOString();
      this.lastError = '';
      if (this.options.budgetBytes > 0 && usage.rssBytes > this.options.budgetBytes) {
        this.budgetExceededCount += 1;
        this.options.onBudgetExceeded?.(this.status());
      }
    } catch (error: any) {
      if (this.pid === pid) this.lastError = error?.message || String(error);
    } finally {
      this.sampling = false;
    }
  }

  status(): SupervisedProcessResourceSnapshot {
    return {
      pid: this.pid,
      rssBytes: this.rssBytes,
      privateBytes: this.privateBytes,
      peakRssBytes: this.peakRssBytes,
      budgetBytes: Math.max(0, this.options.budgetBytes),
      budgetExceededCount: this.budgetExceededCount,
      sampledAt: this.sampledAt,
      lastError: this.lastError,
    };
  }
}
