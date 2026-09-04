import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ChatTerminalReceiptLedger,
  ChatRequestLedger,
  ChatTurnTimerGuard,
  finalizeStreamedChatMessage,
  normalizePersistedPendingChatExecutions,
  removePersistedPendingChatExecution,
  upsertPersistedPendingChatExecution,
} from '../src/lib/chatEventReceipts';

afterEach(() => {
  vi.useRealTimers();
});

describe('native chat terminal event receipts', () => {
  it('renders one terminal for an ordinary duplicate delivery', () => {
    const ledger = new ChatTerminalReceiptLedger();
    const terminal = {
      requestId: 'request-1',
      source: 'agent_chat:lumi',
      conversationId: 'conversation-1',
    };

    expect(ledger.claim(terminal)).toBe(true);
    expect(ledger.claim({ ...terminal, conversationId: 'conversation-assigned-later' })).toBe(false);
  });

  it('replaces the captured stream bubble instead of appending a second terminal', () => {
    const messages = [
      { id: 'user-1', text: 'hello', type: 'user' },
      { id: 'stream-1', text: 'short prefix', type: 'agent' },
    ];
    const capturedStreamId = 'stream-1';
    // Mirrors React running the updater after streamingMsgId.current was reset.
    const mutableRef = { current: null as string | null };

    const finalized = finalizeStreamedChatMessage(messages, capturedStreamId, 'short prefix and complete answer');

    expect(mutableRef.current).toBeNull();
    expect(finalized).toHaveLength(2);
    expect(finalized[1].text).toBe('short prefix and complete answer');
  });

  it('does not let an old terminal cleanup timer clear a newer turn', () => {
    vi.useFakeTimers();
    const guard = new ChatTurnTimerGuard();
    const cleared: string[] = [];

    guard.begin('request-old');
    guard.schedule('request-old', 5_000, () => cleared.push('old'));
    guard.begin('request-new');
    guard.schedule('request-new', 5_000, () => cleared.push('new'));

    vi.advanceTimersByTime(5_000);
    expect(cleared).toEqual(['new']);
  });

  it('settles a sidecar without losing the foreground request receipt', () => {
    const requests = new ChatRequestLedger();
    expect(requests.begin('foreground-A').controlTargetRequestId).toBe('');
    expect(requests.begin('sidecar-S').controlTargetRequestId).toBe('foreground-A');

    expect(requests.settle('sidecar-S')).toEqual({
      remaining: 1,
      foregroundRequestId: 'foreground-A',
    });
    expect(requests.has('foreground-A')).toBe(true);
    expect(requests.settle('foreground-A').remaining).toBe(0);
  });

  it('keeps FIFO terminal ownership when A finishes while B is queued', () => {
    const requests = new ChatRequestLedger();
    requests.begin('A');
    requests.begin('B');

    expect(requests.settle('A')).toEqual({ remaining: 1, foregroundRequestId: 'B' });
    expect(requests.has('B')).toBe(true);
    expect(requests.settle('B')).toEqual({ remaining: 0, foregroundRequestId: '' });
  });

  it('round-trips a bounded pending FIFO across reload and removes only its terminal', () => {
    const a = { requestId: 'A', source: 'chat', domain: 'personal' as const, startedAt: '2026-08-22T00:00:00.000Z' };
    const b = { requestId: 'B', source: 'chat', domain: 'personal' as const, startedAt: '2026-08-22T00:00:01.000Z' };
    const withA = upsertPersistedPendingChatExecution(null, a);
    const withAB = upsertPersistedPendingChatExecution(withA, b);

    expect(normalizePersistedPendingChatExecutions(JSON.parse(JSON.stringify(withAB))).map(item => item.requestId))
      .toEqual(['A', 'B']);
    expect(removePersistedPendingChatExecution(withAB, 'A').pending.map(item => item.requestId))
      .toEqual(['B']);
  });

  it('round-trips bounded media recovery metadata without persisting the prompt', () => {
    const state = upsertPersistedPendingChatExecution(null, {
      requestId: 'media-1',
      source: 'command-center-chat',
      domain: 'personal',
      startedAt: '2026-09-04T00:00:00.000Z',
      mediaGeneration: {
        mode: 'video',
        operation: 'image_to_video',
        size: '1280x720',
        duration: 6,
        referenceImage: 'D:\\media\\first.png',
      },
    });

    expect(normalizePersistedPendingChatExecutions(JSON.parse(JSON.stringify(state)))[0]?.mediaGeneration).toEqual({
      mode: 'video',
      operation: 'image_to_video',
      size: '1280x720',
      duration: 6,
      referenceImage: 'D:\\media\\first.png',
    });
    expect(JSON.stringify(state)).not.toContain('prompt');
  });
});
