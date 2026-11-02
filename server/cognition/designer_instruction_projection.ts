import { affirmativeDesignerInstructionText } from './designer_clause_projection';
import { getCurrentIndustryCapabilityProfile, isCurrentIndustryMultiWorkspaceLedgerStatusRequest } from '../regions/routing/industry_profile';
import { isDesignProjectStatusRequest } from '../design/status_intent';

/** Exact visible workspace labels are operands, while quoted commands remain data. */
export function designerInstructionText(text: string): string {
  const labels = new Set(getCurrentIndustryCapabilityProfile()?.entries.map(entry => entry.displayName) || []);
  // i18n-allow: The adverb 'respectively' contains the one-character negator;
  // canonicalize only its direct read/report form before polarity projection.
  text = text.replace(/分别(?=列出|查询|查看|汇总|报告)/gu, '逐项');
  // i18n-allow: Quote and list delimiters around exact registered workspace operands.
  const operands = text.replace(/[“‘"]([^“”‘’"\r\n]+)[”’"]/gu, (literal, value: string) => {
    const values = value.split(/[、，,]/u).map(part => part.trim());
    return values.length && values.every(part => labels.has(part)) ? values.join('、') : literal;
  });
  return affirmativeDesignerInstructionText(operands);
}

export function designerStatusRequest(text: string): boolean {
  const projected = designerInstructionText(text);
  return isDesignProjectStatusRequest(projected) || isCurrentIndustryMultiWorkspaceLedgerStatusRequest(projected);
}
