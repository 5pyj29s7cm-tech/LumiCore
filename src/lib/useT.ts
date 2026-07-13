import { useSyncExternalStore } from 'react';
import {
  getLocale,
  getMessages,
  setLocale,
  subscribeLocale,
  translate,
  type Locale,
} from '../i18n/runtime';
import type { TranslationDict } from './translations';

export function useLocale(): Locale {
  return useSyncExternalStore(subscribeLocale, getLocale, getLocale);
}

export function setLang(lang: Locale): Locale {
  return setLocale(lang);
}

export function useT(): TranslationDict {
  return getMessages(useLocale());
}

export function t(key: string, values?: Record<string, string | number>): string {
  return translate(key, values);
}

export type { Locale } from '../i18n/runtime';
