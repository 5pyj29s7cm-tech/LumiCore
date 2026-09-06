import './helpers';
import { beforeAll, describe, expect, it } from 'vitest';
import { buildLumiTurnFlow } from '../server/cognition/turn_flow';
import { buildActionContract } from '../server/cognition/action_contract';
import { finalizeLumiResponse } from '../server/cognition/result_finalizer';
import { isVideoPlaybackRequest } from '../server/cognition/media_intent';
import { buildDesktopObservationPlan, evaluateDesktopObservationEvidence } from '../server/cognition/desktop_observation';
import { buildLumiExecutionDecision } from '../server/cognition/execution_decision';
import { prepareConversationActionTaskState } from '../server/cognition/action_continuation';

beforeAll(async () => { const { initDatabase } = await import('../db_layer'); await initDatabase(); });

describe('live conversation routing and terminal truth', () => {
  it('keeps same-player and allowance followups on the exact unfinished playback task', () => {
    const policy = { allowedTools: ['desktop_open', 'desktop_ui_snapshot'], forbiddenTools: [], requireConfirmation: [], maxIterations: 8 };
    const initial = prepareConversationActionTaskState(null, { userText: '帮我用爱奇艺播放第一集', requestId: 'voice-first', toolPolicy: policy });
    const unfinished = { ...initial.state!, status: 'blocked' as const, unfinished: true };
    for (const text of ['用爱奇艺', '允许']) {
      const next = prepareConversationActionTaskState(unfinished, { userText: text, requestId: `chat-${text}`, toolPolicy: policy });
      expect(next.kind).toBe('resume');
      expect(next.state?.taskId).toBe(initial.state?.taskId);
      expect(next.state?.goal).toBe(initial.state?.goal);
      expect(prepareConversationActionTaskState(null, { userText: text, requestId: 'unbound', toolPolicy: policy }).kind).toBe('conversation');
    }
    expect(prepareConversationActionTaskState(unfinished, { userText: '用优酷', requestId: 'different', toolPolicy: policy }).kind).not.toBe('resume');
  });
  it('keeps an image request on the generator through final execution routing', () => {
    const text = '生成图片：帮我生成一张棒棒糖的图片';
    const flow = buildLumiTurnFlow({ userId: 'live-regression', text, channel: 'chat', operationMode: 'autonomous', targetIsLumi: true });
    const toolDeclarations = ['generate_image', 'get_image_generation_status', 'work_product_plan', 'work_product_verify', 'write_file', 'read_file', 'create_pdf', 'create_docx', 'desktop_write_text_file', 'self_extension_plan'].map(name => ({
      type: 'function' as const, function: { name, description: name, parameters: { type: 'object', properties: {} } },
    }));
    const decision = buildLumiExecutionDecision({ flow, text, toolDeclarations });
    expect(decision.toolRoute?.toolNames).toContain('generate_image');
    expect(decision.toolRoute?.categories).not.toContain('artifact_work');
    expect(decision.toolRoute?.toolNames).not.toContain('desktop_write_text_file');
    expect(decision.toolRoute?.toolNames).not.toContain('self_extension_plan');
  });
  it.each(['查看一下电脑的存储量', '看看硬盘还有多少空间', 'Show storage capacity on my computer'])('routes storage questions to native metrics, not capability installation: %s', taskText => {
    expect(buildDesktopObservationPlan(taskText)).toEqual([{ name: 'desktop_system_info', arguments: {} }]);
    const evidence = evaluateDesktopObservationEvidence([{
      name: 'desktop_system_info', arguments: {},
      result: JSON.stringify({ disks: [{ mount_point: 'D:', total_space: 512 * 1024 ** 3, available_space: 120 * 1024 ** 3 }] }),
      terminalVerification: { status: 'verified', strategy: 'terminal_receipt', reason: 'Native snapshot' },
    }], taskText);
    expect(evidence.complete).toBe(true);
    expect(evidence.text).toContain('512.0 GiB');
    expect(evidence.text).toContain('120.0 GiB');
  });
  it('does not mistake CPU/memory data for the requested storage result', () => {
    const evidence = evaluateDesktopObservationEvidence([{
      name: 'desktop_system_info', arguments: {}, result: JSON.stringify({ total_memory: 32 * 1024 ** 3 }),
      terminalVerification: { status: 'verified', strategy: 'terminal_receipt', reason: 'Older native client snapshot' },
    }], '查看一下电脑的存储量');
    expect(evidence.complete).toBe(false);
  });
  it.each(['嗯, 帮我用爱奇艺放吧, 我要看第1集。', '帮我用优酷放一下这部电影', 'Play episode one on YouTube'])('admits actual video playback tools across voice and text: %s', text => {
    for (const channel of ['voice', 'chat'] as const) {
      const flow = buildLumiTurnFlow({ userId: 'live-regression', text, channel, operationMode: 'autonomous', targetIsLumi: true });
      expect(flow.allowToolUseForTurn).toBe(true);
      expect(flow.workSurfaceRoute.directDesktop).toBe(true);
      expect(buildActionContract(text).applies).toBe(true);
    }
  });
  it.each(['爱奇艺是什么', '不要用爱奇艺播放视频', '怎么在优酷播放视频', '把视频放到文件夹', '用爱奇艺'])('does not invent a playback instruction from mention, advice or a missing action: %s', text => {
    expect(isVideoPlaybackRequest(text)).toBe(false);
  });
  it.each([
    ['又怎么了', '已经成功生成了一张图片。[图片](https://cdn.invalid/generated.png)'],
    ['这是什么', '请查看以下图片：\n![](https://cdn.invalid/generated.png)'],
    ['用爱奇艺', '已经成功打开了爱奇艺首页。第一集已经开始播放了。'],
    ['允许', '[模拟打开爱奇艺网站]已经打开了爱奇艺。'],
    ['知。', '好的，这就帮你打开爱奇艺。'],
    ['又怎么了', '[LUMI_INTERNAL_RECEIPT_LEDGER_V1: generated | outcome=verified_success]图片生成成功。'],
  ])('does not let chat classification exempt an unsupported execution claim: %s', (taskText, responseText) => {
    const result = finalizeLumiResponse({ taskText, responseText, toolRecords: [], source: 'chat', flow: { allowToolUseForTurn: false } as any });
    expect(result.blocked).toBe(true);
    expect(result.text).not.toContain('cdn.invalid');
    expect(result.text).not.toContain('LUMI_INTERNAL_RECEIPT');
  });
  it('preserves an upstream blocked verdict even after its wording no longer contains a completion claim', () => {
    const blocked = { text: 'The requested action did not start.', blocked: true, reason: 'No action receipt.' };
    const result = finalizeLumiResponse({ taskText: 'Continue', responseText: blocked.text, source: 'chat', completionGuard: blocked, flow: { allowToolUseForTurn: false } as any });
    expect(result.blocked).toBe(true);
  });
  it.each([false, true])('allows verified media despite an upstream generic guard (blocked=%s)', upstreamBlocked => {
    const result = finalizeLumiResponse({ taskText: '帮我生成一张图片', responseText: '图片已经生成。', source: 'chat',
      completionGuard: upstreamBlocked ? { text: 'No document was created.', blocked: true, reason: 'Generic artifact guard.' } : undefined,
      toolRecords: [{
      name: 'generate_image', arguments: { prompt: 'a landscape' },
      result: JSON.stringify({ success: true, verified: true, verificationStatus: 'verified', outputPaths: ['D:/generated/landscape.png'] }),
      terminalVerification: { status: 'verified', strategy: 'terminal_receipt', reason: 'Downloaded artifact was verified' },
    }] });
    expect(result.blocked).toBe(false);
  });
  it.each(['生成一个视频', '生成两张图片'])('does not complete a different kind or number of requested artifacts: %s', taskText => {
    const result = finalizeLumiResponse({ taskText, responseText: '已经完成了。', source: 'chat', toolRecords: [{
      name: 'generate_image', arguments: { prompt: 'a landscape' },
      result: JSON.stringify({ success: true, verified: true, verificationStatus: 'verified', outputPaths: ['D:/generated/landscape.png'] }),
      terminalVerification: { status: 'verified', strategy: 'terminal_receipt', reason: 'Downloaded artifact was verified' },
    }] });
    expect(result.blocked).toBe(true);
  });
  it('does not use a URL in the generator prompt as a delivered artifact', () => {
    const result = finalizeLumiResponse({ taskText: '又怎么了', responseText: '请查看以下图片：![](https://cdn.invalid/reference.png)', source: 'chat', flow: { allowToolUseForTurn: false } as any, toolRecords: [{
      name: 'generate_image', arguments: {},
      result: JSON.stringify({ prompt: 'https://cdn.invalid/reference.png', success: true, verified: true, verificationStatus: 'verified', outputPaths: ['D:/generated/landscape.png'] }),
      terminalVerification: { status: 'verified', strategy: 'terminal_receipt', reason: 'Downloaded artifact was verified' },
    }] });
    expect(result.blocked).toBe(true);
    expect(result.text).not.toContain('cdn.invalid');
  });
});
