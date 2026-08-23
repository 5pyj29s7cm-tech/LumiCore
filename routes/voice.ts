import { Router, Request, Response } from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { execFileSync } from 'child_process';
import { synthesizeSpeech, cloneVoice, getVoiceCloneStatus, designVoice, listVoices, getActiveProvider, isTTSProviderConfigured } from '../server/tts/adapter';
import { TTSProvider } from '../server/tts/types';
import { logger } from '../logger';
import { recordLatency } from '../server/monitor/latency_store';
import { getDataPath } from '../server/config/data_path';
import { requireAdmin, requireAuth, requireLocalRequest } from '../server/middleware/auth';
import { getCosyVoiceCloneTargetModel, getQwenCloneTargetModel, getQwenDesignTargetModel } from '../server/tts/providers/cosyvoice';
import {
  addScopedVoiceProfile,
  isVoiceProfileAccessible,
  listScopedVoiceProfiles,
  removeScopedVoiceProfile,
  updateScopedVoiceProfile,
  voiceProfileScope,
  type VoiceProfileScope,
} from '../server/tts/profile_store';

const router = Router();

const samplesDir = getDataPath('voice_samples');
fs.mkdirSync(samplesDir, { recursive: true });
const preparedSamplesDir = path.join(samplesDir, '_prepared');
fs.mkdirSync(preparedSamplesDir, { recursive: true });

const PUBLIC_SAMPLE_TOKEN_TTL_MS = 15 * 60 * 1000;
const publicSampleTokens = new Map<string, { filePath: string; userId: string; expiresAt: number }>();

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    const userId = (_req as any).user?.uid || (_req as any).userId || 'anonymous';
    const userDir = path.join(samplesDir, userId);
    fs.mkdirSync(userDir, { recursive: true });
    cb(null, userDir);
  },
  filename: (_req, file, cb) => {
    const timestamp = Date.now();
    const safeName = file.originalname.replace(/[^a-zA-Z0-9_\-. ]/g, '');
    cb(null, `${timestamp}_${safeName}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB per file
  fileFilter: (_req, file, cb) => {
    const base = (file.mimetype || '').split(';')[0];
    const ext = path.extname(file.originalname || '').toLowerCase();
    const allowedMimes = [
      'audio/webm',
      'audio/mp3',
      'audio/mpeg',
      'audio/wav',
      'audio/wave',
      'audio/ogg',
      'audio/mp4',
      'audio/m4a',
      'audio/x-m4a',
      'audio/aac',
      'audio/flac',
      'audio/x-flac',
      'audio/x-wav',
      'audio/x-pn-wav',
    ];
    const allowedExts = ['.webm', '.mp3', '.wav', '.ogg', '.m4a', '.aac', '.flac'];
    if (allowedMimes.includes(base) || allowedExts.includes(ext)) {
      cb(null, true);
    } else {
      cb(new Error(`Unsupported audio format: ${file.mimetype}`));
    }
  },
});

function getUserId(req: Request): string {
  return (req as any).user?.uid || (req as any).userId || 'anonymous';
}

function getRequestVoiceScope(req: Request): VoiceProfileScope {
  return voiceProfileScope(
    getUserId(req),
    req.user?.orgId ? 'work' : 'personal',
    req.user?.orgId || '',
  );
}

function assertCanMutateVoiceAssets(req: Request): void {
  if (!req.user?.orgId) return;
  if (!['owner', 'admin'].includes(String(req.user.orgRole || ''))) {
    throw Object.assign(new Error('Only an organization owner or administrator can create or remove shared voice assets.'), { statusCode: 403 });
  }
}

function getPublicBaseUrl(req: Request): string {
  return (process.env.LUMI_PUBLIC_BASE_URL || process.env.PUBLIC_BASE_URL || `${req.protocol}://${req.get('host')}`).replace(/\/+$/, '');
}

function isLocalOnlyBaseUrl(baseUrl: string): boolean {
  try {
    const host = new URL(baseUrl).hostname.toLowerCase();
    if (host === 'localhost' || host === '::1' || host.endsWith('.local')) return true;
    if (host === '0.0.0.0' || host.startsWith('127.')) return true;
    if (host.startsWith('10.') || host.startsWith('192.168.')) return true;
    const private172 = host.match(/^172\.(\d+)\./);
    if (private172) {
      const second = Number(private172[1]);
      if (second >= 16 && second <= 31) return true;
    }
    if (host.startsWith('fc') || host.startsWith('fd') || host.startsWith('fe80')) return true;
    return false;
  } catch {
    return true;
  }
}

function resolveUserSamplePath(req: Request, sampleUrl: string): string {
  const currentUserId = getUserId(req);
  let pathname = '';

  try {
    pathname = new URL(sampleUrl).pathname;
  } catch {
    pathname = sampleUrl;
  }

  if (!pathname.startsWith('/api/voice/samples/')) {
    throw Object.assign(new Error('Invalid voice sample URL'), { statusCode: 400 });
  }

  const relative = decodeURIComponent(pathname.slice('/api/voice/samples/'.length));
  const [sampleUserId, filename, ...rest] = relative.split('/');
  if (!sampleUserId || !filename || rest.length > 0) {
    throw Object.assign(new Error('Invalid voice sample URL'), { statusCode: 400 });
  }
  if (sampleUserId !== currentUserId) {
    throw Object.assign(new Error('Sample not found'), { statusCode: 403 });
  }

  const userDir = path.resolve(samplesDir, currentUserId);
  const filePath = path.resolve(userDir, filename);
  if (filePath !== userDir && !filePath.startsWith(`${userDir}${path.sep}`)) {
    throw Object.assign(new Error('Invalid voice sample path'), { statusCode: 400 });
  }
  if (!fs.existsSync(filePath)) {
    throw Object.assign(new Error('Sample not found'), { statusCode: 404 });
  }
  return filePath;
}

function runFfmpeg(args: string[], errorPrefix: string) {
  try {
    execFileSync('ffmpeg', args, { stdio: 'pipe', timeout: 30000 });
  } catch (err: any) {
    const detail = err.stderr?.toString()?.slice(0, 240) || err.message || 'ffmpeg failed';
    throw Object.assign(new Error(`${errorPrefix}: ${detail}`), { statusCode: 400 });
  }
}

function isPcm16MonoWav(filePath: string, expectedSampleRate: number): boolean {
  let buffer: Buffer;
  try {
    buffer = fs.readFileSync(filePath);
  } catch {
    return false;
  }

  if (buffer.length < 44) return false;
  if (buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WAVE') return false;

  let offset = 12;
  while (offset + 8 <= buffer.length) {
    const chunkId = buffer.toString('ascii', offset, offset + 4);
    const chunkSize = buffer.readUInt32LE(offset + 4);
    const dataOffset = offset + 8;
    if (chunkId === 'fmt ' && chunkSize >= 16 && dataOffset + 16 <= buffer.length) {
      const audioFormat = buffer.readUInt16LE(dataOffset);
      const channels = buffer.readUInt16LE(dataOffset + 2);
      const sampleRate = buffer.readUInt32LE(dataOffset + 4);
      const bitsPerSample = buffer.readUInt16LE(dataOffset + 14);
      return audioFormat === 1 && channels === 1 && sampleRate === expectedSampleRate && bitsPerSample === 16;
    }
    offset = dataOffset + chunkSize + (chunkSize % 2);
  }

  return false;
}

function prepareCloneSampleFile(inputPaths: string[], userId: string, sampleRate = 16000): string {
  if (inputPaths.length === 0) {
    throw Object.assign(new Error('At least one sample URL is required'), { statusCode: 400 });
  }

  if (inputPaths.length === 1 && isPcm16MonoWav(inputPaths[0], sampleRate)) {
    return inputPaths[0];
  }

  const jobId = crypto.randomBytes(8).toString('hex');
  const userPreparedDir = path.join(preparedSamplesDir, userId);
  fs.mkdirSync(userPreparedDir, { recursive: true });

  const wavPaths = inputPaths.map((inputPath, index) => {
    const wavPath = path.join(userPreparedDir, `${jobId}_${index}.wav`);
    runFfmpeg([
      '-y',
      '-i',
      inputPath,
      '-acodec',
      'pcm_s16le',
      '-ar',
      String(sampleRate),
      '-ac',
      '1',
      wavPath,
    ], 'Audio conversion failed');
    return wavPath;
  });

  if (wavPaths.length === 1) return wavPaths[0];

  const combinedPath = path.join(userPreparedDir, `${jobId}_combined.wav`);
  const filter = `${wavPaths.map((_, index) => `[${index}:a]`).join('')}concat=n=${wavPaths.length}:v=0:a=1[a]`;
  runFfmpeg([
    '-y',
    ...wavPaths.flatMap(wavPath => ['-i', wavPath]),
    '-filter_complex',
    filter,
    '-map',
    '[a]',
    '-acodec',
    'pcm_s16le',
    '-ar',
    String(sampleRate),
    '-ac',
    '1',
    combinedPath,
  ], 'Audio sample merge failed');

  for (const wavPath of wavPaths) {
    try { fs.unlinkSync(wavPath); } catch {}
  }
  return combinedPath;
}

function createPublicSampleUrl(req: Request, filePath: string, userId: string): string {
  const token = crypto.randomBytes(24).toString('base64url');
  publicSampleTokens.set(token, {
    filePath,
    userId,
    expiresAt: Date.now() + PUBLIC_SAMPLE_TOKEN_TTL_MS,
  });
  return `${getPublicBaseUrl(req)}/api/voice/public-samples/${token}`;
}

function getAudioContentType(format: string): { contentType: string; extension: string } {
  const normalized = format || 'mpeg';
  const contentType = normalized.includes('/') ? normalized : `audio/${normalized}`;
  const extension = contentType.replace(/^audio\//, '').replace(/^x-/, '');
  return { contentType, extension };
}

// POST /api/voice/samples — Upload voice sample(s) for cloning
router.post('/voice/samples', requireAuth, (req: Request, res: Response) => {
  try {
    assertCanMutateVoiceAssets(req);
  } catch (err: any) {
    return res.status(err.statusCode || 403).json({ error: err.message });
  }
  upload.array('samples', 5)(req, res, (uploadErr: any) => {
    if (uploadErr) {
      for (const file of (req.files as Express.Multer.File[] | undefined) || []) {
        try { fs.rmSync(file.path, { force: true }); } catch {}
      }
      return res.status(400).json({ error: uploadErr.message || 'Audio upload failed' });
    }
  try {
    const files = req.files as Express.Multer.File[];
    if (!files || files.length === 0) {
      return res.status(400).json({ error: 'No audio files provided' });
    }

    const urls = files.map(f => `/api/voice/samples/${getUserId(req)}/${f.filename}`);
    res.json({ urls, filenames: files.map(f => f.filename), count: files.length });
  } catch (err: any) {
    logger.warn('[Voice Upload Error]', err.message);
    res.status(500).json({ error: err.message });
  }
  });
});

// GET /api/voice/samples/:userId/:filename — Serve uploaded samples
router.get('/voice/samples/:userId/:filename', requireAuth, (req: Request, res: Response) => {
  if (req.params.userId !== req.user!.uid) {
    return res.status(403).json({ error: 'Sample not found' });
  }
  const userDir = path.resolve(samplesDir, req.params.userId);
  const filePath = path.resolve(userDir, req.params.filename);
  if (filePath !== userDir && !filePath.startsWith(`${userDir}${path.sep}`)) {
    return res.status(400).json({ error: 'Invalid sample path' });
  }
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'Sample not found' });
  }
  res.sendFile(filePath);
});

router.get('/voice/public-samples/:token', (req: Request, res: Response) => {
  const entry = publicSampleTokens.get(req.params.token);
  if (!entry || entry.expiresAt < Date.now()) {
    publicSampleTokens.delete(req.params.token);
    return res.status(404).json({ error: 'Sample not found' });
  }
  if (!fs.existsSync(entry.filePath)) {
    publicSampleTokens.delete(req.params.token);
    return res.status(404).json({ error: 'Sample not found' });
  }
  res.sendFile(entry.filePath);
});

// POST /api/voice/clone — Trigger voice cloning
const TTS_PROVIDERS = new Set<TTSProvider>(['local-cosyvoice', 'cosyvoice', 'ark', 'gptsovits']);

function resolveRequestedTtsProvider(value?: unknown): TTSProvider | null {
  const requested = String(value || '').trim() as TTSProvider;
  if (requested) return TTS_PROVIDERS.has(requested) ? requested : null;
  const preference = getVoicePreference();
  if (preference.tts !== 'auto') return preference.tts;
  return getActiveProvider();
}

function providerCapabilities(provider: TTSProvider | null) {
  return {
    clone: provider === 'cosyvoice' || provider === 'ark',
    design: provider === 'cosyvoice',
  };
}

router.post('/voice/clone', requireAuth, async (req: Request, res: Response) => {
  const cleanupPaths = new Set<string>();
  try {
    assertCanMutateVoiceAssets(req);
    const {
      sampleUrls,
      name,
      provider,
      speakerId,
      language,
      sampleText,
      demoText,
      enableAudioDenoise,
      disableVolumeNormalization,
      confirmPostpaidBilling,
    } = req.body;

    if (!sampleUrls || !Array.isArray(sampleUrls) || sampleUrls.length === 0) {
      return res.status(400).json({ error: 'At least one sample URL is required' });
    }
    if (!name || typeof name !== 'string') {
      return res.status(400).json({ error: 'Voice name is required' });
    }

    const activeProvider = resolveRequestedTtsProvider(provider);
    if (!activeProvider) {
      return res.status(400).json({ error: 'Choose and configure a voice service before cloning.' });
    }
    if (!['cosyvoice', 'ark'].includes(activeProvider)) {
      return res.status(400).json({
        error: `Voice cloning is not available for the selected ${activeProvider} service. Switch the voice service to Qwen / DashScope CosyVoice to clone, or connect that provider's cloning adapter.`,
        activeProvider,
        supportedProviders: ['cosyvoice', 'ark'],
      });
    }

    if (sampleUrls.length > 5) {
      return res.status(400).json({ error: 'Up to 5 samples can be cloned at once' });
    }

    const cleanName = name.trim();
    if (!cleanName) {
      return res.status(400).json({ error: 'Voice name is required' });
    }
    const requestedSpeakerId = typeof speakerId === 'string' ? speakerId.trim() : '';
    if (activeProvider === 'ark' && !requestedSpeakerId && confirmPostpaidBilling !== true) {
      return res.status(409).json({
        error: 'Creating a new Doubao clone uses a postpaid voice slot. Confirm that the first formal synthesis will activate and charge the slot, or provide an existing prepaid speaker ID.',
        confirmationRequired: true,
        confirmationType: 'doubao_postpaid_voice_slot',
      });
    }
    const localSamplePaths = sampleUrls.map((url: string) => resolveUserSamplePath(req, url));
    localSamplePaths.forEach(filePath => cleanupPaths.add(filePath));
    let voiceModel: string;
    let cloneResult;

    if (activeProvider === 'ark') {
      const cloneAudioPath = prepareCloneSampleFile(localSamplePaths, getUserId(req), 24000);
      cleanupPaths.add(cloneAudioPath);
      voiceModel = 'seed-icl-2.0';
      cloneResult = await cloneVoice({
        sampleUrls: [cloneAudioPath],
        name: cleanName,
        speakerId: requestedSpeakerId || undefined,
        language: Number.isFinite(Number(language)) ? Number(language) : 0,
        sampleText: typeof sampleText === 'string' ? sampleText : undefined,
        demoText: typeof demoText === 'string' && demoText.trim()
          ? demoText.trim()
          : '你好，我是 Lumi，这是我的声音复刻试听。',
        enableAudioDenoise: typeof enableAudioDenoise === 'boolean' ? enableAudioDenoise : false,
        disableVolumeNormalization: typeof disableVolumeNormalization === 'boolean'
          ? disableVolumeNormalization
          : false,
      }, activeProvider);
    } else {
      const explicitCloneAudioMode = process.env.COSYVOICE_CLONE_AUDIO_MODE?.toLowerCase();
      const publicBaseUrl = getPublicBaseUrl(req);
      const cloneAudioMode = explicitCloneAudioMode || (isLocalOnlyBaseUrl(publicBaseUrl) ? 'data-url' : 'url');
      if (cloneAudioMode !== 'data-url' && isLocalOnlyBaseUrl(publicBaseUrl)) {
        return res.status(400).json({
          error: 'CosyVoice voice cloning needs a public backend URL so DashScope can fetch the prepared audio sample. Set LUMI_PUBLIC_BASE_URL to an HTTPS tunnel or deployed domain, or set COSYVOICE_CLONE_AUDIO_MODE=data-url if your DashScope endpoint supports data URLs.',
          requiresPublicBaseUrl: true,
        });
      }
      const cloneAudioPath = prepareCloneSampleFile(localSamplePaths, getUserId(req));
      cleanupPaths.add(cloneAudioPath);
      const cloneSampleUrls = cloneAudioMode === 'data-url'
        ? [cloneAudioPath]
        : [createPublicSampleUrl(req, cloneAudioPath, getUserId(req))];
      voiceModel = cloneAudioMode === 'data-url' ? getQwenCloneTargetModel() : getCosyVoiceCloneTargetModel();
      cloneResult = await cloneVoice({ sampleUrls: cloneSampleUrls, name: cleanName }, activeProvider);
    }
    const voiceId = cloneResult.voiceId;

    const scope = getRequestVoiceScope(req);
    addScopedVoiceProfile(scope, {
      voiceId,
      name: cleanName,
      provider: activeProvider,
      category: 'cloned',
      model: voiceModel,
      source: 'cloned',
      status: cloneResult.status,
      demoAudio: cloneResult.demoAudio,
      billingMode: cloneResult.billingMode,
      availableTrainingTimes: cloneResult.availableTrainingTimes,
      statusMessage: cloneResult.message,
      createdAt: new Date().toISOString(),
    });
    res.json({
      voiceId,
      name: cleanName,
      provider: activeProvider,
      category: 'cloned',
      model: voiceModel,
      source: 'cloned',
      status: cloneResult.status,
      demoAudio: cloneResult.demoAudio,
      billingMode: cloneResult.billingMode,
      availableTrainingTimes: cloneResult.availableTrainingTimes,
      message: cloneResult.message,
    });
  } catch (err: any) {
    logger.error('[Voice Clone Error]', err);
    res.status(err.statusCode || 500).json({ error: err.message || 'Voice cloning service unavailable' });
  } finally {
    for (const filePath of cleanupPaths) {
      try { fs.rmSync(filePath, { force: true }); } catch {}
      for (const [token, entry] of publicSampleTokens) {
        if (entry.filePath === filePath) publicSampleTokens.delete(token);
      }
    }
  }
});

router.get('/voice/clone-status/:voiceId', requireAuth, async (req: Request, res: Response) => {
  try {
    const scope = getRequestVoiceScope(req);
    const profile = listScopedVoiceProfiles(scope).find((voice: any) => voice.voiceId === req.params.voiceId);
    if (!profile) return res.status(404).json({ error: 'Voice not found' });
    if (profile.provider !== 'ark') return res.json(profile);

    const status = await getVoiceCloneStatus(profile.voiceId, 'ark', profile.billingMode);
    const updated = updateScopedVoiceProfile(scope, profile.voiceId, {
      status: status.status,
      demoAudio: status.demoAudio || profile.demoAudio,
      availableTrainingTimes: status.availableTrainingTimes,
      statusMessage: status.message,
      lastStatusCheckAt: new Date().toISOString(),
    });
    res.json(updated || { ...profile, ...status });
  } catch (err: any) {
    logger.error('[Voice Clone Status Error]', err);
    res.status(err.statusCode || 502).json({ error: err.message || 'Voice clone status unavailable' });
  }
});

// POST /api/voice/design — Design a new voice from text description
router.post('/voice/design', requireAuth, async (req: Request, res: Response) => {
  try {
    assertCanMutateVoiceAssets(req);
    const { prompt, name } = req.body;
    if (!prompt || typeof prompt !== 'string' || prompt.trim().length < 10) {
      return res.status(400).json({ error: 'Voice prompt is required (at least 10 characters)' });
    }
    if (!name || typeof name !== 'string') {
      return res.status(400).json({ error: 'Voice name is required' });
    }
    const activeProvider = resolveRequestedTtsProvider(req.body?.provider);
    if (!activeProvider) {
      return res.status(400).json({ error: 'Choose and configure a voice service before designing a voice.' });
    }
    if (activeProvider !== 'cosyvoice') {
      return res.status(400).json({
        error: `Voice design is not available for the selected ${activeProvider} service.`,
        activeProvider,
        supportedProviders: ['cosyvoice'],
      });
    }

    const cleanName = name.trim();
    if (!cleanName) {
      return res.status(400).json({ error: 'Voice name is required' });
    }
    const voiceModel = getQwenDesignTargetModel();
    const voiceId = await designVoice(prompt.trim(), cleanName, activeProvider);

    addScopedVoiceProfile(getRequestVoiceScope(req), {
      voiceId,
      name: cleanName,
      provider: activeProvider,
      category: 'cloned',
      model: voiceModel,
      source: 'designed',
      prompt: prompt.trim(),
      createdAt: new Date().toISOString(),
    });

    res.json({ voiceId, name: cleanName, provider: activeProvider, category: 'cloned', model: voiceModel, source: 'designed' });
  } catch (err: any) {
    logger.error('[Voice Design Error]', err);
    res.status(err.statusCode || 500).json({ error: err.message || 'Voice design service unavailable' });
  }
});

// GET /api/voice/voices — List user's cloned voices + ALL provider premade voices
router.get('/voice/voices', requireAuth, async (req: Request, res: Response) => {
  try {
    const requested = String(req.query.provider || '').trim();
    if (requested && !TTS_PROVIDERS.has(requested as TTSProvider)) {
      return res.status(400).json({ error: 'Unknown TTS provider' });
    }
    const provider = resolveRequestedTtsProvider(requested);
    const userVoices = listScopedVoiceProfiles(getRequestVoiceScope(req)).filter((voice: any) => (
      provider ? String(voice.provider || 'cosyvoice') === provider : false
    )).map((voice: any) => ({
      ...voice,
      category: 'cloned' as const,
    }));

    // Keep the catalogue isolated to the selected service.
    let premadeVoices: any[] = [];
    for (const selectedProvider of provider ? [provider] : []) {
      try {
        const voices = await listVoices(selectedProvider);
        // Preserve the provider identity for preview and selection.
        premadeVoices.push(...voices.map(v => ({ ...v, category: v.category || 'premade', provider: selectedProvider })));
      } catch {
        // Provider not available — skip
      }
    }

    res.json({
      provider,
      configured: provider ? isTTSProviderConfigured(provider) : false,
      capabilities: providerCapabilities(provider),
      cloned: userVoices,
      premade: premadeVoices,
    });
  } catch (err: any) {
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});

// DELETE /api/voice/:voiceId — Delete a cloned voice
router.delete('/voice/:voiceId', requireAuth, async (req: Request, res: Response) => {
  try {
    assertCanMutateVoiceAssets(req);
    const removed = removeScopedVoiceProfile(getRequestVoiceScope(req), req.params.voiceId);
    if (!removed) return res.status(404).json({ error: 'Voice not found' });

    res.json({ deleted: removed });
  } catch (err: any) {
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});

// POST /api/voice/synthesize — Synthesize speech (for TTS without full voice call)
router.post('/voice/synthesize', requireAuth, async (req: Request, res: Response) => {
  try {
    const { text, voiceId, provider, model } = req.body;

    if (!text || typeof text !== 'string') {
      return res.status(400).json({ error: 'Text is required' });
    }

    const activeProvider = provider || getActiveProvider();
    if (!activeProvider) {
      return res.status(400).json({ error: 'No TTS provider configured' });
    }
    if (!isVoiceProfileAccessible(getRequestVoiceScope(req), voiceId || 'default')) {
      return res.status(403).json({ error: 'This cloned voice belongs to a different Lumi domain.' });
    }

    const start = Date.now();
    const result = await synthesizeSpeech(text, {
      provider: activeProvider,
      voiceId: voiceId || 'default',
      model,
      allowFallback: !provider,
    });
    recordLatency('tts', Date.now() - start);

    const { contentType, extension } = getAudioContentType(result.format);
    res.set('Content-Type', contentType);
    res.set('X-Audio-Format', extension);
    res.send(result.audioBuffer);
  } catch (err: any) {
    logger.error('[Voice Synthesize Error]', err);
    res.status(500).json({ error: 'Speech synthesis unavailable' });
  }
});

// Voice provider preferences
import { getVoicePreference, setVoicePreference } from '../server/config/voice_preference';
import { getActiveProvider as getActiveTTSProvider } from '../server/tts/adapter';
import { getActiveSTTProvider } from '../server/stt/adapter';

router.get('/voice/active-provider', requireAuth, requireAdmin, requireLocalRequest, (_req, res) => {
  try {
    const pref = getVoicePreference();
    res.json({
      pref,
      active: {
        stt: getActiveSTTProvider({ requireHealthy: true }),
        tts: getActiveTTSProvider?.({ requireHealthy: true }) || null,
      },
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/voice/provider', requireAuth, requireAdmin, requireLocalRequest, (req, res) => {
  try {
    if (req.user?.orgId) {
      return res.status(403).json({ error: 'Voice provider selection belongs to the local personal Lumi settings.' });
    }
    const { stt, tts } = req.body;
    const merged = setVoicePreference({ stt: stt || undefined, tts: tts || undefined } as any);
    res.json(merged);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
