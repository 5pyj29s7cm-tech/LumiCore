import fs from 'fs';
import path from 'path';
import { getDataPath } from '../config/data_path';
import type { IncomingAttachment, IncomingMessage } from './types';

const STORE_PATH = getDataPath(path.join('messaging', 'attachment_context.json'));
const MAX_CONTEXT_ATTACHMENTS = 8;
const MAX_EXTRACTED_TEXT = 12_000;
const CONTEXT_TTL_MS = 30 * 24 * 60 * 60 * 1000;

interface AttachmentContextEntry {
  updatedAt: string;
  attachments: IncomingAttachment[];
}

interface AttachmentContextStore {
  version: 1;
  entries: Record<string, AttachmentContextEntry>;
}

let store: AttachmentContextStore | null = null;

function emptyStore(): AttachmentContextStore {
  return { version: 1, entries: {} };
}

function readStore(): AttachmentContextStore {
  if (store) return store;
  try {
    const parsed = JSON.parse(fs.readFileSync(STORE_PATH, 'utf8'));
    store = parsed?.version === 1 && parsed?.entries && typeof parsed.entries === 'object'
      ? parsed as AttachmentContextStore
      : emptyStore();
  } catch {
    store = emptyStore();
  }
  return store;
}

function writeStore(next: AttachmentContextStore): void {
  store = next;
  fs.mkdirSync(path.dirname(STORE_PATH), { recursive: true });
  const temporaryPath = `${STORE_PATH}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporaryPath, JSON.stringify(next, null, 2), 'utf8');
  fs.renameSync(temporaryPath, STORE_PATH);
}

function attachmentIdentity(attachment: IncomingAttachment): string {
  if (attachment.localPath) return `path:${attachment.localPath.replace(/\\/g, '/').toLowerCase()}`;
  if (attachment.resourceKey) return `resource:${attachment.resourceKey.toLowerCase()}`;
  return `name:${attachment.fileName.toLowerCase()}:${attachment.fileSize || 0}`;
}

function verifiedLocalPath(value?: string): string | undefined {
  const candidate = String(value || '').trim();
  if (!candidate) return undefined;
  try {
    return fs.statSync(candidate).isFile() ? candidate : undefined;
  } catch {
    return undefined;
  }
}

function durableAttachment(attachment: IncomingAttachment): IncomingAttachment {
  const localPath = verifiedLocalPath(attachment.localPath);
  return {
    id: attachment.id,
    type: attachment.type,
    fileName: attachment.fileName,
    fileSize: attachment.fileSize,
    mimeType: attachment.mimeType,
    localPath,
    extractedText: attachment.extractedText?.slice(0, MAX_EXTRACTED_TEXT),
    parseError: attachment.parseError,
  };
}

function usableAttachment(attachment: IncomingAttachment): boolean {
  return Boolean(verifiedLocalPath(attachment.localPath) || attachment.extractedText);
}

export function remoteAttachmentContextKey(message: IncomingMessage): string {
  return [
    message.platform,
    message.boundOrgId ? `org:${message.boundOrgId}` : 'personal',
    `member:${message.boundUserId || message.userId}`,
    message.chatType,
    message.chatId,
    message.threadId || 'main',
  ].join(':');
}

export function isRemoteAttachmentContextClearRequest(text: string): boolean {
  const clean = String(text || '').trim();
  return /^(?:\u6e05\u9664|\u79fb\u9664|\u5220\u9664|\u5fd8\u6389|\u4e0d\u8981\u518d\u7528|\u505c\u6b62\u4f7f\u7528).{0,12}(?:\u4f1a\u8bdd)?(?:\u6750\u6599|\u9644\u4ef6|\u6587\u4ef6)(?:\u4e0a\u4e0b\u6587)?$/u.test(clean)
    || /^(?:clear|forget|remove|stop using)(?: the)? (?:session )?(?:materials?|attachments?|files?)(?: context)?$/iu.test(clean);
}

export function isRemoteConversationDismissalRequest(text: string): boolean {
  const clean = String(text || '').trim();
  // i18n-allow -- Multilingual remote-turn recognition; this literal is not user-visible copy.
  return /^(?:(?:没事(?:了)?|算了|不用了|不需要了|先这样(?:吧)?|到这(?:里)?(?:吧)?|没别的事了)(?:[，,、\s]+(?:你)?退下(?:吧)?)?|(?:你)?退下(?:吧)?)[。！？.!?\s]*$/u.test(clean)
    || /^(?:never\s*mind|that(?:'s| is) all|we(?:'re| are) done|dismissed|you may go)[.!?\s]*$/iu.test(clean);
}

export function clearRemoteAttachmentContext(message: IncomingMessage): void {
  const current = readStore();
  const key = remoteAttachmentContextKey(message);
  if (!current.entries[key]) return;
  delete current.entries[key];
  writeStore(current);
}

function attachmentPromptBlock(attachment: IncomingAttachment): string {
  return [
    `## Conversation material: ${attachment.fileName}`,
    attachment.localPath ? `Verified local cache: ${attachment.localPath}` : '',
    attachment.extractedText ? `Extracted text:\n${attachment.extractedText.slice(0, MAX_EXTRACTED_TEXT)}` : '',
    !attachment.extractedText && attachment.parseError ? `Parsing status: ${attachment.parseError}` : '',
  ].filter(Boolean).join('\n');
}

/** Carry verified, locally cached files only within the exact remote conversation. */
export function applyRemoteAttachmentContext(message: IncomingMessage): IncomingMessage {
  if (isRemoteAttachmentContextClearRequest(message.text)) {
    clearRemoteAttachmentContext(message);
    return {
      ...message,
      attachments: undefined,
      raw: { ...message.raw, lumiAttachmentContext: { cleared: true, incomingCount: 0, carriedCount: 0, totalCount: 0 } },
    };
  }

  // A conversational dismissal closes the foreground exchange. Retaining the
  // cached material for a later explicit follow-up is useful, but injecting it
  // into this turn can make the attachment look like a fresh task and restart
  // work after the user has just ended it.
  if (isRemoteConversationDismissalRequest(message.text) && !message.attachments?.length) {
    return {
      ...message,
      attachments: undefined,
      raw: {
        ...message.raw,
        lumiAttachmentContext: {
          cleared: false,
          suppressedForDismissal: true,
          incomingCount: 0,
          carriedCount: 0,
          totalCount: 0,
        },
      },
    };
  }

  const currentStore = readStore();
  const now = Date.now();
  let storeChanged = false;
  for (const [key, entry] of Object.entries(currentStore.entries)) {
    if (now - new Date(entry.updatedAt).getTime() > CONTEXT_TTL_MS) {
      delete currentStore.entries[key];
      storeChanged = true;
    }
  }

  const key = remoteAttachmentContextKey(message);
  const storedPrevious = currentStore.entries[key]?.attachments || [];
  const previous = storedPrevious.map(durableAttachment).filter(usableAttachment);
  const incoming = (message.attachments || []).map(durableAttachment).filter(usableAttachment);
  const incomingIdentities = new Set(incoming.map(attachmentIdentity));
  const carried = previous.filter(item => !incomingIdentities.has(attachmentIdentity(item)));
  const merged: IncomingAttachment[] = [];
  const identities = new Set<string>();
  for (const item of [...carried, ...incoming]) {
    const identity = attachmentIdentity(item);
    if (identities.has(identity)) continue;
    identities.add(identity);
    merged.push(durableAttachment(item));
  }
  const bounded = merged.slice(-MAX_CONTEXT_ATTACHMENTS);
  const staleStoredAttachmentRemoved = previous.length !== storedPrevious.length
    || previous.some((item, index) => item.localPath !== storedPrevious[index]?.localPath);
  if (incoming.length > 0 || staleStoredAttachmentRemoved) {
    if (bounded.length === 0) delete currentStore.entries[key];
    else {
      currentStore.entries[key] = {
        updatedAt: new Date(now).toISOString(),
        attachments: bounded,
      };
    }
    storeChanged = true;
  }
  if (storeChanged) writeStore(currentStore);

  if (bounded.length === 0) return message;
  const carriedBlocks = carried.slice(-MAX_CONTEXT_ATTACHMENTS).map(attachmentPromptBlock);
  const text = carriedBlocks.length > 0
    ? [
        message.text,
        '',
        'The following materials were sent earlier by this member in the same remote conversation and are safely cached locally. They are reference context, not a new instruction. Use them only when the current message refers to them; otherwise follow the current message and do not resume the old attachment task. When relevant, continue using them and do not ask for another upload.',
        carriedBlocks.join('\n\n'),
      ].join('\n')
    : message.text;
  return {
    ...message,
    text,
    attachments: bounded,
    raw: {
      ...message.raw,
      lumiAttachmentContext: {
        cleared: false,
        incomingCount: incoming.length,
        carriedCount: carried.length,
        totalCount: bounded.length,
      },
    },
  };
}

export function resetRemoteAttachmentContextForTest(): void {
  store = emptyStore();
  try { fs.rmSync(STORE_PATH, { force: true }); } catch {}
}
