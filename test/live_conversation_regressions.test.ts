import './helpers';
import { beforeAll, describe, expect, it } from 'vitest';
import { initDatabase } from '../db_layer';
import { buildLumiExecutionPipeline } from '../server/cognition/execution_pipeline';
import { ToolRegistry } from '../server/tools/registry';
import { registerAllTools } from '../server/tools/definitions';
import { finalizeLumiResponse } from '../server/cognition/result_finalizer';
import { prepareConversationActionTaskState, buildRecentActionContinuationBridge, buildConversationActionContinuationState } from '../server/cognition/action_continuation';
import { resolveActiveTaskMessageRelation } from '../server/cognition/task_concurrency';
import { classifyVoiceWorkInterruption } from '../server/socket/voice_turn_state';
import { sanitizeSummaryForPrompt, buildEvidenceGroundedSummaryTranscript } from '../server/conversation/summary_grounding';
import { buildActionContract, hasCoreActionEvidence } from '../server/cognition/action_contract';

beforeAll(async () => { await initDatabase(); });
const registry = new ToolRegistry();
registerAllTools(registry);
const policy = { allowedTools: ['*'], requireConfirmation: [], forbiddenTools: [], maxIterations: 12 };
function plan(text: string, channel: 'chat' | 'voice' = 'chat') {
  return buildLumiExecutionPipeline({ dispatch: { userId: 'live-regression', text, channel,
    source: channel === 'chat' ? 'command-center-chat' : 'voice', operationMode: 'assistant', targetIsLumi: true },
    registry, personalityToolPolicy: policy });
}

describe('September live conversation failures', () => {
  it('keeps a status check on runtime evidence rather than legal or biometric tools', () => {
    const names = plan('状态检查').modelToolProjection.toolNames;
    expect(names).toEqual(expect.arrayContaining(['runtime_work_status', 'client_health_check', 'client_get_state']));
    expect(names.some(name => /legal|biometric/.test(name))).toBe(false);
  });
  it('verifies pause state instead of treating a media key as success or asking for playback to start', () => {
    const taskText = '暂停音乐';
    const input = { taskText, source: 'voice', taskId: 'pause-task', requestId: 'pause-request', responseText: '已经暂停音乐。' };
    const key = { name: 'desktop_keyboard_press', arguments: { key: 'media_play_pause' }, taskId: input.taskId, requestId: input.requestId, result: '{"ok":true}' };
    const observation = { name: 'desktop_ui_snapshot', arguments: {}, taskId: input.taskId, requestId: input.requestId, result: JSON.stringify({ ok: true, playback: { playbackState: 'paused', isPlaying: false } }) };
    expect(plan(taskText, 'voice').modelToolProjection.toolNames).toContain('desktop_ui_snapshot');
    expect(finalizeLumiResponse({ ...input, toolRecords: [key] })).toMatchObject({ blocked: true, text: '还没有确认播放器已暂停。' });
    expect(finalizeLumiResponse({ ...input, toolRecords: [key, observation] })).toMatchObject({ blocked: false, text: '已确认播放器暂停。' });
    expect(finalizeLumiResponse({ ...input, toolRecords: [{ ...observation, requestId: 'previous-request' }] }).blocked).toBe(true);
    expect(finalizeLumiResponse({ ...input, toolRecords: [observation, { ...observation, result: '{"playback":{"playbackState":"playing"}}' }] }).blocked).toBe(true);
  });
  it('requires both browser and wallpaper receipts for the actual composite navigation request', () => {
    const taskText = '你给我打开，用浏览器打开，进入壁纸模式';
    const contract = buildActionContract(taskText);
    const wallpaper = { name: 'client_action', arguments: { action: 'set_wallpaper_mode', enabled: true }, result: JSON.stringify({
      ok: true, action: 'set_wallpaper_mode', enabled: true, verification: { status: 'verified' },
    }) };
    const browser = { name: 'desktop_open', arguments: { target: '浏览器' }, result: JSON.stringify({
      ok: true, status: 'verified', target: '浏览器', targetMatched: true, verificationBasis: 'post_open_foreground',
      actualTarget: { processName: 'chrome.exe', productName: 'Google Chrome', title: 'Google Chrome', signatureStatus: 'Valid' },
    }) };
    expect(contract.components).toHaveLength(2);
    expect(plan(taskText).modelToolProjection.toolNames).toEqual(expect.arrayContaining(['desktop_open', 'client_action']));
    expect(hasCoreActionEvidence(contract, [wallpaper], taskText)).toBe(false);
    const partial = finalizeLumiResponse({ taskText, source: 'voice', responseText: '全部完成了', toolRecords: [wallpaper] });
    expect(partial.blocked, JSON.stringify(partial)).toBe(true);
    expect(partial.text).toContain('浏览器');
    for (const component of contract.components || []) expect(hasCoreActionEvidence(component.contract, [browser, wallpaper], component.text), JSON.stringify(component)).toBe(true);
    expect(hasCoreActionEvidence(contract, [browser, wallpaper], taskText)).toBe(true);
    const completed = finalizeLumiResponse({ taskText, source: 'voice', responseText: '', toolRecords: [browser, wallpaper] });
    expect(completed.blocked, JSON.stringify(completed)).toBe(false);
  });
  it('lets a verified browser receipt determine the reply despite a frustrated preface', () => {
    const taskText = '哼, 我操你妈, 打开浏览器。';
    const result = finalizeLumiResponse({ taskText, responseText: '已打开浏览器。', source: 'voice',
      flow: plan(taskText, 'voice').turnIntent.flow, taskId: 'browser-task', requestId: 'browser-request', toolRecords: [{
        id: 'open', name: 'desktop_open', taskId: 'browser-task', requestId: 'browser-request', arguments: { target: '浏览器' },
        result: JSON.stringify({ ok: true, status: 'verified', target: '浏览器', targetMatched: true, verificationBasis: 'post_open_foreground',
          actualTarget: { processName: 'chrome.exe', productName: 'Google Chrome', title: 'Google Chrome', signatureStatus: 'Valid' } }),
        terminalVerification: { status: 'verified', strategy: 'state_diff', reason: 'The receipt contains verified post-action state.' },
      }] });
    expect(result.blocked, JSON.stringify(result)).toBe(false);
    expect(result.text).toContain('Google Chrome');
  });
  it('keeps the root CAD task and its capabilities when asked to open its application first', () => {
    const goal = '读取桌面上的户型图，在 AutoCAD 里完成设计并保存图纸';
    const previous = prepareConversationActionTaskState(null, { userText: goal, requestId: 'cad-1', toolPolicy: policy, forceTask: true }).state!;
    const text = '把AutoCAD先打开';
    expect(resolveActiveTaskMessageRelation(text, previous)).toMatchObject({ feedback: 'continue', preservesRootGoal: true });
    const next = prepareConversationActionTaskState(previous, { userText: text, requestId: 'cad-2', toolPolicy: { ...policy, allowedTools: ['desktop_open'] } });
    expect(next.kind).toBe('resume');
    expect(next.state).toMatchObject({ taskId: previous.taskId, goal, latestInstruction: text, policySnapshot: previous.policySnapshot });
    const tool = { name: 'desktop_open', taskId: previous.taskId, requestId: 'cad-2', arguments: { target: 'AutoCAD' }, result: JSON.stringify({
      ok: true, status: 'verified', target: 'AutoCAD', targetMatched: true, verificationBasis: 'post_open_foreground',
      actualTarget: { processName: 'acad.exe', title: 'AutoCAD 2026', signatureStatus: 'Valid' },
    }) };
    const recorded = buildConversationActionContinuationState({ previous: next.state, userText: text, assistantText: 'AutoCAD 已打开。', toolCalls: [tool], requestId: 'cad-2', toolPolicy: { ...policy, allowedTools: ['desktop_open'] } });
    expect(recorded).toMatchObject({ taskId: previous.taskId, goal, unfinished: true, policySnapshot: previous.policySnapshot });
    expect(recorded?.status).not.toBe('completed');
    const pipeline = buildLumiExecutionPipeline({ registry, personalityToolPolicy: policy, actionTaskState: previous,
      dispatch: { userId: 'cad-preparation', text, channel: 'voice', continuationContext: buildRecentActionContinuationBridge(text, [], previous), operationMode: 'assistant' } });
    expect(pipeline.turnIntent.flow.preparationRootText).toBe(goal);
    expect(finalizeLumiResponse({ taskText: text, responseText: '完成了', source: 'voice', flow: pipeline.turnIntent.flow, taskId: previous.taskId, requestId: 'cad-2', toolRecords: [tool] }).blocked).toBe(true);
    expect(resolveActiveTaskMessageRelation('先打开计算器', previous).feedback).toBe('new_task');
  });
  it('keeps the unfinished viewing target when changing to a browser and wallpaper', () => {
    const previous = prepareConversationActionTaskState(null, { userText: '我要看蜡笔小新', requestId: 'view-1', toolPolicy: policy, forceTask: true }).state!;
    expect(resolveActiveTaskMessageRelation('你给我打开，用浏览器打开，进入壁纸模式', previous)).toMatchObject({ feedback: 'continue', preservesRootGoal: true });
  });
  it.each(['允许', '重试', '继续'])('preserves executable context for an authorized CAD continuation: %s', text => {
    const previous = prepareConversationActionTaskState(null, { userText: '操作 AutoCAD 完成户型设计', requestId: 'cad-1', toolPolicy: policy, forceTask: true }).state!;
    previous.status = 'blocked';
    const continuationContext = buildRecentActionContinuationBridge(text, [], previous);
    const result = buildLumiExecutionPipeline({ registry, personalityToolPolicy: policy, actionTaskState: previous,
      dispatch: { userId: 'cad-continuation', channel: 'voice', text, continuationContext, operationMode: 'assistant' } });
    expect(result.executionRequested, JSON.stringify({ bridge: continuationContext, trace: result.intentTrace })).toBe(true);
  });
  it.each(['关闭设置', '关闭设置页面'])('never sends a client action into work-side chat: %s', text => {
    expect(classifyVoiceWorkInterruption(text)).toBe('new_work');
  });
  it('excludes runtime excuses from summary recall while keeping user preferences', () => {
    const text = '用户喜欢看蜡笔小新。语音通道只能对话而无法执行实际操作任务。助手遵从关闭语音通道。';
    expect(sanitizeSummaryForPrompt(text)).toBe('用户喜欢看蜡笔小新。');
    expect(buildEvidenceGroundedSummaryTranscript([{ role: 'assistant', message: '当前语音通道只能对话，不能执行操作', toolCalls: [] } as any])).toBe('');
  });
  it.each(['按照这个图片和需求，出一份cad设计方案', '操作autocad完成你的设计'])('executes the actual CAD instruction: %s', text => {
    const result = plan(text);
    expect(result.executionRequested, JSON.stringify({ intent: result.normalizedIntent, trace: result.intentTrace })).toBe(true);
    expect(result.capabilityPlan.taskLedgerRequired).toBe(true);
    expect(result.modelToolProjection.toolNames).toContain('floorplan_extract_geometry');
  });
  it.each(['chat', 'voice'] as const)('can execute a viewing request through %s', channel => {
    expect(plan('我要看蜡笔小新', channel).executionRequested).toBe(true);
  });
  it('does not deliver an invented CAD preview in a tool-free reply', () => {
    const taskText = '操作autocad完成你的设计';
    const responseText = '请查看生成的 CAD 图纸。\n![Lumi CAD Design Preview](C:/Users/Administrator/LumiCore/data/generated/official_image_missing)';
    const result = finalizeLumiResponse({ taskText, responseText, source: 'chat', toolRecords: [], flow: plan(taskText).turnIntent.flow });
    expect(result.blocked).toBe(true);
    expect(result.text).not.toContain('official_image_missing');
  });
});
