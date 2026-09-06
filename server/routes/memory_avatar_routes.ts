import { Router, Request, Response, NextFunction } from 'express';
import { getActiveConversation, getMessages } from '../conversation/manager';
import { requireAuth } from '../middleware/auth';
import { createMemoryAvatar, getMemoryAvatar, listMemoryAvatars, archiveMemoryAvatar, updateMemoryAvatar, listMemoryAvatarMaterials, addMemoryAvatarMaterial, removeMemoryAvatarMaterial, MemoryAvatarError } from '../memory_avatar/store';

const asyncHandler = (fn: (req: Request, res: Response, next: NextFunction) => Promise<any>) =>
  (req: Request, res: Response, next: NextFunction) => Promise.resolve(fn(req, res, next)).catch(error => {
    if (error instanceof MemoryAvatarError) return res.status(error.status).json({ error: error.message, code: error.code });
    next(error);
  });

function publicAvatar(avatar: any) {
  return {
    id: avatar.id,
    name: avatar.name,
    relationshipType: avatar.relationshipType,
    status: avatar.status,
    isFrozen: avatar.isFrozen !== false,
    evidenceMap: avatar.evidenceMap || [],
    seedMemoryIds: avatar.seedMemoryIds || [],
    revision: avatar.revision,
    appearance: avatar.appearance,
    voice: avatar.voice,
    narrative: avatar.narrative || '',
    personalityConfig: avatar.personalityConfig || {},
    createdAt: avatar.createdAt,
    updatedAt: avatar.updatedAt,
    memoryCount: avatar.memoryCount,
  };
}

export function mountMemoryAvatarRoutes(
  router: Router,
  llmGetters: {
    getDeepSeek: () => any; getGemini: () => any; getOpenAI?: () => any;
    getAnthropic?: () => any; getQwen?: () => any; getOllama?: () => any;
    getLmStudio?: () => any; getArk?: () => any; getXiaomi?: () => any;
    getKimi?: () => any; getGlm?: () => any; getRelay?: () => any;
  },
) {
  router.post('/memory-avatars/distill', requireAuth, asyncHandler(async (req, res) => {
    const { chatLog, format, relationshipType, name: targetName, audioTranscript } = req.body || {};
    if (typeof chatLog !== 'string' || !chatLog.trim() || !format) {
      return res.status(400).json({ error: 'chatLog and format are required' });
    }
    if (!['wechat', 'qq', 'plain'].includes(format)) {
      return res.status(400).json({ error: 'format must be: wechat, qq, or plain' });
    }
    const { distillPersona } = await import('../memory_avatar/distiller');
    const result = await distillPersona(
      {
        chatLog,
        format,
        targetName: typeof targetName === 'string' ? targetName.slice(0, 120) : undefined,
        relationshipType: typeof relationshipType === 'string' ? relationshipType.slice(0, 40) : undefined,
        userId: req.user!.uid,
        audioTranscript: typeof audioTranscript === 'string' ? audioTranscript.slice(0, 20_000) : undefined,
      },
      {
        getDeepSeek: llmGetters.getDeepSeek,
        getGemini: llmGetters.getGemini,
        getOpenAI: llmGetters.getOpenAI,
        getAnthropic: llmGetters.getAnthropic,
        getQwen: llmGetters.getQwen,
        getOllama: llmGetters.getOllama,
        getLmStudio: llmGetters.getLmStudio,
        getArk: llmGetters.getArk,
        getXiaomi: llmGetters.getXiaomi,
        getKimi: llmGetters.getKimi,
        getGlm: llmGetters.getGlm,
        getRelay: llmGetters.getRelay,
      },
    );
    return res.json({
      personalityConfig: result.personalityConfig,
      seedMemories: result.seedMemories,
      evidenceMap: result.evidenceMap,
      relationshipType: result.relationshipType,
      narrative: result.narrative,
      inferredName: result.inferredName,
      summary: {
        messageCount: chatLog.split('\n').filter((line: string) => line.trim()).length,
        memoryCount: result.seedMemories.length,
        cognitiveStyle: result.personalityConfig.personalityVector?.cognitiveStyle,
        socialStyle: result.personalityConfig.personalityVector?.socialStyle,
        tone: result.personalityConfig.expressionStyle?.tone,
        topPhrases: result.personalityConfig.expressionStyle?.vocabularyHints?.slice(0, 5),
      },
    });
  }));

  router.get('/memory-avatars', requireAuth, (req, res) => {
    res.json({ avatars: listMemoryAvatars(req.user!.uid).map(publicAvatar) });
  });

  router.get('/memory-avatars/:id', requireAuth, (req, res) => {
    const avatar = getMemoryAvatar(req.user!.uid, String(req.params.id || ''));
    if (!avatar || avatar.status !== 'active') return res.status(404).json({ error: 'Memory avatar not found' });
    return res.json(publicAvatar(avatar));
  });

  router.post('/memory-avatars', requireAuth, asyncHandler(async (req, res) => {
    const avatar = await createMemoryAvatar({ ...req.body, userId: req.user!.uid });
    return res.status(201).json(publicAvatar(avatar));
  }));

  router.patch('/memory-avatars/:id', requireAuth, asyncHandler(async (req, res) => {
    const avatar = await updateMemoryAvatar(req.user!.uid, String(req.params.id), req.body || {});
    return res.json(publicAvatar(avatar));
  }));

  router.get('/memory-avatars/:id/materials', requireAuth, asyncHandler(async (req, res) => {
    return res.json(listMemoryAvatarMaterials(req.user!.uid, String(req.params.id)));
  }));

  router.post('/memory-avatars/:id/materials', requireAuth, asyncHandler(async (req, res) => {
    const result = await addMemoryAvatarMaterial(req.user!.uid, String(req.params.id), req.body || {});
    return res.status(201).json({ material: result.material, avatar: publicAvatar(result.avatar) });
  }));

  router.delete('/memory-avatars/:id/materials/:materialId', requireAuth, asyncHandler(async (req, res) => {
    const avatar = await removeMemoryAvatarMaterial(req.user!.uid, String(req.params.id), String(req.params.materialId), req.body?.revision);
    return res.json({ ok: true, avatar: publicAvatar(avatar) });
  }));

  router.get('/memory-avatars/:id/history', requireAuth, (req, res) => {
    const id = String(req.params.id || '');
    const avatar = getMemoryAvatar(req.user!.uid, id);
    if (!avatar || avatar.status !== 'active') return res.status(404).json({ error: 'Memory avatar not found' });
    const conversation = getActiveConversation(req.user!.uid, id, 'personal', '');
    const messages = conversation ? getMessages(conversation.id, 150) : [];
    return res.json(messages.map((message: any) => ({
      id: message.id,
      requestId: message.requestId || message.externalMessageId || '',
      role: message.role,
      content: message.content || message.message || '',
      timestamp: message.createdAt || message.timestamp,
    })));
  });

  router.delete('/memory-avatars/:id', requireAuth, asyncHandler(async (req, res) => {
    await archiveMemoryAvatar(req.user!.uid, String(req.params.id), req.body?.revision);
    return res.json({ ok: true });
  }));
}
