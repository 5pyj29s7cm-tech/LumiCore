import './helpers';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const verifiedDesktopReceipt = {
  terminalVerification: {
    status: 'verified' as const,
    strategy: 'terminal_receipt' as const,
    reason: 'Fresh desktop snapshot returned by the connected desktop client.',
  },
};

describe('Lumi result finalizer', () => {
  it('replaces a fabricated seven-mode answer with canonical operation-mode facts', async () => {
    const { finalizeLumiResponse } = await import('../server/cognition/result_finalizer');
    const result = finalizeLumiResponse({
      taskText: '\u4f60\u6709\u591a\u5c11\u79cd\u6a21\u5f0f',
      responseText: '\u6211\u5171\u6709 7 \u79cd\u8fd0\u884c\u6a21\u5f0f\uff0c\u5df2\u9a8c\u8bc1\u5b58\u5728\u4e8e client.modes \u72b6\u6001\u4e2d\uff1aassistant\u3001autonomy\u3001scholar\u3001office\u3001companion\u3001mentor\u3001celebrate\u3002',
      toolRecords: [],
      source: 'chat',
    });

    expect(result.blocked).toBe(false);
    expect(result.reason).toBe('canonical_operation_mode_facts');
    expect(result.text).toContain('3 \u79cd');
    expect(result.text).toContain('autonomous');
    expect(result.text).not.toMatch(/7 \u79cd|scholar|office|autonomy\u3001/u);
    expect(result.text).not.toContain('client.modes');
  });

  it('naturally corrects an unsupported live-client verification claim', async () => {
    const { finalizeLumiResponse } = await import('../server/cognition/result_finalizer');
    const result = finalizeLumiResponse({
      taskText: '\u8bf4\u660e\u4f60\u5bf9\u5ba2\u6237\u7aef\u8fd0\u884c\u72b6\u6001\u7684\u4e86\u89e3',
      responseText: '\u8fd9\u4e9b\u80fd\u529b\u5df2\u9a8c\u8bc1\u5b58\u5728\u4e8e client.modes \u72b6\u6001\u4e2d\u3002',
      toolRecords: [],
      source: 'chat',
    });

    expect(result.blocked).toBe(false);
    expect(result.reason).toBe('unsupported_client_state_verification_claim_corrected');
    expect(result.text).toContain('\u6ca1\u6709\u8bfb\u53d6\u5230\u53ef\u6838\u9a8c');
    expect(result.text).not.toContain('client.modes');
  });

  it('grounds receipt-only runtime cancellation after nested JSON normalization', async () => {
    const { finalizeLumiResponse } = await import('../server/cognition/result_finalizer');
    const result = finalizeLumiResponse({
      taskText: '\u6e05\u6389\u8fd9\u4e9b\u4efb\u52a1',
      responseText: 'Completed the background task cleanup.',
      toolRecords: [{
        name: 'runtime_work_cancel',
        arguments: { taskIds: ['task-a'] },
        result: '',
        receipt: JSON.stringify(JSON.stringify({
          ok: true,
          status: 'cancelled',
          matchedCount: 1,
          cancelledCount: 1,
          cancellingCount: 0,
          failedCount: 0,
        })),
        terminalVerification: {
          status: 'verified',
          strategy: 'terminal_receipt',
          reason: 'The runtime ledger confirmed cancellation.',
        },
      }],
      source: 'chat',
    });

    expect(result.blocked).toBe(false);
  });

  it('never persists a blank runtime-status turn and keeps the cleanup offer adjacent', async () => {
    const { finalizeLumiResponse } = await import('../server/cognition/result_finalizer');
    const result = finalizeLumiResponse({
      taskText: '后台工作现在怎么样？请核对哪些仍可撤回。',
      responseText: '',
      toolRecords: [{
        name: 'runtime_work_status',
        arguments: {},
        result: JSON.stringify({
          ok: true,
          status: 'active',
          activeCount: 2,
          items: [
            { id: 'task-a', title: '任务 A', controls: { canCancel: true } },
            { id: 'task-b', title: '任务 B', controls: { canCancel: true } },
          ],
        }),
        terminalVerification: {
          status: 'verified',
          strategy: 'terminal_receipt',
          reason: 'server-owned runtime snapshot',
        },
        envelope: { status: 'verified_success' },
      } as any],
      source: 'chat',
    });

    expect(result.blocked).toBe(false);
    expect(result.text).toContain('当前有 2 项后台工作');
    expect(result.text).toMatch(/要不要我帮你清理这些后台任务？/u);
  });

  it('projects an empty verified runtime cancellation into a concise user receipt', async () => {
    const { finalizeLumiResponse } = await import('../server/cognition/result_finalizer');
    const result = finalizeLumiResponse({
      taskText: '清理这些后台任务',
      responseText: '',
      toolRecords: [{
        name: 'runtime_work_cancel',
        arguments: { taskIds: ['task-a'] },
        result: JSON.stringify({
          ok: true,
          status: 'cancelled',
          requestedTaskIds: ['task-a'],
          cancelledTaskIds: ['task-a'],
          cancellingTaskIds: [],
          notCancelledTaskIds: [],
          targetResults: [],
        }),
        terminalVerification: {
          status: 'verified',
          strategy: 'terminal_receipt',
          reason: 'server-owned runtime cancellation',
        },
        envelope: { status: 'verified_success' },
      } as any],
      source: 'chat',
    });

    expect(result.blocked).toBe(false);
    expect(result.text).toContain('已取消：task-a');
  });

  it('blocks cleanup completion when core tools failed and only unrelated reads succeeded', async () => {
    const { finalizeLumiResponse } = await import('../server/cognition/result_finalizer');
    const result = finalizeLumiResponse({
      taskText: '\u6e05\u6389\u8fd9\u4e9b\u4efb\u52a1',
      responseText: 'Completed the background task cleanup.',
      toolRecords: [{
        name: 'runtime_work_cancel',
        arguments: { taskIds: ['task-a'] },
        result: '',
        error: 'Cancellation failed.',
      }, {
        name: 'database_query',
        arguments: { query: 'SELECT * FROM commandCenterPlans' },
        result: '',
        error: 'Could not determine table name.',
      }, {
        name: 'list_directory',
        arguments: { path: '.' },
        result: JSON.stringify({ ok: true, entries: ['entry.cjs', 'node.exe'] }),
        terminalVerification: verifiedDesktopReceipt.terminalVerification,
      }, {
        name: 'search_files',
        arguments: { path: '.', pattern: 'task' },
        result: JSON.stringify({ ok: true, matches: ['runtime'] }),
        terminalVerification: verifiedDesktopReceipt.terminalVerification,
      }],
      source: 'chat',
    });

    expect(result.blocked).toBe(true);
    expect(result.reason).toContain('Missing core evidence for task_control');
  });
  it('blocks a fenced legacy tool protocol from leaking into a read-only conversation', async () => {
    const { finalizeLumiResponse } = await import('../server/cognition/result_finalizer');
    const result = finalizeLumiResponse({
      taskText: '先聊一句：你认为最需要补充什么？不要修改文件。',
      responseText: '我先读取文件。```tool\n[{"name":"read_file","arguments":{"path":"D:\\\\brief.txt"}}]\n```',
      toolRecords: [],
      source: 'chat',
    });

    expect(result.blocked).toBe(true);
    expect(result.reason).toContain('protocol leaked');
    expect(result.text).not.toContain('```tool');
  });

  it.each([
    '\u5f53\u524d\u4f1a\u8bdd\u53ea\u6302\u8f7d\u4e86\u4e24\u4e2a\u5de5\u5177\uff0c\u8bb0\u5fc6\u5e93\u68c0\u7d22\u5de5\u5177\u6ca1\u6302\u8f7d\u3002',
    '\u5f53\u524d\u804a\u5929\u6a21\u5f0f\u672c\u8eab\u6ca1\u5e26\u5de5\u5177\uff0c\u7ffb\u4e0d\u4e86\u8bb0\u5fc6\u5e93\u3002',
  ])('replaces unsupported per-session tool claims with canonical mode facts: %s', async (responseText) => {
    const { finalizeLumiResponse } = await import('../server/cognition/result_finalizer');
    const result = finalizeLumiResponse({
      taskText: '\u4f60\u73b0\u5728\u4e0d\u662f\u52a9\u624b\u6a21\u5f0f\u5417',
      responseText,
      toolRecords: [],
      source: 'command-center-chat',
    });

    expect(result.blocked).toBe(false);
    expect(result.reason).toBe('canonical_operation_mode_facts');
    expect(result.text).toContain('assistant');
    expect(result.text).not.toBe(responseText);
  });

  it('allows a truthful explanation that a routed subset is not the tool inventory', async () => {
    const { buildCapabilityMetaResponse } = await import('../server/cognition/capability_meta');
    const { finalizeLumiResponse } = await import('../server/cognition/result_finalizer');
    const responseText = buildCapabilityMetaResponse({
      text: '\u90a3\u8981\u600e\u4e48\u624d\u80fd\u8ba9\u4f60\u4f7f\u7528\u5176\u5b83\u5de5\u5177',
      operationMode: 'assistant',
      source: 'command-center-chat',
    })!;
    const result = finalizeLumiResponse({
      taskText: '\u90a3\u8981\u600e\u4e48\u624d\u80fd\u8ba9\u4f60\u4f7f\u7528\u5176\u5b83\u5de5\u5177',
      responseText,
      toolRecords: [],
      source: 'command-center-chat',
    });

    expect(result.blocked).toBe(false);
    expect(result.text).toBe(responseText);
  });

  it('does not mistake a hypothetical desktop plan for a tool-availability excuse', async () => {
    const { finalizeLumiResponse } = await import('../server/cognition/result_finalizer');
    const taskText = '意图识别验收：不要打开计算器，不要启动任何应用，也不要调用工具。你只需说明未来会怎么执行和核验。';
    const responseText = '未来会用桌面打开工具直接启动 Windows 计算器这个精确目标，不打开替代软件；随后核验窗口和进程。本轮没有执行任何动作，未调用工具。';
    const result = finalizeLumiResponse({
      taskText,
      responseText,
      toolRecords: [],
      source: 'chat',
      flow: {
        allowToolUseForTurn: false,
        completionEvidenceNeeded: false,
        clientActionOnlyTurn: false,
        selfRepairTurn: false,
      } as any,
    });

    expect(result.blocked).toBe(false);
    expect(result.text).toBe(responseText);
  });

  it('does not treat a persisted task update and matching draft as execution evidence', async () => {
    const { finalizeLumiResponse } = await import('../server/cognition/result_finalizer');
    const draft = '1. \u4efb\u52a1\u5f15\u7528\u5df2\u6838\u5bf9\n2. \u9a8c\u6536\u9700\u6c42\u5df2\u8bb0\u5f55\n3. \u804a\u5929\u4ea4\u4ed8\u5df2\u751f\u6210\n4. \u672a\u5199\u6587\u4ef6\u3001\u672a\u5916\u53d1\n5. \u540e\u7eed\u6b65\u9aa4\u4ecd\u7b49\u5f85\u786e\u8ba4';
    const responseText = `\u5df2\u5b8c\u6210\u6b65\u9aa4\uff1a\u8bb0\u5f55\u9a8c\u6536\u9700\u6c42\u2192\u751f\u6210\u6e05\u5355\n5\u9879\u68c0\u67e5\u6e05\u5355\uff1a\n${draft}\n\u5f53\u524d\u72b6\u6001\uff1awaiting_confirmation\n\u5269\u4f59\u6b65\u9aa4\uff1a\u7b49\u5f85\u786e\u8ba4`;
    const result = finalizeLumiResponse({
      taskText: '\u7ee7\u7eed\u6301\u4e45\u4efb\u52a1 wt_task_acceptance\uff0c\u4e0d\u8981\u5199\u6587\u4ef6\uff0c\u4e0d\u8981\u5916\u53d1\u3002',
      responseText,
      toolRecords: [{
        name: 'work_takeover_task_update',
        arguments: { id: 'wt_task_acceptance' },
        result: JSON.stringify({
          ok: true,
          status: 'updated',
          persisted: true,
          task: {
            id: 'wt_task_acceptance',
            status: 'waiting_confirmation',
            updatedAt: new Date().toISOString(),
            drafts: [{ text: draft }],
          },
        }),
      }],
      source: 'chat',
    });

    expect(result.blocked).toBe(true);
    expect(result.text).toContain('\u53ea\u8bc1\u660e\u4e86\u8bb0\u8d26\u6216\u72b6\u6001\u5199\u56de');
    expect(result.text).toContain('\u6ca1\u6709\u771f\u5b9e\u52a8\u4f5c\u7684\u5df2\u9a8c\u8bc1\u7ec8\u6001\u56de\u6267');
    expect(result.reason).toContain('without a verified action receipt');
  });

  it('does not apply the ledger-only completion blocker when a real action has verified terminal evidence', async () => {
    const { finalizeLumiResponse } = await import('../server/cognition/result_finalizer');
    const responseText = '\u5df2\u5b8c\u6210\u7b2c\u4e00\u6b65\u201c\u8bfb\u53d6\u5e76\u6838\u5bf9\u5ba2\u6237\u8d44\u6599\u201d\u3002';
    const result = finalizeLumiResponse({
      taskText: '\u7ee7\u7eed\u6301\u4e45\u4efb\u52a1 wt_task_acceptance\uff0c\u6267\u884c\u7b2c\u4e00\u6b65\u3002',
      responseText,
      toolRecords: [{
        name: 'customer_profile_read',
        arguments: { customerId: 'customer-1' },
        result: '{"customerId":"customer-1","verified":true}',
        terminalVerification: {
          status: 'verified',
          strategy: 'terminal_receipt',
          reason: 'Customer profile was returned and matched the target.',
        },
      }, {
        name: 'work_takeover_task_update',
        arguments: { id: 'wt_task_acceptance', currentActionIndex: 1 },
        result: '{"ok":true,"persisted":true,"status":"updated"}',
      }],
      source: 'chat',
    });

    expect(result.blocked).toBe(false);
    expect(result.reason || '').not.toContain('without a verified action receipt');
    expect(result.text).not.toContain('\u53ea\u8bc1\u660e\u4e86\u8bb0\u8d26\u6216\u72b6\u6001\u5199\u56de');
  });

  it('blocks raw legacy function-call markup from reaching the user', async () => {
    const { finalizeLumiResponse } = await import('../server/cognition/result_finalizer');
    const result = finalizeLumiResponse({
      taskText: '为我介绍客户端里的每个页面。',
      responseText: '<function_calls>\n<invoke name="client_get_state">\n</invoke>\n</function_calls>',
      toolRecords: [],
      source: 'voice',
    });

    expect(result.blocked).toBe(true);
    expect(result.text).not.toContain('<function_calls>');
    expect(result.text).toContain('没有读取到当前客户端状态');
  });

  it('blocks a fabricated prior self-check explanation without diagnostic receipts', async () => {
    const { finalizeLumiResponse } = await import('../server/cognition/result_finalizer');

    const result = finalizeLumiResponse({
      taskText: '你怎么运行了这么久才回我？',
      responseText: '刚才在跑自检，扫描 MCP 连接、组织工作区和技能链路。',
      toolRecords: [],
      source: 'voice',
    });

    expect(result.blocked).toBe(true);
    expect(result.reason).toContain('prior diagnostic run');
    expect(result.text).toContain('没有可核实的客户端自检工具回执');
  });

  it.each([
    { name: 'desktop_capture_screen', arguments: {}, result: '{"width":1280,"height":720}' },
    { name: 'client_health_check', arguments: {}, result: '{"report":{"level":"ready"}}' },
  ])('does not let current-turn receipts prove a claimed prior self-check', async (toolRecord) => {
    const { finalizeLumiResponse } = await import('../server/cognition/result_finalizer');
    const result = finalizeLumiResponse({
      taskText: '你刚才为什么那么久才回复？',
      responseText: '刚才在跑自检，检查了客户端和运行时。',
      toolRecords: [toolRecord],
      source: 'voice',
    });

    expect(result.blocked).toBe(true);
    expect(result.reason).toContain('prior diagnostic run');
  });

  it('does not let a current receipt prove a prior self-check when the question itself names self-check', async () => {
    const { finalizeLumiResponse } = await import('../server/cognition/result_finalizer');
    const result = finalizeLumiResponse({
      taskText: '你刚才是不是在跑自检？',
      responseText: '是的，刚才在跑自检，检查了客户端和运行时。',
      toolRecords: [{
        name: 'client_health_check',
        arguments: {},
        result: '{"report":{"level":"ready"}}',
      }],
      source: 'voice',
    });

    expect(result.blocked).toBe(true);
    expect(result.reason).toContain('prior diagnostic run');
    expect(result.text).not.toContain('自检完成');
  });

  it('still grounds an explicitly requested current self-check from current receipts', async () => {
    const { finalizeLumiResponse } = await import('../server/cognition/result_finalizer');
    const result = finalizeLumiResponse({
      taskText: '请现在做一次客户端自检',
      responseText: '刚刚已经完成自检。',
      toolRecords: [{
        name: 'client_health_check',
        arguments: {},
        result: '{"report":{"level":"ready"}}',
      }],
      source: 'voice',
    });

    expect(result.blocked).toBe(false);
    expect(result.reason).toContain('Grounded client diagnostic summary');
    expect(result.text).toContain('自检完成');
  });

  it.each([
    '检查一下你自己有没有问题',
    '检查一下客户端',
    '你自己检查一下',
  ])('grounds the entry-classified current self-check instead of treating it as prior: %s', async (taskText) => {
    const { finalizeLumiResponse } = await import('../server/cognition/result_finalizer');
    const result = finalizeLumiResponse({
      taskText,
      responseText: '刚刚已经完成自检。',
      toolRecords: [{
        name: 'client_health_check',
        arguments: {},
        result: '{"report":{"level":"ready"}}',
      }],
      source: 'chat',
    });

    expect(result.blocked).toBe(false);
    expect(result.reason).toContain('Grounded client diagnostic summary');
    expect(result.text).toBe('刚刚已经完成自检。');
    expect(result.reason).not.toContain('prior diagnostic run');
  });

  it.each([
    '检查一下你自己有没有问题',
    '检查一下客户端',
    '你自己检查一下',
  ])('blocks a failed client health receipt for current self-check wording: %s', async (taskText) => {
    const { finalizeLumiResponse } = await import('../server/cognition/result_finalizer');
    const result = finalizeLumiResponse({
      taskText,
      responseText: '刚刚已经完成自检。',
      toolRecords: [{
        name: 'client_health_check',
        arguments: {},
        result: '{"ok":false,"error":"health probe failed"}',
      }],
      source: 'chat',
    });

    expect(result.blocked).toBe(true);
    expect(result.reason).toContain('did not produce a successful substantive receipt');
    expect(result.text).toContain('自检未完成');
    expect(result.text).toContain('health probe failed');
    expect(result.reason).not.toContain('prior diagnostic run');
  });

  it('blocks a claimed diagnostic tool run when the current turn has no matching records', async () => {
    const { finalizeLumiResponse } = await import('../server/cognition/result_finalizer');

    const result = finalizeLumiResponse({
      taskText: '\u786e\u8ba4',
      responseText: '\u597d\u7684\uff0c\u6211\u5df2\u7ecf\u8fd0\u884c\u4e86 `client_health_check` \u548c `client_get_state`\uff0c\u72b6\u6001\u6b63\u5e38\u3002',
      toolRecords: [],
      source: 'wechat_bot',
    });

    expect(result.blocked).toBe(true);
    expect(result.reason).toContain('without matching tool records');
    expect(result.text).toContain('client_health_check');
    expect(result.text).toContain('client_get_state');
  });

  it('replaces a diagnostic narrative with a summary grounded in real records', async () => {
    const { finalizeLumiResponse } = await import('../server/cognition/result_finalizer');
    const responseText = '\u6211\u5df2\u7ecf\u8fd0\u884c\u4e86 `client_health_check` \u548c `client_get_state`\u3002';

    const result = finalizeLumiResponse({
      taskText: '\u786e\u8ba4',
      responseText,
      toolRecords: [
        { name: 'client_health_check', arguments: {}, result: '{"level":"ready"}' },
        { name: 'client_get_state', arguments: {}, result: '{"state":"ready"}' },
      ],
      source: 'wechat_bot',
    });

    expect(result.blocked).toBe(false);
    expect(result.text).toContain('\u81ea\u68c0\u5b8c\u6210');
    expect(result.text).toContain('\u5065\u5eb7\u7b49\u7ea7\uff1aready');
    expect(result.text).toContain('client_health_check');
    expect(result.text).toContain('client_get_state');
    expect(result.text).not.toBe(responseText);
  });

  it('reports a successful but irrelevant client_get_state receipt instead of claiming zero tool execution', async () => {
    const { finalizeLumiResponse } = await import('../server/cognition/result_finalizer');
    const result = finalizeLumiResponse({
      taskText: '\u5148\u67e5\u770b\u5f53\u524d\u6d3b\u52a8\u7a97\u53e3\uff0c\u518d\u5217\u51fa\u684c\u9762\u6587\u4ef6\uff0c\u6700\u540e\u544a\u8bc9\u6211\u7a97\u53e3\u6807\u9898\u548c\u6587\u4ef6\u6570\u91cf\u3002',
      responseText: '\u5df2\u5b8c\u6210\u67e5\u770b\u5f53\u524d\u6d3b\u52a8\u7a97\u53e3\u5e76\u5217\u51fa\u684c\u9762\u6587\u4ef6\u3002',
      toolRecords: [{
        name: 'client_get_state',
        arguments: {},
        result: JSON.stringify({
          selfAwareness: {
            habits: [
              'Some external actions require user confirmation.',
              '\u9700\u8981\u786e\u8ba4\u7684\u662f\u5176\u4ed6\u52a8\u4f5c\uff0c\u4e0d\u662f\u8fd9\u6b21\u72b6\u6001\u8bfb\u53d6\u3002',
            ],
          },
          capabilities: [{
            id: 'external.action',
            requiresConfirmation: true,
            notes: 'This nested capability note is descriptive metadata.',
          }],
          state: { mode: 'assistant', activeTab: 'home', runtimeStatus: 'ready' },
          health: { level: 'attention' },
        }),
      }],
      source: 'voice',
    });

    expect(result.blocked).toBe(true);
    expect(result.reason).toContain('\u6210\u529f\u6267\u884c\u4e86\u67e5\u8be2\u6216\u68c0\u67e5\u5de5\u5177');
    expect(result.text).toContain('\u5df2\u7ecf\u53d6\u5f97\u90e8\u5206\u6709\u6548\u56de\u6267');
    expect(result.text).not.toContain('client_get_state');
    expect(result.text).toContain('\u8fd8\u7f3a\u5c11\u80fd\u8bc1\u660e\u6700\u7ec8\u7ed3\u679c\u7684\u8bc1\u636e');
    expect(result.text).not.toContain('\u8fd9\u4e00\u8f6e\u6ca1\u6709\u6210\u529f\u6267\u884c\u4efb\u4f55\u5de5\u5177');
    expect(result.text).not.toContain('client_get_state: undefined');
  });

  it('does not invent a WeChat desktop limitation from a work-scope routing miss', async () => {
    const { finalizeLumiResponse } = await import('../server/cognition/result_finalizer');

    const result = finalizeLumiResponse({
      taskText: '\u4f60\u81ea\u5df1\u80fd\u591f\u4fee\u590d\u5417',
      responseText: '\u56e0\u4e3a\u6211\u4eec\u73b0\u5728\u8d70\u7684\u662f\u5fae\u4fe1\u6e20\u9053\uff0c\u6240\u4ee5\u5fae\u4fe1\u8fd9\u8fb9\u770b\u4e0d\u5230\u684c\u9762\u3002',
      toolRecords: [{
        name: 'client_health_check',
        arguments: {},
        result: JSON.stringify({
          report: {
            level: 'unknown',
            stateAgeSeconds: null,
            findings: [{ id: 'client_state_missing', message: 'No live scoped client state' }],
          },
          scope: { domain: 'work', orgId: 'org-1' },
          skillRuntimeFindings: [
            { name: 'minimax', connected: false },
            { name: 'code-sandbox', connected: false },
          ],
        }),
      }, {
        name: 'get_active_window_info',
        arguments: {},
        result: '',
        error: 'No desktop client connected for this user.',
      }, {
        name: 'desktop_running_processes',
        arguments: {},
        result: '',
        error: 'No desktop client connected for this user.',
      }, {
        name: 'client_self_repair',
        arguments: { action: 'refresh_client_state' },
        result: '',
        error: 'No desktop client connected for this user.',
      }],
      source: 'wechat_bot',
    });

    expect(result.blocked).toBe(false);
    expect(result.text).toContain('\u7ec4\u7ec7\u5de5\u4f5c\u57df');
    expect(result.text).toContain('\u4e0d\u80fd\u636e\u6b64\u65ad\u8a00');
    expect(result.text).toContain('get_active_window_info: No desktop client connected for this user.');
    expect(result.text).toContain('\u53ef\u9009\u6280\u80fd\u5f53\u524d\u672a\u8fde\u63a5\uff1aminimax\u3001code-sandbox');
    expect(result.text).not.toContain('\u56e0\u4e3a\u6211\u4eec\u73b0\u5728\u8d70\u7684\u662f\u5fae\u4fe1\u6e20\u9053');
  });

  it('reports missing diagnostic receipts instead of fabricating a self-check', async () => {
    const { finalizeLumiResponse } = await import('../server/cognition/result_finalizer');

    const result = finalizeLumiResponse({
      taskText: '\u4f60\u81ea\u68c0\u4e00\u4e0b\uff0c\u770b\u770b\u6709\u6ca1\u6709\u4ec0\u4e48\u5730\u65b9\u4e0d\u591f\u81ea\u7136\u4e0e\u901a\u7545',
      responseText: '\u5df2\u8fd0\u884c client_health_check\uff0c45/47 \u4e2a MCP \u5df2\u8fde\u63a5\u3002',
      toolRecords: [],
      source: 'wechat_bot',
    });

    expect(result.text).toContain('\u672c\u8f6e\u6ca1\u6709\u53d6\u5f97\u4efb\u4f55\u5ba2\u6237\u7aef\u81ea\u68c0\u5de5\u5177\u56de\u6267');
    expect(result.text).not.toContain('45/47');
  });

  it.each([
    ['adapter_health_check', '{"checkedCount":2,"needsAttention":[]}'],
    ['model_configuration_test', '{"ok":true,"role":"reasoning"}'],
  ])('accepts %s as a real self-check receipt', async (name, receipt) => {
    const { finalizeLumiResponse } = await import('../server/cognition/result_finalizer');
    const result = finalizeLumiResponse({
      taskText: '请做一次客户端自检',
      responseText: `已检查 ${name}。`,
      toolRecords: [{ name, arguments: {}, result: receipt }],
      source: 'chat',
    });

    expect(result.blocked).toBe(false);
    expect(result.text).toBe(`已检查 ${name}。`);
    expect(result.text).not.toContain('没有取得任何客户端自检工具回执');
  });

  it.each([
    ['desktop_ui_snapshot', '{"window":"LumiCore","nodes":[]}'],
    ['desktop_capture_screen', '{"width":1280,"height":720}'],
    ['desktop_running_processes', '{"processes":[]}'],
  ])('does not treat supporting desktop evidence as a complete self-check: %s', async (name, receipt) => {
    const { finalizeLumiResponse } = await import('../server/cognition/result_finalizer');
    const result = finalizeLumiResponse({
      taskText: '请做一次客户端自检',
      responseText: `已检查 ${name}。`,
      toolRecords: [{ name, arguments: {}, result: receipt }],
      source: 'chat',
    });

    expect(result.text).toContain('没有取得任何客户端自检工具回执');
    expect(result.text).not.toContain('自检完成');
  });

  it.each([
    ['model_configuration_test', '{"ok":false,"role":"reasoning","error":"HTTP 500"}', 'HTTP 500'],
    ['desktop_ui_snapshot', '{"status":"not_supported"}', 'not_supported'],
    ['client_repair_skill', 'Tool "client_repair_skill" requires user confirmation and was not approved.', 'user confirmation was not approved'],
  ])('records semantic diagnostic failure instead of success: %s', async (name, receipt, expectedFailure) => {
    const { finalizeLumiResponse } = await import('../server/cognition/result_finalizer');
    const result = finalizeLumiResponse({
      taskText: '请做一次客户端自检',
      responseText: `已检查 ${name}。`,
      toolRecords: [
        { name: 'client_health_check', arguments: {}, result: '{"report":{"level":"attention"}}' },
        { name, arguments: {}, result: receipt },
      ],
      source: 'chat',
    });

    expect(result.text).toContain(`未完成的检查：${name}: ${expectedFailure}`);
    expect(result.text).not.toContain(`本轮有回执的检查：${name}`);
    if (name === 'client_repair_skill') {
      expect(result.text).not.toContain('client_repair_skill: completed');
    }
  });

  it.each([
    ['client_health_check', '', 'Timeout', 'Timeout'],
    ['model_configuration_test', '{"ok":false,"role":"reasoning","error":"HTTP 500"}', undefined, 'HTTP 500'],
    ['client_repair_skill', 'Tool "client_repair_skill" requires user confirmation and was not approved.', undefined, 'user confirmation was not approved'],
  ])('blocks an all-failed diagnostic turn instead of claiming self-check completion: %s', async (
    name,
    receipt,
    error,
    expectedFailure,
  ) => {
    const { finalizeLumiResponse } = await import('../server/cognition/result_finalizer');
    const result = finalizeLumiResponse({
      taskText: '请做一次客户端自检',
      responseText: `已检查 ${name}。`,
      toolRecords: [
        { name: 'desktop_capture_screen', arguments: {}, result: '{"width":1280,"height":720}' },
        { name, arguments: {}, result: receipt, ...(error ? { error } : {}) },
      ],
      source: 'chat',
    });

    expect(result.blocked).toBe(true);
    expect(result.reason).toContain('did not produce a successful substantive receipt');
    expect(result.text).toContain('自检未完成');
    expect(result.text).toContain(expectedFailure);
    expect(result.text).not.toContain('自检完成');
    expect(result.text).not.toContain(`本轮有回执的检查：${name}`);
  });

  it('blocks unverified completion claims for concrete work', async () => {
    const { finalizeLumiResponse } = await import('../server/cognition/result_finalizer');

    const result = finalizeLumiResponse({
      taskText: 'Create a PPT file for the customer.',
      responseText: 'Created the PPT successfully.',
      toolRecords: [],
      source: 'task',
    });

    expect(result.blocked).toBe(true);
    expect(result.text).toBe('I could not complete the requested action because it never reached a successful execution.');
    expect(result.text).not.toMatch(/tool|receipt|evidence/i);
    expect(result.notification?.type).toBe('work_product_guard');
  });

  it('does not bypass the generic guard when no task contract is recognized', async () => {
    const { finalizeLumiResponse } = await import('../server/cognition/result_finalizer');

    const result = finalizeLumiResponse({
      taskText: '\u786e\u8ba4',
      responseText: '\u5df2\u65b0\u5efa\u5e76\u5199\u597d\u4e86\u3002',
      toolRecords: [],
      source: 'voice',
    });

    expect(result.blocked).toBe(true);
    expect(result.reason).toContain('\u8fd9\u4e00\u8f6e\u6ca1\u6709\u6210\u529f\u6267\u884c\u4efb\u4f55\u5de5\u5177');
    expect(result.notification?.type).toBe('work_product_guard');
  });

  it('blocks an ungrounded voice execution-status claim without a recognized contract', async () => {
    const { finalizeLumiResponse } = await import('../server/cognition/result_finalizer');

    const result = finalizeLumiResponse({
      taskText: '\u597d',
      responseText: '\u6b63\u5728\u6267\u884c\u3002',
      toolRecords: [],
      source: 'voice',
    });

    expect(result.blocked).toBe(true);
    expect(result.reason).toContain('current-turn tool execution');
    expect(result.text).toContain('\u64cd\u4f5c\u8fd8\u6ca1\u6709\u6210\u529f\u542f\u52a8');
    expect(result.text).not.toContain('No successful current-turn tool execution');
  });

  it('keeps a factual denial of tool and task execution outside the completion guard', async () => {
    const { finalizeLumiResponse } = await import('../server/cognition/result_finalizer');
    const responseText = '没有。这轮对话我没有调用任何工具，也没有创建任务，只是文字交流。';
    const result = finalizeLumiResponse({
      taskText: '这轮对话里你有没有真的执行工具或创建任务？只按事实回答。',
      responseText,
      toolRecords: [],
      source: 'chat',
    });

    expect(result.blocked).toBe(false);
    expect(result.text).toBe(responseText);
  });

  it('removes invented scheduling and reminder claims from factual restatements', async () => {
    const { finalizeLumiResponse } = await import('../server/cognition/result_finalizer');
    const result = finalizeLumiResponse({
      taskText: '现在完整说出明天这件事。',
      responseText: '明天去看硬件社区合作，重点问交付方式和数据归属。就在日程里记着了，到时候我提醒你。',
      toolRecords: [],
      source: 'chat',
    });

    expect(result.blocked).toBe(false);
    expect(result.text).toBe('明天去看硬件社区合作，重点问交付方式和数据归属。');
  });

  it('keeps ordinary knowledge answers outside the execution guard', async () => {
    const { finalizeLumiResponse } = await import('../server/cognition/result_finalizer');
    const responseText = '\u201c\u5df2\u5b8c\u6210\u201d\u8868\u793a\u52a8\u4f5c\u7ed3\u675f\uff1b\u201c\u6b63\u5728\u6267\u884c\u201d\u8868\u793a\u52a8\u4f5c\u4ecd\u5728\u8fdb\u884c\u3002';

    const result = finalizeLumiResponse({
      taskText: '\u201c\u5df2\u5b8c\u6210\u201d\u548c\u201c\u6b63\u5728\u6267\u884c\u201d\u6709\u4ec0\u4e48\u533a\u522b\uff1f',
      responseText,
      toolRecords: [],
      source: 'chat',
    });

    expect(result.blocked).toBe(false);
    expect(result.text).toBe(responseText);
  });

  it.each([
    {
      taskText: '你好 Lumi，我正在和你进行现场验收。请用两句话说明你是谁、能做什么，并明确今天只按我的指令行动。不要调用工具。',
      responseText: '我是 Lumi，你的本地私人智能体，可以和你交流、记忆上下文并在你授权时调用工具处理事务。今天我只按你的明确指令行动。',
    },
    {
      taskText: '接着刚才的验收，请记住验收代号是晨星716，只回复已记住，不执行工具。',
      responseText: '已记住。',
    },
  ])('does not apply work completion gates to an authoritative no-tool turn', async ({ taskText, responseText }) => {
    const { finalizeLumiResponse } = await import('../server/cognition/result_finalizer');
    const result = finalizeLumiResponse({
      taskText,
      responseText,
      toolRecords: [],
      source: 'chat',
      flow: {
        allowToolUseForTurn: false,
        completionEvidenceNeeded: false,
        clientActionOnlyTurn: false,
        selfRepairTurn: false,
      } as any,
    });

    expect(result.blocked).toBe(false);
    expect(result.text).toBe(responseText);
  });

  it('keeps a no-mutation follow-up question conversational even when its answer describes file work', async () => {
    const { finalizeLumiResponse } = await import('../server/cognition/result_finalizer');
    const responseText = '当前最需要客户补充的是完整的数据接口文档；我现在只做判断，不修改文件。';

    const result = finalizeLumiResponse({
      taskText: '先聊一句：你认为这份方案当前最需要客户补充的唯一信息是什么？不要修改文件。',
      responseText,
      toolRecords: [],
      source: 'chat',
      flow: { completionEvidenceNeeded: false } as any,
    });

    expect(result.blocked).toBe(false);
    expect(result.text).toBe(responseText);
  });

  it('does not mark a verified text artifact complete until exact requested text is present', async () => {
    const { finalizeLumiResponse } = await import('../server/cognition/result_finalizer');
    const root = mkdtempSync(path.join(os.tmpdir(), 'lumi-artifact-finalizer-'));
    const artifactPath = path.join(root, 'followup.md');
    try {
      writeFileSync(artifactPath, '## 已知风险\n负责人刘工\n', 'utf8');
      const record = {
        name: 'write_file',
        arguments: { path: artifactPath },
        result: `File written: ${artifactPath} (20 bytes)`,
        terminalVerification: { status: 'verified' as const, strategy: 'artifact' as const, reason: 'non-empty file verified' },
      };
      const taskText = `把刚才生成的方案改一下：在“已知风险”里明确写出“负责人：刘工”，其他事实不变，仍保存到 ${artifactPath}，修改后验证。`;
      const missing = finalizeLumiResponse({
        taskText,
        responseText: '已经修改并验证完成。',
        toolRecords: [record],
        source: 'chat',
      });
      expect(missing.blocked).toBe(true);
      expect(missing.text).toContain('缺少精确文本“负责人：刘工”');

      writeFileSync(artifactPath, '## 已知风险\n负责人：刘工\n', 'utf8');
      const satisfied = finalizeLumiResponse({
        taskText,
        responseText: '已经修改并验证完成。',
        toolRecords: [record],
        source: 'chat',
      });
      expect(satisfied.blocked).toBe(false);
      expect(satisfied.text).toContain(artifactPath);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('keeps requested encoding, line count, and full text in a same-path readback result', async () => {
    const { finalizeLumiResponse } = await import('../server/cognition/result_finalizer');
    const root = mkdtempSync(path.join(os.tmpdir(), 'lumi-artifact-readback-'));
    const artifactPath = path.join(root, 'field-test.txt');
    const content = '验收对象：Lumi 主程序\n验收项目：本地文件创建与回读\n验收代号：青穹-17';
    try {
      writeFileSync(artifactPath, content, 'utf8');
      const taskText = `请在 ${artifactPath} 新建 TXT，只写入以下三行：第一行“验收对象：Lumi 主程序”；第二行“验收项目：本地文件创建与回读”；第三行“验收代号：青穹-17”。写入后重新读取，核验 UTF-8 编码、总行数和三行全文。`;
      const result = finalizeLumiResponse({
        taskText,
        responseText: '已经完成。',
        toolRecords: [{
          name: 'write_file',
          arguments: { path: artifactPath, content },
          result: `File written: ${artifactPath}`,
          terminalVerification: { status: 'verified' as const, strategy: 'artifact' as const, reason: 'non-empty file verified' },
        }, {
          name: 'read_file',
          arguments: { path: artifactPath },
          result: content,
          terminalVerification: { status: 'verified' as const, strategy: 'terminal_receipt' as const, reason: 'read returned' },
        }],
        source: 'chat',
      });
      expect(result.blocked).toBe(false);
      expect(result.text).toContain('编码：UTF-8');
      expect(result.text).toContain('总行数：3');
      expect(result.text).toContain(content);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('blocks source-grounded artifacts that still contain dependency placeholders', async () => {
    const { finalizeLumiResponse } = await import('../server/cognition/result_finalizer');
    const root = mkdtempSync(path.join(os.tmpdir(), 'lumi-source-grounding-'));
    const artifactPath = path.join(root, 'report.md');
    const content = '# \u9a8c\u6536\u62a5\u544a\n\n\u9a8c\u6536\u5bf9\u8c61\uff1a\uff08\u6839\u636e\u6e90\u6587\u4ef6\u5185\u5bb9\u586b\u5199\uff09\n';
    try {
      writeFileSync(artifactPath, content, 'utf8');
      const result = finalizeLumiResponse({
        taskText: `\u8bf7\u8bfb\u53d6\u6e90\u6587\u4ef6\uff0c\u4ee5\u5b83\u7684\u771f\u5b9e\u5185\u5bb9\u4e3a\u552f\u4e00\u6765\u6e90\uff0c\u5728 ${artifactPath} \u521b\u5efa\u9a8c\u6536\u62a5\u544a\u5e76\u56de\u8bfb\u3002`,
        responseText: '\u5df2\u5b8c\u6210\u3002',
        toolRecords: [{
          name: 'write_file',
          arguments: { path: artifactPath, content },
          result: `File written: ${artifactPath}`,
          terminalVerification: { status: 'verified' as const, strategy: 'artifact' as const, reason: 'non-empty file verified' },
        }, {
          name: 'read_file',
          arguments: { path: artifactPath },
          result: content,
          terminalVerification: { status: 'verified' as const, strategy: 'terminal_receipt' as const, reason: 'read returned' },
        }],
        source: 'chat',
      });
      expect(result.blocked).toBe(true);
      expect(result.reason).toContain('unresolved placeholders');
      expect(result.text).toContain('\u4e0d\u80fd\u62a5\u544a\u5b8c\u6210');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('reports UTF-8 encoding, line count, and full text for a Chinese readback request', async () => {
    const { finalizeLumiResponse } = await import('../server/cognition/result_finalizer');
    const root = mkdtempSync(path.join(os.tmpdir(), 'lumi-chinese-readback-'));
    const artifactPath = path.join(root, 'report.md');
    const content = '# \u9a8c\u6536\u62a5\u544a\n\n\u9a8c\u6536\u5bf9\u8c61\uff1aLumi \u4e3b\u7a0b\u5e8f\n';
    try {
      writeFileSync(artifactPath, content, 'utf8');
      const result = finalizeLumiResponse({
        taskText: `\u5728 ${artifactPath} \u521b\u5efa\u62a5\u544a\uff0c\u5199\u5165\u540e\u91cd\u65b0\u8bfb\u53d6\uff0c\u6700\u540e\u62a5\u544a\u7f16\u7801\u3001\u603b\u884c\u6570\u548c\u5168\u6587\u3002`,
        responseText: '\u5df2\u5b8c\u6210\u3002',
        toolRecords: [{
          name: 'write_file',
          arguments: { path: artifactPath, content },
          result: `File written: ${artifactPath}`,
          terminalVerification: { status: 'verified' as const, strategy: 'artifact' as const, reason: 'non-empty file verified' },
        }, {
          name: 'read_file',
          arguments: { path: artifactPath },
          result: content,
          terminalVerification: { status: 'verified' as const, strategy: 'terminal_receipt' as const, reason: 'read returned' },
        }],
        source: 'chat',
      });
      expect(result.blocked).toBe(false);
      expect(result.text).toContain('\u7f16\u7801\uff1aUTF-8');
      expect(result.text).toContain('\u603b\u884c\u6570\uff1a3');
      expect(result.text).toContain(content.replace(/\n$/, ''));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('grounds native semantic text writes from the same shared artifact receipts', async () => {
    const { finalizeLumiResponse } = await import('../server/cognition/result_finalizer');
    const root = mkdtempSync(path.join(os.tmpdir(), 'lumi-native-artifact-finalizer-'));
    const artifactPath = path.join(root, 'native-note.txt');
    const content = 'native semantic write';
    try {
      writeFileSync(artifactPath, content, 'utf8');
      const result = finalizeLumiResponse({
        taskText: `After creating the file, read it back and report the exact content. Target: ${artifactPath}`,
        responseText: 'The file and readback are complete.',
        toolRecords: [{
          name: 'desktop_write_text_file',
          arguments: { path: artifactPath, content },
          result: JSON.stringify({ ok: true, status: 'verified', path: artifactPath, readBackMatched: true }),
          terminalVerification: { status: 'verified' as const, strategy: 'measured' as const, reason: 'native byte read-back matched' },
        }, {
          name: 'read_file',
          arguments: { path: artifactPath },
          result: content,
          terminalVerification: { status: 'verified' as const, strategy: 'terminal_receipt' as const, reason: 'text read returned' },
        }],
        source: 'chat',
      });

      expect(result.blocked).toBe(false);
      expect(result.text).toContain(artifactPath);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.each([
    '我正在继续改进自己的任务理解和执行能力。',
    '我现在就开始检查自己哪些能力还需要提升。',
  ])('keeps a reflective ability self-assessment outside the execution guard: %s', async (responseText) => {
    const { finalizeLumiResponse } = await import('../server/cognition/result_finalizer');

    const result = finalizeLumiResponse({
      taskText: '你对目前自己的能力是否满意',
      responseText,
      toolRecords: [],
      source: 'chat',
    });

    expect(result.blocked).toBe(false);
    expect(result.text).toBe(responseText);
  });

  it('keeps reflective capability-building completion conversational for the original typoed question', async () => {
    const { finalizeLumiResponse } = await import('../server/cognition/result_finalizer');
    const responseText = '我已经完成了基础能力建设，但还不够满意。';

    const result = finalizeLumiResponse({
      taskText: '你对目前自己的能提是否满意',
      responseText,
      toolRecords: [],
      source: 'chat',
    });

    expect(result.blocked).toBe(false);
    expect(result.text).toBe(responseText);
  });

  it('does not replace a missing-reply explanation with a file-reading guard', async () => {
    const { finalizeLumiResponse } = await import('../server/cognition/result_finalizer');
    const responseText = '抱歉，我先检查一下刚才的对话和响应状态，再给你明确答复。';

    const result = finalizeLumiResponse({
      taskText: '为什么不回我',
      responseText,
      toolRecords: [],
      source: 'chat',
    });

    expect(result.blocked).toBe(false);
    expect(result.text).toBe(responseText);
  });

  it('does not correct a mismatched desktop-open receipt into success', async () => {
    const { finalizeLumiResponse } = await import('../server/cognition/result_finalizer');

    const result = finalizeLumiResponse({
      taskText: '\u6253\u5f00 AutoCAD\u3002',
      responseText: '\u5df2\u6253\u5f00 AutoCAD\u3002',
      toolRecords: [{
        name: 'desktop_open',
        arguments: { target: 'mspaint.exe' },
        result: JSON.stringify({ ok: true, status: 'opened', target: 'mspaint.exe' }),
      }],
      source: 'chat',
    });

    expect(result.blocked).toBe(true);
    expect(result.reason).toBe('Missing core evidence for desktop_operation.');
    expect(result.text).not.toBe('\u5df2\u6253\u5f00 AutoCAD\u3002');
  });

  it('keeps model-authored chat wording unchanged when the success receipt is grounded', async () => {
    const { finalizeLumiResponse } = await import('../server/cognition/result_finalizer');
    const responseText = '嗯，AutoCAD 已经替你打开了。';
    const result = finalizeLumiResponse({
      taskText: '打开 AutoCAD。',
      responseText,
      toolRecords: [{
        name: 'desktop_open',
        arguments: { target: 'AutoCAD' },
        result: JSON.stringify({
          ok: true,
          status: 'verified',
          target: 'AutoCAD',
          targetMatched: true,
          actualTarget: { processName: 'acad.exe', title: 'Autodesk AutoCAD' },
        }),
      }],
      source: 'chat',
    });

    expect(result.blocked).toBe(false);
    expect(result.text).toBe(responseText);
    expect(result.reason).not.toContain('Model-authored wording preserved');
  });

  it('keeps a natural paraphrase without requiring every receipt detail to be repeated', async () => {
    const { finalizeLumiResponse } = await import('../server/cognition/result_finalizer');
    const responseText = '搞定啦，记事本窗口已经在前台。';
    const result = finalizeLumiResponse({
      taskText: '打开记事本。',
      responseText,
      toolRecords: [{
        name: 'desktop_open',
        arguments: { target: '记事本' },
        result: JSON.stringify({
          ok: true,
          status: 'verified',
          target: '记事本',
          targetMatched: true,
          actualTarget: { processName: 'notepad.exe', title: '无标题 - 记事本' },
        }),
      }],
      source: 'chat',
    });

    expect(result.blocked).toBe(false);
    expect(result.text).toBe(responseText);
  });

  it('keeps an exact desktop-open receipt successful even if the model hits its tool limit', async () => {
    const { finalizeLumiResponse } = await import('../server/cognition/result_finalizer');

    const result = finalizeLumiResponse({
      taskText: '\u6253\u5f00 AutoCAD\u3002',
      responseText: '\u8fd9\u8f6e\u5de5\u5177\u5904\u7406\u6b21\u6570\u5230\u4e0a\u9650\u4e86\uff0c\u6211\u8fd8\u6ca1\u6709\u5b8c\u6210\u3002',
      toolRecords: [{
        name: 'desktop_open',
        arguments: { target: 'AutoCAD' },
        result: JSON.stringify({
          ok: true,
          status: 'verified',
          target: 'AutoCAD',
          targetMatched: true,
          actualTarget: {
            processName: 'acad.exe',
            title: 'Autodesk AutoCAD',
          },
        }),
      }],
      source: 'chat',
    });

    expect(result.blocked).toBe(false);
    expect(result.text).toContain('AutoCAD');
    expect(result.text).toContain('\u5df2\u6253\u5f00');
    expect(result.reason).toContain('exact desktop-open success');
  });

  it('uses a verified client navigation receipt even when model narration says it failed', async () => {
    const { finalizeLumiResponse } = await import('../server/cognition/result_finalizer');

    const result = finalizeLumiResponse({
      taskText: '打开 Lumi 指挥中心。只执行客户端内置导航，不做其他操作。',
      responseText: '这次还没完成，没有可验证结果。',
      toolRecords: [{
        name: 'client_action',
        arguments: { action: 'open_command_center' },
        result: JSON.stringify({
          ok: true,
          action: 'open_command_center',
          target: 'command-center',
          relayResult: { ok: true, action: 'open_command_center', view: 'office' },
          verification: {
            status: 'verified',
            matched: ['surface:command-center:open'],
            missing: [],
            message: 'Lumi command center is open.',
          },
          say: 'Lumi command center is open.',
        }),
      }],
      source: 'chat',
      flow: { clientActionOnlyTurn: true } as any,
    });

    expect(result.blocked).toBe(false);
    expect(result.text).toContain('指挥中心');
    expect(result.text).toContain('已打开');
    expect(result.reason).toContain('verified state-diff receipt');
    expect(result.reason).toContain('Structured evidence correction');
  });

  it('blocks a claimed client mode switch when the current turn has no action receipt', async () => {
    const { finalizeLumiResponse } = await import('../server/cognition/result_finalizer');
    const result = finalizeLumiResponse({
      taskText: '\u5207\u6362\u5ba2\u6237\u7aef\u804a\u5929\u6a21\u5f0f',
      responseText: '\u5df2\u7ecf\u5207\u6362\u5230\u804a\u5929\u6a21\u5f0f\u3002',
      toolRecords: [],
      source: 'chat',
      flow: { clientActionOnlyTurn: true, requestedMode: 'chat' } as any,
    });

    expect(result.blocked).toBe(true);
  });

  it('completes a client mode switch from an exact verified client_action receipt', async () => {
    const { finalizeLumiResponse } = await import('../server/cognition/result_finalizer');
    const result = finalizeLumiResponse({
      taskText: '\u5207\u6362\u5ba2\u6237\u7aef\u804a\u5929\u6a21\u5f0f',
      responseText: '\u8fd9\u6b21\u8fd8\u6ca1\u6709\u5b8c\u6210\u3002',
      toolRecords: [{
        name: 'client_action',
        arguments: { action: 'set_client_mode', mode: 'chat' },
        result: JSON.stringify({
          ok: true,
          action: 'set_client_mode',
          mode: 'chat',
          verification: { status: 'verified' },
        }),
      }],
      source: 'chat',
      flow: { clientActionOnlyTurn: true, requestedMode: 'chat' } as any,
    });

    expect(result.blocked).toBe(false);
  });

  it('does not complete a client mode switch from a verified receipt for another client action', async () => {
    const { finalizeLumiResponse } = await import('../server/cognition/result_finalizer');
    const result = finalizeLumiResponse({
      taskText: '\u5207\u6362\u5ba2\u6237\u7aef\u804a\u5929\u6a21\u5f0f',
      responseText: '\u5df2\u7ecf\u5207\u6362\u5230\u804a\u5929\u6a21\u5f0f\u3002',
      toolRecords: [{
        name: 'client_action',
        arguments: { action: 'open_command_center' },
        result: JSON.stringify({
          ok: true,
          action: 'open_command_center',
          target: 'command-center',
          verification: { status: 'verified' },
        }),
      }],
      source: 'chat',
      flow: { clientActionOnlyTurn: true, requestedMode: 'chat' } as any,
    });

    expect(result.blocked).toBe(true);
  });

  it('treats explicit no-input and no-substitute clauses as open constraints, not remaining work', async () => {
    const { finalizeLumiResponse } = await import('../server/cognition/result_finalizer');

    const result = finalizeLumiResponse({
      taskText: '打开记事本，只打开，不输入任何内容，也不要打开替代软件。',
      responseText: '已打开记事本。',
      toolRecords: [{
        name: 'desktop_open',
        arguments: { target: '记事本' },
        result: JSON.stringify({
          ok: true,
          status: 'verified',
          target: '记事本',
          targetMatched: true,
          actualTarget: { title: '无标题 - 记事本', processName: 'notepad.exe' },
        }),
        terminalVerification: { status: 'verified', strategy: 'state_diff', reason: 'target matched' },
      }, {
        name: 'desktop_active_window',
        arguments: {},
        result: JSON.stringify({ title: '无标题 - 记事本', process_name: 'notepad.exe' }),
      }],
      source: 'chat',
    });

    expect(result.blocked).toBe(false);
    expect(result.text).toContain('已打开');
    expect(result.text).toContain('记事本');
    expect(result.text).not.toContain('后续操作');
  });

  it('matches a Chinese Notepad request to the verified native process receipt', async () => {
    const { finalizeLumiResponse } = await import('../server/cognition/result_finalizer');

    const result = finalizeLumiResponse({
      taskText: '\u6253\u5f00\u8bb0\u4e8b\u672c\uff0c\u53ea\u6253\u5f00\uff0c\u4e0d\u8f93\u5165\u4efb\u4f55\u5185\u5bb9\uff0c\u4e5f\u4e0d\u8981\u6253\u5f00\u66ff\u4ee3\u8f6f\u4ef6\u3002',
      responseText: '\u5df2\u6253\u5f00\u8bb0\u4e8b\u672c\u3002',
      source: 'chat',
      toolRecords: [{
        id: 'qc-notepad-native',
        name: 'desktop_open',
        arguments: { target: '\u8bb0\u4e8b\u672c' },
        result: JSON.stringify({
          ok: true,
          status: 'verified',
          target: '\u8bb0\u4e8b\u672c',
          targetMatched: true,
          actualTarget: { title: '\u65e0\u6807\u9898 - \u8bb0\u4e8b\u672c', processName: 'notepad.exe' },
          verification: { status: 'verified' },
        }),
        terminalVerification: {
          status: 'verified',
          strategy: 'state_diff',
          reason: 'Exact target focused.',
        },
      }],
    });

    expect(result.blocked).toBe(false);
    expect(result.text).toBe('\u5df2\u6253\u5f00\u8bb0\u4e8b\u672c\u3002');
    expect(result.reason).toContain('exact desktop-open success');
  });

  it('accepts a verified Windows Calculator window even when the host process is generic', async () => {
    const { finalizeLumiResponse } = await import('../server/cognition/result_finalizer');
    const result = finalizeLumiResponse({
      taskText: '现在请打开 Windows 计算器。只打开计算器并核验窗口确实出现，不输入任何数字，不打开替代软件。',
      responseText: '已打开 Windows 计算器。',
      source: 'chat',
      toolRecords: [{
        name: 'desktop_open',
        arguments: { target: '计算器' },
        result: JSON.stringify({
          ok: true,
          status: 'verified',
          target: '计算器',
          targetMatched: true,
          actualTarget: { title: '计算器', processName: 'ApplicationFrameHost.exe' },
        }),
        terminalVerification: { status: 'verified', strategy: 'state_diff', reason: 'target matched' },
      }],
    });

    expect(result.blocked).toBe(false);
    expect(result.text).toContain('已打开');
    expect(result.text).not.toContain('后续操作');
  });

  it('blocks the real WPS false-success ledger instead of accepting write_file as in-app editing', async () => {
    const { finalizeLumiResponse } = await import('../server/cognition/result_finalizer');
    const taskText = [
      '\u5728\u8fd9\u91cc\u9762\u65b0\u5efa\u4e00\u4e2a\u7a7a\u767d\u6587\u6863\u5e76\u5199\u5165\uff1aLumi\u7aef\u5230\u7aef\u56de\u5f52\u6d4b\u8bd5\u3002',
      '## Recent action continuation context',
      'Recovered structured action state:',
      '- appTarget: WPS Office',
      '- unfinished: yes',
    ].join('\n');
    const result = finalizeLumiResponse({
      taskText,
      responseText: '\u5df2\u5728 WPS \u65b0\u5efa\u7a7a\u767d\u6587\u6863\uff0c\u8f93\u5165\u5185\u5bb9\u5e76\u4fdd\u5b58\u6210\u529f\u3002',
      toolRecords: [{
        name: 'desktop_open',
        arguments: { target: 'WPS' },
        result: JSON.stringify({
          ok: true,
          status: 'verified',
          target: 'WPS',
          targetMatched: true,
          actualTarget: { processName: 'wps.exe', title: 'WPS Office' },
        }),
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
        arguments: { path: 'D:\\LumiCore\\Lumi\u7aef\u5230\u7aef\u56de\u5f52\u6d4b\u8bd5.txt' },
        result: 'File written: D:\\LumiCore\\Lumi\u7aef\u5230\u7aef\u56de\u5f52\u6d4b\u8bd5.txt',
      }],
      source: 'chat',
    });

    expect(result.blocked).toBe(true);
    expect(result.reason).toBe('Missing verified in-app UI mutation evidence.');
    expect(result.text).not.toContain('\u4fdd\u5b58\u6210\u529f');
  });

  it.each([
    { source: 'voice', taskText: '\u7ee7\u7eed' },
    { source: 'task', taskText: '\u786e\u8ba4' },
  ])('uses recovered WPS route context for a $source finalizer mismatch', async ({ source, taskText }) => {
    const { finalizeLumiResponse } = await import('../server/cognition/result_finalizer');
    const routeText = [
      '\u5728\u8fd9\u91cc\u9762\u65b0\u5efa\u4e00\u4e2a\u7a7a\u767d\u6587\u6863\u5e76\u5199\u5165\uff1aLumi \u8fde\u7eed\u4efb\u52a1\u56de\u5f52\u3002',
      '## Recent action continuation context',
      'Recovered structured action state:',
      '- appTarget: WPS Office',
      '- unfinished: yes',
    ].join('\n');

    const result = finalizeLumiResponse({
      taskText,
      responseText: '\u5df2\u5b8c\u6210\uff0c\u6587\u6863\u5df2\u65b0\u5efa\u5e76\u5199\u597d\u3002',
      toolRecords: [{
        name: 'write_file',
        arguments: { path: 'D:\\LumiCore\\Lumi-continuation.txt' },
        result: 'File written: D:\\LumiCore\\Lumi-continuation.txt',
      }],
      source,
      flow: { routeText } as any,
    });

    expect(result.blocked).toBe(true);
    expect(result.reason).toBe('Missing verified in-app UI mutation evidence.');
    expect(result.text).not.toBe('\u5df2\u5b8c\u6210\uff0c\u6587\u6863\u5df2\u65b0\u5efa\u5e76\u5199\u597d\u3002');
  });

  it('blocks an extra WPS save claim when create/type passed but save was not verified', async () => {
    const { finalizeLumiResponse } = await import('../server/cognition/result_finalizer');
    const taskText = [
      '\u5728\u8fd9\u91cc\u9762\u65b0\u5efa\u4e00\u4e2a\u7a7a\u767d\u6587\u6863\u5e76\u5199\u5165\uff1aLumi\u7aef\u5230\u7aef\u56de\u5f52\u6d4b\u8bd5\u3002',
      '## Recent action continuation context',
      '- appTarget: WPS Office',
    ].join('\n');
    const result = finalizeLumiResponse({
      taskText,
      responseText: '\u5df2\u5728 WPS \u65b0\u5efa\u3001\u5199\u5165\u5e76\u4fdd\u5b58\u6210\u529f\u3002',
      toolRecords: [{
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
      }],
      source: 'chat',
    });

    expect(result.blocked).toBe(true);
    expect(result.reason).toBe('Missing verified in-app save evidence.');
    expect(result.text).not.toContain('\u4fdd\u5b58\u6210\u529f');
  });

  it.each([
    {
      responseText: '\u8fd9\u8f6e\u5de5\u5177\u5904\u7406\u6b21\u6570\u5230\u4e0a\u9650\u4e86\uff0c\u6211\u8fd8\u6ca1\u6709\u5b8c\u6210\u3002',
      expectedReason: 'Tool iteration limit reached',
    },
    {
      responseText: 'WPS \u6587\u6863\u8fd8\u6ca1\u6709\u5b8c\u6210\u3002',
      expectedReason: 'Execution remained incomplete',
    },
  ])('marks an unresolved WPS execution as blocked: $responseText', async ({
    responseText,
    expectedReason,
  }) => {
    const { finalizeLumiResponse } = await import('../server/cognition/result_finalizer');
    const routeText = [
      '\u5728\u8fd9\u91cc\u9762\u65b0\u5efa\u4e00\u4e2a\u7a7a\u767d\u6587\u6863\u5e76\u5199\u5165\uff1aLumi\u7aef\u5230\u7aef\u56de\u5f52\u6d4b\u8bd5\u3002',
      '## Recent action continuation context',
      'Recovered structured action state:',
      '- followupIntent: execute',
      '- appTarget: WPS',
      '- unfinished: yes',
    ].join('\n');
    const result = finalizeLumiResponse({
      taskText: routeText,
      responseText,
      toolRecords: [{
        name: 'desktop_active_window',
        arguments: {},
        result: JSON.stringify({
          ok: true,
          processName: 'wps.exe',
          windowTitle: 'WPS Writer',
        }),
      }, {
        name: 'wps_create_document_with_text',
        arguments: { text: 'Lumi\u7aef\u5230\u7aef\u56de\u5f52\u6d4b\u8bd5' },
        result: '',
        error: 'WPS execution did not produce a verified receipt.',
      }],
      source: 'chat',
    });

    expect(result.blocked).toBe(true);
    expect(result.reason).toContain(expectedReason);
    expect(result.text).toBe(responseText);
    expect(result.notification?.type).toBe('work_product_guard');
  });

  it('allows a WPS create/type/save claim only after post-save document evidence', async () => {
    const { finalizeLumiResponse } = await import('../server/cognition/result_finalizer');
    const taskText = [
      '\u5728\u8fd9\u91cc\u9762\u65b0\u5efa\u4e00\u4e2a\u7a7a\u767d\u6587\u6863\u5e76\u5199\u5165\uff1aLumi\u7aef\u5230\u7aef\u56de\u5f52\u6d4b\u8bd5\u3002',
      '## Recent action continuation context',
      '- appTarget: WPS Office',
    ].join('\n');
    const responseText = '\u5df2\u5728 WPS \u65b0\u5efa\u3001\u5199\u5165\u5e76\u4fdd\u5b58\u6210\u529f\u3002';
    const result = finalizeLumiResponse({
      taskText,
      responseText,
      toolRecords: [{
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
      }, {
        name: 'desktop_keyboard_press',
        arguments: { key: 'ctrl+s' },
        result: 'Pressed: ctrl+s',
      }, {
        name: 'desktop_ui_snapshot',
        arguments: { root: 'active' },
        result: '{"root":{"name":"Lumi\u7aef\u5230\u7aef\u56de\u5f52\u6d4b\u8bd5.docx - WPS Office"}}',
      }],
      source: 'chat',
    });

    expect(result.blocked).toBe(false);
    expect(result.text).toBe(responseText);
  });

  it('allows completion claims when producing tools provide evidence', async () => {
    const { finalizeLumiResponse } = await import('../server/cognition/result_finalizer');

    const result = finalizeLumiResponse({
      taskText: 'Create a PPT file for the customer.',
      responseText: 'Created the PPT successfully.',
      toolRecords: [{
        name: 'create_ppt',
        arguments: { title: 'Customer deck' },
        result: 'created: D:\\\\tmp\\\\customer.pptx',
      }],
      source: 'task',
    });

    expect(result.blocked).toBe(false);
    expect(result.text).toBe('Created the PPT successfully.');
  });

  it('blocks action promises when no tool evidence exists', async () => {
    const { finalizeLumiResponse } = await import('../server/cognition/result_finalizer');

    const result = finalizeLumiResponse({
      taskText: 'Please open and review this contract file from the buyer side.',
      responseText: 'Let me first read the file content, then I will review it from the buyer side.',
      toolRecords: [],
      source: 'chat',
    });

    expect(result.blocked).toBe(true);
    expect(result.text).toContain('never reached a successful execution');
  });

  it('blocks a runtime-repair plan when no tool actually started', async () => {
    const { finalizeLumiResponse } = await import('../server/cognition/result_finalizer');

    const result = finalizeLumiResponse({
      taskText: '\u91cd\u542f\u540e\u7aef\u8fdb\u7a0b\u3002',
      responseText: '\u597d\u7684\uff0c\u5148\u770b\u770b\u5f53\u524d\u540e\u7aef\u8fdb\u7a0b\u7684\u72b6\u6001\u3002',
      toolRecords: [],
      source: 'voice',
    });

    expect(result.blocked).toBe(true);
    expect(result.text).toContain('\u53ea\u8bf4\u4e86\u65b9\u6848');
    expect(result.text).toContain('\u5b9e\u9645\u8fd8\u6ca1\u5f00\u59cb');
  });

  it('blocks Chinese read/review promises when no tool evidence exists', async () => {
    const { finalizeLumiResponse } = await import('../server/cognition/result_finalizer');

    const result = finalizeLumiResponse({
      taskText: '\u9700\u8981\u4f60\u6253\u5f00\u5ba1\u67e5\u4e00\u4e0b\u8fd9\u4efd\u5408\u540c\u534f\u8bae\uff0c\u7ad9\u5728\u4e59\u65b9\u89d2\u5ea6\u7ed9\u51fa\u4fee\u6539\u610f\u89c1',
      responseText: '\u597d\u7684\uff0c\u6211\u5148\u8bfb\u53d6\u8fd9\u4efd\u534f\u8bae\u7684\u5185\u5bb9\uff0c\u7136\u540e\u4ece\u4e59\u65b9\u89d2\u5ea6\u9010\u6761\u5ba1\u67e5\u3002\u8ba9\u6211\u5148\u770b\u770b\u6587\u4ef6\u5185\u5bb9\u3002',
      toolRecords: [],
      source: 'chat',
    });

    expect(result.blocked).toBe(true);
    expect(result.text).toContain('\u6ca1\u6709\u771f\u6b63\u5f00\u59cb\u8bfb\u53d6');
    expect(result.text).toContain('\u6ca1\u6709\u5b9e\u9645\u8bfb\u5230\u6587\u4ef6\u5185\u5bb9');
  });

  it('does not treat a directory listing as read/review evidence', async () => {
    const { finalizeLumiResponse } = await import('../server/cognition/result_finalizer');

    const result = finalizeLumiResponse({
      taskText: 'Please open and review this contract file from the buyer side.',
      responseText: 'Let me first read the file content, then I will review it from the buyer side.',
      toolRecords: [{
        name: 'desktop_list_files',
        arguments: { path: 'C:\\Users\\me\\Desktop' },
        result: '[{"name":"contract.docx","path":"C:\\\\Users\\\\me\\\\Desktop\\\\contract.docx","type":"file"}]',
      }],
      source: 'chat',
    });

    expect(result.blocked).toBe(true);
    expect(result.text).toContain('available result does not confirm it');
    expect(result.reason).toContain('content-read/open/review');
  });

  it('keeps blocked autonomous task results compact', async () => {
    const { finalizeLumiResponse } = await import('../server/cognition/result_finalizer');

    const result = finalizeLumiResponse({
      taskText: '\u6253\u5f00\u5fae\u4fe1\u7ed9\u963f\u9646\u53d1\u665a\u5b89',
      responseText: 'Completed successfully.',
      toolRecords: [{
        name: 'desktop_open',
        arguments: { target: '\u5fae\u4fe1' },
        result: '',
        error: 'Desktop tool "desktop_open" timed out (30s)',
      }],
      source: 'task',
    });

    expect(result.blocked).toBe(true);
    expect(result.text).toContain('\u8fd9\u6b21\u8fd8\u6ca1\u5b8c\u6210');
    expect(result.text).toContain('\u6253\u5f00\u6216\u805a\u7126\u76ee\u6807\u7a97\u53e3');
    expect(result.text).toContain('\u7a97\u53e3\u56de\u6267\u65f6\u8d85\u65f6');
    expect(result.text).not.toContain('timed out');
    expect(result.text).not.toContain('\u56de\u590d\u58f0\u79f0');
    expect(result.text).not.toContain('\u76ee\u524d\u80fd\u786e\u8ba4\u7684\u6210\u529f\u6b65\u9aa4');
  });

  it('surfaces an actionable visual-provider account blocker for desktop launch verification', async () => {
    const { finalizeLumiResponse } = await import('../server/cognition/result_finalizer');
    const result = finalizeLumiResponse({
      taskText: '打开记事本，只打开，不输入任何内容，也不要打开替代软件。',
      responseText: '这次没有完成。',
      toolRecords: [{
        name: 'desktop_open',
        arguments: { target: '记事本' },
        result: '',
        error: 'Qwen Vision returned 400 Access denied, please make sure your account is in good standing',
      }],
      source: 'chat',
    });

    expect(result.blocked).toBe(true);
    expect(result.text).toContain('视觉核验服务拒绝了请求');
    expect(result.text).toContain('账号状态、余额和访问权限');
  });

  it('keeps blocked foreground WeChat desktop results in messaging context', async () => {
    const { finalizeLumiResponse } = await import('../server/cognition/result_finalizer');

    const result = finalizeLumiResponse({
      taskText: '\u6253\u5f00\u5fae\u4fe1\u7ed9\u963f\u9646\u53d1\u665a\u5b89',
      responseText: 'Completed successfully.',
      toolRecords: [{
        name: 'desktop_open',
        arguments: { target: '\u5fae\u4fe1' },
        result: '',
        error: 'Desktop tool "desktop_open" timed out (30s)',
      }],
      source: 'chat',
    });

    expect(result.blocked).toBe(true);
    expect(result.text).toContain('\u8fd9\u6b21\u8fd8\u6ca1\u5b8c\u6210');
    expect(result.text).toContain('\u5fae\u4fe1\u53d1\u9001');
    expect(result.text).not.toContain('\u8bfb\u53d6\u6216\u5ba1\u67e5');
    expect(result.text).not.toContain('\u53ef\u8bfb\u53d6\u7684\u6587\u4ef6');
  });

  it('keeps blocked foreground WeChat chat reads out of send wording', async () => {
    const { finalizeLumiResponse } = await import('../server/cognition/result_finalizer');

    const result = finalizeLumiResponse({
      taskText: '\u6253\u5f00\u5fae\u4fe1\u770b\u770b\u6211\u548c\u963f\u9646\u6700\u8fd1\u7684\u804a\u5929\u5185\u5bb9',
      responseText: '\u6211\u5df2\u7ecf\u770b\u5230\u4e86\u6700\u8fd1\u804a\u5929\u5185\u5bb9\u3002',
      toolRecords: [{
        name: 'desktop_open',
        arguments: { target: '\u5fae\u4fe1' },
        result: 'Focused WeChat',
      }],
      source: 'chat',
    });

    expect(result.blocked).toBe(true);
    expect(result.text).toContain('\u5f53\u524d\u804a\u5929');
    expect(result.text).not.toContain('wechat_read_recent_chat');
    expect(result.text).toContain('\u5df2\u8bfb\u5230\u804a\u5929\u5185\u5bb9');
    expect(result.text).not.toContain('\u5fae\u4fe1\u53d1\u9001\u8bf4\u6210\u5df2\u53d1\u9001');
  });

  it('keeps the current desktop task isolated from a stale messaging response', async () => {
    const { finalizeLumiResponse } = await import('../server/cognition/result_finalizer');

    const result = finalizeLumiResponse({
      taskText: '\u8bf7\u53ea\u8bfb\u53d6\u5f53\u524d\u6d3b\u52a8\u7a97\u53e3\u6807\u9898\u548c\u684c\u9762\u8fd0\u884c\u72b6\u6001\uff0c\u4e0d\u8981\u70b9\u51fb\u6216\u8f93\u5165',
      responseText: '\u8fd8\u6ca1\u5b8c\u6210\u5fae\u4fe1\u804a\u5929\u8bfb\u53d6\uff0c\u9700\u8981 wechat_read_recent_chat \u8bc1\u636e\u3002',
      toolRecords: [{
        name: 'desktop_active_window',
        arguments: {},
        result: '{"title":"LumiCore","process_name":"lumi-core.exe","pid":3928,"width":1920,"height":1080}',
        ...verifiedDesktopReceipt,
      }, {
        name: 'desktop_running_processes',
        arguments: { top: 20 },
        result: '[{"pid":3928,"name":"lumi-core.exe"},{"pid":22920,"name":"msedge.exe"}]',
        ...verifiedDesktopReceipt,
      }, {
        name: 'desktop_idle_time',
        arguments: {},
        result: '{"idle_seconds":160}',
        ...verifiedDesktopReceipt,
      }],
      source: 'chat',
    });

    expect(result.blocked).toBe(false);
    expect(result.reason).toContain('action-contract drift');
    expect(result.text).toContain('\u5f53\u524d\u6d3b\u52a8\u7a97\u53e3\uff1aLumiCore');
    expect(result.text).toContain('lumi-core.exe');
    expect(result.text).toContain('\u672c\u8f6e\u6ca1\u6709\u6267\u884c\u70b9\u51fb');
    expect(result.text).not.toContain('\u5fae\u4fe1');
    expect(result.text).not.toContain('wechat_read_recent_chat');
  });

  it('keeps successful process evidence when an irrelevant auxiliary write fails later', async () => {
    const { finalizeLumiResponse } = await import('../server/cognition/result_finalizer');
    const result = finalizeLumiResponse({
      taskText: '做个桌面程序检查',
      responseText: '这次还没有完成，因为 write_file 失败了。',
      toolRecords: [{
        name: 'desktop_running_processes',
        arguments: { top: 20 },
        result: '[{"pid":3928,"name":"lumi-core.exe"},{"pid":22920,"name":"msedgewebview2.exe"}]',
        ...verifiedDesktopReceipt,
      }, {
        name: 'write_file',
        arguments: {},
        result: '',
        error: 'write_file requires a file path',
      }],
      source: 'task',
    });

    expect(result.blocked).toBe(false);
    expect(result.text).toContain('运行快照');
    expect(result.text).toContain('lumi-core.exe');
    expect(result.text).not.toContain('write_file');
  });

  it('grounds external AI history status in the persistent sync receipt instead of model narration', async () => {
    const { finalizeLumiResponse } = await import('../server/cognition/result_finalizer');
    const result = finalizeLumiResponse({
      taskText: 'Sync the ChatGPT chat history from the authorized source.',
      responseText: 'Everything in the account was imported completely.',
      toolRecords: [{
        name: 'external_ai_history_sync',
        arguments: { sourceId: 'history-source-1' },
        result: JSON.stringify({
          ok: true,
          verified: true,
          verificationStatus: 'verified',
          status: 'partial',
          sourceId: 'history-source-1',
          jobId: 'history-job-1',
          authorizationDigest: 'authorization-digest',
          sourceKind: 'desktop_visible',
          targetId: 'chatgpt',
          counts: { inserted: 4, updated: 1, skipped: 2, conflicted: 1, attachments: 0 },
          pageCount: 1,
          nextCursor: '',
          completeness: 'partial_visible',
          limitations: ['Only the current visible viewport was read; no automatic scrolling occurred.'],
        }),
      }],
      source: 'chat',
    });

    expect(result.blocked).toBe(false);
    expect(result.reason).toContain('history-job-1');
    expect(result.text).toContain('External AI history sync: partial');
    expect(result.text).toContain('Completeness: partial_visible');
    expect(result.text).toContain('no automatic scrolling');
    expect(result.text).not.toContain('Everything in the account');
  });

  it('renders only locally archived external AI history messages with their stable ids', async () => {
    const { finalizeLumiResponse } = await import('../server/cognition/result_finalizer');
    const result = finalizeLumiResponse({
      taskText: 'Read the ChatGPT conversation history from the authorized archive.',
      responseText: 'There were no messages.',
      toolRecords: [{
        name: 'external_ai_history_query',
        arguments: { sourceId: 'history-source-2' },
        result: JSON.stringify({
          ok: true,
          status: 'queried',
          sourceId: 'history-source-2',
          sourceKind: 'export',
          targetId: 'chatgpt',
          conversations: [],
          messages: [{ role: 'assistant', sourceExternalMessageId: 'message-42', content: 'Grounded archived answer.' }],
          attachments: [],
          count: 1,
          completeness: 'source_bounded',
          limitations: ['Results are limited to synchronized pages.'],
        }),
      }],
      source: 'chat',
    });

    expect(result.blocked).toBe(false);
    expect(result.text).toContain('message-42');
    expect(result.text).toContain('Grounded archived answer.');
    expect(result.text).toContain('source_bounded');
    expect(result.text).not.toContain('There were no messages.');
  });

  it('does not treat a CAD folder workflow as visible AutoCAD completion evidence', async () => {
    const { finalizeLumiResponse } = await import('../server/cognition/result_finalizer');

    const result = finalizeLumiResponse({
      taskText: '\u684c\u9762\u4e0a\u6709\u4e2a\u300c\u963f\u9646\u300d\u6587\u4ef6\u5939\uff0c\u8bf7\u6839\u636e\u91cc\u9762\u7684\u56fe\u7247\u751f\u6210 CAD \u56fe\u7eb8\uff0c\u5e76\u5728 AutoCAD \u91cc\u5b9e\u9645\u753b\u51fa\u6765',
      responseText: '\u6211\u5df2\u7ecf\u751f\u6210\u4e86 DXF\uff0c\u5e76\u5728 AutoCAD \u91cc\u753b\u5b8c\u4e86\u3002',
      toolRecords: [{
        name: 'mcp_cad-drafting_cad_renovation_folder_workflow',
        arguments: { folderPath: 'C:\\\\Users\\\\me\\\\Desktop\\\\\u963f\u9646' },
        result: '{"ok":true,"cadFiles":[{"path":"C:\\\\Users\\\\me\\\\Desktop\\\\\u963f\u9646\\\\LumiCAD\\\\plan.dxf"}]}',
      }],
      source: 'chat',
    });

    expect(result.blocked).toBe(true);
    expect(result.reason).toBe('Missing visible AutoCAD execution evidence.');
    expect(result.text).toContain('\u8fd9\u6b21\u8fd8\u6ca1\u5b8c\u6210');
    expect(result.text).toContain('AutoCAD \u524d\u53f0\u7ed8\u56fe');
    expect(result.text).not.toContain('mcp_cad-drafting_autocad_playback_file');
  });

  it('calls geometry extraction successful only for a verified server receipt', async () => {
    const { finalizeLumiResponse } = await import('../server/cognition/result_finalizer');
    const taskText = '\u8bfb\u53d6\u684c\u9762\u4e0a\u7684\u8bbe\u8ba1\u8349\u7a3f.jpg\uff0c\u63d0\u53d6\u51e0\u4f55\u4fe1\u606f\uff0c\u5148\u4e0d\u8981\u7ed8\u5236\uff0c\u53ea\u544a\u8bc9\u6211\u63d0\u53d6\u662f\u5426\u6210\u529f\u3002';
    const toolRecord = {
      name: 'floorplan_extract_geometry',
      arguments: { imagePath: 'C:\\Users\\test-user\\Desktop\\\u8bbe\u8ba1\u8349\u7a3f.jpg' },
      result: JSON.stringify({
        path: 'C:\\Users\\test-user\\Desktop\\\u8bbe\u8ba1\u8349\u7a3f.jpg',
        parsed: true,
        geometryReady: true,
        geometryVerified: true,
        executableGeometryAvailable: true,
        geometryReceiptPath: 'C:\\Users\\test-user\\LumiCore\\data\\cad\\geometry_receipts\\verified.json',
        geometryReview: {
          width: 9000,
          height: 7600,
          counts: { outerBoundary: 6, polylines: 8 },
        },
      }),
    };

    const verified = finalizeLumiResponse({
      taskText,
      responseText: '\u63d0\u53d6\u597d\u50cf\u5931\u8d25\u4e86\u3002',
      toolRecords: [toolRecord],
      source: 'chat',
    });
    const unverified = finalizeLumiResponse({
      taskText,
      responseText: '\u51e0\u4f55\u63d0\u53d6\u5df2\u6210\u529f\u3002',
      toolRecords: [{
        ...toolRecord,
        result: JSON.stringify({
          parsed: true,
          geometryReady: true,
          geometryVerified: false,
          executableGeometryAvailable: false,
          geometryReceiptPath: 'C:\\Users\\test-user\\LumiCore\\data\\cad\\geometry_receipts\\unverified.json',
        }),
      }],
      source: 'chat',
    });

    expect(verified.blocked).toBe(false);
    expect(verified.text).toContain('\u51e0\u4f55\u63d0\u53d6\u6210\u529f');
    expect(verified.text).toContain('geometryReady=true');
    expect(verified.text).toContain('geometryVerified=true');
    expect(verified.text).toContain('verified.json');
    expect(verified.text).toContain('\u672a\u6267\u884c\u7ed8\u5236');
    expect(unverified.blocked).toBe(true);
    expect(unverified.text).toContain('\u51e0\u4f55\u63d0\u53d6\u672a\u6210\u529f');
    expect(unverified.text).toContain('geometryVerified=false');
  });

  it('rejects unrelated generated charts when a terse continuation belongs to an AutoCAD task', async () => {
    const { finalizeLumiResponse } = await import('../server/cognition/result_finalizer');

    const result = finalizeLumiResponse({
      taskText: [
        '执行绘图',
        '## Recent action continuation context',
        'Recent user task context:',
        '- 读取桌面阿陆文件夹里的户型图，并在 AutoCAD 中实际画出来。',
        'Recent Lumi execution state:',
        '- AutoCAD 回放仍被阻塞，尚未获得完成标记。',
      ].join('\n'),
      responseText: '已完成绘图，生成了六张业务数据可视化 PNG 图表。',
      toolRecords: [{
        name: 'write_file',
        arguments: { path: 'C:\\tmp\\charts.py' },
        result: 'C:\\tmp\\charts.py',
      }, {
        name: 'python_exec',
        arguments: { path: 'C:\\tmp\\charts.py' },
        result: 'Generated C:\\tmp\\sales_dashboard.png',
      }],
      source: 'task',
    });

    expect(result.blocked).toBe(true);
    expect(result.reason).toBe('Missing visible AutoCAD execution evidence.');
    expect(result.text).toContain('还没完成');
  });

  it('rejects a legacy batch marker even when the task did not explicitly say MCP-only', async () => {
    const { finalizeLumiResponse } = await import('../server/cognition/result_finalizer');

    const result = finalizeLumiResponse({
      taskText: '\u684c\u9762\u4e0a\u6709\u4e2a\u300c\u963f\u9646\u300d\u6587\u4ef6\u5939\uff0c\u8bf7\u6839\u636e\u91cc\u9762\u7684\u56fe\u7247\u751f\u6210 CAD \u56fe\u7eb8\uff0c\u5e76\u5728 AutoCAD \u91cc\u5b9e\u9645\u753b\u51fa\u6765',
      responseText: 'AutoCAD drawing completed.',
      toolRecords: [{
        name: 'cad_prepare_autocad_operations',
        arguments: { width: 7800, height: 6200 },
        result: '{"operationsPath":"C:\\\\Users\\\\me\\\\Desktop\\\\plan_operations.json","completionMarkerPath":"C:\\\\Users\\\\me\\\\Desktop\\\\plan.done","operationCount":12}',
      }, {
        name: 'legacy_autocad_batch',
        arguments: { operationsPath: 'C:\\\\Users\\\\me\\\\Desktop\\\\plan_operations.json' },
        result: '{"status":"completed","completionMarkerExists":true,"completionMarkerPath":"C:\\\\Users\\\\me\\\\Desktop\\\\plan_completed.txt","autocadExecutable":"D:\\\\AutoCAD\\\\acad.exe","autocadExecutableSource":"desktop_app_index"}',
      }],
      source: 'chat',
    });

    expect(result.blocked).toBe(true);
    expect(result.reason).toBe('Missing visible AutoCAD execution evidence.');
  });

  it('grounds visible AutoCAD MCP playback in its operation file and marker', async () => {
    const { finalizeLumiResponse } = await import('../server/cognition/result_finalizer');

    const result = finalizeLumiResponse({
      taskText: 'Draw this visibly in AutoCAD stroke by stroke.',
      responseText: 'Done.',
      toolRecords: [{
        name: 'mcp_cad-drafting_autocad_playback_file',
        arguments: { operationsPath: 'C:\\CAD\\plan_operations.json' },
        result: '{"status":"completed","transport":"mcp_autocad_com","visiblePlayback":true,"completionMarkerExists":true,"completionMarkerPath":"C:\\\\CAD\\\\plan_completed.txt","operationsPath":"C:\\\\CAD\\\\plan_operations.json","geometryVerified":true,"entityCountMatches":true,"operationCount":46,"expectedEntityCount":46,"entitiesAdded":46,"operationSetId":"verified-operation-set","strokeDelayMs":450}',
      }],
      source: 'chat',
    });

    expect(result.blocked).toBe(false);
    expect(result.reason).toContain('MCP/COM visible-playback');
    expect(result.text).toContain('stroke-by-stroke playback');
    expect(result.text).toContain('plan_operations.json');
    expect(result.text).toContain('450 ms');
  });

  it('uses the composite CAD workflow receipt instead of leaking model process narration', async () => {
    const { finalizeLumiResponse } = await import('../server/cognition/result_finalizer');
    const result = finalizeLumiResponse({
      taskText: '读取桌面上的阿陆平面图，画进 AutoCAD 里。',
      responseText: '先找到图片。现在让我继续尝试几个工具，再看看内部协议和 allowedTools。',
      toolRecords: [{
        name: 'cad_draw_floorplan_in_autocad',
        arguments: { sourceName: '阿陆平面图' },
        result: JSON.stringify({
          status: 'blocked',
          completed: false,
          stage: 'autocad_playback',
          sourcePath: 'C:\\Users\\me\\Desktop\\阿陆平面图.jpg',
          operationsPath: 'C:\\CAD\\plan_operations.json',
          completionMarkerPath: 'C:\\CAD\\plan_completed.json',
          blocker: 'AutoCAD entity-count verification failed after operation 33.',
        }),
      }],
      source: 'voice',
    });

    expect(result.blocked).toBe(true);
    expect(result.text).toContain('operation 33');
    expect(result.text).not.toContain('allowedTools');
    expect(result.text).not.toContain('先找到图片');
  });

  it('uses a successful AutoCAD MCP retry after an earlier timeout on an attached CAD task', async () => {
    const { finalizeLumiResponse } = await import('../server/cognition/result_finalizer');
    const taskText = [
      '把这幅图画成cad图',
      '## Current Turn Attachments',
      'The user attached these files to the current message. Treat them as part of the user request.',
      'Local path: C:\\Users\\me\\LumiCore\\data\\knowledge\\plan.jpg',
    ].join('\n\n');
    const result = finalizeLumiResponse({
      taskText,
      responseText: '这次还没完成。任务类型：前台消息发送。',
      source: 'chat',
      toolRecords: [{
        id: 'first-attempt',
        name: 'mcp_cad-drafting_autocad_playback_file',
        arguments: {
          operationsPath: 'C:\\CAD\\plan_operations.json',
          completionMarkerPath: 'C:\\CAD\\plan_completed.txt',
          strokeDelayMs: 450,
        },
        result: '',
        error: 'MCP error -32001: Request timed out',
      }, {
        id: 'retry',
        name: 'mcp_cad-drafting_autocad_playback_file',
        arguments: {
          operationsPath: 'C:\\CAD\\plan_operations.json',
          completionMarkerPath: 'C:\\CAD\\plan_completed.txt',
          strokeDelayMs: 200,
        },
        result: '{"status":"completed","transport":"mcp_autocad_com","visiblePlayback":true,"completionMarkerExists":true,"completionMarkerPath":"C:\\\\CAD\\\\plan_completed.txt","operationsPath":"C:\\\\CAD\\\\plan_operations.json","geometryVerified":true,"entityCountMatches":true,"operationCount":185,"expectedEntityCount":185,"entitiesAdded":185,"operationSetId":"verified-operation-set","strokeDelayMs":200}',
      }],
    });

    expect(result.blocked).toBe(false);
    expect(result.text).toContain('185');
    expect(result.text).toContain('AutoCAD');
    expect(result.text).not.toContain('微信');
    expect(result.text).not.toContain('timed out');
  });

  it('does not accept a generated drawing file for an explicit AutoCAD MCP-only task', async () => {
    const { finalizeLumiResponse } = await import('../server/cognition/result_finalizer');

    const result = finalizeLumiResponse({
      taskText: 'Draw visibly in AutoCAD stroke by stroke. Use AutoCAD MCP only; do not use LISP, scripts, or fallback.',
      responseText: 'The AutoCAD drawing is complete.',
      toolRecords: [{
        name: 'cad_generate_dxf',
        arguments: {},
        result: '{"status":"completed","path":"C:\\\\CAD\\\\fallback.dxf"}',
      }],
      source: 'chat',
    });

    expect(result.blocked).toBe(true);
    expect(result.reason).toBe('Missing visible AutoCAD execution evidence.');
  });

  it('blocks login-then-search claims without authenticated result evidence', async () => {
    const { finalizeLumiResponse } = await import('../server/cognition/result_finalizer');

    const result = finalizeLumiResponse({
      taskText: '\u6253\u5f00\u4e2d\u56fd\u88c1\u5224\u6587\u4e66\u7f51\uff0c\u81ea\u52a8\u767b\u5f55\u8d26\u53f7\u627e\u4e00\u4e0b\u6d59\u6c5f\u7701\u7684\u6848\u4ef6',
      responseText: '\u5df2\u7ecf\u767b\u5f55\u5e76\u627e\u5230\u4e86\u6d59\u6c5f\u7701\u7684\u6848\u4ef6\u3002',
      toolRecords: [{
        name: 'web_login_profile_list',
        arguments: {},
        result: '{"profiles":[]}',
      }, {
        name: 'mcp_playwright_browser_snapshot',
        arguments: {},
        result: 'Page URL: https://wenshu.court.gov.cn/website/wenshu/181010CARHS5BS3C/index.html?open=login\\n登录/注册',
      }],
      source: 'chat',
    });

    expect(result.blocked).toBe(true);
    expect(result.reason).toBe('Missing authenticated browser result evidence.');
    expect(result.text).toContain('\u6ca1\u6709\u627e\u5230\u5df2\u4fdd\u5b58\u7684\u7f51\u9875\u767b\u5f55 profile');
  });

  it('blocks legal document completion claims without current-law verification', async () => {
    const { finalizeLumiResponse } = await import('../server/cognition/result_finalizer');

    const result = finalizeLumiResponse({
      taskText: '\u6839\u636e\u6750\u6599\u751f\u6210\u8d77\u8bc9\u72b6\u548c\u8981\u7d20\u5f0f\u8bc9\u72b6',
      responseText: '\u8d77\u8bc9\u72b6\u548c\u8981\u7d20\u5f0f\u8bc9\u72b6\u5df2\u7ecf\u751f\u6210\u5b8c\u6210\uff0c\u53ef\u4ee5\u76f4\u63a5\u4f7f\u7528\u3002',
      toolRecords: [{
        name: 'legal_generate_litigation_packet',
        arguments: { caseName: '\u4e70\u5356\u5408\u540c\u7ea0\u7eb7' },
        result: '# \u8d77\u8bc9\u72b6\u8349\u7a3f\n\u672a\u8fd0\u884c\u5f15\u7528\u6838\u9a8c\u62a5\u544a',
      }],
      source: 'chat',
    });

    expect(result.blocked).toBe(true);
    expect(result.reason).toBe('Missing current-law verification gate for legal document.');
    expect(result.text).toContain('\u8fd8\u4e0d\u80fd\u6807\u8bb0\u4e3a\u5b8c\u6210\u6216\u6b63\u5f0f\u53ef\u7528');
    expect(result.text).toContain('legal_generate_citation_verification_report');
  });

  it('allows legal document completion after current-law verification passes', async () => {
    const { finalizeLumiResponse } = await import('../server/cognition/result_finalizer');

    const responseText = '\u8d77\u8bc9\u72b6\u548c\u8981\u7d20\u5f0f\u8bc9\u72b6\u5df2\u7ecf\u751f\u6210\u5b8c\u6210\uff0c\u73b0\u884c\u6709\u6548\u6cd5\u5f8b\u6838\u9a8c\u5df2\u901a\u8fc7\u3002';
    const result = finalizeLumiResponse({
      taskText: '\u6839\u636e\u6750\u6599\u751f\u6210\u8d77\u8bc9\u72b6\u548c\u8981\u7d20\u5f0f\u8bc9\u72b6',
      responseText,
      toolRecords: [
        {
          name: 'legal_generate_litigation_packet',
          arguments: { caseName: '\u4e70\u5356\u5408\u540c\u7ea0\u7eb7' },
          result: '# \u8d77\u8bc9\u72b6\n## \u6cd5\u5f8b\u4f9d\u636e\n\u4ee5\u73b0\u884c\u6709\u6548\u6cd5\u5f8b\u4e3a\u51c6\u3002\n## \u4e8b\u5b9e\u4e0e\u8bc1\u636e\n\u8bc1\u636e\u76ee\u5f55\u3001\u8bc1\u660e\u76ee\u7684\u5df2\u7ed1\u5b9a\u3002\n## \u4e8b\u5b9e\u9002\u7528\u5206\u6790\n\u56f4\u7ed5\u4e89\u8bae\u7126\u70b9\u5f62\u6210\u7ed3\u8bba\u8bf7\u6c42\u3002\n# \u8981\u7d20\u5f0f\u8bc9\u72b6\noutput: D:\\\\tmp\\\\complaint.docx',
        },
        {
          name: 'legal_generate_citation_verification_report',
          arguments: { caseName: '\u4e70\u5356\u5408\u540c\u7ea0\u7eb7' },
          result: '\u73b0\u884c\u6709\u6548\u6cd5\u5f8b\u786c\u95e8\u69db\uff1a\u901a\u8fc7\n\u5df2\u5e9f\u6b62/\u5931\u6548\u98ce\u9669\uff1a0',
        },
      ],
      source: 'chat',
    });

    expect(result.blocked).toBe(false);
    expect(result.text).toBe(responseText);
  });

  it('blocks legal document completion claims without triad reasoning chain evidence', async () => {
    const { finalizeLumiResponse } = await import('../server/cognition/result_finalizer');

    const result = finalizeLumiResponse({
      taskText: '\u751f\u6210\u6b63\u5f0f\u6cd5\u5f8b\u610f\u89c1\u4e66',
      responseText: '\u6b63\u5f0f\u6cd5\u5f8b\u610f\u89c1\u4e66\u5df2\u7ecf\u751f\u6210\u5b8c\u6210\uff0c\u73b0\u884c\u6709\u6548\u6cd5\u5f8b\u6838\u9a8c\u5df2\u901a\u8fc7\uff0c\u53ef\u4ee5\u76f4\u63a5\u4f7f\u7528\u3002',
      toolRecords: [
        {
          name: 'legal_generate_litigation_packet',
          arguments: { caseName: '\u63a8\u7406\u94fe\u7f3a\u5931\u6d4b\u8bd5\u6848' },
          result: '# \u6cd5\u5f8b\u610f\u89c1\u4e66\noutput: D:\\\\tmp\\\\opinion.docx',
        },
        {
          name: 'legal_generate_citation_verification_report',
          arguments: { caseName: '\u63a8\u7406\u94fe\u7f3a\u5931\u6d4b\u8bd5\u6848' },
          result: '\u73b0\u884c\u6709\u6548\u6cd5\u5f8b\u786c\u95e8\u69db\uff1a\u901a\u8fc7\n\u5df2\u5e9f\u6b62/\u5931\u6548\u98ce\u9669\uff1a0',
        },
      ],
      source: 'chat',
    });

    expect(result.blocked).toBe(true);
    expect(result.reason).toBe('Missing legal reasoning chain evidence.');
    expect(result.text).toContain('\u4e09\u6bb5\u8bba\u63a8\u7406\u94fe');
    expect(result.text).toContain('legal_case_reasoning_matrix');
  });

  it('blocks legal delivery claims when the current-law gate failed', async () => {
    const { finalizeLumiResponse } = await import('../server/cognition/result_finalizer');

    const result = finalizeLumiResponse({
      taskText: '\u751f\u6210\u6b63\u5f0f\u4ee3\u7406\u8bcd\u548c\u6cd5\u5f8b\u610f\u89c1\u4e66\u4ea4\u4ed8\u5305',
      responseText: '\u6b63\u5f0f\u4ee3\u7406\u8bcd\u548c\u6cd5\u5f8b\u610f\u89c1\u4e66\u4ea4\u4ed8\u5305\u5df2\u5b8c\u6210\u3002',
      toolRecords: [{
        name: 'legal_finalize_delivery_package',
        arguments: { caseName: '\u5e9f\u6b62\u6cd5\u963b\u65ad\u6d4b\u8bd5\u6848' },
        result: '\u73b0\u884c\u6709\u6548\u6cd5\u5f8b\u786c\u95e8\u69db\u672a\u901a\u8fc7\n\u300a\u5408\u540c\u6cd5\u300b\u5df2\u5e9f\u6b62',
      }],
      source: 'chat',
    });

    expect(result.blocked).toBe(true);
    expect(result.reason).toBe('Missing current-law verification gate for legal document.');
    expect(result.text).toContain('\u672a\u6838\u9a8c\u7684\u6cd5\u5f8b\u6587\u4e66');
  });

  it('blocks court filing portal claims that pretend final external submission is automatic', async () => {
    const { finalizeLumiResponse } = await import('../server/cognition/result_finalizer');

    const result = finalizeLumiResponse({
      taskText: '\u5e2e\u6211\u5728\u6cd5\u9662\u7acb\u6848\u7f51\u81ea\u52a8\u7acb\u6848\u5e76\u63d0\u4ea4',
      responseText: '\u5df2\u7ecf\u5728\u6cd5\u9662\u7acb\u6848\u7f51\u5b8c\u6210\u81ea\u52a8\u7acb\u6848\u63d0\u4ea4\u3001\u7b7e\u540d\u548c\u7f34\u8d39\u3002',
      toolRecords: [{
        name: 'legal_prepare_filing_handoff',
        arguments: { caseName: '\u7acb\u6848\u6d4b\u8bd5\u6848' },
        result: '\u534a\u81ea\u52a8\u7acb\u6848\u4ea4\u63a5\u5355\nLumi \u672a\u81ea\u52a8\u63d0\u4ea4\u3001\u672a\u7b7e\u540d\u3001\u672a\u7f34\u8d39\u3002',
      }],
      source: 'chat',
    });

    expect(result.blocked).toBe(true);
    expect(result.reason).toBe('External legal platform final action requires authorized collaboration.');
    expect(result.text).toContain('\u5916\u90e8\u6cd5\u5f8b\u5e73\u53f0\u4e0d\u80fd\u6807\u8bb0\u4e3a\u5168\u81ea\u52a8\u5b8c\u6210');
    expect(result.text).toContain('\u6388\u6743\u534f\u4f5c');
  });

  it('blocks external legal research result claims without source or session evidence', async () => {
    const { finalizeLumiResponse } = await import('../server/cognition/result_finalizer');

    const result = finalizeLumiResponse({
      taskText: '\u8fde\u63a5\u6cd5\u8749\u3001Alpha \u548c\u4f01\u67e5\u67e5\u67e5\u516c\u53f8\u548c\u88ab\u6267\u884c\u4eba\u60c5\u51b5',
      responseText: '\u5df2\u7ecf\u5728\u6cd5\u8749\u3001Alpha \u548c\u4f01\u67e5\u67e5\u67e5\u5230\u516c\u53f8\u6d89\u8bc9\u548c\u88ab\u6267\u884c\u60c5\u51b5\u3002',
      toolRecords: [],
      source: 'chat',
    });

    expect(result.blocked).toBe(true);
    expect(result.reason).toBe('Missing external legal platform result evidence.');
    expect(result.text).toContain('\u5916\u90e8\u6cd5\u5f8b\u5e73\u53f0\u67e5\u8be2');
    expect(result.text).toContain('\u6765\u6e90\u767b\u8bb0');
  });

  it('allows authorized external legal research handoffs without pretending results are fetched', async () => {
    const { finalizeLumiResponse } = await import('../server/cognition/result_finalizer');

    const responseText = '\u5df2\u751f\u6210\u6388\u6743\u534f\u4f5c\u68c0\u7d22\u884c\u52a8\u5355\uff0c\u5f85\u5f8b\u5e08\u767b\u5f55\u6cd5\u8749\u3001Alpha \u548c\u88c1\u5224\u6587\u4e66\u7f51\u6838\u9a8c\u5e76\u5f52\u6863\u6765\u6e90\u3002';
    const result = finalizeLumiResponse({
      taskText: '\u751f\u6210\u6cd5\u8749\u3001Alpha \u548c\u88c1\u5224\u6587\u4e66\u7f51\u68c0\u7d22\u8ba1\u5212',
      responseText,
      toolRecords: [{
        name: 'legal_external_research_plan',
        arguments: { caseName: '\u5916\u90e8\u68c0\u7d22\u6d4b\u8bd5\u6848' },
        result: '\u5916\u90e8\u68c0\u7d22\u884c\u52a8\u5355\n\u6388\u6743\u7f51\u9875\u767b\u5f55\u534f\u4f5c\n\u6765\u6e90\u767b\u8bb0\u8868',
      }],
      source: 'chat',
    });

    expect(result.blocked).toBe(false);
    expect(result.text).toBe(responseText);
  });

  it('blocks legacy customer packages from claiming customer work completed', async () => {
    const { finalizeLumiResponse } = await import('../server/cognition/result_finalizer');

    const result = finalizeLumiResponse({
      taskText: 'Analyze this customer lead and advance the sales follow-up.',
      responseText: 'The customer takeover and follow-up are completed.',
      toolRecords: [{
        name: 'legacy_scripted_customer_package',
        arguments: { customerName: 'Example customer' },
        result: '{"quoteReady":true,"contractReady":true,"completionEligible":false}',
      }],
      source: 'chat',
    });

    expect(result.blocked).toBe(true);
    expect(result.reason).toBe('Missing core evidence for customer_operations.');
  });

  it('blocks legacy ecommerce packages from claiming platform work completed', async () => {
    const { finalizeLumiResponse } = await import('../server/cognition/result_finalizer');

    const result = finalizeLumiResponse({
      taskText: 'Analyze this ecommerce campaign and optimize the store listing.',
      responseText: 'The ecommerce operation and store optimization are completed.',
      toolRecords: [{
        name: 'legacy_scripted_ecommerce_package',
        arguments: { productName: 'Example product' },
        result: '{"contentMatrixReady":true,"publishDraftReady":true,"completionEligible":false}',
      }],
      source: 'chat',
    });

    expect(result.blocked).toBe(true);
    expect(result.reason).toBe('Missing core evidence for ecommerce_operations.');
  });

  it('blocks legacy design packages from claiming composite design delivery', async () => {
    const { finalizeLumiResponse } = await import('../server/cognition/result_finalizer');

    const result = finalizeLumiResponse({
      taskText: 'Based on the attached plan, create a design PPT, finished render, and budget schedule.',
      responseText: 'The full design package has been generated and completed.',
      toolRecords: [{
        name: 'legacy_scripted_design_package',
        arguments: { area: 120 },
        result: '{"pptReady":true,"renderPreviewReady":true,"budgetReady":true,"completionEligible":false}',
      }],
      source: 'chat',
    });

    expect(result.blocked).toBe(true);
    expect(result.reason).toBe('Missing core evidence for design_delivery.');
  });

  it('allows grounded customer analysis from the real sales capability', async () => {
    const { finalizeLumiResponse } = await import('../server/cognition/result_finalizer');
    const responseText = 'Customer lead analysis completed with a concrete next action.';

    const result = finalizeLumiResponse({
      taskText: 'Analyze this customer lead and score the sales opportunity.',
      responseText,
      toolRecords: [{
        name: 'mcp_sales-customer-ops_lead_score',
        arguments: { leadText: 'The buyer needs 30 seats this month and requested a formal quote.' },
        result: '{"score":80,"grade":"hot","signals":{"budget":true,"timing":true},"nextBestAction":"Confirm authority and prepare a scoped quotation."}',
      }],
      source: 'chat',
    });

    expect(result.blocked).toBe(false);
    expect(result.text).toBe(responseText);
  });

  it('blocks ordinary chat formal legal documents without production and citation gates', async () => {
    const { finalizeLumiResponse } = await import('../server/cognition/result_finalizer');

    const result = finalizeLumiResponse({
      taskText: '\u76f4\u63a5\u7ed9\u6211\u4e00\u4efd\u6b63\u5f0f\u7248\u8d77\u8bc9\u72b6',
      responseText: '\u6b63\u5f0f\u7248\u8d77\u8bc9\u72b6\u5df2\u751f\u6210\uff0c\u53ef\u4ee5\u76f4\u63a5\u63d0\u4ea4\u3002',
      toolRecords: [],
      source: 'chat',
    });

    expect(result.blocked).toBe(true);
    expect(result.reason).toBe('Missing legal document production evidence.');
    expect(result.text).toContain('\u6cd5\u5f8b\u6587\u4e66\u8fd8\u4e0d\u80fd\u6807\u8bb0\u4e3a\u5b8c\u6210');
  });

  it('preserves verified process and window details for an exact desktop launch', async () => {
    const { finalizeLumiResponse } = await import('../server/cognition/result_finalizer');
    const taskText = '\u4e3b\u7a0b\u5e8f\u81ea\u6062\u590d\u9a8c\u6536\uff1a\u8bf7\u6253\u5f00 Windows \u8bb0\u4e8b\u672c\uff0c\u53ea\u6253\u5f00\u8fd9\u4e2a\u7cbe\u786e\u76ee\u6807\uff0c\u4e0d\u8981\u6253\u5f00\u66ff\u4ee3\u8f6f\u4ef6\u3002\u5982\u679c\u89c6\u89c9\u670d\u52a1\u4e0d\u53ef\u7528\uff0c\u8bf7\u4f7f\u7528\u5b89\u5168\u7684\u672c\u5730\u7a97\u53e3\u56de\u6267\u5b8c\u6210\u6838\u9a8c\u3002\u5b8c\u6210\u540e\u8bf4\u660e\u5b9e\u9645\u8fdb\u7a0b\u3001\u7a97\u53e3\u548c\u9a8c\u8bc1\u72b6\u6001\u3002';
    const result = finalizeLumiResponse({
      taskText,
      responseText: '\u5df2\u6253\u5f00Windows \u8bb0\u4e8b\u672c\u3002',
      toolRecords: [{
        name: 'desktop_open',
        arguments: { target: '\u8bb0\u4e8b\u672c' },
        result: JSON.stringify({
          ok: true,
          status: 'verified',
          target: '\u8bb0\u4e8b\u672c',
          targetMatched: true,
          actualTarget: {
            title: '\u65e0\u6807\u9898 - \u8bb0\u4e8b\u672c',
            processName: 'notepad.exe',
          },
          verification: { status: 'verified', targetMatched: true },
        }),
        terminalVerification: {
          status: 'verified',
          strategy: 'state_diff',
          reason: 'Exact target focused.',
        },
      }, {
        name: 'desktop_active_window',
        arguments: {},
        result: JSON.stringify({
          executable: 'C:\\Windows\\System32\\notepad.exe',
          pid: 18612,
          title: '\u65e0\u6807\u9898 - \u8bb0\u4e8b\u672c',
        }),
      }],
      source: 'command-center-chat',
    });

    expect(result.blocked).toBe(false);
    expect(result.reason).toContain('Grounded exact desktop-open success');
    expect(result.text).toBe([
      '\u5df2\u6253\u5f00Windows \u8bb0\u4e8b\u672c\u3002',
      '\u5b9e\u9645\u8fdb\u7a0b\uff1anotepad.exe (PID 18612)',
      '\u7a97\u53e3\uff1a\u65e0\u6807\u9898 - \u8bb0\u4e8b\u672c',
      '\u9a8c\u8bc1\u72b6\u6001\uff1a\u5df2\u9a8c\u8bc1\uff08\u76ee\u6807\u7cbe\u786e\u5339\u914d\uff09',
    ].join('\n'));
  });

  it('keeps a verified file open successful when later optional focus checks fail', async () => {
    const { finalizeLumiResponse } = await import('../server/cognition/result_finalizer');
    const target = 'C:\\Users\\test-user\\Desktop\\领航员计划_介绍手册_2026.docx';
    const result = finalizeLumiResponse({
      taskText: '打开桌面上的领航员计划文件',
      responseText: '这次没有成功打开文件。',
      toolRecords: [{
        name: 'desktop_list_files',
        arguments: { path: 'C:\\Users\\test-user\\Desktop' },
        result: JSON.stringify([{ path: target, type: 'file' }]),
      }, {
        name: 'desktop_open',
        arguments: { target },
        result: JSON.stringify({
          ok: true,
          status: 'verified',
          target,
          application: 'WPS Office',
          targetMatched: true,
          actualTarget: {
            title: '领航员计划_介绍手册_2026.docx - WPS Office',
            processName: 'wps.exe',
          },
        }),
        terminalVerification: {
          status: 'verified',
          strategy: 'state_diff',
          reason: 'Exact target opened.',
        },
        envelope: {
          version: 1,
          status: 'verified_success',
          toolName: 'desktop_open',
          taskId: 'task-file-open',
          turnId: 'turn-file-open',
          requestId: 'request-file-open',
          idempotencyKey: 'file-open-key',
          targetIdentity: target,
          completedAt: '2026-08-25T09:00:00.000Z',
          verification: { status: 'verified', reason: 'Exact target opened.' },
        },
      }, {
        name: 'desktop_execution_plan_receipt',
        arguments: {},
        result: '',
        error: 'Desktop execution ended as target_mismatch.',
      }, {
        name: 'desktop_active_window',
        arguments: {},
        result: '',
        error: 'Desktop control is paused: desktop_control_paused_for_user_activity',
      }, {
        name: 'read_docx',
        arguments: { path: target },
        result: 'Document text was read.',
      }],
      source: 'chat',
    });

    expect(result.blocked).toBe(false);
    expect(result.text).toContain('已打开领航员计划_介绍手册_2026.docx');
    expect(result.text).toContain('后续窗口焦点核验没有完成');
    expect(result.text).not.toMatch(/target_mismatch|desktop_control_paused|没有成功打开/iu);
    expect(result.reason).toContain('Primary desktop-open verified');
  });

  it('keeps a verified browser open successful when a later plan fingerprint becomes stale', async () => {
    const { finalizeLumiResponse } = await import('../server/cognition/result_finalizer');
    const result = finalizeLumiResponse({
      taskText: '打开浏览器',
      responseText: '浏览器没有打开。',
      toolRecords: [{
        name: 'desktop_open',
        arguments: { target: 'Google Chrome' },
        result: JSON.stringify({
          ok: true,
          status: 'verified',
          target: 'Google Chrome',
          targetMatched: true,
          actualTarget: {
            title: '新标签页 - Google Chrome',
            processName: 'chrome.exe',
          },
        }),
        terminalVerification: {
          status: 'verified',
          strategy: 'state_diff',
          reason: 'Chrome window opened.',
        },
        envelope: {
          version: 1,
          status: 'verified_success',
          toolName: 'desktop_open',
          taskId: 'task-browser-open',
          turnId: 'turn-browser-open',
          requestId: 'request-browser-open',
          idempotencyKey: 'browser-open-key',
          targetIdentity: 'Google Chrome',
          completedAt: '2026-08-25T09:05:00.000Z',
          verification: { status: 'verified', reason: 'Chrome window opened.' },
        },
      }, {
        name: 'desktop_execution_plan_receipt',
        arguments: {},
        result: '',
        error: 'Desktop execution ended as target_mismatch.',
      }, {
        name: 'desktop_run_command',
        arguments: { command: 'observe only' },
        result: '',
        error: 'Desktop window/display fingerprint changed; the compiled UI/vision plan is invalid and must be rebuilt.',
      }],
      source: 'chat',
    });

    expect(result.blocked).toBe(false);
    expect(result.text).toContain('已打开Google Chrome');
    expect(result.text).toContain('后续窗口焦点核验没有完成');
    expect(result.text).not.toMatch(/target_mismatch|fingerprint|没有打开/iu);
    expect(result.reason).toContain('Primary desktop-open verified');
  });

  it('fuses the real Aliyun open observation and does not let later desktop pauses erase it', async () => {
    const { finalizeLumiResponse } = await import('../server/cognition/result_finalizer');
    const result = finalizeLumiResponse({
      taskText: '\u6253\u5f00\u963f\u91cc\u4e91\u5b98\u7f51',
      responseText: [
        '\u72b6\u6001\uff1a\u5931\u8d25\u3002',
        '\u8bc1\u636e\uff1a\u684c\u9762\u64cd\u4f5c\u5931\u8d25\u3002',
        '\u5177\u4f53\u963b\u585e\uff1adesktop_control_paused_for_user_activity',
        '\u6211\u5df2\u4fdd\u7559\u539f\u76ee\u6807\u3001\u5df2\u6267\u884c\u6b65\u9aa4\u548c\u56de\u6267\u3002',
      ].join('\n'),
      toolRecords: [{
        name: 'desktop_open',
        arguments: { target: 'https://www.aliyun.com' },
        result: JSON.stringify({
          ok: false,
          status: 'target_mismatch',
          target: 'https://www.aliyun.com',
          targetMatched: false,
          actualTarget: {
            title: '\u963f\u91cc\u4e91-\u8ba1\u7b97\uff0c\u4e3a\u4e86\u65e0\u6cd5\u8ba1\u7b97\u7684\u4ef7\u503c - \u5938\u514b',
            processName: 'quark.exe',
          },
        }),
        terminalVerification: {
          status: 'failed',
          strategy: 'state_diff',
          reason: 'The terminal receipt reported target_mismatch.',
        },
        envelope: {
          version: 1,
          status: 'target_mismatch',
          toolName: 'desktop_open',
          taskId: 'aliyun-task',
          turnId: 'aliyun-turn',
          requestId: 'aliyun-request',
          idempotencyKey: 'aliyun-open',
          targetIdentity: 'https://www.aliyun.com',
          completedAt: '2026-08-28T10:20:51.107Z',
          verification: { status: 'failed', reason: 'The terminal receipt reported target_mismatch.' },
        },
      }, {
        name: 'desktop_active_window',
        arguments: {},
        result: JSON.stringify({ title: 'LumiCore', process_name: 'lumi-core.exe' }),
        ...verifiedDesktopReceipt,
      }, {
        name: 'desktop_running_processes',
        arguments: { top: 15 },
        result: JSON.stringify({ count: 15 }),
        ...verifiedDesktopReceipt,
      }, {
        name: 'browser_open_task',
        arguments: { url: 'https://www.aliyun.com', open: true },
        result: '',
        error: 'Desktop control is paused: desktop_control_paused_for_user_activity',
        terminalVerification: {
          status: 'failed',
          strategy: 'state_diff',
          reason: 'Desktop control is paused: desktop_control_paused_for_user_activity',
        },
      }, {
        name: 'desktop_execution_plan_receipt',
        arguments: {},
        result: '{}',
        error: 'Desktop execution ended as target_mismatch.',
      }],
      source: 'chat',
    });

    expect(result.blocked).toBe(false);
    expect(result.text).toContain('\u5df2\u6253\u5f00\u963f\u91cc\u4e91\u5b98\u7f51');
    expect(result.text).not.toMatch(/\u72b6\u6001|\u8bc1\u636e|\u56de\u6267|target_mismatch|desktop_|browser_open_task/iu);
  });

  it('reports the real NetEase sequence as opened but playback-unconfirmed', async () => {
    const { finalizeLumiResponse } = await import('../server/cognition/result_finalizer');
    const result = finalizeLumiResponse({
      taskText: '\u6253\u5f00\u7f51\u6613\u4e91\u5e76\u64ad\u653e\u97f3\u4e50',
      responseText: '\u5df2\u83b7\u53d6\u5c4f\u5e55\u753b\u9762\uff0c\u4f46\u89c6\u89c9\u8bc6\u522b\u6ca1\u6709\u5b8c\u6210\u3002',
      toolRecords: [{
        name: 'desktop_list_apps',
        arguments: { query: '\u7f51\u6613\u4e91' },
        result: JSON.stringify({ apps: ['NetEase Cloud Music'] }),
        ...verifiedDesktopReceipt,
      }, {
        name: 'desktop_active_window',
        arguments: {},
        result: JSON.stringify({ title: 'LumiCore', process_name: 'lumi-core.exe' }),
        ...verifiedDesktopReceipt,
      }, {
        name: 'desktop_open',
        arguments: { target: '\u7f51\u6613\u4e91\u97f3\u4e50' },
        result: JSON.stringify({
          ok: false,
          status: 'target_mismatch',
          target: '\u7f51\u6613\u4e91\u97f3\u4e50',
          targetMatched: false,
          actualTarget: { title: '\u6708\u7259\u513f - Ice Paper', processName: 'cloudmusic.exe' },
        }),
        terminalVerification: {
          status: 'failed',
          strategy: 'state_diff',
          reason: 'The terminal receipt reported target_mismatch.',
        },
      }, {
        name: 'desktop_ui_snapshot',
        arguments: { root: 'active' },
        result: JSON.stringify({ status: 'ok', tree: { name: '\u6708\u7259\u513f - Ice Paper', processId: 24716 } }),
        ...verifiedDesktopReceipt,
      }, {
        name: 'ocr_screen',
        arguments: { query: '\u662f\u5426\u6b63\u5728\u64ad\u653e\uff1f' },
        result: JSON.stringify({ format: 'screenshot_base64', error: 'Visual request failed.' }),
        terminalVerification: {
          status: 'failed',
          strategy: 'terminal_receipt',
          reason: 'The visual request failed.',
        },
      }, {
        name: 'desktop_active_window',
        arguments: {},
        result: JSON.stringify({ title: '\u6708\u7259\u513f - Ice Paper', process_name: 'cloudmusic.exe' }),
        ...verifiedDesktopReceipt,
      }, {
        name: 'desktop_keyboard_press',
        arguments: { key: 'mediaplaypause', expectedProcessId: 24716 },
        result: '',
        error: 'Unknown key: mediaplaypause.',
      }, {
        name: 'desktop_keyboard_press',
        arguments: { key: 'space', expectedProcessId: 24716 },
        result: JSON.stringify({
          ok: true,
          status: 'verified',
          targetMatched: true,
          actualTarget: { title: '\u6708\u7259\u513f - Ice Paper', process_name: 'cloudmusic.exe', pid: 24716 },
        }),
        ...verifiedDesktopReceipt,
      }],
      source: 'chat',
    });

    expect(result.blocked).toBe(true);
    expect(result.text).toContain('\u5df2\u6253\u5f00\u7f51\u6613\u4e91');
    expect(result.text).toContain('\u65e0\u6cd5\u533a\u5206\u662f\u64ad\u653e\u8fd8\u662f\u6682\u505c');
    expect(result.text).not.toMatch(/ocr_screen|desktop_|mediaplaypause|target_mismatch|\u8bc1\u636e|\u56de\u6267|C:\\/iu);
  });

  it('keeps verified playback successful when a later auxiliary visual check fails', async () => {
    const { finalizeLumiResponse } = await import('../server/cognition/result_finalizer');
    const result = finalizeLumiResponse({
      taskText: '\u6253\u5f00\u7f51\u6613\u4e91\u5e76\u64ad\u653e\u97f3\u4e50',
      responseText: '\u540e\u7eed OCR \u5931\u8d25\uff0c\u4efb\u52a1\u53d7\u963b\u3002',
      toolRecords: [{
        name: 'desktop_active_window',
        arguments: {},
        result: JSON.stringify({ title: '\u7f51\u6613\u4e91\u97f3\u4e50', process_name: 'cloudmusic.exe' }),
        ...verifiedDesktopReceipt,
      }, {
        name: 'desktop_keyboard_press',
        arguments: { key: 'space' },
        result: JSON.stringify({ ok: true, status: 'verified', targetMatched: true }),
        ...verifiedDesktopReceipt,
      }, {
        name: 'desktop_ui_snapshot',
        arguments: { root: 'active' },
        result: JSON.stringify({ status: 'ok', playerState: 'playing', title: '\u6708\u7259\u513f - Ice Paper' }),
        ...verifiedDesktopReceipt,
      }, {
        name: 'ocr_screen',
        arguments: {},
        result: JSON.stringify({ error: 'Vision provider unavailable.' }),
        terminalVerification: { status: 'failed', strategy: 'terminal_receipt', reason: 'Vision provider unavailable.' },
      }],
      source: 'chat',
    });

    expect(result.blocked).toBe(false);
    expect(result.text).toContain('\u97f3\u4e50\u6b63\u5728\u64ad\u653e');
    expect(result.text).not.toMatch(/OCR|ocr_screen|\u53d7\u963b|\u8bc1\u636e|\u56de\u6267/iu);
  });

  it('does not let successful file searches prove that the visual model is available', async () => {
    const { finalizeLumiResponse } = await import('../server/cognition/result_finalizer');
    const result = finalizeLumiResponse({
      taskText: '\u68c0\u67e5\u89c6\u89c9\u6a21\u578b\u5f53\u524d\u662f\u5426\u53ef\u7528',
      responseText: '\u72b6\u6001\uff1a\u5931\u8d25\u3002\n\u8bc1\u636e\uff1asearch_files \u6210\u529f\uff0cocr_region \u5931\u8d25\u3002',
      toolRecords: [{
        name: 'search_files',
        arguments: { path: 'D:\\lumiOS', pattern: 'vision' },
        result: JSON.stringify({ ok: true, matches: ['server/cognition/vision_routing.ts'] }),
        ...verifiedDesktopReceipt,
      }, {
        name: 'ocr_region',
        arguments: { x: 0, y: 0, width: 400, height: 300 },
        result: JSON.stringify({
          format: 'screenshot_base64',
          error: 'Access denied: account is not in good standing; overdue-payment.',
        }),
        terminalVerification: {
          status: 'failed',
          strategy: 'terminal_receipt',
          reason: 'Access denied: account is not in good standing; overdue-payment.',
        },
      }],
      source: 'chat',
    });

    expect(result.blocked).toBe(true);
    expect(result.text).toMatch(/\u6b20\u8d39|\u8d26\u6237\u72b6\u6001/iu);
    expect(result.text).not.toMatch(/search_files|ocr_region|D:\\|overdue-payment|\u72b6\u6001\uff1a|\u8bc1\u636e\uff1a|\u56de\u6267/iu);
  });

  it('accepts one real visual probe even when unrelated auxiliary work fails later', async () => {
    const { finalizeLumiResponse } = await import('../server/cognition/result_finalizer');
    const result = finalizeLumiResponse({
      taskText: '\u68c0\u67e5\u89c6\u89c9\u6a21\u578b\u5f53\u524d\u662f\u5426\u53ef\u7528',
      responseText: '\u540e\u7eed\u8f85\u52a9\u68c0\u67e5\u5931\u8d25\u3002',
      toolRecords: [{
        name: 'ocr_screen',
        arguments: { query: '\u8bf7\u8bc6\u522b\u5f53\u524d\u7a97\u53e3\u6807\u9898' },
        result: '\u5f53\u524d\u7a97\u53e3\u662f LumiCore \u804a\u5929\u754c\u9762\u3002',
        ...verifiedDesktopReceipt,
      }, {
        name: 'desktop_capture_screen',
        arguments: {},
        result: '',
        error: 'Auxiliary capture failed.',
      }],
      source: 'chat',
    });

    expect(result.blocked).toBe(false);
    expect(result.text).toContain('\u89c6\u89c9\u6a21\u578b\u5f53\u524d\u53ef\u7528');
    expect(result.text).not.toMatch(/desktop_capture_screen|\u5931\u8d25|\u8bc1\u636e|\u56de\u6267/iu);
  });

  it('asks for the real foreground document naturally when Lumi itself is active', async () => {
    const { finalizeLumiResponse } = await import('../server/cognition/result_finalizer');
    const result = finalizeLumiResponse({
      taskText: '\u5206\u6790\u6253\u5f00\u7684\u8fd9\u4efd\u6587\u4ef6',
      responseText: '\u5df2\u7ecf\u5b8c\u6210\u8fd9\u4efd\u6587\u4ef6\u7684\u5206\u6790\u3002',
      toolRecords: [{
        name: 'desktop_active_window',
        arguments: {},
        result: JSON.stringify({
          ok: true,
          title: 'LumiCore',
          process_name: 'lumi-core.exe',
        }),
        ...verifiedDesktopReceipt,
      }],
      source: 'chat',
    });

    expect(result.blocked).toBe(true);
    expect(result.text).toContain('LumiCore');
    expect(result.text).toContain('\u6587\u6863\u5207\u5230\u524d\u53f0');
    expect(result.text).toContain('\u6587\u4ef6\u53d1\u7ed9\u6211');
    expect(result.text).not.toMatch(/\u72b6\u6001|\u8bc1\u636e|\u56de\u6267|\u53d7\u963b/iu);
  });

  it('keeps a verified current WPS document result when desktop control pauses afterwards', async () => {
    const { finalizeLumiResponse } = await import('../server/cognition/result_finalizer');
    const exactPath = 'C:\\Users\\Administrator\\Desktop\\Lumi_\u8def\u6f14.pptx';
    const result = finalizeLumiResponse({
      taskText: '\u5e2e\u6211\u5206\u6790\u4e00\u4e0b WPS \u5f53\u524d\u6253\u5f00\u7684\u6587\u4ef6\uff0c\u5148\u544a\u8bc9\u6211\u5b83\u4e3b\u8981\u8bb2\u4e86\u4ec0\u4e48\u3002',
      responseText: 'execution_recovery_incomplete: desktop control paused; continue later.',
      toolRecords: [{
        name: 'desktop_running_processes',
        arguments: {},
        result: JSON.stringify({
          processes: [{
            name: 'wpp.exe',
            window_titles: ['Lumi_\u8def\u6f14.pptx - WPS Office'],
          }],
        }),
        ...verifiedDesktopReceipt,
      }, {
        name: 'desktop_list_files',
        arguments: { directory: 'C:\\Users\\Administrator\\Desktop' },
        result: JSON.stringify({ files: [{ path: exactPath }] }),
        ...verifiedDesktopReceipt,
      }, {
        name: 'extract_document_text',
        arguments: { filePath: exactPath },
        result: JSON.stringify({
          ok: true,
          content: [
            'Lumi Core \u662f\u9762\u5411\u4e2a\u4eba\u8fde\u7eed\u6027\u7684 AI \u64cd\u4f5c\u7cfb\u7edf',
            '\u6388\u6743\u4e0e\u53ef\u9a8c\u8bc1\u884c\u52a8\u6784\u6210\u4efb\u52a1\u6267\u884c\u95ed\u73af',
            '\u4ea4\u4ed8\u8def\u7ebf\u5305\u542b\u684c\u9762\u5ba2\u6237\u7aef\u3001\u591a\u6a21\u578b\u7f16\u6392\u548c\u5b50\u7a0b\u5e8f',
          ].join('\\n'),
        }),
        ...verifiedDesktopReceipt,
      }],
      source: 'chat',
    });

    expect(result.blocked).toBe(false);
    expect(result.text).toContain('Lumi_\u8def\u6f14.pptx');
    expect(result.text).toContain('\u4e2a\u4eba\u8fde\u7eed\u6027');
    expect(result.text).toContain('\u6388\u6743\u4e0e\u53ef\u9a8c\u8bc1\u884c\u52a8');
    expect(result.text).not.toMatch(/execution_|desktop_|C:\\\\Users|\u56de\u6267|\u53d7\u963b|\u7ee7\u7eed\u6267\u884c/iu);
  });

  it('does not preserve a terminal “正在执行” claim from unrelated finished observations', async () => {
    const { finalizeLumiResponse } = await import('../server/cognition/result_finalizer');
    const result = finalizeLumiResponse({
      taskText: '\u53ef\u4ee5',
      responseText: '\u5df2\u5b8c\u6210\u73af\u5883\u68c0\u67e5\u3002\n\u6b63\u5728\u6267\u884c\u2014\u2014',
      toolRecords: [{
        name: 'desktop_list_apps',
        arguments: {},
        result: JSON.stringify({ ok: true, status: 'completed', apps: ['LumiCore'] }),
        ...verifiedDesktopReceipt,
      }, {
        name: 'desktop_active_window',
        arguments: {},
        result: JSON.stringify({ ok: true, title: 'LumiCore', process_name: 'lumi-core.exe' }),
        ...verifiedDesktopReceipt,
      }],
      source: 'chat',
    });

    expect(result.blocked).toBe(true);
    expect(result.text).toContain('\u64cd\u4f5c\u5df2\u7ecf\u7ed3\u675f');
    expect(result.text).not.toContain('\u6b63\u5728\u6267\u884c\u2014\u2014');
  });

  it('keeps a verified artifact completed while correcting a stray ongoing-status tail', async () => {
    const { finalizeLumiResponse } = await import('../server/cognition/result_finalizer');
    const root = mkdtempSync(path.join(os.tmpdir(), 'lumi-completed-artifact-status-'));
    const artifactPath = path.join(root, 'verified.txt');
    const content = 'verified artifact body';
    try {
      writeFileSync(artifactPath, content, 'utf8');
      const result = finalizeLumiResponse({
        taskText: `Create ${artifactPath} with the exact text "${content}", then read it back and verify it.`,
        responseText: 'The file was created and verified.\n\u6b63\u5728\u6267\u884c\u2014\u2014',
        toolRecords: [{
          name: 'write_file',
          arguments: { path: artifactPath, content },
          result: JSON.stringify({ ok: true, status: 'verified', path: artifactPath }),
          terminalVerification: { status: 'verified', strategy: 'artifact', reason: 'write verified' },
        }, {
          name: 'read_file',
          arguments: { path: artifactPath },
          result: content,
          terminalVerification: { status: 'verified', strategy: 'terminal_receipt', reason: 'readback verified' },
        }],
        source: 'chat',
      });

      expect(result.blocked).toBe(false);
      expect(result.text).toContain(artifactPath);
      expect(result.text).not.toContain('\u6b63\u5728\u6267\u884c\u2014\u2014');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.each([
    ['播放已启动，音量 72%。', '没有确认音乐已经开始播放'],
    ['文件已发送成功。', '没有取得发送成功的确认'],
    ['已经创建明早 7:30 的提醒。', '没有记录到提醒'],
    ['当前使用本地 TTS，音色是 Lumi‑Neutral v2。', '还没有读取当前语音或模型配置'],
  ])('blocks a terse-turn real-world claim without a verified receipt: %s', async (responseText, expected) => {
    const { finalizeLumiResponse } = await import('../server/cognition/result_finalizer');
    const result = finalizeLumiResponse({
      taskText: '嗯，对。',
      responseText,
      toolRecords: [],
      source: 'voice',
      taskId: 'task-current',
      requestId: 'request-current',
    });

    expect(result.blocked).toBe(true);
    expect(result.text).toContain(expected);
    expect(result.text).not.toMatch(/No successful|allowedTools|undefined|execution-status claim|tool execution/iu);
  });

  it.each([
    '文件保存成功的判断标准是什么？',
    '你说“文件已发送成功”，依据是什么？',
    '我已经打开思路了，我们继续聊。',
    '现在官方模型使用云端是什么意思？',
  ])('does not mistake an ordinary question, quotation, or abstract expression for execution: %s', async responseText => {
    const { finalizeLumiResponse } = await import('../server/cognition/result_finalizer');
    const result = finalizeLumiResponse({
      taskText: '解释一下。',
      responseText,
      toolRecords: [],
      source: 'chat',
      flow: { allowToolUseForTurn: false } as any,
    });

    expect(result.blocked).toBe(false);
    expect(result.text).toBe(responseText);
  });

  it('still blocks a concrete first-person completion claim without a receipt', async () => {
    const { finalizeLumiResponse } = await import('../server/cognition/result_finalizer');
    const result = finalizeLumiResponse({
      taskText: '随便聊聊。',
      responseText: '我已经打开浏览器了。',
      toolRecords: [],
      source: 'chat',
      flow: { allowToolUseForTurn: false } as any,
    });

    expect(result.blocked).toBe(true);
    expect(result.text).toContain('没有确认目标已经打开');
  });

  it('does not let an unrelated or stale receipt prove a terse send claim', async () => {
    const { finalizeLumiResponse } = await import('../server/cognition/result_finalizer');
    const result = finalizeLumiResponse({
      taskText: '确认。',
      responseText: '文件已发送成功。',
      toolRecords: [{
        name: 'wechat_send_file',
        arguments: { target: 'customer' },
        result: JSON.stringify({ ok: true, status: 'verified', sent: true }),
        taskId: 'task-stale',
        requestId: 'request-stale',
        terminalVerification: { status: 'verified', strategy: 'provider_ack', reason: 'old send' },
      }],
      source: 'wechat_bot',
      taskId: 'task-current',
      requestId: 'request-current',
    });

    expect(result.blocked).toBe(true);
    expect(result.text).toContain('没有取得发送成功的确认');
  });

  it('rejects a receipt whose top-level and envelope request identities conflict', async () => {
    const { finalizeLumiResponse } = await import('../server/cognition/result_finalizer');
    const result = finalizeLumiResponse({
      taskText: '确认。',
      responseText: '文件已发送成功。',
      toolRecords: [{
        name: 'wechat_send_file',
        arguments: { target: 'customer' },
        result: JSON.stringify({ ok: true, status: 'verified', sent: true }),
        taskId: 'task-current',
        requestId: 'request-current',
        terminalVerification: { status: 'verified', strategy: 'provider_ack', reason: 'provider acknowledged send' },
        envelope: {
          version: 1,
          status: 'verified_success',
          toolName: 'wechat_send_file',
          taskId: 'task-current',
          turnId: 'turn-current',
          requestId: 'request-stale',
          idempotencyKey: 'send-stale-envelope',
          targetIdentity: 'customer',
          completedAt: new Date().toISOString(),
          result: { sent: true },
          verification: { status: 'verified', reason: 'stale envelope' },
        },
      }],
      source: 'wechat_bot',
      taskId: 'task-current',
      requestId: 'request-current',
    });

    expect(result.blocked).toBe(true);
    expect(result.text).toContain('没有取得发送成功的确认');
  });

  it('accepts a terse send claim only with a verified receipt from the same task and request', async () => {
    const { finalizeLumiResponse } = await import('../server/cognition/result_finalizer');
    const responseText = '文件已发送成功。';
    const result = finalizeLumiResponse({
      taskText: '把 D:\\documents\\sample.pdf 发给 customer。',
      responseText,
      toolRecords: [{
        name: 'wechat_send_file',
        arguments: { target: 'customer', contact: 'customer', filePath: 'D:\\documents\\sample.pdf' },
        result: JSON.stringify({ ok: true, status: 'verified', sent: true, fileName: 'sample.pdf' }),
        taskId: 'task-current',
        requestId: 'request-current',
        terminalVerification: { status: 'verified', strategy: 'provider_ack', reason: 'provider acknowledged send' },
      }],
      source: 'wechat_bot',
      taskId: 'task-current',
      requestId: 'request-current',
    });

    expect(result.blocked).toBe(false);
    expect(result.text).toBe(responseText);
  });

  it('does not let a verified active-window observation masquerade as an open action', async () => {
    const { finalizeLumiResponse } = await import('../server/cognition/result_finalizer');
    const result = finalizeLumiResponse({
      taskText: '打开记事本。',
      responseText: '记事本已打开。',
      toolRecords: [{
        name: 'desktop_active_window',
        arguments: {},
        result: JSON.stringify({ ok: true, title: '无标题 - 记事本', processName: 'notepad.exe' }),
        taskId: 'task-open-current',
        requestId: 'request-open-current',
        terminalVerification: { status: 'verified', strategy: 'terminal_receipt', reason: 'active window observed' },
      }],
      source: 'chat',
      taskId: 'task-open-current',
      requestId: 'request-open-current',
    });

    expect(result.blocked).toBe(true);
    expect(result.text).toContain('没有确认目标已经打开');
  });

  it('does not let a generic computer-use receipt masquerade as verified playback', async () => {
    const { finalizeLumiResponse } = await import('../server/cognition/result_finalizer');
    const result = finalizeLumiResponse({
      taskText: '打开网易云音乐并播放歌曲。',
      responseText: '播放已启动。',
      toolRecords: [{
        name: 'computer_use',
        arguments: { instruction: '看一下桌面' },
        result: JSON.stringify({ ok: true, status: 'completed' }),
        taskId: 'task-play-current',
        requestId: 'request-play-current',
        terminalVerification: { status: 'verified', strategy: 'terminal_receipt', reason: 'desktop command returned' },
      }],
      source: 'chat',
      taskId: 'task-play-current',
      requestId: 'request-play-current',
    });

    expect(result.blocked).toBe(true);
    expect(result.text).toMatch(/没有确认.*播放/);
  });

  it('does not let message or settings reads masquerade as sends or runtime switches', async () => {
    const { finalizeLumiResponse } = await import('../server/cognition/result_finalizer');
    const baseRecord = {
      taskId: 'task-read-only-current',
      requestId: 'request-read-only-current',
      terminalVerification: { status: 'verified' as const, strategy: 'terminal_receipt' as const, reason: 'read completed' },
    };
    const sent = finalizeLumiResponse({
      taskText: '给 customer 发消息“你好”。',
      responseText: '消息已发送成功。',
      toolRecords: [{
        ...baseRecord,
        name: 'wechat_read_recent_chat',
        arguments: { contact: 'customer' },
        result: JSON.stringify({ ok: true, read: true }),
      }],
      source: 'chat',
      taskId: baseRecord.taskId,
      requestId: baseRecord.requestId,
    });
    const switched = finalizeLumiResponse({
      taskText: '把音色切换到 Lumi‑Neutral v2。',
      responseText: '已切换到 Lumi‑Neutral v2 音色。',
      toolRecords: [{
        ...baseRecord,
        name: 'settings_get',
        arguments: { section: 'voice' },
        result: JSON.stringify({ ok: true, voice: 'Lumi‑Neutral v2' }),
      }],
      source: 'chat',
      taskId: baseRecord.taskId,
      requestId: baseRecord.requestId,
    });

    expect(sent.blocked).toBe(true);
    expect(sent.text).toContain('没有取得发送成功的确认');
    expect(switched.blocked).toBe(true);
    expect(switched.text).toContain('还没有读取当前语音或模型配置');
  });

  it('keeps a verified same-turn PDF observation usable instead of relabeling it blocked', async () => {
    const { finalizeLumiResponse } = await import('../server/cognition/result_finalizer');
    const responseText = '这份文档的核心是项目交付边界和双方责任。';
    const result = finalizeLumiResponse({
      taskText: '分析一下 sample.pdf 附件。',
      responseText,
      toolRecords: [{
        name: 'read_pdf',
        arguments: { path: 'D:\\documents\\sample.pdf' },
        result: JSON.stringify({ ok: true, content: '项目交付边界与双方责任' }),
        taskId: 'task-read-pdf',
        requestId: 'request-read-pdf',
        terminalVerification: { status: 'verified', strategy: 'terminal_receipt', reason: 'PDF text returned' },
      }],
      source: 'wechat_bot',
      taskId: 'task-read-pdf',
      requestId: 'request-read-pdf',
    });

    expect(result.blocked).toBe(false);
    expect(result.text).toBe(responseText);
  });

  it('accepts a verified read_file for the same complete Windows path in a Chinese request with follow-up constraints', async () => {
    const { finalizeLumiResponse } = await import('../server/cognition/result_finalizer');
    const responseText = '项目 name 是 lumi-core，version 是 3.1.0。';
    const result = finalizeLumiResponse({
      taskText: '请读取 D:\\lumiOS\\package.json，只告诉我项目 name 和 version；不要修改任何文件。',
      responseText,
      toolRecords: [{
        name: 'read_file',
        arguments: { path: 'D:\\lumiOS\\package.json' },
        result: JSON.stringify({ kind: 'structured_result_summary', originalChars: 8192, resultOmitted: true }),
        taskId: 'task-windows-json',
        requestId: 'request-windows-json',
        terminalVerification: { status: 'verified', strategy: 'terminal_receipt', reason: 'file content returned' },
        envelope: {
          version: 1, status: 'verified_success', toolName: 'read_file',
          taskId: 'task-windows-json', turnId: 'turn-windows-json', requestId: 'request-windows-json',
          idempotencyKey: 'read-windows-json', targetIdentity: 'D:\\lumiOS\\package.json',
          completedAt: new Date().toISOString(), result: { name: 'lumi-core', version: '3.1.0' },
          verification: { status: 'verified', reason: 'exact path read' },
        },
      }],
      source: 'chat',
      taskId: 'task-windows-json',
      requestId: 'request-windows-json',
    });

    expect(result.blocked).toBe(false);
    expect(result.text).toBe(responseText);
    expect(result.reason).toContain('Grounded read-only document observation');
  });

  it('still rejects a verified read_file for a different complete Windows path', async () => {
    const { finalizeLumiResponse } = await import('../server/cognition/result_finalizer');
    const result = finalizeLumiResponse({
      taskText: '请读取 D:\\lumiOS\\package.json，只告诉我项目 name 和 version；不要修改任何文件。',
      responseText: '项目 name 是 other，version 是 0.0.0。',
      toolRecords: [{
        name: 'read_file',
        arguments: { path: 'D:\\other\\package.json' },
        result: JSON.stringify({ name: 'other', version: '0.0.0' }),
        taskId: 'task-wrong-windows-json',
        requestId: 'request-wrong-windows-json',
        terminalVerification: { status: 'verified', strategy: 'terminal_receipt', reason: 'other file content returned' },
        envelope: {
          version: 1, status: 'verified_success', toolName: 'read_file',
          taskId: 'task-wrong-windows-json', turnId: 'turn-wrong-windows-json', requestId: 'request-wrong-windows-json',
          idempotencyKey: 'read-wrong-windows-json', targetIdentity: 'D:\\other\\package.json',
          completedAt: new Date().toISOString(), result: { read: true },
          verification: { status: 'verified', reason: 'different exact path read' },
        },
      }],
      source: 'chat',
      taskId: 'task-wrong-windows-json',
      requestId: 'request-wrong-windows-json',
    });

    expect(result.blocked).toBe(true);
    expect(result.reason).toContain('target did not match');
  });

  it('does not let a verified read of another PDF complete the requested document analysis', async () => {
    const { finalizeLumiResponse } = await import('../server/cognition/result_finalizer');
    const result = finalizeLumiResponse({
      taskText: '分析 D:\\documents\\requested.pdf。',
      responseText: '这份文档的核心是错误目标里的内容。',
      toolRecords: [{
        name: 'read_pdf',
        arguments: { path: 'D:\\documents\\other.pdf' },
        result: JSON.stringify({ ok: true, content: '错误文件内容' }),
        taskId: 'task-wrong-pdf',
        requestId: 'request-wrong-pdf',
        terminalVerification: { status: 'verified', strategy: 'terminal_receipt', reason: 'other PDF text returned' },
      }],
      source: 'wechat_bot',
      taskId: 'task-wrong-pdf',
      requestId: 'request-wrong-pdf',
    });

    expect(result.blocked).toBe(true);
    expect(result.reason).not.toContain('Grounded read-only document observation');
  });

  it('accepts a generic attachment request when trusted attachment identities bind the read receipt', async () => {
    const { finalizeLumiResponse } = await import('../server/cognition/result_finalizer');
    const responseText = '附件说明了项目交付边界和双方责任。';
    const result = finalizeLumiResponse({
      taskText: '分析这个附件。', responseText, source: 'chat',
      taskId: 'task-attachment', requestId: 'request-attachment',
      toolRecords: [{
        name: 'read_pdf',
        arguments: { path: 'D:\\documents\\sample.pdf', attachmentId: 'attachment-123' },
        result: JSON.stringify({ ok: true, content: '项目交付边界与双方责任' }),
        taskId: 'task-attachment', requestId: 'request-attachment',
        terminalVerification: { status: 'verified', strategy: 'terminal_receipt', reason: 'PDF text returned' },
        envelope: {
          version: 1, status: 'verified_success', toolName: 'read_pdf',
          taskId: 'task-attachment', turnId: 'turn-attachment', requestId: 'request-attachment',
          idempotencyKey: 'attachment-read-123', targetIdentity: 'attachment-123',
          completedAt: new Date().toISOString(), result: { content: '项目交付边界与双方责任' },
          verification: { status: 'verified', reason: 'bound attachment read' },
        },
      }],
    });
    expect(result.blocked).toBe(false);
    expect(result.text).toBe(responseText);
  });

  it('keeps a PDF analysis incomplete when only the read step has a verified receipt', async () => {
    const { finalizeLumiResponse } = await import('../server/cognition/result_finalizer');
    const result = finalizeLumiResponse({
      taskText: '分析一下 sample.pdf 附件。',
      responseText: '状态：受阻。这次还没完成。',
      toolRecords: [{
        name: 'read_pdf',
        arguments: { path: 'D:\\documents\\sample.pdf' },
        result: JSON.stringify({ ok: true, content: '项目交付边界与双方责任' }),
        taskId: 'task-read-only-pdf',
        requestId: 'request-read-only-pdf',
        terminalVerification: { status: 'verified', strategy: 'terminal_receipt', reason: 'PDF text returned' },
      }],
      source: 'wechat_bot',
      taskId: 'task-read-only-pdf',
      requestId: 'request-read-only-pdf',
    });

    expect(result.blocked).toBe(true);
    expect(result.text).toContain('文件内容已经成功读取');
    expect(result.text).toContain('分析结论还没有生成');
    expect(result.text).not.toMatch(/No successful|current-turn|execution-status|undefined/iu);
    expect(result.reason).toContain('no usable analysis');
  });

  it('completes a plain document read from its verified receipt even when narration is empty', async () => {
    const { finalizeLumiResponse } = await import('../server/cognition/result_finalizer');
    const result = finalizeLumiResponse({
      taskText: '读取 sample.pdf 文件。',
      responseText: '',
      toolRecords: [{
        name: 'read_pdf',
        arguments: { path: 'D:\\documents\\sample.pdf' },
        result: JSON.stringify({ ok: true, content: '项目交付边界与双方责任' }),
        taskId: 'task-plain-read-pdf',
        requestId: 'request-plain-read-pdf',
        terminalVerification: { status: 'verified', strategy: 'terminal_receipt', reason: 'PDF text returned' },
      }],
      source: 'wechat_bot',
      taskId: 'task-plain-read-pdf',
      requestId: 'request-plain-read-pdf',
    });

    expect(result.blocked).toBe(false);
    expect(result.text).toBe('文件内容已成功读取。');
  });

  it('keeps socket entrypoints on the shared finalizer path', () => {
    const root = process.cwd();
    const chatSource = readFileSync(path.join(root, 'server/socket/chat.ts'), 'utf8');
    const voiceSource = readFileSync(path.join(root, 'server/socket/voice.ts'), 'utf8');
    const taskSource = readFileSync(path.join(root, 'server/socket/task.ts'), 'utf8');
    const socketSources = [chatSource, voiceSource, taskSource];

    for (const source of socketSources) {
      expect(source).toContain('finalizeLumiResponse');
      expect(source).not.toContain('guardCompletionClaims');
    }
    expect(chatSource).toContain('responseText = finalResponse.text;');
    expect(chatSource).not.toContain('responseText: completionCandidate');
    expect(chatSource).not.toContain('const completionText = finalizedBackground.text;');
    expect(voiceSource).toContain('responseText = finalResponse.text;');
    expect(taskSource).toContain('finalTaskText = finalTaskResponse.text;');
  });
});
