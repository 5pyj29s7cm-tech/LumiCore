
import type { ToolRegistry } from '../registry';
import { requireDesktopRelay } from './external_app_shared';

function normalizeUrl(args: Record<string, any>): string {
  const rawUrl = String(args.url || '').trim();
  const query = String(args.query || '').trim();
  if (rawUrl) {
    if (/^https?:\/\//i.test(rawUrl)) return rawUrl;
    return `https://${rawUrl}`;
  }
  if (!query) throw new Error('Provide either url or query.');
  return `https://www.bing.com/search?q=${encodeURIComponent(query)}`;
}

export function registerBrowserTaskTools(registry: ToolRegistry): void {
registry.register({
    name: 'browser_open_task',
    description: 'Prepare or open a browser task. By default returns the target URL without opening it; set open=true only when the user wants the browser opened. If the user explicitly named a browser, pass that browser so the target is not opened in a different default browser.',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'URL to open. If omitted, query is converted to a Bing search URL.' },
        query: { type: 'string', description: 'Search query when no URL is provided.' },
        open: { type: 'boolean', description: 'Open the URL in the desktop browser. High-risk submits, payments, publishing, and account transitions still require confirmation.' },
        browser: { type: 'string', description: 'Optional explicitly requested browser application, such as "Google Chrome", "Microsoft Edge", or "Safari". Leave empty to use the OS default.' },
      },
      required: [],
    },
    handler: async (args, context) => {
      const target = normalizeUrl(args);
      if (!args.open) {
        return JSON.stringify({ target, opened: false, note: 'Set open=true to open the browser when the user wants visible browser work.' }, null, 2);
      }
      const desktopRelay = requireDesktopRelay(context);
      const browser = String(args.browser || '').trim();
      const result = await desktopRelay('desktop_open', { target, ...(browser ? { application: browser } : {}) });
      // The native launch receipt must identify this URL. A same-named app or
      // file is not a browser-open success, and a launch alone proves no login.
      const opened = String(result).includes(target) && !/"(?:ok|success)"\s*:\s*false/.test(String(result));
      return JSON.stringify({ target, opened, ...(opened ? { status: 'launched' } : {}), navigationVerified: false, loginVerified: false,
        ...(opened ? {} : { ok: false, status: 'target_unverified' }),
        ...(browser ? { browser } : {}), result }, null, 2);
    },
    permission: 'user',
    securityLevel: 'safe',
    capability: {
      id: 'web.browser.open-task',
      family: 'browser',
      lane: 'web',
      operation: 'mutate',
      risk: 'low',
      sideEffects: [{ type: 'desktop_control', scope: 'requested browser target', reversible: true }],
      verification: {
        strategy: 'provider_ack',
        required: true,
        requiredFields: ['target', 'opened'],
        successStatuses: ['launched'],
        successSignals: ['native launcher acknowledged the exact URL and browser'],
        limitations: ['This receipt verifies URL launch only. Page navigation, login and subsequent work require fresh page evidence.'],
      },
      intents: ['prepare or visibly open a browser task'],
    },
    evidence: {
      capability: 'web.browser.open-task',
      operation: 'mutate',
      assurance: 'observed',
      subjectArgument: 'url',
      limitations: ['opened=false is preparation only; visible completion requires post-state evidence.'],
    },
  });
}
