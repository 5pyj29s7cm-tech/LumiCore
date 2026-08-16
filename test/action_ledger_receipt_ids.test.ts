import './helpers';
import { describe, expect, it } from 'vitest';
import {
  appendConversationActionReceipts,
  type ConversationActionTaskRow,
} from '../server/conversation/action_ledger';

function task(id: string): ConversationActionTaskRow {
  return {
    id,
    conversationId: 'conversation-1',
    userId: 'user-1',
    domain: 'personal',
    orgId: '',
    parentTaskId: '',
    rootUserMessageId: '',
    intentKind: 'artifact_work',
    operation: 'create',
    goal: 'create an artifact',
    target: '',
    status: 'executing',
    blocker: '',
    activeRequestId: '',
    completionSource: '',
    context: '{}',
    revision: 1,
    createdAt: '2026-08-16T00:00:00.000Z',
    updatedAt: '2026-08-16T00:00:00.000Z',
    completedAt: '',
  };
}

describe('conversation action receipt ids', () => {
  it('allocates a new durable row id when one tool record is associated with another task', () => {
    const db: any = { conversationActionTasks: [], conversationActionReceipts: [] };
    const record = { id: 'tool-call-1', name: 'write_file', arguments: { path: 'result.md' }, result: 'ok' };

    appendConversationActionReceipts(db, { task: task('task-a'), records: [record] });
    appendConversationActionReceipts(db, { task: task('task-b'), records: [record] });

    expect(db.conversationActionReceipts).toHaveLength(2);
    expect(new Set(db.conversationActionReceipts.map((item: any) => item.id)).size).toBe(2);
    expect(db.conversationActionReceipts[0].id).toBe('tool-call-1');
  });
});
