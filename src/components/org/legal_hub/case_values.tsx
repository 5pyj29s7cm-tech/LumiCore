import { CHINA_LEGAL_WORKSPACE_COPY } from '../../../i18n/regions/cn/legalWorkspace';
import type { LegalCaseFile, LegalCaseStage } from "../../../lib/legalCaseStore";
import { uiMessage } from "../../../i18n/uiMessages";

export function legalCaseTitle(caseFile?: LegalCaseFile | null): string {
  if (!caseFile) return 'Untitled legal case';
  return caseFile.title || caseFile.party || caseFile.caseNumber || 'Untitled legal case';
}

export function resolveLegalCaseActiveId(cases: LegalCaseFile[], requestedId: string): string {
  return cases.some(item => item.id === requestedId) ? requestedId : (cases[0]?.id || '');
}

export function legalStageLabels(): Record<LegalCaseStage, string> {
  return {
    consultation: uiMessage('legal-hub.consultation.7a3d850bb4'),
    filing: uiMessage('legal-hub.filing.84e2c4dc09'),
    trial: uiMessage('legal-hub.trial.26f80dc45f'),
    judgment: uiMessage('legal-hub.judgment.407839a173'),
    enforcement: uiMessage('legal-hub.enforcement.10a7440dfb'),
    closed: uiMessage('legal-hub.closed.8d3c2a38e3'),
  };
}

export function buildLegalCaseKnowledgeMarkdown(caseFile: LegalCaseFile): string {
  const materialLines = (caseFile.materials || []).map((material, index) => [
    `## Material ${index + 1}: ${material.title}`,
    `- Type: ${material.type}`,
    `- Source: ${material.source || 'manual'}`,
    `- Created: ${material.createdAt}`,
    '',
    material.content || '(No extracted content)',
  ].join('\n'));

  return [
    `# Legal Case Archive: ${legalCaseTitle(caseFile)}`,
    '',
    '## Case Profile',
    `- Case number: ${caseFile.caseNumber || '-'}`,
    `- Party: ${caseFile.party || '-'}`,
    `- Cause: ${caseFile.cause || '-'}`,
    `- Court: ${caseFile.court || '-'}`,
    `- Judge: ${caseFile.judge || '-'}`,
    `- Stage: ${caseFile.stage || '-'}`,
    `- Hearing date: ${caseFile.hearingDate || '-'}`,
    `- Judgment date: ${caseFile.judgmentDate || '-'}`,
    `- Appeal deadline: ${caseFile.appealDeadline || '-'}`,
    `- Enforcement deadline: ${caseFile.enforcementDeadline || '-'}`,
    '',
    '## Facts / Notes',
    caseFile.notes || '(No notes)',
    '',
    '## Archived Materials',
    materialLines.length > 0 ? materialLines.join('\n\n') : '(No materials archived yet)',
  ].join('\n');
}

export function addDays(dateValue: string, days: number): string {
  if (!dateValue) return '';
  const date = new Date(`${dateValue}T00:00:00`);
  if (Number.isNaN(date.getTime())) return '';
  date.setDate(date.getDate() + days);
  return date.toISOString().slice(0, 10);
}

export function inferLegalMaterialTitle(content: string, fallback: string): string {
  // i18n-allow: Recognize supplied legal material or voice transcript input; not display copy.
  const caseNumber = content.match(/[（(]\d{4}[）)][^\n，。；;]{2,80}(?:号|字第?\d+号?)/)?.[0];
  if (caseNumber) return `${fallback} ${caseNumber}`;
  const firstLine = content.split(/\r?\n/).map(line => line.trim()).find(Boolean);
  return firstLine ? firstLine.slice(0, 80) : fallback;
}

export function legalCaseToolArgs(caseFile?: LegalCaseFile | null, orgId?: string): Record<string, any> {
  if (!caseFile) return orgId ? { orgId } : {};
  return {
    caseId: caseFile.id,
    caseName: legalCaseTitle(caseFile),
    caseType: caseFile.cause || undefined,
    court: caseFile.court || undefined,
    parties: caseFile.party || undefined,
    stage: caseFile.stage || undefined,
    orgId,
    persistCase: true,
  };
}

export function legalCaseDraftContext(caseFile?: LegalCaseFile | null): string {
  if (!caseFile) return '';
  return [
    caseFile.title && CHINA_LEGAL_WORKSPACE_COPY.caseTitle(caseFile.title),
    caseFile.caseNumber && CHINA_LEGAL_WORKSPACE_COPY.caseNumber(caseFile.caseNumber),
    caseFile.party && CHINA_LEGAL_WORKSPACE_COPY.party(caseFile.party),
    caseFile.cause && CHINA_LEGAL_WORKSPACE_COPY.cause(caseFile.cause),
    caseFile.court && CHINA_LEGAL_WORKSPACE_COPY.court(caseFile.court),
    caseFile.judge && CHINA_LEGAL_WORKSPACE_COPY.judge(caseFile.judge),
    caseFile.notes && CHINA_LEGAL_WORKSPACE_COPY.facts(caseFile.notes),
    ...(caseFile.materials || []).slice(0, 6).map(material => CHINA_LEGAL_WORKSPACE_COPY.material(material.title, material.content || '')),
  ].filter(Boolean).join('\n\n');
}
