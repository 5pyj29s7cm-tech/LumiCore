import './helpers';
import fs from 'fs';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { initDatabase } from '../db_layer';
import { saveKeys } from '../server/config/keys';
import { upsertUserPreferredGenerationModels } from '../server/llm/generation_preferences';
import { registerVideoTools } from '../server/tools/definitions/video_tools';
import { ToolRegistry } from '../server/tools/registry';

function response(body: any, ok = true, status = 200): any {
  return { ok, status, json: async () => body };
}

async function runVideo(userId: string, args: Record<string, any> = {}): Promise<any> {
  const registry = new ToolRegistry();
  registerVideoTools(registry);
  return JSON.parse(await registry.execute('generate_video', { prompt: 'A camera moves through a quiet studio', ...args }, { userId }));
}

describe('video generation model routing', () => {
  beforeAll(async () => {
    await initDatabase();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    saveKeys({
      DASHSCOPE_API_KEY: '',
      MINIMAX_API_KEY: '',
      SILICONFLOW_API_KEY: '',
      OPENAI_API_KEY: '',
    });
  });

  it('routes Qwen through the DashScope async video API', async () => {
    saveKeys({ DASHSCOPE_API_KEY: 'qwen-test-key' });
    upsertUserPreferredGenerationModels('video-qwen-user', {
      image: { provider: 'auto' },
      video: { provider: 'qwen', models: { qwen: 'wanx2.1-t2v-plus' } },
    });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response({ output: { task_id: 'qwen-task' } }))
      .mockResolvedValueOnce(response({ output: { task_status: 'SUCCEEDED', video_url: 'https://example.test/qwen.mp4' } }))
      .mockResolvedValueOnce(response({}, false, 503));
    vi.stubGlobal('fetch', fetchMock);

    const result = await runVideo('video-qwen-user', { size: '720x1280' });

    expect(result).toMatchObject({ success: true, provider: 'qwen', model: 'wanx2.1-t2v-plus', taskId: 'qwen-task' });
    expect(fetchMock.mock.calls[0][0]).toContain('dashscope.aliyuncs.com/api/v1/services/aigc/video-generation');
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).parameters.size).toBe('720*1280');
  });

  it('routes MiniMax through task polling and file retrieval', async () => {
    saveKeys({ MINIMAX_API_KEY: 'minimax-test-key' });
    upsertUserPreferredGenerationModels('video-minimax-user', {
      image: { provider: 'auto' },
      video: { provider: 'minimax', models: { minimax: 'MiniMax-Hailuo-02' } },
    });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response({ task_id: 'minimax-task' }))
      .mockResolvedValueOnce(response({ status: 'Success', file_id: 'minimax-file' }))
      .mockResolvedValueOnce(response({ file: { download_url: 'https://example.test/minimax.mp4' } }))
      .mockResolvedValueOnce(response({}, false, 503));
    vi.stubGlobal('fetch', fetchMock);

    const result = await runVideo('video-minimax-user', { duration: 6, resolution: '1080P' });

    expect(result).toMatchObject({ success: true, provider: 'minimax', model: 'MiniMax-Hailuo-02', taskId: 'minimax-task' });
    expect(fetchMock.mock.calls.map(call => String(call[0]))).toEqual(expect.arrayContaining([
      'https://api.minimaxi.com/v1/video_generation',
      expect.stringContaining('/v1/query/video_generation'),
      expect.stringContaining('/v1/files/retrieve'),
    ]));
  });

  it('routes SiliconFlow through submit and status endpoints', async () => {
    saveKeys({ SILICONFLOW_API_KEY: 'siliconflow-test-key' });
    upsertUserPreferredGenerationModels('video-siliconflow-user', {
      image: { provider: 'auto' },
      video: { provider: 'siliconflow', models: { siliconflow: 'Wan-AI/Wan2.2-T2V-A14B' } },
    });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response({ requestId: 'siliconflow-task' }))
      .mockResolvedValueOnce(response({ status: 'Succeed', results: { videos: [{ url: 'https://example.test/siliconflow.mp4' }] } }))
      .mockResolvedValueOnce(response({}, false, 503));
    vi.stubGlobal('fetch', fetchMock);

    const result = await runVideo('video-siliconflow-user', { size: '960*960' });

    expect(result).toMatchObject({ success: true, provider: 'siliconflow', model: 'Wan-AI/Wan2.2-T2V-A14B', taskId: 'siliconflow-task' });
    expect(fetchMock.mock.calls[0][0]).toBe('https://api.siliconflow.cn/v1/video/submit');
    expect(fetchMock.mock.calls[1][0]).toBe('https://api.siliconflow.cn/v1/video/status');
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).image_size).toBe('960x960');
  });

  it('routes OpenAI through the Videos API and saves returned content', async () => {
    saveKeys({ OPENAI_API_KEY: 'openai-test-key' });
    upsertUserPreferredGenerationModels('video-openai-user', {
      image: { provider: 'auto' },
      video: { provider: 'openai', models: { openai: 'sora-2-pro' } },
    });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response({ id: 'openai-video', status: 'queued' }))
      .mockResolvedValueOnce(response({ id: 'openai-video', status: 'completed' }))
      .mockResolvedValueOnce({ ok: true, status: 200, arrayBuffer: async () => new Uint8Array([0, 1, 2, 3]).buffer });
    vi.stubGlobal('fetch', fetchMock);

    const result = await runVideo('video-openai-user', { duration: 8, size: '1280*720' });

    expect(result).toMatchObject({ success: true, provider: 'openai', model: 'sora-2-pro', taskId: 'openai-video' });
    expect(result.outputPath).toMatch(/openai_video_\d+\.mp4$/);
    expect(fs.existsSync(result.outputPath)).toBe(true);
    const form = fetchMock.mock.calls[0][1].body as FormData;
    expect(form.get('model')).toBe('sora-2-pro');
    expect(form.get('seconds')).toBe('8');
    expect(form.get('size')).toBe('1280x720');
    fs.rmSync(result.outputPath, { force: true });
  });
});
