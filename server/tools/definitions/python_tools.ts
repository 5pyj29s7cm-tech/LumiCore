import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { ToolRegistry } from '../registry';
import { capabilityContract, capabilityEvidence } from '../capability_contracts';
import { getGeneratedOutputDir } from '../../config/data_path';
import type { ToolContext } from '../types';

const OUTPUT_DIR = getGeneratedOutputDir();
const IMAGE_EXTS = /\.(png|jpg|jpeg|svg|gif|webp)$/i;

// These tools share one interpreter environment and image output directory.
// Preserve their execution order without blocking the server's event loop.
const pythonJobs: Array<() => void> = [];
let pythonJobRunning = false;

function startNextPythonJob(): void {
  if (pythonJobRunning) return;
  const next = pythonJobs.shift();
  if (!next) return;
  pythonJobRunning = true;
  next();
}

function withPythonTurn<T>(operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  if (signal?.aborted) return Promise.reject(new Error('Python process cancelled before starting.'));
  return new Promise<T>((resolve, reject) => {
    const cancelQueued = () => {
      const index = pythonJobs.indexOf(start);
      if (index < 0) return;
      pythonJobs.splice(index, 1);
      signal?.removeEventListener('abort', cancelQueued);
      reject(new Error('Python process cancelled before starting.'));
    };
    const release = () => {
      pythonJobRunning = false;
      startNextPythonJob();
    };
    const start = () => {
      signal?.removeEventListener('abort', cancelQueued);
      if (signal?.aborted) {
        reject(new Error('Python process cancelled before starting.'));
        release();
        return;
      }
      let pending: Promise<T>;
      try { pending = operation(); }
      catch (error) { reject(error); release(); return; }
      pending.then(
        value => { resolve(value); release(); },
        error => { reject(error); release(); },
      );
    };
    pythonJobs.push(start);
    signal?.addEventListener('abort', cancelQueued, { once: true });
    startNextPythonJob();
  });
}

function ensureOutputDir() {
  if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });
}

function snapshotImages(): Set<string> {
  return new Set(fs.readdirSync(OUTPUT_DIR).filter(f => IMAGE_EXTS.test(f)));
}

function detectNewImages(before: Set<string>): string[] {
  const after = fs.readdirSync(OUTPUT_DIR).filter(f => IMAGE_EXTS.test(f));
  return after.filter(f => !before.has(f));
}

function formatImages(images: string[]): string {
  return images.map(img => {
    const stat = fs.statSync(path.join(OUTPUT_DIR, img));
    const sizeKB = (stat.size / 1024).toFixed(1);
    return `![${img}](/lumi_output/${img})\n*${img} · ${sizeKB} KB*`;
  }).join('\n\n');
}

const WRAP_HEADER = `import os
os.environ['MPLBACKEND'] = 'Agg'
_output_dir = r"${OUTPUT_DIR.replace(/\\/g, '\\\\')}"
os.chdir(_output_dir)

`;

/** Await process settlement so cancellation never deletes a still-running script. */
function runPythonProcess(args: string[], timeoutMs: number, maxBytes: number, signal?: AbortSignal): Promise<string> {
  if (signal?.aborted) return Promise.reject(new Error('Python process cancelled before starting.'));
  return new Promise((resolve, reject) => {
    const child = spawn('python', args, {
      shell: false,
      windowsHide: true,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, MPLBACKEND: 'Agg', PYTHONIOENCODING: 'utf-8' },
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let bytes = 0;
    let failure: Error | undefined;
    let cleanup: Promise<void> | undefined;
    const stop = (error: Error) => {
      if (failure) return;
      failure = error;
      if (!child.pid) return;
      if (process.platform === 'win32') {
        cleanup = new Promise<void>(done => {
          const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, shell: false, stdio: 'ignore' });
          const fallback = () => { try { child.kill('SIGKILL'); } catch {} };
          const deadline = setTimeout(() => { killer.kill(); fallback(); }, 5000);
          killer.once('error', () => { clearTimeout(deadline); fallback(); done(); });
          killer.once('close', code => { clearTimeout(deadline); if (code !== 0) fallback(); done(); });
        });
      } else {
        try { process.kill(-child.pid, 'SIGKILL'); }
        catch { try { child.kill('SIGKILL'); } catch {} }
      }
    };
    const onAbort = () => stop(new Error('Python process cancelled.'));
    const timer = setTimeout(() => stop(new Error(`Python process timed out after ${timeoutMs}ms.`)), timeoutMs);
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
    const collect = (chunks: Buffer[]) => (chunk: Buffer) => {
      if (failure) return;
      bytes += chunk.length;
      if (bytes > maxBytes) { stop(new Error(`Python process output exceeded ${maxBytes} bytes.`)); return; }
      chunks.push(Buffer.from(chunk));
    };
    child.stdout!.on('data', collect(stdout));
    child.stderr!.on('data', collect(stderr));
    child.once('error', error => { failure ||= error; });
    child.once('close', async (code, terminationSignal) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      await cleanup;
      if (failure) { reject(failure); return; }
      if (code !== 0) {
        reject(new Error(Buffer.concat(stderr).toString('utf8').slice(0, 2000)
          || `Python process exited with ${terminationSignal || code}.`));
        return;
      }
      resolve(Buffer.concat(stdout).toString('utf8'));
    });
  });
}

async function pythonExec(args: Record<string, any>, context?: ToolContext): Promise<string> {
  const code = String(args.code || '');
  const timeout = Math.min(Math.max(Number(args.timeout) || 30000, 5000), 120000);
  if (!code.trim()) throw new Error('Code is required.');

  ensureOutputDir();
  const before = snapshotImages();

  const scriptId = `py_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  const scriptPath = path.join(OUTPUT_DIR, `${scriptId}.py`);
  fs.writeFileSync(scriptPath, WRAP_HEADER + code, 'utf-8');

  try {
    const stdout = await runPythonProcess([scriptPath], timeout, 10 * 1024 * 1024, context?.executionSignal);

    const newImages = detectNewImages(before);
    const artifacts = newImages.map(image => ({ type: 'image', path: path.join(OUTPUT_DIR, image) }));
    return JSON.stringify({
      ok: true,
      status: 'completed',
      exitCode: 0,
      stdout: stdout.trim(),
      artifacts,
    });
  } catch (err: any) {
    const newImages = detectNewImages(before);
    const errorMsg = err.stderr || err.message || String(err);
    const partialArtifacts = newImages.map(image => path.join(OUTPUT_DIR, image));
    const partial = partialArtifacts.length > 0 ? ` Partial artifacts: ${partialArtifacts.join(', ')}.` : '';
    throw new Error(`Python execution failed: ${String(errorMsg).slice(0, 2000)}.${partial}`);
  } finally {
    try { fs.unlinkSync(scriptPath); } catch {}
  }
}

async function pythonPackageInstall(args: Record<string, any>, context?: ToolContext): Promise<string> {
  const pkg = String(args.package || '').trim();
  if (!pkg) throw new Error('Package name is required.');

  const safePkg = /^[a-zA-Z0-9_.-]+$/.test(pkg) ? pkg : null;
  if (!safePkg) throw new Error(`Invalid package name: ${pkg}`);

  try {
    const stdout = await runPythonProcess(['-m', 'pip', 'install', safePkg], 60000, 1024 * 1024, context?.executionSignal);
    const alreadyInstalled = stdout.includes('already satisfied');
    return JSON.stringify({
      ok: true,
      status: alreadyInstalled ? 'already_installed' : 'installed',
      package: safePkg,
      stdout: stdout.trim().slice(-800),
    });
  } catch (err: any) {
    const msg = err.stderr || err.message || String(err);
    throw new Error(`Failed to install ${safePkg}: ${String(msg).slice(0, 2000)}`);
  }
}

export function registerPythonTools(registry: ToolRegistry): void {
  registry.register({
    name: 'python_exec',
    description:
      'Execute Python 3.10 code in the active Python environment. Common libraries such as matplotlib, seaborn, plotly, pandas, and Pillow can be used when installed. Use this to generate charts, plots, data visualizations, statistical graphics, and image processing. To display a chart in chat, save it with `plt.savefig(\'filename.png\')` — saved images are automatically captured and shown. The matplotlib backend is configured as Agg (no GUI needed) without importing matplotlib for non-plotting tasks. Working directory is lumi_output/. Use `plt.savefig(\'chart.png\', dpi=100, bbox_inches=\'tight\')` for best results. For plotly, use `fig.write_image(\'chart.png\')` or `fig.write_html(\'chart.html\')`.',
    parameters: {
      type: 'object',
      properties: {
        code: { type: 'string', description: 'Python code to execute. Import the libraries you need; availability follows the active Python environment.' },
        timeout: { type: 'number', description: 'Timeout in milliseconds (default 30000, max 120000).' },
      },
      required: ['code'],
    },
    handler: (args, context) => withPythonTurn(() => pythonExec(args, context), context?.executionSignal),
    permission: 'user',
    securityLevel: 'confirm',
    capability: capabilityContract({
      id: 'system.python.execute',
      family: 'code-execution',
      lane: 'system',
      operation: 'mutate',
      risk: 'high',
      sideEffects: [
        { type: 'process_execution', scope: 'local Python interpreter', reversible: false },
        { type: 'local_write', scope: 'Python-generated outputs in Lumi output directory', reversible: true },
      ],
      verification: {
        strategy: 'terminal_receipt',
        required: true,
        requiredFields: ['ok', 'status', 'exitCode', 'artifacts'],
        requiredValues: { ok: true, status: 'completed', exitCode: 0 },
        successStatuses: ['completed'],
        failureStatuses: ['failed', 'timed_out'],
        successSignals: ['Python process exits with code zero'],
        limitations: ['Process success does not validate the semantic correctness of arbitrary user code output.'],
      },
    }),
    evidence: capabilityEvidence({
      id: 'system.python.execute',
      operation: 'mutate',
      subjectArgument: 'code',
      limitations: ['Exit code zero is execution evidence, not proof that arbitrary output satisfies the task.'],
    }),
  });

  registry.register({
    name: 'python_pip_install',
    description:
      'Install a Python package via pip into the active Python environment. Use this when the user needs a library that is not already available.',
    parameters: {
      type: 'object',
      properties: {
        package: { type: 'string', description: 'The pip package name to install.' },
      },
      required: ['package'],
    },
    handler: (args, context) => withPythonTurn(() => pythonPackageInstall(args, context), context?.executionSignal),
    permission: 'user',
    securityLevel: 'confirm',
    capability: capabilityContract({
      id: 'system.python.package.install',
      family: 'package-management',
      lane: 'system',
      operation: 'mutate',
      risk: 'high',
      sideEffects: [
        { type: 'installation', scope: 'active Python environment', reversible: true },
        { type: 'process_execution', scope: 'pip package installer', reversible: false },
        { type: 'network_read', scope: 'configured Python package index', reversible: true },
      ],
      verification: {
        strategy: 'terminal_receipt',
        required: true,
        requiredFields: ['ok', 'status', 'package'],
        requiredValues: { ok: true },
        successStatuses: ['installed', 'already_installed'],
        failureStatuses: ['failed'],
        successSignals: ['pip exits successfully for the exact validated package name'],
        limitations: ['Installer success does not prove the package imports correctly in every runtime.'],
      },
    }),
    evidence: capabilityEvidence({
      id: 'system.python.package.install',
      operation: 'mutate',
      subjectArgument: 'package',
      limitations: ['Package import compatibility must be verified separately when required.'],
    }),
  });
}
