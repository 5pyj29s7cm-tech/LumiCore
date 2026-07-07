// local-whisper STT provider — runs faster-whisper via Python subprocess.
// No API key needed. Model (~500MB) auto-downloads on first use.
// Falls back to cloud providers if Python or the script is unavailable.

import { execFileSync, spawn } from 'child_process';
import { STTResult } from '../types';
import { getSttArtifactRoot, getWhisperModelDir } from '../artifact_paths';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT_PATH = path.join(__dirname, '..', 'local_whisper.py');
const SAFE_AUDIO_EXTS = new Set(['.mp3', '.mpeg', '.wav', '.m4a', '.ogg', '.oga', '.flac', '.aac', '.wma', '.webm']);
const STT_ARTIFACT_ROOT = getSttArtifactRoot();
const MANAGED_VENV_DIR = path.join(STT_ARTIFACT_ROOT, 'faster-whisper-venv');
const MANAGED_PYTHON = path.join(MANAGED_VENV_DIR, 'Scripts', 'python.exe');
const LEGACY_MANAGED_PYTHON = path.join(os.homedir(), 'LumiOS', 'data', 'stt', 'faster-whisper-venv', 'Scripts', 'python.exe');

let pythonCandidates: string[] | null = null;

function splitConfiguredPython(value?: string): string[] {
  return String(value || '')
    .split(/[;\r\n]/)
    .map(item => item.trim())
    .filter(Boolean);
}

function buildPythonCandidates(): string[] {
  const candidates = [
    ...splitConfiguredPython(process.env.LUMI_LOCAL_WHISPER_PYTHON),
    ...splitConfiguredPython(process.env.LUMI_VOICEPRINT_PYTHON),
    MANAGED_PYTHON,
    LEGACY_MANAGED_PYTHON,
    path.join(process.cwd(), '.venv', 'Scripts', 'python.exe'),
  ];
  if (process.env.LUMI_ALLOW_SYSTEM_STT_PYTHON === '1') {
    candidates.push('python3', 'python');
  }
  if (process.env.LUMI_ALLOW_GPTSOVITS_STT_PYTHON === '1') {
    candidates.push(
      path.join(process.cwd(), 'gpt-sovits-src', 'venv', 'Scripts', 'python.exe'),
      path.join(process.cwd(), '..', 'gpt-sovits-src', 'venv', 'Scripts', 'python.exe'),
    );
  }
  return [...new Set(candidates.filter(Boolean))];
}

function getPythonEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    KMP_DUPLICATE_LIB_OK: 'TRUE',
    KMP_WARNINGS: 'FALSE',
    MKL_NUM_THREADS: process.env.MKL_NUM_THREADS || '1',
    OMP_NUM_THREADS: process.env.OMP_NUM_THREADS || '1',
    PYTHONIOENCODING: 'utf-8',
    PYTHONUTF8: '1',
    PYTHONUNBUFFERED: '1',
    LUMI_STT_DATA_DIR: STT_ARTIFACT_ROOT,
    WHISPER_MODEL_DIR: getWhisperModelDir(),
  };
}

function findPythonCandidates(): string[] {
  if (pythonCandidates) return pythonCandidates;
  pythonCandidates = [];
  const candidates = buildPythonCandidates();
  for (const cmd of candidates) {
    try {
      execFileSync(cmd, ['--version'], {
        encoding: 'utf-8',
        stdio: 'pipe',
        timeout: 5000,
        env: getPythonEnv(),
      });
      pythonCandidates.push(cmd);
    } catch {}
  }
  return pythonCandidates;
}

function pythonVersion(cmd: string): { major: number; minor: number } | null {
  try {
    const stdout = execFileSync(cmd, ['-c', 'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}")'], {
      encoding: 'utf-8',
      stdio: 'pipe',
      timeout: 5000,
      env: getPythonEnv(),
    }).trim();
    const match = /^(\d+)\.(\d+)/.exec(stdout);
    if (!match) return null;
    return { major: Number(match[1]), minor: Number(match[2]) };
  } catch {
    return null;
  }
}

function isSupportedPython(cmd: string): boolean {
  if (/WindowsApps/i.test(cmd)) return false;
  const version = pythonVersion(cmd);
  if (!version) return false;
  return version.major > 3 || (version.major === 3 && version.minor >= 10);
}

function findBootstrapPython(): string | null {
  const candidates = [
    ...splitConfiguredPython(process.env.LUMI_STT_BOOTSTRAP_PYTHON),
    'python3',
    'python',
  ];
  for (const cmd of [...new Set(candidates.filter(Boolean))]) {
    if (isSupportedPython(cmd)) return cmd;
  }
  return null;
}

function ensureManagedPython(): string | null {
  if (process.env.LUMI_LOCAL_WHISPER_MANAGED_VENV === '0') return null;
  if (fs.existsSync(MANAGED_PYTHON)) return MANAGED_PYTHON;
  const bootstrap = findBootstrapPython();
  if (!bootstrap) return null;
  fs.mkdirSync(path.dirname(MANAGED_VENV_DIR), { recursive: true });
  execFileSync(bootstrap, ['-m', 'venv', MANAGED_VENV_DIR], {
    encoding: 'utf-8',
    stdio: 'pipe',
    timeout: 120_000,
    env: getPythonEnv(),
  });
  pythonCandidates = null;
  return fs.existsSync(MANAGED_PYTHON) ? MANAGED_PYTHON : null;
}

export function isLocalWhisperAvailable(): boolean {
  if (!fs.existsSync(SCRIPT_PATH)) return false;
  if (findPythonCandidates().length > 0) return true;
  return Boolean(findBootstrapPython());
}

interface LocalWhisperOptions {
  fileName?: string;
  onProgress?: (message: string) => void;
}

function safeAudioExt(fileName?: string): string {
  const ext = path.extname(String(fileName || '')).toLowerCase();
  return SAFE_AUDIO_EXTS.has(ext) ? ext : '.wav';
}

function getLocalWhisperTimeoutMs(): number {
  const configured = Number(process.env.LUMI_LOCAL_WHISPER_TIMEOUT_MS || '');
  if (Number.isFinite(configured) && configured > 0) return Math.max(30_000, configured);
  const model = String(process.env.LUMI_WHISPER_MODEL || 'large-v3,medium,small').toLowerCase();
  if (model.includes('large')) return 45 * 60 * 1000;
  if (model.includes('medium')) return 25 * 60 * 1000;
  return 10 * 60 * 1000;
}

function bufferText(value: unknown): string {
  return Buffer.isBuffer(value) ? value.toString('utf-8') : String(value || '');
}

function formatPythonFailure(err: any): string {
  const stderr = bufferText(err?.stderr);
  const stdout = bufferText(err?.stdout);
  const message = String(err?.message || err || '').trim();
  return (stderr || stdout || message || 'unknown error').replace(/\s+/g, ' ').slice(0, 600);
}

function parseUsedModel(stderr: string): string | undefined {
  const match = /\[local_whisper\]\s+Used model:\s*([^\r\n]+)/i.exec(stderr);
  const model = match?.[1]?.trim();
  return model ? `faster-whisper-${model}` : undefined;
}

function progressFromPythonLine(line: string): string | null {
  const clean = line.replace(/^python\.exe\s*:\s*/i, '').trim();
  if (!clean.includes('[local_whisper]')) return null;
  if (/Loading model/i.test(clean)) return clean.replace('[local_whisper]', '本地 Whisper');
  if (/Skipping uncached/i.test(clean)) return clean.replace('[local_whisper]', '本地 Whisper');
  if (/Used model/i.test(clean)) return clean.replace('[local_whisper]', '本地 Whisper');
  if (/Detected language/i.test(clean)) return clean.replace('[local_whisper]', '本地 Whisper');
  if (/failed|All model attempts failed/i.test(clean)) return clean.replace('[local_whisper]', '本地 Whisper');
  return null;
}

function runPythonTranscriber(
  python: string,
  audioPath: string,
  language: string,
  timeoutMs: number,
  onProgress?: (message: string) => void,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(python, [SCRIPT_PATH, audioPath, language || 'zh'], {
      env: getPythonEnv(),
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let stderrTail = '';
    let settled = false;
    let lastHeartbeat = Date.now();
    const maxBuffer = 10 * 1024 * 1024;

    const cleanup = () => {
      if (timeout) clearTimeout(timeout);
      if (heartbeat) clearInterval(heartbeat);
    };
    const finishError = (err: any) => {
      if (settled) return;
      settled = true;
      cleanup();
      err.stdout = stdout;
      err.stderr = stderr;
      reject(err);
    };
    const timeout = setTimeout(() => {
      try { child.kill(); } catch {}
      finishError(new Error(`Local Whisper timed out after ${Math.round(timeoutMs / 1000)}s`));
    }, timeoutMs);
    const heartbeat = setInterval(() => {
      const elapsedSeconds = Math.max(1, Math.round((Date.now() - lastHeartbeat) / 1000));
      onProgress?.(`本地 Whisper 仍在转写中，已等待 ${elapsedSeconds} 秒`);
    }, 45_000);

    child.stdout?.on('data', chunk => {
      stdout += bufferText(chunk);
      if (stdout.length > maxBuffer) {
        try { child.kill(); } catch {}
        finishError(new Error('Local Whisper output exceeded the maximum buffer'));
      }
    });

    child.stderr?.on('data', chunk => {
      const text = bufferText(chunk);
      stderr += text;
      stderrTail += text;
      const parts = stderrTail.split(/\r?\n/);
      stderrTail = parts.pop() || '';
      for (const part of parts) {
        const progress = progressFromPythonLine(part);
        if (progress) {
          lastHeartbeat = Date.now();
          onProgress?.(progress);
        }
      }
      if (stderr.length > maxBuffer) stderr = stderr.slice(-maxBuffer);
    });

    child.on('error', finishError);
    child.on('close', code => {
      if (settled) return;
      settled = true;
      cleanup();
      const tailProgress = progressFromPythonLine(stderrTail);
      if (tailProgress) onProgress?.(tailProgress);
      if (code !== 0) {
        const err: any = new Error(`Local Whisper exited with code ${code ?? 'unknown'}`);
        err.stdout = stdout;
        err.stderr = stderr;
        reject(err);
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

export async function transcribe(audioBuffer: Buffer, language: string = 'zh', options: LocalWhisperOptions = {}): Promise<STTResult> {
  options.onProgress?.('准备本地 Whisper 转写环境');
  ensureManagedPython();
  const pythons = findPythonCandidates();
  if (pythons.length === 0) throw new Error('Python not found. Local STT requires Python 3.10+.');

  if (!fs.existsSync(SCRIPT_PATH)) {
    throw new Error(`Local whisper script not found at ${SCRIPT_PATH}`);
  }

  const tmpDir = path.join(STT_ARTIFACT_ROOT, 'tmp');
  fs.mkdirSync(tmpDir, { recursive: true });
  const audioPath = path.join(tmpDir, `lumi_stt_${Date.now()}_${Math.random().toString(36).slice(2)}${safeAudioExt(options.fileName)}`);
  fs.writeFileSync(audioPath, audioBuffer);

  const failures: string[] = [];
  try {
    for (const python of pythons) {
      try {
        options.onProgress?.(`启动本地 Python 转写进程：${path.basename(python)}`);
        const result = await runPythonTranscriber(python, audioPath, language || 'zh', getLocalWhisperTimeoutMs(), options.onProgress);
        const text = String(result.stdout || '').trim();
        if (!text) throw new Error('Local Whisper returned an empty transcript');
        return { text, isFinal: true, model: parseUsedModel(String(result.stderr || '')) };
      } catch (err: any) {
        failures.push(`${python}: ${formatPythonFailure(err)}`);
      }
    }
  } finally {
    try { fs.unlinkSync(audioPath); } catch {}
  }

  throw new Error(`Local Whisper failed with ${pythons.length} Python runtime(s): ${failures.join('; ')}`);
}
