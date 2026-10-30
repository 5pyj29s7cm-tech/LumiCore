import { EventEmitter } from 'node:events';
import os from 'node:os';
import { expect, it, vi } from 'vitest';
import { loadSourceModule } from './source_expression';

it.each([false, true])('ends a failed process without ending a replacement created during output: reentry=%s', reentry => {
  const proc = () => Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter(), stdin: { writable: true, write: vi.fn() }, kill: vi.fn() });
  const old = proc(), current = proc(), queue = [old, current];
  const { registerTerminalHandlers } = loadSourceModule<typeof import('../server/socket/terminal')>('server/socket/terminal.ts', { child_process: { spawn: () => queue.shift() }, os: { default: os } });
  const handlers = new Map<string, (...args: any[]) => void>();
  const peer = { id: 'error-receipt', data: { trustedLocalExecution: true }, on: (event: string, callback: (...args: any[]) => void) => handlers.set(event, callback), emit: vi.fn() };
  const receive = (event: string, ...args: any[]) => handlers.get(event)?.(...args);
  registerTerminalHandlers(peer, () => 'synthetic'); receive('terminal:create'); peer.emit.mockClear();
  peer.emit.mockImplementation(event => { if (reentry && event === 'terminal:output') receive('terminal:create'); });
  try {
    old.emit('error', new Error('synthetic failure'));
    expect(peer.emit.mock.calls.map(call => call[0])).toEqual(reentry ? ['terminal:output', 'terminal:ready'] : ['terminal:output', 'terminal:exit']);
    if (reentry) { receive('terminal:input', { data: 'replacement input' }); expect(current.stdin.write).toHaveBeenCalledExactlyOnceWith('replacement input'); }
    else expect(peer.emit).toHaveBeenLastCalledWith('terminal:exit', { code: -1 });
    peer.emit.mockClear(); old.emit('exit', 1); expect(peer.emit).not.toHaveBeenCalled();
  } finally { receive('disconnect'); }
});
