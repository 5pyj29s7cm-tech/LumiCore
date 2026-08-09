export const MAX_CHAT_ATTACHMENTS = 8;

export type ChatAttachmentKind = 'image' | 'audio' | 'file';

export interface ChatAttachmentReference {
  id: string;
  fileName: string;
  path?: string;
  content?: string | null;
  preview?: string | null;
  mimeType?: string;
  size?: number;
  kind: ChatAttachmentKind;
  fileId?: string;
  downloadUrl?: string;
  transcript?: string | null;
  transcriptionStatus?: string;
  transcriptionError?: string | null;
  transcriptionProvider?: string;
  transcriptionModel?: string;
}

export interface ChatFileReferenceInput {
  id?: string;
  fileId?: string;
  fileName?: string;
  name?: string;
  displayName?: string;
  path?: string;
  content?: string | null;
  preview?: string | null;
  mimeType?: string;
  size?: number;
  rawSize?: number;
  kind?: string;
  downloadUrl?: string;
  openUrl?: string;
  saveUrl?: string;
  transcript?: string | null;
  transcriptionStatus?: string;
  transcriptionError?: string | null;
  transcriptionProvider?: string;
  transcriptionModel?: string;
}

export interface ChatAttachmentRequest extends ChatFileReferenceInput {
  requestId: string;
  domain: 'personal' | 'work';
  orgId?: string;
}

export interface MergeChatAttachmentsResult {
  attachments: ChatAttachmentReference[];
  added: ChatAttachmentReference[];
  duplicateCount: number;
  overflowCount: number;
}

type PersistedChatAttachmentReference = Omit<ChatAttachmentReference, 'preview'> & {
  preview?: string | null;
};

interface PersistedChatAttachmentContext {
  version: 1;
  savedAt: number;
  expiresAt: number;
  attachments: PersistedChatAttachmentReference[];
}

export const CHAT_ATTACHMENT_CONTEXT_TTL_MS = 30 * 24 * 60 * 60 * 1000;

function normalizeReferencePath(value: string): string {
  return value.trim().replace(/\\/g, '/').replace(/\/{2,}/g, '/').toLowerCase();
}

function stableToken(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

export function inferChatAttachmentKind(
  fileName: string,
  mimeType?: string,
  kind?: string,
): ChatAttachmentKind {
  if (kind === 'image' || mimeType?.startsWith('image/') || /\.(png|jpe?g|webp|bmp|gif|tiff?)$/i.test(fileName)) {
    return 'image';
  }
  if (kind === 'audio' || mimeType?.startsWith('audio/') || /\.(mp3|mpeg|wav|m4a|ogg|oga|flac|aac|wma|webm)$/i.test(fileName)) {
    return 'audio';
  }
  return 'file';
}

export function chatAttachmentIdentity(
  item: Pick<ChatFileReferenceInput, 'fileId' | 'fileName' | 'name' | 'displayName' | 'path' | 'size' | 'rawSize'>,
): string {
  const filePath = String(item.path || '').trim();
  if (filePath) return `path:${normalizeReferencePath(filePath)}`;

  const fileId = String(item.fileId || '').trim();
  if (fileId) return `file:${fileId.toLowerCase()}`;

  const fileName = String(item.fileName || item.displayName || item.name || '').trim().toLowerCase();
  const size = Number(item.rawSize ?? item.size ?? 0);
  return `name:${fileName}:${Number.isFinite(size) ? size : 0}`;
}

export function createChatAttachmentReference(input: ChatFileReferenceInput): ChatAttachmentReference {
  const fileName = String(input.fileName || input.displayName || input.name || input.fileId || input.id || 'attachment').trim();
  const fileId = String(input.fileId || '').trim() || undefined;
  const identity = chatAttachmentIdentity({ ...input, fileName, fileId });
  return {
    id: `ref-${stableToken(identity)}`,
    fileName,
    path: input.path,
    content: input.content || null,
    preview: input.preview || null,
    mimeType: input.mimeType || '',
    size: Number(input.rawSize ?? input.size ?? 0) || 0,
    kind: inferChatAttachmentKind(fileName, input.mimeType, input.kind),
    fileId,
    downloadUrl: input.downloadUrl || input.openUrl || input.saveUrl,
    transcript: input.transcript || null,
    transcriptionStatus: input.transcriptionStatus,
    transcriptionError: input.transcriptionError || null,
    transcriptionProvider: input.transcriptionProvider,
    transcriptionModel: input.transcriptionModel,
  };
}

export function chatAttachmentRequestMatchesScope(
  request: Pick<ChatAttachmentRequest, 'domain' | 'orgId'>,
  activeDomain: 'personal' | 'work',
  activeOrgId?: string,
): boolean {
  if (request.domain !== activeDomain) return false;
  if (activeDomain === 'personal') return true;
  return Boolean(activeOrgId) && (!request.orgId || request.orgId === activeOrgId);
}

export function mergeChatAttachmentReferences(
  existing: ChatAttachmentReference[],
  incoming: ChatAttachmentReference[],
  limit = MAX_CHAT_ATTACHMENTS,
): MergeChatAttachmentsResult {
  const attachments = [...existing];
  const identities = new Set(existing.map(chatAttachmentIdentity));
  const added: ChatAttachmentReference[] = [];
  let duplicateCount = 0;
  let overflowCount = 0;

  for (const item of incoming) {
    const identity = chatAttachmentIdentity(item);
    if (identities.has(identity)) {
      duplicateCount += 1;
      continue;
    }
    if (attachments.length >= limit) {
      overflowCount += 1;
      continue;
    }
    identities.add(identity);
    attachments.push(item);
    added.push(item);
  }

  return { attachments, added, duplicateCount, overflowCount };
}

/**
 * Keeps durable references available when the desktop client is reopened.
 * Extracted text, transcripts, and previews are deliberately not copied into
 * localStorage; the scoped file id/path remains the source of truth.
 */
export function serializeChatAttachmentContext(
  attachments: ChatAttachmentReference[],
  now = Date.now(),
): string {
  const persisted: PersistedChatAttachmentReference[] = attachments
    .filter(item => Boolean(item.path || item.fileId))
    .slice(0, MAX_CHAT_ATTACHMENTS)
    .map(item => ({
      ...item,
      content: null,
      transcript: null,
      preview: null,
      transcriptionError: null,
    }));
  const context: PersistedChatAttachmentContext = {
    version: 1,
    savedAt: now,
    expiresAt: now + CHAT_ATTACHMENT_CONTEXT_TTL_MS,
    attachments: persisted,
  };
  return JSON.stringify(context);
}

export function parseChatAttachmentContext(value?: string | null, now = Date.now()): ChatAttachmentReference[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    if (
      !parsed
      || parsed.version !== 1
      || !Number.isFinite(Number(parsed.expiresAt))
      || Number(parsed.expiresAt) <= now
      || !Array.isArray(parsed.attachments)
    ) return [];
    return parsed.attachments
      .filter(item => item && typeof item === 'object' && String(item.fileName || '').trim())
      .map(item => createChatAttachmentReference(item as ChatFileReferenceInput))
      .filter(item => Boolean(item.path || item.fileId))
      .slice(0, MAX_CHAT_ATTACHMENTS);
  } catch {
    return [];
  }
}
