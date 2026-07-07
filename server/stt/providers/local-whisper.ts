// local-whisper STT provider — runs faster-whisper via Python subprocess.
// No API key needed. Model (~500MB) auto-downloads on first use.
// Falls back to cloud providers if Python or the script is unavailable.

import { execFileSync } from 'child_process';
import { STTResult } from '../types';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT_PATH = path.join(__dirname, '..', 'local_whisper.py');
const SAFE_AUDIO_EXTS = new Set(['.mp3', '.mpeg', '.wav', '.m4a', '.ogg', '.oga', '.flac', '.aac', '.wma', '.webm']);

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
    path.join(process.cwd(), 'gpt-sovits-src', 'venv', 'Scripts', 'python.exe'),
    path.join(process.cwd(), '..', 'gpt-sovits-src', 'venv', 'Scripts', 'python.exe'),
    path.join(process.cwd(), '.venv', 'Scripts', 'python.exe'),
    'python3', 'python',
  ];
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

export function isLocalWhisperAvailable(): boolean {
  return findPythonCandidates().length > 0 && fs.existsSync(SCRIPT_PATH);
}

interface LocalWhisperOptions {
  fileName?: string;
}

function safeAudioExt(fileName?: string): string {
  const ext = path.extname(String(fileName || '')).toLowerCase();
  return SAFE_AUDIO_EXTS.has(ext) ? ext : '.wav';
}

function getLocalWhisperTimeoutMs(): number {
  const configured = Number(process.env.LUMI_LOCAL_WHISPER_TIMEOUT_MS || '');
  if (Number.isFinite(configured) && configured > 0) return Math.max(30_000, configured);
  return 10 * 60 * 1000;
}

function formatPythonFailure(err: any): string {
  const stderr = Buffer.isBuffer(err?.stderr) ? err.stderr.toString('utf-8') : String(err?.stderr || '');
  const stdout = Buffer.isBuffer(err?.stdout) ? err.stdout.toString('utf-8') : String(err?.stdout || '');
  const message = String(err?.message || err || '').trim();
  return (stderr || stdout || message || 'unknown error').replace(/\s+/g, ' ').slice(0, 600);
}

export async function transcribe(audioBuffer: Buffer, language: string = 'zh', options: LocalWhisperOptions = {}): Promise<STTResult> {
  const pythons = findPythonCandidates();
  if (pythons.length === 0) throw new Error('Python not found. Local STT requires Python 3.10+.');

  if (!fs.existsSync(SCRIPT_PATH)) {
    throw new Error(`Local whisper script not found at ${SCRIPT_PATH}`);
  }

  const tmpDir = os.tmpdir();
  const audioPath = path.join(tmpDir, `lumi_stt_${Date.now()}_${Math.random().toString(36).slice(2)}${safeAudioExt(options.fileName)}`);
  fs.writeFileSync(audioPath, audioBuffer);

  const failures: string[] = [];
  try {
    for (const python of pythons) {
      try {
        const stdout = execFileSync(python, [SCRIPT_PATH, audioPath, language || 'zh'], {
          encoding: 'utf-8',
          timeout: getLocalWhisperTimeoutMs(),
          maxBuffer: 10 * 1024 * 1024,
          env: getPythonEnv(),
        });

        const text = stdout.trim();
        if (!text) throw new Error('Local Whisper returned an empty transcript');
        return { text, isFinal: true };
      } catch (err: any) {
        failures.push(`${python}: ${formatPythonFailure(err)}`);
      }
    }
  } finally {
    try { fs.unlinkSync(audioPath); } catch {}
  }

  throw new Error(`Local Whisper failed with ${pythons.length} Python runtime(s): ${failures.join('; ')}`);
}
