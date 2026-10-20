import { Router, type Request, type Response, type NextFunction } from 'express';
import { requireAuth } from '../middleware/auth';
import { createRequestAbortController } from '../http/request_abort';
import { getUserPreferredGenerationModels } from '../llm/generation_preferences';
import { isStrictPrivacy } from '../config/privacy';
import type { mountCreativeRoutes } from './creative_routes';
import { chatSongSongCurrent } from '../../shared/chat_song';
import {
  ChatSongError, listChatSongProjects, getChatSongProject, createChatSongProject,
  applyChatSongAction, draftChatSongDialogue, chatSongHandoff, exportChatSongPackage, getChatSongRender, getChatSongAnimation,
  searchChatSongProjectReactions, chatSongProjectReactionPreview,
} from '../creative/chat_song';
import { renderChatSongVideo } from '../creative/chat_song_render';

const handle = (fn: (req: Request, res: Response) => Promise<unknown>) => (req: Request, res: Response, next: NextFunction) => {
  Promise.resolve(fn(req, res)).catch(error => {
    if (res.headersSent || res.destroyed) return;
    if (error instanceof ChatSongError) return res.status(error.status).json({ error: error.message });
    if (error?.name === 'AbortError') return res.status(409).json({ error: 'Operation cancelled.' });
    next(error);
  });
};
export function mountChatSongRoutes(router: Router, getters: Parameters<typeof mountCreativeRoutes>[2]): void {
  const base = '/creative/chat-songs';
  router.use(base, requireAuth, (req, res, next) => {
    if (req.user?.orgId || req.query.domain === 'work') return res.status(403).json({ error: 'Chat-song projects currently require your personal workspace.' });
    next();
  });
  router.get(base, handle(async (req, res) => res.json({ projects: listChatSongProjects(req.user!.uid) })));
  router.post(base, handle(async (req, res) => res.status(201).json(await createChatSongProject(req.user!.uid, req.body))));
  router.get(`${base}/:id`, handle(async (req, res) => res.json(getChatSongProject(req.user!.uid, String(req.params.id)))));
  router.patch(`${base}/:id`, handle(async (req, res) => res.json(await applyChatSongAction(req.user!.uid, String(req.params.id), req.body?.revision, 'save', req.body?.project))));
  router.post(`${base}/:id/action`, handle(async (req, res) => {
    const { action, revision, value } = req.body || {}, request = createRequestAbortController(req, res);
    try { res.json(await applyChatSongAction(req.user!.uid, String(req.params.id), revision, action, value, request.signal)); }
    finally { request.dispose(); }
  }));
  router.post(`${base}/:id/draft`, handle(async (req, res) => {
    const request = createRequestAbortController(req, res);
    try { res.json(await draftChatSongDialogue(req.user!.uid, String(req.params.id), req.body?.revision, getters, request.signal)); }
    finally { request.dispose(); }
  }));
  router.post(`${base}/:id/reactions/search`, handle(async (req, res) => {
    const request = createRequestAbortController(req, res);
    try { res.json(await searchChatSongProjectReactions(req.user!.uid, String(req.params.id), req.body?.revision, req.body?.lines, request.signal,
      req.body?.dataRoutingPolicy === 'local_only' ? 'local_only' : undefined)); }
    finally { request.dispose(); }
  }));
  router.get(`${base}/:id/reactions/:candidateId/preview`, handle(async (req, res) => {
    const image = chatSongProjectReactionPreview(req.user!.uid, String(req.params.id), String(req.params.candidateId));
    res.setHeader('Cache-Control', 'private, no-store'); res.type('png').send(image.bytes);
  }));
  router.get(`${base}/:id/handoff`, handle(async (req, res) => res.json(chatSongHandoff(getChatSongProject(req.user!.uid, String(req.params.id))))));
  router.post(`${base}/:id/media-preflight`, handle(async (req, res) => {
    const project = getChatSongProject(req.user!.uid, String(req.params.id));
    const lane = req.body?.mode === 'video' ? 'video' : 'image';
    if (lane === 'video' && project.brief.outputStyle !== 'animation') throw new ChatSongError(409, 'The selected chat format is composed locally from images. Select animation before requesting model video generation.');
    if (req.body?.revision !== undefined && req.body.revision !== project.revision) throw new ChatSongError(409, 'Reload the current project before generating media.');
    if (lane === 'video' && !chatSongSongCurrent(project)) throw new ChatSongError(409, 'Select a song for the current finalized dialogue before generating video.');
    if (isStrictPrivacy() || getUserPreferredGenerationModels(req.user!.uid)[lane].provider !== 'relay') throw new ChatSongError(409, 'Choose Lumi Official API for this generation role in model settings. Local-only privacy mode must be off.');
    res.json({ ok: true });
  }));
  router.post(`${base}/:id/export`, handle(async (req, res) => {
    const project = getChatSongProject(req.user!.uid, String(req.params.id));
    if (req.body?.revision !== project.revision) throw new ChatSongError(409, 'Reload the current project before exporting.');
    res.json(await exportChatSongPackage(req.user!.uid, project));
  }));
  router.get(`${base}/:id/render`, handle(async (req, res) => {
    const userId = req.user!.uid, id = String(req.params.id), render = getChatSongRender(userId, id);
    try { res.json({ render, animation: getChatSongAnimation(userId, id) }); }
    catch (error) { if (!(error instanceof ChatSongError)) throw error; res.json({ render, animation: null, animationError: error.message }); }
  }));
  router.post(`${base}/:id/render`, handle(async (req, res) => {
    const request = createRequestAbortController(req, res);
    try { res.json({ render: await renderChatSongVideo(req.user!.uid, String(req.params.id), req.body?.revision, request.signal) }); }
    finally { request.dispose(); }
  }));
}
