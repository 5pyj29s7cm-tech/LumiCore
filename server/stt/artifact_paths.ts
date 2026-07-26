import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { getDataDirectory } from '../config/data_path';

function ensureDir(dir: string): string {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function getSttArtifactRoot(): string {
  const configured = process.env.LUMI_STT_DATA_DIR || process.env.LUMI_WHISPER_DATA_DIR;
  if (configured) return ensureDir(path.resolve(configured));

  return getDataDirectory('stt');
}

export function getWhisperModelDir(): string {
  const configured = process.env.WHISPER_MODEL_DIR || process.env.LUMI_WHISPER_MODEL_DIR;
  if (configured) return ensureDir(path.resolve(configured));

  return ensureDir(path.join(getSttArtifactRoot(), 'whisper_models'));
}

export function getMeetingAudioDir(scope?: { userId?: string; domain?: string; orgId?: string }): string {
  const configured = process.env.LUMI_MEETING_AUDIO_DIR;
  let root: string;
  if (configured) root = ensureDir(path.resolve(configured));
  else root = getDataDirectory('meeting_audio');

  if (!scope?.userId) return root;
  const identity = scope.domain === 'work' && scope.orgId
    ? `work:${scope.orgId}`
    : `personal:${scope.userId}`;
  const scopeId = crypto.createHash('sha256').update(identity).digest('hex').slice(0, 20);
  return ensureDir(path.join(root, scope.domain === 'work' ? 'work' : 'personal', scopeId));
}
