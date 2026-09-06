import fs from 'node:fs';
import { Worker } from 'node:worker_threads';
import { setTimeout as delay } from 'node:timers/promises';
import type { ToolContext } from './types';

const MAX_OUTPUT_BYTES = 128 * 1024;
const MAX_CODE_BYTES = 64 * 1024;
const MAX_WORKERS = 2;
const MAX_QUEUED = 8;
let activeWorkers = 0;
let queued = 0;

function failed(error: string, cancelled = false): string {
  return JSON.stringify({ ok: false, status: cancelled ? 'cancelled' : 'failed', output: '', error });
}

function cancelled(context?: ToolContext): boolean {
  return context?.executionSignal?.aborted === true || context?.isCancelled?.() === true;
}

function workerURL(): URL {
  const source = new URL('./javascript_sandbox_worker.cjs', import.meta.url);
  if (fs.existsSync(source)) return source;
  const bundled = new URL('./javascript-sandbox-worker.cjs', import.meta.url);
  if (fs.existsSync(bundled)) return bundled;
  throw new Error('The JavaScript calculation runtime is missing. Rebuild the backend resources.');
}

export async function executeSandboxedJavaScript(code: string, timeout: number, context?: ToolContext): Promise<string> {
  if (!code.trim()) return failed('Code is required.');
  if (Buffer.byteLength(code, 'utf8') > MAX_CODE_BYTES) return failed('Code exceeds the 64 KiB limit.');
  if (cancelled(context)) return failed('Execution cancelled.', true);
  if (queued >= MAX_QUEUED) return failed('The JavaScript calculation queue is full. Try again later.');
  const deadline = Date.now() + timeout;
  queued += 1;
  try {
    while (activeWorkers >= MAX_WORKERS) {
      if (cancelled(context)) return failed('Execution cancelled.', true);
      if (Date.now() >= deadline) return failed('Execution timed out while waiting for a calculation slot.');
      await delay(20);
    }
    if (cancelled(context)) return failed('Execution cancelled.', true);
    activeWorkers += 1;
  } finally { queued -= 1; }

  try {
    return await new Promise<string>(resolve => {
      let worker: Worker;
      try {
        worker = new Worker(workerURL(), {
          workerData: { code, deadline, maxOutputBytes: MAX_OUTPUT_BYTES },
          execArgv: [], env: {}, stdout: true, stderr: true,
          resourceLimits: { maxOldGenerationSizeMb: 64, maxYoungGenerationSizeMb: 16, stackSizeMb: 2 },
        });
      } catch { resolve(failed('The JavaScript calculation runtime could not be started.')); return; }
      let finishing = false;
      const finish = (result: string) => {
        if (finishing) return;
        finishing = true;
        clearTimeout(timer);
        clearInterval(cancellationPoll);
        context?.executionSignal?.removeEventListener('abort', onAbort);
        // Do not free a concurrency slot or settle cancellation before the
        // actual worker exits. Guest loops cannot continue after the receipt.
        void worker.terminate().then(() => resolve(result), () => resolve(failed('JavaScript worker shutdown failed.')));
      };
      const onAbort = () => finish(failed('Execution cancelled.', true));
      const timer = setTimeout(() => finish(failed('Execution timed out.')), Math.max(1, deadline - Date.now()));
      const cancellationPoll = setInterval(() => { if (cancelled(context)) onAbort(); }, 25);
      context?.executionSignal?.addEventListener('abort', onAbort, { once: true });
      worker.on('message', (result: unknown) => {
        if (cancelled(context)) { onAbort(); return; }
        if (Date.now() >= deadline) { finish(failed('Execution timed out.')); return; }
        if (typeof result !== 'string' || Buffer.byteLength(result, 'utf8') > MAX_OUTPUT_BYTES + 2048) {
          finish(failed('JavaScript result exceeded the output limit.')); return;
        }
        finish(result);
      });
      worker.on('error', () => finish(failed('JavaScript runtime exceeded its resource limit or failed.')));
      worker.on('exit', () => finish(failed('JavaScript runtime exited without a result.')));
      // No guest has access to stdout/stderr. Discard trusted runtime diagnostics
      // and cap them too, so malformed runtime failures cannot fill host buffers.
      let diagnosticBytes = 0;
      for (const stream of [worker.stdout, worker.stderr]) stream.on('data', (chunk: Buffer) => {
        diagnosticBytes += chunk.byteLength;
        if (diagnosticBytes > MAX_OUTPUT_BYTES) finish(failed('JavaScript runtime output limit exceeded.'));
      });
      if (cancelled(context)) onAbort();
    });
  } finally { activeWorkers -= 1; }
}
