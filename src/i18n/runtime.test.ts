import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_LOCALE,
  getLocale,
  getMessages,
  normalizeLocale,
  resetLocaleForTests,
  resolveInitialLocale,
  setLocale,
  subscribeLocale,
  translate,
} from './runtime';
import { translations } from '../lib/translations';
import uiMessageData from './locales/ui.generated.json';

describe('locale runtime', () => {
  afterEach(() => {
    resetLocaleForTests();
  });

  it('uses English as the canonical fallback', () => {
    expect(DEFAULT_LOCALE).toBe('en');
    expect(resolveInitialLocale()).toBe('en');
    expect(resolveInitialLocale({ browserLanguages: ['fr-FR'] })).toBe('en');
    expect(getMessages('en')).toBe(translations.en);
  });

  it('normalizes supported browser locale aliases', () => {
    expect(normalizeLocale('zh-CN')).toBe('zh');
    expect(normalizeLocale('zh_Hans')).toBe('zh');
    expect(normalizeLocale('en-US')).toBe('en');
    expect(normalizeLocale('fr')).toBeNull();
    expect(resolveInitialLocale({ storedLocale: 'zh-CN', browserLanguages: ['en-US'] })).toBe('zh');
  });

  it('notifies subscribers when the locale changes', () => {
    setLocale('en');
    const listener = vi.fn();
    const unsubscribe = subscribeLocale(listener);
    expect(getLocale()).toBe('en');
    setLocale('zh');
    expect(listener).toHaveBeenCalledTimes(1);
    expect(translate('notificationCenter')).toBe(translations.zh.notificationCenter);
    setLocale('zh');
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
  });

  it('keeps English and Chinese catalogs in key parity', () => {
    expect(Object.keys(translations.zh).sort()).toEqual(Object.keys(translations.en).sort());
  });

  it('keeps canonical English catalogs free of Han text', () => {
    const han = /[\u3400-\u4dbf\u4e00-\u9fff]/u;
    const translationViolations = Object.entries(translations.en)
      .filter(([, value]) => han.test(value))
      .map(([key]) => key);
    const generatedViolations = Object.entries(uiMessageData)
      .filter(([, value]) => han.test(value.en))
      .map(([key]) => key);

    expect(translationViolations).toEqual([]);
    expect(generatedViolations).toEqual([]);
  });
});
