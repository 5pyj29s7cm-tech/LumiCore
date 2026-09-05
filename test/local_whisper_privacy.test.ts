import './helpers';
import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const processMocks = vi.hoisted(() => ({ exec: vi.fn(), spawn: vi.fn() }));
vi.mock('child_process', () => ({ execFileSync: processMocks.exec, spawn: processMocks.spawn }));

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  vi.stubEnv('LUMI_PRIVACY', 'strict');
  vi.stubEnv('LUMI_LOCAL_WHISPER_PYTHON', 'synthetic-python');
  vi.stubEnv('LUMI_ALLOW_SYSTEM_STT_PYTHON', '0');
  vi.stubEnv('HF_HUB_OFFLINE', '0');
  vi.stubEnv('TRANSFORMERS_OFFLINE', '0');
});
afterEach(() => vi.unstubAllEnvs());

describe('strict local Whisper runtime', () => {
  it('does not bootstrap Python or install a model when the offline probe fails', async () => {
    processMocks.exec.mockImplementation((_cmd, args) => {
      if (args.includes('--check-available')) throw new Error('No local model');
      if (args[0] === '--version') return 'Python 3.11.0';
      throw new Error('Unexpected subprocess');
    });
    const whisper = await import('../server/stt/providers/local-whisper');
    expect(whisper.isLocalWhisperAvailable()).toBe(false);
    await expect(whisper.transcribe(Buffer.from('private audio'))).rejects.toThrow('cached model');
    expect(processMocks.spawn).not.toHaveBeenCalled();
    expect(processMocks.exec.mock.calls.every(([, args]) => args[0] === '--version' || args.includes('--check-available'))).toBe(true);
  });

  it('sends strict offline flags to availability checks and an existing transcription runtime', async () => {
    processMocks.exec.mockImplementation((_cmd, args) => {
      if (args[0] === '--version') return 'Python 3.11.0';
      if (args.includes('--check-available')) return '';
      throw new Error('Unexpected bootstrap or installation');
    });
    processMocks.spawn.mockImplementation(() => {
      const child = Object.assign(new EventEmitter(), {
        stdout: new EventEmitter(), stderr: new EventEmitter(), kill: vi.fn(),
      });
      queueMicrotask(() => { child.stdout.emit('data', 'synthetic local transcript'); child.emit('close', 0); });
      return child;
    });
    const whisper = await import('../server/stt/providers/local-whisper');
    await expect(whisper.transcribe(Buffer.from('private audio'))).resolves.toMatchObject({ text: 'synthetic local transcript' });
    const offlineEnvironment = { LUMI_PRIVACY: 'strict', HF_HUB_OFFLINE: '1', TRANSFORMERS_OFFLINE: '1', HF_HUB_DISABLE_TELEMETRY: '1' };
    expect(processMocks.exec).toHaveBeenCalledWith('synthetic-python', expect.arrayContaining(['--check-available']), expect.objectContaining({ env: expect.objectContaining(offlineEnvironment) }));
    expect(processMocks.spawn).toHaveBeenCalledOnce();
    expect(processMocks.spawn).toHaveBeenCalledWith('synthetic-python', expect.any(Array), expect.objectContaining({ env: expect.objectContaining(offlineEnvironment), windowsHide: true }));
  });
});
