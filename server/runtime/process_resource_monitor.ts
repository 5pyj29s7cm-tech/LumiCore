import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface SupervisedProcessResourceSnapshot {
  pid: number | null;
  processCount: number;
  rssBytes: number;
  privateBytes: number;
  peakRssBytes: number;
  peakPrivateBytes: number;
  budgetBytes: number;
  privateBudgetBytes: number;
  budgetExceededCount: number;
  sampledAt: string;
  lastError: string;
}

interface ProcessTreeUsage {
  rssBytes: number;
  privateBytes: number;
  processCount: number;
}

async function sampleWindowsProcess(pid: number): Promise<ProcessTreeUsage> {
  const script = [
    `$rootProcessId = ${pid}`,
    '$rows = @(Get-CimInstance Win32_Process -ErrorAction Stop | Select-Object ProcessId, ParentProcessId)',
    '$ids = [System.Collections.Generic.HashSet[int]]::new()',
    '$pending = [System.Collections.Generic.Queue[int]]::new()',
    '[void]$ids.Add($rootProcessId)',
    '$pending.Enqueue($rootProcessId)',
    'while ($pending.Count -gt 0) { $parentProcessId = $pending.Dequeue(); foreach ($row in $rows) { $childProcessId = [int]$row.ProcessId; if ([int]$row.ParentProcessId -eq $parentProcessId -and $ids.Add($childProcessId)) { $pending.Enqueue($childProcessId) } } }',
    '$rss = [int64]0',
    '$private = [int64]0',
    '$count = 0',
    'foreach ($processId in $ids) { $process = Get-Process -Id $processId -ErrorAction SilentlyContinue; if ($process) { $rss += [int64]$process.WorkingSet64; $private += [int64]$process.PrivateMemorySize64; $count += 1 } }',
    'if ($count -lt 1) { throw "Process tree is no longer running" }',
    '[pscustomobject]@{rss=$rss;private=$private;count=$count} | ConvertTo-Json -Compress',
  ].join('; ');
  const { stdout } = await execFileAsync(
    'powershell',
    ['-NoProfile', '-NonInteractive', '-Command', script],
    { timeout: 10_000, windowsHide: true, encoding: 'utf8' },
  );
  const parsed = JSON.parse(String(stdout || '{}'));
  return {
    rssBytes: Math.max(0, Number(parsed.rss) || 0),
    privateBytes: Math.max(0, Number(parsed.private) || 0),
    processCount: Math.max(1, Number(parsed.count) || 0),
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

async function collectLinuxProcessTree(rootPid: number): Promise<number[]> {
  const ids = new Set<number>([rootPid]);
  const pending = [rootPid];
  while (pending.length > 0) {
    const parentPid = pending.shift()!;
    const children = await fs.readFile(`/proc/${parentPid}/task/${parentPid}/children`, 'utf8').catch(() => '');
    for (const token of children.trim().split(/\s+/).filter(Boolean)) {
      const childPid = Number(token);
      if (Number.isInteger(childPid) && childPid > 0 && !ids.has(childPid)) {
        ids.add(childPid);
        pending.push(childPid);
      }
    }
  }
  return [...ids];
}

async function sampleLinuxProcess(pid: number): Promise<ProcessTreeUsage> {
  const ids = await collectLinuxProcessTree(pid);
  let rssBytes = 0;
  let privateBytes = 0;
  let processCount = 0;
  for (const processId of ids) {
    try {
      const usage = await sampleProcStatus(processId);
      rssBytes += usage.rssBytes;
      privateBytes += usage.privateBytes;
      processCount += 1;
    } catch {
      if (processId === pid && processCount === 0) throw new Error(`Process tree ${pid} is no longer running`);
    }
  }
  return { rssBytes, privateBytes, processCount };
}

async function samplePosixProcess(pid: number): Promise<ProcessTreeUsage> {
  if (process.platform === 'linux') return sampleLinuxProcess(pid);
  const { stdout } = await execFileAsync(
    'ps',
    ['-axo', 'pid=,ppid=,rss='],
    { timeout: 5_000, encoding: 'utf8' },
  );
  const rows = String(stdout || '').split(/\r?\n/).map(line => {
    const [processId, parentProcessId, rssKib] = line.trim().split(/\s+/).map(Number);
    return { processId, parentProcessId, rssKib };
  }).filter(row => Number.isInteger(row.processId) && Number.isInteger(row.parentProcessId));
  const ids = new Set<number>([pid]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const row of rows) {
      if (ids.has(row.parentProcessId) && !ids.has(row.processId)) {
        ids.add(row.processId);
        changed = true;
      }
    }
  }
  const matched = rows.filter(row => ids.has(row.processId));
  if (matched.length === 0) throw new Error(`Process tree ${pid} is no longer running`);
  const rssBytes = matched.reduce((sum, row) => sum + Math.max(0, row.rssKib || 0) * 1024, 0);
  return { rssBytes, privateBytes: rssBytes, processCount: matched.length };
}

export async function sampleProcessTree(pid: number): Promise<ProcessTreeUsage> {
  return process.platform === 'win32' ? sampleWindowsProcess(pid) : samplePosixProcess(pid);
}

export class SupervisedProcessResourceMonitor {
  private pid: number | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private sampling = false;
  private rssBytes = 0;
  private privateBytes = 0;
  private processCount = 0;
  private peakRssBytes = 0;
  private peakPrivateBytes = 0;
  private budgetExceededCount = 0;
  private sampledAt = '';
  private lastError = '';

  constructor(private readonly options: {
    budgetBytes: number;
    privateBudgetBytes?: number;
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
    this.processCount = 0;
  }

  private async sample(): Promise<void> {
    const pid = this.pid;
    if (!pid || this.sampling) return;
    this.sampling = true;
    try {
      const usage = await sampleProcessTree(pid);
      if (this.pid !== pid) return;
      this.rssBytes = usage.rssBytes;
      this.privateBytes = usage.privateBytes;
      this.processCount = usage.processCount;
      this.peakRssBytes = Math.max(this.peakRssBytes, usage.rssBytes);
      this.peakPrivateBytes = Math.max(this.peakPrivateBytes, usage.privateBytes);
      this.sampledAt = new Date().toISOString();
      this.lastError = '';
      const rssExceeded = this.options.budgetBytes > 0 && usage.rssBytes > this.options.budgetBytes;
      const privateExceeded = Number(this.options.privateBudgetBytes || 0) > 0
        && usage.privateBytes > Number(this.options.privateBudgetBytes);
      if (rssExceeded || privateExceeded) {
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
      processCount: this.processCount,
      rssBytes: this.rssBytes,
      privateBytes: this.privateBytes,
      peakRssBytes: this.peakRssBytes,
      peakPrivateBytes: this.peakPrivateBytes,
      budgetBytes: Math.max(0, this.options.budgetBytes),
      privateBudgetBytes: Math.max(0, Number(this.options.privateBudgetBytes || 0)),
      budgetExceededCount: this.budgetExceededCount,
      sampledAt: this.sampledAt,
      lastError: this.lastError,
    };
  }
}
