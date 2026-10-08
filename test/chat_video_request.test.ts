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

const interruptedVideoHistory = [...videoBriefHistory,
  { role: 'user', message: '按上面的“非拼写错误版”来' },
  { role: 'tool', message: '[Tool: client_get_state] Done' },
  { role: 'assistant', message: '自检完成。', cognitiveIntent: 'work_product_guard', toolCalls: [{ name: 'client_get_state', result: '{"ok":true}' }] },
  { role: 'user', message: '继续完成原任务' },
  { role: 'assistant', message: '目前没有可核实的执行结果。', cognitiveIntent: 'work_product_guard', toolCalls: [{ name: 'work_takeover_task_create', result: '{"ok":true,"status":"created"}' }] },
];
it('recovers the selected video brief through incidental diagnostic and task-registration guard replies', () => {
  const request = resolveChatVideoRequest('继续完成原任务', images(), scope, interruptedVideoHistory)!;
  expect(request).toMatchObject({ operation: 'image_to_video', duration: 30, size: '1080x1920', referenceImage: fs.realpathSync(sourcePath) });
  expect(request.prompt).toContain('纯英文版');
  expect(request.prompt).toContain('0–3秒展示产品');
  expect(request.prompt).toContain('按上面的“非拼写错误版”来');
  expect(request.prompt).not.toMatch(/client_get_state|自检完成|work_takeover|没有可核实/);
});
it('does not revive old media through unrelated turns, a veto, casual assent or a verified deliverable', () => {
  for (const text of ['好的', '继续之前先告诉我做到哪了', '继续完成原任务，暂时不要执行', '继续原任务，生成Word报告']) {
    expect(resolveChatVideoRequest(text, images(), scope, interruptedVideoHistory)).toBeNull();
  }
  expect(resolveChatVideoRequest('继续完成原任务', images(), scope, [...interruptedVideoHistory, { role: 'user', message: '不要生成了' }, { role: 'assistant', message: '好的。' }])).toBeNull();
  expect(resolveChatVideoRequest('继续完成原任务', images(), scope, [...interruptedVideoHistory, { role: 'user', message: '生成Word报告' }, { role: 'assistant', message: '目前没有可核实的执行结果。', cognitiveIntent: 'work_product_guard' }])).toBeNull();
  const delivered = { role: 'assistant', message: 'guard reply', cognitiveIntent: 'work_product_guard', toolCalls: [{ name: 'generate_video', arguments: { duration: 30 }, result: JSON.stringify({ ok: true, verified: true, verificationStatus: 'verified', outputPath: 'D:/generated/finished.mp4', settingsMatch: true, actualSettings: { duration: 30 } }) }] };
  expect(resolveChatVideoRequest('继续完成原任务', images(), scope, [...interruptedVideoHistory, delivered])).toBeNull();
});

const confirmedVideoHistory = [
  { role: 'user', message: '帮我做一个tiktok的推广视频，要三十秒的，纯英文版' },
  { role: 'assistant', message: '视频已生成。' },
  { role: 'user', message: '你这做的什么东西，声音也没有' },
  { role: 'assistant', message: '没有真正生成出视频。' },
  { role: 'user', message: '你已经生成过了，但是我看不上你做的东西，东西不对，而且画面要16比9的' },
  { role: 'assistant', message: '已停止当前任务，未完成的步骤不会继续执行。', cognitiveIntent: 'task_cancelled' },
  { role: 'user', message: '继续' },
  { role: 'assistant', message: '没法直接吐出成片，因为这轮执行合同没有开放视频生成工具。\n我按你要的标准重新生成，需要你先确认三点：\n配音风格：活泼女声 / 沉稳男声 / 童声（选一个）\n你回一句确认，我就按30秒、16:9、纯英文配音继续推进成片。' },
];
it.each(['确认', '继续'])('binds the promised video on %s and preserves the user correction', text => {
  const history = text === '确认' ? confirmedVideoHistory : [...confirmedVideoHistory,
    { role: 'user', message: '确认' },
    { role: 'assistant', message: '这一步没有返回明确结果。', cognitiveIntent: 'work_product_guard', toolCalls: [{ name: 'client_capability_manifest', result: '{"ok":true}' }] },
  ];
  const request = resolveChatVideoRequest(text, images(), scope, history)!;
  expect(request).toMatchObject({ operation: 'image_to_video', duration: 30, size: '1920x1080' });
  expect(request.prompt).toContain('画面要16比9');
  expect(request.prompt).toContain('纯英文配音');
  expect(request.prompt).not.toMatch(/执行合同|工具|选一个|没有真正生成/);
  expect(structuredMediaToolCall(request).name).toBe('generate_video');
});
it.each([
  ['帮我做个tiktok视频，16:9', '1920x1080'],
  ['帮我做个tiktok视频，16比9', '1920x1080'],
  ['帮我做个tiktok视频，横屏', '1920x1080'],
  ['帮我做个视频，16:9，改成9:16', '1080x1920'],
  ['帮我做个视频，720x1280，改成16:9', '1920x1080'],
  ['帮我做个视频，16:9，改成720x1280', '720x1280'],
])('gives the latest explicit dimensions precedence: %s', (text, size) => {
  expect(resolveChatVideoRequest(text, images(), scope)).toMatchObject({ size });
});
it('does not revive a video for a complaint, an unrelated document confirmation, or a finished receipt', () => {
  expect(resolveChatVideoRequest('我要的是视频这是什么', images(), scope, confirmedVideoHistory)).toBeNull();
  expect(resolveChatVideoRequest('确认', images(), scope, [...confirmedVideoHistory,
    { role: 'user', message: '只生成Word视频脚本' },
    { role: 'assistant', message: '请你确认，我就生成视频脚本文档。' },
  ])).toBeNull();
  const delivery = { role: 'assistant', message: '视频已生成。', toolCalls: [{ name: 'generate_video', arguments: {},
    result: JSON.stringify({ ok: true, verified: true, verificationStatus: 'verified', outputPath: 'D:/generated/finished.mp4', settingsMatch: true }) }] };
  expect(resolveChatVideoRequest('继续', images(), scope, [...confirmedVideoHistory, { role: 'user', message: '确认' }, delivery])).toBeNull();
});

it('keeps the original video brief when incidental tool events fill the raw history window', () => {
  const history = [...confirmedVideoHistory.slice(0, -1), ...Array.from({ length: 40 }, () => ({ role: 'tool', message: '[Tool: client_capability_manifest] Done' })), confirmedVideoHistory.at(-1)!];
  expect(resolveChatVideoRequest('确认', images(), scope, history)).toMatchObject({ duration: 30, size: '1920x1080' });
});
