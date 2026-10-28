
import type { ToolRegistry } from '../registry';
import { desktopOpen } from './desktop_tools';

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
      return desktopOpen({target, application:String(args.browser || '').trim()}, context);
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
        strategy: 'state_diff',
        required: true,
        requiredFields: ['target', 'opened', 'navigationVerified', 'pageLoadVerified', 'actualUrl'],
        requiredValues: { opened:true, navigationVerified:true, pageLoadVerified:true },
        successStatuses: ['verified'],
        failureStatuses: ['unverified', 'target_mismatch', 'cancelled'],
        successSignals: ['the actual native browser Document exposes the exact URL, title and displayed content'],
        limitations: ['document_observed verifies a displayed page, not that every network resource loaded, login, or subsequent work.'],
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
