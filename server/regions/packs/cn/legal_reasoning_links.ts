import type { CitationVerificationOptions } from '../../../legal/kb';
import { verifyCitation, verifyMultipleCitations } from '../../../legal/kb';
import { isLegalSourceMaterial } from '../../../../shared/legal_workflow_receipts';
import type { OrgLegalCaseFile } from '../../../org/legal_cases';

import type { LegalApplicationCheck, LegalReasoningLink, LegalRulePart } from '../../../../shared/legal_workflow_receipts';
export type { LegalApplicationCheck, LegalReasoningLink, LegalRulePart } from '../../../../shared/legal_workflow_receipts';

/** New analysis applies the complete provision, without treating punctuation as legal premises. */
export function legalRuleParts(quote: string): LegalRulePart[] {
  return quote.trim() ? [{ id: 'P1', start: 0, end: quote.length, quote }] : [];
}

export function compileLegalApplicationChecks(checks: LegalApplicationCheck[]) {
  return {
    application: checks.map(check => [
      '【' + check.partId + '】规则原文衔接片段：' + check.ruleQuote,
      ...check.evidence.map(source => '- 本案材料 ' + source.materialId + '；位置 ' + source.locator + '；原句：' + source.quote),
      '本案适用核对（' + (check.status === 'supported' ? '给定材料范围内有依据，仍未核准' : check.status === 'conditional' ? '以下为条件分析，尚未确认适用前提' : '依据不足') + '）：' + check.application,
    ].join('\n')).join('\n\n'),
    conclusion: checks.map(check => '【' + check.partId + '】' + (check.status === 'conditional' ? '现有材料不足以作确定结论；' : '') + check.conclusion).join('\n'),
    limitations: [...new Set(checks.flatMap(check => check.missingPremises))].map(premise => '尚待核实是否成立：' + premise).concat('仅为给定材料范围内的拟议分析，不证明证据真实或律师已经核准。').join('；'),
  };
}

export const legalReasoningLinksSchema = {
  type: 'array', maxItems: 30, description: '逐项关联规则原文、待证事实、当前案件材料 ID/原文/页码、适用分析、结论和证据限制；仅有三个标题不能通过交付检查。',
  items: { type: 'object', required: ['issue', 'ruleCitation', 'ruleQuote', 'fact', 'evidence', 'application', 'conclusion', 'limitations'], properties: {
    issue: { type: 'string' }, ruleCitation: { type: 'string', description: '一条具体法条，多条法律依据拆成多项。' },
    ruleQuote: { type: 'string', description: '该法条的连续原文摘录，不混入条号标签或其他条文。' },
    fact: { type: 'string', description: '从本项证据摘录中连续引用待证事实；计算与推断写在 application，不补造事实。' },
    evidence: { type: 'array', minItems: 1, items: { type: 'object', required: ['materialId', 'quote', 'locator'], properties: {
      materialId: { type: 'string' }, quote: { type: 'string' }, locator: { type: 'string' },
    } } },
    application: { type: 'string' }, conclusion: { type: 'string' }, limitations: { type: 'string' },
  } },
};

const compact = (value: unknown) => String(value || '').replace(/\s+/g, '');
const substantive = (value: unknown) => typeof value === 'string' && compact(value).length >= 8
  && !/^(待补|待填|待确认|TODO|TBD)/i.test(value.trim());

function hasReasoningLinkShape(value: unknown): value is LegalReasoningLink {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const link = value as LegalReasoningLink;
  return ['issue', 'ruleCitation', 'ruleQuote', 'fact', 'application', 'conclusion', 'limitations']
    .every(field => typeof link[field as keyof LegalReasoningLink] === 'string')
    && Array.isArray(link.evidence) && link.evidence.every(evidence => evidence && typeof evidence === 'object'
      && ['materialId', 'quote', 'locator'].every(field => typeof evidence[field as keyof typeof evidence] === 'string'));
}

/** Verifies traceability, not evidentiary truth or the legal correctness of an inference. */
export function inspectLegalReasoningLinks(input: unknown, caseFile: OrgLegalCaseFile | null, orgId: string,
  options: CitationVerificationOptions & { document?: string } = {}) {
  const errors: string[] = [];
  const candidates: unknown[] = Array.isArray(input) ? input : [];
  const links = candidates.slice(0, 30).filter(hasReasoningLinkShape).map(link => ({ ...link }));
  if (!caseFile) errors.push('需要关联有权限的案件及已归档原始材料。');
  if (!candidates.length || candidates.length > 30) errors.push('需要 1–30 条规则—事实—证据—适用结论关联，不能只提供分析标题。');
  if (links.length !== Math.min(candidates.length, 30)) errors.push('分析条目格式无效：文字字段及证据 ID、原文、位置必须完整，不能使用空对象或错误类型。');
  for (const [index, link] of links.slice(0, 30).entries()) {
    const prefix = `第 ${index + 1} 项：`;
    if (!link || typeof link !== 'object') { errors.push(`${prefix}关联格式无效。`); continue; }
    for (const field of ['issue', 'ruleCitation', 'ruleQuote', 'fact', 'application', 'conclusion', 'limitations'] as const) {
      const meaningful = field === 'limitations' ? compact(link[field]).length >= 8
        : field === 'issue' ? compact(link[field]).length >= 2 : substantive(link[field]);
      if (!meaningful) errors.push(`${prefix}${field} 缺少具体内容。`);
    }
    const check = verifyCitation(String(link.ruleCitation || ''), orgId, { ...options, quotedText: String(link.ruleQuote || '') });
    const rules = verifyMultipleCitations(link.ruleCitation, orgId, options);
    if (rules.length !== 1 || rules[0].type !== 'statute') errors.push(`${prefix}每项只能关联一条具体法条；多条法律依据需分别分析并逐条摘录。`);
    if (check.type !== 'statute' || !check.provisionVerified || check.isEffective !== true || check.quotationVerified !== true || check.temporalApplicabilityVerified === false) {
      errors.push(`${prefix}规则引用未通过现行原文核验：${check.detail}`);
    }
    if (link.applicationChecks !== undefined) {
      const checks = link.applicationChecks;
      // Exact consecutive coverage accepts both stored fragments and a whole-provision check.
      if (!Array.isArray(checks) || !checks.length || checks[checks.length - 1]?.ruleEnd !== link.ruleQuote.length
        || checks.some((item, i) => !item || item.partId !== 'P' + (i + 1)
        || item.ruleStart !== (i ? checks[i - 1]?.ruleEnd : 0) || !Number.isInteger(item.ruleEnd) || item.ruleEnd <= item.ruleStart
        || item.ruleQuote !== link.ruleQuote.slice(item.ruleStart, item.ruleEnd)
        || !Array.isArray(item.evidence) || !item.evidence.length || item.evidence.some(source => !source || !link.evidence.some(existing => existing.materialId === source.materialId && existing.quote === source.quote && existing.locator === source.locator))
        || !['supported', 'conditional'].includes(item.status) || !substantive(item.application) || !substantive(item.conclusion)
        || !Array.isArray(item.missingPremises) || !item.missingPremises.every(value => typeof value === 'string' && value.trim())
        || (item.status === 'supported' && item.missingPremises.length) || (item.status === 'conditional' && !item.missingPremises.length))) {
        errors.push(prefix + '适用核对必须逐项保留完整规则片段、原文衔接和本案依据。');
      } else {
        const compiled = compileLegalApplicationChecks(checks);
        const legacyLimitations = [...new Set(checks.flatMap(item => item.missingPremises)), '仅为给定材料范围内的拟议分析，不证明证据真实或律师已经核准。'].join('；');
        if (link.application !== compiled.application || link.conclusion !== compiled.conclusion
          || (link.limitations !== compiled.limitations && link.limitations !== legacyLimitations)) errors.push(prefix + '适用核对正文与来源绑定结构不一致。');
        else link.limitations = compiled.limitations;
      }
    }
    if ((link.ruleReferenceDate !== undefined && link.ruleReferenceDate !== check.referenceDate) || (link.ruleTemporalScope !== undefined && link.ruleTemporalScope !== check.temporalScope)) errors.push(prefix + '本条法源的适用时间基准与核验记录不一致。');
    if (!Array.isArray(link.evidence) || !link.evidence.length || link.evidence.length > 30) errors.push(`${prefix}缺少可定位的原始证据。`);
    for (const evidence of Array.isArray(link.evidence) ? link.evidence.slice(0, 30) : []) {
      const material = caseFile?.materials.find(m => m.id === evidence?.materialId && isLegalSourceMaterial(m));
      if (!material || !substantive(evidence?.quote) || !compact(material.content).includes(compact(evidence.quote))) {
        errors.push(`${prefix}证据摘录不在本案原始材料中，不能引用其他案件或生成稿作证明。`);
      }
      if (!String(evidence?.locator || '').trim() || /^(待|TODO|TBD)/i.test(evidence.locator)) errors.push(`${prefix}证据缺少页码、段落或时间戳。`);
    }
    const factParts = String(link.fact || '').split(/\r?\n/).map(compact).filter(Boolean);
    const factCovered = factParts.length > 0 && factParts.every(part => link.evidence.some(evidence => {
      if (compact(evidence.quote).includes(part)) return true;
      const material = caseFile?.materials.find(item => item.id === evidence.materialId && isLegalSourceMaterial(item));
      // The same original may be quoted as several adjacent snippets. Check
      // their union against that original instead of forcing an LLM rewrite.
      if (!material || !compact(material.content).includes(part)) return false;
      const snippets = link.evidence.filter(item => item.materialId === material.id).map(item => compact(item.quote));
      const covered = new Uint8Array(part.length);
      for (const snippet of snippets) {
        for (let pos = part.indexOf(snippet); snippet && pos >= 0; pos = part.indexOf(snippet, pos + 1)) covered.fill(1, pos, pos + snippet.length);
      }
      return part.split('').every((char, index) => covered[index] || /[，。；、,:;.!?！？]/u.test(char));
    }));
    if (!substantive(link.fact) || !factCovered) {
      errors.push(`${prefix}待证事实必须连续摘自本项原始证据；推断或计算应另写在适用分析，不能把材料未提供的信息写成已确认事实。`);
    }
    if (options.document !== undefined && (!substantive(link.conclusion) || !compact(options.document).includes(compact(link.conclusion)))) {
      errors.push(`${prefix}结论未出现在本次拟交付文书中，不能复用无关底稿。`);
    }
  }
  if (options.document !== undefined) {
    const linked = new Set(links.map(link => compact(verifyCitation(String(link?.ruleCitation || ''), orgId, options).sourceText)));
    for (const check of verifyMultipleCitations(options.document, orgId, options).filter(check => check.type === 'statute')) {
      if (!check.sourceText || !linked.has(compact(check.sourceText))) errors.push(`文书引用 ${check.citation} 缺少对应适用分析。`);
    }
  }
  return { passed: errors.length === 0, links, errors, legalValidityVerified: false as const };
}

export function formatLegalReasoningLinks(links: LegalReasoningLink[]): string {
  return links.filter(hasReasoningLinkShape).map((link, i) => [
    `### ${i + 1}. ${link.issue}`, `法律依据：${link.ruleCitation}\n法条原文：${link.ruleQuote}`,
    ...(link.ruleReferenceDate ? ['本条法律适用基准（' + (link.ruleTemporalScope === 'procedure' ? '程序' : '实体事实') + '，不代替具体事件日期）：' + link.ruleReferenceDate] : []),
    ...(link.applicationChecks ? [
      '适用分析（以下为完整原文的连续衔接片段，不表示各片段是独立成立的法律条件）：\n' + link.application,
      '拟议结论（与同一原文片段编号对应，不另写一套法律前提）：\n' + link.conclusion,
    ] : [`事实与证据：${link.fact}`, ...link.evidence.map(e => `- 材料 ${e.materialId}；位置 ${e.locator}；摘录：${e.quote}`),
      `适用分析：${link.application}`, `结论：${link.conclusion}`]),
    `限制与反证：${link.limitations}`,
  ].join('\n\n')).join('\n\n');
}
