import { EXTERNAL_APP_MESSAGES } from '../../regions/packs/cn/external_app_messages';
import { providerGetterArguments } from "../../llm/provider_getters";
import { analyzeScreen } from '../../llm/adapter';
import type { ToolRegistry } from '../registry';
import { captureDesktopUiEvidence, hasVisionProvider, prepareWeChatConversation, requireDesktopRelay } from './external_app_shared';

function compactEvidenceText(value: string, limit = 2400): string {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (text.length <= limit) return text;
  return `${text.slice(0, Math.floor(limit * 0.7))}\n...\n${text.slice(-Math.floor(limit * 0.25))}`;
}

function hasReadableUiEvidence(snapshotText: string): boolean {
  if (!snapshotText || /^UI snapshot unavailable/i.test(snapshotText)) return false;
  const withoutUiBoilerplate = snapshotText.replace(
    /\b(?:window|text|edit|button|pane|group|document|control|name|role|automationid|classname|bounds)\b/gi,
    ' ',
  );
  const readableChars = withoutUiBoilerplate.match(/[\u4e00-\u9fffA-Za-z0-9]/gu) || [];
  return readableChars.length >= 12;
}

export function registerWechatReadTools(registry: ToolRegistry): void {
registry.register({
    name: 'wechat_read_recent_chat',
    description: 'Read the currently visible recent messages from the real foreground WeChat client. It reuses an already-running WeChat window when possible, optionally selects a contact through WeChat search, captures UI/screen evidence, and uses the configured vision model when available. It never sends messages.',
    parameters: {
      type: 'object',
      properties: {
        contact: { type: 'string', description: 'Contact or group name to select in WeChat. Omit to inspect the current chat.' },
        applicationTarget: { type: 'string', description: 'Desktop app target. Defaults to wechat.' },
        useSearch: { type: 'boolean', description: 'Use WeChat search to select contact before reading. Defaults true when contact is provided.' },
        maxMessages: { type: 'number', description: 'Approximate number of recent visible messages to summarize. Defaults 8.' },
      },
      required: [],
    },
    handler: async (args, context) => {
      const desktopRelay = requireDesktopRelay(context);
      const progress = (step: string) => context?.onProgress?.(step);
      const { contact, useSearch, openResult, activeWindow } = await prepareWeChatConversation(args, context, desktopRelay, true);
      const maxMessages = Math.max(3, Math.min(Number(args.maxMessages || 8), 20));

      progress(EXTERNAL_APP_MESSAGES.readingChat);
      let uiSnapshot = '';
      try {
        uiSnapshot = await captureDesktopUiEvidence(desktopRelay, 180);
      } catch (err: any) {
        uiSnapshot = `UI snapshot unavailable: ${err?.message || String(err)}`;
      }

      const screenCapture = await desktopRelay('desktop_capture_screen', { quality: 65 });
      let contentSummary = '';
      let visionError = '';
      const visionConfig = hasVisionProvider(context);
      if (visionConfig) {
        const getters = context?.llmGetters;
        const query = [
          contact
            ? `This is a WeChat conversation window. The target contact/group is "${contact}".`
            : 'This is a WeChat conversation window.',
          `Read the most recent ${maxMessages} visible chat messages. Return the visible speaker/message content and a concise Chinese summary.`,
          'Do not infer hidden messages. If the screenshot is not a chat window or text is unreadable, say that clearly.',
        ].join('\n');
        try {
          contentSummary = await analyzeScreen(
            screenCapture,
            query,
            visionConfig,
            ...providerGetterArguments(getters),
          );
        } catch (err: any) {
          visionError = err?.message || String(err);
        }
      } else {
        visionError = 'No configured vision provider is available for reading chat text from the screenshot.';
      }

      const snapshotText = compactEvidenceText(uiSnapshot, 1800);
      const hasUsefulSnapshot = hasReadableUiEvidence(snapshotText);
      const read = Boolean(contentSummary.trim()) || hasUsefulSnapshot;

      return JSON.stringify({
        read,
        contact: contact || null,
        usedContactSearch: useSearch,
        method: contentSummary.trim() ? 'foreground_wechat_search_screenshot_vision' : 'foreground_wechat_search_ui_snapshot',
        openResult,
        activeWindow,
        contentSummary: contentSummary.trim() || null,
        uiSnapshotPreview: snapshotText || null,
        screenCaptured: Boolean(screenCapture),
        visionProvider: visionConfig?.provider || null,
        visionError: visionError || null,
        note: read
          ? 'Visible WeChat chat evidence was captured and read from the foreground window.'
          : 'WeChat was opened/focused, but no readable chat content evidence was extracted.',
      }, null, 2);
    },
    permission: 'user',
    securityLevel: 'safe',
  });
}
