import { getLocale } from '../i18n/runtime';
import { chinaLegalCopy } from '../i18n/regions/cn/legal';

export type LegalCaseStage = 'consultation' | 'filing' | 'trial' | 'judgment' | 'enforcement' | 'closed';

export type LegalCaseMaterialType = 'consultation' | 'evidence' | 'pleading' | 'judgment' | 'contract' | 'note';

export interface LegalCaseMaterial {
  id: string;
  type: LegalCaseMaterialType;
  title: string;
  createdAt: string;
  content?: string;
  source?: 'manual' | 'meeting' | 'notice' | 'tool' | 'import' | 'feishu';
}

export interface LegalCaseFile {
  id: string;
  title: string;
  caseNumber: string;
  party: string;
  cause: string;
  court: string;
  judge: string;
  stage: LegalCaseStage;
  hearingDate: string;
  judgmentDate: string;
  appealDeadline: string;
  enforcementDeadline: string;
  notes: string;
  materials: LegalCaseMaterial[];
  createdAt: string;
  updatedAt: string;
}

export interface MeetingNoteLike {
  id?: string;
  text: string;
  time: number;
}

export const LEGAL_CASES_STORAGE = 'lumi_legal_cases_v1';
export const ACTIVE_LEGAL_CASE_STORAGE = 'lumi_legal_active_case_v1';
export const LEGAL_CONSULTATION_CASE_STORAGE = 'lumi_legal_consultation_case_v1';
export const LEGAL_CASES_CHANGED_EVENT = 'lumi:legal-cases-changed';

function canUseStorage() {
  return typeof window !== 'undefined' && typeof window.localStorage !== 'undefined';
}

function currentLegalStorageScope(): { domain: 'personal' | 'work'; orgId: string } {
  if (!canUseStorage()) return { domain: 'personal', orgId: '' };
  try {
    if (localStorage.getItem('lumi_work_domain') !== 'work') return { domain: 'personal', orgId: '' };
    const orgId = String(JSON.parse(localStorage.getItem('lumi_org_connection') || 'null')?.orgId || '').trim();
    return orgId ? { domain: 'work', orgId } : { domain: 'work', orgId: 'pending' };
  } catch {
    return { domain: 'personal', orgId: '' };
  }
}

function scopedLegalStateKey(base: string): string {
  const scope = currentLegalStorageScope();
  return scope.domain === 'work' ? `${base}:org:${encodeURIComponent(scope.orgId)}` : base;
}

function newId(prefix: string) {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
}

export function createEmptyLegalCase(): LegalCaseFile {
  const now = new Date().toISOString();
  return {
    id: newId('case'),
    title: '',
    caseNumber: '',
    party: '',
    cause: '',
    court: '',
    judge: '',
    stage: 'consultation',
    hearingDate: '',
    judgmentDate: '',
    appealDeadline: '',
    enforcementDeadline: '',
    notes: '',
    materials: [],
    createdAt: now,
    updatedAt: now,
  };
}

function normalizeCaseFile(value: any): LegalCaseFile | null {
  if (!value || typeof value !== 'object' || !value.id) return null;
  return {
    id: String(value.id),
    title: String(value.title || ''),
    caseNumber: String(value.caseNumber || ''),
    party: String(value.party || ''),
    cause: String(value.cause || ''),
    court: String(value.court || ''),
    judge: String(value.judge || ''),
    stage: (['consultation', 'filing', 'trial', 'judgment', 'enforcement', 'closed'].includes(value.stage) ? value.stage : 'consultation') as LegalCaseStage,
    hearingDate: String(value.hearingDate || ''),
    judgmentDate: String(value.judgmentDate || ''),
    appealDeadline: String(value.appealDeadline || ''),
    enforcementDeadline: String(value.enforcementDeadline || ''),
    notes: String(value.notes || ''),
    materials: Array.isArray(value.materials) ? value.materials.map((item: any) => ({
      id: String(item?.id || newId('mat')),
      type: (['consultation', 'evidence', 'pleading', 'judgment', 'contract', 'note'].includes(item?.type) ? item.type : 'note') as LegalCaseMaterialType,
      title: String(item?.title || chinaLegalCopy().material),
      createdAt: String(item?.createdAt || new Date().toISOString()),
      content: item?.content ? String(item.content) : undefined,
      source: item?.source,
    })) : [],
    createdAt: String(value.createdAt || new Date().toISOString()),
    updatedAt: String(value.updatedAt || value.createdAt || new Date().toISOString()),
  };
}

export function readLegalCaseFiles(): LegalCaseFile[] {
  if (!canUseStorage()) return [];
  if (currentLegalStorageScope().domain === 'work') return [];
  try {
    const parsed = JSON.parse(localStorage.getItem(LEGAL_CASES_STORAGE) || '[]');
    if (!Array.isArray(parsed)) return [];
    return parsed.map(normalizeCaseFile).filter(Boolean) as LegalCaseFile[];
  } catch {
    return [];
  }
}

export function getActiveLegalCaseId(): string {
  if (!canUseStorage()) return '';
  return localStorage.getItem(scopedLegalStateKey(ACTIVE_LEGAL_CASE_STORAGE)) || '';
}

export function getLegalConsultationCaseId(): string {
  if (!canUseStorage()) return '';
  return localStorage.getItem(scopedLegalStateKey(LEGAL_CONSULTATION_CASE_STORAGE)) || '';
}

export function setActiveLegalCaseId(caseId: string) {
  if (!canUseStorage()) return;
  const key = scopedLegalStateKey(ACTIVE_LEGAL_CASE_STORAGE);
  if (caseId) localStorage.setItem(key, caseId);
  else localStorage.removeItem(key);
  emitLegalCasesChanged();
}

export function setLegalConsultationCaseId(caseId: string) {
  if (!canUseStorage()) return;
  const key = scopedLegalStateKey(LEGAL_CONSULTATION_CASE_STORAGE);
  if (caseId) localStorage.setItem(key, caseId);
  else localStorage.removeItem(key);
}

export function clearLegalConsultationCaseId() {
  if (!canUseStorage()) return;
  localStorage.removeItem(scopedLegalStateKey(LEGAL_CONSULTATION_CASE_STORAGE));
}

export function writeLegalCaseFiles(cases: LegalCaseFile[], activeCaseId?: string) {
  if (!canUseStorage()) return;
  if (currentLegalStorageScope().domain === 'work') return;
  localStorage.setItem(LEGAL_CASES_STORAGE, JSON.stringify(cases));
  if (typeof activeCaseId === 'string') {
    if (activeCaseId) localStorage.setItem(ACTIVE_LEGAL_CASE_STORAGE, activeCaseId);
    else localStorage.removeItem(ACTIVE_LEGAL_CASE_STORAGE);
  }
  emitLegalCasesChanged();
}

export function getLegalCaseById(caseId: string): LegalCaseFile | null {
  if (!caseId) return null;
  return readLegalCaseFiles().find(item => item.id === caseId) || null;
}

export function updateLegalCase(caseId: string, patch: Partial<LegalCaseFile>): LegalCaseFile | null {
  const cases = readLegalCaseFiles();
  let updated: LegalCaseFile | null = null;
  const next = cases.map(item => {
    if (item.id !== caseId) return item;
    updated = { ...item, ...patch, updatedAt: new Date().toISOString() };
    return updated;
  });
  if (!updated) return null;
  writeLegalCaseFiles(next, caseId);
  return updated;
}

export function addLegalCaseMaterial(
  caseId: string,
  material: Omit<LegalCaseMaterial, 'id' | 'createdAt'> & Partial<Pick<LegalCaseMaterial, 'id' | 'createdAt'>>,
): LegalCaseMaterial | null {
  const current = getLegalCaseById(caseId);
  if (!current) return null;
  const nextMaterial: LegalCaseMaterial = {
    id: material.id || newId('mat'),
    type: material.type,
    title: material.title,
    createdAt: material.createdAt || new Date().toISOString(),
    content: material.content,
    source: material.source || 'manual',
  };
  updateLegalCase(caseId, { materials: [nextMaterial, ...(current.materials || [])] });
  return nextMaterial;
}

export function getLegalCaseLabel(caseFile: LegalCaseFile | null): string {
  if (!caseFile) return '';
  return caseFile.title || caseFile.party || caseFile.caseNumber || chinaLegalCopy().unnamedCase;
}

export function getActiveLegalCase(): LegalCaseFile | null {
  const cases = readLegalCaseFiles();
  const activeId = getActiveLegalCaseId();
  return cases.find(item => item.id === activeId) || cases[0] || null;
}

export function getLegalConsultationCase(): LegalCaseFile | null {
  const consultationId = getLegalConsultationCaseId();
  return consultationId ? getLegalCaseById(consultationId) : null;
}

export function archiveLegalMeetingToConsultationCase({
  report,
  notes,
  startedAt,
  endedAt,
}: {
  report: string;
  notes: MeetingNoteLike[];
  startedAt: number | null;
  endedAt: number;
}): { caseFile: LegalCaseFile; material: LegalCaseMaterial } | null {
  const caseId = getLegalConsultationCaseId();
  const caseFile = caseId ? getLegalCaseById(caseId) : null;
  if (!caseFile) return null;

  const started = startedAt ? new Date(startedAt) : new Date(endedAt);
  const ended = new Date(endedAt);
  const locale = getLocale();
  const localeTag = locale === 'zh' ? 'zh-CN' : 'en-US';
  const copy = chinaLegalCopy(locale);
  const transcript = notes
    .map(note => {
      const time = note.time ? new Date(note.time).toLocaleTimeString(localeTag) : '';
      const text = String(note.text || '').trim();
      return text ? `- [${time}] ${text}` : '';
    })
    .filter(Boolean)
    .join('\n');

  const title = `${copy.meeting.title} ${started.toLocaleString(localeTag)}`;
  const content = [
    `# ${title}`,
    '',
    `${copy.meeting.case}: ${getLegalCaseLabel(caseFile)}`,
    `${copy.meeting.started}: ${started.toLocaleString(localeTag)}`,
    `${copy.meeting.ended}: ${ended.toLocaleString(localeTag)}`,
    '',
    `## ${copy.meeting.summary}`,
    '',
    report || copy.meeting.noSummary,
    '',
    `## ${copy.meeting.transcript}`,
    '',
    transcript || copy.meeting.noTranscript,
    '',
    `## ${copy.meeting.boundary}`,
    '',
    copy.meeting.boundaryText,
  ].join('\n');

  const material = addLegalCaseMaterial(caseFile.id, {
    type: 'consultation',
    title,
    content,
    source: 'meeting',
  });
  if (!material) return null;

  const updatedCase = getLegalCaseById(caseFile.id) || caseFile;
  const nextNotes = [
    updatedCase.notes,
    '',
    `【会谈归档 ${ended.toLocaleString()}】`,
    report || transcript,
  ].filter(Boolean).join('\n').trim();
  updateLegalCase(caseFile.id, {
    notes: nextNotes,
    stage: updatedCase.stage === 'consultation' ? 'consultation' : updatedCase.stage,
  });
  clearLegalConsultationCaseId();

  const finalCase = getLegalCaseById(caseFile.id) || updatedCase;
  return { caseFile: finalCase, material };
}

export function emitLegalCasesChanged() {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent(LEGAL_CASES_CHANGED_EVENT, {
    detail: {
      cases: readLegalCaseFiles(),
      activeCaseId: getActiveLegalCaseId(),
      consultationCaseId: getLegalConsultationCaseId(),
    },
  }));
}
