import fs from 'fs';
import path from 'path';
import { getDataPath } from '../config/data_path';

function cwdDataPath(...parts: string[]): string | null {
  const cwd = process.cwd();
  const root = path.parse(cwd).root.toLowerCase();
  if (process.platform === 'win32' && root && !root.startsWith('c:')) {
    return path.join(cwd, 'data', ...parts);
  }
  return null;
}

function ensureDir(dir: string): string {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function getSttArtifactRoot(): string {
  const configured = process.env.LUMI_STT_DATA_DIR || process.env.LUMI_WHISPER_DATA_DIR;
  if (configured) return ensureDir(path.resolve(configured));

  const projectData = cwdDataPath('stt');
  if (projectData) return ensureDir(projectData);

  return ensureDir(path.dirname(getDataPath(path.join('stt', '.keep'))));
}

export function getWhisperModelDir(): string {
  const configured = process.env.WHISPER_MODEL_DIR || process.env.LUMI_WHISPER_MODEL_DIR;
  if (configured) return ensureDir(path.resolve(configured));

  const projectData = cwdDataPath('whisper_models');
  if (projectData) return ensureDir(projectData);

  return ensureDir(path.join(getSttArtifactRoot(), 'whisper_models'));
}

export function getMeetingAudioDir(): string {
  const configured = process.env.LUMI_MEETING_AUDIO_DIR;
  if (configured) return ensureDir(path.resolve(configured));

  const projectData = cwdDataPath('meeting_audio');
  if (projectData) return ensureDir(projectData);

  return ensureDir(path.dirname(getDataPath(path.join('meeting_audio', '.keep'))));
}
