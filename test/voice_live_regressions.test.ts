import { describe, expect, it } from 'vitest';
import { buildQuickCommandToolPolicy, matchQuickCommand } from '../server/cognition/quick_commands';
import { buildActionContract } from '../server/cognition/action_contract';
import { buildRecentActionContinuationBridge } from '../server/cognition/action_continuation';
import { classifyIntent } from '../server/cognition/intent';
import { traceToolIntentDecision } from '../server/cognition/tool_intent';
import { finalizeLumiResponse } from '../server/cognition/result_finalizer';
import { parseWeChatConversationReadyVerification } from '../server/tools/definitions/external_app_tools';
import { describeRecentActionsFromHistory } from '../server/socket/voice_action_history';
import { resolveWeChatRecipientFromHistory } from '../server/socket/voice_messaging_context';
import { reservePriorityVoiceHandoff } from '../server/socket/voice';

describe('live voice regression cases', () => {
  it('preserves queued work and reserves the lane for confirmation or correction handoff', () => {
    const pipelineAbortController = new AbortController();
    const queued = [
      { text: 'next task one', queuedAt: '2026-07-26T00:00:00.000Z', voiceAuthorized: true },
      { text: 'next task two', queuedAt: '2026-07-26T00:00:01.000Z', voiceAuthorized: true },
    ];
    const session = {
      activeRoutingText: 'current durable task',
      pendingInterruptedTurn: null,
      activeTaskConversationId: 'conversation-1',
      activeTaskRequestId: 'request-1',
      userId: 'voice-user',
      bgGeneration: 1,
      isSpeaking: true,
      isProcessing: true,
      isOrchestrating: false,
      inputQueue: queued,
      accumulatedText: '',
      bargeinTimer: null,
      ttsAbortController: null,
      pipelineAbortController,
      sidecarAbortController: null,
      sidecarGeneration: 0,
      sidecarHistory: [],
      isBackgroundWork: true,
      activeWorkStatus: 'waiting_confirmation',
      activeWorkStep: 'waiting',
      activeWorkToolCalls: 1,
      workHeartbeatTimer: null,
      activeTurnRequestId: 'request-1',
      ttsDecayTimers: [],
    };

    reservePriorityVoiceHandoff(session as any, false);

    expect(session.inputQueue).toBe(queued);
    expect(session.inputQueue.map(item => item.text)).toEqual(['next task one', 'next task two']);
    expect(session.isProcessing).toBe(true);
    expect(pipelineAbortController.signal.aborted).toBe(true);
    expect(session.activeTaskConversationId).toBe('conversation-1');
    expect(session.activeTaskRequestId).toBe('request-1');
  });

  it('keeps combined WeChat inquiry out of the generic app-open quick path', async () => {
    expect(await matchQuickCommand('打开微信，问一下阿陆在干嘛。', 'u1')).toBeNull();
    expect(await matchQuickCommand('打开微信看下我有多少个联系人，把这些联系人的名字都记住。', 'u1')).toBeNull();
    expect(buildActionContract('打开微信，问一下阿陆在干嘛。').kind).toBe('messaging_send');
    expect(buildActionContract('我没有户型图发给你。').kind).toBe('none');
  });

  it('does not swallow a compound AutoCAD workflow as one app name', () => {
    expect(classifyIntent('打开微信')).toMatchObject({
      directToolCall: { name: 'desktop_open', args: { target: '微信' } },
      needsLLM: false,
    });
    const compound = classifyIntent('打开桌面上的阿陆文件夹，看一下里面的图和需求，在 AutoCAD 里面把这个需求画出来');
    expect(compound.directToolCall).toBeUndefined();
    expect(compound.needsLLM).toBe(true);
  });

  it('treats criticism of client navigation as feedback, not another navigation command', () => {
    const trace = traceToolIntentDecision('你能不能不要动不动就进入介绍客户端的界面啊', 'voice', 'assistant');
    expect(trace.allowToolUse).toBe(false);
    expect(trace.signals.clientActionOnlyIntent).toBe(false);
  });

  it('bridges a short app-page continuation to the real previous receipt', () => {
    const bridge = buildRecentActionContinuationBridge('切换到联系人页面', [
      { role: 'user', message: '打开微信' },
      {
        role: 'assistant',
        message: '已打开微信。',
        toolCalls: [{ name: 'desktop_open', arguments: { target: '微信' }, result: 'Opened WeChat' }],
      },
    ]);
    expect(bridge).toContain('Recent action continuation context');
    expect(bridge).toContain('desktop_open');
    expect(bridge).toContain('打开微信');
  });

  it('focuses an existing app without treating the rest of the sentence as its name', async () => {
    expect(await matchQuickCommand('打开正在运行的微信，不要启动新的微信。', 'u1')).toMatchObject({
      toolCall: { name: 'desktop_open', arguments: { target: '微信' } },
    });
    const feedback = await matchQuickCommand('打开了。', 'u1');
    expect(feedback).toMatchObject({
      responseText: '好，已经打开了。',
    });
    expect(feedback?.toolCall).toBeUndefined();
  });

  it('adds only the deterministic quick tool to a non-forbidden route policy', () => {
    const policy = buildQuickCommandToolPolicy({
      allowedTools: ['client_get_state'],
      forbiddenTools: ['desktop_run_command'],
      requireConfirmation: [],
      maxIterations: 4,
    }, 'browser_open_task');
    expect(policy?.allowedTools).toEqual(['client_get_state', 'browser_open_task']);
    expect(buildQuickCommandToolPolicy({ ...policy!, forbiddenTools: ['browser_open_task'] }, 'browser_open_task'))
      .toMatchObject({ forbiddenTools: ['browser_open_task'] });
  });

  it('uses dedicated browser and knowledge tools for the exact spoken requests', async () => {
    expect(await matchQuickCommand('你能听到我吗？', 'u1')).toMatchObject({
      responseText: '能听见。你说。',
      matched: true,
    });
    expect(await matchQuickCommand('打开浏览器。', 'u1')).toMatchObject({
      toolCall: { name: 'browser_open_task' },
    });
    expect(await matchQuickCommand('打开中国裁判文书网。', 'u1')).toMatchObject({
      toolCall: {
        name: 'browser_open_task',
        arguments: { url: 'https://wenshu.court.gov.cn/', open: true },
      },
    });
    expect(await matchQuickCommand('看一下现在知识库里有多少的文件内容。', 'u1')).toMatchObject({
      toolCall: { name: 'knowledge_file_stats' },
    });
  });

  it('answers the current operation mode without running the full voice pipeline', async () => {
    expect(await matchQuickCommand('你现在是什么模式？', 'u1')).toMatchObject({
      responseText: expect.stringMatching(/^当前是(?:聊天|助理|自主|会议)模式。$/),
      matched: true,
    });
  });

  it('resolves a recipient pronoun from the latest real WeChat tool call', () => {
    const resolved = resolveWeChatRecipientFromHistory({ contact: '他', message: '在干嘛？' }, [{
      role: 'assistant',
      toolCalls: JSON.stringify([{
        name: 'wechat_send_message',
        arguments: { contact: '阿陆', message: '在干嘛？' },
        result: '{"sent":false}',
      }]),
    }]);
    expect(resolved.contact).toBe('阿陆');
  });

  it('requires strong visible evidence before treating a searched chat as ready', () => {
    expect(parseWeChatConversationReadyVerification('{"ready":true,"confidence":0.91,"reason":"exact chat header and composer"}').ready).toBe(true);
    expect(parseWeChatConversationReadyVerification('{"ready":true,"confidence":0.42,"reason":"only search results"}').ready).toBe(false);
    expect(parseWeChatConversationReadyVerification('{"ready":false,"confidence":0.99,"reason":"wrong chat"}').ready).toBe(false);
  });

  it('answers what just happened from tool receipts instead of inventing an explanation', () => {
    const response = describeRecentActionsFromHistory('我问你刚刚干了什么？你打开微信干了什么。', [{
      role: 'assistant',
      toolCalls: [{
        name: 'wechat_send_message',
        arguments: { contact: '阿路', message: '在干嘛？' },
        result: JSON.stringify({ sent: false, sendAttempted: true, verificationStatus: 'uncertain' }),
      }],
    }]);
    expect(response).toContain('搜索了“阿路”');
    expect(response).toContain('不能算发送成功');
  });

  it('does not call an unverified sent flag a successful WeChat send', () => {
    const response = describeRecentActionsFromHistory('我问你刚刚干了什么？微信发出去了吗。', [{
      role: 'assistant',
      toolCalls: [{
        name: 'wechat_send_message',
        arguments: { contact: '阿路', message: '在干嘛？' },
        result: JSON.stringify({
          sent: true,
          sendAttempted: true,
          verificationStatus: 'uncertain',
        }),
      }],
    }]);

    expect(response).toContain('不能算发送成功');
  });

  it('does not describe an empty or failed desktop_open receipt as opened', () => {
    for (const result of ['', '{"status":"failed","error":"not found"}']) {
      const response = describeRecentActionsFromHistory('我问你刚刚打开微信干了什么。', [{
        role: 'assistant',
        toolCalls: [{
          name: 'desktop_open',
          arguments: { target: '微信' },
          result,
        }],
      }]);
      expect(response).not.toContain('已经打开');
    }
  });

  it('keeps AutoCAD status questions aligned to CAD receipts instead of newer WeChat receipts', () => {
    const response = describeRecentActionsFromHistory('刚刚那个 AutoCAD 任务执行得怎么样？', [
      {
        role: 'assistant',
        toolCalls: [{
          name: 'cad_prepare_autocad_operations',
          arguments: { source: 'C:\\Desktop\\阿陆' },
          result: JSON.stringify({ status: 'prepared' }),
        }],
      },
      {
        role: 'assistant',
        toolCalls: [{
          name: 'wechat_send_message',
          arguments: { contact: '阿陆', message: '在干嘛？' },
          result: JSON.stringify({ sent: false }),
        }],
      },
    ]);
    expect(response).toContain('AutoCAD');
    expect(response).not.toContain('微信');
  });

  it('keeps a successful simple AutoCAD open response concise', () => {
    const result = finalizeLumiResponse({
      taskText: '打开AutoCAD。',
      responseText: '已打开AutoCAD。',
      toolRecords: [{
        name: 'desktop_open',
        arguments: { target: 'AutoCAD' },
        result: 'Opened app AutoCAD via desktop shortcut',
      }],
      source: 'voice',
    });
    expect(result.text).toBe('已打开AutoCAD。');
    expect(result.text).not.toContain('桌面状态读取');
  });

  it('keeps a successful website open out of the completion blocker', () => {
    const result = finalizeLumiResponse({
      taskText: '打开中国裁判文书网。',
      responseText: '已打开中国裁判文书网。',
      toolRecords: [{
        name: 'browser_open_task',
        arguments: { url: 'https://wenshu.court.gov.cn/', open: true },
        result: JSON.stringify({ opened: true, result: 'Opened: https://wenshu.court.gov.cn/' }),
      }],
      source: 'voice',
    });
    expect(result.blocked).toBe(false);
    expect(result.text).toContain('已打开');
  });

  it('does not replace an unrelated action answer with a client self-check dump', () => {
    const result = finalizeLumiResponse({
      taskText: '桌面上有一张叫设计草稿的图片，把它画到 AutoCAD 里。',
      responseText: '还没有完成 AutoCAD 绘制。',
      toolRecords: [{
        name: 'client_get_state',
        arguments: {},
        result: JSON.stringify({ state: { mode: 'assistant' }, health: { level: 'healthy' } }),
      }],
      source: 'voice',
    });
    expect(result.text).toBe('还没有完成 AutoCAD 绘制。');
    expect(result.text).not.toContain('自检');
  });

  it('keeps the real voice tool ledger factual when client_get_state succeeds but desktop tools never ran', () => {
    const result = finalizeLumiResponse({
      taskText: '组建团队，分两步执行，先查看当前活动窗口，再列出桌面文件，最后根据真实工具结果告诉我窗口标题和文件数量。',
      responseText: '已完成查看当前活动窗口并列出桌面文件。',
      toolRecords: [{
        name: 'client_get_state',
        arguments: {},
        result: JSON.stringify({
          selfAwareness: {
            level: 'live',
            habits: [
              'Some external actions require user confirmation.',
              '其他受控动作需要确认；本次 client_get_state 已成功返回。',
            ],
          },
          capabilities: Array.from({ length: 80 }, (_, index) => ({
            id: `voice-capability-${index}`,
            requiresConfirmation: index % 2 === 0,
            notes: `Nested capability ${index} may require confirmation for writes.`,
          })),
          state: { mode: 'assistant', activeTab: 'home', runtimeStatus: 'ready' },
          health: { level: 'attention' },
          scope: { domain: 'personal' },
        }),
      }],
      source: 'voice',
    });

    expect(result.blocked).toBe(true);
    expect(result.text).toContain('已成功执行：client_get_state');
    expect(result.text).toContain('不是完成当前请求所需的执行证据');
    expect(result.text).not.toContain('这一轮没有成功执行任何工具');
    expect(result.text).not.toContain('没有记录到成功的工具执行');
    expect(result.text).not.toContain('undefined');
  });
});
