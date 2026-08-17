import './helpers';
import { describe, expect, it } from 'vitest';
import {
  formatConversationExecutionFactAnswer,
  isConversationExecutionFactQuestion,
} from '../server/conversation/execution_facts';

describe('conversation execution facts', () => {
  it('recognizes factual questions about tool and task execution', () => {
    expect(isConversationExecutionFactQuestion('这轮对话里你有没有真的执行工具或创建任务？')).toBe(true);
    expect(isConversationExecutionFactQuestion('你能不能调用工具？')).toBe(false);
  });

  it('answers zero execution directly without turning the denial into a claim', () => {
    expect(formatConversationExecutionFactAnswer({ toolCalls: [], tasks: [] }, '这轮对话有执行吗？'))
      .toBe('没有。这段对话没有记录到工具调用，也没有创建任务。');
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
});
