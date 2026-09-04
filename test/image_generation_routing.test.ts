import './helpers';
import dns from 'node:dns/promises';
import fs from 'node:fs';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { initDatabase } from '../db_layer';
import { saveKeys } from '../server/config/keys';
import { upsertUserPreferredGenerationModels } from '../server/llm/generation_preferences';
import { registerImageTools } from '../server/tools/definitions/image_tools';
import { ToolRegistry } from '../server/tools/registry';

const VALID_PNG_BYTES = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
);

function allowPublicTestDns(): void {
  vi.spyOn(dns, 'lookup').mockImplementation(async () => ([{ address: '8.8.8.8', family: 4 }] as any));
}

describe('image generation model routing', () => {
  beforeAll(async () => {
    await initDatabase();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    saveKeys({
      SILICONFLOW_API_KEY: '',
      DASHSCOPE_API_KEY: '',
      QWEN_API_KEY: '',
      OPENAI_API_KEY: '',
      RELAY_API_KEY: '',
      RELAY_BASE_URL: '',
    });
  });

  it('uses the explicitly selected SiliconFlow model without provider fallback', async () => {
    saveKeys({ SILICONFLOW_API_KEY: 'siliconflow-test-key' });
    allowPublicTestDns();
    upsertUserPreferredGenerationModels('image-routing-user', {
      image: {
        provider: 'siliconflow',
        models: { siliconflow: 'stabilityai/stable-diffusion-3-5-large' },
      },
      video: { provider: 'qwen' },
    });

    const fetchMock = vi.fn(async (input: string | URL | Request, _init?: RequestInit) => {
      const url = String(input);
      if (url === 'https://api.siliconflow.cn/v1/images/generations') {
        return new Response(JSON.stringify({ data: [{ url: 'https://images.example.test/generated.png' }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (url === 'https://images.example.test/generated.png') {
        return new Response(VALID_PNG_BYTES, {
          status: 200,
          headers: { 'content-type': 'image/png' },
        });
      }
      throw new Error(`Unexpected image request: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const registry = new ToolRegistry();
    registerImageTools(registry);
    const progress: string[] = [];
    let outputPath = '';
    try {
      const raw = await registry.execute(
        'generate_image',
        { prompt: 'A precise architectural massing study', size: '1024x1024' },
        { userId: 'image-routing-user', onProgress: step => progress.push(step) },
      );
      const result = JSON.parse(raw);
      outputPath = result.images[0];

      expect(result).toMatchObject({
        success: true,
        verified: true,
        verificationStatus: 'verified',
        provider: 'siliconflow',
        model: 'stabilityai/stable-diffusion-3-5-large',
        images: [outputPath],
        artifacts: [{ type: 'image', path: outputPath }],
      });
      expect(fs.readFileSync(outputPath)).toEqual(VALID_PNG_BYTES);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(fetchMock.mock.calls[0][0]).toBe('https://api.siliconflow.cn/v1/images/generations');
      expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toMatchObject({
        model: 'stabilityai/stable-diffusion-3-5-large',
        prompt: 'A precise architectural massing study',
        size: '1024x1024',
      });
      expect(progress).toEqual([
        '图片生成请求已提交。',
        '图片正在生成中。',
        '图片已生成，正在保存结果。',
        '图片生成完成。',
      ]);
    } finally {
      if (outputPath) fs.rmSync(outputPath, { force: true });
    }
  });

  it('downloads and verifies a remote Lumi Official image before returning success', async () => {
    const userId = 'image-routing-official-remote-user';
    const model = 'huawei_maas/qwen-image';
    const officialBaseUrl = 'https://official-image-generation.test/v1';
    const remoteImageUrl = 'https://images.example.test/official-output.png?signature=private';
    saveKeys({
      RELAY_API_KEY: 'official-image-test-key',
      RELAY_BASE_URL: officialBaseUrl,
    });
    upsertUserPreferredGenerationModels(userId, {
      image: { provider: 'relay', model, models: { relay: model } },
      video: { provider: 'qwen' },
    });
    allowPublicTestDns();

    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url === `${officialBaseUrl}/images/generations`) {
        return new Response(JSON.stringify({
          model,
          data: [{ url: remoteImageUrl }],
        }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (url === remoteImageUrl) {
        return new Response(VALID_PNG_BYTES, {
          status: 200,
          headers: { 'content-type': 'application/octet-stream' },
        });
      }
      throw new Error(`Unexpected image request: ${url} ${init?.method || 'GET'}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const registry = new ToolRegistry();
    registerImageTools(registry);
    let outputPath = '';
    try {
      const result = JSON.parse(await registry.execute(
        'generate_image',
        { prompt: 'A calm blue studio' },
        { userId },
      ));
      outputPath = result.images[0];

      expect(result).toMatchObject({
        status: 'generated',
        provider: 'relay',
        model,
        verified: true,
        verificationStatus: 'verified',
        artifacts: [{ type: 'image', path: outputPath }],
      });
      expect(outputPath).not.toContain('signature=private');
      expect(fs.readFileSync(outputPath)).toEqual(VALID_PNG_BYTES);
      const remoteCall = fetchMock.mock.calls.find(call => String(call[0]) === remoteImageUrl);
      expect((remoteCall?.[1]?.headers as Record<string, string> | undefined)?.Authorization).toBeUndefined();
    } finally {
      if (outputPath) fs.rmSync(outputPath, { force: true });
    }
  });

  it('downloads a completed DashScope image task into a verified local artifact', async () => {
    const userId = 'image-routing-qwen-remote-user';
    const remoteImageUrl = 'https://images.example.test/qwen-output.png';
    saveKeys({ DASHSCOPE_API_KEY: 'qwen-test-key' });
    upsertUserPreferredGenerationModels(userId, {
      image: { provider: 'qwen', models: { qwen: 'wan2.2-t2i-plus' } },
      video: { provider: 'qwen' },
    });
    allowPublicTestDns();

    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url.includes('/services/aigc/text2image/image-synthesis')) {
        return new Response(JSON.stringify({ output: { task_id: 'qwen-image-task' } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (url.endsWith('/api/v1/tasks/qwen-image-task')) {
        return new Response(JSON.stringify({
          output: { task_status: 'SUCCEEDED', results: [{ url: remoteImageUrl }] },
        }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (url === remoteImageUrl) {
        return new Response(VALID_PNG_BYTES, {
          status: 200,
          headers: { 'content-type': 'image/png' },
        });
      }
      throw new Error(`Unexpected image request: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const registry = new ToolRegistry();
    registerImageTools(registry);
    let outputPath = '';
    try {
      const result = JSON.parse(await registry.execute(
        'generate_image',
        { prompt: 'A quiet mountain lake' },
        { userId },
      ));
      outputPath = result.images[0];

      expect(result).toMatchObject({
        status: 'generated',
        provider: 'qwen',
        verified: true,
        verificationStatus: 'verified',
        taskId: 'qwen-image-task',
        artifacts: [{ type: 'image', path: outputPath }],
      });
      expect(fs.readFileSync(outputPath)).toEqual(VALID_PNG_BYTES);
      expect(fetchMock).toHaveBeenCalledTimes(3);
    } finally {
      if (outputPath) fs.rmSync(outputPath, { force: true });
    }
  });

  it('uses the shared DashScope cancel endpoint after an accepted image task is locally cancelled', async () => {
    const userId = 'image-routing-qwen-remote-cancel-user';
    saveKeys({ DASHSCOPE_API_KEY: 'qwen-test-key' });
    upsertUserPreferredGenerationModels(userId, {
      image: { provider: 'qwen', models: { qwen: 'wan2.2-t2i-plus' } },
      video: { provider: 'qwen' },
    });
    const caller = new AbortController();
    const progress: string[] = [];
    const fetchMock = vi.fn(async (...request: Parameters<typeof fetch>): Promise<Response> => {
      const url = String(request[0]);
      if (url.includes('/services/aigc/text2image/image-synthesis')) {
        caller.abort(new DOMException('cancel accepted image task', 'AbortError'));
        return new Response(JSON.stringify({ output: { task_id: 'qwen-image-cancel-task' } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (url.endsWith('/api/v1/tasks/qwen-image-cancel-task/cancel')) {
        return new Response(JSON.stringify('cancel-request-id'), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      throw new Error(`Unexpected URL: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const registry = new ToolRegistry();
    registerImageTools(registry);
    await expect(registry.execute(
      'generate_image',
      { prompt: 'Cancel this accepted image task' },
      { userId, executionSignal: caller.signal, onProgress: message => progress.push(message) },
    )).rejects.toThrow(/cancel accepted image task/i);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1][0]).toBe(
      'https://dashscope.aliyuncs.com/api/v1/tasks/qwen-image-cancel-task/cancel',
    );
    const cancelInit = fetchMock.mock.calls[1][1] as RequestInit;
    expect(cancelInit).toMatchObject({
      method: 'POST',
      headers: { Authorization: 'Bearer qwen-test-key' },
    });
    expect(cancelInit.signal).not.toBe(caller.signal);
    expect(cancelInit.signal?.aborted).toBe(false);
    expect(progress).toEqual([
      '图片生成任务已提交。',
      '图片正在生成中。',
      'DashScope 已确认取消远端排队任务。',
    ]);
  });

  it('downloads an OpenAI image URL into a verified local artifact', async () => {
    const userId = 'image-routing-openai-remote-user';
    const remoteImageUrl = 'https://images.example.test/openai-output.png';
    saveKeys({ OPENAI_API_KEY: 'openai-test-key' });
    upsertUserPreferredGenerationModels(userId, {
      image: { provider: 'openai', models: { openai: 'gpt-image-1' } },
      video: { provider: 'qwen' },
    });
    allowPublicTestDns();

    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url === 'https://api.openai.com/v1/images/generations') {
        return new Response(JSON.stringify({
          created: 1,
          data: [{ url: remoteImageUrl }],
        }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (url === remoteImageUrl) {
        return new Response(VALID_PNG_BYTES, {
          status: 200,
          headers: { 'content-type': 'image/png' },
        });
      }
      throw new Error(`Unexpected image request: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const registry = new ToolRegistry();
    registerImageTools(registry);
    let outputPath = '';
    try {
      const result = JSON.parse(await registry.execute(
        'generate_image',
        { prompt: 'A quiet studio portrait' },
        { userId },
      ));
      outputPath = result.images[0];

      expect(result).toMatchObject({
        status: 'generated',
        provider: 'openai',
        model: 'gpt-image-1',
        verified: true,
        verificationStatus: 'verified',
        artifacts: [{ type: 'image', path: outputPath }],
      });
      expect(fs.readFileSync(outputPath)).toEqual(VALID_PNG_BYTES);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    } finally {
      if (outputPath) fs.rmSync(outputPath, { force: true });
    }
  });

  it('rejects a remote text body after provider completion without charging a fallback provider', async () => {
    const userId = 'image-routing-invalid-remote-user';
    saveKeys({
      SILICONFLOW_API_KEY: 'siliconflow-test-key',
      RELAY_API_KEY: 'fallback-must-not-run',
      RELAY_BASE_URL: 'https://fallback-official.test/v1',
    });
    upsertUserPreferredGenerationModels(userId, {
      image: {
        provider: 'auto',
        models: {
          siliconflow: 'stabilityai/stable-diffusion-3-5-large',
          relay: 'huawei_maas/qwen-image',
        },
      },
      video: { provider: 'qwen' },
    });
    allowPublicTestDns();

    const remoteImageUrl = 'https://images.example.test/not-really-an-image.png';
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url === 'https://api.siliconflow.cn/v1/images/generations') {
        return new Response(JSON.stringify({ data: [{ url: remoteImageUrl }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (url === remoteImageUrl) {
        return new Response('plain text masquerading as PNG', {
          status: 200,
          headers: { 'content-type': 'image/png' },
        });
      }
      throw new Error(`Unexpected image request: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const registry = new ToolRegistry();
    registerImageTools(registry);
    await expect(registry.execute(
      'generate_image',
      { prompt: 'This result must be decoded before success' },
      { userId },
    )).rejects.toThrow(/not a decodable .* image/i);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('propagates cancellation to an active image generation request', async () => {
    const userId = 'image-routing-cancel-user';
    saveKeys({ SILICONFLOW_API_KEY: 'siliconflow-test-key' });
    upsertUserPreferredGenerationModels(userId, {
      image: {
        provider: 'siliconflow',
        models: { siliconflow: 'stabilityai/stable-diffusion-3-5-large' },
      },
      video: { provider: 'qwen' },
    });

    const caller = new AbortController();
    let requestSignal: AbortSignal | undefined;
    const fetchMock = vi.fn(async (...request: Parameters<typeof fetch>): Promise<Response> => {
      requestSignal = request[1]?.signal || undefined;
      return new Promise<Response>((_resolve, reject) => {
        const rejectOnAbort = () => reject(requestSignal?.reason || new DOMException('cancelled', 'AbortError'));
        if (requestSignal?.aborted) rejectOnAbort();
        else requestSignal?.addEventListener('abort', rejectOnAbort, { once: true });
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    const registry = new ToolRegistry();
    registerImageTools(registry);
    const pending = registry.execute(
      'generate_image',
      { prompt: 'A request that should be cancelled' },
      { userId, executionSignal: caller.signal },
    );
    const outcome = pending.then(
      () => null,
      error => error as Error,
    );
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    caller.abort(new DOMException('test image generation cancellation', 'AbortError'));

    const error = await outcome;
    expect(error).toBeInstanceOf(Error);
    expect(error?.message).toMatch(/test image generation cancellation/i);
    expect(requestSignal?.aborted).toBe(true);
  });

  it('does not try another provider after an auto-routed request is cancelled', async () => {
    const userId = 'image-routing-auto-cancel-user';
    saveKeys({
      OPENAI_API_KEY: '',
      DASHSCOPE_API_KEY: 'qwen-test-key',
      SILICONFLOW_API_KEY: 'siliconflow-test-key',
    });
    upsertUserPreferredGenerationModels(userId, {
      image: {
        provider: 'auto',
        models: {
          qwen: 'wan2.2-t2i-plus',
          siliconflow: 'stabilityai/stable-diffusion-3-5-large',
        },
      },
      video: { provider: 'qwen' },
    });

    const caller = new AbortController();
    let requestSignal: AbortSignal | undefined;
    const fetchMock = vi.fn(async (...request: Parameters<typeof fetch>): Promise<Response> => {
      requestSignal = request[1]?.signal || undefined;
      return new Promise<Response>((_resolve, reject) => {
        const rejectOnAbort = () => reject(requestSignal?.reason || new DOMException('cancelled', 'AbortError'));
        if (requestSignal?.aborted) rejectOnAbort();
        else requestSignal?.addEventListener('abort', rejectOnAbort, { once: true });
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    const registry = new ToolRegistry();
    registerImageTools(registry);
    const pending = registry.execute(
      'generate_image',
      { prompt: 'Cancel before fallback' },
      { userId, executionSignal: caller.signal },
    );
    const outcome = pending.then(
      () => null,
      error => error as Error,
    );
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    caller.abort(new DOMException('cancel auto image generation', 'AbortError'));

    const error = await outcome;
    expect(error).toBeInstanceOf(Error);
    expect(error?.message).toMatch(/cancel auto image generation/i);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toContain('dashscope.aliyuncs.com');
    expect(requestSignal?.aborted).toBe(true);
  });
});
