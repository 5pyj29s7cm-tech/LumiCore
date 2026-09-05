import { afterEach, describe, expect, it, vi } from 'vitest';
import { apiFetch } from './apiClient';

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('local backend request retry policy', () => {
  it('retries a safe read during backend startup', async () => {
    vi.useFakeTimers();
    const fetch = vi.fn().mockRejectedValueOnce(new TypeError('Failed to fetch')).mockResolvedValueOnce(new Response('ready'));
    vi.stubGlobal('fetch', fetch);
    const pending = apiFetch('/api/health');
    await vi.advanceTimersByTimeAsync(250);
    expect(await (await pending).text()).toBe('ready');
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it.each(['POST', 'PUT', 'PATCH', 'DELETE'])('does not replay a %s whose result is unknown', async method => {
    const error = new TypeError('Failed to fetch');
    const fetch = vi.fn().mockRejectedValue(error);
    vi.stubGlobal('fetch', fetch);
    await expect(apiFetch('/api/command-center/plans', { method, body: '{}' })).rejects.toBe(error);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('does not send an already aborted request', async () => {
    const controller = new AbortController();
    controller.abort();
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    await expect(apiFetch('/api/health', { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('cancels the retry wait immediately without issuing another request', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const fetch = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'));
    vi.stubGlobal('fetch', fetch);
    const pending = apiFetch('/api/health', { signal: controller.signal });
    const result = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    await vi.advanceTimersByTimeAsync(0);
    controller.abort();
    await result;
    await vi.advanceTimersByTimeAsync(20_000);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('returns HTTP errors without replaying them', async () => {
    const response = new Response('temporary failure', { status: 503 });
    const fetch = vi.fn().mockResolvedValue(response);
    vi.stubGlobal('fetch', fetch);
    expect(await apiFetch('/api/health')).toBe(response);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('does not classify a different port as the local backend', async () => {
    const fetch = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'));
    vi.stubGlobal('fetch', fetch);
    await expect(apiFetch('http://127.0.0.1:30000/api/health')).rejects.toThrow('Failed to fetch');
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
