import './helpers';
import fs from 'node:fs';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { initDatabase } from '../db_layer';
import { generatedKnowledgeDirectory } from '../server/files/knowledge_directory';
import { resolveChatVideoRequest } from '../server/socket/chat/media_request';
import { structuredMediaToolCall } from '../shared/media_generation';
import { buildLumiExecutionPipeline } from '../server/cognition/execution_pipeline';
import { ToolRegistry } from '../server/tools/registry';
import { registerVideoTools } from '../server/tools/definitions/video_tools';

const scope = { userId: 'video-source-owner', domain: 'personal' as const };
let sourcePath: string;
const registry = new ToolRegistry();
beforeAll(async () => {
  await initDatabase();
  sourcePath = path.join(generatedKnowledgeDirectory(scope), 'uploaded-photo.png');
  fs.writeFileSync(sourcePath, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lZkAAAAASUVORK5CYII=', 'base64'));
  registerVideoTools(registry);
});
const images = () => [{ kind: 'image' as const, fileName: 'uploaded-photo.png', path: sourcePath }];

describe('natural chat video execution', () => {
  it.each(['这个帮我做个tiktok的推广视频，30秒的', '帮我做个推广视频', '用这张照片做成视频', '请帮我生成一段视频：镜头缓慢移动。'])('binds %s to the uploaded first frame and video tool', text => {
    const request = resolveChatVideoRequest(text, images(), scope)!;
    expect(request).toMatchObject({ operation: 'image_to_video', referenceImage: fs.realpathSync(sourcePath), prompt: text });
    expect(structuredMediaToolCall(request)).toMatchObject({ name: 'generate_video', arguments: { first_frame_image: fs.realpathSync(sourcePath) } });
    const pipeline = buildLumiExecutionPipeline({ structuredMediaRequest: request, registry,
      dispatch: { userId: scope.userId, channel: 'chat', text, targetIsLumi: true },
      personalityToolPolicy: { allowedTools: ['*'], forbiddenTools: [], requireConfirmation: [], maxIterations: 3 },
    });
    expect(pipeline.executionRequested).toBe(true);
    expect(pipeline.modelToolProjection.toolNames).toContain('generate_video');
  });
  it('preserves duration, dimensions, and portrait intent instead of quietly replacing them', () => {
    expect(resolveChatVideoRequest('这个帮我做个tiktok的推广视频，30秒的', images(), scope)).toMatchObject({ size: '1080x1920', duration: 30 });
    expect(resolveChatVideoRequest('帮我做个10秒的视频，1280×720', [], scope)).toMatchObject({ operation: 'text_to_video', size: '1280x720', duration: 10 });
  });
  it.each(['不要做视频，只写脚本', '帮我制作推广视频脚本', '生成视频了吗？', '打开刚才生成的视频', '为什么不能生成视频', '生成视频的模型是什么？', '生成视频封面图片', '帮我生成视频页面组件'])('does not spend generation capacity for %s', text => {
    expect(resolveChatVideoRequest(text, images(), scope)).toBeNull();
  });
  it('does not invent a first frame or silently discard ambiguous or foreign materials', () => {
    expect(resolveChatVideoRequest('用这张照片做成视频', [], scope)).toBeNull();
    expect(resolveChatVideoRequest('帮我做个视频', [...images(), ...images()], scope)).toBeNull();
    expect(resolveChatVideoRequest('帮我做个视频', images(), { ...scope, userId: 'other-owner' })).toBeNull();
    expect(resolveChatVideoRequest('帮我做个视频', [{ ...images()[0], path: path.join(process.env.LUMI_DATA_DIR!, 'data/lumi.db') }], scope)).toBeNull();
  });
});
