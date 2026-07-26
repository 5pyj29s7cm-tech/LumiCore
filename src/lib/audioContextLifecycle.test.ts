import { describe, expect, it, vi } from 'vitest';
import { closeAudioContext, type ClosableAudioContext } from './audioContextLifecycle';

function context(state: AudioContextState, close: () => Promise<void>): ClosableAudioContext {
  return { state, close };
}

describe('audio context lifecycle', () => {
  it('does nothing for absent or already closed contexts', async () => {
    const close = vi.fn(async () => {});
    await closeAudioContext(null);
    await closeAudioContext(context('closed', close));
    expect(close).not.toHaveBeenCalled();
  });

  it('closes one context at most once across racing cleanup paths', async () => {
    let release: (() => void) | undefined;
    const close = vi.fn(() => new Promise<void>(resolve => { release = resolve; }));
    const target = context('running', close);
    const first = closeAudioContext(target);
    const second = closeAudioContext(target);
    await Promise.resolve();
    expect(close).toHaveBeenCalledTimes(1);
    release?.();
    await expect(Promise.all([first, second])).resolves.toEqual([undefined, undefined]);
    await closeAudioContext(target);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('absorbs asynchronous InvalidState-style cleanup failures', async () => {
    const target = context('running', vi.fn(async () => {
      throw new DOMException('Cannot close a closed AudioContext.', 'InvalidStateError');
    }));
    await expect(closeAudioContext(target)).resolves.toBeUndefined();
  });
});
