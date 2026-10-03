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
let legalAccountId = '';
export const isLegalCaseAccount = (uid?: string) => Boolean(uid) && uid === legalAccountId;

export function setLegalCaseAccount(uid?: string) {
  const next = String(uid || '').trim();
  if (legalAccountId === next) return;
  legalAccountId = next;
  emitLegalCasesChanged();
}

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
    return { domain: 'work', orgId: 'pending' };
  }
}

function scopedLegalStateKey(base: string): string {
  if (!legalAccountId) return '';
  const scope = currentLegalStorageScope();
  const key = `${base}:user:${encodeURIComponent(legalAccountId)}`;
  return scope.domain === 'work' ? `${key}:org:${encodeURIComponent(scope.orgId)}` : key;
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
  if (!canUseStorage() || !legalAccountId) return [];
  if (currentLegalStorageScope().domain === 'work') return [];
  try {
    const parsed = JSON.parse(localStorage.getItem(scopedLegalStateKey(LEGAL_CASES_STORAGE)) || '[]');
    if (!Array.isArray(parsed)) return [];
    return parsed.map(normalizeCaseFile).filter(Boolean) as LegalCaseFile[];
  } catch {
    return [];
  }
}

function readLegalCaseChoice(base: string): string {
  if (!canUseStorage() || !legalAccountId) return '';
  return localStorage.getItem(scopedLegalStateKey(base)) || '';
}

function writeLegalCaseChoice(base: string, caseId: string) {
  if (!canUseStorage() || !legalAccountId) return;
  const key = scopedLegalStateKey(base);
  if (caseId) localStorage.setItem(key, caseId);
  else localStorage.removeItem(key);
}

export function getActiveLegalCaseId(): string {
  return readLegalCaseChoice(ACTIVE_LEGAL_CASE_STORAGE);
}

export function getLegalConsultationCaseId(): string {
  return readLegalCaseChoice(LEGAL_CONSULTATION_CASE_STORAGE);
}

export function setActiveLegalCaseId(caseId: string) {
  if (!canUseStorage() || !legalAccountId) return;
  writeLegalCaseChoice(ACTIVE_LEGAL_CASE_STORAGE, caseId);
  emitLegalCasesChanged();
}

export function setLegalConsultationCaseId(caseId: string) {
  writeLegalCaseChoice(LEGAL_CONSULTATION_CASE_STORAGE, caseId);
}

export function clearLegalConsultationCaseId() {
  setLegalConsultationCaseId('');
}

export function writeLegalCaseFiles(cases: LegalCaseFile[], activeCaseId?: string) {
  if (!canUseStorage() || !legalAccountId) throw new Error('Sign in before saving personal cases');
  if (currentLegalStorageScope().domain === 'work') return;
  localStorage.setItem(scopedLegalStateKey(LEGAL_CASES_STORAGE), JSON.stringify(cases));
  if (typeof activeCaseId === 'string') writeLegalCaseChoice(ACTIVE_LEGAL_CASE_STORAGE, activeCaseId);
  emitLegalCasesChanged();
}

export function hasLegacyLegalCases(): boolean {
  if (!canUseStorage() || !legalAccountId || currentLegalStorageScope().domain !== 'personal') return false;
  const owner = localStorage.getItem(`${LEGAL_CASES_STORAGE}:owner`);
  return (!owner || owner === legalAccountId) && Boolean(localStorage.getItem(LEGAL_CASES_STORAGE))
    && localStorage.getItem(`${scopedLegalStateKey(LEGAL_CASES_STORAGE)}:legacy-imported`) !== '1';
}

/** Called only after the user confirms ownership; never infer it from first login. */
export function importLegacyLegalCases(): boolean {
  if (!hasLegacyLegalCases()) return false;
  const parsed = JSON.parse(localStorage.getItem(LEGAL_CASES_STORAGE) || '[]');
  if (!Array.isArray(parsed)) throw new Error('Legacy case archive is invalid');
  const legacy = parsed.map(normalizeCaseFile).filter((file): file is LegalCaseFile => Boolean(file))
    .map(file => ({ ...file, id: `legacy:${file.id}` }));
  const current = readLegalCaseFiles(), ids = new Set(current.map(file => file.id));
  // Claim first: a failed copy remains recoverable by this account, not a later login.
  localStorage.setItem(`${LEGAL_CASES_STORAGE}:owner`, legalAccountId);
  const active = getActiveLegalCaseId() || `legacy:${localStorage.getItem(ACTIVE_LEGAL_CASE_STORAGE) || ''}`;
  const merged = [...current, ...legacy.filter(file => !ids.has(file.id))];
  writeLegalCaseFiles(merged, merged.some(file => file.id === active) ? active : merged[0]?.id || '');
  localStorage.setItem(`${scopedLegalStateKey(LEGAL_CASES_STORAGE)}:legacy-imported`, '1');
  emitLegalCasesChanged();
  return true;
}

export function getLegalCaseById(caseId: string): LegalCaseFile | null {
  if (!caseId) return null;
  return readLegalCaseFiles().find(item => item.id === caseId) || null;
}

export function updateLegalCase(caseId: string, patch: Partial<LegalCaseFile> | ((current: LegalCaseFile) => Partial<LegalCaseFile>)): LegalCaseFile | null {
  const cases = readLegalCaseFiles();
  const index = cases.findIndex(item => item.id === caseId);
  if (index < 0) return null;
  const current = cases[index];
  const updated = { ...current, ...(typeof patch === 'function' ? patch(current) : patch), updatedAt: new Date().toISOString() };
  cases[index] = updated;
  writeLegalCaseFiles(cases, caseId);
  return updated;
}

export function addLegalCaseMaterial(
  caseId: string,
  material: Omit<LegalCaseMaterial, 'id' | 'createdAt'> & Partial<Pick<LegalCaseMaterial, 'id' | 'createdAt'>>,
): LegalCaseMaterial | null {
  const nextMaterial: LegalCaseMaterial = {
    id: material.id || newId('mat'),
    type: material.type,
    title: material.title,
    createdAt: material.createdAt || new Date().toISOString(),
    content: material.content,
    source: material.source || 'manual',
  };
  return updateLegalCase(caseId, current => ({ materials: [nextMaterial, ...current.materials] })) ? nextMaterial : null;
}

export function getLegalCaseLabel(caseFile: LegalCaseFile | null): string {
  if (!caseFile) return '';
  return caseFile.title || caseFile.party || caseFile.caseNumber || chinaLegalCopy().unnamedCase;
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
  const finalCase = updateLegalCase(getLegalConsultationCaseId(), caseFile => {
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

    const material: LegalCaseMaterial = {
      id: newId('mat'),
      createdAt: new Date().toISOString(),
      type: 'consultation',
      title,
      content,
      source: 'meeting',
    };

    return {
      materials: [material, ...caseFile.materials],
      notes: [caseFile.notes, `【会谈归档 ${ended.toLocaleString()}】`, report || transcript].filter(Boolean).join('\n').trim(),
    };
  });
  if (!finalCase) return null;
  clearLegalConsultationCaseId();
  return { caseFile: finalCase, material: finalCase.materials[0] };
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
