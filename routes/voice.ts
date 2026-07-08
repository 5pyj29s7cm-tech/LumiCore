import { Router, Request, Response } from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { execFileSync } from 'child_process';
import { synthesizeSpeech, cloneVoice, designVoice, listVoices, getActiveProvider, isTTSProviderConfigured } from '../server/tts/adapter';
import { TTSProvider } from '../server/tts/types';
import { readDB, writeDB } from '../db_layer';
import { logger } from '../logger';
import { recordLatency } from '../server/monitor/latency_store';
import { getDataPath } from '../server/config/data_path';
import { requireAuth } from '../server/middleware/auth';
import { getCosyVoiceCloneTargetModel, getQwenCloneTargetModel, getQwenDesignTargetModel } from '../server/tts/providers/cosyvoice';

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

function isPcm16Mono16kWav(filePath: string): boolean {
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
      return audioFormat === 1 && channels === 1 && sampleRate === 16000 && bitsPerSample === 16;
    }
    offset = dataOffset + chunkSize + (chunkSize % 2);
  }

  return false;
}

function prepareCloneSampleFile(inputPaths: string[], userId: string): string {
  if (inputPaths.length === 0) {
    throw Object.assign(new Error('At least one sample URL is required'), { statusCode: 400 });
  }

  if (inputPaths.length === 1 && isPcm16Mono16kWav(inputPaths[0])) {
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
      '16000',
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
    '16000',
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
  upload.array('samples', 5)(req, res, (uploadErr: any) => {
    if (uploadErr) {
      return res.status(400).json({ error: uploadErr.message || 'Audio upload failed' });
    }
  try {
    const files = req.files as Express.Multer.File[];
    console.log('[Voice Upload] Received files:', files?.length, 'userId:', getUserId(req));
    if (!files || files.length === 0) {
      console.log('[Voice Upload] No files — req.file:', req.file, 'req.files:', req.files, 'req.body:', req.body);
      return res.status(400).json({ error: 'No audio files provided' });
    }
    files.forEach(f => console.log('[Voice Upload] File:', f.filename, f.size, f.mimetype, f.path));

    const urls = files.map(f => `/api/voice/samples/${getUserId(req)}/${f.filename}`);
    console.log('[Voice Upload] Returning URLs:', urls);
    res.json({ urls, filenames: files.map(f => f.filename), count: files.length });
  } catch (err: any) {
    console.log('[Voice Upload] Error:', err.message);
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
router.post('/voice/clone', requireAuth, async (req: Request, res: Response) => {
  try {
    const { sampleUrls, name, provider } = req.body;

    if (!sampleUrls || !Array.isArray(sampleUrls) || sampleUrls.length === 0) {
      return res.status(400).json({ error: 'At least one sample URL is required' });
    }
    if (!name || typeof name !== 'string') {
      return res.status(400).json({ error: 'Voice name is required' });
    }

    const activeProvider = (provider || 'cosyvoice') as TTSProvider;
    if (activeProvider !== 'cosyvoice') {
      return res.status(400).json({
        error: 'Voice cloning currently supports DashScope CosyVoice only. Choose DashScope CosyVoice in the cloning flow or add a provider adapter.',
        activeProvider,
        supportedProviders: ['cosyvoice'],
      });
    }

    if (sampleUrls.length > 5) {
      return res.status(400).json({ error: 'Up to 5 samples can be cloned at once' });
    }

    const cleanName = name.trim();
    if (!cleanName) {
      return res.status(400).json({ error: 'Voice name is required' });
    }
    const localSamplePaths = sampleUrls.map((url: string) => resolveUserSamplePath(req, url));
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
    const cloneSampleUrls = cloneAudioMode === 'data-url'
      ? [cloneAudioPath]
      : [createPublicSampleUrl(req, cloneAudioPath, getUserId(req))];
    const voiceModel = cloneAudioMode === 'data-url' ? getQwenCloneTargetModel() : getCosyVoiceCloneTargetModel();
    console.log('[Voice Clone] samples:', sampleUrls.length, 'prepared:', cloneAudioPath, 'name:', cleanName, 'provider:', activeProvider, 'mode:', cloneAudioMode);

    const voiceId = await cloneVoice({ sampleUrls: cloneSampleUrls, name: cleanName }, activeProvider);
    console.log('[Voice Clone] Got voiceId:', voiceId);

    // Store voice reference in user data
    const db = readDB();
    const userId = getUserId(req);
    console.log('[Voice Clone] Writing to DB for userId:', userId);
    if (!db.voiceProfiles) db.voiceProfiles = {};
    if (!db.voiceProfiles[userId]) db.voiceProfiles[userId] = [];
    db.voiceProfiles[userId].push({
      voiceId,
      name: cleanName,
      provider: activeProvider,
      category: 'cloned',
      model: voiceModel,
      source: 'cloned',
      createdAt: new Date().toISOString(),
    });
    writeDB(db);
    console.log('[Voice Clone] DB written, responding with voiceId:', voiceId);

    res.json({ voiceId, name: cleanName, provider: activeProvider, category: 'cloned', model: voiceModel, source: 'cloned' });
  } catch (err: any) {
    logger.error('[Voice Clone Error]', err);
    res.status(err.statusCode || 500).json({ error: err.message || 'Voice cloning service unavailable' });
  }
});

// POST /api/voice/design — Design a new voice from text description
router.post('/voice/design', requireAuth, async (req: Request, res: Response) => {
  try {
    const { prompt, name } = req.body;
    if (!prompt || typeof prompt !== 'string' || prompt.trim().length < 10) {
      return res.status(400).json({ error: 'Voice prompt is required (at least 10 characters)' });
    }
    if (!name || typeof name !== 'string') {
      return res.status(400).json({ error: 'Voice name is required' });
    }
    const activeProvider = ((req.body?.provider as TTSProvider | undefined) || 'cosyvoice') as TTSProvider;
    if (activeProvider !== 'cosyvoice') {
      return res.status(400).json({ error: 'Voice design currently supports DashScope CosyVoice only.' });
    }

    const cleanName = name.trim();
    if (!cleanName) {
      return res.status(400).json({ error: 'Voice name is required' });
    }
    const voiceModel = getQwenDesignTargetModel();
    const voiceId = await designVoice(prompt.trim(), cleanName, activeProvider);

    const db = readDB();
    const userId = getUserId(req);
    if (!db.voiceProfiles) db.voiceProfiles = {};
    if (!db.voiceProfiles[userId]) db.voiceProfiles[userId] = [];
    db.voiceProfiles[userId].push({
      voiceId,
      name: cleanName,
      provider: activeProvider,
      category: 'cloned',
      model: voiceModel,
      source: 'designed',
      prompt: prompt.trim(),
      createdAt: new Date().toISOString(),
    });
    writeDB(db);

    res.json({ voiceId, name: cleanName, provider: activeProvider, category: 'cloned', model: voiceModel, source: 'designed' });
  } catch (err: any) {
    logger.error('[Voice Design Error]', err);
    res.status(500).json({ error: err.message || 'Voice design service unavailable' });
  }
});

// GET /api/voice/voices — List user's cloned voices + ALL provider premade voices
router.get('/voice/voices', requireAuth, async (req: Request, res: Response) => {
  try {
    const userId = getUserId(req);
    const db = readDB();
    const userVoices = (db.voiceProfiles?.[userId] || []).map((voice: any) => ({
      ...voice,
      category: 'cloned' as const,
    }));

    // Fetch premade voices from ALL available providers, not just the active one
    let premadeVoices: any[] = [];
    const providers: TTSProvider[] = [];

    const knownProviders: TTSProvider[] = ['local-cosyvoice', 'cosyvoice', 'ark', 'gptsovits'];
    providers.push(...knownProviders.filter(isTTSProviderConfigured));
    // If nothing configured, fall back to active provider
    if (providers.length === 0) {
      const active = getActiveProvider();
      if (active) providers.push(active);
    }

    for (const provider of providers) {
      try {
        const voices = await listVoices(provider);
        // Tag each voice with its provider so the frontend can show it
        premadeVoices.push(...voices.map(v => ({ ...v, category: v.category || 'premade', provider })));
      } catch {
        // Provider not available — skip
      }
    }

    res.json({
      cloned: userVoices,
      premade: premadeVoices,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/voice/:voiceId — Delete a cloned voice
router.delete('/voice/:voiceId', requireAuth, async (req: Request, res: Response) => {
  try {
    const userId = getUserId(req);
    const db = readDB();
    const userVoices = db.voiceProfiles?.[userId] || [];
    const voiceIdx = userVoices.findIndex((v: any) => v.voiceId === req.params.voiceId);

    if (voiceIdx === -1) {
      return res.status(404).json({ error: 'Voice not found' });
    }

    const [removed] = userVoices.splice(voiceIdx, 1);
    db.voiceProfiles[userId] = userVoices;
    writeDB(db);

    res.json({ deleted: removed });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/voice/synthesize — Synthesize speech (for TTS without full voice call)
router.post('/voice/synthesize', async (req: Request, res: Response) => {
  try {
    const { text, voiceId, provider, model } = req.body;

    if (!text || typeof text !== 'string') {
      return res.status(400).json({ error: 'Text is required' });
    }

    const activeProvider = provider || getActiveProvider();
    if (!activeProvider) {
      return res.status(400).json({ error: 'No TTS provider configured' });
    }

    const start = Date.now();
    const result = await synthesizeSpeech(text, {
      provider: activeProvider,
      voiceId: voiceId || 'default',
      model,
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

router.get('/voice/active-provider', (_req, res) => {
  try {
    const pref = getVoicePreference();
    res.json({
      pref,
      active: { stt: getActiveSTTProvider(), tts: getActiveTTSProvider?.() || 'cosyvoice' },
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/voice/provider', (req, res) => {
  try {
    const { stt, tts } = req.body;
    const merged = setVoicePreference({ stt: stt || undefined, tts: tts || undefined } as any);
    res.json(merged);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
