import './helpers';
import { beforeAll, describe, expect, it } from 'vitest';
import { buildLumiExecutionPipeline } from '../server/cognition/execution_pipeline';
import { registerAllTools } from '../server/tools/definitions';
import { ToolRegistry } from '../server/tools/registry';
import { structuredMediaRoutingEnvelope, type StructuredMediaRequest } from '../shared/media_generation';
import { classifyExecutionGuardIntent } from '../server/cognition/execution_guard_recovery';
import { buildConversationActionContinuationState, buildRecentActionContinuationBridge, classifyConversationActionFollowupIntent } from '../server/cognition/action_continuation';
import { resolveActiveTaskMessageRelation } from '../server/cognition/task_concurrency';
import { prepareModelRequestContext } from '../server/llm/request_context_budget';
import { buildTaskCapsuleV1, formatTaskCapsuleForPrompt } from '../server/conversation/task_capsule';

const registry = new ToolRegistry();
beforeAll(async () => {
  const { initDatabase } = await import('../db_layer');
  await initDatabase();
  registerAllTools(registry);
});

const cases: { text: string; media: StructuredMediaRequest; tool: string }[] = [
  { text: '生成视频：6秒无声视频，写实温暖的公寓走廊，夜色微蓝，两位原创成年邻居在门口相视微笑，镜头固定，轻微自然动作，不要文字、聊天气泡和手机外框，不要背景音乐。',
    media: { operation: 'text_to_video', prompt: '6秒无声视频，写实温暖的公寓走廊，夜色微蓝，两位原创成年邻居在门口相视微笑，镜头固定，轻微自然动作，不要文字、聊天气泡和手机外框，不要背景音乐。', size: '720x1280', duration: 6, officialOnly: true }, tool: 'generate_video' },
  { text: '请生成一张图片：明亮的木桌上放着一个蓝色陶瓷杯，简洁写实风格，没有文字和人物。只生成一张，1024×1024，完成后直接在对话里给我图片。',
    media: { operation: 'text_to_image', prompt: '明亮的木桌上放着一个蓝色陶瓷杯，简洁写实风格，没有文字和人物。', size: '1024x1024', count: 1 }, tool: 'generate_image' },
  { text: '请生成一段5秒的视频：清晨森林里树叶随微风轻轻摇动，镜头固定，没有人物、文字或声音。1280×720，完成后直接在对话里给我视频。',
    media: { operation: 'text_to_video', prompt: '清晨森林里树叶随微风轻轻摇动，镜头固定，没有人物、文字或声音。', size: '1280x720', duration: 5 }, tool: 'generate_video' },
  { text: 'Edit image\nChange the background to blue.',
    media: { operation: 'image_edit', prompt: 'Change the background to blue.', size: '1024x1024', primaryImage: 'C:/test/source.png' }, tool: 'ai_edit_image' },
  { text: 'Generate a video\nAnimate this image.',
    media: { operation: 'image_to_video', prompt: 'Animate this image.', size: '1280x720', referenceImage: 'C:/test/source.png', duration: 5 }, tool: 'generate_video' },
];

describe('media requests through the complete shared planning pipeline', () => {
  function failedImageTask() {
    return buildConversationActionContinuationState({
      userText: '帮我生成一张皮卡丘在精灵球里的图片',
      assistantText: '超时了，我再试一次——这次简化画面，减少复杂元素，提高成功率。',
      toolCalls: [{ name: 'generate_image', arguments: { prompt: 'Pikachu in a ball' },
        error: 'Lumi Official API request timed out after 60000ms', result: '',
        terminalVerification: { status: 'failed', strategy: 'artifact', reason: 'timed out' } }],
      updatedAt: new Date().toISOString(),
    })!;
  }
  it.each(['chat', 'voice', 'task'] as const)('retains the failed media task after accepting its retry on %s', channel => {
    const state = failedImageTask();
    expect(state).toMatchObject({ unfinished: true, status: 'blocked' });
    expect(classifyConversationActionFollowupIntent('可以', state)).toBe('execute');
    expect(resolveActiveTaskMessageRelation('可以', state)).toMatchObject({ feedback: 'retry', taskId: state.taskId });
    const continuationContext = buildRecentActionContinuationBridge('可以', [], state);
    const pipeline = buildLumiExecutionPipeline({
      dispatch: { userId: 'media-acceptance', channel, text: '可以', continuationContext, targetIsLumi: true }, registry,
      actionTaskState: state,
      personalityToolPolicy: { allowedTools: ['*'], requireConfirmation: [], forbiddenTools: [], maxIterations: 10 },
    });
    expect({ intent: pipeline.normalizedIntent, execute: pipeline.executionRequested, tools: pipeline.modelToolProjection.toolNames,
      comparison: pipeline.shadowComparison }).toMatchObject({ intent: { kind: 'media_generation' }, execute: true,
      tools: expect.arrayContaining(['generate_image']), comparison: { externalCommitBlocked: false } });
    expect(pipeline.authorizationPolicy.forbiddenTools).toContain('send_email');
    expect(pipeline.turnIntent.flow.routeText).toContain(state.goal);
  });
  it('retains the unfinished media brief under request pressure after tool results arrive', () => {
    const state = failedImageTask();
    const capsule = formatTaskCapsuleForPrompt(buildTaskCapsuleV1(state)!);
    expect(capsule).not.toContain('clarify_target');
    const prepared = prepareModelRequestContext({ inputTokenBudget: 4096, toolDeclarations: [], messages: [
      { role: 'system', content: ['Core operating rules', '## Manual\n' + 'Background UI documentation. '.repeat(3000), capsule].join('\n\n') },
      { role: 'user', content: state.goal },
      { role: 'user', content: '可以', sourceMessageId: 'current-approval' },
      { role: 'assistant', content: '', toolCalls: [{ id: 'health-call', name: 'adapter_health_check', arguments: {} }] },
      { role: 'tool', toolCallId: 'health-call', content: 'Adapter inventory. '.repeat(1500) },
    ] });
    expect(prepared.compacted).toBe(true);
    expect(prepared.messages.filter(m => m.role === 'system').map(m => m.content).join('\n')).toContain(state.goal);
    expect(prepared.messages.some(m => m.sourceMessageId === 'current-approval')).toBe(true);
  });
  it.each(['调用了吗', '你发起了吗', '你发了吗，没发为什么说你再发一次', '为什么你说完以后自己没去发起？'])(
    'keeps %s attached to the original task without authorizing another generation', text => {
      const state = failedImageTask();
      expect(classifyConversationActionFollowupIntent(text, state)).toBe('status');
      expect(resolveActiveTaskMessageRelation(text, state)).toMatchObject({ feedback: 'status', taskId: state.taskId });
      expect(buildRecentActionContinuationBridge(text, [], state)).toContain(state.goal);
    });
  it('does not turn an unbound, stale, completed or unrelated acknowledgement into a retry', () => {
    const state = failedImageTask();
    for (const candidate of [undefined, { ...state, assistantState: '晚上好' },
      { ...state, status: 'completed' as const, unfinished: false }, { ...state, updatedAt: '2020-01-01T00:00:00Z' }]) {
      expect(classifyConversationActionFollowupIntent('可以', candidate)).not.toBe('execute');
    }
  });
  it.each(cases.flatMap(item => [ { ...item, structured: true }, { ...item, structured: false } ]))('projects $tool (structured=$structured) and requires its evidence', ({ text, media, tool, structured }) => {
    const pipeline = buildLumiExecutionPipeline({
      structuredMediaRequest: structured ? media : undefined,
      dispatch: { userId: 'media-acceptance', channel: 'chat', source: 'local_acceptance_harness', operationMode: 'assistant',
        text: structured ? [text, structuredMediaRoutingEnvelope(media)].join('\n\n') : text, targetIsLumi: true },
      registry, personalityToolPolicy: { allowedTools: ['*'], requireConfirmation: [], forbiddenTools: [], maxIterations: 10 },
    });
    expect({ intent: pipeline.normalizedIntent, route: pipeline.execution.toolRoute,
      execute: pipeline.executionRequested, projected: pipeline.modelToolProjection.toolNames,
      ledger: pipeline.capabilityPlan.taskLedgerRequired }).toMatchObject({ execute: true, ledger: true,
        projected: expect.arrayContaining([tool]) });
    expect(classifyExecutionGuardIntent([text, structuredMediaRoutingEnvelope(media)].join('\n\n'))).toBe('action_execution');
    expect(pipeline.authorizationPolicy.forbiddenTools).toContain('send_email');
  });
  it.each(['不要生成图片，只解释功能', '生成图片的模型是什么？', '生成视频脚本', 'Generate a video prompt', '生成图片了吗？', '打开刚才生成的图片'])('does not grant generation for %s', text => {
    const pipeline = buildLumiExecutionPipeline({
      dispatch: { userId: 'media-acceptance', channel: 'chat', text, targetIsLumi: true }, registry,
      personalityToolPolicy: { allowedTools: ['*'], requireConfirmation: [], forbiddenTools: [], maxIterations: 10 },
    });
    expect(pipeline.normalizedIntent.kind).not.toBe('media_generation');
    expect(pipeline.modelToolProjection.toolNames).not.toEqual(expect.arrayContaining(['generate_image']));
    expect(pipeline.modelToolProjection.toolNames).not.toEqual(expect.arrayContaining(['generate_video']));
  });
  it('keeps explicit policy denial authoritative even with a valid workbench request', () => {
    const { text, media, tool } = cases[0];
    const pipeline = buildLumiExecutionPipeline({ structuredMediaRequest: media,
      dispatch: { userId: 'media-acceptance', channel: 'chat', text, targetIsLumi: true }, registry,
      personalityToolPolicy: { allowedTools: ['*'], requireConfirmation: [], forbiddenTools: [tool], maxIterations: 10 },
    });
    expect(pipeline.modelToolProjection.toolNames).not.toContain(tool);
  });
  it.each(['image', 'video'] as const)('executes a validated %s creation despite surrounding acceptance narration', mode => {
    const media: StructuredMediaRequest = { operation: mode === 'image' ? 'text_to_image' : 'text_to_video',
      prompt: '不要生成汉字、聊天气泡或手机外框。两人相视而笑。', size: '720x1280', officialOnly: true };
    const text = `本轮为创作功能验收，请按已给定的 mediaRequest 实际生成${mode === 'image' ? '一张图片' : '一个6秒视频'}，使用 Lumi 官方 API，生成文件保存入库即可。不调用汽水或剪映，不打开网页，不发布作品。本轮是虚构验收素材，不作为我的个人经历或偏好保存。`;
    const run = (text: string, forbiddenTools: string[] = []) => buildLumiExecutionPipeline({ structuredMediaRequest: media,
      dispatch: { userId: 'media-acceptance', channel: 'chat', text, targetIsLumi: true }, registry,
      personalityToolPolicy: { allowedTools: ['*'], requireConfirmation: [], forbiddenTools, maxIterations: 10 },
    });
    const tool = mode === 'image' ? 'generate_image' : 'generate_video';
    expect(run(text).executionRequested).toBe(true);
    expect(run(text).modelToolProjection.toolNames).toContain(tool);
    expect(run(`生成${mode === 'image' ? '图片' : '视频'}：${media.prompt}`).modelToolProjection.toolNames).toContain(tool);
    expect(run(text, [tool]).modelToolProjection.toolNames).not.toContain(tool);
    expect(run(text + '现在不要使用工具。').executionRequested).toBe(false);
    expect(run(text + '现在不要生成任何内容。').modelToolProjection.toolNames).not.toContain(tool);
  });
});
