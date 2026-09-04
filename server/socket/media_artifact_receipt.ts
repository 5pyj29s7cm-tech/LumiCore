export type MediaArtifactReceiptKind = 'image' | 'video';

export type MediaArtifactReceipt = {
  version: 1;
  verified: true;
  verificationStatus: 'verified';
  toolName: 'generate_image' | 'ai_edit_image' | 'generate_video';
  settings: {
    size?: string;
    count?: number;
    duration?: number;
    hasReference: boolean;
    hasSource?: boolean;
  };
  artifacts: Array<{
    kind: MediaArtifactReceiptKind;
    path?: string;
    url?: string;
  }>;
};

const MEDIA_TOOL_KIND = new Map<string, MediaArtifactReceiptKind>([
  ['generate_image', 'image'],
  ['ai_edit_image', 'image'],
  ['generate_video', 'video'],
]);
const MAX_ARTIFACTS = 4;
const MAX_LOCAL_PATH_LENGTH = 2048;
const FAILED_MEDIA_RESULT_STATUS_RE = /^(?:failed|failure|error|errored|timed_out|timeout|cancelled|canceled|aborted|blocked|rejected)$/i;

function parseResult(result: unknown): Record<string, any> | null {
  if (result && typeof result === 'object') return result as Record<string, any>;
  if (typeof result !== 'string' || !result.trim()) return null;
  try {
    const parsed = JSON.parse(result);
    return parsed && typeof parsed === 'object' ? parsed as Record<string, any> : null;
  } catch {
    return null;
  }
}

function safeArtifactLocation(value: unknown): { path?: string; url?: string } | null {
  const location = typeof value === 'string' ? value.trim() : '';
  if (!location || /^data:/i.test(location)) return null;
  if (/^[A-Za-z]:[\\/]/.test(location) || location.startsWith('/')) {
    return location.length <= MAX_LOCAL_PATH_LENGTH ? { path: location } : null;
  }
  return null;
}

export function sanitizeMediaArtifactReceipt(value: unknown): MediaArtifactReceipt | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const candidate = value as Record<string, any>;
  const kind = MEDIA_TOOL_KIND.get(String(candidate.toolName || ''));
  if (
    candidate.version !== 1
    || candidate.verified !== true
    || candidate.verificationStatus !== 'verified'
    || !kind
    || !Array.isArray(candidate.artifacts)
  ) return undefined;
  const artifacts: MediaArtifactReceipt['artifacts'] = [];
  const seen = new Set<string>();
  for (const artifact of candidate.artifacts) {
    if (!artifact || typeof artifact !== 'object' || artifact.kind !== kind) continue;
    const location = safeArtifactLocation(artifact.path || artifact.url);
    if (!location) continue;
    const key = String(location.path || location.url).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    artifacts.push({ kind, ...location });
    if (artifacts.length >= MAX_ARTIFACTS) break;
  }
  if (artifacts.length === 0) return undefined;
  const rawSettings = candidate.settings && typeof candidate.settings === 'object'
    ? candidate.settings as Record<string, unknown>
    : {};
  const size = String(rawSettings.size || '').trim().slice(0, 40) || undefined;
  const count = Number(rawSettings.count);
  const duration = Number(rawSettings.duration);
  return {
    version: 1,
    verified: true,
    verificationStatus: 'verified',
    toolName: candidate.toolName,
    settings: {
      ...(size ? { size } : {}),
      ...(kind === 'image' && Number.isInteger(count) ? { count: Math.min(4, Math.max(1, count)) } : {}),
      ...(kind === 'video' && Number.isFinite(duration) ? { duration: Math.min(120, Math.max(1, duration)) } : {}),
      hasReference: rawSettings.hasReference === true,
      ...(candidate.toolName === 'ai_edit_image' && typeof rawSettings.hasSource === 'boolean'
        ? { hasSource: rawSettings.hasSource }
        : {}),
    },
    artifacts,
  };
}

/**
 * Derive the minimum media artifact payload needed by the authenticated UI.
 * The normal tool result remains bounded for diagnostics; prompts, base64
 * bodies, provider metadata, and unrelated fields never enter this receipt.
 */
export function buildMediaArtifactReceipt(
  toolName: string,
  args: unknown,
  result: unknown,
  error?: unknown,
): MediaArtifactReceipt | undefined {
  const kind = MEDIA_TOOL_KIND.get(String(toolName || ''));
  if (!kind || error) return undefined;
  const payload = parseResult(result);
  if (
    !payload
    || payload.ok === false
    || payload.success === false
    || payload.verified !== true
    || payload.verificationStatus !== 'verified'
    || Boolean(payload.error)
    || FAILED_MEDIA_RESULT_STATUS_RE.test(String(payload.status || '').trim())
  ) {
    return undefined;
  }

  const candidates: unknown[] = [];
  if (Array.isArray(payload.artifacts)) {
    for (const artifact of payload.artifacts) {
      if (typeof artifact === 'string') candidates.push(artifact);
      else if (artifact && typeof artifact === 'object') {
        candidates.push(artifact.path || artifact.url || artifact.outputPath || artifact.output_path);
      }
    }
  }
  if (Array.isArray(payload.images)) {
    for (const image of payload.images) {
      if (typeof image === 'string') candidates.push(image);
      else if (image && typeof image === 'object') candidates.push(image.path || image.url);
    }
  }
  if (Array.isArray(payload.outputPaths)) candidates.push(...payload.outputPaths);
  candidates.push(payload.outputPath, payload.output_path, payload.image_url, payload.video_url, payload.videoUrl);

  const artifacts: MediaArtifactReceipt['artifacts'] = [];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    const location = safeArtifactLocation(candidate);
    if (!location) continue;
    const key = String(location.path || location.url).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    artifacts.push({ kind, ...location });
    if (artifacts.length >= MAX_ARTIFACTS) break;
  }
  if (artifacts.length === 0) return undefined;

  const parameters = args && typeof args === 'object' ? args as Record<string, unknown> : {};
  const size = String(parameters.size || '').trim().slice(0, 40) || undefined;
  const count = Number(parameters.n);
  const duration = Number(parameters.duration);

  return sanitizeMediaArtifactReceipt({
    version: 1,
    verified: true,
    verificationStatus: 'verified',
    toolName: toolName as MediaArtifactReceipt['toolName'],
    settings: {
      ...(size ? { size } : {}),
      ...(kind === 'image' && Number.isInteger(count) ? { count } : {}),
      ...(kind === 'video' && Number.isFinite(duration) ? { duration } : {}),
      hasReference: Boolean(String(parameters.first_frame_image || '').trim()),
      ...(toolName === 'ai_edit_image'
        ? { hasSource: Boolean(String(parameters.filePath || '').trim()) }
        : {}),
    },
    artifacts,
  });
}
