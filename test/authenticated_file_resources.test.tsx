// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FileResourceImage, FileResourceVideo } from '../src/components/FileResourceMedia';
import { loadFileResource, localFileResourcePath, saveFileResource } from '../src/services/fileResource';

const externalOpen = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock('../src/lib/externalNavigation', () => ({ openExternalHttpUrl: externalOpen }));

const originalUrl = URL;
const createObjectURL = vi.fn();
const revokeObjectURL = vi.fn();
const fetchMock = vi.fn();
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
}
function successResponse() {
  return { ok: true, status: 200, blob: async () => new Blob(['synthetic image'], { type: 'image/png' }) };
}

beforeEach(() => {
  vi.clearAllMocks();
  let serial = 0;
  createObjectURL.mockImplementation(() => `blob:http://tauri.localhost/resource-${++serial}`);
  vi.stubGlobal('URL', class extends originalUrl {
    static createObjectURL = createObjectURL;
    static revokeObjectURL = revokeObjectURL;
  });
  vi.stubGlobal('fetch', fetchMock);
  (window as any).__LUMI_DESKTOP__ = true;
  localStorage.setItem('lumi_auth_token', 'synthetic-session-token');
  localStorage.setItem('lumi_desktop_session_proof', 'synthetic-desktop-proof');
});
afterEach(() => {
  cleanup();
  localStorage.clear();
  delete (window as any).__LUMI_DESKTOP__;
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('authenticated desktop file resources', () => {
  it('only treats allowed paths on the exact backend origin as local resources', () => {
    expect(localFileResourcePath('/api/files/download/synthetic?inline=1')).toBe('/api/files/download/synthetic?inline=1');
    expect(localFileResourcePath('http://127.0.0.1:3000/lumi_output/image.png')).toBe('/lumi_output/image.png');
    for (const value of [
      'https://example.test/api/files/download/synthetic',
      '//example.test/api/files/download/synthetic',
      '/api/files/../../auth/me',
      'http://user:password@127.0.0.1:3000/api/files/download/synthetic',
      'javascript:void(0)',
    ]) expect(localFileResourcePath(value)).toBeNull();
  });

  it('fetches from the backend with session headers and releases the Blob exactly once', async () => {
    fetchMock.mockResolvedValue(successResponse());
    const resource = await loadFileResource('/api/files/download/synthetic?inline=1');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, request] = fetchMock.mock.calls[0];
    expect(url).toBe('http://127.0.0.1:3000/api/files/download/synthetic?inline=1');
    expect(new Headers(request.headers).get('Authorization')).toBe('Bearer synthetic-session-token');
    expect(new Headers(request.headers).get('x-lumi-desktop-session')).toBe('synthetic-desktop-proof');
    expect(request.credentials).toBe('include');
    expect(request.redirect).toBe('error');
    expect(resource.url).toMatch(/^blob:/);
    resource.release();
    resource.release();
    expect(revokeObjectURL).toHaveBeenCalledTimes(1);
  });

  it('renders authenticated image/video Blob URLs and releases them on unmount', async () => {
    fetchMock.mockResolvedValue(successResponse());
    const view = render(<><FileResourceImage src="/api/files/download/image" alt="Synthetic" /><FileResourceVideo src="/lumi_output/video.mp4" /></>);
    await waitFor(() => expect(view.container.querySelector('img')?.getAttribute('src')).toMatch(/^blob:/));
    expect(view.container.querySelector('video')?.getAttribute('src')).toMatch(/^blob:/);
    view.unmount();
    expect(revokeObjectURL).toHaveBeenCalledTimes(2);
  });

  it('aborts stale preview fetches and never publishes their late responses', async () => {
    const pending = deferred<any>();
    fetchMock.mockImplementationOnce(() => pending.promise).mockResolvedValue(successResponse());
    const view = render(<FileResourceImage src="/api/files/download/old" alt="Synthetic" />);
    const signal = fetchMock.mock.calls[0][1].signal as AbortSignal;
    view.rerender(<FileResourceImage src="/api/files/download/new" alt="Synthetic" />);
    expect(signal.aborted).toBe(true);
    await waitFor(() => expect(view.container.querySelector('img')?.getAttribute('src')).toMatch(/^blob:/));
    const currentSrc = view.container.querySelector('img')?.getAttribute('src');
    await act(async () => { pending.resolve(successResponse()); });
    expect(createObjectURL).toHaveBeenCalledTimes(1);
    expect(view.container.querySelector('img')?.getAttribute('src')).toBe(currentSrc);
  });

  it('does not reuse a revoked Blob when switching back to a prior source or user', async () => {
    fetchMock.mockResolvedValue(successResponse());
    const view = render(<FileResourceImage src="/api/files/download/a" alt="Synthetic" />);
    await waitFor(() => expect(view.container.querySelector('img')?.getAttribute('src')).toContain('resource-1'));
    view.rerender(<FileResourceImage src="/api/files/download/b" alt="Synthetic" />);
    await waitFor(() => expect(view.container.querySelector('img')?.getAttribute('src')).toContain('resource-2'));
    const pending = deferred<any>();
    fetchMock.mockImplementationOnce(() => pending.promise);
    view.rerender(<FileResourceImage src="/api/files/download/a" alt="Synthetic" />);
    expect(view.container.querySelector('img')?.getAttribute('src')).toBeNull();
    await act(async () => { pending.resolve(successResponse()); });
    await waitFor(() => expect(view.container.querySelector('img')?.getAttribute('src')).toContain('resource-3'));
    localStorage.setItem('lumi_auth_token', 'synthetic-new-session');
    view.rerender(<FileResourceImage src="/api/files/download/a" alt="Synthetic" />);
    expect(view.container.querySelector('img')?.getAttribute('src')).toBeNull();
    await waitFor(() => expect(view.container.querySelector('img')?.getAttribute('src')).toContain('resource-4'));
    expect(revokeObjectURL).toHaveBeenCalledTimes(3);
  });

  it('reports authenticated fetch failures to media validation without creating a Blob', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 403 });
    const failed = vi.fn();
    const view = render(<FileResourceImage src="/api/files/download/denied" alt="Synthetic" onResourceError={failed} />);
    await waitFor(() => expect(failed).toHaveBeenCalledTimes(1));
    view.rerender(<FileResourceImage src="/api/files/download/denied" alt="Synthetic" onResourceError={() => failed()} />);
    expect(failed).toHaveBeenCalledTimes(1);
    expect(createObjectURL).not.toHaveBeenCalled();
  });

  it('keeps external images and downloads outside the authenticated backend path', async () => {
    const view = render(<FileResourceImage src="https://example.test/image.png" alt="External" />);
    expect(view.container.querySelector('img')?.src).toBe('https://example.test/image.png');
    await saveFileResource('https://example.test/file.pdf', 'file.pdf');
    expect(externalOpen).toHaveBeenCalledWith('https://example.test/file.pdf');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('downloads from an authenticated Blob and releases it after the browser claims it', async () => {
    vi.useFakeTimers();
    fetchMock.mockResolvedValue(successResponse());
    const clicks: Array<{ url: string; download: string }> = [];
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      clicks.push({ url: this.href, download: this.download });
    });
    await saveFileResource('/api/files/download/synthetic', 'report.pdf');
    expect(clicks).toEqual([{ url: 'blob:http://tauri.localhost/resource-1', download: 'report.pdf' }]);
    expect(document.querySelector('a')).toBeNull();
    expect(revokeObjectURL).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1000);
    expect(revokeObjectURL).toHaveBeenCalledTimes(1);
  });
});
