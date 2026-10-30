// @vitest-environment jsdom
import React from 'react';
import { cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const f = vi.hoisted(() => ({ events: new Map<string, Function>(), data: (_s: string) => {}, emit: vi.fn(), write: vi.fn() }));
vi.mock('../src/hooks/useSocket', () => ({ useSocket: () => socket }));
vi.mock('../src/lib/useT', () => ({ useLocale: () => 'en' }));
const socket = { emit: f.emit, on: (name: string, fn: Function) => f.events.set(name, fn), off: (name: string) => f.events.delete(name) };
vi.mock('@xterm/xterm', () => ({ Terminal: class { cols = 80; rows = 24; loadAddon() {} open() {} clear() {} focus() {} dispose() {} writeln = f.write; write = f.write; onData(fn: (s: string) => void) { f.data = fn; return { dispose() {} }; } } }));
vi.mock('@xterm/addon-fit', () => ({ FitAddon: class { fit() {} } }));
vi.mock('@xterm/addon-webgl', () => ({ WebglAddon: class {} }));
import { TerminalWindow } from '../src/components/Terminal';
beforeEach(() => { vi.clearAllMocks(); f.events.clear(); vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} }); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.useRealTimers(); });
it('Enter creates exactly one replacement after exit, waits for ready, then resumes shell input', () => {
  render(<TerminalWindow t={x => x} isActive={false} onClose={() => {}} />); f.events.get('terminal:ready')!(); f.events.get('terminal:exit')!({ code: 0 });
  f.data('\r'); f.data('\r'); expect(f.emit.mock.calls.filter(x => x[0] === 'terminal:create')).toHaveLength(2); expect(f.emit.mock.calls.filter(x => x[0] === 'terminal:input')).toHaveLength(0);
  f.events.get('terminal:ready')!(); f.data('pwd\r'); expect(f.emit).toHaveBeenCalledWith('terminal:input', { data: 'pwd\r' });
});
it('missing readiness becomes visible and permits an explicit Enter retry', () => {
  vi.useFakeTimers();
  render(<TerminalWindow t={x => x} isActive={false} onClose={() => {}} />);
  vi.advanceTimersByTime(15_000); expect(f.write).toHaveBeenCalledWith(expect.stringContaining('did not become ready'));
  f.data('\r'); expect(f.emit.mock.calls.filter(x => x[0] === 'terminal:create')).toHaveLength(2);
});
