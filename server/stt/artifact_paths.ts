import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
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

export function getMeetingAudioDir(scope?: { userId?: string; domain?: string; orgId?: string }): string {
  const configured = process.env.LUMI_MEETING_AUDIO_DIR;
  let root: string;
  if (configured) root = ensureDir(path.resolve(configured));
  else {
    const projectData = cwdDataPath('meeting_audio');
    root = projectData
      ? ensureDir(projectData)
      : ensureDir(path.dirname(getDataPath(path.join('meeting_audio', '.keep'))));
  }

  if (!scope?.userId) return root;
  const identity = scope.domain === 'work' && scope.orgId
    ? `work:${scope.orgId}`
    : `personal:${scope.userId}`;
  const scopeId = crypto.createHash('sha256').update(identity).digest('hex').slice(0, 20);
  return ensureDir(path.join(root, scope.domain === 'work' ? 'work' : 'personal', scopeId));
}
