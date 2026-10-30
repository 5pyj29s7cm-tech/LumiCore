import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('node:child_process', async importOriginal => ({
  ...await importOriginal<typeof import('node:child_process')>(), spawn: vi.fn(),
}));
import { spawn } from 'node:child_process';
import { runMediaProcess } from '../server/media/process';
import { createRequestAbortController } from '../server/http/request_abort';
const tempBase = path.resolve(process.env.LUMI_TEST_TMPDIR || os.tmpdir());
const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform')!;
let mediaRoot: string;
beforeEach(() => {
  mediaRoot = fs.mkdtempSync(path.join(tempBase, 'media-request-'));
  vi.stubEnv('LUMI_MEDIA_BIN_DIR', ''); vi.stubEnv('LUMI_RUNTIME_META_FILE', '');
});
afterEach(() => {
  vi.unstubAllEnvs(); vi.clearAllMocks(); Object.defineProperty(process, 'platform', platformDescriptor);
  if (path.dirname(mediaRoot) !== tempBase || !path.basename(mediaRoot).startsWith('media-request-')) throw new Error('Unsafe media fixture root');
  fs.rmSync(mediaRoot, { recursive: true, force: true });
});
describe('HTTP-owned media work', () => {
  it('cancels on response disconnect but not on normal request body completion', () => {
    const req = new EventEmitter(); const res = Object.assign(new EventEmitter(), { writableEnded: false });
    const request = createRequestAbortController(req as any, res as any);
    req.emit('close'); expect(request.signal.aborted).toBe(false);
    res.emit('close'); expect(request.signal.aborted).toBe(true);
    request.dispose(); expect(req.listenerCount('aborted')).toBe(0); expect(res.listenerCount('close')).toBe(0);
  });
  it('does not cancel a response that completed normally and catches an already aborted request', () => {
    const req = Object.assign(new EventEmitter(), { aborted: false });
    const res = Object.assign(new EventEmitter(), { writableEnded: true });
    const request = createRequestAbortController(req as any, res as any);
    res.emit('close'); expect(request.signal.aborted).toBe(false); request.dispose();
    req.aborted = true;
    const late = createRequestAbortController(req as any, res as any);
    expect(late.signal.aborted).toBe(true); late.dispose();
  });
  it.each(['configured', 'packaged', 'unix-path'] as const)('waits for the owned decoder to exit before reporting cancellation and allowing cleanup (%s)', async mode => {
    let executable = 'ffmpeg';
    if (mode === 'unix-path') Object.defineProperty(process, 'platform', { ...platformDescriptor, value: 'linux' });
    else {
      const directory = mode === 'configured' ? mediaRoot : path.join(mediaRoot, 'media', 'bin');
      fs.mkdirSync(directory, { recursive: true });
      executable = path.join(directory, 'ffmpeg' + (process.platform === 'win32' ? '.exe' : ''));
      fs.writeFileSync(executable, 'synthetic decoder; spawn is mocked');
      vi.stubEnv(mode === 'configured' ? 'LUMI_MEDIA_BIN_DIR' : 'LUMI_RUNTIME_META_FILE', mode === 'configured' ? directory : path.join(mediaRoot, 'runtime.json'));
    }
    const child = Object.assign(new EventEmitter(), { pid: undefined, stdout: new EventEmitter(), stderr: new EventEmitter(), kill: vi.fn() });
    vi.mocked(spawn).mockReturnValue(child as any);
    const controller = new AbortController();
    const pending = runMediaProcess('ffmpeg', ['-i', 'synthetic.wav'], controller.signal);
    let settled = false;
    const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' }).then(() => { settled = true; });
    controller.abort(); await Promise.resolve(); expect(settled).toBe(false);
    child.emit('close', 1); await rejected;
    expect(spawn).toHaveBeenCalledExactlyOnceWith(executable, ['-i', 'synthetic.wav'], expect.objectContaining({ shell: false, windowsHide: true }));
  });
  it('rejects a missing explicitly configured decoder instead of silently using PATH', async () => {
    vi.stubEnv('LUMI_MEDIA_BIN_DIR', mediaRoot);
    await expect(runMediaProcess('ffmpeg', ['-i', 'synthetic.wav'])).rejects.toMatchObject({ code: 'media_tool_unavailable' });
    expect(spawn).not.toHaveBeenCalled();
  });
});
