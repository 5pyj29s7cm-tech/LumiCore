import './helpers';
import fs from 'fs';
import path from 'path';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { initDatabase } from '../db_layer';
import { saveKeys } from '../server/config/keys';
import { getGeneratedOutputDir } from '../server/config/data_path';
import { upsertUserPreferredGenerationModels } from '../server/llm/generation_preferences';
import { registerVideoTools } from '../server/tools/definitions/video_tools';
import { ToolRegistry } from '../server/tools/registry';
import type { ToolContext } from '../server/tools/types';

function response(body: any, ok = true, status = 200): any {
  return { ok, status, json: async () => body };
}

function jsonResponse(body: any, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const OFFICIAL_T2V_MODEL = 'huawei_maas/Wan2.2-T2V-A14B';
const OFFICIAL_I2V_MODEL = 'huawei_maas/Wan2.2-I2V-A14B';
const ORIGINAL_RELAY_VIDEO_MODEL = process.env.RELAY_VIDEO_MODEL;
const ORIGINAL_RELAY_IMAGE_TO_VIDEO_MODEL = process.env.RELAY_IMAGE_TO_VIDEO_MODEL;
const ORIGINAL_RELAY_VIDEO_REQUEST_FORMAT = process.env.RELAY_VIDEO_REQUEST_FORMAT;
const MINIMAL_MP4 = Buffer.from([
  0x00, 0x00, 0x00, 0x10,
  0x66, 0x74, 0x79, 0x70,
  0x69, 0x73, 0x6f, 0x6d,
  0x00, 0x00, 0x00, 0x00,
]);
const MINIMAL_WEBM = Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x42, 0x86, 0x81, 0x01]);
const VALID_PNG_BYTES = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
);

function mediaResponse(bytes: Buffer, contentType: string): Response {
  return new Response(Uint8Array.from(bytes), {
    status: 200,
    headers: { 'content-type': contentType },
  });
}

function generatedFiles(): string[] {
  const directory = getGeneratedOutputDir();
  return fs.existsSync(directory) ? fs.readdirSync(directory).sort() : [];
}

function restoreEnvironment(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

function configureOfficialVideoModels(userId: string): void {
  process.env.RELAY_VIDEO_MODEL = OFFICIAL_T2V_MODEL;
  process.env.RELAY_IMAGE_TO_VIDEO_MODEL = OFFICIAL_I2V_MODEL;
  process.env.RELAY_VIDEO_REQUEST_FORMAT = 'json';
  saveKeys({
    RELAY_API_KEY: 'official-video-test-key',
    RELAY_BASE_URL: 'https://official.example.test/v1',
  });
  upsertUserPreferredGenerationModels(userId, {
    image: { provider: 'auto' },
    video: { provider: 'relay', model: OFFICIAL_T2V_MODEL, models: { relay: OFFICIAL_T2V_MODEL } },
    imageToVideo: { provider: 'relay', model: OFFICIAL_I2V_MODEL, models: { relay: OFFICIAL_I2V_MODEL } },
  });
}

function removeGeneratedVideo(result: any): void {
  if (typeof result?.outputPath === 'string' && result.outputPath) {
    fs.rmSync(result.outputPath, { force: true });
  }
}

async function runVideo(
  userId: string,
  args: Record<string, any> = {},
  context: ToolContext = {},
): Promise<any> {
  const registry = new ToolRegistry();
  registerVideoTools(registry);
  return JSON.parse(await registry.execute(
    'generate_video',
    { prompt: 'A camera moves through a quiet studio', ...args },
    { ...context, userId },
  ));
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
      RELAY_API_KEY: '',
      RELAY_BASE_URL: '',
    });
    restoreEnvironment('RELAY_VIDEO_MODEL', ORIGINAL_RELAY_VIDEO_MODEL);
    restoreEnvironment('RELAY_IMAGE_TO_VIDEO_MODEL', ORIGINAL_RELAY_IMAGE_TO_VIDEO_MODEL);
    restoreEnvironment('RELAY_VIDEO_REQUEST_FORMAT', ORIGINAL_RELAY_VIDEO_REQUEST_FORMAT);
  });

  it('routes Qwen through the DashScope async video API', async () => {
    saveKeys({ DASHSCOPE_API_KEY: 'qwen-test-key' });
    upsertUserPreferredGenerationModels('video-qwen-user', {
      image: { provider: 'auto' },
      video: { provider: 'qwen', models: { qwen: 'wanx2.1-t2v-plus' } },
    });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response({ output: { task_id: 'qwen-task' } }))
      .mockResolvedValueOnce(response({ output: { task_status: 'SUCCEEDED', video_url: 'https://8.8.8.8/qwen.mp4' } }))
      .mockResolvedValueOnce(mediaResponse(MINIMAL_MP4, 'video/mp4'));
    vi.stubGlobal('fetch', fetchMock);
    const progress: string[] = [];

    let result: any;
    try {
      result = await runVideo(
        'video-qwen-user',
        { size: '720x1280' },
        { onProgress: message => progress.push(message) },
      );

      expect(result).toMatchObject({
        success: true,
        verified: true,
        verificationStatus: 'verified',
        provider: 'qwen',
        model: 'wanx2.1-t2v-plus',
        taskId: 'qwen-task',
        artifactDurability: 'local_file',
      });
      expect(result.outputPath).toMatch(/qwen_video_\d+_[0-9a-f-]{36}\.mp4$/);
      expect(fs.readFileSync(result.outputPath)).toEqual(MINIMAL_MP4);
      expect(fetchMock.mock.calls[0][0]).toContain('dashscope.aliyuncs.com/api/v1/services/aigc/video-generation');
      expect(JSON.parse(fetchMock.mock.calls[0][1].body).parameters.size).toBe('720*1280');
      expect(progress).toEqual([
        'DashScope 视频生成任务已提交。',
        'DashScope 视频任务正在排队或生成中。',
        '视频已生成，正在下载结果。',
        '视频生成完成，结果已保存。',
      ]);
    } finally {
      removeGeneratedVideo(result);
    }
  });

  it('rejects invalid remote video bytes without publishing a file or verified receipt', async () => {
    const userId = 'video-qwen-invalid-container-user';
    saveKeys({ DASHSCOPE_API_KEY: 'qwen-test-key' });
    upsertUserPreferredGenerationModels(userId, {
      image: { provider: 'auto' },
      video: { provider: 'qwen', models: { qwen: 'wanx2.1-t2v-plus' } },
    });
    const before = generatedFiles();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response({ output: { task_id: 'qwen-invalid-task' } }))
      .mockResolvedValueOnce(response({ output: { task_status: 'SUCCEEDED', video_url: 'https://8.8.8.8/not-video.mp4' } }))
      .mockResolvedValueOnce(mediaResponse(Buffer.from('<html>not a video</html>'), 'text/html'));
    vi.stubGlobal('fetch', fetchMock);

    await expect(runVideo(userId)).rejects.toThrow('not a valid MP4 or WebM container');
    expect(generatedFiles()).toEqual(before);
  });

  it('propagates cancellation after submission and stops before the first status poll', async () => {
    const userId = 'video-qwen-cancel-user';
    saveKeys({ DASHSCOPE_API_KEY: 'qwen-test-key' });
    upsertUserPreferredGenerationModels(userId, {
      image: { provider: 'auto' },
      video: { provider: 'qwen', models: { qwen: 'wanx2.1-t2v-plus' } },
    });
    const controller = new AbortController();
    const progress: string[] = [];
    const fetchMock = vi.fn(async (..._request: Parameters<typeof fetch>) => {
      controller.abort(new DOMException('cancelled by test', 'AbortError'));
      return response({ output: { task_id: 'qwen-cancel-task' } });
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(runVideo(userId, {}, {
      executionSignal: controller.signal,
      onProgress: message => progress.push(message),
    })).rejects.toThrow(/cancel|unknown/i);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect((fetchMock.mock.calls[0][1] as RequestInit).signal?.aborted).toBe(true);
    expect(fetchMock.mock.calls[1][0]).toBe('https://dashscope.aliyuncs.com/api/v1/tasks/qwen-cancel-task/cancel');
    expect(fetchMock.mock.calls[1][1]).toMatchObject({ method: 'POST' });
    expect((fetchMock.mock.calls[1][1] as RequestInit).signal).not.toBe(controller.signal);
    expect((fetchMock.mock.calls[1][1] as RequestInit).signal?.aborted).toBe(false);
    expect(progress).toEqual([
      'DashScope 视频生成任务已提交。',
      'DashScope 视频任务正在排队或生成中。',
      'DashScope 已确认取消远端排队任务。',
    ]);
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
      .mockResolvedValueOnce(response({ file: { download_url: 'https://8.8.8.8/minimax.mp4' } }))
      .mockResolvedValueOnce(mediaResponse(MINIMAL_MP4, 'video/mp4'));
    vi.stubGlobal('fetch', fetchMock);

    const result = await runVideo('video-minimax-user', { duration: 6, resolution: '1080P' });

    expect(result).toMatchObject({
      success: true,
      verified: true,
      verificationStatus: 'verified',
      provider: 'minimax',
      model: 'MiniMax-Hailuo-02',
      taskId: 'minimax-task',
      artifactDurability: 'local_file',
    });
    expect(fs.readFileSync(result.outputPath)).toEqual(MINIMAL_MP4);
    expect(fetchMock.mock.calls.map(call => String(call[0]))).toEqual(expect.arrayContaining([
      'https://api.minimaxi.com/v1/video_generation',
      expect.stringContaining('/v1/query/video_generation'),
      expect.stringContaining('/v1/files/retrieve'),
    ]));
    removeGeneratedVideo(result);
  });

  it('routes SiliconFlow through submit and status endpoints', async () => {
    saveKeys({ SILICONFLOW_API_KEY: 'siliconflow-test-key' });
    upsertUserPreferredGenerationModels('video-siliconflow-user', {
      image: { provider: 'auto' },
      video: { provider: 'siliconflow', models: { siliconflow: 'Wan-AI/Wan2.2-T2V-A14B' } },
    });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response({ requestId: 'siliconflow-task' }))
      .mockResolvedValueOnce(response({ status: 'Succeed', results: { videos: [{ url: 'https://8.8.8.8/siliconflow.mp4' }] } }))
      .mockResolvedValueOnce(mediaResponse(MINIMAL_MP4, 'video/mp4'));
    vi.stubGlobal('fetch', fetchMock);

    const result = await runVideo('video-siliconflow-user', { size: '960*960' });

    expect(result).toMatchObject({ success: true, provider: 'siliconflow', model: 'Wan-AI/Wan2.2-T2V-A14B', taskId: 'siliconflow-task' });
    expect(fetchMock.mock.calls[0][0]).toBe('https://api.siliconflow.cn/v1/video/submit');
    expect(fetchMock.mock.calls[1][0]).toBe('https://api.siliconflow.cn/v1/video/status');
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).image_size).toBe('960x960');
    expect(fs.readFileSync(result.outputPath)).toEqual(MINIMAL_MP4);
    removeGeneratedVideo(result);
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
      .mockResolvedValueOnce(mediaResponse(MINIMAL_MP4, 'video/mp4'));
    vi.stubGlobal('fetch', fetchMock);

    const result = await runVideo('video-openai-user', { duration: 8, size: '1280*720' });

    expect(result).toMatchObject({ success: true, provider: 'openai', model: 'sora-2-pro', taskId: 'openai-video' });
    expect(result.outputPath).toMatch(/openai_video_\d+_[0-9a-f-]{36}\.mp4$/);
    expect(fs.existsSync(result.outputPath)).toBe(true);
    expect(fs.readFileSync(result.outputPath)).toEqual(MINIMAL_MP4);
    const form = fetchMock.mock.calls[0][1].body as FormData;
    expect(form.get('model')).toBe('sora-2-pro');
    expect(form.get('seconds')).toBe('8');
    expect(form.get('size')).toBe('1280x720');
    fs.rmSync(result.outputPath, { force: true });
  });

  it('removes the atomic temporary file when cancellation arrives during publication', async () => {
    const userId = 'video-openai-cancel-during-write-user';
    saveKeys({ OPENAI_API_KEY: 'openai-test-key' });
    upsertUserPreferredGenerationModels(userId, {
      image: { provider: 'auto' },
      video: { provider: 'openai', models: { openai: 'sora-2-pro' } },
    });
    const before = generatedFiles();
    const controller = new AbortController();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response({ id: 'openai-cancel-video', status: 'queued' }))
      .mockResolvedValueOnce(response({ id: 'openai-cancel-video', status: 'completed' }))
      .mockResolvedValueOnce(mediaResponse(MINIMAL_MP4, 'video/mp4'));
    vi.stubGlobal('fetch', fetchMock);
    const fsyncSpy = vi.spyOn(fs, 'fsyncSync').mockImplementationOnce(() => {
      controller.abort(new DOMException('cancelled during atomic publication', 'AbortError'));
    });

    try {
      await expect(runVideo(userId, {}, { executionSignal: controller.signal }))
        .rejects.toThrow(/cancel|unknown/i);
      expect(generatedFiles()).toEqual(before);
    } finally {
      fsyncSpy.mockRestore();
    }
  });

  it('converts a local first frame to a data URL and routes it through the independent official I2V model', async () => {
    const userId = 'video-official-i2v-user';
    configureOfficialVideoModels(userId);
    const referencePath = path.join(process.env.LUMI_DATA_DIR!, 'official-i2v-reference.png');
    const referenceBytes = VALID_PNG_BYTES;
    fs.writeFileSync(referencePath, referenceBytes);
    const fetchMock = vi.fn(async (..._request: Parameters<typeof fetch>): Promise<Response> => jsonResponse({
      video_base64: `data:video/mp4;base64,${MINIMAL_MP4.toString('base64')}`,
    }));
    vi.stubGlobal('fetch', fetchMock);

    let result: any;
    try {
      result = await runVideo(userId, { first_frame_image: referencePath, duration: 5 });
      const request = fetchMock.mock.calls[0];
      const payload = JSON.parse(String(request[1]?.body || '{}'));

      expect(String(request[0])).toBe('https://official.example.test/v1/videos/generations');
      expect(payload).toMatchObject({
        model: OFFICIAL_I2V_MODEL,
        duration: 5,
        input_reference: `data:image/png;base64,${referenceBytes.toString('base64')}`,
      });
      expect(result).toMatchObject({
        ok: true,
        status: 'generated',
        success: true,
        provider: 'relay',
        model: OFFICIAL_I2V_MODEL,
        taskId: 'completed',
        generationMode: 'image_to_video',
        inputReferenceAccepted: true,
        selectionReason: 'configured_image_to_video_role',
        artifactDurability: 'local_file',
      });
      expect(result.outputPath).toMatch(/official_video_\d+_[0-9a-f-]{36}\.mp4$/);
      expect(fs.existsSync(result.outputPath)).toBe(true);
      expect(fs.readFileSync(result.outputPath)).toEqual(MINIMAL_MP4);
      expect(result.artifacts).toEqual([{ type: 'video', path: result.outputPath }]);
    } finally {
      removeGeneratedVideo(result);
      fs.rmSync(referencePath, { force: true });
    }
  });

  it('keeps text-to-video on its separately configured official model and reports the mode receipt', async () => {
    const userId = 'video-official-t2v-user';
    configureOfficialVideoModels(userId);
    const fetchMock = vi.fn(async (..._request: Parameters<typeof fetch>): Promise<Response> => jsonResponse({
      video_base64: `data:video/webm;base64,${MINIMAL_WEBM.toString('base64')}`,
    }));
    vi.stubGlobal('fetch', fetchMock);

    let result: any;
    try {
      result = await runVideo(userId);
      const payload = JSON.parse(String(fetchMock.mock.calls[0][1]?.body || '{}'));

      expect(payload.model).toBe(OFFICIAL_T2V_MODEL);
      expect(payload).not.toHaveProperty('input_reference');
      expect(result).toMatchObject({
        ok: true,
        status: 'generated',
        success: true,
        provider: 'relay',
        model: OFFICIAL_T2V_MODEL,
        taskId: 'completed',
        generationMode: 'text_to_video',
        inputReferenceAccepted: false,
        selectionReason: 'configured_text_to_video_role',
        artifactDurability: 'local_file',
      });
      expect(result.outputPath).toMatch(/official_video_\d+_[0-9a-f-]{36}\.webm$/);
      expect(fs.readFileSync(result.outputPath)).toEqual(MINIMAL_WEBM);
    } finally {
      removeGeneratedVideo(result);
    }
  });

  it('downloads and atomically publishes an official async content response', async () => {
    const userId = 'video-official-content-user';
    configureOfficialVideoModels(userId);
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ id: 'official-content-task', status: 'queued' }))
      .mockResolvedValueOnce(jsonResponse({ id: 'official-content-task', status: 'completed' }))
      .mockResolvedValueOnce(mediaResponse(MINIMAL_WEBM, 'video/webm'));
    vi.stubGlobal('fetch', fetchMock);

    let result: any;
    try {
      result = await runVideo(userId);
      expect(result).toMatchObject({
        ok: true,
        verified: true,
        verificationStatus: 'verified',
        provider: 'relay',
        taskId: 'official-content-task',
        artifactDurability: 'local_file',
      });
      expect(result.outputPath).toMatch(/official_video_\d+_[0-9a-f-]{36}\.webm$/);
      expect(fs.readFileSync(result.outputPath)).toEqual(MINIMAL_WEBM);
      expect(generatedFiles().some(file => file.endsWith('.partial'))).toBe(false);
    } finally {
      removeGeneratedVideo(result);
    }
  });

  it('rejects invalid official base64 without leaving a final or partial file', async () => {
    const userId = 'video-official-invalid-base64-user';
    configureOfficialVideoModels(userId);
    const before = generatedFiles();
    const invalidBytes = Buffer.from('<!doctype html><title>not video</title>');
    vi.stubGlobal('fetch', vi.fn(async (..._request: Parameters<typeof fetch>): Promise<Response> => jsonResponse({
      video_base64: `data:video/mp4;base64,${invalidBytes.toString('base64')}`,
    })));

    await expect(runVideo(userId)).rejects.toThrow('not a valid MP4 or WebM container');
    expect(generatedFiles()).toEqual(before);
  });

  it('rejects configured T2V and I2V model cross-use before any provider request', async () => {
    const userId = 'video-official-mode-guard-user';
    configureOfficialVideoModels(userId);
    upsertUserPreferredGenerationModels(userId, {
      image: { provider: 'auto' },
      video: { provider: 'relay', model: OFFICIAL_I2V_MODEL, models: { relay: OFFICIAL_I2V_MODEL } },
      imageToVideo: { provider: 'relay', model: OFFICIAL_T2V_MODEL, models: { relay: OFFICIAL_T2V_MODEL } },
    });
    const referencePath = path.join(process.env.LUMI_DATA_DIR!, 'official-i2v-mode-guard.png');
    fs.writeFileSync(referencePath, VALID_PNG_BYTES);
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    try {
      await expect(runVideo(userId, {
        first_frame_image: referencePath,
      })).rejects.toThrow('text-to-video only');
      await expect(runVideo(userId)).rejects.toThrow('requires a reference image');
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      fs.rmSync(referencePath, { force: true });
    }
  });
});
