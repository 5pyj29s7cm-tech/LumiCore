import './helpers';
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { transcribe } from '../server/stt/providers/local-whisper';

const processes = vi.hoisted(() => ({ spawn: vi.fn(), execFileSync: vi.fn() }));
vi.mock('child_process', () => processes);

afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks(); });

describe('local Whisper cancellation', () => {
  it('stops the owned transcriber, waits for exit, cleans audio and does not try another runtime', async () => {
    vi.stubEnv('LUMI_LOCAL_WHISPER_MANAGED_VENV', '0');
    vi.stubEnv('LUMI_LOCAL_WHISPER_PYTHON', 'synthetic-python');
    processes.execFileSync.mockImplementation((command: string) => {
      if (command === 'synthetic-python') return 'Python 3.11';
      throw new Error('Synthetic unavailable runtime');
    });
    const child = Object.assign(new EventEmitter(), {
      pid: 12345,
      stdout: new EventEmitter(), stderr: new EventEmitter(), kill: vi.fn(),
    });
    const killer = new EventEmitter();
    processes.spawn.mockImplementation((command: string) => command === 'taskkill' ? killer : child);
    const controller = new AbortController();
    let settled = false;
    const pending = transcribe(Buffer.from('synthetic audio'), 'zh', { signal: controller.signal, fileName: 'synthetic.wav' }).finally(() => { settled = true; });
    const stopped = expect(pending).rejects.toThrow('cancel local audio');
    expect(processes.spawn).toHaveBeenCalledOnce();
    const audioPath = processes.spawn.mock.calls[0][1][1] as string;
    expect(path.extname(audioPath)).toBe('.wav');
    expect(fs.existsSync(audioPath)).toBe(true);
    controller.abort(new Error('cancel local audio'));
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(fs.existsSync(audioPath)).toBe(true);
    if (process.platform === 'win32') {
      expect(processes.spawn.mock.calls[1]).toEqual(['taskkill', ['/PID', '12345', '/T', '/F'], expect.objectContaining({ windowsHide: true, shell: false })]);
      killer.emit('close', 0);
    } else expect(child.kill).toHaveBeenCalledWith('SIGKILL');
    child.emit('close', 1);
    await stopped;
    expect(fs.existsSync(audioPath)).toBe(false);
    expect(processes.spawn.mock.calls.filter(call => call[0] !== 'taskkill')).toHaveLength(1);
  });
});
