import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { makeApp, JWT_SECRET } from './helpers';
import { mountSystemRoutes } from '../server/routes/system_routes';

let url: string;
let cleanup: () => void;

describe('Settings & Keys API', () => {
  beforeAll(async () => {
    const app = await makeApp();
    url = app.url;
    cleanup = app.cleanup;
    mountSystemRoutes(app.apiRouter, JWT_SECRET, { emit: () => {} });
  });

  afterAll(() => cleanup?.());

  it('GET /settings/keys returns masked key status', async () => {
    const res = await fetch(`${url}/api/settings/keys`, {
      signal: AbortSignal.timeout(5000),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(typeof body).toBe('object');
    expect(body).toHaveProperty('DASHSCOPE_API_KEY');
    expect(body).toHaveProperty('DEEPSEEK_API_KEY');
  });

  it('POST /settings/keys saves and reports saved', async () => {
    const res = await fetch(`${url}/api/settings/keys`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ keys: { DEEPSEEK_API_KEY: 'sk-test' } }),
      signal: AbortSignal.timeout(5000),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.saved).toContain('DEEPSEEK_API_KEY');

    // Read back
    const read = await fetch(`${url}/api/settings/keys`, {
      signal: AbortSignal.timeout(5000),
    });
    const readBody = await read.json();
    expect(readBody.DEEPSEEK_API_KEY).toBe(true);
  });

  it('POST /settings/keys rejects empty payload', async () => {
    const res = await fetch(`${url}/api/settings/keys`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
      signal: AbortSignal.timeout(5000),
    });
    expect(res.status).toBe(400);
  });

  it('stores image and video generation roles independently', async () => {
    const update = await fetch(`${url}/api/preferences/generation`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        image: {
          provider: 'qwen',
          model: 'wan-image-direct',
          models: {
            openai: 'gpt-image-custom',
            qwen: 'wan-image-custom',
          },
        },
        video: {
          provider: 'qwen',
          model: 'wan-video-direct',
          models: { qwen: 'wan-video-custom' },
        },
      }),
      signal: AbortSignal.timeout(5000),
    });
    expect(update.status).toBe(200);
    const updateBody = await update.json();
    expect(updateBody.image).toMatchObject({
      provider: 'qwen',
      model: 'wan-image-custom',
      models: {
        openai: 'gpt-image-custom',
        qwen: 'wan-image-custom',
      },
    });
    expect(updateBody.video).toMatchObject({
      provider: 'qwen',
      model: 'wan-video-custom',
      models: { qwen: 'wan-video-custom' },
    });

    const read = await fetch(`${url}/api/preferences/generation`, {
      signal: AbortSignal.timeout(5000),
    });
    expect(read.status).toBe(200);
    const readBody = await read.json();
    expect(readBody.image.model).toBe('wan-image-custom');
    expect(readBody.video.model).toBe('wan-video-custom');
  });

  it('rejects unsupported generation model providers', async () => {
    const res = await fetch(`${url}/api/preferences/generation`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        image: { provider: 'unsupported' },
        video: { provider: 'qwen' },
      }),
      signal: AbortSignal.timeout(5000),
    });
    expect(res.status).toBe(400);
  });

  it('stores an independent World Model and can return to Vision inheritance', async () => {
    const independent = await fetch(`${url}/api/preferences/world`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        provider: 'qwen',
        model: 'qwen-vl-direct',
        models: { qwen: 'qwen-vl-world-custom' },
      }),
      signal: AbortSignal.timeout(5000),
    });
    expect(independent.status).toBe(200);
    const independentBody = await independent.json();
    expect(independentBody).toMatchObject({
      provider: 'qwen',
      model: 'qwen-vl-world-custom',
      resolved: {
        provider: 'qwen',
        model: 'qwen-vl-world-custom',
        inheritedFromVision: false,
      },
    });

    const inherited = await fetch(`${url}/api/preferences/world`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        provider: 'inherit_vision',
        model: '',
        models: independentBody.models,
      }),
      signal: AbortSignal.timeout(5000),
    });
    expect(inherited.status).toBe(200);
    const inheritedBody = await inherited.json();
    expect(inheritedBody.provider).toBe('inherit_vision');
    expect(inheritedBody.resolved.inheritedFromVision).toBe(true);
    expect(typeof inheritedBody.resolved.provider).toBe('string');
    expect(typeof inheritedBody.resolved.model).toBe('string');
  });

  it('rejects unsupported World Model providers', async () => {
    const res = await fetch(`${url}/api/preferences/world`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider: 'unsupported', model: 'anything' }),
      signal: AbortSignal.timeout(5000),
    });
    expect(res.status).toBe(400);
  });
});
