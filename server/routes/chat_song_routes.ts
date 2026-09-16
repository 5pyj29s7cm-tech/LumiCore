import { Router, type Request, type Response, type NextFunction } from 'express';
import { requireAuth } from '../middleware/auth';
import { createRequestAbortController } from '../http/request_abort';
import { makeLLMCall } from '../llm/providers';
import { getUserPreferredLLMConfig } from '../llm/user_preferences';
import { getUserPreferredGenerationModels } from '../llm/generation_preferences';
import { isStrictPrivacy } from '../config/privacy';
import type { mountCreativeRoutes } from './creative_routes';
import { chatSongDraftPrompt, chatSongImagePrompt, chatSongSingingPrompt } from '../regions/packs/cn/chat_song';
import { chatSongLyrics } from '../../shared/chat_song';
import {
  ChatSongError, listChatSongProjects, getChatSongProject, createChatSongProject, changeChatSongProject,
  editChatSongProject, lockChatSongScript, attachChatSongAsset, selectChatSongAudio, confirmChatSongAudio,
  setChatSongTimings, normalizeChatSongLines, exportChatSongPackage,
} from '../creative/chat_song';

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
  router.patch(`${base}/:id`, handle(async (req, res) => res.json(await changeChatSongProject(req.user!.uid, String(req.params.id), req.body?.revision, project => editChatSongProject(project, req.body?.project)))));
  router.post(`${base}/:id/action`, handle(async (req, res) => {
    const { action, revision, value } = req.body || {};
    const project = await changeChatSongProject(req.user!.uid, String(req.params.id), revision, async draft => {
      if (action === 'lock-script') lockChatSongScript(draft);
      else if (action === 'attach-asset') await attachChatSongAsset(req.user!.uid, draft, value);
      else if (action === 'select-song') await selectChatSongAudio(req.user!.uid, draft, value);
      else if (action === 'remove-asset') draft.assets = draft.assets.filter(asset => asset.id !== value);
      else if (action === 'confirm-song') confirmChatSongAudio(draft, value);
      else if (action === 'set-timings') setChatSongTimings(draft, value);
      else throw new ChatSongError(400, 'Unknown project action.');
    });
    res.json(project);
  }));
  router.post(`${base}/:id/draft`, handle(async (req, res) => {
    const project = getChatSongProject(req.user!.uid, String(req.params.id));
    if (req.body?.revision !== project.revision) throw new ChatSongError(409, 'Save or reload the current project first.');
    const request = createRequestAbortController(req, res);
    try {
      const config = getUserPreferredLLMConfig(req.user!.uid, { maxTokens: 4000, domain: 'personal', source: 'chat-song-draft' });
      if (isStrictPrivacy() || config.provider !== 'relay') throw new ChatSongError(409, 'Choose Lumi Official API in model settings. Cloud creation is unavailable in local-only privacy mode.');
      const response = await makeLLMCall([{ role: 'user', content: chatSongDraftPrompt(project) }], [],
        { ...config, selectionMode: 'pinned', fallbackCandidates: [], allowCloudFallback: false, signal: request.signal },
        getters.getDeepSeek, getters.getGemini, getters.getOpenAI, getters.getAnthropic, getters.getQwen, getters.getOllama,
        getters.getLmStudio, getters.getArk, getters.getXiaomi, getters.getKimi, getters.getGlm, getters.getRelay);
      request.signal.throwIfAborted();
      let output: unknown;
      try { output = JSON.parse(String(response.text || '').replace(/^\s*```(?:json)?\s*|\s*```\s*$/g, '')); }
      catch { throw new ChatSongError(502, 'The model returned an incomplete draft. Your saved dialogue has not changed.'); }
      const lines = normalizeChatSongLines((output as any)?.lines);
      if (lines.length < 2 || !lines.some(line => line.role === 'A') || !lines.some(line => line.role === 'B')) throw new ChatSongError(502, 'The draft must include both speakers.');
      res.json({ revision: project.revision, lines });
    } finally { request.dispose(); }
  }));
  router.get(`${base}/:id/handoff`, handle(async (req, res) => {
    const project = getChatSongProject(req.user!.uid, String(req.params.id));
    const prompts = ['background', 'avatarA', 'avatarB'].map(kind => ({ kind, lineId: '', prompt: chatSongImagePrompt(project, kind) }));
    for (const line of project.lines.filter(line => line.reaction)) prompts.push({ kind: 'reaction', lineId: line.id, prompt: chatSongImagePrompt(project, 'reaction', line.id) });
    for (const line of project.lines.filter(line => line.reaction)) prompts.push({ kind: 'clip', lineId: line.id, prompt: chatSongImagePrompt(project, 'clip', line.id) });
    res.json({ lyrics: chatSongLyrics(project.lines), singing: chatSongSingingPrompt(project), prompts });
  }));
  router.post(`${base}/:id/media-preflight`, handle(async (req, res) => {
    getChatSongProject(req.user!.uid, String(req.params.id));
    const lane = req.body?.mode === 'video' ? 'video' : 'image';
    if (isStrictPrivacy() || getUserPreferredGenerationModels(req.user!.uid)[lane].provider !== 'relay') throw new ChatSongError(409, 'Choose Lumi Official API for this generation role in model settings. Local-only privacy mode must be off.');
    res.json({ ok: true });
  }));
  router.post(`${base}/:id/export`, handle(async (req, res) => {
    const project = getChatSongProject(req.user!.uid, String(req.params.id));
    if (req.body?.revision !== project.revision) throw new ChatSongError(409, 'Reload the current project before exporting.');
    res.json(await exportChatSongPackage(req.user!.uid, project));
  }));
}
