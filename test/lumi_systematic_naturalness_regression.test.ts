import './helpers';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { initDatabase } from '../db_layer';
import {
  buildActionContract,
  hasCoreActionEvidence,
  requiresDesktopAiAnswerReadback,
  requiresDesktopAiRequest,
} from '../server/cognition/action_contract';
import {
  type ConversationActionContinuationState,
} from '../server/cognition/action_continuation';
import {
  buildDesktopObservationPlan,
  formatDesktopObservationResult,
} from '../server/cognition/desktop_observation';
import { buildLumiExecutionPipeline } from '../server/cognition/execution_pipeline';
import { resolveAcceptedTaskTarget } from '../server/conversation/task_target_anchor';
import { registerAllTools } from '../server/tools/definitions';
import { normalizeActionIntent } from '../server/cognition/normalized_action_intent';
import { finalizeLumiResponse } from '../server/cognition/result_finalizer';
import {
  addMemory,
  classifyMemoryEvidence,
  CONVERSATIONAL_MEMORY_EVIDENCE,
  formatMemoriesForContext,
  queryMemories,
} from '../server/memory/store';
import { normalizeVoiceHistory, normalizeVoiceHistoryRecord } from '../server/socket/voice';
import { registerExternalAppTools } from '../server/tools/definitions/external_app_tools';
import { isToolNameAllowedByPolicy, ToolRegistry, toolRegistry } from '../server/tools/registry';

const verifiedDesktopReceipt = {
  terminalVerification: {
    status: 'verified' as const,
    strategy: 'terminal_receipt' as const,
    reason: 'Fresh desktop snapshot returned by the connected desktop client.',
  },
};

describe('systematic naturalness regressions', () => {
  beforeAll(async () => {
    await initDatabase();
  });

  it('recognizes a natural running-software count and answers from one process receipt', () => {
    const text = '你看一下现在后台有多少个软件在运行';
    expect(buildDesktopObservationPlan(text)).toEqual([
      { name: 'desktop_running_processes', arguments: { top: 20 } },
    ]);
    const answer = formatDesktopObservationResult([{
      name: 'desktop_running_processes',
      arguments: { top: 50 },
      result: JSON.stringify([
        { pid: 1, name: 'chrome.exe' },
        { pid: 2, name: 'chrome.exe' },
        { pid: 3, name: 'Weixin.exe' },
      ]),
      ...verifiedDesktopReceipt,
    }], text);
    expect(answer).toContain('3 个活跃进程条目');
    expect(answer).toContain('2 个进程名称');
    expect(answer).toContain('当前采样');
  });

  it('keeps deterministic desktop observation scripts as non-executing planner hints', async () => {
    const execute = vi.spyOn(toolRegistry, 'execute').mockResolvedValue(JSON.stringify([
      { pid: 1, name: 'wps.exe' },
      { pid: 2, name: 'Weixin.exe' },
    ]));
    try {
      const result = buildLumiExecutionPipeline({
        dispatch: { text: '现在后台有几个软件在运行？', userId: 'naturalness-observation', channel: 'voice',
          source: 'voice', operationMode: 'assistant', targetIsLumi: true },
        registry: toolRegistry,
      });
      expect(result.intentTrace.normalizedActionIntent).toEqual(result.normalizedIntent);
      expect(execute).not.toHaveBeenCalled();
    } finally {
      execute.mockRestore();
    }
  });

  it('binds an open follow-up to its persisted producer receipt without guessing for a new target', () => {
    const path = 'D:/lumi_output/customer-report.docx';
    const persistedHistory = [{ id: 'created-document', role: 'assistant', requestId: 'produce-doc', message: 'Created', toolCalls: [{
      name: 'create_docx', requestId: 'produce-doc', result: JSON.stringify({ ok: true, path }), terminalVerification: { status: 'verified' },
    }] }];
    const accepted = resolveAcceptedTaskTarget({ text: '打开刚才生成的文件', persistedHistory });
    expect(accepted).toMatchObject({ source: 'prior_tool_receipt', sourceId: 'created-document' });
    expect(accepted?.target.path.replaceAll('\\', '/')).toBe(path);
    expect(resolveAcceptedTaskTarget({ text: '打开浏览器', persistedHistory })).toBeUndefined();
  });

  it('does not reopen a receipt target for a retrospective status question', () => {
    const state: ConversationActionContinuationState = {
      version: 1,
      goal: 'open Notepad',
      latestInstruction: 'open Notepad',
      appTarget: 'Notepad',
      sourcePaths: ['Notepad'],
      latestBlocker: '',
      unfinished: false,
      evidenceTools: ['desktop_open'],
      assistantState: 'opened',
      toolSummaries: ['desktop_open succeeded'],
      updatedAt: new Date().toISOString(),
    };
    const pipeline = buildLumiExecutionPipeline({
      dispatch: { text: '刚才打开了什么？不要执行新操作。', userId: 'naturalness-status', channel: 'voice', source: 'voice', operationMode: 'assistant', targetIsLumi: true },
      registry: toolRegistry, actionTaskState: state,
    });
    expect(pipeline.executionRequested).toBe(false);
    expect(pipeline.normalizedIntent.kind).toBe('status_query');
  });

  it('keeps saved-session login available in shared planning', () => {
    const registry = new ToolRegistry();
    registerAllTools(registry);
    const result = buildLumiExecutionPipeline({
      dispatch: { text: '登录中国裁判文书网', userId: 'naturalness-login', channel: 'voice', source: 'voice', operationMode: 'assistant', targetIsLumi: true },
      registry,
    });
    expect(result.executionRequested).toBe(true);
    expect(result.modelToolProjection.toolNames).toContain('web_login_run');
  });

  it('uses one canonical wildcard policy for model visibility and execution', async () => {
    const registry = new ToolRegistry();
    registry.register({
      name: 'policy_probe',
      description: 'policy probe',
      parameters: { type: 'object', properties: {} },
      handler: async () => 'ok',
      permission: 'user',
      securityLevel: 'safe',
    });
    const wildcardAfterExplicit = {
      allowedTools: ['another_tool', '*'],
      requireConfirmation: [],
      forbiddenTools: [],
      maxIterations: 2,
    };
    expect(isToolNameAllowedByPolicy('policy_probe', wildcardAfterExplicit)).toBe(true);
    await expect(registry.execute('policy_probe', {}, { toolPolicy: wildcardAfterExplicit })).resolves.toBe('ok');

    const forbiddenWildcard = { ...wildcardAfterExplicit, forbiddenTools: ['*'] };
    expect(isToolNameAllowedByPolicy('policy_probe', forbiddenWildcard)).toBe(false);
    await expect(registry.execute('policy_probe', {}, { toolPolicy: forbiddenWildcard })).rejects.toThrow('forbidden');
  });

  it('passes an explicitly requested browser through to the native desktop relay', async () => {
    const registry = new ToolRegistry();
    registerExternalAppTools(registry);
    const calls: Array<{ name: string; args: Record<string, any> }> = [];
    const result = JSON.parse(await registry.execute('browser_open_task', {
      url: 'https://example.com/account',
      open: true,
      browser: 'Google Chrome',
    }, {
      desktopRelay: async (name, args) => {
        calls.push({ name, args });
        return `Opened: ${args.target}`;
      },
    }));
    expect(calls).toEqual([{
      name: 'desktop_open',
      args: { target: 'https://example.com/account', application: 'Google Chrome' },
    }]);
    expect(result).toMatchObject({ opened: true, browser: 'Google Chrome' });
  });

  it('requires a real submission and visible answer from one desktop AI tool', () => {
    const text = '我让你跟 ChatGPT 聊天，把它的回答告诉我';
    expect(requiresDesktopAiRequest(text)).toBe(true);
    expect(requiresDesktopAiAnswerReadback(text)).toBe(true);
    const contract = buildActionContract(text);
    expect(contract.label).toBe('Verified external AI tool request');
    expect(hasCoreActionEvidence(contract, [{
      name: 'desktop_open',
      arguments: { target: 'ChatGPT' },
      result: '{"ok":true}',
    }], text)).toBe(false);
    const submitted = {
      name: 'desktop_ai_ask',
      arguments: { question: '你怎么看？', target: 'chatgpt' },
      result: '{"ok":true,"status":"prepared","results":[{"targetId":"chatgpt","status":"prepared"}]}',
    };
    expect(hasCoreActionEvidence(contract, [submitted], text)).toBe(false);
    expect(hasCoreActionEvidence(contract, [submitted, {
      name: 'desktop_ai_collect_answer',
      arguments: { target: 'chatgpt' },
      result: '{"ok":true,"status":"collected","answerText":"这是可见回答。"}',
    }], text)).toBe(true);
  });

  it('reports artifact creation as successful even when the requested open step fails', () => {
    const result = finalizeLumiResponse({
      taskText: '创建一个 Word 文档并打开',
      responseText: '任务失败。',
      toolRecords: [{
        name: 'create_docx',
        arguments: { title: '客户报告' },
        result: 'DOCX created: D:\\lumi_output\\客户报告.docx (1200 bytes)',
        terminalVerification: { status: 'verified', strategy: 'artifact', reason: 'Created file verified by the tool engine.' },
      }, {
        name: 'desktop_path_info',
        arguments: { target: 'D:\\lumi_output\\客户报告.docx' },
        result: '{"exists":true,"size":1200}',
      }, {
        name: 'desktop_open',
        arguments: { target: 'D:\\lumi_output\\客户报告.docx' },
        result: '',
        error: 'open failed',
      }],
      source: 'voice',
    });
    expect(result.blocked).toBe(true);
    expect(result.text).toContain('文件已保存');
    expect(result.text).toContain('尚未确认在指定软件中打开');
  });

  it('keeps compact tool evidence without replaying old assistant claims into ordinary voice chat', () => {
    const toolHistory = normalizeVoiceHistoryRecord({
      role: 'assistant',
      message: '后台有 50 个进程。',
      toolCalls: [{ name: 'desktop_running_processes', result: '[]' }],
    });
    expect(toolHistory).toHaveLength(1);
    expect(toolHistory[0].content).toContain('desktop_running_processes');
    expect(toolHistory[0].content).toContain('items=0');
    expect(toolHistory[0].content).not.toContain('50 个进程');
    expect(normalizeVoiceHistoryRecord({
      role: 'assistant',
      message: '我们接着聊。',
      toolCalls: [],
    })).toEqual([{ role: 'assistant', content: '我们接着聊。' }]);
    expect(normalizeVoiceHistory([
      { role: 'user', message: '打开 AutoCAD 并画图' },
      {
        role: 'assistant',
        message: '已打开 AutoCAD。',
        toolCalls: [{ name: 'desktop_open', result: '{"status":"opened"}' }],
      },
      { role: 'user', message: '你的音频怎么降级了？' },
      { role: 'assistant', message: '当前语音没有切换备用音色。', toolCalls: [] },
    ])).toEqual([
      { role: 'user', content: '打开 AutoCAD 并画图' },
      expect.objectContaining({ role: 'assistant', content: expect.stringContaining('desktop_open') }),
      { role: 'user', content: '你的音频怎么降级了？' },
      { role: 'assistant', content: '当前语音没有切换备用音色。' },
    ]);
  });

  it('blocks a zero-receipt old-task activity claim in ordinary conversation', () => {
    const result = finalizeLumiResponse({
      taskText: '你的音频怎么降级了？',
      responseText: '工具链路已经恢复，我现在开始处理 WPS 和网易云音乐。',
      toolRecords: [],
      source: 'voice',
    });
    expect(result.blocked).toBe(true);
    expect(result.text).toContain('混入了旧任务内容');
  });

  it('filters generated growth/proactive traces from ordinary memory recall', () => {
    const token = `natural-memory-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const userId = `user-${token}`;
    const direct = addMemory({
      userId,
      type: 'preference',
      content: `${token} 用户明确喜欢简洁回复`,
      keywords: [token],
      confidence: 0.95,
      sourceInteractionId: `direct_${token}`,
    }, { source: 'import' });
    addMemory({
      userId,
      type: 'knowledge',
      content: `[Proactive Scan] ${token} poetic generated narrative`,
      keywords: [token],
      confidence: 0.99,
      sourceInteractionId: `proactive_scan_${token}`,
    }, { source: 'import' });

    const recalled = queryMemories({ userId, query: token, limit: 10 });
    expect(recalled.map(memory => memory.id)).toEqual([direct.id]);
  });

  it('keeps Lumi narrative out of owner evidence without deleting it', () => {
    const token = `evidence-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const userId = `user-${token}`;
    const owner = addMemory({
      userId,
      type: 'preference',
      content: `${token} 用户明确说喜欢直接回答`,
      keywords: [token],
      confidence: 0.95,
      sourceInteractionId: `voice_${token}`,
    }, { source: 'voice', perspective: 'owner_trait' });
    const narrative = addMemory({
      userId,
      type: 'knowledge',
      content: `${token} Lumi 觉得沉默代表信任`,
      keywords: [token],
      confidence: 0.99,
      sourceInteractionId: `growth_${token}`,
    }, { source: 'system', perspective: 'lumi_growth', tier: 'growth' });

    expect(classifyMemoryEvidence(owner)).toBe('owner_statement');
    expect(classifyMemoryEvidence(narrative)).toBe('lumi_narrative');
    const ownerContext = queryMemories({
      userId,
      query: token,
      limit: 10,
      evidenceClasses: CONVERSATIONAL_MEMORY_EVIDENCE,
    });
    expect(ownerContext.map(memory => memory.id)).toEqual([owner.id]);
    expect(queryMemories({ userId, query: token, limit: 10 }).map(memory => memory.id)).toContain(narrative.id);
    expect(formatMemoriesForContext([owner, narrative])).toContain('[Lumi narrative]');
  });
});
