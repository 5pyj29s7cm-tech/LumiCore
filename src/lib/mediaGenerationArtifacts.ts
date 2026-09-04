export type MediaGenerationKind = 'image' | 'video';

export type MediaGenerationOperation =
  | 'text_to_image'
  | 'image_edit'
  | 'text_to_video'
  | 'image_to_video';

export type MediaGenerationSourceOperation = Extract<
  MediaGenerationOperation,
  'image_edit' | 'image_to_video'
>;

export type MediaGenerationArtifact = {
  id: string;
  kind: MediaGenerationKind;
  url: string;
  path?: string;
  fileName?: string;
  requestId?: string;
  operation?: MediaGenerationOperation;
  prompt?: string;
  model?: string;
  createdAt?: string;
};

export type MediaGenerationExpectation = {
  mode: MediaGenerationKind;
  operation?: MediaGenerationOperation;
  size: string;
  count?: number;
  duration?: number;
  primaryImage?: string;
  referenceImages?: string[];
  referenceImage?: string;
  primaryArtifactId?: string;
  referenceArtifactIds?: string[];
  referenceArtifactId?: string;
};

export function mediaGenerationKindForOperation(operation: MediaGenerationOperation): MediaGenerationKind {
  return operation === 'text_to_image' || operation === 'image_edit' ? 'image' : 'video';
}

export function defaultMediaGenerationOperation(kind: MediaGenerationKind): MediaGenerationOperation {
  return kind === 'image' ? 'text_to_image' : 'text_to_video';
}

export function resolveMediaGenerationOperation(
  expectation: MediaGenerationExpectation,
): MediaGenerationOperation {
  if (expectation.operation) return expectation.operation;
  if (expectation.mode === 'image') {
    return String(expectation.primaryImage || '').trim() ? 'image_edit' : 'text_to_image';
  }
  return String(expectation.referenceImage || '').trim() ? 'image_to_video' : 'text_to_video';
}

export function mediaGenerationToolForOperation(
  operation: MediaGenerationOperation,
): 'generate_image' | 'ai_edit_image' | 'generate_video' {
  if (operation === 'image_edit') return 'ai_edit_image';
  return mediaGenerationKindForOperation(operation) === 'image' ? 'generate_image' : 'generate_video';
}

const IMAGE_EXTENSION_RE = /\.(?:png|jpe?g|webp|gif|bmp|tiff?|svg)(?:$|[?#])/i;
const VIDEO_EXTENSION_RE = /\.(?:mp4|mov|m4v|webm)(?:$|[?#])/i;
const WINDOWS_PATH_RE = /^[A-Za-z]:[\\/]/;

function parseToolPayload(value: unknown): Record<string, any> | null {
  if (value && typeof value === 'object') return value as Record<string, any>;
  const text = String(value || '').trim();
  if (!text) return null;
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' ? parsed as Record<string, any> : null;
  } catch {
    const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]?.trim();
    if (!fenced) return null;
    try {
      const parsed = JSON.parse(fenced);
      return parsed && typeof parsed === 'object' ? parsed as Record<string, any> : null;
    } catch {
      return null;
    }
  }
}

function inferKind(value: string, declaredType: string, fallbackKind?: MediaGenerationKind): MediaGenerationKind | null {
  if (/video/i.test(declaredType) || VIDEO_EXTENSION_RE.test(value) || /^data:video\//i.test(value)) return 'video';
  if (/image/i.test(declaredType) || IMAGE_EXTENSION_RE.test(value) || /^data:image\//i.test(value)) return 'image';
  return fallbackKind || null;
}

function artifactUrl(value: string): { url: string; path?: string } | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith('/api/files/generated?') || trimmed.startsWith('/lumi_output/')) {
    return { url: trimmed, path: trimmed.startsWith('/lumi_output/') ? trimmed : undefined };
  }
  if (WINDOWS_PATH_RE.test(trimmed) || trimmed.startsWith('/')) {
    return {
      url: `/api/files/generated?path=${encodeURIComponent(trimmed)}&inline=1`,
      path: trimmed,
    };
  }
  return null;
}

function fileNameFor(value: string): string | undefined {
  if (/^(?:https?|data):/i.test(value)) return undefined;
  const plain = value.split(/[?#]/, 1)[0];
  return plain.split(/[\\/]/).pop() || undefined;
}

/**
 * Extracts only concrete media returned by a generation tool. A successful
 * prose response without an artifact deliberately remains empty so the UI
 * cannot present an unverified generation as complete.
 */
export function extractMediaGenerationArtifacts(
  result: unknown,
  fallbackKind?: MediaGenerationKind,
): MediaGenerationArtifact[] {
  const payload = parseToolPayload(result);
  if (!payload) return [];
  if (
    payload.ok === false
    || payload.success === false
    || payload.verified !== true
    || payload.verificationStatus !== 'verified'
    || Boolean(payload.error)
    || /^(?:failed|failure|error|errored|timed_out|timeout|cancelled|canceled|aborted|blocked|rejected)$/i.test(String(payload.status || ''))
  ) return [];

  const candidates: Array<{ value: unknown; type?: unknown }> = [];
  if (Array.isArray(payload.artifacts)) {
    for (const item of payload.artifacts) {
      if (typeof item === 'string') candidates.push({ value: item });
      else if (item && typeof item === 'object') {
        candidates.push({
          value: item.path || item.url || item.outputPath || item.output_path,
          type: item.type || item.kind,
        });
      }
    }
  }
  if (Array.isArray(payload.images)) {
    for (const image of payload.images) {
      candidates.push({
        value: typeof image === 'object' && image ? image.url || image.path || image.b64_json : image,
        type: 'image',
      });
    }
  }
  for (const [key, kind] of [
    ['image_url', 'image'],
    ['image_base64', 'image'],
    ['video_url', 'video'],
    ['videoUrl', 'video'],
    ['outputPath', fallbackKind],
    ['output_path', fallbackKind],
  ] as const) {
    const raw = payload[key];
    if (!raw) continue;
    const value = key === 'image_base64' && !String(raw).startsWith('data:')
      ? `data:image/png;base64,${String(raw)}`
      : raw;
    candidates.push({ value, type: kind });
  }

  const seen = new Set<string>();
  const artifacts: MediaGenerationArtifact[] = [];
  for (const candidate of candidates) {
    const value = String(candidate.value || '').trim();
    const location = artifactUrl(value);
    const kind = inferKind(value, String(candidate.type || ''), fallbackKind);
    if (!location || !kind) continue;
    const key = `${kind}:${location.url}`.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    artifacts.push({
      id: `media-${kind}-${artifacts.length}-${key.slice(-48)}`,
      kind,
      url: location.url,
      path: location.path,
      fileName: fileNameFor(location.path || value),
    });
  }
  return artifacts;
}

function normalizedSize(value: unknown): string {
  return String(value || '').trim().toLowerCase().replace('*', 'x');
}

/** Ensures the model called the generator with the settings the user chose. */
export function mediaGenerationArgumentsMatch(
  expectation: MediaGenerationExpectation,
  args: unknown,
): boolean {
  if (!args || typeof args !== 'object') return false;
  const values = args as Record<string, unknown>;
  const operation = resolveMediaGenerationOperation(expectation);
  if (mediaGenerationKindForOperation(operation) !== expectation.mode) return false;
  if (normalizedSize(values.size) !== normalizedSize(expectation.size)) return false;

  if (operation === 'text_to_image') {
    const requestedCount = Math.max(1, Number(expectation.count) || 1);
    const actualCount = values.n == null ? 1 : Number(values.n);
    return Number.isInteger(actualCount) && actualCount === requestedCount;
  }

  if (operation === 'image_edit') {
    const expectedSource = String(expectation.primaryImage || '').trim();
    const actualSource = String(values.filePath || '').trim();
    const expectedReferences = Array.isArray(expectation.referenceImages)
      ? expectation.referenceImages.map(value => String(value || '').trim()).filter(Boolean)
      : [];
    const actualReferences = Array.isArray(values.referencePaths)
      ? values.referencePaths.map(value => String(value || '').trim()).filter(Boolean)
      : [];
    return Boolean(expectedSource)
      && actualSource === expectedSource
      && expectedReferences.length === actualReferences.length
      && expectedReferences.every((value, index) => value === actualReferences[index]);
  }

  const actualDuration = Number(values.duration);
  if (!Number.isFinite(actualDuration) || actualDuration !== Number(expectation.duration)) return false;
  const expectedReference = String(expectation.referenceImage || '').trim();
  const actualReference = String(values.first_frame_image || '').trim();
  if (operation === 'image_to_video') {
    return Boolean(expectedReference) && actualReference === expectedReference;
  }
  return !expectedReference && !actualReference;
}

export function mediaGenerationReceiptSettingsMatch(
  expectation: MediaGenerationExpectation,
  receipt: unknown,
): boolean {
  if (!receipt || typeof receipt !== 'object') return false;
  if (
    (receipt as Record<string, any>).verified !== true
    || (receipt as Record<string, any>).verificationStatus !== 'verified'
  ) return false;
  const operation = resolveMediaGenerationOperation(expectation);
  if (mediaGenerationKindForOperation(operation) !== expectation.mode) return false;
  const expectedToolName = mediaGenerationToolForOperation(operation);
  if (String((receipt as Record<string, any>).toolName || '') !== expectedToolName) return false;
  const settings = (receipt as Record<string, any>).settings;
  if (!settings || typeof settings !== 'object') return false;
  if (normalizedSize(settings.size) !== normalizedSize(expectation.size)) return false;
  if (operation === 'text_to_image') {
    return Number(settings.count ?? 1) === Math.max(1, Number(expectation.count) || 1);
  }

  if (operation === 'image_edit') {
    const expectedSource = String(expectation.primaryImage || '').trim();
    if (!expectedSource) return false;
    // Older receipts only expose `hasReference` for video first frames. Newer
    // image-edit receipts may additionally assert `hasSource`; consume that
    // assertion when present without rejecting safe legacy receipts.
    return settings.hasSource == null || settings.hasSource === true;
  }
  const expectsReference = operation === 'image_to_video';
  return Number(settings.duration) === Number(expectation.duration)
    && Boolean(settings.hasReference) === expectsReference;
}
