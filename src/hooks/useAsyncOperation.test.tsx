// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { useAsyncOperation } from './useAsyncOperation';
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
function deferred() { let resolve!: (commit: () => void) => void; const promise = new Promise<() => void>(done => { resolve = done; }); return { promise, resolve }; }

it('serializes duplicate actions and releases failed writes for an explicit retry', async () => {
  const { result } = renderHook(useAsyncOperation), pending = deferred(), commit = vi.fn(), duplicate = vi.fn();
  let first!: Promise<boolean>;
  act(() => { first = result.current.run('save', () => pending.promise); });
  expect(await result.current.run('save', duplicate)).toBe(false); expect(duplicate).not.toHaveBeenCalled();
  await act(async () => { pending.resolve(commit); expect(await first).toBe(true); }); expect(commit).toHaveBeenCalledOnce();
  await act(async () => { expect(await result.current.run('save', async () => { throw new Error('denied'); })).toBe(false); });
  expect(result.current.error).toBe('denied'); expect(result.current.busy).toBe('');
  await act(async () => { expect(await result.current.run('save', async () => commit)).toBe(true); }); expect(result.current.error).toBe('');
});

it.each(['cancel', 'unmount'] as const)('drops late commits after %s, including non-abortable file reads', async mode => {
  const view = renderHook(useAsyncOperation), pending = deferred(), commit = vi.fn(); let signal!: AbortSignal, first!: Promise<boolean>;
  act(() => { first = view.result.current.run('import', s => { signal = s; return pending.promise; }); });
  if (mode === 'unmount') view.unmount(); else act(() => view.result.current.cancel());
  expect(signal.aborted).toBe(true);
  await act(async () => { pending.resolve(commit); expect(await first).toBe(false); }); expect(commit).not.toHaveBeenCalled();
  if (mode === 'cancel') expect(view.result.current.error).toBe('');
});

it('survives StrictMode setup and makes an obsolete failure unable to replace the next result', async () => {
  const { result } = renderHook(useAsyncOperation, { wrapper: ({ children }) => <React.StrictMode>{children}</React.StrictMode> });
  const old = deferred(), commit = vi.fn(); let first!: Promise<boolean>;
  act(() => { first = result.current.run('old', () => old.promise); result.current.cancel(); });
  await act(async () => { expect(await result.current.run('new', async () => commit)).toBe(true); old.resolve(vi.fn()); await first; });
  expect(commit).toHaveBeenCalledOnce(); expect(result.current).toMatchObject({ busy: '', error: '' });
});

it('reports a deadline without automatically replaying a write', async () => {
  const deadline = new AbortController(); vi.spyOn(AbortSignal, 'timeout').mockReturnValue(deadline.signal);
  const { result } = renderHook(useAsyncOperation), operation = vi.fn((signal: AbortSignal) => new Promise<() => void>((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason))));
  let running!: Promise<boolean>; act(() => { running = result.current.run('save', operation); });
  await act(async () => { deadline.abort(new Error('timed out')); expect(await running).toBe(false); });
  expect(operation).toHaveBeenCalledOnce(); expect(result.current).toMatchObject({ busy: '', error: 'timed out' });
});

it('releases a non-abortable file or clipboard wait at its deadline and ignores its late result', async () => {
  const deadline = new AbortController(); vi.spyOn(AbortSignal, 'timeout').mockReturnValueOnce(deadline.signal);
  const { result } = renderHook(useAsyncOperation), pending = deferred(), late = vi.fn(), next = vi.fn(); let first!: Promise<boolean>;
  act(() => { first = result.current.run('import', () => pending.promise); });
  await act(async () => { deadline.abort(new Error('read timed out')); expect(await first).toBe(false); });
  expect(result.current).toMatchObject({ busy: '', error: 'read timed out' });
  await act(async () => { expect(await result.current.run('new', async () => next)).toBe(true); pending.resolve(late); });
  expect(next).toHaveBeenCalledOnce(); expect(late).not.toHaveBeenCalled(); expect(result.current.error).toBe('');
});
