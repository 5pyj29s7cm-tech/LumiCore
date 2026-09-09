import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('node:child_process', () => ({ spawn: vi.fn() }));
import { spawn } from 'node:child_process';
import { runMediaProcess } from '../server/media/process';
import { createRequestAbortController } from '../server/http/request_abort';
afterEach(() => vi.clearAllMocks());
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
  it('waits for the owned decoder to exit before reporting cancellation and allowing cleanup', async () => {
    const child = Object.assign(new EventEmitter(), { pid: undefined, stdout: new EventEmitter(), stderr: new EventEmitter(), kill: vi.fn() });
    vi.mocked(spawn).mockReturnValue(child as any);
    const controller = new AbortController();
    const pending = runMediaProcess('ffmpeg', ['-i', 'synthetic.wav'], controller.signal);
    let settled = false;
    const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' }).then(() => { settled = true; });
    controller.abort(); await Promise.resolve(); expect(settled).toBe(false);
    child.emit('close', 1); await rejected;
    expect(spawn).toHaveBeenCalledWith('ffmpeg', ['-i', 'synthetic.wav'], expect.objectContaining({ shell: false, windowsHide: true }));
  });
});
