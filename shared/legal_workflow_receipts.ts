export type LegalRulePart = { id: string; start: number; end: number; quote: string };
export type LegalApplicationCheck = { partId: string; ruleStart: number; ruleEnd: number; ruleQuote: string;
  evidence: Array<{ materialId: string; quote: string; locator: string }>;
  status: 'supported' | 'conditional' | 'unsupported'; application: string; conclusion: string; missingPremises: string[] };

export interface LegalReasoningLink {
  issue: string;
  ruleCitation: string;
  ruleQuote: string;
  fact: string;
  evidence: Array<{ materialId: string; quote: string; locator: string }>;
  application: string;
  conclusion: string;
  limitations: string;
  applicationChecks?: LegalApplicationCheck[];
  ruleReferenceDate?: string;
  ruleTemporalScope?: 'fact' | 'procedure';
}

/** Server-issued execution records. User documents are never progress receipts. */
export interface LegalWorkflowRun {
  tool: string;
  ok: boolean;
  status: string;
  checkedAt: string;
  basis: string;
  materialIds: string[];
  artifacts: string[];
  /** Actual returned text for read-only business-page history; never source evidence. */
  displayText?: string;
  currentLawGate?: 'passed' | 'blocked';
  reasoningLinked?: boolean;
  draftMode?: 'template' | 'mixed' | 'model';
}

export function isLegalSourceMaterial(material: { source?: string; title?: string }): boolean {
  return material.source !== 'tool' || [
    '案件事实与时间线', '证据材料与证明目的', '起诉状/答辩状/对方材料',
    '庭审/会议/沟通记录', '法条、类案与外部检索记录',
  ].includes(material.title || '');
}

/** Change detection only; authorization and formal delivery are checked server-side. */
export function legalCaseSourceFingerprint(input: {
  title?: string; party?: string; cause?: string; court?: string; caseNumber?: string;
  notes?: string; clientPartyName?: string; clientRole?: string; objective?: string; factDate?: string;
  materials?: Array<{ id?: string; type?: string; source?: string; title?: string; content?: string; localPath?: string }>;
}): string {
  const source = JSON.stringify([
    input.title || '', input.party || '', input.cause || '', input.court || '', input.caseNumber || '',
    input.clientRole || '', input.objective || '', (input.notes || '').replace(/^【材料归档】.*$/gm, '').trim(),
    (input.materials || []).filter(isLegalSourceMaterial).map(m => [m.id, m.type, m.title, m.content, m.localPath]).sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
    ...(input.clientPartyName ? [['clientPartyName', input.clientPartyName]] : []),
    ...(input.factDate ? [['factDate', input.factDate]] : []),
  ]);
  let a = 2166136261; let b = 5381;
  for (let i = 0; i < source.length; i++) {
    a = Math.imul(a ^ source.charCodeAt(i), 16777619);
    b = Math.imul(b, 33) ^ source.charCodeAt(i);
  }
  return `${source.length}:${(a >>> 0).toString(16)}:${(b >>> 0).toString(16)}`;
}
