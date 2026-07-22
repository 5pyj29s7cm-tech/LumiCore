import { describe, expect, it } from 'vitest';
import {
  buildConversationActionContinuationState,
  buildRecentActionContinuationBridge,
  classifyConversationActionFollowupIntent,
  classifyRecentActionFollowupIntent,
  extractRecentActionContinuationState,
  getRecoveredApplicationContinuationTarget,
  isRecoveredCurrentAppEditingContinuation,
  needsRecentActionContinuationContext,
} from '../server/cognition/action_continuation';

describe('recent action continuation', () => {
  it('recognizes terse and referential continuations without capturing complete new tasks', () => {
    expect(needsRecentActionContinuationContext('执行绘图')).toBe(true);
    expect(needsRecentActionContinuationContext('按照里面的要求继续')).toBe(true);
    expect(needsRecentActionContinuationContext('后台继续这个任务')).toBe(true);
    expect(needsRecentActionContinuationContext('draw it')).toBe(true);
    expect(needsRecentActionContinuationContext('画一只戴帽子的猫')).toBe(false);
    expect(needsRecentActionContinuationContext('你在干嘛')).toBe(true);
    expect(needsRecentActionContinuationContext('结果呢')).toBe(true);
    expect(needsRecentActionContinuationContext('桌面上有一张叫设计草稿的图片，把它画到 AutoCAD 里')).toBe(false);
  });

  it('separates execute pressure from status/why follow-ups', () => {
    expect(needsRecentActionContinuationContext('有没有在执行')).toBe(true);
    expect(needsRecentActionContinuationContext('有没有在执行这个任务')).toBe(true);
    expect(needsRecentActionContinuationContext('为什么没有完成')).toBe(true);
    expect(needsRecentActionContinuationContext('我问你为什么没有完成？你为什么不去执行？')).toBe(true);
    expect(needsRecentActionContinuationContext('我刚刚给你了什么任务')).toBe(true);
    expect(needsRecentActionContinuationContext('快点去执行')).toBe(true);
    expect(needsRecentActionContinuationContext('去呀快点啊')).toBe(true);
    expect(needsRecentActionContinuationContext('你在搞什么东西啊去执行这个任务')).toBe(true);
    expect(classifyRecentActionFollowupIntent('有没有在执行')).toBe('status');
    expect(classifyRecentActionFollowupIntent('怎么回事')).toBe('none');
    expect(classifyRecentActionFollowupIntent('为什么没有完成')).toBe('status');
    expect(classifyRecentActionFollowupIntent('我问你为什么没有完成？你为什么不去执行？')).toBe('status');
    expect(classifyRecentActionFollowupIntent('我让你帮我看下桌面上多少软件你倒是跟我说呀')).toBe('status');
    expect(classifyRecentActionFollowupIntent('快点去执行')).toBe('execute');
    expect(classifyRecentActionFollowupIntent('你在搞什么东西啊去执行这个任务')).toBe('execute');
    expect(classifyRecentActionFollowupIntent('慢个屁')).toBe('execute');
    expect(classifyRecentActionFollowupIntent('别光说，快做')).toBe('execute');
  });

  it('treats an ambiguous failure question as status only for an unfinished durable task', () => {
    const unfinished = buildConversationActionContinuationState({
      userText: '读取桌面平面图并画进 AutoCAD。',
      assistantText: 'AutoCAD 绘制被阻塞。',
      toolCalls: [{
        name: 'cad_draw_floorplan_in_autocad',
        arguments: { sourceName: '平面图' },
        result: JSON.stringify({ status: 'blocked', stage: 'autocad_playback', blocker: 'entity verification failed' }),
      }],
    });
    const completed = { ...unfinished!, status: 'completed' as const, unfinished: false };

    expect(classifyConversationActionFollowupIntent('怎么回事？', unfinished)).toBe('status');
    expect(classifyConversationActionFollowupIntent('怎么回事？', completed)).toBe('none');
    expect(buildRecentActionContinuationBridge('怎么回事？', [], unfinished)).toContain('- followupIntent: status');
  });

  it('keeps the executed source path instead of bulk desktop-list samples', () => {
    const state = extractRecentActionContinuationState([
      { role: 'user', message: '读取桌面上的阿陆平面图画进 AutoCAD。' },
      {
        role: 'assistant',
        message: '正在处理。',
        toolCalls: JSON.stringify([
          {
            name: 'desktop_list_files',
            arguments: { path: '~/Desktop' },
            result: JSON.stringify([
              { path: 'C:\\Users\\me\\Desktop\\unrelated-1.txt' },
              { path: 'C:\\Users\\me\\Desktop\\unrelated-2.png' },
              { path: 'C:\\Users\\me\\Desktop\\阿陆平面图.jpg' },
            ]),
          },
          {
            name: 'floorplan_extract_geometry',
            arguments: { imagePath: 'C:\\Users\\me\\Desktop\\阿陆平面图.jpg' },
            result: JSON.stringify({ status: 'blocked', parseError: 'calibration required' }),
          },
        ]),
      },
    ]);

    expect(state.sourcePaths).toContain('C:\\Users\\me\\Desktop\\阿陆平面图.jpg');
    expect(state.sourcePaths).not.toContain('C:\\Users\\me\\Desktop\\unrelated-1.txt');
  });

  it('keeps a result demand on the latest desktop observation instead of an older WeChat task', () => {
    const history = [
      { role: 'user', message: '\u6253\u5f00\u5fae\u4fe1\u7ed9\u963f\u9646\u53d1\u6d88\u606f\u3002' },
      {
        role: 'assistant',
        message: '\u5fae\u4fe1\u53d1\u9001\u8fd8\u6ca1\u5b8c\u6210\u3002',
        toolCalls: JSON.stringify([{
          name: 'wechat_send_message',
          arguments: { recipient: '\u963f\u9646' },
          error: 'recipient not found',
        }]),
      },
      { role: 'user', message: '\u5e2e\u6211\u770b\u4e0b\u684c\u9762\u4e0a\u6709\u591a\u5c11\u8f6f\u4ef6\u3002' },
      {
        role: 'assistant',
        message: '\u5df2\u7ecf\u67e5\u770b\u4e86\u684c\u9762\u8f6f\u4ef6\u5217\u8868\u3002',
        toolCalls: JSON.stringify([{
          name: 'desktop_list_apps',
          arguments: {},
          result: JSON.stringify([
            { label: 'AutoCAD', path: 'C:\\Program Files\\AutoCAD\\acad.exe' },
            { label: 'WPS Office', path: 'C:\\Program Files\\WPS\\wps.exe' },
          ]),
        }]),
      },
    ];
    const text = '\u6211\u8ba9\u4f60\u5e2e\u6211\u770b\u4e0b\u684c\u9762\u4e0a\u591a\u5c11\u8f6f\u4ef6\u4f60\u5012\u662f\u8ddf\u6211\u8bf4\u5440';
    const bridge = buildRecentActionContinuationBridge(text, history);

    expect(bridge).toContain('- followupIntent: status');
    expect(bridge).toContain('\u5e2e\u6211\u770b\u4e0b\u684c\u9762\u4e0a\u6709\u591a\u5c11\u8f6f\u4ef6');
    expect(bridge).toContain('desktop_list_apps');
    expect(bridge).toContain('items=2');
    expect(bridge).toContain('sample=AutoCAD | WPS Office');
    expect(bridge).not.toContain('\u963f\u9646');
    expect(bridge).not.toContain('wechat_send_message');
  });

  it('continues the latest unfinished action for direct execution pressure', () => {
    const history = [
      { role: 'user', message: '\u628a\u684c\u9762\u7684\u8bbe\u8ba1\u8349\u7a3f.jpg\u753b\u5230 AutoCAD \u91cc\u3002' },
      {
        role: 'assistant',
        message: '\u56fe\u7247\u8bfb\u53d6\u5931\u8d25\uff0c\u5b9e\u9645\u7ed8\u56fe\u8fd8\u6ca1\u6709\u5b8c\u6210\u3002',
        toolCalls: JSON.stringify([{
          name: 'ocr_image_file',
          arguments: { path: 'C:\\Users\\me\\Desktop\\\u8bbe\u8ba1\u8349\u7a3f.jpg' },
          error: 'image decoder failed',
        }]),
      },
    ];

    for (const text of ['\u6162\u4e2a\u5c41', '\u522b\u5149\u8bf4\uff0c\u5feb\u505a']) {
      const bridge = buildRecentActionContinuationBridge(text, history);
      expect(bridge).toContain('- followupIntent: execute');
      expect(bridge).toContain('\u8bbe\u8ba1\u8349\u7a3f.jpg');
      expect(bridge).toContain('AutoCAD');
      expect(bridge).toContain('image decoder failed');
    }
  });

  it('recovers the latest successful opened application for in-app continuation', () => {
    const history = [
      { role: 'user', message: '打开 WPS。' },
      {
        role: 'assistant',
        message: '已打开 WPS。',
        toolCalls: JSON.stringify([{
          name: 'desktop_open',
          arguments: { target: 'WPS' },
          result: JSON.stringify({ ok: true, status: 'opened', target: 'WPS' }),
        }]),
      },
    ];

    expect(needsRecentActionContinuationContext('在这里面写“我好想你”')).toBe(true);
    const state = extractRecentActionContinuationState(history);
    expect(state.appTarget).toBe('WPS');
    expect(state.goal).toContain('打开 WPS');
    const bridge = buildRecentActionContinuationBridge('在这里面写“我好想你”', history);
    expect(bridge).toContain('- followupIntent: execute');
    expect(bridge).toContain('- appTarget: WPS');
    expect(bridge).toContain('active-window and UI typing/control tools');
    expect(bridge).toContain('not a task-center record');
  });

  it('recovers a known current application from a verified active-window receipt', () => {
    const state = extractRecentActionContinuationState([
      { role: 'user', message: '查看当前窗口。' },
      {
        role: 'assistant',
        message: '当前窗口已读取。',
        toolCalls: [{
          name: 'desktop_active_window',
          arguments: {},
          result: JSON.stringify({ ok: true, processName: 'wps.exe', windowTitle: 'WPS 文字' }),
        }],
      },
    ]);

    expect(state.appTarget).toBe('WPS');
  });

  it('keeps a new-document payload inside the recovered WPS application', () => {
    const history = [
      { role: 'user', message: '打开WPS。' },
      {
        role: 'assistant',
        message: '已打开WPS。',
        toolCalls: JSON.stringify([{
          name: 'desktop_open',
          arguments: { target: 'WPS' },
          result: JSON.stringify({
            ok: true,
            status: 'opened',
            processName: 'wps.exe',
            target: 'WPS',
          }),
        }]),
      },
    ];
    const text = '在这里面新建一个空白文档并写入：Lumi端到端回归测试。';
    const bridge = buildRecentActionContinuationBridge(text, history);
    const routeText = `${text}\n\n${bridge}`;

    expect(needsRecentActionContinuationContext(text)).toBe(true);
    expect(classifyRecentActionFollowupIntent(text)).toBe('execute');
    expect(getRecoveredApplicationContinuationTarget(routeText)).toBe('WPS');
    expect(isRecoveredCurrentAppEditingContinuation(routeText)).toBe(true);
  });

  it('keeps the original unfinished CAD goal across repeated pressure follow-ups', () => {
    const history = [
      { role: 'user', message: '把桌面的设计草稿.jpg画到 AutoCAD 里。' },
      {
        role: 'assistant',
        message: '图片读取失败，实际绘图还没有完成。',
        toolCalls: JSON.stringify([{
          name: 'mcp_filesystem_read_media_file',
          arguments: { path: 'C:\\Users\\me\\Desktop\\设计草稿.jpg' },
          error: 'Path is outside allowed directories',
        }]),
      },
      { role: 'user', message: '有没有在执行？' },
      { role: 'assistant', message: '还没有完成。' },
      { role: 'user', message: '为什么没有完成？' },
    ];

    const bridge = buildRecentActionContinuationBridge('我刚刚给你了什么任务', history);
    expect(bridge).toContain('- followupIntent: status');
    expect(bridge).toContain('设计草稿.jpg');
    expect(bridge).toContain('AutoCAD');
    expect(bridge).toContain('mcp_filesystem_read_media_file');
    expect(bridge).toContain('outside allowed directories');

    const whyBridge = buildRecentActionContinuationBridge(
      '\u6211\u95ee\u4f60\u4e3a\u4ec0\u4e48\u6ca1\u6709\u5b8c\u6210\uff1f\u4f60\u4e3a\u4ec0\u4e48\u4e0d\u53bb\u6267\u884c\uff1f',
      history,
    );
    expect(whyBridge).toContain('- followupIntent: status');
    expect(whyBridge).toContain('\u8bbe\u8ba1\u8349\u7a3f.jpg');
    expect(whyBridge).toContain('mcp_filesystem_read_media_file');
    expect(whyBridge).toContain('outside allowed directories');
  });

  it('restores the recent target, application, path, blocker, and tool evidence', () => {
    const bridge = buildRecentActionContinuationBridge('执行绘图', [
      {
        role: 'user',
        message: '读取桌面阿陆文件夹里的户型图，并在 AutoCAD 中实际画出来。',
      },
      {
        role: 'assistant',
        message: '绘图文件已准备，但真实 AutoCAD 回放还没有完成。',
        toolCalls: JSON.stringify([{
          name: 'mcp_cad-drafting_autocad_playback_file',
          arguments: { operationsPath: 'C:\\Users\\me\\Desktop\\阿陆\\LumiCAD\\plan_operations.json' },
          result: JSON.stringify({
            status: 'blocked',
            completionMarkerExists: false,
            completionMarkerPath: 'C:\\Users\\me\\Desktop\\阿陆\\LumiCAD\\plan.done',
          }),
        }]),
      },
    ]);

    expect(bridge).toContain('Recent action continuation context');
    expect(bridge).toContain('阿陆');
    expect(bridge).toContain('AutoCAD');
    expect(bridge).toContain('mcp_cad-drafting_autocad_playback_file');
    expect(bridge).toContain('status=blocked');
    expect(bridge).toContain('plan_operations.json');
    expect(bridge).toContain('Do not reinterpret');
  });

  it('does not invent continuation context when there is no usable history', () => {
    expect(buildRecentActionContinuationBridge('继续', [])).toBe('');
  });

  it('does not turn a guard-blocked conversational exchange into executable continuation', () => {
    const guardText = [
      '我还没有真正开始读取或审查：这一轮没有记录到成功的工具执行。',
      '现在能确认的是：这次只是生成了文字回复，没有实际读到文件内容。',
      '下一步需要先拿到可读取的文件或位置。',
    ].join('\n');
    const markedHistory = [
      { role: 'user', message: '你对目前自己的能力是否满意' },
      {
        role: 'assistant',
        message: guardText,
        cognitiveIntent: 'work_product_guard',
        toolCalls: [{
          name: 'desktop_open',
          result: JSON.stringify({ ok: true, status: 'opened', target: 'WPS' }),
        }],
      },
    ];
    const legacyHistory = markedHistory.map(({ cognitiveIntent: _ignored, ...item }) => item);

    for (const history of [markedHistory, legacyHistory]) {
      expect(buildRecentActionContinuationBridge('继续', history)).toBe('');
      expect(buildRecentActionContinuationBridge('回答我', history)).toBe('');
      const state = extractRecentActionContinuationState(history);
      expect(state.evidenceTools).toEqual([]);
      expect(state.appTarget).toBe('');
      expect(state.unfinished).toBe(false);
    }
  });

  it('still continues a real external action goal while excluding its guard response', () => {
    const guardText = [
      '我还没有拿到可确认的桌面动作结果：这一轮没有成功执行任何工具。',
      '现在能确认的是：这一轮还没有成功的桌面打开、聚焦或进程验证记录。',
    ].join('\n');
    const bridge = buildRecentActionContinuationBridge('继续', [
      { role: 'user', message: '打开 AutoCAD' },
      {
        role: 'assistant',
        message: guardText,
        cognitiveIntent: 'work_product_guard',
      },
    ]);

    expect(bridge).toContain('- followupIntent: execute');
    expect(bridge).toContain('- originalGoal: 打开 AutoCAD');
    expect(bridge).not.toContain(guardText);
    expect(bridge).not.toContain('还没有成功的桌面打开');
  });

  it('restores an evidence-backed task from persisted conversation state without recent history', () => {
    const opened = buildConversationActionContinuationState({
      userText: '打开 WPS。',
      assistantText: '已打开 WPS。',
      toolCalls: [{
        name: 'desktop_open',
        arguments: { target: 'WPS' },
        result: JSON.stringify({ ok: true, status: 'opened', target: 'WPS' }),
      }],
      updatedAt: '2026-07-17T10:00:00.000Z',
      evidenceMessageId: 'msg-open-wps',
    });

    expect(opened).toMatchObject({
      goal: '打开 WPS。',
      latestInstruction: '打开 WPS。',
      appTarget: 'WPS',
      unfinished: false,
      evidenceTools: ['desktop_open'],
      evidenceMessageId: 'msg-open-wps',
    });

    const bridge = buildRecentActionContinuationBridge(
      '在这里面写“我好想你”',
      [],
      opened,
    );
    expect(bridge).toContain('- originalGoal: 打开 WPS。');
    expect(bridge).toContain('- latestInstruction: 打开 WPS。');
    expect(bridge).toContain('- appTarget: WPS');
    expect(bridge).toContain('desktop_open');
    expect(bridge).toContain('conversation-scoped persisted execution state');
  });

  it('advances the same persisted task on execute follow-ups but does not let status turns replace its goal', () => {
    const opened = buildConversationActionContinuationState({
      userText: '打开 WPS。',
      assistantText: '已打开 WPS。',
      toolCalls: [{
        name: 'desktop_open',
        arguments: { target: 'WPS' },
        result: JSON.stringify({ ok: true, status: 'opened', target: 'WPS' }),
      }],
    });
    const written = buildConversationActionContinuationState({
      previous: opened,
      userText: '在这里面写“我好想你”',
      assistantText: '已在当前 WPS 文档中写入。',
      toolCalls: [{
        name: 'wps_create_document',
        arguments: { text: '我好想你' },
        result: JSON.stringify({ ok: true, status: 'completed' }),
      }],
    });
    const checked = buildConversationActionContinuationState({
      previous: written,
      userText: '完成了吗？',
      assistantText: '检查时窗口读取失败，不能确认。',
      toolCalls: [{
        name: 'desktop_active_window',
        arguments: {},
        error: 'window unavailable',
      }],
    });

    expect(written).toMatchObject({
      goal: '打开 WPS。',
      latestInstruction: '在这里面写“我好想你”',
      appTarget: 'WPS',
      unfinished: false,
    });
    expect(written?.evidenceTools).toEqual(['desktop_open', 'wps_create_document']);
    expect(checked).toMatchObject({
      goal: '打开 WPS。',
      latestInstruction: '在这里面写“我好想你”',
      appTarget: 'WPS',
      unfinished: true,
    });
    expect(checked?.latestBlocker).toContain('window unavailable');
  });

  it('does not treat a structured ok=false receipt as successful continuation evidence', () => {
    const state = buildConversationActionContinuationState({
      userText: '把文件写到桌面。',
      assistantText: '工具返回了结果。',
      toolCalls: [{
        name: 'write_file',
        arguments: { path: 'C:\\Users\\me\\Desktop\\result.txt' },
        result: JSON.stringify({ ok: false, reason: 'write verification failed' }),
      }],
    });

    expect(state).toMatchObject({ unfinished: true });
    expect(state?.latestBlocker).toContain('write verification failed');
  });

  it('drops a superseded execution branch after the user corrects the task', () => {
    const bridge = buildRecentActionContinuationBridge('继续', [
      { role: 'user', message: '在 AutoCAD 里画户型图。' },
      {
        role: 'assistant',
        message: '生成了六张业务图表。',
        toolCalls: JSON.stringify([{ name: 'python_exec', result: 'sales_dashboard.png' }]),
      },
      { role: 'user', message: '不是数据图，读取阿陆文件夹并在 AutoCAD 里画出来。' },
      {
        role: 'assistant',
        message: 'AutoCAD 实际绘图仍被完成标记阻塞。',
        toolCalls: JSON.stringify([{
          name: 'mcp_cad-drafting_autocad_playback_file',
          result: JSON.stringify({ status: 'blocked', completionMarkerExists: false }),
        }]),
      },
    ]);

    expect(bridge).toContain('mcp_cad-drafting_autocad_playback_file');
    expect(bridge).toContain('status=blocked');
    expect(bridge).not.toContain('python_exec');
    expect(bridge).not.toContain('六张业务图表');
  });
});
