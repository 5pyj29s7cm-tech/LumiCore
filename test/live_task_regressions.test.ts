import './helpers';
import { describe, expect, it } from 'vitest';
import { normalizeActionIntent } from '../server/cognition/normalized_action_intent';
import { classifyConversationActionFollowupIntent } from '../server/cognition/action_continuation';
import { resolveActiveTaskMessageRelation } from '../server/cognition/task_concurrency';
import { buildTaskTargetAnchorProjection } from '../server/conversation/task_target_anchor';
import { buildActionContract, documentReadMatchesRequestedTarget, hasMediaPlaybackEvidence, hasCoreActionEvidence, hasRequestedDesktopOpenEvidence, browserSessionObservation, requiresMediaPlaybackAction } from '../server/cognition/action_contract';
import { finalizeLumiResponse, tryFinalizeVerifiedBoundedAction } from '../server/cognition/result_finalizer';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { guardCompletionClaims } from '../server/work_product/completion_guard';
import { buildForegroundTaskCompletionFeedback } from '../server/cognition/acceptance_evidence';
import { prepareLocalModelRequest } from '../server/llm/local_context_budget';
import { isCurrentClientDiagnosticRequest } from '../server/cognition/tool_intent';
import { formatClientDiagnosticResult } from '../server/cognition/client_diagnostic_result';
import type { ConversationActionContinuationState } from '../server/cognition/action_continuation';
import type { ToolExecutionRecord } from '../server/tools/types';

const verified = { status: 'verified' as const, strategy: 'terminal_receipt' as const, reason: 'Synthetic regression receipt.' };
const fileTask: ConversationActionContinuationState = {
  version: 2, taskId: 'test-file-task', status: 'blocked', goal: '生成 D:/test/source.xlsx 采购报表', latestInstruction: '生成采购报表',
  appTarget: 'WPS', sourcePaths: ['D:/test/source.xlsx'], latestBlocker: '', unfinished: true,
  evidenceTools: ['create_xlsx'], assistantState: '', toolSummaries: [], revision: 1, updatedAt: new Date().toISOString(),
};

describe('regressions from the two live task rounds', () => {
  it('reports a fresh player observation without imposing forbidden playback actions', () => {
    const task = '先不要再操作播放器。只查看当前网易云音乐窗口，告诉我当前歌曲和歌手、暂停还是播放状态，以及底部显示的已播放时间和总时长；看不清的项目明确说明。';
    const response = '网易云音乐当前歌曲是金玉良缘，歌手李琦。控制栏显示暂停按钮；时间数字看不清。';
    const scope = { requestId: 'observe-request', taskId: 'observe-task' };
    const record = { ...scope, name: 'ocr_screen', arguments: {}, result: JSON.stringify({ status: 'observed', description: response }), terminalVerification: verified };
    expect(requiresMediaPlaybackAction(task)).toBe(false);
    const input = { ...scope, taskText: task, responseText: '尚未开始执行。', source: 'chat', toolRecords: [record] };
    expect(finalizeLumiResponse(input)).toMatchObject({ blocked: false, text: response });
    expect(tryFinalizeVerifiedBoundedAction(input)).toMatchObject({ blocked: false, text: response });
    expect(tryFinalizeVerifiedBoundedAction({ ...input, toolRecords: [{ ...record, requestId: 'old-request' }] })).toBeNull();
    expect(tryFinalizeVerifiedBoundedAction({ ...input, toolRecords: [{ ...record, result: JSON.stringify({ status: 'observed', description: '' }) }] })).toBeNull();
    expect(tryFinalizeVerifiedBoundedAction({ ...input, taskText: task + '再计算总时长。' })).toBeNull();
    expect(tryFinalizeVerifiedBoundedAction({ ...input, taskText: '播放网易云音乐的十年。' })).toBeNull();
  });
  it('delivers an observed logged-out browser state without claiming login or completing extra work', () => {
    const task = '用 Google Chrome 打开 https://www.douyin.com/，检查之前保存的登录是否有效，不发消息、不点赞。';
    const scope = { requestId: 'browser-r', taskId: 'browser-t', terminalVerification: verified };
    const launch = { ...scope, name: 'browser_open_task', arguments: { url: 'https://www.douyin.com/' }, result: JSON.stringify({ target: 'https://www.douyin.com/', opened: true, status: 'launched' }) };
    const observation = { ...scope, name: 'ocr_screen', arguments: {}, result: '当前 douyin.com 页面右上角有登录按钮，当前未登录，没有扫码弹窗。' };
    const records = [launch, observation];
    expect(browserSessionObservation(records, task)).toBe(observation.result);
    expect(tryFinalizeVerifiedBoundedAction({ ...scope, taskText: task, responseText: '', source: 'test', toolRecords: records })).toMatchObject({ blocked: false, text: observation.result });
    expect(browserSessionObservation([observation, launch], task)).toBeNull();
    expect(browserSessionObservation([launch, { ...observation, result: '其他页面显示登录按钮。' }], task)).toBeNull();
    expect(browserSessionObservation(records, task + '然后生成检查报告文件。')).toBeNull();
    expect(browserSessionObservation([launch], task)).toBeNull();
    const detailedObservation = { ...observation, result: [
      '**页面地址**：douyin.com/jingxuan',
      '**顶部区域**：右上角红色按钮：「登录」',
      '## 登录状态判断',
      '**结论：当前为「未登录」状态。**',
      '因此，该抖音页面处于需要登录的状态。',
    ].join('\n\n') };
    const summary = browserSessionObservation([launch, detailedObservation], task);
    expect(summary).toMatch(/^\*\*结论：当前为「未登录」状态/);
    expect(summary).not.toContain('## 登录状态判断');
    expect(summary).not.toContain('顶部区域');
    const nativeLaunch = { ...launch, name: 'desktop_open', arguments: { target: launch.arguments.url }, result: JSON.stringify({ target: launch.arguments.url, targetMatched: true, actualTarget: { processName: 'chrome.exe' } }) };
    expect(browserSessionObservation([nativeLaunch, observation], task)).toBe(observation.result);
    expect(browserSessionObservation([{ ...nativeLaunch, result: nativeLaunch.result.replace('chrome.exe', 'notepad.exe') }, observation], task)).toBeNull();
  });
  it.each(['run', '发送', '分析', 'copy'])('finishes a spreadsheet under a %s folder without treating its name as another action', folderName => {
    const dir = mkdtempSync(path.join(os.tmpdir(), `lumi-${folderName}-sheet-`));
    const file = path.join(dir, 'report.xlsx'); writeFileSync(file, 'synthetic receipt fixture');
    try {
      const scope = { requestId: 'sheet-r', taskId: 'sheet-t', terminalVerification: verified };
      const producer = { ...scope, name: 'create_xlsx', arguments: { outputPath: file }, result: JSON.stringify({ ok: true, status: 'created', path: file, size: 25, formulaCount: 4, chartCount: 1, unresolvedFormulas: [], calculatedCells: [{ sheet: '采购表', cell: 'D5', label: '总计', value: 1170 }] }) };
      const opened = { ...scope, name: 'desktop_open', arguments: { target: file }, result: JSON.stringify({ ok: true, status: 'verified', target: file, targetMatched: true, verificationBasis: 'post_open_foreground', actualTarget: { title: 'report.xlsx - WPS Office', processName: 'wps.exe' } }) };
      const input = { ...scope, taskText: `生成采购表 ${file}，金额使用公式，添加柱状图，在 WPS 打开并告诉我总金额。`, responseText: '', source: 'test', toolRecords: [producer, opened] };
      const result = tryFinalizeVerifiedBoundedAction(input);
      expect(result?.blocked, JSON.stringify({ contract: buildActionContract(input.taskText).kind, core: hasCoreActionEvidence(buildActionContract(input.taskText), input.toolRecords, input.taskText, undefined, scope), opened: hasRequestedDesktopOpenEvidence(input.toolRecords, input.taskText, file) })).toBe(false); expect(result?.text).toContain('总计: 1170');
      expect(tryFinalizeVerifiedBoundedAction({ ...input, toolRecords: [producer] })).toBeNull();
      expect(hasRequestedDesktopOpenEvidence([opened], input.taskText, path.join(dir, 'other', 'report.xlsx'))).toBe(false);
      expect(hasRequestedDesktopOpenEvidence([{ ...opened, result: opened.result.replace('report.xlsx - WPS', 'other-report.xlsx - WPS') }], input.taskText, file)).toBe(false);
      expect(tryFinalizeVerifiedBoundedAction({ ...input, toolRecords: [{ ...producer, result: producer.result.replace('"chartCount":1', '"chartCount":0') }, opened] })).toBeNull();
      expect(tryFinalizeVerifiedBoundedAction({ ...input, taskText: input.taskText + '另外分析供应商风险。' })).toBeNull();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it('recognizes a browser launch receipt without upgrading it to a verified login', () => {
    const result = guardCompletionClaims({ task: '打开 https://www.douyin.com/，检查登录状态。', response: '已打开 https://www.douyin.com/，但还没有确认登录状态。', toolCalls: [{ name: 'browser_open_task', arguments: { url: 'https://www.douyin.com/', open: true }, result: JSON.stringify({ opened: true, status: 'launched', target: 'https://www.douyin.com/', loginVerified: false }), terminalVerification: verified }] } as any);
    expect(result.blocked).toBe(false);
    expect(result.reason || '').not.toContain('没有成功的打开');
  });
  it('does not turn a browser login check into message reading because of a hostname or prohibition', () => {
    expect(normalizeActionIntent('用 Google Chrome 打开 https://www.douyin.com/，检查之前保存的登录是否有效。只查看登录状态，不发消息、不点赞。').kind).not.toBe('messaging_read');
    expect(buildActionContract('用 Google Chrome 打开 https://www.douyin.com/，检查之前保存的登录是否有效。只查看登录状态，不发消息、不点赞。').kind).toBe('browser_account');
    expect(buildActionContract('用 Google Chrome 打开 https://chat.deepseek.com/，检查已有登录状态，不要发送对话。').kind).toBe('browser_account');
  });
  it('binds generic attachment reads to current upload paths without trusting similarly named files', () => {
    const record = { name: 'read_file', arguments: { path: 'C:/uploads/list.csv' }, result: 'actual contents', terminalVerification: verified } as ToolExecutionRecord;
    expect(documentReadMatchesRequestedTarget(record, '根据附件计算金额', undefined, ['C:/uploads/list.csv'])).toBe(true);
    expect(documentReadMatchesRequestedTarget(record, '根据附件计算金额', undefined, ['D:/other/list.csv'])).toBe(false);
    expect(documentReadMatchesRequestedTarget(record, '读取 D:/other/list.csv 附件', undefined, ['C:/uploads/list.csv'])).toBe(false);
    const task = '根据附件列出数量和总金额，也先不要生成新文件。';
    const target = buildTaskTargetAnchorProjection({ taskText: task, sourcePaths: ['C:/uploads/list.csv'] }).target;
    const result = finalizeLumiResponse({ taskText: task, responseText: 'A类3件，金额360，总金额1000。', source: 'chat', toolRecords: [record], flow: { channel: 'text', currentAttachmentPaths: ['C:/uploads/list.csv'], acceptedTaskTarget: { target, source: 'current_turn', sourceId: 'upload-turn' } } as any });
    expect(result.blocked).toBe(false);
    expect(result.text).toContain('1000');
  });
  it('preserves a calculated Markdown table on an other-values-unchanged followup', () => {
    const response = '按调整后的数量：\n\n| 品类 | 金额 |\n| --- | --- |\n| A | 360 |\n| B | 510 |\n| C | 300 |\n\n总金额：1170。';
    expect(finalizeLumiResponse({ taskText: 'B类数量改成6，其他不变，只回答金额。', responseText: response, source: 'chat', toolRecords: [] }).text).toBe(response);
  });
  it.each(['https://chat.deepseek.com/', 'https://example.com/chat', 'https://example.com/files'])('keeps an opened URL external: %s', url => {
    const text = `用 Google Chrome 打开 ${url} 这个网址，检查已有登录状态。只打开网页，不要打开同名的本地文件，也不要发送对话。`;
    expect(normalizeActionIntent(text)).toMatchObject({ kind: 'desktop_operation', operation: 'navigate', target: url });
    expect(classifyConversationActionFollowupIntent(text, fileTask)).toBe('none');
    expect(resolveActiveTaskMessageRelation(text, fileTask).taskRelation).toBe('new');
  });

  it('continues a blocked file edit and verifies its input separately from save-as output', () => {
    const text = '把刚才报表的 B类数量改成6，其余不变，另存到 D:/test/updated.xlsx，检查公式和图表，并告诉我新总金额。';
    expect(classifyConversationActionFollowupIntent(text, fileTask)).toBe('execute');
    expect(resolveActiveTaskMessageRelation(text, fileTask).taskRelation).toBe('correct');
    const accepted = { target: buildTaskTargetAnchorProjection({ taskText: fileTask.goal, sourcePaths: fileTask.sourcePaths }).target,
      source: 'prior_tool_receipt' as const, sourceId: 'synthetic-create-receipt' };
    expect(documentReadMatchesRequestedTarget({ name: 'read_xlsx', arguments: { filePath: 'D:/test/source.xlsx' },
      result: 'item,qty\nB,4', terminalVerification: verified }, text, accepted)).toBe(true);
    expect(documentReadMatchesRequestedTarget({ name: 'read_xlsx', arguments: { filePath: 'D:/other/source.xlsx' },
      result: 'item,qty\nB,4', terminalVerification: verified }, text, accepted)).toBe(false);
    expect(resolveActiveTaskMessageRelation('用 WPS 新建 D:/test/meeting.docx，写一份会议安排。', {
      ...fileTask, goal: '在网易云音乐播放孤勇者', sourcePaths: [],
    }).taskRelation).toBe('new');
  });

  it('does not treat a path containing LumiCore as a request to diagnose the client', () => {
    const task = '把刚才报表的 B类数量改成6，其余不变，另存到 D:/LumiCore-Audit-Reports/采购报表_更新.xlsx，检查公式和图表，并告诉我新总金额。';
    expect(isCurrentClientDiagnosticRequest(task)).toBe(false);
    expect(formatClientDiagnosticResult([], task, '新总金额1170元。')).toBeNull();
    expect(isCurrentClientDiagnosticRequest('检查 Lumi 客户端的运行状态。')).toBe(true);
  });

  it('retains target-player evidence when a later observation sees a different application', () => {
    const task = '在网易云音乐播放《孤勇者》';
    const records: ToolExecutionRecord[] = [{ name: 'desktop_ui_snapshot', arguments: {},
      result: JSON.stringify({ player: '网易云音乐', playerState: 'playing', currentTrack: { title: '孤勇者' } }),
      requestId: 'r', taskId: 't', terminalVerification: verified }, { name: 'ocr_screen', arguments: {},
      result: JSON.stringify({ process_name: 'Code.exe', title: 'Visual Studio Code', playerState: 'paused' }),
      requestId: 'r', taskId: 't', terminalVerification: verified }];
    expect(hasMediaPlaybackEvidence(records, task, { requestId: 'r', taskId: 't' })).toBe(true);
    expect(hasMediaPlaybackEvidence([...records, { ...records[0], result: JSON.stringify({ player: '网易云音乐', playerState: 'paused' }) }], task, { requestId: 'r', taskId: 't' })).toBe(false);
    expect(buildForegroundTaskCompletionFeedback({ taskId: 't', taskLabel: task, toolRecords: [records[1]] })?.status).toBe('blocked');
  });

  it('does not mark a file with missing formulas/chart as complete', () => {
    const task = '生成采购报表 D:/test/report.xlsx，金额使用公式，添加柱状图。';
    const records: ToolExecutionRecord[] = [{ name: 'create_xlsx', arguments: {}, terminalVerification: verified,
      result: JSON.stringify({ ok: true, path: 'D:/test/report.xlsx', formulaCount: 0, chartCount: 0, unresolvedFormulas: [] }) }];
    expect(finalizeLumiResponse({ taskText: task, responseText: '全部完成。', source: 'chat', toolRecords: records }))
      .toMatchObject({ blocked: true, reason: 'artifact_step_pending:repair_workbook' });
    expect(buildForegroundTaskCompletionFeedback({ taskId: 't', taskLabel: task, toolRecords: records })?.status).toBe('blocked');
  });

  it('uses a bounded working prompt even when the local runtime loads 32k context', () => {
    const request = prepareLocalModelRequest({ contextTokens: 32768, messages: [
      { role: 'system', content: 'execution policy '.repeat(3500) },
      { role: 'user', content: '请读取已上传的采购清单并计算总金额。' },
    ], toolDeclarations: [], compactToolDeclarations: true });
    expect(request.contextTokens).toBe(32768);
    expect(request.estimatedInputTokens).toBeLessThanOrEqual(6144);
    expect(request.compacted).toBe(true);
    expect(request.messages.at(-1)?.content).toBe('请读取已上传的采购清单并计算总金额。');
  });
});
