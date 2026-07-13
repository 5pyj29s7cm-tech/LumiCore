import { translations, type TranslationDict } from '../lib/translations';

export const DEFAULT_LOCALE = 'en' as const;
export const LOCALE_STORAGE_KEY = 'lumi-lang';

export type Locale = keyof typeof translations;

const localeListeners = new Set<() => void>();
let activeLocale: Locale | undefined;

export function normalizeLocale(value: unknown): Locale | null {
  const normalized = String(value || '').trim().toLowerCase().replace('_', '-');
  if (!normalized) return null;
  if (normalized === 'zh' || normalized.startsWith('zh-')) return 'zh';
  if (normalized === 'en' || normalized.startsWith('en-')) return 'en';
  return null;
}

export function resolveInitialLocale(input: {
  storedLocale?: unknown;
  browserLanguages?: readonly string[];
} = {}): Locale {
  const stored = normalizeLocale(input.storedLocale);
  if (stored) return stored;

  for (const language of input.browserLanguages || []) {
    const locale = normalizeLocale(language);
    if (locale) return locale;
  }

  return DEFAULT_LOCALE;
}

function readBrowserLanguages(): string[] {
  if (typeof navigator === 'undefined') return [];
  return Array.from(new Set([...(navigator.languages || []), navigator.language].filter(Boolean)));
}

function readStoredLocale(): string | null {
  if (typeof localStorage === 'undefined') return null;
  try {
    return localStorage.getItem(LOCALE_STORAGE_KEY);
  } catch {
    return null;
  }
}

function persistLocale(locale: Locale): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(LOCALE_STORAGE_KEY, locale);
  } catch {
    // Private or restricted browser contexts can reject storage writes.
  }
}

function applyDocumentLocale(locale: Locale): void {
  if (typeof document === 'undefined') return;
  document.documentElement.lang = locale === 'zh' ? 'zh-CN' : 'en';
}

export function getLocale(): Locale {
  if (!activeLocale) {
    activeLocale = resolveInitialLocale({
      storedLocale: readStoredLocale(),
      browserLanguages: readBrowserLanguages(),
    });
    applyDocumentLocale(activeLocale);
  }
  return activeLocale;
}

export function setLocale(value: Locale | string): Locale {
  const locale = normalizeLocale(value) || DEFAULT_LOCALE;
  const changed = locale !== getLocale();
  activeLocale = locale;
  persistLocale(locale);
  applyDocumentLocale(locale);
  if (changed) localeListeners.forEach(listener => listener());
  return locale;
}

export function subscribeLocale(listener: () => void): () => void {
  localeListeners.add(listener);
  return () => localeListeners.delete(listener);
}

export function getMessages(locale: Locale = getLocale()): TranslationDict {
  return translations[locale] || translations[DEFAULT_LOCALE];
}

export function translate(key: string, values?: Record<string, string | number>): string {
  const localeMessages = getMessages();
  let message = localeMessages[key] || translations[DEFAULT_LOCALE][key] || key;
  if (!values) return message;
  for (const [name, value] of Object.entries(values)) {
    message = message.replaceAll(`{${name}}`, String(value));
  }
  return message;
}

export function resetLocaleForTests(): void {
  activeLocale = undefined;
  localeListeners.clear();
}
