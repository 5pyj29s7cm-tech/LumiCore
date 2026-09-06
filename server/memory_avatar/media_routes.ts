import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Router, Request, Response, NextFunction } from 'express';
import multer from 'multer';
import { getMemoryAvatar, MemoryAvatarError } from './store';
import { avatarMediaDirectory, AVATAR_MEDIA_MAX_BYTES } from './media_files';
import { cancelMemoryAvatarMedia, deleteMemoryAvatarMedia, getMemoryAvatarMediaFile, listMemoryAvatarMedia, processMemoryAvatarMedia, uploadMemoryAvatarMedia, type AvatarMediaLlmGetters } from './media';
import type { MemoryAvatarMediaVariant } from '../../shared/memory_avatar';

const handle = (fn: (req: Request, res: Response) => Promise<any>) => (req: Request, res: Response, next: NextFunction) => {
  return Promise.resolve(fn(req, res)).catch(error => {
    if (res.headersSent) return next(error);
    if (error instanceof MemoryAvatarError) return res.status(error.status).json({ error: error.message, code: error.code });
    if (error?.status === 416) return res.status(416).end();
    if (error?.name === 'AbortError') return res.status(409).json({ error: 'The media operation was cancelled.', code: 'media_cancelled' });
    return res.status(503).json({ error: 'Media could not be saved. Retry the same request.', code: 'media_save_failed' });
  });
};
export function mountMemoryAvatarMediaRoutes(router: Router, getters: AvatarMediaLlmGetters, publicAvatar: (avatar: any) => any): void {
  // The parent router requires an authenticated personal session for every endpoint.
  const base = '/memory-avatars/:id/media';
  router.get(base, handle(async (req, res) => res.json(listMemoryAvatarMedia(req.user!.uid, String(req.params.id)))));
  const upload = multer({ storage: multer.diskStorage({
    destination(req, _file, done) {
      try {
        const avatar = getMemoryAvatar(req.user!.uid, String(req.params.id));
        if (!avatar || avatar.status !== 'active') throw new MemoryAvatarError(404, 'memory_avatar_not_found', 'Memory avatar not found.');
        done(null, avatarMediaDirectory(req.user!.uid, avatar.id));
      } catch (error) { done(error as Error, ''); }
    }, filename(_req, _file, done) { done(null, `.upload-${randomUUID()}`); },
  }), limits: { fileSize: AVATAR_MEDIA_MAX_BYTES.video, files: 1, fields: 5, fieldSize: 8000 } }).single('file');
  router.post(base, handle(async (req, res) => {
    const controller = new AbortController();
    const abort = () => controller.abort(new DOMException('Upload cancelled.', 'AbortError'));
    const close = () => { if (!res.writableEnded) abort(); };
    req.once('aborted', abort); res.once('close', close);
    try {
      await new Promise<void>((resolve, reject) => upload(req, res, error => error ? reject(error instanceof MemoryAvatarError ? error : new MemoryAvatarError(error.code === 'LIMIT_FILE_SIZE' ? 413 : 400, 'media_upload_invalid', 'Upload one supported media file within the size limit.')) : resolve()));
      if (!req.file) throw new MemoryAvatarError(400, 'media_upload_missing', 'Choose one media file.');
      const result = await uploadMemoryAvatarMedia(req.user!.uid, String(req.params.id), { path: req.file.path, title: req.body?.title || req.file.originalname, caption: req.body?.caption, clientRequestId: req.body?.clientRequestId, revision: Number(req.body?.revision), signal: controller.signal });
      if (!controller.signal.aborted) res.status(201).json({ media: result.media, avatar: publicAvatar(result.avatar) });
    } finally {
      req.off('aborted', abort); res.off('close', close);
      if (req.file?.path) await fs.promises.rm(req.file.path, { force: true });
    }
  }));
  router.get(`${base}/:mediaId/content`, handle(async (req, res) => {
    const variant = String(req.query.variant || 'original') as MemoryAvatarMediaVariant;
    const file = getMemoryAvatarMediaFile(req.user!.uid, String(req.params.id), String(req.params.mediaId), variant);
    res.setHeader('Cache-Control', 'private, no-store'); res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Type', file.mimeType); res.setHeader('Content-Disposition', `inline; filename="media${path.extname(file.path)}"`);
    await new Promise<void>((resolve, reject) => res.sendFile(file.path, { dotfiles: 'deny' }, error => error ? reject(error) : resolve()));
  }));
  router.post(`${base}/:mediaId/process`, handle(async (req, res) => {
    const result = await processMemoryAvatarMedia(req.user!.uid, String(req.params.id), String(req.params.mediaId), req.body?.revision, getters);
    res.status(result.media.status === 'processing' ? 202 : 200).json({ media: result.media, avatar: publicAvatar(result.avatar) });
  }));
  router.post(`${base}/:mediaId/cancel`, handle(async (req, res) => {
    const result = await cancelMemoryAvatarMedia(req.user!.uid, String(req.params.id), String(req.params.mediaId), req.body?.revision);
    res.json({ media: result.media, avatar: publicAvatar(result.avatar) });
  }));
  router.delete(`${base}/:mediaId`, handle(async (req, res) => {
    const avatar = await deleteMemoryAvatarMedia(req.user!.uid, String(req.params.id), String(req.params.mediaId), req.body?.revision);
    res.json({ ok: true, avatar: publicAvatar(avatar) });
  }));
}
