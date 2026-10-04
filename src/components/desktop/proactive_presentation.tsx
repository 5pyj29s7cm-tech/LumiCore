import { desktopWorkflowCopy } from "../../i18n/locales/desktopWorkflows";
import { uiMessage, formatUiMessage } from "../../i18n/uiMessages";

export type ProactiveChatDetail = {
  type?: string;
  message?: string;
  action?: string;
  proactiveContext?: Record<string, any>;
  context?: Record<string, any>;
  timestamp?: string;
};


function proactiveActionLabel(action: string | undefined, lang: 'en' | 'zh'): string {
  const labels = desktopWorkflowCopy(lang).proactiveActions as Record<string, string>;
  return (action ? labels[action] : '') || action || uiMessage('desktop-ui.continue.5206d89b73', lang);
}


function compactProactivePreview(value: unknown): string {
  const text = String(value || '').trim().replace(/\s+/g, ' ');
  if (!text) return '';
  return text.length > 700 ? `${text.slice(0, 700)}...` : text;
}


export function formatProactiveChatPrefill(detail: ProactiveChatDetail, lang: 'en' | 'zh'): string {
  const message = String(detail.message || '').trim();
  const context = detail.proactiveContext || detail.context || {};
  const lines = [message || (uiMessage('desktop-ui.i-just-noticed-a-context.e82631aa13', (lang === 'zh') ? 'zh' : 'en'))];

  if (context.trigger === 'window_changed') {
    const appLabel = context.appLabel || context.processName || (uiMessage('desktop-ui.the-current-app.9ba27b3466', (lang === 'zh') ? 'zh' : 'en'));
    lines.push('');
    lines.push(formatUiMessage('desktop-ui.i-asked-because-you-switched.dca30b423a', { value0: appLabel }, (lang === 'zh') ? 'zh' : 'en'));
    if (context.windowTitle) {
      lines.push(formatUiMessage('desktop-ui.active-window-value0.39501f825f', { value0: context.windowTitle }, (lang === 'zh') ? 'zh' : 'en'));
    }
  } else if (context.trigger === 'clipboard_changed') {
    lines.push('');
    lines.push(uiMessage('desktop-ui.i-asked-because-i-noticed.e51083b4fa', (lang === 'zh') ? 'zh' : 'en'));
    const preview = compactProactivePreview(context.preview);
    if (preview) {
      lines.push(formatUiMessage('desktop-ui.context-preview-value0.ab9411a203', { value0: preview }, (lang === 'zh') ? 'zh' : 'en'));
    }
  }

  if (detail.action) {
    lines.push(formatUiMessage('desktop-ui.suggested-action-value0.35f751e5d4', { value0: proactiveActionLabel(detail.action, lang) }, (lang === 'zh') ? 'zh' : 'en'));
  }
  lines.push(uiMessage('desktop-ui.you-can-reply-yes-take.44dc1e9be5', (lang === 'zh') ? 'zh' : 'en'));
  return lines.join('\n');
}
