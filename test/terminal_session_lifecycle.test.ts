import { EventEmitter } from 'node:events';
import os from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadSourceModule } from './source_expression';

// Inject only this module's process boundary; global child_process remains intact
// for unrelated test teardown. No real terminal or host process is launched.
function fixture() {
  const processes: any[] = [];
  const spawn = vi.fn(() => {
    const proc = processes.shift();
    if (!proc) throw new Error('No synthetic process was queued');
    return proc;
  });
  const { registerTerminalHandlers } = loadSourceModule<typeof import('../server/socket/terminal')>(
    'server/socket/terminal.ts', { child_process: { spawn }, os: { default: os } });
  const sockets: any[] = [];
  const socket = (id: string, trusted = true) => {
    const handlers = new Map<string, (...args: any[]) => void>();
    const peer = { id, data: { trustedLocalExecution: trusted },
      on: vi.fn((event: string, handler: (...args: any[]) => void) => handlers.set(event, handler)),
      emit: vi.fn(), receive: (event: string, ...args: any[]) => handlers.get(event)?.(...args) };
    registerTerminalHandlers(peer, () => 'synthetic-user'); sockets.push(peer); return peer;
  };
  return { processes, spawn, socket, cleanup: () => sockets.forEach(peer => peer.receive('disconnect')) };
}
function processFixture() {
  return Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter(),
    stdin: { writable: true, write: vi.fn() }, kill: vi.fn() });
}
const cleanups: Array<() => void> = [];
function harness() { const h = fixture(); cleanups.push(h.cleanup); return h; }
afterEach(() => { cleanups.splice(0).forEach(cleanup => cleanup()); vi.restoreAllMocks(); });

describe('terminal process session ownership', () => {
  it('does not register or spawn a terminal for an untrusted socket', () => {
    const h = harness(), peer = h.socket('untrusted', false);
    peer.receive('terminal:create'); expect(peer.on).not.toHaveBeenCalled(); expect(h.spawn).not.toHaveBeenCalled();
  });

  it.each(['exit', 'error'] as const)('ignores old %s and output after replacement while the new shell remains writable and destroyable', event => {
    const h = harness(), old = processFixture(), current = processFixture(), peer = h.socket('replacement');
    h.processes.push(old, current); peer.receive('terminal:create'); peer.receive('terminal:create');
    expect(old.kill).toHaveBeenCalledOnce(); peer.emit.mockClear();
    old.stdout.emit('data', Buffer.from('obsolete stdout')); old.stderr.emit('data', Buffer.from('obsolete stderr'));
    if (event === 'exit') old.emit('exit', 0); else old.emit('error', new Error('obsolete error'));
    expect(peer.emit).not.toHaveBeenCalled();
    peer.receive('terminal:input', { data: 'new-input' }); expect(current.stdin.write).toHaveBeenCalledExactlyOnceWith('new-input');
    current.stdout.emit('data', Buffer.from('current stdout')); current.stderr.emit('data', Buffer.from('current stderr'));
    expect(peer.emit.mock.calls).toEqual([['terminal:output', { data: 'current stdout' }], ['terminal:output', { data: 'current stderr' }]]);
    peer.receive('terminal:destroy'); expect(current.kill).toHaveBeenCalledOnce();
    peer.receive('terminal:input', { data: 'after-destroy' }); expect(current.stdin.write).toHaveBeenCalledOnce();
  });

  it('retires ownership before a synchronous kill callback runs', () => {
    const h = harness(), old = processFixture(), current = processFixture(), peer = h.socket('synchronous-kill');
    old.kill.mockImplementation(() => { old.stdout.emit('data', Buffer.from('retired')); old.emit('error', new Error('retired')); old.emit('exit', 0); });
    h.processes.push(old, current); peer.receive('terminal:create'); peer.emit.mockClear(); peer.receive('terminal:create');
    expect(peer.emit.mock.calls).toEqual([['terminal:ready', { sessionId: peer.id }]]);
    peer.receive('terminal:input', { data: 'current' }); expect(current.stdin.write).toHaveBeenCalledExactlyOnceWith('current');
  });

  it.each(['terminal:destroy', 'disconnect'])('%s retires the current process before kill and ignores all late events', event => {
    const h = harness(), proc = processFixture(), peer = h.socket(event); h.processes.push(proc); peer.receive('terminal:create');
    proc.kill.mockImplementation(() => { proc.emit('exit', 0); }); peer.emit.mockClear(); peer.receive(event);
    proc.stdout.emit('data', Buffer.from('late')); proc.stderr.emit('data', Buffer.from('late')); proc.emit('error', new Error('late'));
    peer.receive('terminal:input', { data: 'late' }); peer.receive(event);
    expect(peer.emit).not.toHaveBeenCalled(); expect(proc.stdin.write).not.toHaveBeenCalled(); expect(proc.kill).toHaveBeenCalledOnce();
  });

  it.each(['exit', 'error'] as const)('publishes current %s once and releases ownership before the callback creates a new session', event => {
    const h = harness(), old = processFixture(), current = processFixture(), peer = h.socket('reentrant-' + event);
    h.processes.push(old, current); peer.receive('terminal:create'); peer.emit.mockClear();
    peer.emit.mockImplementation((name: string) => { if (name === (event === 'exit' ? 'terminal:exit' : 'terminal:output')) peer.receive('terminal:create'); });
    if (event === 'exit') old.emit('exit', null); else old.emit('error', new Error('current error'));
    peer.receive('terminal:input', { data: 'replacement' }); expect(current.stdin.write).toHaveBeenCalledExactlyOnceWith('replacement');
    expect(peer.emit.mock.calls[0]).toEqual(event === 'exit' ? ['terminal:exit', { code: -1 }] : ['terminal:output', { data: '\r\n\x1b[31mTerminal error: current error\x1b[0m\r\n' }]);
    peer.emit.mockClear(); old.emit('exit', 0); old.emit('error', new Error('late')); expect(peer.emit).not.toHaveBeenCalled();
  });

  it('keeps different socket sessions independent and still cleans up after kill throws', () => {
    const h = harness(), a = processFixture(), b = processFixture(), replacement = processFixture();
    const first = h.socket('first'), second = h.socket('second'); h.processes.push(a, b, replacement);
    first.receive('terminal:create'); second.receive('terminal:create'); a.kill.mockImplementation(() => { throw new Error('synthetic kill failure'); });
    first.receive('terminal:create'); a.emit('exit', 0);
    first.receive('terminal:input', { data: 'first-new' }); second.receive('terminal:input', { data: 'second-current' });
    expect(replacement.stdin.write).toHaveBeenCalledExactlyOnceWith('first-new'); expect(b.stdin.write).toHaveBeenCalledExactlyOnceWith('second-current');
  });
});
