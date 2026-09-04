export const MEDIA_GENERATION_OPERATIONS = [
  'text_to_image',
  'image_edit',
  'text_to_video',
  'image_to_video',
] as const;

export type MediaGenerationOperation = typeof MEDIA_GENERATION_OPERATIONS[number];

export type StructuredMediaRequest = {
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
 * provider, model, endpoint, or unbounded argument through this payload.
 */
export function normalizeStructuredMediaRequest(value: unknown): StructuredMediaRequest | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  const operation = MEDIA_GENERATION_OPERATIONS.includes(candidate.operation as MediaGenerationOperation)
    ? candidate.operation as MediaGenerationOperation
    : null;
  const prompt = compact(candidate.prompt, MAX_PROMPT_LENGTH);
  const size = normalizeSize(candidate.size);
  if (!operation || !prompt || !size) return null;

  if (operation === 'text_to_image') {
    const count = Math.max(1, Math.min(4, Math.trunc(Number(candidate.count) || 1)));
    return { operation, prompt, size, count };
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
      ...(referenceImages.length > 0 ? { referenceImages } : {}),
    };
  }

  const duration = Math.max(1, Math.min(120, Math.trunc(Number(candidate.duration) || 6)));
  if (operation === 'text_to_video') return { operation, prompt, size, duration };

  const referenceImage = normalizeReference(candidate.referenceImage);
  if (!referenceImage) return null;
  return { operation, prompt, size, duration, referenceImage };
}

export function structuredMediaToolCall(request: StructuredMediaRequest): StructuredMediaToolCall {
  if (request.operation === 'text_to_image') {
    return {
      name: 'generate_image',
      arguments: { prompt: request.prompt, size: request.size, n: request.count || 1 },
    };
  }
  if (request.operation === 'image_edit') {
    return {
      name: 'ai_edit_image',
      arguments: {
        prompt: request.prompt,
        size: request.size,
        filePath: request.primaryImage,
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
