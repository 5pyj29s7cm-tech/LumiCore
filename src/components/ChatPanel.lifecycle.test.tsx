// @vitest-environment jsdom
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ChatPanel } from './ChatPanel';

vi.mock('framer-motion', () => ({
  AnimatePresence: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  motion: new Proxy({}, {
    get: (_target, tag: string) => tag,
  }),
}));

type Handler = (...args: any[]) => void;

class FakeSocket {
  connected = true;
  emitted: Array<{ event: string; args: any[] }> = [];
  private handlers = new Map<string, Set<Handler>>();

  on(event: string, handler: Handler) {
    const set = this.handlers.get(event) || new Set<Handler>();
    set.add(handler);
    this.handlers.set(event, set);
  }

  off(event: string, handler: Handler) {
    this.handlers.get(event)?.delete(handler);
  }

  emit(event: string, ...args: any[]) {
    this.emitted.push({ event, args });
    const ack = args.at(-1);
    if (event === 'agent:task' && typeof ack === 'function') {
      ack({ ok: true, requestId: args[0]?.requestId });
    }
  }

  push(event: string, payload: any) {
    for (const handler of this.handlers.get(event) || []) handler(payload);
  }

  listenerCount(event: string) {
    return this.handlers.get(event)?.size || 0;
  }
}

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('ChatPanel task lifecycle', () => {
  it('accepts only the active task response and detaches socket listeners on unmount', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      json: async () => ({ skills: [] }),
    }));
    const socket = new FakeSocket();
    const { unmount } = render(<ChatPanel socket={socket} t={{ langCode: 'en' }} />);

    socket.push('chat:conversations', { conversations: [] });
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'open the notes app' } });
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter', code: 'Enter' });

    const taskEmission = socket.emitted.find(entry => entry.event === 'agent:task');
    const requestId = taskEmission?.args[0]?.requestId;
    expect(requestId).toMatch(/^task_/);
    expect(localStorage.getItem('lumi_active_task_execution')).toContain(requestId);

    socket.push('agent:response', {
      text: 'stale response',
      source: 'task',
      requestId: 'task_stale',
      finalized: true,
    });
    expect(screen.queryByText('stale response')).toBeNull();

    socket.push('agent:response', {
      text: 'current response',
      source: 'task',
      requestId,
      finalized: true,
      blocked: false,
    });
    expect(await screen.findByText('current response')).toBeTruthy();
    await waitFor(() => {
      expect(localStorage.getItem('lumi_active_task_execution')).toBeNull();
    });

    expect(socket.listenerCount('agent:response')).toBe(1);
    unmount();
    expect(socket.listenerCount('agent:response')).toBe(0);
    expect(socket.listenerCount('agent:tool_call')).toBe(0);
    expect(socket.listenerCount('connect')).toBe(0);
  });
});
