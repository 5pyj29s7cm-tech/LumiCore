import { Router, Request, Response, NextFunction } from 'express';
import { getActiveConversation, getMessages } from '../conversation/manager';
import { requireAuth } from '../middleware/auth';
import { createMemoryAvatar, getMemoryAvatar, listMemoryAvatars, archiveMemoryAvatar } from '../memory_avatar/store';

const asyncHandler = (fn: (req: Request, res: Response, next: NextFunction) => Promise<any>) =>
  (req: Request, res: Response, next: NextFunction) => Promise.resolve(fn(req, res, next)).catch(next);

function publicAvatar(avatar: any) {
  return {
    id: avatar.id,
    name: avatar.name,
    relationshipType: avatar.relationshipType,
    status: avatar.status,
    isFrozen: avatar.isFrozen !== false,
    evidenceMap: avatar.evidenceMap || [],
    seedMemoryIds: (avatar.seedMemories || []).map((_: unknown, index: number) => `${avatar.id}:seed:${index}`),
    narrative: avatar.narrative || '',
    personalityConfig: avatar.personalityConfig || {},
    createdAt: avatar.createdAt,
    updatedAt: avatar.updatedAt,
    memoryCount: (avatar.seedMemories || []).length,
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

  router.post('/memory-avatars', requireAuth, (req, res) => {
    const body = req.body || {};
    if (!body.personalityConfig || typeof body.personalityConfig !== 'object') {
      return res.status(400).json({ error: 'personalityConfig is required' });
    }
    const config = {
      ...body.personalityConfig,
      // A memory avatar is deliberately a private conversational persona. It
      // cannot acquire tools or alter the single-core task scheduler.
      toolPolicy: {
        ...(body.personalityConfig.toolPolicy || {}),
        allowedTools: [],
        requireConfirmation: [],
        forbiddenTools: ['*'],
        maxIterations: 0,
      },
      memoryPolicy: {
        ...(body.personalityConfig.memoryPolicy || {}),
        retrieveLimit: Math.min(20, Math.max(1, Number(body.personalityConfig.memoryPolicy?.retrieveLimit) || 10)),
        autoExtract: true,
      },
    };
    const avatar = createMemoryAvatar({
      userId: req.user!.uid,
      name: String(body.name || 'Memory').slice(0, 120),
      relationshipType: String(body.relationshipType || 'close_friend').slice(0, 40),
      personalityConfig: config,
      evidenceMap: Array.isArray(body.evidenceMap) ? body.evidenceMap : [],
      seedMemories: Array.isArray(body.seedMemories) ? body.seedMemories : [],
      narrative: String(body.narrative || '').slice(0, 2000),
    });
    return res.status(201).json(publicAvatar(avatar));
  });

  router.get('/memory-avatars/:id/history', requireAuth, (req, res) => {
    const id = String(req.params.id || '');
    const avatar = getMemoryAvatar(req.user!.uid, id);
    if (!avatar || avatar.status !== 'active') return res.status(404).json({ error: 'Memory avatar not found' });
    const conversation = getActiveConversation(req.user!.uid, id, 'personal', '');
    const messages = conversation ? getMessages(conversation.id, 150) : [];
    return res.json(messages.map((message: any) => ({
      role: message.role,
      content: message.content || message.message || '',
      timestamp: message.createdAt || message.timestamp,
    })));
  });

  router.delete('/memory-avatars/:id', requireAuth, (req, res) => {
    if (!archiveMemoryAvatar(req.user!.uid, String(req.params.id || ''))) {
      return res.status(404).json({ error: 'Memory avatar not found' });
    }
    return res.json({ ok: true });
  });
}

