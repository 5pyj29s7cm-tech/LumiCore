import { desktopWechatWatchService } from '../../messaging/desktop_wechat_watch';
import type { ToolRegistry } from '../registry';
import { capabilityContract, capabilityEvidence } from '../capability_contracts';

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
    handler: async (args, context) => {
      const userId = context?.userId || 'anonymous';
      const config = desktopWechatWatchService.updateConfig(userId, args);
      const watchStatus = desktopWechatWatchService.status(userId);
      if (watchStatus.config.updatedAt !== config.updatedAt) {
        throw new Error('Desktop WeChat watch configuration was not persisted.');
      }
      return JSON.stringify({
        ok: true,
        status: 'updated',
        persisted: true,
        updated: true,
        config: watchStatus.config,
        watchStatus,
      }, null, 2);
    },
    permission: 'user',
    securityLevel: 'confirm',
    capability: capabilityContract({
      id: 'messaging.wechat.desktop-watch.update',
      family: 'wechat-desktop-watch',
      lane: 'messaging',
      operation: 'mutate',
      risk: 'high',
      sideEffects: [
        { type: 'local_state_change', scope: 'desktop WeChat duty-mode configuration', reversible: true },
        { type: 'desktop_control', scope: 'periodic read-only WeChat foreground inspection when enabled', reversible: true },
        { type: 'network_read', scope: 'configured vision/reasoning provider for visible chat analysis', reversible: true },
      ],
      verification: {
        strategy: 'state_diff',
        required: true,
        requiredFields: ['ok', 'status', 'persisted', 'config.updatedAt', 'watchStatus.config.updatedAt', 'watchStatus.runtime.state'],
        requiredValues: { ok: true, status: 'updated', persisted: true },
        successStatuses: ['updated'],
        failureStatuses: ['failed', 'unverified'],
        successSignals: ['configuration was reread from the dedicated desktop WeChat watch store'],
        limitations: ['Enabling watch mode does not prove WeChat is accessible or that any unread message was read.', 'Drafts are never sent automatically.'],
      },
    }),
    evidence: capabilityEvidence({
      id: 'messaging.wechat.desktop-watch.update',
      operation: 'mutate',
      subjectArgument: 'enabled',
      limitations: ['This receipt covers watch configuration only.'],
    }),
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
    handler: async (args, context) => {
      const userId = context?.userId || 'anonymous';
      const event = await desktopWechatWatchService.approveReply(
        userId,
        String(args.eventId || ''),
        args.draft === undefined ? undefined : String(args.draft),
      );
      const persistedEvent = desktopWechatWatchService.status(userId).events.find(item => item.id === event.id);
      if (!persistedEvent || persistedEvent.updatedAt !== event.updatedAt) {
        throw new Error(`Desktop WeChat watch event was not persisted: ${event.id}`);
      }
      return JSON.stringify({
        ok: persistedEvent.status === 'sent',
        status: persistedEvent.status,
        sent: persistedEvent.status === 'sent',
        persisted: true,
        event: persistedEvent,
      }, null, 2);
    },
    permission: 'user',
    securityLevel: 'confirm',
    capability: capabilityContract({
      id: 'messaging.wechat.desktop-watch.approve-reply',
      family: 'wechat-desktop-watch',
      lane: 'messaging',
      operation: 'communicate',
      risk: 'high',
      sideEffects: [
        { type: 'external_communication', scope: 'one exact prepared desktop WeChat reply', reversible: false },
        { type: 'desktop_control', scope: 'verified desktop WeChat contact and composer', reversible: false },
        { type: 'local_state_change', scope: 'desktop WeChat watch event ledger', reversible: true },
      ],
      verification: {
        strategy: 'visual',
        required: true,
        requiredFields: ['ok', 'status', 'sent', 'persisted', 'event.id', 'event.contact', 'event.status', 'event.updatedAt'],
        requiredValues: { ok: true, status: 'sent', sent: true, persisted: true, 'event.status': 'sent' },
        successStatuses: ['sent'],
        failureStatuses: ['failed', 'blocked', 'unverified'],
        successSignals: ['nested WeChat send tool visibly verifies the exact contact and message', 'sent event was reread from the watch ledger'],
        limitations: ['A failed send remains failed even though the event ledger was updated.'],
      },
    }),
    evidence: capabilityEvidence({
      id: 'messaging.wechat.desktop-watch.approve-reply',
      operation: 'communicate',
      subjectArgument: 'eventId',
      limitations: ['Only status=sent with nested visible send evidence is successful.'],
    }),
  });
}
