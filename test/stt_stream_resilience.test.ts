import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createResilientStreamingSession,
  isRecoverableStreamingSTTError,
} from '../server/stt/adapter';
import type { StreamingSTTSession, STTResult } from '../server/stt/types';

class FakeStreamingSession implements StreamingSTTSession {
  readonly sent: Buffer[] = [];
  ended = false;
  private resultCallbacks: Array<(result: STTResult) => void> = [];
  private errorCallbacks: Array<(error: Error) => void> = [];

  sendAudio(chunk: Buffer): void {
    this.sent.push(Buffer.from(chunk));
  }

  end(): void {
    this.ended = true;
  }

  onResult(callback: (result: STTResult) => void): void {
    this.resultCallbacks.push(callback);
  }

  onError(callback: (error: Error) => void): void {
    this.errorCallbacks.push(callback);
  }

  emitResult(result: STTResult): void {
    this.resultCallbacks.forEach(callback => callback(result));
  }

  emitError(error: Error): void {
    this.errorCallbacks.forEach(callback => callback(error));
  }
}

afterEach(() => {
  vi.useRealTimers();
});

describe('realtime STT recovery', () => {
  it('buffers audio during a short disconnect and replays it once', () => {
    vi.useFakeTimers();
    const first = new FakeStreamingSession();
    const second = new FakeStreamingSession();
    const sessions = [first, second];
    const recovering = vi.fn();
    const recovered = vi.fn();
    const results: STTResult[] = [];

    const session = createResilientStreamingSession(
      { provider: 'qwen', language: 'zh', interimResults: true },
      {
        reconnectDelaysMs: [20],
        createSession: () => sessions.shift()!,
        onRecovering: recovering,
        onRecovered: recovered,
      },
    );
    session.onResult(result => results.push(result));

    session.sendAudio(Buffer.from('before'));
    first.emitError(new Error('temporary websocket disconnect'));
    session.sendAudio(Buffer.from('during-1'));
    session.sendAudio(Buffer.from('during-2'));

    expect(first.ended).toBe(true);
    expect(recovering).toHaveBeenCalledWith(expect.objectContaining({ attempt: 1, delayMs: 20 }));
    vi.advanceTimersByTime(20);

    expect(second.sent.map(chunk => chunk.toString())).toEqual(['during-1', 'during-2']);
    second.emitResult({ text: '继续识别', isFinal: false });
    expect(results).toEqual([{ text: '继续识别', isFinal: false }]);
    expect(recovered).toHaveBeenCalledWith({ attempt: 1 });
  });

  it('reports one terminal error after the reconnect budget is exhausted', () => {
    vi.useFakeTimers();
    const first = new FakeStreamingSession();
    const second = new FakeStreamingSession();
    const sessions = [first, second];
    const errors: Error[] = [];
    const session = createResilientStreamingSession(
      { provider: 'ark', language: 'zh-CN', interimResults: true },
      { reconnectDelaysMs: [5], createSession: () => sessions.shift()! },
    );
    session.onError(error => errors.push(error));

    first.emitError(new Error('socket reset'));
    vi.advanceTimersByTime(5);
    second.emitError(new Error('provider remains unavailable'));
    second.emitError(new Error('duplicate close callback'));

    expect(errors.map(error => error.message)).toEqual(['provider remains unavailable']);
  });

  it('does not retry invalid credentials or configuration', () => {
    const errors: Error[] = [];
    const factory = vi.fn(() => {
      throw new Error('DASHSCOPE_API_KEY is not configured');
    });
    const session = createResilientStreamingSession(
      { provider: 'qwen', language: 'zh' },
      { reconnectDelaysMs: [0, 0], createSession: factory },
    );
    session.onError(error => errors.push(error));

    expect(factory).toHaveBeenCalledTimes(1);
    expect(errors.map(error => error.message)).toEqual(['DASHSCOPE_API_KEY is not configured']);
    expect(isRecoverableStreamingSTTError(new Error('temporary disconnect'))).toBe(true);
    expect(isRecoverableStreamingSTTError(new Error('quota exhausted'))).toBe(false);
  });

  it('bounds recovery audio without discarding the start of the utterance', () => {
    vi.useFakeTimers();
    const first = new FakeStreamingSession();
    const second = new FakeStreamingSession();
    const sessions = [first, second];
    const session = createResilientStreamingSession(
      { provider: 'qwen', language: 'zh' },
      { reconnectDelaysMs: [10], maxPendingChunks: 2, createSession: () => sessions.shift()! },
    );

    first.emitError(new Error('socket reset'));
    session.sendAudio(Buffer.from('opening-1'));
    session.sendAudio(Buffer.from('opening-2'));
    session.sendAudio(Buffer.from('overflow'));
    vi.advanceTimersByTime(10);

    expect(second.sent.map(chunk => chunk.toString())).toEqual(['opening-1', 'opening-2']);
  });
});
