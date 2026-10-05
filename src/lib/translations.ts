import { enCatalog } from "../i18n/locales/catalog_en";
import { zhCatalog } from "../i18n/locales/catalog_zh";

export type TranslationDict = Record<string, string>;
export type TranslationMap = { en: TranslationDict; zh: TranslationDict };

export const translations: TranslationMap = { en: enCatalog, zh: zhCatalog };
