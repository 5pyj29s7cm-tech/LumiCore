import { spawn } from 'node:child_process';

export type MediaProcessErrorFactory = (code: string, message: string, status?: number) => Error;
const defaultMediaError: MediaProcessErrorFactory = (code, message, status = 400) => Object.assign(new Error(message), { code, status, statusCode: status });

/** Fixed argument arrays only; cancellation waits for the owned process to exit. */
export function runMediaProcess(binary: 'ffmpeg' | 'ffprobe', args: string[], signal?: AbortSignal, timeoutMs = 120_000, mediaError: MediaProcessErrorFactory = defaultMediaError): Promise<string> {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { shell: false, windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
    const output: Buffer[] = []; let size = 0; let failure: Error | undefined; let cleanup: Promise<void> | undefined;
    const stop = (error: Error) => {
      if (failure) return;
      failure = error;
      if (!child.pid) return;
      if (process.platform === 'win32') {
        cleanup = new Promise<void>(done => {
          const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { shell: false, windowsHide: true, stdio: 'ignore' });
          const fallback = () => { try { child.kill('SIGKILL'); } catch { /* Already stopped. */ } };
          const deadline = setTimeout(() => { killer.kill(); fallback(); }, 5000);
          killer.once('error', () => { clearTimeout(deadline); fallback(); done(); });
          killer.once('close', code => { clearTimeout(deadline); if (code !== 0) fallback(); done(); });
        });
      } else {
        try { process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch { /* Already stopped. */ } }
      }
    };
    const abort = () => stop(new DOMException('Media processing cancelled.', 'AbortError'));
    const timer = setTimeout(() => stop(mediaError('media_processing_timeout', 'Media processing timed out. Retry a shorter recording.', 503)), timeoutMs);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    child.stdout.on('data', (chunk: Buffer) => { size += chunk.length; if (size > 1024 * 1024) stop(mediaError('media_processing_output_limit', 'Media processing exceeded its output limit.')); else output.push(Buffer.from(chunk)); });
    child.stderr.on('data', (chunk: Buffer) => { size += chunk.length; if (size > 1024 * 1024) stop(mediaError('media_processing_output_limit', 'Media processing exceeded its output limit.')); });
    child.once('error', () => { failure ||= mediaError('media_tool_unavailable', `${binary} is unavailable. Install/configure the existing media tools and retry.`, 503); });
    child.once('close', async code => {
      clearTimeout(timer); signal?.removeEventListener('abort', abort); await cleanup;
      if (failure) reject(failure);
      else if (code !== 0) reject(mediaError('media_decode_failed', 'The media could not be decoded. Check the format and try another file.'));
      else resolve(Buffer.concat(output).toString('utf8'));
    });
  });
}
