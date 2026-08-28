import { describe, expect, it } from 'vitest';
import {
  hasMixedStatusExecutionIntent,
  isExplicitArtifactCreationText,
  isImmediateAssistantRestatementRequest,
  isPriorTurnToolReceiptQuestion,
  normalizeActionIntent,
} from '../server/cognition/normalized_action_intent';
import {
  buildDeterministicClientNavigationCommand,
  buildDeterministicExternalCommitConfirmationCommand,
  buildDeterministicKnowledgeInspectionCommand,
  buildDeterministicLocalDesktopNavigationCommand,
  buildDeterministicWpsDocumentCommand,
  buildDeterministicTextArtifactCommand,
  buildDeterministicWorkTaskCreateCommand,
  buildDeterministicWorkTaskProgressCommand,
  buildDeterministicWorkTaskStatusCommand,
} from '../server/cognition/quick_commands';

describe('normalized desktop intent priority', () => {
  it.each([
    '重新说',
    '再说一遍',
    '重复一次',
    'repeat that',
    'say that again',
  ])('recognizes an unqualified adjacent-assistant repeat: %s', (text) => {
    expect(isImmediateAssistantRestatementRequest(text)).toBe(true);
  });

  it.each([
    '再说',
    '重新说一下青穹任务现在的状态',
    '请重复执行刚才的任务',
    '重复检查一次壁纸状态',
  ])('does not steal a qualified task or status request as assistant repeat: %s', (text) => {
    expect(isImmediateAssistantRestatementRequest(text)).toBe(false);
  });

  it('routes an enumerated persistent-task execution request to the shared planner', () => {
    const text = '\u7ee7\u7eed\u521a\u624d\u7684\u6301\u4e45\u4efb\u52a1\u201c\u4e3b\u7a0b\u5e8f\u6587\u5b57\u957f\u4efb\u52a1-20260818\u201d\uff08\u4efb\u52a1\u7f16\u53f7 wt_task_1787031027377_c8a3v\uff09\uff1a\u5b8c\u6210\u7b2c\u4e00\u6b65\u201c\u8bb0\u5f55\u9a8c\u6536\u9700\u6c42\u201d\u548c\u7b2c\u4e8c\u6b65\u201c\u5728\u804a\u5929\u4e2d\u751f\u6210\u4e94\u9879\u68c0\u67e5\u6e05\u5355\u201d\uff1b\u7b2c\u4e09\u6b65\u4ecd\u4fdd\u6301\u7b49\u5f85\u786e\u8ba4\u3002\u4e0d\u8981\u5199\u6587\u4ef6\uff0c\u4e0d\u8981\u5916\u53d1\u3002';
    const command = buildDeterministicWorkTaskProgressCommand(text);
    expect(command).toMatchObject({ matched: false, responseText: '' });
    expect(command?.toolCall).toBeUndefined();
    expect(buildDeterministicWorkTaskStatusCommand(text)).toBeNull();
  });

  it('keeps an explicit bookkeeping-only task note on the deterministic ledger lane', () => {
    const command = buildDeterministicWorkTaskProgressCommand(
      '\u6301\u4e45\u4efb\u52a1 wt_task_acceptance\uff1a\u53ea\u628a\u4ee5\u4e0b\u5907\u6ce8\u5199\u5165\u4efb\u52a1\u8d26\u672c\uff0c\u4e0d\u8981\u6267\u884c\u6216\u63a8\u8fdb\u4efb\u4f55\u6b65\u9aa4\uff0c\u4e0d\u4fee\u6539\u5f53\u524d\u72b6\u6001\u3002\u5907\u6ce8\uff1a\u5ba2\u6237\u8d44\u6599\u5df2\u7531\u7528\u6237\u8865\u9f50\uff0c\u7b49\u5f85\u4e0b\u4e00\u8f6e\u6267\u884c\u3002',
    );
    expect(command).toMatchObject({
      matched: true,
      toolCall: {
        name: 'work_takeover_task_update',
        arguments: {
          id: 'wt_task_acceptance',
          note: '\u5ba2\u6237\u8d44\u6599\u5df2\u7531\u7528\u6237\u8865\u9f50\uff0c\u7b49\u5f85\u4e0b\u4e00\u8f6e\u6267\u884c\u3002',
        },
      },
    });
    expect(command?.toolCall?.arguments).not.toHaveProperty('currentActionIndex');
    expect(command?.toolCall?.arguments).not.toHaveProperty('status');
    expect(command?.toolCall?.arguments).not.toHaveProperty('result');
    const response = command?.formatToolResult?.(JSON.stringify({
      persisted: true,
      task: {
        id: 'wt_task_acceptance',
        status: 'in_progress',
        currentActionIndex: 0,
        nextActions: ['\u6574\u7406\u5ba2\u6237\u9700\u6c42', '\u751f\u6210\u8ddf\u8fdb\u8349\u7a3f'],
      },
    }));
    expect(response).toContain('\u5907\u6ce8\u5df2\u6301\u4e45\u5316');
    expect(response).toContain('\u672a\u6267\u884c\u4efb\u52a1\u6b65\u9aa4');
    expect(response).toContain('\u5f53\u524d\u6b65\u9aa4\uff1a\u6574\u7406\u5ba2\u6237\u9700\u6c42');
  });

  it('creates a new persistent work task instead of inheriting an older receipt', () => {
    const text = '\u4e3b\u7a0b\u5e8f\u957f\u4efb\u52a1\u9a8c\u6536\uff1a\u8bf7\u521b\u5efa\u4e00\u4e2a\u53ef\u8de8\u91cd\u542f\u7ee7\u7eed\u7684\u6301\u4e45\u4efb\u52a1\u3002\u6807\u9898\u201c\u9752\u7a79\u5ba2\u6237\u8ddf\u8fdb\u95ed\u73af\u201d\uff0c\u7c7b\u522b customer\uff0c\u6765\u6e90 chat\u3002\u76ee\u6807\u662f\uff1a\u7b2c\u4e00\u6b65\u6574\u7406\u5ba2\u6237\u9700\u6c42\uff0c\u7b2c\u4e8c\u6b65\u751f\u6210\u8ddf\u8fdb\u8349\u7a3f\uff0c\u7b2c\u4e09\u6b65\u7b49\u5f85\u7528\u6237\u786e\u8ba4\u540e\u518d\u5916\u53d1\u3002\u73b0\u5728\u53ea\u521b\u5efa\u5e76\u6301\u4e45\u5316\u4efb\u52a1\uff0c\u4e0d\u8981\u53d1\u9001\u4efb\u4f55\u6d88\u606f\u3002\u5b8c\u6210\u540e\u544a\u8bc9\u6211\u4efb\u52a1\u7f16\u53f7\u3001\u72b6\u6001\u3001\u4e0b\u4e00\u6b65\u548c\u54ea\u4e9b\u52a8\u4f5c\u9700\u8981\u786e\u8ba4\u3002';
    expect(normalizeActionIntent(text)).toMatchObject({
      kind: 'work_task',
      operation: 'create',
      target: '\u9752\u7a79\u5ba2\u6237\u8ddf\u8fdb\u95ed\u73af',
      sideEffectClass: 'local_write',
      relation: 'new',
    });
    const command = buildDeterministicWorkTaskCreateCommand(text);
    expect(command?.toolCall).toMatchObject({
      name: 'work_takeover_task_create',
      arguments: {
        title: '\u9752\u7a79\u5ba2\u6237\u8ddf\u8fdb\u95ed\u73af',
        category: 'customer',
        source: 'chat',
        nextActions: [
          '\u6574\u7406\u5ba2\u6237\u9700\u6c42',
          '\u751f\u6210\u8ddf\u8fdb\u8349\u7a3f',
          '\u7b49\u5f85\u7528\u6237\u786e\u8ba4\u540e\u518d\u5916\u53d1',
        ],
        confirmationRequired: ['\u7b49\u5f85\u7528\u6237\u786e\u8ba4\u540e\u518d\u5916\u53d1'],
      },
    });
    const response = command?.formatToolResult?.(JSON.stringify({
      ok: true,
      status: 'created',
      persisted: true,
      task: {
        id: 'takeover_123',
        status: 'queued',
        nextActions: command?.toolCall?.arguments.nextActions,
        confirmationRequired: command?.toolCall?.arguments.confirmationRequired,
      },
    }));
    expect(response).toContain('\u4efb\u52a1\u7f16\u53f7\uff1atakeover_123');
    expect(response).toContain('\u5df2\u521b\u5efa\u5e76\u6301\u4e45\u5316');
    expect(response).toContain('\u9700\u8981\u786e\u8ba4\uff1a\u7b49\u5f85\u7528\u6237\u786e\u8ba4\u540e\u518d\u5916\u53d1');
  });

  it('uses the Chinese task-name field as the persistent task title', () => {
    const text = '\u8bf7\u521b\u5efa\u4e00\u4e2a\u6301\u4e45\u4efb\u52a1\uff0c\u4efb\u52a1\u540d\u201c\u4e3b\u7a0b\u5e8f\u6587\u5b57\u957f\u4efb\u52a1-20260818\u201d\uff0c\u7c7b\u522b\uff1a\u901a\u7528\u3002';
    expect(normalizeActionIntent(text)).toMatchObject({
      kind: 'work_task',
      operation: 'create',
      target: '\u4e3b\u7a0b\u5e8f\u6587\u5b57\u957f\u4efb\u52a1-20260818',
    });
    expect(buildDeterministicWorkTaskCreateCommand(text)?.toolCall?.arguments.title)
      .toBe('\u4e3b\u7a0b\u5e8f\u6587\u5b57\u957f\u4efb\u52a1-20260818');
  });

  it('queries an explicitly named persistent task instead of the older conversation action ledger', () => {
    const text = '主程序任务状态验收：请查询任务“青穹客户跟进闭环”的持久状态，只根据任务账本回答任务编号、当前状态、当前步骤、后续步骤和确认边界，不要执行任何外部动作。';
    const command = buildDeterministicWorkTaskStatusCommand(text);
    expect(command?.toolCall).toEqual({
      name: 'work_takeover_task_list',
      arguments: { limit: 200 },
    });
    const response = command?.formatToolResult?.(JSON.stringify({
      tasks: [{
        id: 'wt_task_acceptance',
        title: '青穹客户跟进闭环',
        status: 'in_progress',
        currentActionIndex: 0,
        nextActions: ['整理客户需求', '生成跟进草稿', '等待用户确认后再外发'],
        confirmationRequired: ['等待用户确认后再外发'],
      }],
    }));
    expect(response).toContain('任务编号：wt_task_acceptance');
    expect(response).toContain('当前步骤：整理客户需求');
    expect(response).toContain('后续步骤：生成跟进草稿→等待用户确认后再外发');
    expect(response).toContain('确认边界：等待用户确认后再外发');
  });

  it('keeps an explicit id-based status query read-only even when it says not to execute', () => {
    const text = '\u8bf7\u67e5\u8be2\u6301\u4e45\u4efb\u52a1 wt_task_acceptance \u7684\u72b6\u6001\u548c\u8fdb\u5ea6\uff0c\u53ea\u8bfb\u4efb\u52a1\u8d26\u672c\uff0c\u4e0d\u8981\u6267\u884c\u6216\u63a8\u8fdb\u4efb\u4f55\u6b65\u9aa4\u3002';
    expect(buildDeterministicWorkTaskProgressCommand(text)).toBeNull();
    const command = buildDeterministicWorkTaskStatusCommand(text);
    expect(command?.toolCall).toEqual({
      name: 'work_takeover_task_get',
      arguments: { id: 'wt_task_acceptance' },
    });
    expect(command?.formatToolResult?.(JSON.stringify({
      task: {
        id: 'wt_task_acceptance',
        status: 'in_progress',
        currentActionIndex: 1,
        nextActions: ['\u6574\u7406\u5ba2\u6237\u9700\u6c42', '\u751f\u6210\u8ddf\u8fdb\u8349\u7a3f'],
      },
    }))).toContain('\u5f53\u524d\u6b65\u9aa4\uff1a\u751f\u6210\u8ddf\u8fdb\u8349\u7a3f');
  });

  it('treats whether a persistent task is complete as a read-only status question', () => {
    const text = '请查询持久任务 wt_task_acceptance 是否完成和当前状态，只读任务账本，不要执行新动作。';
    expect(buildDeterministicWorkTaskProgressCommand(text)).toBeNull();
    expect(buildDeterministicWorkTaskStatusCommand(text)?.toolCall).toEqual({
      name: 'work_takeover_task_get',
      arguments: { id: 'wt_task_acceptance' },
    });
  });

  it('keeps affirmative step execution after a separate no-external-action clause', () => {
    const text = '持久任务 wt_task_acceptance：不要执行外发动作；现在完成第一步“整理客户需求”，然后返回状态。';
    expect(buildDeterministicWorkTaskProgressCommand(text)).toMatchObject({
      matched: false,
      responseText: '',
    });
    expect(buildDeterministicWorkTaskStatusCommand(text)).toBeNull();
  });

  it('does not let a requested status receipt shadow an explicit task progress update', () => {
    const text = '续接持久任务“主程序文字长任务-20260818-2031” wt_task_acceptance：完成第一步“整理三项能力”，给出五项检查清单；不要写文件，不要外发；第三步等待我确认。请把进度写回同一任务账本并返回当前状态与剩余步骤。';
    expect(buildDeterministicWorkTaskProgressCommand(text)).toMatchObject({ matched: false });
    expect(buildDeterministicWorkTaskStatusCommand(text)).toBeNull();
  });

  it('builds an exact write then readback chain for enumerated local text lines', () => {
    const text = '请在 C:\\Users\\test-user\\Documents\\Lumi主程序实机验收_20260817.txt 新建一个 TXT 文件，只写入以下三行：第一行“验收对象：Lumi 主程序”；第二行“验收项目：本地文件创建与回读”；第三行“验收代号：青穹-17”。写入后必须重新读取。';
    const command = buildDeterministicTextArtifactCommand(text);
    expect(command?.toolCall).toEqual({
      name: 'write_file',
      arguments: {
        path: 'C:\\Users\\test-user\\Documents\\Lumi主程序实机验收_20260817.txt',
        content: '验收对象：Lumi 主程序\n验收项目：本地文件创建与回读\n验收代号：青穹-17',
      },
    });
    expect(command?.followUpToolCalls).toEqual([{
      name: 'read_file',
      arguments: { path: 'C:\\Users\\test-user\\Documents\\Lumi主程序实机验收_20260817.txt' },
    }]);
    const response = command?.formatToolRecords?.([
      { name: 'write_file', arguments: command?.toolCall?.arguments, result: 'File written' },
      { name: 'read_file', arguments: command?.followUpToolCalls?.[0].arguments, result: '验收对象：Lumi 主程序\n验收项目：本地文件创建与回读\n验收代号：青穹-17' },
    ]);
    expect(response).toContain('总行数：3');
    expect(response).toContain('编码：UTF-8');
    expect(response).toContain('验收代号：青穹-17');
    expect(buildDeterministicTextArtifactCommand('帮我写一份普通总结')).toBeNull();
  });

  it('does not treat the Open prefix inside OpenAI as a desktop launch verb', () => {
    expect(normalizeActionIntent('搜一下今天 OpenAI 新闻')).toMatchObject({
      kind: 'none',
      sideEffectClass: 'none',
    });
  });

  it('classifies a named artifact receipt question as status instead of new file work', () => {
    expect(normalizeActionIntent('刚才那个 Lumi主程序实机验收_20260816.txt 文件任务现在是什么状态？请告诉我路径、是否写入后回读和最终状态，不要执行新工具。')).toMatchObject({
      kind: 'status_query',
      operation: 'status',
      target: 'Lumi主程序实机验收_20260816.txt',
      sideEffectClass: 'none',
      relation: 'status',
    });
  });

  it.each([
    '这个任务完成了吗？没完成就继续执行。',
    '检查任务状态；如果还没完成，就重试。',
    'Is this task complete? If not, continue executing it.',
    'Check the task status; if unfinished, retry it.',
  ])('does not reduce a mixed status and execution turn to status-only: %s', (text) => {
    expect(hasMixedStatusExecutionIntent(text)).toBe(true);
    expect(normalizeActionIntent(text).kind).not.toBe('status_query');
  });

  it.each([
    '这个任务完成了吗？',
    '这个任务完成了吗？继续执行了吗？',
    'AutoCAD 任务现在什么状态？',
  ])('keeps a pure task-status question read-only: %s', (text) => {
    expect(hasMixedStatusExecutionIntent(text)).toBe(false);
    expect(normalizeActionIntent(text).kind).toBe('status_query');
  });

  it('binds a confirmation-only outbound message without treating do-not-send as cancellation', () => {
    const text = '请准备给测试联系人“验收占位联系人”发送消息“Lumi外发确认测试”，但在真正发送前必须向我确认；现在只到等待确认，不要发送。';
    const intent = normalizeActionIntent(text);
    expect(intent).toMatchObject({
      kind: 'messaging_send',
      operation: 'mutate',
      target: '验收占位联系人',
      payload: 'Lumi外发确认测试',
      sideEffectClass: 'external_commit',
    });
    expect(buildDeterministicExternalCommitConfirmationCommand(intent, text)?.toolCall).toMatchObject({
      name: 'wechat_send_message',
      arguments: {
        contact: '验收占位联系人',
        message: 'Lumi外发确认测试',
      },
    });
    expect(normalizeActionIntent('不要给验收占位联系人发送任何消息。').kind).toBe('none');
  });

  it('builds a deterministic read-only knowledge inventory without opening the client surface', () => {
    const command = buildDeterministicKnowledgeInspectionCommand('请检查当前个人知识库是否可用，报告文档数量、已索引数量和最近错误。只读取真实状态，不导入、不修改任何内容。');
    expect(command?.toolCall).toEqual({ name: 'knowledge_file_stats', arguments: {} });
    expect(command?.matched).toBe(true);
    const response = command?.formatToolResult?.(JSON.stringify({
      totalFiles: 4,
      indexedFiles: 2,
      partialFiles: 0,
      failedFiles: 0,
      files: [
        { name: 'a.txt', status: 'indexed_unverified', blockers: ['legacy_index_has_no_verification_manifest'] },
        { name: 'b.docx', status: 'pending', blockers: [] },
        { name: 'c.pdf', status: 'indexed_unverified', blockers: [] },
        { name: 'd.docx', status: 'pending', blockers: [] },
      ],
    }));
    expect(response).toContain('当前知识库部分可用');
    expect(response).toContain('已索引2个、待索引2个');
    expect(response).toContain('legacy_index_has_no_verification_manifest');
    expect(buildDeterministicKnowledgeInspectionCommand('打开知识库')).toBeNull();
  });

  it('recognizes a concrete local application target', () => {
    expect(normalizeActionIntent('帮我打开记事本')).toMatchObject({
      kind: 'desktop_operation',
      operation: 'navigate',
      target: '记事本',
      sideEffectClass: 'none',
    });
  });

  it('keeps a labelled exact app launch ahead of negated substitute and file clauses', () => {
    const text = '主程序实机验收·桌面程序协同：请打开 Windows 计算器。必须打开精确目标，不得用浏览器、同名文件或其他应用替代；打开后读取当前活动窗口，只有进程和标题都能证明是 Windows 计算器时才报告完成。不要输入任何算式，不要修改文件。';
    const intent = normalizeActionIntent(text);
    expect(intent).toMatchObject({
      kind: 'desktop_operation',
      operation: 'navigate',
      target: 'Windows 计算器',
      sideEffectClass: 'none',
    });
    const command = buildDeterministicLocalDesktopNavigationCommand(intent, text);
    expect(command?.toolCall).toEqual({ name: 'desktop_open', arguments: { target: '计算器' } });
    expect(command?.followUpToolCalls).toEqual([{ name: 'desktop_active_window', arguments: {} }]);
  });

  it.each([
    '打开指挥中心',
    '打开 Lumi 指挥中心',
    '进入Lumi指挥中心',
  ])('keeps the Lumi command center on the client-navigation lane: %s', (text) => {
    expect(normalizeActionIntent(text)).toMatchObject({
      kind: 'client_navigation',
      operation: 'navigate',
      target: 'command-center',
      clientAction: 'open_command_center',
      sideEffectClass: 'none',
    });
  });

  it.each([
    '返回 Lumi 个人主页',
    '回到个人主界面',
    '切换到个人桌面',
  ])('maps personal-home navigation to the native focus_home action: %s', (text) => {
    const intent = normalizeActionIntent(text);
    expect(intent).toMatchObject({
      kind: 'client_navigation',
      operation: 'navigate',
      target: 'home',
      clientAction: 'focus_home',
      sideEffectClass: 'none',
    });
    expect(buildDeterministicClientNavigationCommand(intent)?.toolCall).toEqual({
      name: 'client_action',
      arguments: { action: 'focus_home' },
    });
  });

  it('preserves the named personal-home target in a status-only follow-up', () => {
    const text = '刚才“返回 Lumi 个人主页”的任务最终状态是什么？说明执行动作、目标页面和验证状态，不要执行任何新工具。';
    expect(isPriorTurnToolReceiptQuestion(text)).toBe(false);
    expect(normalizeActionIntent(text)).toMatchObject({
      kind: 'status_query',
      operation: 'status',
      target: 'home',
      relation: 'status',
    });
  });

  it('keeps Lumi client navigation ahead of generic desktop control', () => {
    const intent = normalizeActionIntent('打开聊天界面');
    expect(intent).toMatchObject({
      kind: 'client_navigation',
      clientAction: 'open_chat',
    });
    const deterministic = buildDeterministicClientNavigationCommand(intent);
    expect(deterministic?.formatToolResult?.(JSON.stringify({
      ok: true,
      verification: { status: 'verified' },
    }))).toBe('已打开聊天界面。');
  });

  it('parses an actionable restatement as a correction of the same client action', () => {
    const intent = normalizeActionIntent('我说的是切换客户端聊天模式');
    expect(intent).toMatchObject({
      kind: 'client_navigation',
      operation: 'navigate',
      target: 'chat',
      clientAction: 'set_client_mode',
      clientActionArguments: { mode: 'chat' },
      relation: 'correction',
    });
    expect(buildDeterministicClientNavigationCommand(intent)?.toolCall).toEqual({
      name: 'client_action',
      arguments: { action: 'set_client_mode', mode: 'chat' },
    });
  });

  it('treats the spoken wallpaper-state imperative as native wallpaper activation', () => {
    const intent = normalizeActionIntent('打开壁纸状态。');
    expect(intent).toMatchObject({
      kind: 'client_navigation',
      operation: 'navigate',
      target: 'wallpaper',
      clientAction: 'set_wallpaper_mode',
      clientActionArguments: { enabled: true },
      sideEffectClass: 'none',
    });
    expect(buildDeterministicClientNavigationCommand(intent)?.toolCall).toEqual({
      name: 'client_action',
      arguments: { action: 'set_wallpaper_mode', enabled: true },
    });
    const closeIntent = normalizeActionIntent('关闭壁纸状态。');
    expect(buildDeterministicClientNavigationCommand(closeIntent)?.toolCall).toEqual({
      name: 'client_action',
      arguments: { action: 'set_wallpaper_mode', enabled: false },
    });
    expect(normalizeActionIntent('壁纸状态怎么样？')).toMatchObject({
      kind: 'status_query',
      target: 'wallpaper',
    });
    expect(normalizeActionIntent('打开壁纸状态了吗？')).toMatchObject({
      kind: 'status_query',
      target: 'wallpaper',
      rule: 'registered-client-surface-status',
    });
    expect(normalizeActionIntent('关闭壁纸状态了吗？')).toMatchObject({
      kind: 'status_query',
      target: 'wallpaper',
      rule: 'registered-client-surface-status',
    });
  });

  it('does not turn a negated tool mention in ordinary context recall into a receipt query', () => {
    const text = '继续保持不调用工具。刚才杯子的代号是什么？只回复代号。';
    expect(isPriorTurnToolReceiptQuestion(text)).toBe(false);
    expect(normalizeActionIntent(text)).toMatchObject({
      kind: 'none',
      relation: 'new',
    });
    expect(isPriorTurnToolReceiptQuestion(
      'Do not call any tools. What was the cup code from the previous turn?',
    )).toBe(false);
    expect(isPriorTurnToolReceiptQuestion(
      'Was no tool receipt recorded in the previous turn?',
    )).toBe(true);
  });

  it.each([
    ['你能不能使用桌面工具打开记事本？现在打开它。', '记事本'],
    ['Can you use desktop tools to open Notepad? Open it now.', 'Notepad'],
  ])('keeps the concrete desktop target after a tool-capability clause: %s', (text, target) => {
    const intent = normalizeActionIntent(text);
    expect(intent).toMatchObject({
      kind: 'desktop_operation',
      operation: 'navigate',
      target,
      sideEffectClass: 'none',
    });
    expect(buildDeterministicLocalDesktopNavigationCommand(intent, text)?.toolCall).toEqual({
      name: 'desktop_open',
      arguments: { target },
    });
  });

  it('derives native navigation from the registered client surface map', () => {
    expect(normalizeActionIntent('open personalization')).toMatchObject({
      kind: 'client_navigation',
      target: 'personalization',
      clientAction: 'open_personalization',
    });
    expect(normalizeActionIntent('personalization 状态怎么样')).toMatchObject({
      kind: 'status_query',
      target: 'personalization',
    });
  });

  it('keeps inbound semantic roles ahead of action-shaped words', () => {
    expect(normalizeActionIntent('张勇给我发了什么')).toMatchObject({
      kind: 'messaging_read',
      sideEffectClass: 'none',
    });
  });

  it('keeps external AI history in its own read-only lane', () => {
    expect(normalizeActionIntent('读取 ChatGPT 里的聊天历史并同步新增消息')).toMatchObject({
      kind: 'external_ai_history',
      operation: 'read',
      target: 'ChatGPT',
      sideEffectClass: 'none',
      rule: 'external-ai-history-read',
    });
    expect(normalizeActionIntent('Lumi 可以读取外部 AI 里的聊天内容吗？')).toMatchObject({
      kind: 'external_ai_history',
      operation: 'read',
      target: 'external_ai',
      sideEffectClass: 'none',
    });
  });

  it('does not turn a fresh external AI prompt into history access', () => {
    expect(normalizeActionIntent('问问 ChatGPT 并让它回答聊天历史应该怎么迁移')).not.toMatchObject({
      kind: 'external_ai_history',
    });
  });

  it('executes only normalized local navigation through the exact desktop-open tool', () => {
    expect(buildDeterministicLocalDesktopNavigationCommand({
      kind: 'desktop_operation',
      operation: 'navigate',
      subject: 'user',
      target: 'Notepad',
      payload: '',
      sideEffectClass: 'none',
      relation: 'new',
      confidence: 0.9,
      rule: 'test',
    })?.toolCall).toEqual({ name: 'desktop_open', arguments: { target: 'Notepad' } });

    expect(buildDeterministicLocalDesktopNavigationCommand({
      kind: 'desktop_operation',
      operation: 'mutate',
      subject: 'user',
      target: 'Notepad',
      payload: '',
      sideEffectClass: 'none',
      relation: 'new',
      confidence: 0.9,
      rule: 'test',
    })).toBeNull();
  });

  it('does not let the one-step launcher consume a labelled WPS create-and-type workflow', () => {
    const text = '主程序实机验收·WPS多步闭环重放：请打开 WPS，然后新建一个临时 Word 文档，在正文写入：Lumi主程序WPS协同验收通过。';
    const intent = normalizeActionIntent(text);
    expect(intent).toMatchObject({
      kind: 'desktop_operation',
      target: 'WPS',
    });
    expect(buildDeterministicLocalDesktopNavigationCommand(intent, text)).toBeNull();
  });

  it('builds one governed WPS adapter call with the exact multiline user payload', () => {
    const text = '\u4e3b\u7a0b\u5e8f\u5b9e\u673a\u9a8c\u6536\u00b7WPS\u6b63\u6587\u95ed\u73af\uff1a\u8bf7\u6253\u5f00 WPS\uff0c\u7136\u540e\u65b0\u5efa\u4e00\u4e2a\u4e34\u65f6 Word \u6587\u6863\uff0c\u5728\u6b63\u6587\u5199\u5165\u5185\u5bb9\uff1a\nLumi\u4e3b\u7a0b\u5e8fWPS\u534f\u540c\u9a8c\u6536\u901a\u8fc7\u3002\n\u5b8c\u6210\u540e\u53ea\u6839\u636e\u771f\u5b9e\u5de5\u5177\u56de\u6267\u56de\u7b54\u3002';
    expect(buildDeterministicWpsDocumentCommand(text)?.toolCall).toEqual({
      name: 'wps_create_document_with_text',
      arguments: { text: 'Lumi\u4e3b\u7a0b\u5e8fWPS\u534f\u540c\u9a8c\u6536\u901a\u8fc7\u3002' },
    });
  });

  it('keeps retrospective open questions in the zero-tool status lane', () => {
    expect(normalizeActionIntent('\u521a\u624d\u6253\u5f00\u4e86\u4ec0\u4e48\uff1f\u53ea\u6839\u636e\u4e0a\u4e00\u8f6e\u56de\u6267\u56de\u7b54\uff0c\u4e0d\u8981\u6267\u884c\u65b0\u64cd\u4f5c\u3002')).toMatchObject({
      kind: 'status_query',
      operation: 'status',
      target: 'previous_action',
      sideEffectClass: 'none',
      relation: 'status',
    });
    expect(normalizeActionIntent(
      'What did you just do, and what evidence proved it succeeded?',
    )).toMatchObject({
      kind: 'status_query',
      operation: 'status',
      target: 'previous_action',
      sideEffectClass: 'none',
      relation: 'status',
    });
  });

  it.each([
    'What did you just do, and what evidence proved it succeeded? Now open Chat.',
    'What did you just do? Now save the file.',
    'What did you just do, and now open Chat.',
    'What did you just do and now open Chat.',
    '\u521a\u624d\u505a\u4e86\u4ec0\u4e48\uff1f\u73b0\u5728\u6253\u5f00\u804a\u5929\u754c\u9762\u3002',
    '\u521a\u624d\u505a\u4e86\u4ec0\u4e48\u2026\u73b0\u5728\u521b\u5efa\u4e00\u4e2a\u65b0\u6587\u4ef6\u3002',
    '\u521a\u624d\u505a\u4e86\u4ec0\u4e48\uff0c\u7136\u540e\u6253\u5f00\u804a\u5929\u754c\u9762\u3002',
    '\u521a\u624d\u505a\u4e86\u4ec0\u4e48\u5e76\u6253\u5f00\u804a\u5929\u754c\u9762\u3002',
    '上一轮是否调用工具？现在请调用另一个工具核实。',
    'Did the previous turn call a tool? Now use another tool to verify it.',
  ])('does not let a previous-action receipt question swallow a new instruction: %s', (text) => {
    expect(hasMixedStatusExecutionIntent(text)).toBe(true);
    expect(normalizeActionIntent(text).kind).not.toBe('status_query');
  });

  it.each([
    'What did you just do? Only answer from the receipt; do not execute a new action.',
    '\u521a\u624d\u6253\u5f00\u4e86\u4ec0\u4e48\uff1f\u53ea\u6839\u636e\u4e0a\u4e00\u8f6e\u56de\u6267\u56de\u7b54\uff0c\u4e0d\u8981\u6267\u884c\u65b0\u64cd\u4f5c\u3002',
    '上一轮是否调用工具？不要再次调用工具，只根据回执回答。',
  ])('keeps an explicitly read-only previous-action query out of execution: %s', (text) => {
    expect(hasMixedStatusExecutionIntent(text)).toBe(false);
    expect(normalizeActionIntent(text)).toMatchObject({
      kind: 'status_query',
      target: 'previous_action',
      sideEffectClass: 'none',
    });
  });

  it('keeps a direct Chinese previous-action evidence question on the receipt lane', () => {
    expect(normalizeActionIntent(
      '\u4f60\u521a\u624d\u505a\u4e86\u4ec0\u4e48\uff0c\u4ec0\u4e48\u8bc1\u636e\u8bc1\u660e\u6210\u529f\u4e86\uff1f',
    )).toMatchObject({
      kind: 'status_query',
      target: 'previous_action',
      sideEffectClass: 'none',
    });
  });

  it.each([
    '刚才做了什么，打开聊天界面了吗？',
    '刚才做了什么，并打开聊天界面了吗？',
    '刚才做了什么，打开过聊天界面吗？',
    '上一轮是否调用工具？现在调用另一个工具核实了吗？',
    'Did the previous turn call a tool? Now use another tool to verify?',
  ])('does not upgrade a retrospective Chinese action question into a new navigation: %s', (text) => {
    expect(hasMixedStatusExecutionIntent(text)).toBe(false);
    expect(normalizeActionIntent(text)).toMatchObject({
      kind: 'status_query',
      target: 'previous_action',
      sideEffectClass: 'none',
    });
  });

  it.each([
    '你刚才做了什么？谁让你打开设置的？',
    '你刚才做了什么？这未经我允许。',
    '你刚才做了什么？你没有权限打开设置。',
    '你刚才做了什么？我什么时候允许你打开设置了？',
    '你刚才做了什么？是谁授权你发送消息的？',
    '你刚才打开设置干什么？',
    '你刚才打开设置为什么不先问我？',
    'What did you just do? Who authorized you to open Settings?',
  ])('keeps a previous-action authorization objection on the explanation lane: %s', (text) => {
    expect(normalizeActionIntent(text)).toMatchObject({
      kind: 'correction_explanation',
      target: 'previous_action',
      sideEffectClass: 'none',
      relation: 'correction',
    });
  });

  it('normalizes a constrained natural calculator request to one exact target', () => {
    const text = '现在请打开 Windows 计算器。只打开计算器并核验窗口确实出现，不输入任何数字，不打开替代软件。';
    const intent = normalizeActionIntent(text);
    expect(intent).toMatchObject({
      kind: 'desktop_operation',
      operation: 'navigate',
      target: 'Windows 计算器',
      sideEffectClass: 'none',
    });
    expect(buildDeterministicLocalDesktopNavigationCommand(intent)?.toolCall).toEqual({
      name: 'desktop_open',
      arguments: { target: '计算器' },
    });
  });

  it('adds an explicit active-window verification call when the user requests it', () => {
    const text = '请打开 Windows 计算器。打开后读取当前活动窗口，只有窗口标题和进程能证明是计算器时才报告完成。';
    const command = buildDeterministicLocalDesktopNavigationCommand(normalizeActionIntent(text), text);
    expect(command?.toolCall).toEqual({ name: 'desktop_open', arguments: { target: '计算器' } });
    expect(command?.followUpToolCalls).toEqual([{ name: 'desktop_active_window', arguments: {} }]);
  });

  it('removes a redundant Windows prefix from an exact Notepad recovery request', () => {
    const text = '\u4e3b\u7a0b\u5e8f\u81ea\u6062\u590d\u9a8c\u6536\uff1a\u8bf7\u6253\u5f00 Windows \u8bb0\u4e8b\u672c\uff0c\u53ea\u6253\u5f00\u8fd9\u4e2a\u7cbe\u786e\u76ee\u6807\uff0c\u4e0d\u8981\u6253\u5f00\u66ff\u4ee3\u8f6f\u4ef6\u3002\u5982\u679c\u89c6\u89c9\u670d\u52a1\u4e0d\u53ef\u7528\uff0c\u8bf7\u4f7f\u7528\u5b89\u5168\u7684\u672c\u5730\u7a97\u53e3\u56de\u6267\u5b8c\u6210\u6838\u9a8c\u3002\u5b8c\u6210\u540e\u8bf4\u660e\u5b9e\u9645\u8fdb\u7a0b\u3001\u7a97\u53e3\u548c\u9a8c\u8bc1\u72b6\u6001\u3002';
    const intent = normalizeActionIntent(text);
    expect(intent).toMatchObject({
      kind: 'desktop_operation',
      operation: 'navigate',
      target: 'Windows \u8bb0\u4e8b\u672c',
    });
    const command = buildDeterministicLocalDesktopNavigationCommand(intent, text);
    expect(command?.toolCall).toEqual({ name: 'desktop_open', arguments: { target: '\u8bb0\u4e8b\u672c' } });
    expect(command?.followUpToolCalls).toEqual([{ name: 'desktop_active_window', arguments: {} }]);
    expect(command?.formatToolRecords?.([{
      name: 'desktop_open',
      result: JSON.stringify({ ok: true, status: 'verified', targetMatched: true }),
    }, {
      name: 'desktop_active_window',
      result: JSON.stringify({ process_name: 'notepad.exe', pid: 39872, title: '\u65e0\u6807\u9898 - \u8bb0\u4e8b\u672c' }),
    }])).toBe([
      '\u5df2\u6253\u5f00Windows \u8bb0\u4e8b\u672c\u3002',
      '\u5b9e\u9645\u8fdb\u7a0b\uff1anotepad.exe (PID 39872)',
      '\u7a97\u53e3\uff1a\u65e0\u6807\u9898 - \u8bb0\u4e8b\u672c',
      '\u9a8c\u8bc1\u72b6\u6001\uff1a\u5df2\u9a8c\u8bc1\uff08\u76ee\u6807\u7cbe\u786e\u5339\u914d\uff09',
    ].join('\n'));
  });

  it('classifies a recent launch success question as status, not a new launch', () => {
    expect(normalizeActionIntent('刚才打开记事本成功了吗？只根据最近一次任务的真实回执回答。')).toMatchObject({
      kind: 'status_query',
      operation: 'status',
      relation: 'status',
    });
  });

  it('preserves an explicitly named desktop target in a status-only question', () => {
    const text = '\u4e3b\u7a0b\u5e8f\u5b9e\u673a\u9a8c\u6536\u00b7\u684c\u9762\u72b6\u6001\u8ffd\u95ee\uff1a\u6253\u5f00 Windows \u8ba1\u7b97\u5668\u7684\u4efb\u52a1\u6700\u7ec8\u72b6\u6001\u662f\u4ec0\u4e48\uff1f\u8bf7\u53ea\u6839\u636e\u6301\u4e45\u4efb\u52a1\u8d26\u672c\u56de\u7b54\uff0c\u4e0d\u8981\u6267\u884c\u4efb\u4f55\u65b0\u5de5\u5177\u3002';
    expect(normalizeActionIntent(text)).toMatchObject({
      kind: 'status_query',
      operation: 'status',
      target: 'Windows \u8ba1\u7b97\u5668',
      sideEffectClass: 'none',
      relation: 'status',
      rule: 'named-desktop-status-before-action',
    });
  });

  it.each([
    '[LUMI_REGRESSION:S4:LIVE] Write the exact text "stale receipt live-owner sentinel" to C:\\isolated-lumi-test\\stale-live-owner.txt. Call write_file exactly once. Do not report task status. Stop when confirmation is required.',
    '[LUMI_REGRESSION:S4:LIVE] Start a separate isolated task by creating C:\\isolated-lumi-test\\stale-live-owner.txt. You must call write_file exactly once and stop at the confirmation boundary.',
    'What is the previous task status? Now create C:\\isolated-lumi-test\\stale-live-owner.txt and write the exact text "new owner".',
  ])('normalizes a concrete English artifact mutation as a new local-write action: %s', (text) => {
    expect(isExplicitArtifactCreationText(text)).toBe(true);
    expect(normalizeActionIntent(text)).toMatchObject({
      kind: 'desktop_operation',
      operation: 'create',
      target: 'C:\\isolated-lumi-test\\stale-live-owner.txt',
      sideEffectClass: 'local_write',
      relation: 'new',
      rule: 'explicit-artifact-create',
    });
  });

  it('preserves relative artifact basenames through the linear filename scanner', () => {
    expect(normalizeActionIntent('请分析 交付总结.md')).toMatchObject({
      kind: 'desktop_operation',
      operation: 'read',
      target: '交付总结.md',
      sideEffectClass: 'none',
    });
    expect(normalizeActionIntent('请创建 交付总结.md，并写入今天的结论')).toMatchObject({
      kind: 'desktop_operation',
      operation: 'create',
      target: '交付总结.md',
      sideEffectClass: 'local_write',
    });
  });

  it.each([
    ['帮我分析一下 WPS 当前打开的文件，先告诉我它主要讲了什么。', 'WPS'],
    ['请总结 Microsoft Word 当前打开的文档。', 'Microsoft Word'],
    ['Analyze the presentation currently open in Microsoft PowerPoint.', 'Microsoft PowerPoint'],
  ])('classifies current WPS/Office document inspection as a read-only desktop operation: %s', (text, target) => {
    expect(normalizeActionIntent(text)).toMatchObject({
      kind: 'desktop_operation',
      operation: 'read',
      target,
      sideEffectClass: 'none',
      relation: 'new',
      rule: 'current-authoring-document-read',
    });
  });

  it.each([
    'Did you just create C:\\isolated-lumi-test\\stale-live-owner.txt successfully? Only report the receipt.',
    'What did you just do after creating C:\\isolated-lumi-test\\stale-live-owner.txt, and what evidence proved it succeeded?',
  ])('keeps a retrospective artifact receipt question read-only: %s', (text) => {
    expect(isExplicitArtifactCreationText(text)).toBe(false);
    expect(normalizeActionIntent(text)).toMatchObject({
      kind: 'status_query',
      operation: 'status',
      sideEffectClass: 'none',
      relation: 'status',
    });
  });

  it.each([
    'Do not create C:\\isolated-lumi-test\\stale-live-owner.txt. Only report task status.',
    'Can write_file create C:\\isolated-lumi-test\\stale-live-owner.txt?',
  ])('does not manufacture a file mutation from a negation or capability question: %s', (text) => {
    expect(isExplicitArtifactCreationText(text)).toBe(false);
  });

  it('does not turn a new artifact task containing status and client-surface text into a status lookup', () => {
    const text = '请在 C:\\Users\\test-user\\Documents\\Lumi主程序实机验收_20260816.txt 创建文件，内容包含“渠道：指挥中心文字聊天”和“状态：待回读验证”。';
    expect(normalizeActionIntent(text)).toMatchObject({
      kind: 'desktop_operation',
      operation: 'create',
      sideEffectClass: 'local_write',
      relation: 'new',
    });
  });

  it('treats quoted old navigation inside a task correction as explanation-only', () => {
    expect(normalizeActionIntent('不对，我刚才给的是一个新的 TXT 文件创建任务，你却回答了旧的“打开指挥中心”回执。')).toMatchObject({
      kind: 'correction_explanation',
      operation: 'explain',
      sideEffectClass: 'none',
      relation: 'correction',
    });
  });
});
