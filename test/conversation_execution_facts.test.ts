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
});
