import './helpers';
import { beforeAll, describe, expect, it } from 'vitest';
import { initDatabase } from '../db_layer';
import {
  addMessageIdempotent,
  getOrCreateActiveConversation,
} from '../server/conversation/manager';
import {
  formatConversationExecutionFactAnswer,
  getConversationExecutionFacts,
  isConversationExecutionFactQuestion,
} from '../server/conversation/execution_facts';

describe('conversation execution facts', () => {
  beforeAll(async () => {
    await initDatabase();
  });

  it('answers the exact previous-turn tool-receipt question with only tool name and outcome', () => {
    const text = '你上一轮是否真的调用过工具？不要再次调用工具，只根据已保存的回执告诉我：工具名、成功还是失败。';
    expect(isConversationExecutionFactQuestion(text)).toBe(true);
    const answer = formatConversationExecutionFactAnswer({
      toolCalls: [{
        name: 'desktop_active_window',
        error: false,
        turnId: 'prior-window-turn',
        result: JSON.stringify({ ok: true, status: 'verified', title: 'LumiCore' }),
        terminalVerification: { status: 'verified' },
        envelope: { status: 'verified_success', verification: { status: 'verified' } },
      }, {
        name: 'desktop_poll_activity',
        error: false,
        turnId: 'older-turn',
        result: JSON.stringify({ ok: true, status: 'verified' }),
      }],
      priorTurnToolCalls: [{
        name: 'desktop_active_window',
        error: false,
        turnId: 'prior-window-turn',
        result: JSON.stringify({ ok: true, status: 'verified', title: 'LumiCore' }),
        terminalVerification: { status: 'verified' },
        envelope: { status: 'verified_success', verification: { status: 'verified' } },
      }],
      tasks: [],
    }, text);

    expect(answer).toBe('上一轮确实调用了工具：desktop_active_window（成功）。');
    expect(answer).not.toMatch(/desktop_poll_activity|保存产物|写入|验收记录|No successful current-turn tool execution/iu);
  });

  it('binds a queued prior-turn receipt by request id when assistant1 is stored after user2', () => {
    const suffix = `${Date.now()}-${Math.random()}`;
    const userId = `execution-facts-queued-${suffix}`;
    const conversation = getOrCreateActiveConversation(userId, 'lumi', 'personal', '');
    const firstRequestId = `queued-first-${suffix}`;
    const secondRequestId = `queued-second-${suffix}`;
    const common = {
      userId,
      agentId: 'lumi',
      conversationId: conversation.id,
      domain: 'personal',
      orgId: '',
      source: 'command-center-chat',
      channel: 'chat',
    } as const;

    addMessageIdempotent({
      ...common,
      role: 'user',
      content: '查看当前前台窗口。',
      requestId: firstRequestId,
      deferActionPreparation: true,
    });
    addMessageIdempotent({
      ...common,
      role: 'user',
      content: '你上一轮是否真的调用过工具？不要再次调用工具，只根据已保存的回执告诉我：工具名、成功还是失败。',
      requestId: secondRequestId,
      deferActionPreparation: true,
    });
    addMessageIdempotent({
      ...common,
      role: 'assistant',
      content: '当前前台窗口是 LumiCore。',
      requestId: firstRequestId,
      toolCalls: [{
        id: `queued-window-receipt-${suffix}`,
        name: 'desktop_active_window',
        arguments: {},
        result: JSON.stringify({ ok: true, status: 'verified', title: 'LumiCore' }),
        terminalVerification: {
          status: 'verified',
          strategy: 'terminal_receipt',
          reason: 'active window returned',
        },
        envelope: {
          status: 'verified_success',
          verification: { status: 'verified' },
        },
      }],
    });

    const facts = getConversationExecutionFacts({
      conversationId: conversation.id,
      userId,
      domain: 'personal',
      orgId: '',
      currentRequestId: secondRequestId,
    });

    expect(facts.priorTurnToolCalls).toHaveLength(1);
    expect(facts.priorTurnToolCalls?.[0]).toMatchObject({
      name: 'desktop_active_window',
      requestId: firstRequestId,
      error: false,
    });
    expect(formatConversationExecutionFactAnswer(
      facts,
      '你上一轮是否真的调用过工具？不要再次调用工具，只根据已保存的回执告诉我：工具名、成功还是失败。',
    )).toBe('上一轮确实调用了工具：desktop_active_window（成功）。');
  });

  it('recalls the exact prior single-file result without re-reading or accepting an older receipt', () => {
    const suffix = `${Date.now()}-${Math.random()}`;
    const userId = `execution-facts-file-${suffix}`;
    const conversation = getOrCreateActiveConversation(userId, 'lumi', 'personal', '');
    const olderRequestId = `file-older-${suffix}`;
    const readRequestId = `file-read-${suffix}`;
    const followupRequestId = `file-followup-${suffix}`;
    const common = {
      userId,
      agentId: 'lumi',
      conversationId: conversation.id,
      domain: 'personal',
      orgId: '',
      source: 'command-center-chat',
      channel: 'chat',
    } as const;

    addMessageIdempotent({
      ...common,
      role: 'user',
      content: '读取 D:\\other\\stale.json。',
      requestId: olderRequestId,
      deferActionPreparation: true,
    });
    addMessageIdempotent({
      ...common,
      role: 'assistant',
      content: '旧文件读取完成。',
      requestId: olderRequestId,
      toolCalls: [{
        name: 'read_file',
        arguments: { path: 'D:\\other\\stale.json' },
        result: JSON.stringify({ kind: 'structured_result_summary', resultOmitted: true }),
        terminalVerification: { status: 'verified' },
        envelope: {
          status: 'verified_success',
          toolName: 'read_file',
          requestId: olderRequestId,
          targetIdentity: 'D:\\other\\stale.json',
          result: { name: 'wrong-project', version: '0.0.1' },
          verification: { status: 'verified' },
        },
      }],
    });
    addMessageIdempotent({
      ...common,
      role: 'user',
      content: '请读取 D:\\lumiOS\\package.json，只告诉我项目 name 和 version。',
      requestId: readRequestId,
      deferActionPreparation: true,
    });
    addMessageIdempotent({
      ...common,
      role: 'assistant',
      content: '模型文字错误地猜测读取了 D:\\invented\\model-guess.json。',
      requestId: readRequestId,
      toolCalls: [{
        name: 'read_file',
        arguments: { path: 'D:\\lumiOS\\package.json' },
        result: JSON.stringify({ kind: 'structured_result_summary', originalChars: 7618, resultOmitted: true }),
        terminalVerification: { status: 'verified' },
        envelope: {
          status: 'verified_success',
          toolName: 'read_file',
          requestId: readRequestId,
          targetIdentity: 'D:\\lumiOS\\package.json',
          result: {
            name: 'lumi-core',
            private: true,
            version: '3.1.0',
            read: 'incidental field must not be exposed',
            apiToken: 'must-not-be-exposed',
          },
          verification: { status: 'verified' },
        },
      }, {
        name: 'read_file',
        arguments: { path: 'D:\\forged\\wrong.json' },
        result: JSON.stringify({ name: 'forged-project', version: '9.9.9' }),
        terminalVerification: { status: 'verified' },
        envelope: {
          status: 'verified_success',
          toolName: 'read_file',
          requestId: `different-request-${suffix}`,
          targetIdentity: 'D:\\forged\\wrong.json',
          result: { name: 'forged-project', version: '9.9.9' },
          verification: { status: 'verified' },
        },
      }],
    });
    addMessageIdempotent({
      ...common,
      role: 'user',
      content: '刚才读取的是哪个精确文件？把路径、name 和 version 分三行告诉我，不要重新读取。',
      requestId: followupRequestId,
      deferActionPreparation: true,
    });

    const question = '刚才读取的是哪个精确文件？把路径、name 和 version 分三行告诉我，不要重新读取。';
    expect(isConversationExecutionFactQuestion(question)).toBe(true);
    expect(isConversationExecutionFactQuestion('请重新读取刚才的文件，再告诉我 name 和 version。')).toBe(false);
    expect(isConversationExecutionFactQuestion('不要猜旧值，请重新读取刚才的文件，再告诉我 name 和 version。')).toBe(false);
    expect(isConversationExecutionFactQuestion(
      '不是那个路径，改成读取 C:\\Users\\owner\\correct.txt，继续刚才的同一个任务。',
    )).toBe(false);
    expect(isConversationExecutionFactQuestion(
      'Continue the previous task, but change it to read C:\\Users\\owner\\correct.txt.',
    )).toBe(false);
    expect(isConversationExecutionFactQuestion('刚才读取路径和版本。')).toBe(false);
    expect(isConversationExecutionFactQuestion('Without re-reading, tell me the exact path, name, and version from the previous file read.')).toBe(true);
    const facts = getConversationExecutionFacts({
      conversationId: conversation.id,
      userId,
      domain: 'personal',
      orgId: '',
      currentRequestId: followupRequestId,
    });

    expect(facts.priorTurnToolCalls).toHaveLength(2);
    const answer = formatConversationExecutionFactAnswer(facts, question);
    expect(answer).toBe([
      '刚才读取的是 `D:\\lumiOS\\package.json`。',
      '- name：`lumi-core`',
      '- version：`3.1.0`',
    ].join('\n'));
    expect(answer).not.toMatch(/wrong-project|stale\.json|model-guess|forged|9\.9\.9|private|incidental|apiToken|must-not|read_file|重新读取/iu);
  });

  it('recognizes factual questions about tool and task execution', () => {
    expect(isConversationExecutionFactQuestion('这轮对话里你有没有真的执行工具或创建任务？')).toBe(true);
    expect(isConversationExecutionFactQuestion('你能不能调用工具？')).toBe(false);
  });

  it('answers zero execution directly without turning the denial into a claim', () => {
    expect(formatConversationExecutionFactAnswer({ toolCalls: [], tasks: [] }, '这轮对话有执行吗？'))
      .toBe('没有。这段对话没有记录到工具调用，也没有创建任务。');
  });

  it('explains the latest failed receipt instead of replaying a terminal stale task', () => {
    const text = '为什么失败？';
    expect(isConversationExecutionFactQuestion(text)).toBe(true);
    const answer = formatConversationExecutionFactAnswer({
      toolCalls: [{
        name: 'desktop_execution_plan_receipt',
        error: false,
        turnId: 'corrupted-old-turn',
        result: JSON.stringify({ ok: true, status: 'completed' }),
        terminalVerification: { status: 'verified' },
      }, {
        name: 'ocr_screen',
        error: true,
        errorDetail: '400 status code (no body)',
        turnId: 'latest-failed-turn',
        result: '',
        terminalVerification: { status: 'failed' },
      }],
      priorTurnToolCalls: [{
        name: 'ocr_screen',
        error: true,
        errorDetail: '400 status code (no body)',
        turnId: 'latest-failed-turn',
        result: '',
        terminalVerification: { status: 'failed' },
      }],
      tasks: [{ id: 'corrupted-old-task', status: 'completed' }],
    }, text);

    expect(answer).toBe('刚才失败在视觉识别：服务返回 HTTP 400，但没有提供错误正文。');
    expect(answer).not.toMatch(/completed|已完成|corrupted|undefined|ocr_screen/iu);
  });

  it('does not invent a failure reason when the adjacent turn has no failed receipt', () => {
    expect(formatConversationExecutionFactAnswer({
      toolCalls: [],
      priorTurnToolCalls: [],
      tasks: [{ id: 'stale-terminal', status: 'completed' }],
    }, '为什么没做成')).toBe('上一轮没有记录到可核实的失败回执，所以不能凭旧任务状态猜测失败原因。');
  });

  it('reports recorded tools and tasks by persisted facts', () => {
    expect(formatConversationExecutionFactAnswer({
      toolCalls: [{ name: 'read_file', error: false }, { name: 'read_file', error: true }],
      tasks: [{ id: 'task-1', status: 'completed' }],
    }, '这轮对话有执行吗？')).toContain('2 次工具调用：read_file');
  });

  it('answers the field recall plus verified client-navigation question from persisted facts', () => {
    const text = '刚才的验收代号是什么？再告诉我成功执行过哪一个客户端导航动作？不要调用工具。';
    expect(isConversationExecutionFactQuestion(text)).toBe(true);
    expect(formatConversationExecutionFactAnswer({
      recentUserMessages: ['请记住验收代号是晨星716，只回复已记住。'],
      toolCalls: [{
        name: 'client_action',
        error: false,
        arguments: { action: 'open_command_center' },
        result: JSON.stringify({ ok: true, verification: { status: 'verified' } }),
      }],
      tasks: [{ id: 'task-client-action', status: 'completed' }],
    }, text)).toBe('刚才的验收代号是晨星716。成功执行过的客户端导航动作是“打开指挥中心”（client_action:open_command_center），已由真实回执验证。');
  });

  it('recalls a verified prior open instead of denying that it happened', () => {
    const text = '你已经打开了，你自己不知道吗？';
    expect(isConversationExecutionFactQuestion(text)).toBe(true);
    const answer = formatConversationExecutionFactAnswer({
      toolCalls: [{
        name: 'desktop_open',
        error: false,
        turnId: 'turn-open-browser',
        arguments: { target: 'Google Chrome' },
        result: JSON.stringify({
          ok: true,
          status: 'verified',
          targetMatched: true,
          actualTarget: { title: '新标签页 - Google Chrome', processName: 'chrome.exe' },
        }),
        terminalVerification: { status: 'verified' },
        envelope: { status: 'verified_success', verification: { status: 'verified' } },
      }, {
        name: 'desktop_execution_plan_receipt',
        error: true,
        errorDetail: 'Desktop execution ended as target_mismatch.',
        turnId: 'turn-open-browser',
        result: '',
      }],
      tasks: [],
    }, text);

    expect(answer).toContain('是，刚才已经打开了Google Chrome');
    expect(answer).toContain('已验证回执');
    expect(answer).toContain('后续窗口焦点核验没有完成');
    expect(answer).not.toMatch(/target_mismatch|desktop_execution_plan_receipt/iu);
  });
});
