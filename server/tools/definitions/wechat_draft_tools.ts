import { buildMessageDraft } from "../../regions/messages/external_app_messages";
import { isMessagingSendConfirmationRequired } from '../../autonomy/safety_gate';
import { analyzeWechatIntake } from '../../work_takeover/wechat_intake';
import type { ToolRegistry } from '../registry';
import { requireDesktopRelay } from './external_app_shared';

export function registerWechatDraftTools(registry: ToolRegistry): void {
registry.register({
    name: 'wechat_prepare_reply',
    description: 'Prepare a WeChat or messaging reply draft. This tool never sends messages.',
    parameters: {
      type: 'object',
      properties: {
        contact: { type: 'string', description: 'Recipient name or group name.' },
        context: { type: 'string', description: 'Relevant message context from the user.' },
        intent: { type: 'string', description: 'What the reply should accomplish.' },
        tone: { type: 'string', description: 'Tone, e.g. concise, warm, formal, apologetic.' },
        draft: { type: 'string', description: 'Use this exact draft if already written.' },
      },
      required: [],
    },
    handler: async (args) => JSON.stringify({
      draft: buildMessageDraft(args),
      sendAllowed: false,
      note: 'Lumi prepared a draft only. Sending stays user-confirmed.',
    }, null, 2),
    permission: 'user',
    securityLevel: 'safe',
    capability: {
      id: 'messaging.wechat.reply-draft',
      family: 'messaging',
      lane: 'messaging',
      operation: 'create',
      risk: 'none',
      sideEffects: [],
      verification: {
        strategy: 'terminal_receipt',
        required: true,
        requiredFields: ['draft'],
        successSignals: ['non-empty reply draft'],
        limitations: ['A draft is not a sent message.'],
      },
    },
    evidence: {
      capability: 'messaging.wechat.reply-draft',
      operation: 'create',
      assurance: 'declared',
      limitations: ['Creates text only and never sends.'],
    },
  });

registry.register({
    name: 'wechat_intake_analyze',
    description: 'Analyze a WeChat/message intake for current-stage work takeover: classify customer/store/account/case/video/design work, extract amounts/deadlines/people, propose next actions, and draft a reply. This never sends messages.',
    parameters: {
      type: 'object',
      properties: {
        message: { type: 'string', description: 'The WeChat/message content to analyze.' },
        contact: { type: 'string', description: 'Optional sender/contact/group name.' },
        source: { type: 'string', description: 'Source label such as manual, clipboard, selected_text, or wechat.' },
        takeoverMode: { type: 'string', description: 'Optional forced category: customer, store, account, legal_case, video_publish, design_delivery, general_work, personal, auto.' },
        userRules: { type: 'string', description: 'Optional user work rules or boundaries to apply.' },
      },
      required: ['message'],
    },
    handler: async (args) => JSON.stringify(analyzeWechatIntake({
      message: String(args.message || ''),
      contact: args.contact ? String(args.contact) : undefined,
      source: args.source ? String(args.source) : 'manual',
      takeoverMode: args.takeoverMode ? String(args.takeoverMode) as any : 'auto',
      userRules: args.userRules ? String(args.userRules) : undefined,
    }), null, 2),
    permission: 'user',
    securityLevel: 'safe',
    capability: {
      id: 'messaging.wechat.intake-analyze',
      family: 'messaging',
      lane: 'messaging',
      operation: 'observe',
      risk: 'none',
      sideEffects: [],
      verification: {
        strategy: 'terminal_receipt',
        required: true,
        requiredFields: [],
        successSignals: ['structured intake analysis'],
        limitations: ['Analysis does not modify a task or send a reply.'],
      },
    },
    evidence: {
      capability: 'messaging.wechat.intake-analyze',
      operation: 'observe',
      assurance: 'observed',
      subjectArgument: 'message',
    },
  });

registry.register({
    name: 'wechat_intake_from_clipboard',
    description: 'Read the current clipboard as a WeChat/message intake and analyze it for work takeover. This never sends messages or writes clipboard.',
    parameters: {
      type: 'object',
      properties: {
        contact: { type: 'string', description: 'Optional sender/contact/group name.' },
        takeoverMode: { type: 'string', description: 'Optional forced category: customer, store, account, legal_case, video_publish, design_delivery, general_work, personal, auto.' },
        userRules: { type: 'string', description: 'Optional user work rules or boundaries to apply.' },
      },
      required: [],
    },
    handler: async (args, context) => {
      const desktopRelay = requireDesktopRelay(context);
      const clipboardText = String(await desktopRelay('desktop_clipboard_read', {}) || '').trim();
      if (!clipboardText) {
        throw new Error('Clipboard is empty. Copy the WeChat message text first, or pass message to wechat_intake_analyze.');
      }
      return JSON.stringify(analyzeWechatIntake({
        message: clipboardText,
        contact: args.contact ? String(args.contact) : undefined,
        source: 'clipboard',
        takeoverMode: args.takeoverMode ? String(args.takeoverMode) as any : 'auto',
        userRules: args.userRules ? String(args.userRules) : undefined,
      }), null, 2);
    },
    permission: 'user',
    securityLevel: 'safe',
    capability: {
      id: 'messaging.wechat.clipboard-intake',
      family: 'messaging',
      lane: 'messaging',
      operation: 'observe',
      risk: 'low',
      sideEffects: [{ type: 'local_read', scope: 'current clipboard text', reversible: true }],
      verification: {
        strategy: 'terminal_receipt',
        required: true,
        requiredFields: [],
        successSignals: ['clipboard text was read and analyzed'],
        limitations: ['Clipboard intake does not send or modify a message.'],
      },
    },
    evidence: {
      capability: 'messaging.wechat.clipboard-intake',
      operation: 'observe',
      assurance: 'observed',
    },
  });

registry.register({
    name: 'wechat_copy_reply_draft',
    description: 'Copy a prepared WeChat/messaging reply draft to clipboard and optionally open WeChat. This never presses Send.',
    parameters: {
      type: 'object',
      properties: {
        draft: { type: 'string', description: 'Reply draft to copy.' },
        openWechat: { type: 'boolean', description: 'Open WeChat after copying the draft. This does not send; sending remains confirmation-gated.' },
        applicationTarget: { type: 'string', description: 'Optional app target, default wechat.exe.' },
      },
      required: ['draft'],
    },
    handler: async (args, context) => {
      const draft = String(args.draft || '').trim();
      if (!draft) throw new Error('Draft is required.');
      const desktopRelay = requireDesktopRelay(context);
      const copied = await desktopRelay('desktop_clipboard_write', { text: draft });
      let opened: string | undefined;
      if (args.openWechat) {
        opened = await desktopRelay('desktop_open', { target: args.applicationTarget || 'wechat.exe' });
      }
      return JSON.stringify({
        copied: true,
        clipboardResult: copied,
        opened: Boolean(args.openWechat),
        openResult: opened,
        sendAllowed: !isMessagingSendConfirmationRequired(context?.userId),
        note: 'The draft is ready on the clipboard. Lumi did not send the message.',
      }, null, 2);
    },
    permission: 'user',
    securityLevel: 'safe',
    capability: {
      id: 'messaging.wechat.copy-reply-draft',
      family: 'messaging',
      lane: 'desktop',
      operation: 'mutate',
      risk: 'low',
      sideEffects: [{ type: 'desktop_control', scope: 'clipboard and optional WeChat launch', reversible: true }],
      verification: {
        strategy: 'terminal_receipt',
        required: true,
        requiredFields: ['copied'],
        successSignals: ['native clipboard write receipt'],
        limitations: ['Clipboard preparation and opening WeChat are not message delivery.'],
      },
    },
    evidence: {
      capability: 'messaging.wechat.copy-reply-draft',
      operation: 'mutate',
      assurance: 'observed',
      limitations: ['Never presses Send.'],
    },
  });
}
