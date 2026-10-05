import { useSyncExternalStore } from 'react';
import {
  getLocale,
  getMessages,
  setLocale,
  subscribeLocale,
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

export type { Locale } from '../i18n/runtime';
