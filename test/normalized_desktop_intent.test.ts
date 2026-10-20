import { foregroundPipeline } from './foreground_pipeline_fixture';
import { describe, expect, it, vi } from 'vitest';
import { readDB } from '../db_layer';
import { ToolRegistry } from '../server/tools/registry';
import { registerAllTools } from '../server/tools/definitions';
import { executeToolCall } from '../server/tools/execution_engine';
import { listWorkTakeoverTasks } from '../server/work_takeover/tasks';
import {
  hasMixedStatusExecutionIntent,
  isExplicitArtifactCreationText,
  isImmediateAssistantRestatementRequest,
  isPriorTurnToolReceiptQuestion,
  normalizeActionIntent,
} from '../server/cognition/normalized_action_intent';

describe('normalized desktop intent priority', () => {
  it.each(['/tmp/lumi-output/orders.xlsx', '/Users/test-user/My Documents/orders.xlsx'])(
    'retains the complete POSIX path in a concrete creation request: %s', output => {
      expect(normalizeActionIntent(`新建 ${output}，只有一个工作表。`)).toMatchObject({
        operation: 'create', sideEffectClass: 'local_write', target: output,
     });
    },
  );
  it.each(['https://example.com/orders.xlsx', 'relative/reports/orders.xlsx', '~/Desktop/orders.xlsx'])(
    'does not promote a URL or relative path into an absolute output: %s', output => {
      expect(normalizeActionIntent(`Create ${output}.`).target).not.toMatch(/^\//);
    },
  );
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

    const pipeline = foregroundPipeline(text);
    expect(pipeline.normalizedIntent).toEqual(normalizeActionIntent(text));
    expect(pipeline.executionRequested).toBe(true);
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
  });

  it('uses the Chinese task-name field as the persistent task title', () => {
    const text = '\u8bf7\u521b\u5efa\u4e00\u4e2a\u6301\u4e45\u4efb\u52a1\uff0c\u4efb\u52a1\u540d\u201c\u4e3b\u7a0b\u5e8f\u6587\u5b57\u957f\u4efb\u52a1-20260818\u201d\uff0c\u7c7b\u522b\uff1a\u901a\u7528\u3002';
    expect(normalizeActionIntent(text)).toMatchObject({
      kind: 'work_task',
      operation: 'create',
      target: '\u4e3b\u7a0b\u5e8f\u6587\u5b57\u957f\u4efb\u52a1-20260818',
   });
  });

  it('queries an explicitly named persistent task instead of the older conversation action ledger', () => {
    const text = '主程序任务状态验收：请查询任务“青穹客户跟进闭环”的持久状态，只根据任务账本回答任务编号、当前状态、当前步骤、后续步骤和确认边界，不要执行任何外部动作。';

    const pipeline = foregroundPipeline(text);
    expect(pipeline.normalizedIntent).toEqual(normalizeActionIntent(text));
    expect(pipeline.executionRequested).toBe(true);
  });

  it('keeps an explicit id-based status query read-only even when it says not to execute', async () => {
    const text = '\u8bf7\u67e5\u8be2\u6301\u4e45\u4efb\u52a1 wt_task_acceptance \u7684\u72b6\u6001\u548c\u8fdb\u5ea6\uff0c\u53ea\u8bfb\u4efb\u52a1\u8d26\u672c\uff0c\u4e0d\u8981\u6267\u884c\u6216\u63a8\u8fdb\u4efb\u4f55\u6b65\u9aa4\u3002';

    const pipeline = foregroundPipeline(text);
    expect(pipeline.normalizedIntent).toEqual(normalizeActionIntent(text));
    // Availability of read schemas is not admission to execute or resume a task.
    expect(pipeline.executionRequested).toBe(true);
    expect(pipeline.normalizedIntent.sideEffectClass).toBe('none');
    expect(pipeline.taskId).toBeUndefined();
    expect(pipeline.trustedActionContinuation).toBe(false);
    expect(pipeline.modelToolProjection.toolNames).toContain('client_capability_manifest');
    for (const mutation of [
      'work_takeover_task_create', 'work_takeover_task_update', 'work_takeover_task_continue',
      'work_takeover_task_execute_step', 'work_takeover_task_advance', 'work_takeover_task_autorun',
      'runtime_work_cancel', 'runtime_work_pause', 'runtime_work_resume',
    ]) {
      const allowed = pipeline.authorizationPolicy.allowedTools || [];
      const forbidden = pipeline.authorizationPolicy.forbiddenTools || [];
      const authorized = (allowed.includes('*') || allowed.includes(mutation))
        && !forbidden.includes('*') && !forbidden.includes(mutation);
      expect({ mutation, authorized }).toEqual({ mutation, authorized: false });
      expect(pipeline.modelToolProjection.toolNames).not.toContain(mutation);
    }
    const userId = 'foreground-convergence-fixture';
    const registry = new ToolRegistry();
    registerAllTools(registry);
    const originalTasks = JSON.stringify(listWorkTakeoverTasks({ userId }));
    const originalActionTasks = JSON.stringify((readDB().conversationActionTasks || []).filter(row => row.userId === userId));
    for (const [name, args] of [
      ['work_takeover_task_create', { category: 'general_work', title: 'Must not be created by a status query' }],
      ['work_takeover_task_update', { id: 'wt_task_acceptance', status: 'delivered' }],
      ['work_takeover_task_advance', { id: 'wt_task_acceptance' }],
    ] as const) {
      const handler = vi.spyOn(registry.get(name)!, 'handler');
      try {
        const result = await executeToolCall({ registry, name, arguments: args,
          context: { userId, requestId: 'readonly-id-query', domain: 'personal', orgId: '',
            authenticated: true, authRole: 'admin', localExecution: true,
            executionBoundary: 'trusted_local', actionIntent: text,
            toolPolicy: pipeline.authorizationPolicy, acceptedActionContract: pipeline.turnIntent.flow.acceptedActionContract,
          },
        });
        expect(result.error).toMatch(/forbidden/i);
        expect(handler).not.toHaveBeenCalled();
      } finally { handler.mockRestore(); }
    }
    const reader = vi.spyOn(registry.get('work_takeover_task_list')!, 'handler');
    try {
      const read = await executeToolCall({ registry, name: 'work_takeover_task_list', arguments: {},
        context: { userId, requestId: 'readonly-id-query', domain: 'personal', orgId: '',
          authenticated: true, authRole: 'admin', localExecution: true,
          executionBoundary: 'trusted_local', actionIntent: text, toolPolicy: pipeline.authorizationPolicy },
      });
      expect(read.error).toBeUndefined();
      expect(reader).toHaveBeenCalledOnce();
      expect(JSON.parse(read.result)).toEqual({ tasks: JSON.parse(originalTasks), count: JSON.parse(originalTasks).length });
    } finally { reader.mockRestore(); }
    expect(JSON.stringify(listWorkTakeoverTasks({ userId }))).toBe(originalTasks);
    expect(JSON.stringify((readDB().conversationActionTasks || []).filter(row => row.userId === userId))).toBe(originalActionTasks);
  });

  it('treats whether a persistent task is complete as a read-only status question', () => {
    const text = '请查询持久任务 wt_task_acceptance 是否完成和当前状态，只读任务账本，不要执行新动作。';

    const pipeline = foregroundPipeline(text);
    expect(pipeline.normalizedIntent).toEqual(normalizeActionIntent(text));
    expect(pipeline.executionRequested).toBe(false);
  });

  it('keeps affirmative step execution after a separate no-external-action clause', () => {
    const text = '持久任务 wt_task_acceptance：不要执行外发动作；现在完成第一步“整理客户需求”，然后返回状态。';

    const pipeline = foregroundPipeline(text);
    expect(pipeline.normalizedIntent).toEqual(normalizeActionIntent(text));
    expect(pipeline.executionRequested).toBe(true);
  });

  it('does not let a requested status receipt shadow an explicit task progress update', () => {
    const text = '续接持久任务“主程序文字长任务-20260818-2031” wt_task_acceptance：完成第一步“整理三项能力”，给出五项检查清单；不要写文件，不要外发；第三步等待我确认。请把进度写回同一任务账本并返回当前状态与剩余步骤。';

    const pipeline = foregroundPipeline(text);
    expect(pipeline.normalizedIntent).toEqual(normalizeActionIntent(text));
    expect(pipeline.executionRequested).toBe(true);
    expect(pipeline.normalizedIntent.kind).not.toBe('status_query');
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
    expect(normalizeActionIntent('不要给验收占位联系人发送任何消息。').kind).toBe('none');
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
  });

  it('parses an actionable restatement as a correction of the same client action', () => {
    const intent = normalizeActionIntent('我说的是打开聊天界面');
    expect(intent).toMatchObject({
      kind: 'client_navigation',
      operation: 'navigate',
      target: 'chat',
      clientAction: 'open_chat',
      relation: 'correction',
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
    const closeIntent = normalizeActionIntent('关闭壁纸状态。');
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

  it('does not let the one-step launcher consume a labelled WPS create-and-type workflow', () => {
    const text = '主程序实机验收·WPS多步闭环重放：请打开 WPS，然后新建一个临时 Word 文档，在正文写入：Lumi主程序WPS协同验收通过。';
    const intent = normalizeActionIntent(text);
    expect(intent).toMatchObject({
      kind: 'desktop_operation',
      target: 'WPS',
   });
  });

  it('builds one governed WPS adapter call with the exact multiline user payload', () => {
    const text = '\u4e3b\u7a0b\u5e8f\u5b9e\u673a\u9a8c\u6536\u00b7WPS\u6b63\u6587\u95ed\u73af\uff1a\u8bf7\u6253\u5f00 WPS\uff0c\u7136\u540e\u65b0\u5efa\u4e00\u4e2a\u4e34\u65f6 Word \u6587\u6863\uff0c\u5728\u6b63\u6587\u5199\u5165\u5185\u5bb9\uff1a\nLumi\u4e3b\u7a0b\u5e8fWPS\u534f\u540c\u9a8c\u6536\u901a\u8fc7\u3002\n\u5b8c\u6210\u540e\u53ea\u6839\u636e\u771f\u5b9e\u5de5\u5177\u56de\u6267\u56de\u7b54\u3002';

    const pipeline = foregroundPipeline(text);
    expect(pipeline.normalizedIntent).toEqual(normalizeActionIntent(text));
    expect(pipeline.executionRequested).toBe(true);
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
    expect(normalizeActionIntent(
      'Based only on the task receipt already recorded, report the current real status of the read-only observation task, whether a tool receipt exists, and the observed window title.',
    )).toMatchObject({
      kind: 'status_query',
      operation: 'status',
      target: 'previous_action',
      sideEffectClass: 'none',
      relation: 'status',
      rule: 'recent-action-receipt-before-action',
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
  });

  it('adds an explicit active-window verification call when the user requests it', () => {
    const text = '请打开 Windows 计算器。打开后读取当前活动窗口，只有窗口标题和进程能证明是计算器时才报告完成。';

    const pipeline = foregroundPipeline(text);
    expect(pipeline.normalizedIntent).toEqual(normalizeActionIntent(text));
    expect(pipeline.executionRequested).toBe(true);
  });

  it('removes a redundant Windows prefix from an exact Notepad recovery request', () => {
    const text = '\u4e3b\u7a0b\u5e8f\u81ea\u6062\u590d\u9a8c\u6536\uff1a\u8bf7\u6253\u5f00 Windows \u8bb0\u4e8b\u672c\uff0c\u53ea\u6253\u5f00\u8fd9\u4e2a\u7cbe\u786e\u76ee\u6807\uff0c\u4e0d\u8981\u6253\u5f00\u66ff\u4ee3\u8f6f\u4ef6\u3002\u5982\u679c\u89c6\u89c9\u670d\u52a1\u4e0d\u53ef\u7528\uff0c\u8bf7\u4f7f\u7528\u5b89\u5168\u7684\u672c\u5730\u7a97\u53e3\u56de\u6267\u5b8c\u6210\u6838\u9a8c\u3002\u5b8c\u6210\u540e\u8bf4\u660e\u5b9e\u9645\u8fdb\u7a0b\u3001\u7a97\u53e3\u548c\u9a8c\u8bc1\u72b6\u6001\u3002';
    const intent = normalizeActionIntent(text);
    expect(intent).toMatchObject({
      kind: 'desktop_operation',
      operation: 'navigate',
      target: 'Windows \u8bb0\u4e8b\u672c',
   });
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
    '[LUMI_REGRESSION:S4:LIVE] Use desktop_write_text_file exactly once to write the exact text "stale receipt live-owner sentinel" to C:\\isolated-lumi-test\\stale-live-owner.txt.',
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
