import { desktopWechatWatchService } from '../../messaging/desktop_wechat_watch';
import type { ToolRegistry } from '../registry';

export function registerDesktopWechatWatchTools(registry: ToolRegistry): void {
  registry.register({
    name: 'wechat_desktop_watch_status',
    description: 'Read the native desktop WeChat duty-mode configuration, runtime health, unread detections, prepared drafts, and confirmation queue for the current Lumi user. This is separate from the Lumi iLink WeChat bot connection.',
    parameters: { type: 'object', properties: {}, required: [] },
    handler: async (_args, context) => JSON.stringify(
      desktopWechatWatchService.status(context?.userId || 'anonymous'),
      null,
      2,
    ),
    permission: 'user',
    securityLevel: 'safe',
  });

  registry.register({
    name: 'wechat_desktop_watch_update',
    description: 'Enable, disable, or configure native desktop WeChat duty mode. Enabling authorizes periodic read-only inspection of the local WeChat window and optional foreground reading only after the user has been idle. Visible chat evidence may be analyzed by the configured vision and reasoning providers. It prepares drafts but never auto-sends; every external reply needs action-time user confirmation.',
    parameters: {
      type: 'object',
      properties: {
        enabled: { type: 'boolean', description: 'Whether native desktop WeChat duty mode is enabled.' },
        pollIntervalSeconds: { type: 'number', description: 'Background unread scan interval, 10-120 seconds.' },
        autoInspectWhenIdle: { type: 'boolean', description: 'When true, restore WeChat and read a reliably identified unread chat only after the idle threshold.' },
        idleBeforeInspectSeconds: { type: 'number', description: 'Required user idle time before foreground inspection, 15-600 seconds.' },
        contactAllowlist: { type: 'array', items: { type: 'string' }, description: 'Optional exact contact/group allowlist. Empty means any reliably identified contact.' },
      },
      required: [],
    },
    handler: async (args, context) => JSON.stringify({
      updated: true,
      config: desktopWechatWatchService.updateConfig(context?.userId || 'anonymous', args),
      status: desktopWechatWatchService.status(context?.userId || 'anonymous'),
    }, null, 2),
    permission: 'user',
    securityLevel: 'confirm',
  });

  registry.register({
    name: 'wechat_desktop_watch_scan',
    description: 'Run one native desktop WeChat duty-mode scan now and return its verified observation/runtime state. This does not send any reply.',
    parameters: { type: 'object', properties: {}, required: [] },
    handler: async (_args, context) => JSON.stringify(
      await desktopWechatWatchService.scanNow(context?.userId || 'anonymous'),
      null,
      2,
    ),
    permission: 'user',
    securityLevel: 'safe',
  });

  registry.register({
    name: 'wechat_desktop_watch_approve_reply',
    description: 'Confirm and send one exact prepared native desktop WeChat reply. The event must contain a verified contact and draft. This is representational communication and always requires action-time confirmation.',
    parameters: {
      type: 'object',
      properties: {
        eventId: { type: 'string', description: 'Desktop WeChat watch event id.' },
        draft: { type: 'string', description: 'Optional user-edited exact reply text. Omit to send the prepared draft.' },
      },
      required: ['eventId'],
    },
    handler: async (args, context) => JSON.stringify(
      await desktopWechatWatchService.approveReply(
        context?.userId || 'anonymous',
        String(args.eventId || ''),
        args.draft === undefined ? undefined : String(args.draft),
      ),
      null,
      2,
    ),
    permission: 'user',
    securityLevel: 'confirm',
  });
}
