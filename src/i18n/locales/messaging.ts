import { getLocale, type Locale } from '../runtime';

const BINDING_COMMAND_TEMPLATES: Record<Locale, string> = {
  en: 'Bind Lumi {code}',
  zh: '绑定 Lumi {code}',
};

export function formatMessagingBindingCommand(code: string, locale: Locale = getLocale()): string {
  return BINDING_COMMAND_TEMPLATES[locale].replace('{code}', code.trim());
}
