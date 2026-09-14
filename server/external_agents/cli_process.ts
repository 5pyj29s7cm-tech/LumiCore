import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';

export interface CliProcessInput {
  executable: string;
  args: string[];
  cwd: string;
  input?: string;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  isCancelled?: () => boolean;
  timeoutMs: number;
  onLine?: (line: string) => void;
}
export interface CliProcessResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  failure?: 'cancelled' | 'timed_out' | 'output_limit' | 'spawn_failed';
}

/** Own the child tree until it settles; a timeout never starts another agent. */
export function runCliProcess(input: CliProcessInput): Promise<CliProcessResult> {
  if (input.signal?.aborted || input.isCancelled?.()) return Promise.resolve({ exitCode: null, stdout: '', stderr: '', failure: 'cancelled' });
  return new Promise(resolve => {
    const child = spawn(input.executable, input.args, {
      cwd: input.cwd, env: input.env, shell: false, windowsHide: true,
      detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '', stderr = '', pending = '', bytes = 0;
    let failure: CliProcessResult['failure'];
    let cleanup: Promise<void> | undefined;
    const decoder = new StringDecoder('utf8');
    const stop = (reason: NonNullable<CliProcessResult['failure']>) => {
      if (failure) return;
      failure = reason;
      if (!child.pid) return;
      if (process.platform === 'win32') {
        cleanup = new Promise<void>(done => {
          const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { shell: false, windowsHide: true, stdio: 'ignore' });
          const fallback = () => { try { child.kill('SIGKILL'); } catch {} };
          const timer = setTimeout(() => { killer.kill(); fallback(); }, 5000);
          killer.once('error', () => { clearTimeout(timer); fallback(); done(); });
          killer.once('close', code => { clearTimeout(timer); if (code !== 0) fallback(); done(); });
        });
      } else {
        try { process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch {} }
      }
    };
    const emitLine = (line: string) => { try { input.onLine?.(line); } catch { /* observers cannot orphan the process */ } };
    child.stdout.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > 8 * 1024 * 1024) { stop('output_limit'); return; }
      const value = decoder.write(chunk); stdout += value; pending += value;
      let newline: number;
      while ((newline = pending.indexOf('\n')) >= 0) {
        emitLine(pending.slice(0, newline)); pending = pending.slice(newline + 1);
      }
    });
    child.stderr.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > 8 * 1024 * 1024) { stop('output_limit'); return; }
      stderr = (stderr + chunk.toString('utf8')).slice(-16000);
    });
    const onAbort = () => stop('cancelled');
    const deadline = setTimeout(() => stop('timed_out'), input.timeoutMs);
    const poll = setInterval(() => { if (input.isCancelled?.()) onAbort(); }, 200);
    input.signal?.addEventListener('abort', onAbort, { once: true });
    if (input.signal?.aborted) onAbort();
    child.once('error', error => { failure ||= 'spawn_failed'; stderr = error.message; });
    // EPIPE is normal if authentication/configuration fails before stdin is read.
    child.stdin.on('error', () => {});
    child.stdin.end(input.input || '');
    child.once('close', async exitCode => {
      clearTimeout(deadline); clearInterval(poll); input.signal?.removeEventListener('abort', onAbort);
      pending += decoder.end(); if (pending.trim()) emitLine(pending);
      await cleanup;
      resolve({ exitCode, stdout, stderr, ...(failure ? { failure } : {}) });
    });
  });
}
