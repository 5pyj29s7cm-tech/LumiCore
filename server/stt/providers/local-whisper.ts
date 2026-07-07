// local-whisper STT provider — runs faster-whisper via Python subprocess.
// No API key needed. Model (~500MB) auto-downloads on first use.
// Falls back to cloud providers if Python or the script is unavailable.

import { execFileSync, execSync } from 'child_process';
import { STTResult } from '../types';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT_PATH = path.join(__dirname, '..', 'local_whisper.py');
const SAFE_AUDIO_EXTS = new Set(['.mp3', '.mpeg', '.wav', '.m4a', '.ogg', '.oga', '.flac', '.aac', '.wma', '.webm']);

let pythonPath: string | null = null;
let checkedPython = false;

function findPython(): string | null {
  if (checkedPython) return pythonPath;
  checkedPython = true;

  const candidates = [
    path.join(process.cwd(), 'gpt-sovits-src', 'venv', 'Scripts', 'python.exe'),
    path.join(process.cwd(), '..', 'gpt-sovits-src', 'venv', 'Scripts', 'python.exe'),
    'python3', 'python',
  ];

  for (const cmd of candidates) {
    try {
      execSync(`${cmd} --version`, { stdio: 'pipe', timeout: 5000 });
      pythonPath = cmd;
      return cmd;
    } catch {}
  }
  return null;
}

export function isLocalWhisperAvailable(): boolean {
  return findPython() !== null && fs.existsSync(SCRIPT_PATH);
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

export async function transcribe(audioBuffer: Buffer, language: string = 'zh', options: LocalWhisperOptions = {}): Promise<STTResult> {
  const python = findPython();
  if (!python) throw new Error('Python not found. Local STT requires Python 3.10+.');

  if (!fs.existsSync(SCRIPT_PATH)) {
    throw new Error(`Local whisper script not found at ${SCRIPT_PATH}`);
  }

  const tmpDir = os.tmpdir();
  const audioPath = path.join(tmpDir, `lumi_stt_${Date.now()}_${Math.random().toString(36).slice(2)}${safeAudioExt(options.fileName)}`);
  fs.writeFileSync(audioPath, audioBuffer);

  try {
    const stdout = execFileSync(python, [SCRIPT_PATH, audioPath, language || 'zh'], {
      encoding: 'utf-8',
      timeout: getLocalWhisperTimeoutMs(),
      maxBuffer: 10 * 1024 * 1024,
      env: {
        ...process.env,
        KMP_DUPLICATE_LIB_OK: process.env.KMP_DUPLICATE_LIB_OK || 'TRUE',
      },
    });

    const text = stdout.trim();
    return { text, isFinal: true };
  } finally {
    try { fs.unlinkSync(audioPath); } catch {}
  }
}
