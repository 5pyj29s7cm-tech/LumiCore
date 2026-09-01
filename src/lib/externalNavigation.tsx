import { invoke, isTauri } from '@tauri-apps/api/core';
import type { Components } from 'react-markdown';

type ExternalUrlOpener = (url: string) => void | Promise<void>;

let nativeWindowOpen: typeof window.open | null =
  typeof window === 'undefined' ? null : window.open.bind(window);

function currentExternalHttpProtocol(): 'http:' | 'https:' {
  if (typeof window !== 'undefined') {
    const protocol = window.location?.protocol;
    if (protocol === 'http:' || protocol === 'https:') return protocol;
  }
  // Tauri may use a custom WebView protocol. Protocol-relative network links
  // must still leave the WebView, so use HTTPS rather than inheriting it.
  return 'https:';
}

function normalizeExternalHttpUrl(value: string | null | undefined): string | null {
  const candidate = String(value || '').trim();
  if (!candidate) return null;

  try {
    const parsed = new URL(candidate.startsWith('//')
      ? `${currentExternalHttpProtocol()}${candidate}`
      : candidate);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:'
      ? parsed.href
      : null;
  } catch {
    return null;
  }
}

/**
 * Absolute and protocol-relative HTTP(S) URLs are external. Relative paths,
 * hashes and custom Lumi actions remain owned by the app instead of being sent
 * to a browser.
 */
export function isExternalHttpUrl(value: string | null | undefined): boolean {
  return normalizeExternalHttpUrl(value) !== null;
}

export async function openExternalHttpUrl(value: string): Promise<void> {
  const normalized = normalizeExternalHttpUrl(value);
  if (!normalized) {
    throw new Error('Only absolute HTTP(S) URLs can be opened externally.');
  }

  if (isTauri()) {
    // The Tauri shell plugin applies its URL scope before delegating to the
    // operating system. It never navigates the Lumi WebView.
    await invoke('plugin:shell|open', { path: normalized });
    return;
  }

  const open = nativeWindowOpen || (typeof window === 'undefined' ? null : window.open.bind(window));
  if (!open) throw new Error('No external browser opener is available.');
  open(normalized, '_blank', 'noopener,noreferrer');
}

function reportExternalOpenFailure(error: unknown): void {
  console.error('[LumiCore] Unable to open external URL in the system browser.', error);
}

/**
 * Protect the desktop WebView from all external anchor navigation, including
 * React-Markdown links, GFM bare URLs, and target=_blank anchors.
 */
export function installExternalAnchorGuard(
  documentTarget: Document = document,
  opener: ExternalUrlOpener = openExternalHttpUrl,
): () => void {
  const onClick = (event: MouseEvent) => {
    const element = event.target instanceof Element ? event.target : null;
    const anchor = element?.closest<HTMLAnchorElement>('a[href]');
    const href = anchor?.getAttribute('href');
    const normalized = normalizeExternalHttpUrl(href);
    if (!anchor || !normalized) return;

    event.preventDefault();
    // Stop Tauri's own target=_blank listener from opening the same URL twice.
    event.stopImmediatePropagation();
    Promise.resolve(opener(normalized)).catch(reportExternalOpenFailure);
  };

  documentTarget.addEventListener('click', onClick, true);
  return () => documentTarget.removeEventListener('click', onClick, true);
}

/**
 * Code-triggered external links must follow the same system-browser boundary
 * as clicked anchors. Relative app/file routes retain the native behavior.
 */
export function installExternalWindowOpenGuard(
  windowTarget: Window = window,
  opener: ExternalUrlOpener = openExternalHttpUrl,
): () => void {
  const original = windowTarget.open;
  nativeWindowOpen ||= original.bind(windowTarget);

  windowTarget.open = ((url?: string | URL, target?: string, features?: string) => {
    const value = typeof url === 'string' ? url : url?.href;
    const normalized = normalizeExternalHttpUrl(value);
    if (normalized) {
      Promise.resolve(opener(normalized)).catch(reportExternalOpenFailure);
      return null;
    }
    return original.call(windowTarget, url, target, features);
  }) as typeof window.open;

  return () => {
    windowTarget.open = original;
  };
}

export function installExternalNavigationGuards(): () => void {
  const removeAnchorGuard = installExternalAnchorGuard();
  const removeWindowOpenGuard = installExternalWindowOpenGuard();
  return () => {
    removeWindowOpenGuard();
    removeAnchorGuard();
  };
}

/**
 * External links are marked for a separate browsing context as a fallback;
 * the desktop guard still performs the actual OS-browser handoff.
 */
export const safeMarkdownComponents: Components = {
  a: ({ node: _node, href, rel, target, ...props }) => {
    const external = isExternalHttpUrl(href);
    return (
      <a
        {...props}
        href={href}
        target={external ? '_blank' : target}
        rel={external ? 'noopener noreferrer' : rel}
      />
    );
  },
};
