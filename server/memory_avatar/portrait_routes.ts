import type { NextFunction, Request, Response, Router } from 'express';
import { requireAuth } from '../middleware/auth';
import { runtimeBackgroundWork } from '../runtime/shutdown_work';
import { createRequestAbortController } from '../http/request_abort';
import { liveAudioEncoding } from '../../shared/avatar_live';
import { PortraitError } from './portrait_provider';
import { getMemoryAvatarPortraitSessions, type MemoryAvatarPortraitSessions } from './portrait_sessions';
import { getAliyunAvatarSessions, type AliyunAvatarSessions } from './aliyun_sessions';

function personal(req: Request, res: Response, next: NextFunction): void {
  if (req.user?.orgId) { res.status(403).json({ error: 'Use a personal session for a private memory portrait.', code: 'portrait_personal_scope_required' }); return; }
  res.setHeader('Cache-Control', 'no-store'); next();
}
const handler = (fn: (req: Request, res: Response) => Promise<unknown>) => (req: Request, res: Response) => {
  void runtimeBackgroundWork.track(fn(req, res)).catch(error => {
    if (res.headersSent || res.destroyed) return;
    if (error instanceof PortraitError) {
      res.status(error.status).json({ error: error.message, code: error.code, outcomeUnknown: error.outcomeUnknown }); return;
    }
    if (error?.name === 'AbortError') { res.status(409).json({ error: 'The portrait request was cancelled.', code: 'portrait_cancelled' }); return; }
    // No provider payload, credential, absolute local path or private media URL.
    res.status(503).json({ error: 'Live portrait rendering is unavailable.', code: 'portrait_unavailable' });
  });
};

export function mountMemoryAvatarPortraitRoutes(router: Router, manager?: MemoryAvatarPortraitSessions, aliyunManager?: AliyunAvatarSessions): void {
  const service = () => manager || getMemoryAvatarPortraitSessions();
  const aliyun = () => aliyunManager || getAliyunAvatarSessions();
  const scope = (req: Request) => {
    const callSessionId = req.body?.callSessionId;
    if (typeof callSessionId !== 'string' || !/^[A-Za-z0-9_.:-]{1,200}$/.test(callSessionId)) throw new PortraitError('portrait_request_invalid', 'A valid callSessionId is required.', 400);
    return { userId: req.user!.uid, avatarId: String(req.params.id), callSessionId };
  };
  router.get('/memory-avatar-portrait/config', requireAuth, personal, handler(async (req, res) => res.json(service().config(req.user!.uid))));
  router.put('/memory-avatar-portrait/config', requireAuth, personal, handler(async (req, res) => res.json(await service().configure(req.user!.uid, req.body || {}))));
  router.get('/memory-avatars/:id/portrait/aliyun/config', requireAuth, personal, handler(async (req, res) => res.json(aliyun().config(req.user!.uid, String(req.params.id)))));
  router.put('/memory-avatars/:id/portrait/aliyun/config', requireAuth, personal, handler(async (req, res) => res.json(await aliyun().configure(req.user!.uid, String(req.params.id), req.body || {}))));
  router.post('/memory-avatars/:id/portrait/aliyun/cleanup', requireAuth, personal, handler(async (req, res) => res.json(await aliyun().retryCleanup(req.user!.uid, String(req.params.id)))));
  router.post('/memory-avatars/:id/portrait/aliyun/streams', requireAuth, personal, handler(async (req, res) => {
    const result = await aliyun().create(scope(req), req.body?.clientRequestId, req.body?.cloudConsent === true);
    if (!res.destroyed) res.status(201).json(result);
  }));
  router.post('/memory-avatars/:id/portrait/aliyun/streams/:portraitSessionId/ready', requireAuth, personal, handler(async (req, res) => res.json(aliyun().markReady(scope(req), String(req.params.portraitSessionId)))));
  router.post('/memory-avatars/:id/portrait/aliyun/streams/:portraitSessionId/heartbeat', requireAuth, personal, handler(async (req, res) => res.json(aliyun().heartbeat(scope(req), String(req.params.portraitSessionId)))));
  router.delete('/memory-avatars/:id/portrait/aliyun/streams/by-request/:clientRequestId', requireAuth, personal, handler(async (req, res) => {
    await aliyun().stopByRequest(scope(req), String(req.params.clientRequestId)); res.json({ ok: true });
  }));
  router.post('/memory-avatars/:id/portrait/streams', requireAuth, personal, handler(async (req, res) => {
    if (aliyun().selected(req.user!.uid, String(req.params.id))) throw new PortraitError('portrait_provider_changed', 'This person now uses Aliyun. Reopen the call before starting.', 409);
    const result = await service().create({ ...scope(req), clientRequestId: req.body?.clientRequestId, cloudConsent: req.body?.cloudConsent });
    if (!res.destroyed) res.status(201).json(result);
  }));
  router.post('/memory-avatars/:id/portrait/speak', requireAuth, personal, handler(async (req, res) => {
    const { audioBase64, format, requestId } = req.body || {};
    if (typeof audioBase64 !== 'string' || !audioBase64.length || audioBase64.length > 8_000_000
      || !/^[A-Za-z0-9+/=]+$/.test(audioBase64) || !liveAudioEncoding(format)) {
      throw new PortraitError('portrait_request_invalid', 'Invalid portrait audio.', 400);
    }
    const request = createRequestAbortController(req, res);
    try {
      const input = { ...scope(req), requestId, format, audioBuffer: Buffer.from(audioBase64, 'base64'), signal: request.signal };
      const result = await (aliyun().selected(input.userId, input.avatarId) ? aliyun().speak(input) : service().speak(input));
      if (!res.destroyed) res.json(result);
    } finally { request.dispose(); }
  }));
  router.delete('/memory-avatars/:id/portrait/streams/by-request/:clientRequestId', requireAuth, personal, handler(async (req, res) => {
    await service().stopById(scope(req), String(req.params.clientRequestId), true); res.json({ ok: true });
  }));
  router.post('/memory-avatars/:id/portrait/streams/:portraitSessionId/answer', requireAuth, personal, handler(async (req, res) => res.json(await service().answer(scope(req), String(req.params.portraitSessionId), req.body?.answer))));
  router.post('/memory-avatars/:id/portrait/streams/:portraitSessionId/ice', requireAuth, personal, handler(async (req, res) => res.json(await service().ice(scope(req), String(req.params.portraitSessionId), req.body?.candidate ?? null))));
  router.delete('/memory-avatars/:id/portrait/streams/:portraitSessionId', requireAuth, personal, handler(async (req, res) => {
    await service().stopById(scope(req), String(req.params.portraitSessionId)); res.json({ ok: true });
  }));
}
