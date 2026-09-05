import './helpers';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import fs from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { spawn } from 'child_process';
import { registerPythonTools } from '../server/tools/definitions/python_tools';
import type { ToolDefinition } from '../server/tools/types';
import type { ToolRegistry } from '../server/tools/registry';

vi.mock('child_process', () => ({ spawn: vi.fn() }));
let child: any;
let tools: Map<string, ToolDefinition>;
let killed: boolean;

beforeEach(() => {
  vi.useFakeTimers();
  killed = false;
  child = Object.assign(new EventEmitter(), {
    pid: 43210, stdout: new PassThrough(), stderr: new PassThrough(),
    kill: vi.fn(() => { killed = true; queueMicrotask(() => child.emit('close', null, 'SIGKILL')); return true; }),
  });
  vi.mocked(spawn).mockImplementation(((command: string) => {
    if (command === 'taskkill') {
      const killer = Object.assign(new EventEmitter(), { kill: vi.fn() });
      killed = true;
      queueMicrotask(() => { child.emit('close', null, 'SIGKILL'); killer.emit('close', 0); });
      return killer;
    }
    return child;
  }) as typeof spawn);
  vi.spyOn(process, 'kill').mockImplementation(() => {
    killed = true;
    queueMicrotask(() => child.emit('close', null, 'SIGKILL'));
    return true;
  });
  tools = new Map();
  registerPythonTools({ register: (tool: ToolDefinition) => tools.set(tool.name, tool) } as unknown as ToolRegistry);
});
afterEach(() => { vi.restoreAllMocks(); vi.clearAllMocks(); vi.useRealTimers(); });

describe('asynchronous Python process lifecycle', () => {
  it('cancels a queued job without running it or releasing the active job', async () => {
    const first = tools.get('python_exec')!.handler({ code: "print('first')" }, {});
    const abort = new AbortController();
    const queued = tools.get('python_exec')!.handler({ code: "print('queued')" }, { executionSignal: abort.signal });
    const cancelled = expect(queued).rejects.toThrow('cancelled before starting');
    abort.abort();
    await cancelled;
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(killed).toBe(false);
    child.stdout.emit('data', Buffer.from('first'));
    child.emit('close', 0);
    expect(JSON.parse(await first).stdout).toBe('first');
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it('leaves the event loop free and resolves only when the child exits', async () => {
    let settled = false;
    const result = tools.get('python_exec')!.handler({ code: "print('ok')" }, {}).then(value => { settled = true; return value; });
    const tick = vi.fn();
    setTimeout(tick, 10);
    await vi.advanceTimersByTimeAsync(10);
    expect(tick).toHaveBeenCalledOnce();
    expect(settled).toBe(false);
    child.stdout.emit('data', Buffer.from('ok\n'));
    child.emit('close', 0);
    expect(JSON.parse(await result)).toMatchObject({ ok: true, stdout: 'ok', exitCode: 0 });
    expect(spawn).toHaveBeenCalledWith('python', expect.any(Array), expect.objectContaining({ windowsHide: true, shell: false }));
    const scriptPath = vi.mocked(spawn).mock.calls[0][1]![0];
    expect(fs.existsSync(scriptPath)).toBe(false);
  });

  it.each(['python_exec', 'python_pip_install'])('cancels %s and awaits process-tree cleanup', async name => {
    const abort = new AbortController();
    const result = tools.get(name)!.handler(name === 'python_exec' ? { code: 'pass' } : { package: 'example_package' }, { executionSignal: abort.signal });
    const failed = expect(result).rejects.toThrow('cancelled');
    abort.abort();
    await vi.runAllTimersAsync();
    await failed;
    expect(killed).toBe(true);
    if (name === 'python_pip_install') {
      expect(vi.mocked(spawn).mock.calls[0][1]).toEqual(['-m', 'pip', 'install', 'example_package']);
    }
  });

  it.each([['python_exec', 5000], ['python_pip_install', 60000]] as const)('enforces the timeout for %s', async (name, timeout) => {
    const result = tools.get(name)!.handler(name === 'python_exec' ? { code: 'pass', timeout } : { package: 'example_package' }, {});
    const failed = expect(result).rejects.toThrow('timed out');
    await vi.advanceTimersByTimeAsync(timeout + 1);
    await failed;
    expect(killed).toBe(true);
    if (name === 'python_exec') expect(fs.existsSync(vi.mocked(spawn).mock.calls[0][1]![0])).toBe(false);
  });

  it('returns the pip success receipt without invoking a shell or installing in tests', async () => {
    const result = tools.get('python_pip_install')!.handler({ package: 'example_package' }, {});
    child.stdout.emit('data', Buffer.from('Requirement already satisfied: example_package'));
    child.emit('close', 0);
    expect(JSON.parse(await result)).toMatchObject({ ok: true, status: 'already_installed', package: 'example_package' });
  });

  it.each([['python_exec', 10 * 1024 * 1024], ['python_pip_install', 1024 * 1024]] as const)('enforces the output limit for %s', async (name, limit) => {
    const result = tools.get(name)!.handler(name === 'python_exec' ? { code: 'pass' } : { package: 'example_package' }, {});
    const failed = expect(result).rejects.toThrow('output exceeded');
    child.stdout.emit('data', Buffer.alloc(limit + 1));
    await vi.runAllTimersAsync();
    await failed;
    expect(killed).toBe(true);
  });

  it('does not start a process when already cancelled and reports a missing interpreter', async () => {
    const abort = new AbortController();
    abort.abort();
    await expect(tools.get('python_exec')!.handler({ code: 'pass' }, { executionSignal: abort.signal })).rejects.toThrow('before starting');
    expect(spawn).not.toHaveBeenCalled();
    const result = tools.get('python_exec')!.handler({ code: 'pass' }, {});
    const failed = expect(result).rejects.toThrow('ENOENT');
    child.emit('error', new Error('spawn python ENOENT'));
    child.emit('close', -2);
    await failed;
  });
});
