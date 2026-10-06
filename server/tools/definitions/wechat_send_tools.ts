import { EXTERNAL_APP_MESSAGES } from '../../regions/packs/cn/external_app_messages';
import { providerGetterArguments } from "../../llm/provider_getters";
import fs from 'fs';
import path from 'path';
import { analyzeScreen } from '../../llm/adapter';
import { getMember, logAudit } from '../../org/db';
import { sendLocalFileToPersonalWeChat, WeChatFileApiUnavailableError } from '../../messaging/file_transfer';
import type { ToolRegistry } from '../registry';
import { captureDesktopUiEvidence, hasVisionProvider, isWeChatActiveWindow, normalizeEvidenceText, parseDesktopJson, prepareWeChatConversation, requireDesktopRelay, sleep } from './external_app_shared';

function snapshotContainsNewMessage(before: string, after: string, message: string): boolean {
  const target = normalizeEvidenceText(message);
  if (target.length < 1) return false;
  const beforeText = normalizeEvidenceText(before);
  const afterText = normalizeEvidenceText(after);
  return !beforeText.includes(target) && afterText.includes(target);
}

export function parseWeChatSendVisionVerification(value: unknown): {
  sent: boolean;
  confidence: number;
  reason: string;
} {
  const raw = String(value || '').trim();
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return { sent: false, confidence: 0, reason: raw.slice(0, 240) || 'No verification result.' };
  try {
    const parsed = JSON.parse(match[0]);
    const confidence = Math.max(0, Math.min(1, Number(parsed.confidence || 0)));
    return {
      sent: parsed.sent === true && confidence >= 0.65,
      confidence,
      reason: String(parsed.reason || '').trim().slice(0, 400),
    };
  } catch {
    return { sent: false, confidence: 0, reason: raw.slice(0, 240) || 'Invalid verification result.' };
  }
}

function firstFiniteNumber(...values: any[]): number | null {
  for (const value of values) {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function virtualInputPoint(activeWindow: Record<string, any>): { x: number; y: number } {
  const bounds = activeWindow.bounds || activeWindow.rect || activeWindow.windowBounds || {};
  const x = firstFiniteNumber(activeWindow.x, activeWindow.left, bounds.x, bounds.left, 0) ?? 0;
  const y = firstFiniteNumber(activeWindow.y, activeWindow.top, bounds.y, bounds.top, 0) ?? 0;
  const right = firstFiniteNumber(activeWindow.right, bounds.right);
  const bottom = firstFiniteNumber(activeWindow.bottom, bounds.bottom);
  const width = Math.max(320, firstFiniteNumber(activeWindow.width, bounds.width, right !== null ? right - x : null, 0) ?? 0);
  const height = Math.max(320, firstFiniteNumber(activeWindow.height, bounds.height, bottom !== null ? bottom - y : null, 0) ?? 0);
  if (x < -10000 || y < -10000) {
    throw new Error('WeChat window is still minimized or offscreen after opening; cannot safely click the input area.');
  }
  return {
    x: Math.round(x + width * 0.58),
    y: Math.round(y + height - Math.min(96, Math.max(72, height * 0.14))),
  };
}

export function registerWechatSendTools(registry: ToolRegistry): void {
registry.register({
    name: 'wechat_send_message',
    description: 'Send an ordinary user-requested foreground WeChat message through the real desktop client. It reuses an already-running WeChat window when possible, optionally selects a contact through WeChat search, focuses the input area with the virtual cursor click path, pastes the message, presses the configured send shortcut, and verifies the foreground WeChat window. Every send requires exact one-time destination/payload confirmation before invocation. Use only for low-risk social/content messages requested by the present user; QR/login/account switching, payments, legal/contractual commits, and ambiguous high-consequence sends still require handoff or confirmation.',
    parameters: {
      type: 'object',
      properties: {
        contact: { type: 'string', description: 'Recipient or group name to select in WeChat. Omit to use the current chat.' },
        message: { type: 'string', description: 'Exact message text to send.' },
        draft: { type: 'string', description: 'Alias for message when a previous draft is available.' },
        applicationTarget: { type: 'string', description: 'Desktop app target. Defaults to wechat.' },
        useSearch: { type: 'boolean', description: 'Use WeChat search to select contact before sending. Defaults true when contact is provided.' },
        sendShortcut: { type: 'string', description: 'Key shortcut to send, usually enter or ctrl+enter. Defaults enter.' },
        useVirtualCursor: { type: 'boolean', description: 'Click the message input area through the independent virtual cursor path. Defaults true.' },
      },
      required: [],
    },
    handler: async (args, context) => {
      const message = String(args.message || args.draft || '').trim();
      if (!message) throw new Error('Message text is required.');

      const desktopRelay = requireDesktopRelay(context);
      const progress = (step: string) => context?.onProgress?.(step);
      const sendShortcut = String(args.sendShortcut || 'enter').trim() || 'enter';
      const useVirtualCursor = args.useVirtualCursor !== false;
      const { contact, useSearch, openResult, activeWindow } = await prepareWeChatConversation(args, context, desktopRelay);

      const point = virtualInputPoint(activeWindow);
      if (useVirtualCursor) {
        progress(EXTERNAL_APP_MESSAGES.focusingInput);
        await desktopRelay('desktop_cursor_glow_show', { source: 'wechat_send_message', timeoutMs: 12000 }).catch(() => '');
        await desktopRelay('desktop_cursor_glow_update', { x: point.x, y: point.y }).catch(() => '');
        await desktopRelay('desktop_mouse_click_at', { x: point.x, y: point.y, button: 'left' });
        await desktopRelay('desktop_cursor_glow_click', { x: point.x, y: point.y }).catch(() => '');
        await sleep(180);
      }

      let beforeUiSnapshot = '';
      try {
        beforeUiSnapshot = await captureDesktopUiEvidence(desktopRelay, 220);
      } catch {}

      progress(EXTERNAL_APP_MESSAGES.sendingMessage);
      await desktopRelay('desktop_clipboard_write', { text: message });
      await desktopRelay('desktop_keyboard_press', { key: 'ctrl+v' });
      await sleep(220);
      await desktopRelay('desktop_keyboard_press', { key: sendShortcut });
      await sleep(450);
      await desktopRelay('desktop_cursor_glow_hide', { source: 'wechat_send_message' }).catch(() => '');

      const finalActiveWindow = parseDesktopJson(await desktopRelay('desktop_active_window', {}));
      if (!isWeChatActiveWindow(finalActiveWindow)) {
        throw new Error(`Message send shortcut was pressed, but WeChat is no longer foreground. Active window: ${JSON.stringify(finalActiveWindow).slice(0, 300)}`);
      }

      progress(EXTERNAL_APP_MESSAGES.checkingMessage);
      let afterUiSnapshot = '';
      try {
        afterUiSnapshot = await captureDesktopUiEvidence(desktopRelay, 240);
      } catch {}
      const uiVerified = snapshotContainsNewMessage(beforeUiSnapshot, afterUiSnapshot, message);

      let visionVerification = { sent: false, confidence: 0, reason: '' };
      const visionConfig = hasVisionProvider(context);
      if (!uiVerified && visionConfig) {
        try {
          const screenCapture = await desktopRelay('desktop_capture_screen', { quality: 70 });
          const getters = context?.llmGetters;
          const verificationText = await analyzeScreen(
            screenCapture,
            [
              'Verify a foreground WeChat send using only visible evidence.',
              `Expected recipient/group: ${JSON.stringify(contact || '(current conversation)')}.`,
              `Expected exact message: ${JSON.stringify(message)}.`,
              'Set sent=true only if the exact message is visibly present as the newest outgoing chat bubble in the intended conversation and is no longer merely sitting in the input box.',
              'Return only JSON: {"sent":boolean,"confidence":number,"reason":"short visible evidence"}.',
            ].join('\n'),
            visionConfig,
            ...providerGetterArguments(getters),
          );
          visionVerification = parseWeChatSendVisionVerification(verificationText);
        } catch (err: any) {
          visionVerification.reason = err?.message || String(err);
        }
      }
      const sent = uiVerified || visionVerification.sent;

      return JSON.stringify({
        sent,
        sendAttempted: true,
        verificationStatus: sent ? 'verified' : 'uncertain',
        verificationMethod: uiVerified ? 'uia_new_message' : visionVerification.sent ? 'screen_vision' : 'none',
        verificationConfidence: uiVerified ? 0.8 : visionVerification.confidence,
        verificationReason: uiVerified
          ? 'The exact message appeared as new accessible UI text after the send action.'
          : visionVerification.reason || 'No outgoing message-bubble evidence was available.',
        contact: contact || null,
        usedContactSearch: useSearch,
        sendShortcut,
        method: useVirtualCursor ? 'virtual_cursor_clipboard_paste_send' : 'clipboard_paste_send',
        inputPoint: point,
        openResult,
        activeWindow: finalActiveWindow,
        messagePreview: message.slice(0, 80),
        note: sent
          ? 'The foreground send action completed and the result was verified from visible WeChat evidence.'
          : 'The send shortcut was pressed, but completion was not verified. Do not report the message as sent.',
      }, null, 2);
    },
    reconcileExternalCommit: async (args, context, idempotencyKey) => {
      const message = String(args.message || args.draft || '').trim();
      const contact = String(args.contact || '').trim();
      const visionConfig = hasVisionProvider(context);
      if (!message || !visionConfig) return null;
      const desktopRelay = requireDesktopRelay(context);
      const activeWindow = parseDesktopJson(await desktopRelay('desktop_active_window', {}));
      if (!isWeChatActiveWindow(activeWindow)) return null;
      const getters = context?.llmGetters;
      const screenCapture = await desktopRelay('desktop_capture_screen', { quality: 70 });
      const verificationText = await analyzeScreen(
        screenCapture,
        [
          'Read-only reconciliation after a timed-out WeChat send. Do not perform any UI action.',
          `Idempotency key: ${JSON.stringify(idempotencyKey)}.`,
          `Expected exact recipient/group: ${JSON.stringify(contact || '(current conversation)')}.`,
          `Expected exact message: ${JSON.stringify(message)}.`,
          'Set sent=true only if the exact message is visibly the newest outgoing bubble in the intended conversation and is not in the composer.',
          'Return only JSON: {"sent":boolean,"confidence":number,"reason":"short visible evidence"}.',
        ].join('\n'),
        visionConfig,
        ...providerGetterArguments(getters),
      );
      const verification = parseWeChatSendVisionVerification(verificationText);
      if (!verification.sent) return null;
      return JSON.stringify({
        sent: true,
        sendAttempted: true,
        verificationStatus: 'verified',
        verificationMethod: 'timeout_reconciliation_vision',
        verificationConfidence: verification.confidence,
        verificationReason: verification.reason,
        contact: contact || null,
        messagePreview: message.slice(0, 80),
        idempotencyKey,
      });
    },
    permission: 'user',
    securityLevel: 'safe',
    capability: {
      id: 'messaging.wechat.send-message',
      family: 'messaging',
      lane: 'messaging',
      operation: 'communicate',
      risk: 'medium',
      sideEffects: [{ type: 'external_communication', scope: 'explicit WeChat recipient and message', reversible: false }],
      verification: {
        strategy: 'provider_ack',
        required: true,
        requiredFields: ['sent', 'verificationStatus'],
        successSignals: ['sent=true with exact outgoing-message evidence'],
        limitations: ['A pressed shortcut or prepared clipboard is not delivery acknowledgement.'],
      },
    },
    evidence: {
      capability: 'messaging.wechat.send-message',
      operation: 'communicate',
      assurance: 'verified',
      subjectArgument: 'contact',
      limitations: ['Exact recipient and message evidence is required.'],
    },
  });

registry.register({
    name: 'wechat_send_file',
    description: 'Send one real local file to WeChat after an explicit user request. When contact is omitted, first use the current Lumi user\'s bound personal WeChat bot conversation and provider acknowledgement, including an organization audit for work-to-personal transfer. If that conversation lacks usable context, fall back to the member\'s personal desktop WeChat relay. Provide contact only when the user explicitly names another contact/group; desktop mode then copies a real file list to the OS clipboard, sends it, and never reports success without filename evidence.',
    parameters: {
      type: 'object',
      properties: {
        filePath: { type: 'string', description: 'Exact local path of the file to send.' },
        contact: { type: 'string', description: 'Explicit WeChat recipient or group name for desktop mode. Omit for the current Lumi user\'s bound personal WeChat bot conversation.' },
        bindingId: { type: 'string', description: 'Optional personal WeChat binding ID. Use when this Lumi user has more than one personal WeChat binding.' },
        applicationTarget: { type: 'string', description: 'Desktop app target. Defaults to wechat.' },
        useSearch: { type: 'boolean', description: 'Search for the contact before sending. Defaults true when contact is provided.' },
        sendShortcut: { type: 'string', description: 'WeChat send shortcut. Defaults enter.' },
      },
      required: ['filePath'],
    },
    handler: async (args, context) => {
      const filePath = path.resolve(String(args.filePath || '').trim());
      if (!args.filePath || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
        throw new Error(`File does not exist: ${filePath}`);
      }
      if (context?.domain === 'work' && (!context.userId || !context.orgId)) {
        throw new Error('Organization-to-personal WeChat transfer requires a bound member and organization scope for audit.');
      }
      if (context?.domain === 'work') {
        const membership = getMember(context.orgId!, context.userId!);
        if (membership?.status !== 'active' || membership.role === 'viewer') {
          throw new Error('This Lumi member cannot transfer files from the active organization.');
        }
      }
      const progress = (step: string) => context?.onProgress?.(step);
      const contact = String(args.contact || '').trim();
      let nativeFallbackReason = '';
      if (!contact && context?.userId) {
        try {
          progress(EXTERNAL_APP_MESSAGES.sendingBoundFile);
          const result = await sendLocalFileToPersonalWeChat({
            userId: context.userId,
            filePath,
            bindingId: String(args.bindingId || '').trim() || undefined,
            sourceOrgId: context.domain === 'work' ? context.orgId : undefined,
          });
          return JSON.stringify({
            sent: true,
            sendAttempted: true,
            verificationStatus: 'provider_accepted',
            verificationMethod: 'wechat_ilink_provider_ack',
            verificationConfidence: 0.95,
            filePath,
            fileName: result.fileName,
            fileSize: result.fileSize,
            bindingId: result.target.bindingId,
            messageId: result.messageId,
            method: result.method,
            note: 'The bound WeChat provider accepted the file message.',
          }, null, 2);
        } catch (err: any) {
          if (!(err instanceof WeChatFileApiUnavailableError)) throw err;
          nativeFallbackReason = err?.message || String(err);
        }
      }
      const desktopRelay = context?.domain === 'work'
        ? context.personalDesktopRelay
        : context?.desktopRelay || context?.personalDesktopRelay;
      if (!desktopRelay) {
        const suffix = nativeFallbackReason ? ` Native WeChat path unavailable: ${nativeFallbackReason}` : '';
        throw new Error(`Sending a file to personal WeChat requires either a recent bound bot conversation or the member's personal Lumi desktop client online.${suffix}`);
      }

      const sendShortcut = String(args.sendShortcut || 'enter').trim() || 'enter';
      const fileName = path.basename(filePath);
      const { openResult, activeWindow } = await prepareWeChatConversation(args, context, desktopRelay);

      const point = virtualInputPoint(activeWindow);
      await desktopRelay('desktop_cursor_glow_show', { source: 'wechat_send_file', timeoutMs: 12000 }).catch(() => '');
      await desktopRelay('desktop_cursor_glow_update', { x: point.x, y: point.y }).catch(() => '');
      await desktopRelay('desktop_mouse_click_at', { x: point.x, y: point.y, button: 'left' });
      await desktopRelay('desktop_cursor_glow_click', { x: point.x, y: point.y }).catch(() => '');
      await sleep(180);

      let beforeUiSnapshot = '';
      try { beforeUiSnapshot = await captureDesktopUiEvidence(desktopRelay, 220); } catch {}
      progress(EXTERNAL_APP_MESSAGES.sendingFile(fileName));
      await desktopRelay('desktop_clipboard_write_files', { paths: [filePath] });
      await desktopRelay('desktop_keyboard_press', { key: 'ctrl+v' });
      await sleep(500);
      await desktopRelay('desktop_keyboard_press', { key: sendShortcut });
      await sleep(800);
      await desktopRelay('desktop_cursor_glow_hide', { source: 'wechat_send_file' }).catch(() => '');

      const finalActiveWindow = parseDesktopJson(await desktopRelay('desktop_active_window', {}));
      if (!isWeChatActiveWindow(finalActiveWindow)) {
        throw new Error(`File send shortcut was pressed, but WeChat is no longer foreground. Active window: ${JSON.stringify(finalActiveWindow).slice(0, 300)}`);
      }
      let afterUiSnapshot = '';
      try { afterUiSnapshot = await captureDesktopUiEvidence(desktopRelay, 260); } catch {}
      const normalizedAfter = afterUiSnapshot.toLowerCase();
      const uiVerified = normalizedAfter.includes(fileName.toLowerCase()) && afterUiSnapshot !== beforeUiSnapshot;

      let visionVerification = { sent: false, confidence: 0, reason: '' };
      const visionConfig = hasVisionProvider(context);
      if (!uiVerified && visionConfig) {
        try {
          const screenCapture = await desktopRelay('desktop_capture_screen', { quality: 70 });
          const getters = context?.llmGetters;
          const verificationText = await analyzeScreen(
            screenCapture,
            [
              'Verify a foreground WeChat file send using only visible evidence.',
              `Expected recipient/group: ${JSON.stringify(contact || '(current conversation)')}.`,
              `Expected filename: ${JSON.stringify(fileName)}.`,
              'Set sent=true only if the filename is visibly present as the newest outgoing file bubble and is no longer merely pending in the input area.',
              'Return only JSON: {"sent":boolean,"confidence":number,"reason":"short visible evidence"}.',
            ].join('\n'),
            visionConfig,
            ...providerGetterArguments(getters),
          );
          visionVerification = parseWeChatSendVisionVerification(verificationText);
        } catch (err: any) {
          visionVerification.reason = err?.message || String(err);
        }
      }
      const sent = uiVerified || visionVerification.sent;

      if (sent && context?.domain === 'work' && context.orgId && context.userId) {
        logAudit({
          orgId: context.orgId,
          userId: context.userId,
          action: 'messaging.file.transfer_to_personal_wechat',
          resourceType: 'messaging_file_transfer',
          resourceId: `wechat:${Date.now()}`,
          details: {
            sourceDomain: 'work',
            targetPlatform: 'wechat',
            contact: contact || '(current conversation)',
            fileName,
            fileSize: fs.statSync(filePath).size,
            localPath: filePath,
            verificationMethod: uiVerified ? 'uia_filename' : 'screen_vision',
          },
        });
      }

      return JSON.stringify({
        sent,
        sendAttempted: true,
        verificationStatus: sent ? 'verified' : 'uncertain',
        verificationMethod: uiVerified ? 'uia_filename' : visionVerification.sent ? 'screen_vision' : 'none',
        verificationConfidence: uiVerified ? 0.8 : visionVerification.confidence,
        verificationReason: uiVerified
          ? 'The exact filename appeared as new accessible WeChat UI text after the send action.'
          : visionVerification.reason || 'No outgoing file-bubble evidence was available.',
        contact: contact || null,
        filePath,
        fileName,
        openResult,
        activeWindow: finalActiveWindow,
        nativeFallbackReason: nativeFallbackReason || null,
        note: sent
          ? 'The foreground file send completed and was verified from visible WeChat evidence.'
          : 'The send shortcut was pressed, but completion was not verified. Do not report the file as sent.',
      }, null, 2);
    },
    permission: 'user',
    securityLevel: 'safe',
    capability: {
      id: 'messaging.wechat.send-file',
      family: 'messaging',
      lane: 'messaging',
      operation: 'communicate',
      risk: 'medium',
      sideEffects: [{ type: 'external_communication', scope: 'explicit WeChat recipient and local file', reversible: false }],
      verification: {
        strategy: 'provider_ack',
        required: true,
        requiredFields: ['sent', 'verificationStatus'],
        successSignals: ['sent=true with provider or exact filename evidence'],
        limitations: ['Clipboard file preparation and send attempts are not delivery acknowledgement.'],
      },
    },
    evidence: {
      capability: 'messaging.wechat.send-file',
      operation: 'communicate',
      assurance: 'verified',
      subjectArgument: 'contact',
      limitations: ['Exact filename and target acknowledgement are required.'],
    },
  });
}
