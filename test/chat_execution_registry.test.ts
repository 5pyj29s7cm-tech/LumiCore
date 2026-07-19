import { afterEach, describe, expect, it } from 'vitest';
import {
  beginChatExecution,
  getChatExecution,
  markChatExecutionCancelling,
  recordChatExecutionEvent,
  resetChatExecutionRegistryForTests,
  type ChatExecutionScope,
} from '../server/socket/chat_execution_registry';

const scope: ChatExecutionScope = {
  userId: 'user-1',
  domain: 'personal',
  source: 'chat',
};

afterEach(() => resetChatExecutionRegistryForTests());

describe('chat execution registry', () => {
  it('keeps an active execution queryable independently of a socket instance', () => {
    beginChatExecution(scope, 'request-1');
    recordChatExecutionEvent(scope, 'request-1', 'agent:status', {
      status: 'thinking',
      source: 'chat',
      requestId: 'request-1',
    });

    expect(getChatExecution(scope, 'request-1')).toMatchObject({
      requestId: 'request-1',
      status: 'planning',
      terminal: false,
    });
  });

  it('commits cancellation and rejects late events from a superseded execution', () => {
    beginChatExecution(scope, 'request-1');
    const superseded = beginChatExecution(scope, 'request-2');

    expect(superseded).toMatchObject({
      requestId: 'request-1',
      status: 'cancelled',
      terminal: true,
      terminalEvent: { event: 'agent:response' },
    });
    expect(recordChatExecutionEvent(scope, 'request-1', 'agent:error', { message: 'late failure' })).toBe(false);
    expect(getChatExecution(scope)).toMatchObject({ requestId: 'request-2', status: 'acknowledged' });
  });

  it('exposes cancelling before a terminal cancellation response', () => {
    beginChatExecution(scope, 'request-1');
    expect(markChatExecutionCancelling(scope, 'request-1')).toMatchObject({ status: 'cancelling', terminal: false });

    expect(recordChatExecutionEvent(scope, 'request-1', 'agent:response', {
      text: '[Cancelled]',
      finalized: true,
      blocked: true,
      reason: 'cancelled',
    })).toBe(true);
    expect(getChatExecution(scope, 'request-1')).toMatchObject({ status: 'cancelled', terminal: true });
  });

  it('isolates personal and work executions for the same user', () => {
    const workScope: ChatExecutionScope = { ...scope, domain: 'work', orgId: 'org-1' };
    beginChatExecution(scope, 'personal-request');
    beginChatExecution(workScope, 'work-request');

    expect(getChatExecution(scope)?.requestId).toBe('personal-request');
    expect(getChatExecution(workScope)?.requestId).toBe('work-request');
  });
});
