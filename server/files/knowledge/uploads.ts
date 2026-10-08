import multer from "multer";
import { getSharp } from './extraction';
import path from "path";
import fs from "fs";
import os from "os";
import crypto from "crypto";
import { flushDBOrThrow } from "../../../db_layer";
import { commitKnowledgeFileState } from "../knowledge_state";
import { captureOrganizationMembershipAuthorization, isOrganizationMembershipAuthorizationCurrent } from "../../org/membership_authorization";
import type { FileScope, KnowledgeFileInput } from './contracts';
import { saveKnowledgeFile } from './file_ingestion';
import { sanitizeKnowledgeFilename } from './formats';
import { metaMatchesScope, findFileMeta } from './ownership';

// ── Multer: files staged in OS temp, then moved to knowledge dir ──
export const tmpDir = path.join(os.tmpdir(), 'lumi-uploads');

fs.mkdirSync(tmpDir, { recursive: true });

export const MAX_UPLOAD_FILES = Math.max(20, Number(process.env.KNOWLEDGE_UPLOAD_MAX_FILES || 200));

export const MAX_UPLOAD_BYTES = 500 * 1024 * 1024;

export const upload = multer({ dest: tmpDir, limits: { fileSize: MAX_UPLOAD_BYTES, files: MAX_UPLOAD_FILES } });

export interface UploadItemIdentity { batchId: string; itemId: string }

export const activeUploadItems = new Map<string, Promise<any>>();

export function captureUploadAuthorization(scope: FileScope) {
  const snapshot = scope.domain === 'work' ? captureOrganizationMembershipAuthorization(scope.orgId!, scope.userId) : undefined;
  let revoked = false;
  return {
    key: snapshot ? JSON.stringify(snapshot) : scope.userId,
    assertCurrent() {
      if (snapshot && !isOrganizationMembershipAuthorizationCurrent(snapshot, scope.orgId!, scope.userId)) revoked = true;
      if (revoked) throw Object.assign(new Error('Organization access changed during this upload.'), { status: 403 });
    },
  };
}

export function uploadItemIdentities(body: any, count: number): Array<UploadItemIdentity | undefined> {
  if (!body?.uploadBatchId) return Array(count).fill(undefined); // Older clients remain supported.
  const batchId = String(body.uploadBatchId);
  let items: unknown;
  try { items = typeof body.uploadItemIds === 'string' ? JSON.parse(body.uploadItemIds) : body.uploadItemIds; } catch {}
  if (!/^[a-zA-Z0-9_-]{8,100}$/.test(batchId) || !Array.isArray(items) || items.length !== count
    || items.some(item => typeof item !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(item))
    || new Set(items).size !== items.length) {
    throw Object.assign(new Error('Invalid upload batch identity'), { status: 400 });
  }
  return items.map(itemId => ({ batchId, itemId }));
}

export async function hashUploadFile(filePath: string): Promise<string> {
  const info = fs.lstatSync(filePath);
  if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_UPLOAD_BYTES) throw new Error('Invalid upload source');
  const digest = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(filePath)) digest.update(chunk);
  return digest.digest('hex');
}

/** Retry the same authenticated batch item, without changing normal copy-upload semantics. */
export async function saveUploadedKnowledgeFile(
  input: KnowledgeFileInput, userId: string, scope: FileScope, db: any,
  authorization: ReturnType<typeof captureUploadAuthorization>, identity?: UploadItemIdentity,
): Promise<any> {
  authorization.assertCurrent();
  input.signal?.throwIfAborted();
  input.assertAuthorized = authorization.assertCurrent;
  if (!identity) return saveKnowledgeFile(input, userId, scope, db);
  const digest = await hashUploadFile(input.sourcePath);
  input.signal?.throwIfAborted();
  authorization.assertCurrent();
  const key = crypto.createHash('sha256').update(JSON.stringify([
    userId, scope.domain, scope.orgId || '', identity.batchId, identity.itemId,
    authorization.key, sanitizeKnowledgeFilename(input.originalName), input.mimeType || '', digest,
  ])).digest('hex');
  const inFlight = activeUploadItems.get(key);
  if (inFlight) {
    const result = await inFlight;
    input.signal?.throwIfAborted();
    authorization.assertCurrent();
    return { ...result, reused: true };
  }
  const operation = (async () => {
    const candidates = [...(db.knowledgeFiles || [])].reverse().filter((meta: any) => (
      metaMatchesScope(meta, scope) && meta.userId === userId && meta.uploadReceipt?.key === key
      && meta.uploadReceipt.response?.id === meta.filename
    ));
    for (const meta of candidates) {
      const savedPath = path.join(scope.dir, path.basename(meta.filename));
      try {
        if (meta.filename !== path.basename(meta.filename) || await hashUploadFile(savedPath) !== digest) continue;
      } catch { continue; }
      authorization.assertCurrent();
      // A previous flush may have failed. Never return a success before retrying that boundary.
      commitKnowledgeFileState(db);
      await flushDBOrThrow();
      authorization.assertCurrent();
      input.signal?.throwIfAborted();
      return { ...meta.uploadReceipt.response, path: savedPath, reused: true };
    }
    const entry = await saveKnowledgeFile(input, userId, scope, db);
    input.signal?.throwIfAborted();
    authorization.assertCurrent();
    const meta = findFileMeta(db, entry.id, scope);
    if (!meta) throw new Error('Uploaded file metadata is unavailable');
    meta.uploadReceipt = { key, contentSha256: digest, response: entry };
    commitKnowledgeFileState(db);
    await flushDBOrThrow();
    authorization.assertCurrent();
    input.signal?.throwIfAborted();
    return entry;
  })();
  activeUploadItems.set(key, operation);
  try { return await operation; }
  finally { if (activeUploadItems.get(key) === operation) activeUploadItems.delete(key); }
}

/** Validate creative material locally; uploading a first frame must not invoke a vision model. */
export async function validateMediaSourceUpload(file: Express.Multer.File, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  if (!/\.(?:png|jpe?g|webp|gif)$/i.test(file.originalname)) throw new Error('Choose a PNG, JPEG, WebP or GIF source image.');
  if (file.size > 20 * 1024 * 1024) throw new Error('Source image must be smaller than 20 MB.');
  const sharp = await getSharp();
  const image = sharp(file.path, { limitInputPixels: 40_000_000, failOn: 'error' });
  const info = await image.metadata();
  if (!['png', 'jpeg', 'webp', 'gif'].includes(String(info.format))) throw new Error('Choose a PNG, JPEG, WebP or GIF source image.');
  await image.stats();
  signal?.throwIfAborted();
}
