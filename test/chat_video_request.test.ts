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

it.each([['三十秒', 30], ['六十秒', 60], ['一百二十秒', 120], ['一分钟', 60], ['半分钟', 30]])('honors the user duration %s through the same video request', (duration, expected) => {
  expect(resolveChatVideoRequest('帮我做一个tiktok的推广视频，要'+duration+'的，纯英文版', images(), scope)).toMatchObject({ operation: 'image_to_video', duration: expected });
});

const videoBriefHistory = [
  { role: 'user', message: '帮我做一个tiktok的推广视频，要三十秒的，纯英文版\n\n[Attachments]\n- product.png (image)' },
  { role: 'assistant', message: '视频已生成。' },
  { role: 'user', message: '不是三十秒吗' },
  { role: 'assistant', message: '正确的30秒纯英文脚本：0–3秒展示产品；3–24秒展示玩法；24–30秒结尾。需要我按这个脚本直接生成30秒成片吗？文案按上面的非拼写错误版来，还是保留错拼风格？' },
];
it('binds a version choice to the adjacent script and original video goal', () => {
  const text = '按上面的“非拼写错误版”来';
  const request = resolveChatVideoRequest(text, images(), scope, videoBriefHistory)!;
  expect(request).toMatchObject({ operation: 'image_to_video', duration: 30, size: '1080x1920' });
  expect(request.prompt).toContain('纯英文版');
  expect(request.prompt).toContain('0–3秒展示产品');
  expect(request.prompt).toContain(text);
  expect(request.prompt).not.toContain('需要我');
  const pipeline = buildLumiExecutionPipeline({ structuredMediaRequest: request, registry,
    dispatch: { userId: scope.userId, channel: 'chat', text, targetIsLumi: true },
    personalityToolPolicy: { allowedTools: ['*'], forbiddenTools: [], requireConfirmation: [], maxIterations: 3 },
  });
  expect(pipeline.normalizedIntent.kind).toBe('media_generation');
  expect(pipeline.executionRequested).toBe(true);
  expect(pipeline.modelToolProjection.toolNames).toContain('generate_video');
  expect(pipeline.turnIntent.flow.selfRepairTurn).toBe(false);
});
it('does not infer a paid generation from a question, veto or unrelated stale proposal', () => {
  for (const text of ['不是三十秒吗', '为什么没生成', '不要生成，按上面的版本来']) {
    expect(resolveChatVideoRequest(text, images(), scope, videoBriefHistory)).toBeNull();
  }
  expect(resolveChatVideoRequest('按上面的版本来', images(), scope)).toBeNull();
  expect(resolveChatVideoRequest('好', images(), scope, [...videoBriefHistory.slice(0, 1), { role: 'assistant', message: '视频已生成。' }])).toBeNull();
  expect(resolveChatVideoRequest('按上面的版本来', images(), scope, [...videoBriefHistory, {role:'user',message:'生成一份Word报告'}, {role:'assistant',message:'报告可以插入视频，按这个版本吗？'}])).toBeNull();
});
