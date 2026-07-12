import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import jwt from 'jsonwebtoken';
import { makeApp, JWT_SECRET, COOKIE_OPTS } from './helpers';
import voiceRoutes from '../routes/voice';
import { mountAuthRoutes } from '../server/routes/auth';

let url: string;
let cleanup: () => void;
let token: string;

describe('Voice API', () => {
  beforeAll(async () => {
    const app = await makeApp();
    url = app.url;
    cleanup = app.cleanup;
    mountAuthRoutes(app.apiRouter, JWT_SECRET, COOKIE_OPTS);
    app.apiRouter.use('/', voiceRoutes);

    await fetch(`${url}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'voice_tester', password: 'pass123', phone: '13800004444' }),
    });
    const login = await fetch(`${url}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'voice_tester', password: 'pass123' }),
    });
    token = (await login.json()).token;
  });

  afterAll(() => cleanup?.());

  function headers() {
    return {
      'Content-Type': 'application/json',
      'Cookie': `token=${token}`,
    };
  }

  function authHeaders() {
    return { 'Cookie': `token=${token}` };
  }

  function silentWavBlob(durationSec = 0.1): Blob {
    const sampleRate = 16000;
    const samples = Math.max(1, Math.floor(sampleRate * durationSec));
    const dataSize = samples * 2;
    const buffer = Buffer.alloc(44 + dataSize);
    buffer.write('RIFF', 0);
    buffer.writeUInt32LE(36 + dataSize, 4);
    buffer.write('WAVE', 8);
    buffer.write('fmt ', 12);
    buffer.writeUInt32LE(16, 16);
    buffer.writeUInt16LE(1, 20);
    buffer.writeUInt16LE(1, 22);
    buffer.writeUInt32LE(sampleRate, 24);
    buffer.writeUInt32LE(sampleRate * 2, 28);
    buffer.writeUInt16LE(2, 32);
    buffer.writeUInt16LE(16, 34);
    buffer.write('data', 36);
    buffer.writeUInt32LE(dataSize, 40);
    return new Blob([buffer], { type: 'audio/wav' });
  }

  it('requires auth for voice list', async () => {
    const res = await fetch(`${url}/api/voice/voices`, {
      signal: AbortSignal.timeout(5000),
    });
    expect(res.status).toBe(401);
  });

  it('returns voice list for authenticated users', async () => {
    const res = await fetch(`${url}/api/voice/voices`, {
      headers: headers(),
      signal: AbortSignal.timeout(5000),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty('cloned');
    expect(body).toHaveProperty('premade');
    expect(Array.isArray(body.cloned)).toBe(true);
    expect(Array.isArray(body.premade)).toBe(true);
  });

  it('uploads common audio file formats for cloning', async () => {
    const form = new FormData();
    form.append('samples', new Blob([Buffer.from('fake-audio')], { type: 'audio/mp4' }), 'sample.m4a');

    const res = await fetch(`${url}/api/voice/samples`, {
      method: 'POST',
      headers: authHeaders(),
      body: form,
      signal: AbortSignal.timeout(5000),
    });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.count).toBe(1);
    expect(body.urls[0]).toContain('/api/voice/samples/');
  });

  it('rejects cloning samples that do not belong to the authenticated user', async () => {
    const res = await fetch(`${url}/api/voice/clone`, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({
        sampleUrls: ['/api/voice/samples/other-user/sample.wav'],
        name: 'Blocked voice',
        provider: 'cosyvoice',
      }),
      signal: AbortSignal.timeout(5000),
    });
    expect(res.status).toBe(403);
  });

  it('fails clearly when explicit URL cloning cannot expose a public sample URL', async () => {
    const previousPublicBase = process.env.LUMI_PUBLIC_BASE_URL;
    const previousPublicBaseAlias = process.env.PUBLIC_BASE_URL;
    const previousCloneMode = process.env.COSYVOICE_CLONE_AUDIO_MODE;
    delete process.env.LUMI_PUBLIC_BASE_URL;
    delete process.env.PUBLIC_BASE_URL;
    process.env.COSYVOICE_CLONE_AUDIO_MODE = 'url';

    try {
      const form = new FormData();
      form.append('samples', silentWavBlob(), 'sample.wav');
      const upload = await fetch(`${url}/api/voice/samples`, {
        method: 'POST',
        headers: authHeaders(),
        body: form,
        signal: AbortSignal.timeout(5000),
      });
      const uploaded = await upload.json();
      expect(upload.status).toBe(200);

      const clone = await fetch(`${url}/api/voice/clone`, {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify({
          sampleUrls: uploaded.urls,
          name: 'Local blocked voice',
          provider: 'cosyvoice',
        }),
        signal: AbortSignal.timeout(5000),
      });
      const body = await clone.json();

      expect(clone.status).toBe(400);
      expect(body.requiresPublicBaseUrl).toBe(true);
    } finally {
      if (previousPublicBase === undefined) delete process.env.LUMI_PUBLIC_BASE_URL;
      else process.env.LUMI_PUBLIC_BASE_URL = previousPublicBase;
      if (previousPublicBaseAlias === undefined) delete process.env.PUBLIC_BASE_URL;
      else process.env.PUBLIC_BASE_URL = previousPublicBaseAlias;
      if (previousCloneMode === undefined) delete process.env.COSYVOICE_CLONE_AUDIO_MODE;
      else process.env.COSYVOICE_CLONE_AUDIO_MODE = previousCloneMode;
    }
  });

  it('uses Qwen data-url cloning by default for local installed users', async () => {
    const previousPublicBase = process.env.LUMI_PUBLIC_BASE_URL;
    const previousPublicBaseAlias = process.env.PUBLIC_BASE_URL;
    const previousCloneMode = process.env.COSYVOICE_CLONE_AUDIO_MODE;
    const previousDashscopeKey = process.env.DASHSCOPE_API_KEY;
    const previousFetch = globalThis.fetch;
    delete process.env.LUMI_PUBLIC_BASE_URL;
    delete process.env.PUBLIC_BASE_URL;
    delete process.env.COSYVOICE_CLONE_AUDIO_MODE;
    process.env.DASHSCOPE_API_KEY = 'test-dashscope-key';
    let dashscopeBody: any = null;

    globalThis.fetch = (async (input: any, init?: any) => {
      const target = typeof input === 'string' ? input : input?.url || String(input);
      if (target.includes('dashscope.aliyuncs.com/api/v1/services/audio/tts/customization')) {
        dashscopeBody = JSON.parse(String(init?.body || '{}'));
        return new Response(JSON.stringify({ output: { voice_id: 'qwen_local_voice_1' } }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return previousFetch(input, init);
    }) as typeof fetch;

    try {
      const form = new FormData();
      form.append('samples', silentWavBlob(), 'sample.wav');
      const upload = await previousFetch(`${url}/api/voice/samples`, {
        method: 'POST',
        headers: authHeaders(),
        body: form,
        signal: AbortSignal.timeout(5000),
      });
      const uploaded = await upload.json();
      expect(upload.status).toBe(200);

      const clone = await previousFetch(`${url}/api/voice/clone`, {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify({
          sampleUrls: uploaded.urls,
          name: 'Installed User Voice',
          provider: 'cosyvoice',
        }),
        signal: AbortSignal.timeout(10000),
      });
      const body = await clone.json();

      expect(clone.status).toBe(200);
      expect(body.voiceId).toBe('qwen_local_voice_1');
      expect(body.model).toBe('qwen3-tts-vc-2026-01-22');
      expect(dashscopeBody.model).toBe('qwen-voice-enrollment');
      expect(dashscopeBody.input.audio.data).toMatch(/^data:audio\/wav;base64,/);
      expect(dashscopeBody.input.target_model).toBe('qwen3-tts-vc-2026-01-22');
    } finally {
      globalThis.fetch = previousFetch;
      if (previousPublicBase === undefined) delete process.env.LUMI_PUBLIC_BASE_URL;
      else process.env.LUMI_PUBLIC_BASE_URL = previousPublicBase;
      if (previousPublicBaseAlias === undefined) delete process.env.PUBLIC_BASE_URL;
      else process.env.PUBLIC_BASE_URL = previousPublicBaseAlias;
      if (previousCloneMode === undefined) delete process.env.COSYVOICE_CLONE_AUDIO_MODE;
      else process.env.COSYVOICE_CLONE_AUDIO_MODE = previousCloneMode;
      if (previousDashscopeKey === undefined) delete process.env.DASHSCOPE_API_KEY;
      else process.env.DASHSCOPE_API_KEY = previousDashscopeKey;
    }
  });

  it('returns active provider info', async () => {
    const res = await fetch(`${url}/api/voice/active-provider`, {
      headers: authHeaders(),
      signal: AbortSignal.timeout(5000),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    // Response is { pref: {...}, active: { stt: string, tts: string } }
    expect(body).toHaveProperty('pref');
    expect(body).toHaveProperty('active');
    expect(body.active).toHaveProperty('stt');
    expect(body.active).toHaveProperty('tts');
  });

  it('accepts local CosyVoice TTS preference without pretending it is active before configuration', async () => {
    const previousEnabled = process.env.LOCAL_COSYVOICE_ENABLED;
    const previousUrl = process.env.LOCAL_COSYVOICE_API_URL;
    const previousAliasUrl = process.env.COSYVOICE_LOCAL_API_URL;
    delete process.env.LOCAL_COSYVOICE_ENABLED;
    delete process.env.LOCAL_COSYVOICE_API_URL;
    delete process.env.COSYVOICE_LOCAL_API_URL;

    try {
      const save = await fetch(`${url}/api/voice/provider`, {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify({ tts: 'local-cosyvoice' }),
        signal: AbortSignal.timeout(5000),
      });
      expect(save.status).toBe(200);
      const saved = await save.json();
      expect(saved.tts).toBe('local-cosyvoice');

      const status = await fetch(`${url}/api/voice/active-provider`, {
        headers: authHeaders(),
        signal: AbortSignal.timeout(5000),
      });
      const body = await status.json();
      expect(body.pref.tts).toBe('local-cosyvoice');
      expect(body.active.tts).not.toBe('local-cosyvoice');
    } finally {
      await fetch(`${url}/api/voice/provider`, {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify({ tts: 'auto' }),
      });
      if (previousEnabled === undefined) delete process.env.LOCAL_COSYVOICE_ENABLED;
      else process.env.LOCAL_COSYVOICE_ENABLED = previousEnabled;
      if (previousUrl === undefined) delete process.env.LOCAL_COSYVOICE_API_URL;
      else process.env.LOCAL_COSYVOICE_API_URL = previousUrl;
      if (previousAliasUrl === undefined) delete process.env.COSYVOICE_LOCAL_API_URL;
      else process.env.COSYVOICE_LOCAL_API_URL = previousAliasUrl;
    }
  });

  it('rejects synthesize without body', async () => {
    const res = await fetch(`${url}/api/voice/synthesize`, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({}),
      signal: AbortSignal.timeout(5000),
    });
    expect(res.status).toBe(400);
  });

  it('requires authentication for direct speech synthesis and provider status', async () => {
    const synth = await fetch(`${url}/api/voice/synthesize`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'hello' }),
    });
    const provider = await fetch(`${url}/api/voice/active-provider`);
    expect(synth.status).toBe(401);
    expect(provider.status).toBe(401);
  });

  it('verifies enrolled voiceprints on the server', async () => {
    const makeFrames = (invert = false) => Array.from({ length: 24 }, (_, frameIndex) => {
      const sign = invert ? -1 : 1;
      return Array.from({ length: 13 }, (_, coeffIndex) => {
        if (coeffIndex === 0) return 0.2 + frameIndex * 0.001;
        return sign * (Math.sin(coeffIndex * 0.7) + Math.cos(coeffIndex * 0.31)) + frameIndex * 0.002;
      });
    });

    const enrolledFrames = makeFrames(false);
    const enroll = await fetch(`${url}/api/auth/biometric/voiceprint/enroll`, {
      method: 'PUT',
      headers: headers(),
      body: JSON.stringify({ label: 'Owner voice', mfccFeatures: enrolledFrames, sampleCount: enrolledFrames.length }),
      signal: AbortSignal.timeout(5000),
    });
    expect(enroll.status).toBe(200);

    const pass = await fetch(`${url}/api/auth/biometric/voiceprint/verify`, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({ mfccFeatures: makeFrames(false) }),
      signal: AbortSignal.timeout(5000),
    });
    const passBody = await pass.json();
    expect(pass.status).toBe(200);
    expect(passBody.isOwnerSpeaking).toBe(true);
    expect(passBody.confidence).toBeGreaterThanOrEqual(0.68);

    const reject = await fetch(`${url}/api/auth/biometric/voiceprint/verify`, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({ mfccFeatures: makeFrames(true) }),
      signal: AbortSignal.timeout(5000),
    });
    const rejectBody = await reject.json();
    expect(reject.status).toBe(200);
    expect(rejectBody.isOwnerSpeaking).toBe(false);
  });

  it('accepts PCM voiceprint payloads with MFCC fallback when mature provider is disabled', async () => {
    const previousProvider = process.env.LUMI_VOICEPRINT_PROVIDER;
    process.env.LUMI_VOICEPRINT_PROVIDER = 'mfcc';
    try {
      const makeFrames = () => Array.from({ length: 24 }, (_, frameIndex) => {
        return Array.from({ length: 13 }, (_, coeffIndex) => {
          if (coeffIndex === 0) return 0.15 + frameIndex * 0.001;
          return Math.sin(coeffIndex * 0.37) + Math.cos(coeffIndex * 0.19) + frameIndex * 0.0015;
        });
      });
      const pcm16Base64 = Buffer.alloc(16000 * 2).toString('base64');
      const frames = makeFrames();

      const enroll = await fetch(`${url}/api/auth/biometric/voiceprint/enroll`, {
        method: 'PUT',
        headers: headers(),
        body: JSON.stringify({
          label: 'Fallback voice',
          mfccFeatures: frames,
          audioPcm16Base64: pcm16Base64,
          sampleRate: 16000,
          sampleCount: frames.length,
        }),
        signal: AbortSignal.timeout(5000),
      });
      const enrollBody = await enroll.json();
      expect(enroll.status).toBe(200);
      expect(enrollBody.voiceprint.embeddingReady).toBe(false);
      expect(enrollBody.voiceprintProvider.source).toBe('local');

      const verify = await fetch(`${url}/api/auth/biometric/voiceprint/verify`, {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify({
          mfccFeatures: frames,
          audioPcm16Base64: pcm16Base64,
          sampleRate: 16000,
        }),
        signal: AbortSignal.timeout(5000),
      });
      const verifyBody = await verify.json();
      expect(verify.status).toBe(200);
      expect(verifyBody.isOwnerSpeaking).toBe(true);
      expect(verifyBody.source).toBe('local');
      expect(verifyBody.fallbackReason).toBe('provider_disabled');
    } finally {
      if (previousProvider === undefined) delete process.env.LUMI_VOICEPRINT_PROVIDER;
      else process.env.LUMI_VOICEPRINT_PROVIDER = previousProvider;
    }
  });

  it('reloads face embeddings in personal Lumi and hides biometrics in organization Lumi', async () => {
    const embedding = Array.from({ length: 32 }, (_, index) => index / 100);
    const enrolled = await fetch(`${url}/api/auth/biometric/face/enroll`, {
      method: 'PUT',
      headers: headers(),
      body: JSON.stringify({ label: 'Owner face', embedding }),
    });
    expect(enrolled.ok).toBe(true);

    const personalList = await fetch(`${url}/api/auth/biometric/list`, { headers: authHeaders() });
    const personal = await personalList.json();
    expect(personal.faces.some((face: any) => (
      face.label === 'Owner face' && Array.isArray(face.embedding) && face.embedding.length === embedding.length
    ))).toBe(true);

    const identity = jwt.verify(token, JWT_SECRET) as any;
    const workToken = jwt.sign({ ...identity, orgId: 'biometric-work-scope' }, JWT_SECRET);
    const workList = await fetch(`${url}/api/auth/biometric/list`, {
      headers: { Cookie: `token=${workToken}` },
    });
    const work = await workList.json();
    expect(work).toMatchObject({ voiceprints: [], faces: [], personalContextRequired: true });
  });

  it('rejects unusable voiceprint enrollment when no embedding or MFCC frames are available', async () => {
    const previousProvider = process.env.LUMI_VOICEPRINT_PROVIDER;
    process.env.LUMI_VOICEPRINT_PROVIDER = 'mfcc';
    try {
      const pcm16Base64 = Buffer.alloc(16000 * 2).toString('base64');
      const enroll = await fetch(`${url}/api/auth/biometric/voiceprint/enroll`, {
        method: 'PUT',
        headers: headers(),
        body: JSON.stringify({
          label: 'Empty voice',
          mfccFeatures: [],
          audioPcm16Base64: pcm16Base64,
          sampleRate: 16000,
        }),
        signal: AbortSignal.timeout(5000),
      });
      const body = await enroll.json();
      expect(enroll.status).toBe(400);
      expect(body.reason).toBe('not_enough_voiceprint_frames');
    } finally {
      if (previousProvider === undefined) delete process.env.LUMI_VOICEPRINT_PROVIDER;
      else process.env.LUMI_VOICEPRINT_PROVIDER = previousProvider;
    }
  });
});
