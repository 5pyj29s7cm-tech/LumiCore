export const MEDIA_GENERATION_OPERATIONS = [
  'text_to_image',
  'image_edit',
  'text_to_video',
  'image_to_video',
] as const;

export type MediaGenerationOperation = typeof MEDIA_GENERATION_OPERATIONS[number];

export type StructuredMediaRequest = {
  officialOnly?: true;
  model?: string;
  operation: MediaGenerationOperation;
  prompt: string;
  size: string;
  count?: number;
  duration?: number;
  primaryImage?: string;
  referenceImages?: string[];
  referenceImage?: string;
};

export type StructuredMediaToolCall = {
  name: 'generate_image' | 'ai_edit_image' | 'generate_video';
  arguments: Record<string, unknown>;
};

const SIZE_RE = /^(\d{3,4})[x*](\d{3,4})$/i;
const WINDOWS_ABSOLUTE_PATH_RE = /^[A-Za-z]:[\\/]/;
const MAX_PROMPT_LENGTH = 8_000;
const MAX_REFERENCE_LENGTH = 8_192;

function compact(value: unknown, maxLength: number): string {
  return String(value || '').trim().slice(0, maxLength);
}

function normalizeSize(value: unknown): string {
  const raw = compact(value, 40).replace('*', 'x').toLowerCase();
  const match = raw.match(SIZE_RE);
  if (!match) return '';
  const width = Number(match[1]);
  const height = Number(match[2]);
  if (width < 256 || height < 256 || width > 4096 || height > 4096) return '';
  return `${width}x${height}`;
}

function normalizeReference(value: unknown): string {
  const reference = compact(value, MAX_REFERENCE_LENGTH);
  if (!reference) return '';
  if (WINDOWS_ABSOLUTE_PATH_RE.test(reference) || reference.startsWith('/')) return reference;
  try {
    const url = new URL(reference);
    return url.protocol === 'https:' ? url.toString() : '';
  } catch {
    return '';
  }
}

/**
 * Fail-closed parser for the media workbench envelope. The client can choose
 * among four product operations, but it can never choose an arbitrary tool,
 * provider, endpoint, or unbounded argument through this payload. A video
 * model id is bounded here and validated against its role catalog by preflight.
 * An optional official-only restriction narrows allowed routing; it never
 * changes model preferences or grants another provider permission to run.
 */
export function normalizeStructuredMediaRequest(value: unknown): StructuredMediaRequest | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  const operation = MEDIA_GENERATION_OPERATIONS.includes(candidate.operation as MediaGenerationOperation)
    ? candidate.operation as MediaGenerationOperation
    : null;
  const prompt = compact(candidate.prompt, MAX_PROMPT_LENGTH);
  const size = normalizeSize(candidate.size);
  const restriction = candidate.officialOnly === true ? { officialOnly: true as const } : {};
  if (!operation || !prompt || !size) return null;

  if (operation === 'text_to_image') {
    const count = Math.max(1, Math.min(4, Math.trunc(Number(candidate.count) || 1)));
    return { operation, prompt, size, count, ...restriction };
  }

  if (operation === 'image_edit') {
    const primaryImage = normalizeReference(candidate.primaryImage);
    if (!primaryImage) return null;
    const referenceImages = Array.isArray(candidate.referenceImages)
      ? candidate.referenceImages.map(normalizeReference).filter(Boolean).slice(0, 1)
      : [];
    return {
      operation,
      prompt,
      size,
      primaryImage,
      ...restriction,
      ...(referenceImages.length > 0 ? { referenceImages } : {}),
    };
  }

  const model = candidate.model === undefined ? '' : typeof candidate.model === 'string' ? candidate.model.trim() : '';
  if (candidate.model !== undefined && (!model || model.length > 200)) return null;
  const modelSelection = model ? { model } : {};
  const requestedDuration = candidate.duration === undefined ? 6 : Number(candidate.duration);
  if (!Number.isInteger(requestedDuration) || requestedDuration < 1 || requestedDuration > 120) return null;
  const duration = requestedDuration;
  if (operation === 'text_to_video') return { operation, prompt, size, duration, ...restriction, ...modelSelection };

  const referenceImage = normalizeReference(candidate.referenceImage);
  if (!referenceImage) return null;
  return { operation, prompt, size, duration, referenceImage, ...restriction, ...modelSelection };
}

export function structuredMediaToolCall(request: StructuredMediaRequest): StructuredMediaToolCall {
  const restriction = request.officialOnly ? { officialOnly: true } : {};
  if (request.operation === 'text_to_image') {
    return {
      name: 'generate_image',
      arguments: { prompt: request.prompt, size: request.size, n: request.count || 1, ...restriction },
    };
  }
  if (request.operation === 'image_edit') {
    return {
      name: 'ai_edit_image',
      arguments: {
        prompt: request.prompt,
        size: request.size,
        filePath: request.primaryImage,
        ...restriction,
        ...(request.referenceImages?.length ? { referencePaths: request.referenceImages } : {}),
      },
    };
  }
  return {
    name: 'generate_video',
    arguments: {
      prompt: request.prompt,
      size: request.size,
      duration: request.duration || 6,
      ...(request.model ? { model: request.model } : {}),
      ...restriction,
      ...(request.operation === 'image_to_video'
        ? { first_frame_image: request.referenceImage }
        : {}),
    },
  };
}

/** A server-authored routing hint; never rendered or persisted as user text. */
export function structuredMediaRoutingEnvelope(request: StructuredMediaRequest): string {
  const heading = request.operation === 'text_to_image'
    ? 'Generate images'
    : request.operation === 'image_edit'
      ? 'Edit image'
      : 'Generate a video';
  const toolCall = structuredMediaToolCall(request);
  return [
    heading,
    '## Server-validated media workbench request',
    `Operation: ${request.operation}`,
    `Required tool: ${toolCall.name}`,
    'The runtime owns the exact structured arguments and will verify the returned media artifact.',
  ].join('\n');
}

/** Unknown external outcomes must be reconciled through the existing task resume route. */
export function mediaGenerationNeedsStatusCheck(status: string, detail = ''): boolean {
  return status === 'cancelled' || (status === 'error'
    // i18n-allow: Recognition of existing localized unknown-outcome receipts, never displayed as copy.
    && /outcome is unknown|external commit.{0,60}unknown|(?:先核对.{0,80}(?:服务端|任务).{0,40}状态)|不能确认.{0,60}服务端|丢失.{0,40}任务状态|may still continue and incur charges|lost.{0,40}task state/i.test(detail));
}
