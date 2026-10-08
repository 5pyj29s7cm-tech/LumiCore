import { apiFetch, apiJson } from './apiClient';
import { getBackendOrigin } from './apiBridge';
import { openExternalHttpUrl } from '@/lib/externalNavigation';

/** Only these backend resources may receive the user's authentication. */
export function localFileResourcePath(value: string): string | null {
  try {
    const backend = new URL(getBackendOrigin());
    const url = new URL(value, backend);
    if (url.origin !== backend.origin || url.username || url.password) return null;
    if (!url.pathname.startsWith('/api/files/') && !url.pathname.startsWith('/lumi_output/')) return null;
    return `${url.pathname}${url.search}`;
  } catch {
    return null;
  }
}

export function isDisplayableResourceUrl(value: string): boolean {
  return /^https?:\/\//i.test(value) || /^blob:/i.test(value) || /^data:(?:image|video|audio)\//i.test(value);
}

export async function loadFileResource(value: string, signal?: AbortSignal) {
  const resourcePath = localFileResourcePath(value);
  if (!resourcePath) throw new Error('Not a local file resource');
  const response = await apiFetch(resourcePath, { signal, redirect: 'error' });
  if (!response.ok) throw new Error(`Unable to load file (${response.status})`);
  const blob = await response.blob();
  // A response body can finish after its view has been disposed.
  signal?.throwIfAborted();
  const url = URL.createObjectURL(blob);
  let released = false;
  return {
    url,
    release() {
      if (released) return;
      released = true;
      URL.revokeObjectURL(url);
    },
  };
}

export async function saveFileResource(value: string, fileName: string): Promise<void> {
  if (!localFileResourcePath(value)) {
    // External sites retain the normal external-browser path; never attach
    // credentials or download arbitrary external content through apiFetch.
    await openExternalHttpUrl(value);
    return;
  }
  const resource = await loadFileResource(value);
  const anchor = document.createElement('a');
  try {
    anchor.href = resource.url;
    anchor.download = fileName || 'download';
    anchor.rel = 'noopener noreferrer';
    document.body.appendChild(anchor);
    anchor.click();
  } finally {
    anchor.remove();
    // Allow the browser to claim the Blob for the download before releasing it.
    window.setTimeout(() => resource.release(), 1000);
  }
}

/** Reuse the authenticated file opener; only the server resolves the parent directory. */
export function fileResourceOpenTarget(value: string): { route: string; body: { id?: string; path?: string; reveal: true } } | null {
  const local = localFileResourcePath(value);
  if (!local) return null;
  try {
    const url = new URL(local, getBackendOrigin());
    let body: { id?: string; path?: string; reveal: true };
    if (url.pathname.startsWith('/api/files/download/')) {
      const id = decodeURIComponent(url.pathname.slice('/api/files/download/'.length));
      if (!id || /[\\/]/.test(id)) return null;
      body = { id, reveal: true };
    } else if (url.pathname === '/api/files/generated' && url.searchParams.get('path')) {
      body = { path: url.searchParams.get('path')!, reveal: true };
    } else if (url.pathname.startsWith('/lumi_output/')) {
      body = { path: decodeURIComponent(url.pathname), reveal: true };
    } else return null;
    const scope = new URLSearchParams();
    for (const key of ['domain', 'orgId', 'conversationId']) {
      const value = url.searchParams.get(key);
      if (value) scope.set(key, value);
    }
    return { route: '/api/files/open' + (scope.size ? '?' + scope : ''), body };
  } catch { return null; }
}

export async function openFileResourceFolder(value: string): Promise<string> {
  const target = fileResourceOpenTarget(value);
  if (!target) throw new Error('Not a local file resource');
  const result = await apiJson<{ success: boolean; path: string }>(target.route, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(target.body),
  });
  if (result?.success !== true || !result.path) throw new Error('Open folder was not confirmed');
  return result.path;
}
