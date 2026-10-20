// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FileLocationActions } from '../src/components/FileLocationActions';
import { getBackendOrigin } from '../src/services/apiBridge';
import { FileResourceImage, FileResourceVideo } from '../src/components/FileResourceMedia';
import { loadFileResource, localFileResourcePath, saveFileResource, fileResourceOpenTarget, openFileResourceFolder } from '../src/services/fileResource';

const nativeFolder = vi.hoisted(() => ({ downloadDir: vi.fn().mockResolvedValue('D:/Redirected Downloads'), invoke: vi.fn().mockResolvedValue({ success: true }) }));
vi.mock('@tauri-apps/api/path', () => ({ downloadDir: nativeFolder.downloadDir }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: nativeFolder.invoke }));
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
  delete (window as any).__TAURI_INTERNALS__;
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('authenticated desktop file resources', () => {
  it('only treats allowed paths on the exact backend origin as local resources', () => {
    expect(localFileResourcePath('/api/files/download/synthetic?inline=1')).toBe('/api/files/download/synthetic?inline=1');
    expect(localFileResourcePath(getBackendOrigin() + '/lumi_output/image.png')).toBe('/lumi_output/image.png');
    for (const value of [
      'https://example.test/api/files/download/synthetic',
      '//example.test/api/files/download/synthetic',
      '/api/files/../../auth/me',
      getBackendOrigin().replace('://', '://user:password@') + '/api/files/download/synthetic',
      (getBackendOrigin() === 'http://localhost:3000' ? 'http://127.0.0.1:3000' : 'http://localhost:3000') + '/api/files/download/synthetic',
      'http://localhost:3001/api/files/download/synthetic',
      'javascript:void(0)',
    ]) expect(localFileResourcePath(value)).toBeNull();
  });

  it('fetches from the backend with session headers and releases the Blob exactly once', async () => {
    fetchMock.mockResolvedValue(successResponse());
    const resource = await loadFileResource('/api/files/download/synthetic?inline=1');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, request] = fetchMock.mock.calls[0];
    expect(url).toBe(getBackendOrigin() + '/api/files/download/synthetic?inline=1');
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


describe('file folder actions', () => {
  it('retains organization and conversation ownership when opening folders', async () => {
    const value = '/api/files/download/archived%20image.png?domain=work&orgId=org-a&inline=1';
    expect(fileResourceOpenTarget(value)).toEqual({ route: '/api/files/open?domain=work&orgId=org-a', body: { id: 'archived image.png', reveal: true } });
    expect(fileResourceOpenTarget('/api/files/generated?path=D%3A%2Foutput%2Fclip.mp4&conversationId=owned-chat&inline=1')).toEqual({ route: '/api/files/open?conversationId=owned-chat', body: { path: 'D:/output/clip.mp4', reveal: true } });
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ success: true, path: 'D:/output' }) });
    await expect(openFileResourceFolder(value)).resolves.toBe('D:/output');
    const [url, request] = fetchMock.mock.calls[0];
    expect(url).toBe(getBackendOrigin() + '/api/files/open?domain=work&orgId=org-a');
    expect(request.method).toBe('POST');
    expect(JSON.parse(request.body)).toEqual({ id: 'archived image.png', reveal: true });
    expect(new Headers(request.headers).get('Authorization')).toBe('Bearer synthetic-session-token');
  });
  it('does not send credentials or folder actions to external or malformed targets', async () => {
    for (const value of ['https://other.test/api/files/generated?path=C:/secret.txt', '/api/files/open-folder', '/api/files/download/%E0%A4', '/api/files/download/a%2Fb.png', 'blob:fake']) {
      expect(fileResourceOpenTarget(value)).toBeNull();
      await expect(openFileResourceFolder(value)).rejects.toThrow();
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it('surfaces missing files and unconfirmed opens instead of showing success', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 404, json: async () => ({ error: 'File not found' }) });
    await expect(openFileResourceFolder('/lumi_output/gone.mp4')).rejects.toThrow('File not found');
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({}) });
    await expect(openFileResourceFolder('/lumi_output/gone.mp4')).rejects.toThrow('not confirmed');
  });
});


it('shows the original path and opens the actual system Downloads directory in desktop mode', async () => {
  (window as any).__TAURI_INTERNALS__ = {};
  render(<FileLocationActions url="/lumi_output/image.png" path="C:/LumiCore/data/generated/image.png" isZh />);
  expect(screen.getByText('C:/LumiCore/data/generated/image.png')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: '打开下载文件夹' }));
  await waitFor(() => expect(nativeFolder.invoke).toHaveBeenCalledWith('open_item', { target: 'D:/Redirected Downloads' }));
  expect(fetchMock).not.toHaveBeenCalled();
});
it('surfaces a failed folder open independently from preview availability', async () => {
  fetchMock.mockResolvedValue({ ok: false, status: 404, json: async () => ({ error: 'File not found' }) });
  render(<FileLocationActions url="/lumi_output/gone.mp4" isZh />);
  expect(screen.queryByRole('button', { name: '打开下载文件夹' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: '打开所在文件夹' }));
  expect((await screen.findByRole('alert')).textContent).toContain('无法打开文件夹');
});
