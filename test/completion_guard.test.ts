import { describe, expect, it } from 'vitest';
import { guardCompletionClaims } from '../server/work_product/completion_guard';

describe('completion guard desktop action handling', () => {
  it('does not mistake a source-access instruction inside verified legal research for an open claim', () => {
    const task = '律师版实机验收·法条与类案：基于案件ID case-001，只使用可核验来源输出结果；禁止凭模型记忆编造法条，不要登录外部网站。';
    const response = '法条候选来自本地权威快照。未配置来源只能由律师打开授权网页人工核验；本轮未自动登录任何外部网站。任务回执状态：已验证。';
    const result = guardCompletionClaims({
      task,
      response,
      toolCalls: [{
        name: 'legal_search_statute',
        arguments: { query: '买卖合同纠纷' },
        result: '{"ok":true,"status":"observed","content":"现行有效候选"}',
        terminalVerification: { status: 'verified', strategy: 'terminal_receipt', reason: 'Observed source result.' },
      }],
    });

    expect(result.blocked).toBe(false);
    expect(result.text).toBe(response);
  });

  it('does not replace an attempted desktop action with a file-reading guard', () => {
    const response = 'I will open WeChat from the desktop shortcut and check the process.';

    const result = guardCompletionClaims({
      task: 'open WeChat from the desktop shortcut',
      response,
      toolCalls: [
        {
          name: 'desktop_open',
          arguments: { target: 'WeChat' },
          result: '',
          error: 'Open command failed for: WeChat',
        },
      ],
    });

    expect(result.blocked).toBe(false);
    expect(result.text).toBe(response);
  });

  it('uses desktop wording when an open-completion claim is not verified', () => {
    const result = guardCompletionClaims({
      task: 'open WeChat from the desktop shortcut',
      response: 'Opened WeChat.',
      toolCalls: [
        {
          name: 'desktop_open',
          arguments: { target: 'WeChat' },
          result: '',
          error: 'Open command failed for: WeChat',
        },
      ],
    });

    expect(result.blocked).toBe(true);
    expect(result.text).toContain('desktop action');
    expect(result.text).not.toContain('file/location');
  });

  it('keeps Chinese desktop-action attempts out of the content-review fallback', () => {
    const response = '\u6211\u5148\u5c1d\u8bd5\u6253\u5f00\u5fae\u4fe1\uff0c\u5e76\u68c0\u67e5\u8fdb\u7a0b\u3002';

    const result = guardCompletionClaims({
      task: '\u684c\u9762\u4e0a\u5c31\u6709\u5fae\u4fe1\u7684\u5feb\u6377\u65b9\u5f0f',
      response,
      toolCalls: [
        {
          name: 'desktop_open',
          arguments: { target: '\u5fae\u4fe1' },
          result: '',
          error: 'Open command failed for: \u5fae\u4fe1',
        },
      ],
    });

    expect(result.blocked).toBe(false);
    expect(result.text).toBe(response);
  });

  it('does not treat a negative no-mutation statement as an open claim', () => {
    const response = [
      '\u672c\u8f6e\u684c\u9762\u72b6\u6001\u8bfb\u53d6\u5df2\u5b8c\u6210\u3002',
      '\u5f53\u524d\u6d3b\u52a8\u7a97\u53e3\uff1aLumi OS\uff08lumi-os.exe\uff0cPID 3928\uff09\u3002',
      '\u672c\u8f6e\u6ca1\u6709\u6267\u884c\u70b9\u51fb\u3001\u8f93\u5165\u3001\u5207\u6362\u7a97\u53e3\u3001\u6253\u5f00\u5e94\u7528\u6216\u4fee\u6539\u5185\u5bb9\u3002',
    ].join('\n');

    const result = guardCompletionClaims({
      task: '\u53ea\u8bfb\u53d6\u5f53\u524d\u6d3b\u52a8\u7a97\u53e3\u548c\u684c\u9762\u8fd0\u884c\u72b6\u6001',
      response,
      toolCalls: [{
        name: 'desktop_active_window',
        arguments: {},
        result: '{"title":"Lumi OS","process_name":"lumi-os.exe","pid":3928}',
      }],
    });

    expect(result.blocked).toBe(false);
    expect(result.text).toBe(response);
  });
});

describe('completion guard generic execution claims', () => {
  it('accepts a verified persistent-task creation receipt before generic desktop or file heuristics', () => {
    const task = '请创建一个可跨重启继续的持久任务。标题“青穹客户跟进闭环”，类别 customer，来源 chat。现在只创建并持久化任务，不要发送任何消息。';
    const response = [
      '任务编号：wt_task_acceptance',
      '状态：已创建并持久化（in_progress）',
      '下一步：整理客户需求→生成跟进草稿→等待用户确认后再外发',
      '需要确认：等待用户确认后再外发',
    ].join('\n');
    const result = guardCompletionClaims({
      task,
      response,
      toolCalls: [{
        name: 'work_takeover_task_create',
        arguments: { title: '青穹客户跟进闭环', category: 'customer', source: 'chat' },
        result: JSON.stringify({
          ok: true,
          status: 'created',
          persisted: true,
          task: {
            id: 'wt_task_acceptance',
            status: 'in_progress',
            nextActions: ['整理客户需求', '生成跟进草稿', '等待用户确认后再外发'],
            confirmationRequired: ['等待用户确认后再外发'],
          },
        }),
        terminalVerification: {
          status: 'verified',
          strategy: 'terminal_receipt',
          reason: 'Persistent task receipt verified.',
        },
      }],
    });

    expect(result.blocked).toBe(false);
    expect(result.text).toBe(response);
  });

  const stateDiffCapability = {
    capabilityId: 'desktop.open',
    lane: 'desktop' as const,
    operation: 'mutate' as const,
    risk: 'medium' as const,
    sideEffects: [{ type: 'desktop_control' as const, scope: 'desktop', reversible: true }],
    verification: {
      strategy: 'state_diff' as const,
      required: true,
      requiredFields: ['verification.status'],
      successSignals: ['verified post-state'],
      limitations: [],
    },
  };

  it('does not turn a successful handler return into a completed action without terminal verification', () => {
    const result = guardCompletionClaims({
      task: 'launch an external desktop program',
      response: 'The task is completed successfully.',
      toolCalls: [{
        name: 'unclassified_desktop_adapter',
        arguments: { target: 'Example' },
        result: JSON.stringify({ ok: true, action: 'launch-requested' }),
        capability: stateDiffCapability,
        terminalVerification: {
          status: 'unverified',
          strategy: 'state_diff',
          reason: 'No verified target window was observed.',
        },
      }],
    });

    expect(result.blocked).toBe(true);
    expect(result.reason).toContain('No verified target window was observed');
  });

  it('allows a generic completion claim after the same capability receipt is verified', () => {
    const response = 'The task is completed successfully.';
    const result = guardCompletionClaims({
      task: 'launch an external desktop program',
      response,
      toolCalls: [{
        name: 'unclassified_desktop_adapter',
        arguments: { target: 'Example' },
        result: JSON.stringify({ ok: true, targetMatched: true }),
        capability: stateDiffCapability,
        terminalVerification: {
          status: 'verified',
          strategy: 'state_diff',
          reason: 'The target window was observed.',
        },
      }],
    });

    expect(result.blocked).toBe(false);
    expect(result.text).toBe(response);
  });

  it.each([
    '\u5df2\u5b8c\u6210\u3002',
    '\u5199\u597d\u4e86\u3002',
    '\u5df2\u65b0\u5efa\u3002',
    '\u5df2\u65b0\u5efa\u5e76\u5199\u597d\u4e86\u3002',
    '\u4efb\u52a1\u5df2\u5b8c\u6210\u3002',
  ])('blocks a terse Chinese completion claim even when the task contract is unknown: %s', (response) => {
    const result = guardCompletionClaims({
      task: '\u786e\u8ba4',
      response,
      toolCalls: [],
    });

    expect(result.blocked).toBe(true);
    expect(result.reason).toContain('\u8fd9\u4e00\u8f6e\u6ca1\u6709\u6210\u529f\u6267\u884c\u4efb\u4f55\u5de5\u5177');
    expect(result.text).toContain('\u8fd8\u4e0d\u80fd\u8bf4\u8fd9\u4ef6\u4e8b\u5df2\u7ecf\u5b8c\u6210');
  });

  it.each([
    '\u73b0\u5728\u5c31\u505a\u3002',
    '\u9a6c\u4e0a\u52a8\u624b\u3002',
    '\u6b63\u5728\u6267\u884c\u3002',
    '\u6211\u73b0\u5728\u5c31\u5f00\u59cb\u68c0\u67e5\u81ea\u5df1\u7684\u6587\u4ef6\u3002',
  ])('blocks an ungrounded immediate-execution status: %s', (response) => {
    const result = guardCompletionClaims({
      task: '\u786e\u8ba4',
      response,
      toolCalls: [],
    });

    expect(result.blocked).toBe(true);
    expect(result.reason).toContain('current-turn tool execution');
    expect(result.text).toContain('\u8fd8\u4e0d\u80fd\u8bf4\u6b63\u5728\u6267\u884c');
  });

  it('allows a write-completion claim only with current-turn producer evidence', () => {
    const result = guardCompletionClaims({
      task: '\u786e\u8ba4',
      response: '\u5df2\u65b0\u5efa\u5e76\u5199\u597d\u4e86\u3002',
      toolCalls: [{
        name: 'write_file',
        arguments: { path: 'D:\\tmp\\note.txt' },
        result: 'File written: D:\\tmp\\note.txt',
      }],
    });

    expect(result.blocked).toBe(false);
  });

  it('allows an execution-status claim when the current turn has real action evidence', () => {
    const result = guardCompletionClaims({
      task: '\u786e\u8ba4',
      response: '\u6b63\u5728\u6267\u884c\u3002',
      toolCalls: [{
        name: 'desktop_open',
        arguments: { target: 'WPS' },
        result: 'Focused WPS',
      }],
    });

    expect(result.blocked).toBe(false);
  });

  it('does not treat a failed desktop action as evidence that execution is still running', () => {
    const result = guardCompletionClaims({
      task: '\u6253\u5f00 AutoCAD\u3002',
      response: '\u6b63\u5728\u6267\u884c\u3002',
      toolCalls: [{
        name: 'desktop_open',
        arguments: { target: 'AutoCAD' },
        result: '',
        error: 'AutoCAD launch failed',
      }],
    });

    expect(result.blocked).toBe(true);
    expect(result.reason).toContain('current-turn tool execution');
    expect(result.text).toContain('AutoCAD launch failed');
  });

  it('does not accept an inspection-only receipt as file creation evidence', () => {
    const result = guardCompletionClaims({
      task: '\u786e\u8ba4',
      response: '\u5df2\u65b0\u5efa\u5e76\u5199\u597d\u4e86\u3002',
      toolCalls: [{
        name: 'desktop_list_files',
        arguments: { path: 'C:\\Users\\me\\Desktop' },
        result: '[{"name":"note.txt"}]',
      }],
    });

    expect(result.blocked).toBe(true);
    expect(result.reason).toContain('\u5199\u5165/\u751f\u6210/\u9a8c\u6536\u8bb0\u5f55');
  });

  it('does not count a confirmation blocker returned as tool text as success', () => {
    const result = guardCompletionClaims({
      task: '\u786e\u8ba4',
      response: '\u5df2\u65b0\u5efa\u5e76\u5199\u597d\u4e86\u3002',
      toolCalls: [{
        name: 'write_file',
        arguments: { path: 'D:\\tmp\\note.txt' },
        result: 'Tool "write_file" requires user confirmation and was not approved.',
      }],
    });

    expect(result.blocked).toBe(true);
  });

  it('keeps a large client_get_state receipt successful when only nested capability notes mention confirmation', () => {
    const clientStateResult = JSON.stringify({
      selfAwareness: {
        level: 'live',
        habits: [
          'Some external actions require user confirmation.',
          '\u90e8\u5206\u5916\u90e8\u64cd\u4f5c\u9700\u8981\u786e\u8ba4\uff0c\u4f46\u8bfb\u53d6\u5ba2\u6237\u7aef\u72b6\u6001\u672c\u8eab\u5df2\u6210\u529f\u3002',
        ],
      },
      capabilities: Array.from({ length: 160 }, (_, index) => ({
        id: `capability-${index}`,
        requiresConfirmation: index % 3 === 0,
        notes: `Capability ${index}: requires user confirmation only when its own write action is selected.`,
      })),
      state: { mode: 'assistant', activeTab: 'home', runtimeStatus: 'ready' },
      health: { level: 'attention' },
      scope: { domain: 'personal' },
    });
    expect(clientStateResult.length).toBeGreaterThan(10_000);

    const result = guardCompletionClaims({
      task: '\u7ec4\u5efa\u56e2\u961f\uff0c\u5206\u4e24\u6b65\u6267\u884c\uff0c\u5148\u67e5\u770b\u5f53\u524d\u6d3b\u52a8\u7a97\u53e3\uff0c\u518d\u5217\u51fa\u684c\u9762\u6587\u4ef6\uff0c\u6700\u540e\u6839\u636e\u771f\u5b9e\u5de5\u5177\u7ed3\u679c\u544a\u8bc9\u6211\u7a97\u53e3\u6807\u9898\u548c\u6587\u4ef6\u6570\u91cf\u3002',
      response: '\u5df2\u5b8c\u6210\u67e5\u770b\u5f53\u524d\u6d3b\u52a8\u7a97\u53e3\u5e76\u5217\u51fa\u684c\u9762\u6587\u4ef6\u3002',
      toolCalls: [{
        name: 'client_get_state',
        arguments: {},
        result: clientStateResult,
      }],
      source: 'voice',
    });

    expect(result.blocked).toBe(true);
    expect(result.reason).toContain('\u6210\u529f\u6267\u884c\u4e86\u67e5\u8be2\u6216\u68c0\u67e5\u5de5\u5177');
    expect(result.text).toContain('\u5df2\u6210\u529f\u6267\u884c\uff1aclient_get_state');
    expect(result.text).toContain('\u4e0d\u662f\u5b8c\u6210\u5f53\u524d\u8bf7\u6c42\u6240\u9700\u7684\u6267\u884c\u8bc1\u636e');
    expect(result.text).not.toContain('\u8fd9\u4e00\u8f6e\u6ca1\u6709\u6210\u529f\u6267\u884c\u4efb\u4f55\u5de5\u5177');
    expect(result.text).not.toContain('\u6ca1\u6709\u8bb0\u5f55\u5230\u6210\u529f\u7684\u5de5\u5177\u6267\u884c');
    expect(result.text).not.toContain('undefined');
  });

  it.each([
    JSON.stringify([{ notes: 'This nested capability requires user confirmation for writes.' }]),
    JSON.stringify('This scalar metadata says requires user confirmation but is still a returned JSON value.'),
  ])('does not scan confirmation prose inside successfully parsed JSON arrays or scalars', (clientStateResult) => {
    const result = guardCompletionClaims({
      task: 'inspect the active desktop window and list desktop files',
      response: 'completed successfully',
      toolCalls: [{
        name: 'client_get_state',
        arguments: {},
        result: clientStateResult,
      }],
    });

    expect(result.blocked).toBe(true);
    expect(result.reason).toContain('\u6210\u529f\u6267\u884c\u4e86\u67e5\u8be2\u6216\u68c0\u67e5\u5de5\u5177');
    expect(result.text).toContain('Successfully executed: client_get_state');
    expect(result.text).not.toContain('client_get_state: undefined');
  });

  it.each([
    [{ success: false, error: 'desktop relay unavailable' }, 'desktop relay unavailable'],
    [{ ok: false, reason: 'permission was denied' }, 'permission was denied'],
    [{ status: 'failed' }, 'status=failed'],
    [{ status: 'error' }, 'status=error'],
  ])('keeps explicit structured failure signals blocked without undefined details: %j', (payload, expectedDetail) => {
    const result = guardCompletionClaims({
      task: 'inspect the active desktop window',
      response: 'completed successfully',
      toolCalls: [{
        name: 'desktop_active_window',
        arguments: {},
        result: JSON.stringify(payload),
      }],
    });

    expect(result.blocked).toBe(true);
    expect(result.text).toContain(`desktop_active_window: ${expectedDetail}`);
    expect(result.text).not.toContain('undefined');
  });

  it('does not mistake ordinary explanations or third-party facts for Lumi execution', () => {
    const explanation = guardCompletionClaims({
      task: '\u201c\u5df2\u5b8c\u6210\u201d\u548c\u201c\u6b63\u5728\u6267\u884c\u201d\u6709\u4ec0\u4e48\u533a\u522b\uff1f',
      response: '\u201c\u5df2\u5b8c\u6210\u201d\u8868\u793a\u52a8\u4f5c\u7ed3\u675f\uff1b\u201c\u6b63\u5728\u6267\u884c\u201d\u8868\u793a\u52a8\u4f5c\u4ecd\u5728\u8fdb\u884c\u3002',
      toolCalls: [],
    });
    const fact = guardCompletionClaims({
      task: '\u8bf4\u660e\u8fd9\u4e2a\u9879\u76ee\u7684\u65b0\u95fb\u80cc\u666f\u3002',
      response: '\u8be5\u5de5\u7a0b\u5df2\u5b8c\u6210\u4e3b\u4f53\u65bd\u5de5\uff0c\u9884\u8ba1\u660e\u5e74\u6295\u7528\u3002',
      toolCalls: [],
    });
    expect(explanation.blocked).toBe(false);
    expect(fact.blocked).toBe(false);
  });

  it.each([
    '我正在继续改进自己的任务理解和执行能力。',
    '我现在就开始检查自己哪些能力还需要提升。',
  ])('does not turn a reflective self-improvement status into an external-work guard: %s', (response) => {
    const result = guardCompletionClaims({
      task: '你对目前自己的能力是否满意',
      response,
      toolCalls: [],
    });

    expect(result.blocked).toBe(false);
    expect(result.text).toBe(response);
  });

  it('does not treat reflective capability-building completion as external execution', () => {
    const response = '我已经完成了基础能力建设，但还不够满意。';
    const result = guardCompletionClaims({
      task: '你对目前自己的能提是否满意',
      response,
      toolCalls: [],
    });

    expect(result.blocked).toBe(false);
    expect(result.text).toBe(response);
  });

  it('does not let reflective capability completion hide a separate external action claim', () => {
    const result = guardCompletionClaims({
      task: '你对目前自己的能提是否满意',
      response: '我已经完成了基础能力建设，但我已经打开桌面文件。',
      toolCalls: [],
    });

    expect(result.blocked).toBe(true);
    expect(result.reason).toContain('工具');
  });

  it('does not mistake an external project construction claim for self-development reflection', () => {
    const result = guardCompletionClaims({
      task: '项目建设做好了吗',
      response: '我已经完成了项目建设。',
      toolCalls: [],
    });

    expect(result.blocked).toBe(true);
  });

  it('does not let a reflective clause hide a separate external execution claim', () => {
    const result = guardCompletionClaims({
      task: '你对目前自己的能力是否满意',
      response: '我正在继续改进自己的任务理解和执行能力，我现在就打开桌面文件。',
      toolCalls: [],
    });

    expect(result.blocked).toBe(true);
    expect(result.reason).toContain('current-turn tool execution');
  });

  it.each([
    '现在就做。',
    '正在执行。',
  ])('still blocks immediate-execution status for an explicit external task: %s', (response) => {
    const result = guardCompletionClaims({
      task: '打开并检查桌面上的合同文件',
      response,
      toolCalls: [],
    });

    expect(result.blocked).toBe(true);
    expect(result.reason).toContain('current-turn tool execution');
  });

  it('still blocks a promised review when the user task actually requests external work', () => {
    const result = guardCompletionClaims({
      task: '打开并审查这份合同文件',
      response: '好的，接下来我会先读取文件，再逐条审查。',
      toolCalls: [],
    });

    expect(result.blocked).toBe(true);
    expect(result.reason).toContain('content-read/open/review');
  });
});

describe('completion guard current-app UI evidence', () => {
  const task = [
    '\u5728\u8fd9\u91cc\u9762\u65b0\u5efa\u4e00\u4e2a\u7a7a\u767d\u6587\u6863\u5e76\u5199\u5165\uff1aLumi\u7aef\u5230\u7aef\u56de\u5f52\u6d4b\u8bd5\u3002',
    '## Recent action continuation context',
    'Recovered structured action state:',
    '- appTarget: WPS Office',
  ].join('\n');

  const failedLedger = [{
    name: 'desktop_open',
    arguments: { target: 'WPS' },
    result: 'Opened app WPS Office',
  }, {
    name: 'desktop_ui_focus',
    arguments: { nameContains: 'WPS Office' },
    result: '{"status":"ok","action":"focus","selectedAfter":{"name":"WPS Office"}}',
  }, {
    name: 'desktop_ui_snapshot',
    arguments: { root: 'active' },
    result: '{"root":{"name":"WPS Office","controls":[{"name":"Home"}]}}',
  }, {
    name: 'ocr_screen',
    arguments: {},
    result: 'WPS Office \u9996\u9875\uff1a\u7a7a\u767d\u6587\u6863\u672a\u6253\u5f00\u3002',
  }, {
    name: 'desktop_keyboard_press',
    arguments: { key: 'ctrl+n' },
    result: 'Pressed: ctrl+n',
  }, {
    name: 'write_file',
    arguments: { path: 'D:\\lumiOS\\Lumi\u7aef\u5230\u7aef\u56de\u5f52\u6d4b\u8bd5.txt' },
    result: 'File written: D:\\lumiOS\\Lumi\u7aef\u5230\u7aef\u56de\u5f52\u6d4b\u8bd5.txt',
  }];

  const typedAndVerified = [{
    name: 'desktop_active_window',
    arguments: {},
    result: '{"title":"WPS Office","process_name":"wps.exe"}',
  }, {
    name: 'desktop_keyboard_press',
    arguments: { key: 'ctrl+n' },
    result: 'Pressed: ctrl+n',
  }, {
    name: 'desktop_ui_type',
    arguments: { name: '\u6b63\u6587', text: 'Lumi\u7aef\u5230\u7aef\u56de\u5f52\u6d4b\u8bd5' },
    result: '{"status":"ok","action":"type","typedLength":10}',
  }, {
    name: 'ocr_screen',
    arguments: {},
    result: 'WPS Office \u6587\u6863\u6b63\u6587\uff1aLumi\u7aef\u5230\u7aef\u56de\u5f52\u6d4b\u8bd5',
  }];

  it('does not let a project write_file satisfy a WPS create-and-type claim', () => {
    const result = guardCompletionClaims({
      task,
      response: '\u5df2\u5728 WPS \u65b0\u5efa\u7a7a\u767d\u6587\u6863\u3001\u8f93\u5165\u5185\u5bb9\u5e76\u4fdd\u5b58\u6210\u529f\u3002',
      toolCalls: failedLedger,
    });

    expect(result.blocked).toBe(true);
    expect(result.reason).toBe('Missing verified in-app UI mutation evidence.');
    expect(result.text).toContain('\u8fd8\u4e0d\u80fd\u786e\u8ba4\u5b8c\u6210');
  });

  it('allows a create-and-type claim after matching UI actuation and post-action OCR', () => {
    const response = '\u5df2\u5728 WPS \u65b0\u5efa\u7a7a\u767d\u6587\u6863\u5e76\u5199\u5165\u6307\u5b9a\u5185\u5bb9\u3002';
    const result = guardCompletionClaims({
      task,
      response,
      toolCalls: typedAndVerified,
    });

    expect(result.blocked).toBe(false);
    expect(result.text).toBe(response);
  });

  it('blocks an extra save-success claim until save and post-save evidence exist', () => {
    const result = guardCompletionClaims({
      task,
      response: '\u5df2\u5728 WPS \u65b0\u5efa\u3001\u5199\u5165\u5e76\u4fdd\u5b58\u6210\u529f\u3002',
      toolCalls: typedAndVerified,
    });

    expect(result.blocked).toBe(true);
    expect(result.reason).toBe('Missing verified in-app save evidence.');
  });
});
