import type { NextFunction, Request, Response, Router } from 'express';
import { requireAuth } from '../middleware/auth';
import { runtimeBackgroundWork } from '../runtime/shutdown_work';
import { PortraitError } from './portrait_provider';
import { getMemoryAvatarPortraitSessions, type MemoryAvatarPortraitSessions } from './portrait_sessions';

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

export function mountMemoryAvatarPortraitRoutes(router: Router, manager?: MemoryAvatarPortraitSessions): void {
  const service = () => manager || getMemoryAvatarPortraitSessions();
  const scope = (req: Request) => {
    const callSessionId = req.body?.callSessionId;
    if (typeof callSessionId !== 'string' || !/^[A-Za-z0-9_.:-]{1,200}$/.test(callSessionId)) throw new PortraitError('portrait_request_invalid', 'A valid callSessionId is required.', 400);
    return { userId: req.user!.uid, avatarId: String(req.params.id), callSessionId };
  };
  router.get('/memory-avatar-portrait/config', requireAuth, personal, handler(async (req, res) => res.json(service().config(req.user!.uid))));
  router.put('/memory-avatar-portrait/config', requireAuth, personal, handler(async (req, res) => res.json(await service().configure(req.user!.uid, req.body || {}))));
  router.post('/memory-avatars/:id/portrait/streams', requireAuth, personal, handler(async (req, res) => {
    const result = await service().create({ ...scope(req), clientRequestId: req.body?.clientRequestId, cloudConsent: req.body?.cloudConsent });
    if (!res.destroyed) res.status(201).json(result);
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
