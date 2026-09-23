import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LayaShadowObserver } from '../server/runtime/laya_shadow';
const sample = { text: '做到哪一步了？不要重新执行。', decision: { followup: 'status', skill: 'none', executionRequested: false } };
const active: LayaShadowObserver[] = [];
afterEach(() => { for (const observer of active.splice(0)) observer.stop(); vi.useRealTimers(); });
function setup(enabled = true, options = {}) {
  const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn() });
  const spawn = vi.fn((..._args: any[]) => child);
  const observer = new LayaShadowObserver({ enabled, pythonPath: process.execPath, modelPath: process.cwd() },
    { workerPath: 'test-worker.py', spawnProcess: spawn as any, ...options });
  active.push(observer);
  return { observer, child, spawn, reply: (value: any) => child.stdout.write(JSON.stringify(value)+'\n') };
}
describe('local Laya shadow is not a second execution owner', () => {
  it('does not start a process while disabled', () => {
    const { observer, spawn } = setup(false); observer.observe(sample);
    expect(spawn).not.toHaveBeenCalled(); expect(observer.status().controlsExecution).toBe(false);
  });
  it('records a contradictory decision without changing the canonical sample', () => {
    const { observer, child, reply, spawn } = setup();
    const original = JSON.stringify(sample); expect(observer.observe(sample)).toBeUndefined();
    expect(observer.status().state).toBe('starting'); reply({ ready: true });
    const request = JSON.parse(child.stdin.read().toString());
    expect(request).not.toHaveProperty('decision');
    reply({ id: request.id, followup: { choice: 'execute', confidence: .9 }, skill: { choice: 'none', confidence: .7 } });
    expect(observer.status()).toMatchObject({ state: 'ready', completed: 1, disagreements: 1, controlsExecution: false });
    expect(JSON.stringify(sample)).toBe(original);
    expect(JSON.stringify(observer.status())).not.toContain(sample.text);
    expect(spawn.mock.calls[0][2]).toMatchObject({ windowsHide: true, shell: false, env: { HF_HUB_OFFLINE: '1', TRANSFORMERS_OFFLINE: '1' } });
  });
  it('drops concurrent observations instead of queuing stale decisions', () => {
    const { observer, child, reply } = setup(); observer.observe(sample); reply({ ready: true });
    observer.observe({ ...sample, text: '下一步' });
    expect(observer.status()).toMatchObject({ observed: 2, skipped: 1, state: 'busy' });
    const request = JSON.parse(child.stdin.read().toString());
    expect(request.state.current_user_message).toBe(sample.text);
  });
  it('times out startup, releases the process and applies retry backoff', () => {
    vi.useFakeTimers(); const { observer, child, spawn } = setup(true, { startupMs: 100 });
    observer.observe(sample); vi.advanceTimersByTime(101);
    expect(observer.status()).toMatchObject({ state: 'failed', failure: 'startup_timeout', failures: 1 });
    expect(child.kill).toHaveBeenCalledOnce(); observer.observe(sample); expect(spawn).toHaveBeenCalledOnce();
  });
  it('times out inference without producing a default execute decision', () => {
    vi.useFakeTimers(); const { observer, reply } = setup(true, { inferenceMs: 100 });
    observer.observe(sample); reply({ ready: true }); vi.advanceTimersByTime(101);
    expect(observer.status()).toMatchObject({ state: 'failed', failure: 'inference_timeout', completed: 0, last: null });
  });
  it.each([{ id: 999 }, { id: 1, followup: { choice: 'run_command', confidence: 1 }, skill: { choice: 'none', confidence: .5 } }])(
    'rejects stale or invalid responses', response => {
      const { observer, reply } = setup(); observer.observe(sample); reply({ ready: true }); reply(response);
      expect(observer.status()).toMatchObject({ state: 'failed', completed: 0, last: null });
    });
  it('does not truncate away later user constraints', () => {
    const { observer, spawn } = setup(); observer.observe({ ...sample, text: 'a'.repeat(701) });
    expect(observer.status().skipped).toBe(1); expect(spawn).not.toHaveBeenCalled();
  });
  it('releases an idle worker', () => {
    vi.useFakeTimers(); const { observer, reply, child } = setup(true, { idleMs: 100 });
    observer.observe(sample); reply({ ready: true });
    reply({ id: 1, followup: { choice: 'status', confidence: .9 }, skill: { choice: 'none', confidence: .7 } });
    vi.advanceTimersByTime(101); expect(child.kill).toHaveBeenCalledOnce(); expect(observer.status().state).toBe('off');
  });
});
