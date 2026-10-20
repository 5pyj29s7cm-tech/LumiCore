declare global {
  interface Window {
    __LUMI_API_BRIDGE_INSTALLED__?: boolean;
    __LUMI_DESKTOP__?: boolean;
  }
}

export function isTauriRuntime(): boolean {
  if (typeof window === 'undefined') return false;
  const win = window as any;
  return !!(win.__TAURI_INTERNALS__ || win.__TAURI_IPC__ || win.__TAURI__);
}

export function getBackendOrigin(): string {
  if (typeof window === 'undefined') return 'http://127.0.0.1:3000';
  const { protocol, hostname, origin } = window.location;
  // Development variants serve their UI and API on the same loopback port.
  // Honor that origin before the desktop fallback, including during imports
  // that run before installApiBridge(). Packaged custom protocols still use
  // the bundled backend below.
  if (
    (protocol === 'http:' || protocol === 'https:')
    && ['127.0.0.1', 'localhost', '[::1]'].includes(hostname)
  ) return origin;
  // In Tauri production, WebView2 custom protocol can't reach the backend;
  // always route through the bundled Node.js server.
  if (
    window.__LUMI_DESKTOP__
    || isTauriRuntime()
    || protocol === 'tauri:'
    || protocol === 'asset:'
    || hostname === 'tauri.localhost'
    || hostname.endsWith('.tauri.localhost')
  ) {
    return 'http://127.0.0.1:3000';
  }
  return origin;
}

export function getSocketOrigin(): string {
  return getBackendOrigin();
}

export function installApiBridge(): void {
  if (typeof window === 'undefined' || window.__LUMI_API_BRIDGE_INSTALLED__) return;

  const win = window as any;
  win.__LUMI_DESKTOP__ = isTauriRuntime();

  const nativeFetch = window.fetch.bind(window);
  window.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;

    // Never intercept Tauri IPC calls
    if (url.includes('ipc.localhost') || url.includes('tauri://')) {
      return nativeFetch(input, init);
    }

    // In Tauri, API paths need credentials for cross-origin (localhost vs 127.0.0.1)
    // But if same-origin, pass through untouched
    if (url.startsWith('/')) {
      const isDesktop = !!(win.__LUMI_DESKTOP__ || win.__TAURI_INTERNALS__ || win.__TAURI_IPC__ || win.__TAURI__);
      const needsCredentials = isDesktop && (url.startsWith('/api/') || url === '/api' || url.startsWith('/mcp/'));
      if (!needsCredentials) return nativeFetch(input, init);
      const patched: RequestInit = { ...init, credentials: 'include' };

      // WebView2 may not send httpOnly cookies. The desktop bridge supplies the
      // stored account token and its UID-bound native session proof to loopback.
      try {
        const storedToken = localStorage.getItem('lumi_auth_token');
        const desktopSessionProof = localStorage.getItem('lumi_desktop_session_proof');
        const headers = new Headers(patched.headers);
        if (storedToken) headers.set('Authorization', `Bearer ${storedToken}`);
        if (desktopSessionProof) headers.set('x-lumi-desktop-session', desktopSessionProof);
        patched.headers = headers;
      } catch {}

      // In Tauri production, rewrite /api/* requests to the bundled Node.js backend
      return nativeFetch(getBackendOrigin() + url, patched);
    }

    return nativeFetch(input, init);
  };

  window.__LUMI_API_BRIDGE_INSTALLED__ = true;
}
