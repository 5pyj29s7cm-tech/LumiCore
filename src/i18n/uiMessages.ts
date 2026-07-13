import uiMessageData from './locales/ui.generated.json';
import { getLocale, type Locale } from './runtime';

export type UiMessageKey = keyof typeof uiMessageData;

type UiMessageValue = string | number | boolean | null | undefined;
type LocalizedUiMessageValue = UiMessageValue | { en: UiMessageValue; zh: UiMessageValue };

export function uiMessage(key: UiMessageKey, locale: Locale = getLocale()): string {
  const entry = uiMessageData[key] as { en: string; zh: string } | undefined;
  if (!entry) return key;
  return entry[locale] || entry.en || key;
}

export function formatUiMessage(
  key: UiMessageKey,
  values: Record<string, LocalizedUiMessageValue>,
  locale: Locale = getLocale(),
): string {
  return uiMessage(key, locale).replace(/\{([a-zA-Z0-9_]+)\}/g, (_match, name: string) => {
    const value = values[name];
    if (value && typeof value === 'object' && 'en' in value && 'zh' in value) {
      return String(value[locale] ?? '');
    }
    return String(value ?? '');
  });
}
