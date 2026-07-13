import { getLocale, type Locale } from '../runtime';

const KNOWLEDGE_CATEGORY_LABELS = {
  en: { general: 'General', policy: 'Policy', sop: 'SOP', product: 'Product', culture: 'Culture', files: 'Files', hr: 'HR', tech: 'Technical', legal_statute: 'Statute', legal_judgment: 'Judgment', legal_contract: 'Contract' },
  zh: { general: '通用', policy: '制度', sop: 'SOP', product: '产品', culture: '文化', files: '资料', hr: 'HR', tech: '技术', legal_statute: '法规', legal_judgment: '判例', legal_contract: '合同' },
} as const;

export function knowledgeCategoryLabels(locale: Locale = getLocale()) {
  return KNOWLEDGE_CATEGORY_LABELS[locale];
}
