/** Evidence read from the actual native browser document, never from a launch echo. */
export interface BrowserPageObservation {
  source: 'windows-uia';
  observedAt: string;
  url: string;
  title: string;
  documentPresent: boolean;
  textSample: string;
  loadingState: 'loading' | 'not_loading' | 'unknown';
  processId: number;
  nativeWindowHandle: number;
  processName: string;
  windowTitle: string;
}

export interface BrowserNavigationResult {
  target: string;
  opened: boolean;
  status: 'verified' | 'launched' | 'target_mismatch' | 'unverified' | 'cancelled';
  navigationVerified: boolean;
  pageLoadVerified: boolean;
  actualUrl?: string;
  pageTitle?: string;
  pageLoadState: 'document_observed' | 'loading' | 'unknown';
  pageObservation?: BrowserPageObservation;
}

export function browserPageUrlMatches(actualUrl: string, requestedUrl: string): boolean {
  try {
    const actual = new URL(actualUrl);
    const requested = new URL(requestedUrl);
    return /^https?:$/.test(actual.protocol) && /^https?:$/.test(requested.protocol)
      && actual.href === requested.href;
  } catch { return false; }
}

export function parseBrowserPagePayload(value: unknown): Record<string, any> | null {
  let parsed = value;
  for (let depth = 0; depth < 3 && typeof parsed === 'string'; depth += 1) {
    try { parsed = JSON.parse(parsed); } catch { return null; }
  }
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
    ? parsed as Record<string, any> : null;
}

export function hasObservedBrowserPage(value: unknown, requestedUrl: string): boolean {
  const payload = parseBrowserPagePayload(value);
  const observation = payload?.pageObservation;
  const window = payload?.actualTarget;
  return !!payload && payload.opened === true && payload.status === 'verified'
    && payload.navigationVerified === true && payload.pageLoadVerified === true
    && payload.pageLoadState === 'document_observed'
    && browserPageUrlMatches(String(payload.target || ''), requestedUrl)
    && browserPageUrlMatches(String(payload.actualUrl || ''), requestedUrl)
    && observation?.source === 'windows-uia'
    && observation.documentPresent === true
    && browserPageUrlMatches(String(observation.url || ''), requestedUrl)
    && !!String(observation.title || '').trim()
    && !!String(observation.textSample || '').trim()
    && ['unknown', 'not_loading'].includes(observation.loadingState)
    && Number.isSafeInteger(observation.processId) && observation.processId > 0
    && Number.isSafeInteger(observation.nativeWindowHandle) && observation.nativeWindowHandle > 0
    && !!String(observation.processName || '').trim()
    && Number.isFinite(Date.parse(String(observation.observedAt || '')))
    && window?.processId === observation.processId
    && window?.nativeWindowHandle === observation.nativeWindowHandle
    && window?.processName === observation.processName;
}
