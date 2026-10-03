// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ACTIVE_LEGAL_CASE_STORAGE,
  LEGAL_CASES_STORAGE,
  LEGAL_CASES_CHANGED_EVENT,
  addLegalCaseMaterial,
  archiveLegalMeetingToConsultationCase,
  setLegalCaseAccount,
  hasLegacyLegalCases,
  importLegacyLegalCases,
  clearLegalConsultationCaseId,
  createEmptyLegalCase,
  getActiveLegalCaseId,
  getLegalConsultationCaseId,
  readLegalCaseFiles,
  setActiveLegalCaseId,
  setLegalConsultationCaseId,
  writeLegalCaseFiles,
} from '../src/lib/legalCaseStore';

const storage = localStorage;

function usePersonalDomain() {
  storage.setItem('lumi_work_domain', 'personal');
  storage.removeItem('lumi_org_connection');
}

function useOrganization(orgId: string) {
  storage.setItem('lumi_work_domain', 'work');
  storage.setItem('lumi_org_connection', JSON.stringify({ orgId, connected: true }));
}

beforeEach(() => {
  storage.clear();
  setLegalCaseAccount('account-a');
});

afterEach(() => vi.restoreAllMocks());

describe('legal case client scope', () => {
  it('does not expose or overwrite the personal case database in work domain', () => {
    usePersonalDomain();
    const personalCase = { ...createEmptyLegalCase(), id: 'personal-case', title: 'Personal case' };
    writeLegalCaseFiles([personalCase], personalCase.id);
    expect(readLegalCaseFiles().map(item => item.id)).toEqual(['personal-case']);

    useOrganization('org-a');
    expect(readLegalCaseFiles()).toEqual([]);
    writeLegalCaseFiles([{ ...personalCase, id: 'must-not-write' }], 'must-not-write');

    usePersonalDomain();
    expect(readLegalCaseFiles().map(item => item.id)).toEqual(['personal-case']);
    expect(storage.getItem(`${LEGAL_CASES_STORAGE}:user:account-a`)).toContain('personal-case');
  });

  it('keeps active and consultation case choices separate per organization', () => {
    usePersonalDomain();
    setActiveLegalCaseId('personal-active');
    setLegalConsultationCaseId('personal-consultation');

    useOrganization('org-a');
    expect(getActiveLegalCaseId()).toBe('');
    expect(getLegalConsultationCaseId()).toBe('');
    setActiveLegalCaseId('org-a-active');
    setLegalConsultationCaseId('org-a-consultation');

    useOrganization('org-b');
    expect(getActiveLegalCaseId()).toBe('');
    expect(getLegalConsultationCaseId()).toBe('');
    setLegalConsultationCaseId('org-b-consultation');
    clearLegalConsultationCaseId();

    useOrganization('org-a');
    expect(getActiveLegalCaseId()).toBe('org-a-active');
    expect(getLegalConsultationCaseId()).toBe('org-a-consultation');

    usePersonalDomain();
    expect(getActiveLegalCaseId()).toBe('personal-active');
    expect(getLegalConsultationCaseId()).toBe('personal-consultation');
    expect(storage.getItem(`${ACTIVE_LEGAL_CASE_STORAGE}:user:account-a`)).toBe('personal-active');
  });

  it('clears a stale active case when the personal case list becomes empty', () => {
    usePersonalDomain();
    const caseFile = { ...createEmptyLegalCase(), id: 'case-to-delete', title: 'Delete me' };
    writeLegalCaseFiles([caseFile], caseFile.id);
    expect(getActiveLegalCaseId()).toBe(caseFile.id);

    writeLegalCaseFiles([], '');

    expect(readLegalCaseFiles()).toEqual([]);
    expect(getActiveLegalCaseId()).toBe('');
    expect(storage.getItem(`${ACTIVE_LEGAL_CASE_STORAGE}:user:account-a`)).toBeNull();
  });

  it('isolates personal data and organization selections by authenticated account, including logout', () => {
    usePersonalDomain(); const file = { ...createEmptyLegalCase(), id: 'same-id', title: 'Account A private' }; writeLegalCaseFiles([file], file.id); setLegalConsultationCaseId(file.id);
    useOrganization('org-a'); setActiveLegalCaseId('A org'); setLegalConsultationCaseId('A meeting'); setLegalCaseAccount('account-b'); expect(getActiveLegalCaseId()).toBe(''); expect(getLegalConsultationCaseId()).toBe('');
    usePersonalDomain(); expect(readLegalCaseFiles()).toEqual([]); writeLegalCaseFiles([{ ...file, title: 'Account B private' }], file.id); setLegalConsultationCaseId('B meeting');
    setLegalCaseAccount(); expect(readLegalCaseFiles()).toEqual([]); expect(getActiveLegalCaseId()).toBe(''); expect(getLegalConsultationCaseId()).toBe(''); expect(() => writeLegalCaseFiles([])).toThrow('Sign in');
    setLegalCaseAccount('account-a'); expect(readLegalCaseFiles()[0].title).toBe('Account A private'); expect(getActiveLegalCaseId()).toBe('same-id'); expect(getLegalConsultationCaseId()).toBe('same-id'); useOrganization('org-a'); expect(getActiveLegalCaseId()).toBe('A org'); expect(getLegalConsultationCaseId()).toBe('A meeting');
    setLegalCaseAccount('account-b'); usePersonalDomain(); expect(readLegalCaseFiles()[0].title).toBe('Account B private'); expect(getLegalConsultationCaseId()).toBe('B meeting');
  });

  it('keeps unowned archives hidden and imports only by explicit claim without overwriting existing case IDs', () => {
    usePersonalDomain(); const file = { ...createEmptyLegalCase(), id: 'shared-id', title: 'Old case' }, raw = JSON.stringify([file]); storage.setItem(LEGAL_CASES_STORAGE, raw); storage.setItem(ACTIVE_LEGAL_CASE_STORAGE, file.id);
    expect(readLegalCaseFiles()).toEqual([]); expect(getActiveLegalCaseId()).toBe(''); expect(hasLegacyLegalCases()).toBe(true); setLegalCaseAccount('account-b'); expect(readLegalCaseFiles()).toEqual([]);
    writeLegalCaseFiles([{ ...file, title: 'New case' }], file.id); expect(importLegacyLegalCases()).toBe(true); expect(readLegalCaseFiles().map(item => [item.id, item.title])).toEqual([['shared-id', 'New case'], ['legacy:shared-id', 'Old case']]); expect(getActiveLegalCaseId()).toBe('shared-id'); expect(hasLegacyLegalCases()).toBe(false); expect(importLegacyLegalCases()).toBe(false); expect(storage.getItem(LEGAL_CASES_STORAGE)).toBe(raw);
    setLegalCaseAccount('account-a'); expect(hasLegacyLegalCases()).toBe(false); expect(importLegacyLegalCases()).toBe(false); expect(readLegalCaseFiles()).toEqual([]);
  });

  it('retains a failed legacy copy for its claimant and retries without duplicate cases', () => {
    usePersonalDomain(); storage.setItem(LEGAL_CASES_STORAGE, JSON.stringify([{ ...createEmptyLegalCase(), id: 'old' }])); const original = storage.setItem.bind(storage); const failing = vi.spyOn(Storage.prototype, 'setItem').mockImplementation((key, value) => { if (key.endsWith(':legacy-imported')) throw new Error('disk full'); original(key, value); });
    expect(() => importLegacyLegalCases()).toThrow('disk full'); expect(readLegalCaseFiles()).toHaveLength(1); setLegalCaseAccount('account-b'); expect(hasLegacyLegalCases()).toBe(false); failing.mockRestore(); setLegalCaseAccount('account-a'); expect(importLegacyLegalCases()).toBe(true); expect(readLegalCaseFiles()).toHaveLength(1);
  });

  it.each(['material', 'meeting', 'transcript only'])('saves %s in one case-list write and publishes a complete case', kind => {
    const file = { ...createEmptyLegalCase(), title: 'Synthetic case', notes: 'Existing notes', stage: 'trial' as const };
    const other = { ...createEmptyLegalCase(), id: 'unrelated' };
    writeLegalCaseFiles([file, other], other.id);
    const original = addLegalCaseMaterial(file.id, { type: 'note', title: 'Original', id: 'retained', createdAt: '2026-01-01T00:00:00Z' });
    setLegalConsultationCaseId(file.id);
    const reads = vi.spyOn(Storage.prototype, 'getItem'), writes = vi.spyOn(Storage.prototype, 'setItem'), events = vi.spyOn(window, 'dispatchEvent');
    const material = kind === 'material'
      ? addLegalCaseMaterial(file.id, { type: 'evidence', title: 'New evidence' })
      : archiveLegalMeetingToConsultationCase({ report: kind === 'meeting' ? 'Agreed next steps' : '', notes: [{ text: 'Witness statement', time: 1000 }, { text: '  ', time: 0 }], startedAt: null, endedAt: 2000 })?.material;
    const key = `${LEGAL_CASES_STORAGE}:user:account-a`;
    expect(reads.mock.calls.filter(([name]) => name === key)).toHaveLength(2);
    expect(writes.mock.calls.filter(([name]) => name === key)).toHaveLength(1);
    const saved = readLegalCaseFiles()[0];
    expect(saved.materials).toEqual([material, original]); expect(saved.stage).toBe('trial'); expect(readLegalCaseFiles()[1]).toEqual(other);
    expect(events.mock.calls.filter(([event]) => event.type === LEGAL_CASES_CHANGED_EVENT).map(([event]) => (event as CustomEvent).detail.cases[0])).toEqual([saved]);
    expect(getActiveLegalCaseId()).toBe(file.id); expect(getLegalConsultationCaseId()).toBe(kind === 'material' ? file.id : '');
    expect(saved.notes).toContain('Existing notes');
    if (kind !== 'material') {
      expect(material?.content).toContain('Synthetic case'); expect(material?.content).toContain('Witness statement');
      expect(saved.notes).toContain(kind === 'meeting' ? 'Agreed next steps' : 'Witness statement');
    }
  });

  it('keeps a rejected meeting save unchanged and available for retry', () => {
    const file = { ...createEmptyLegalCase(), notes: 'Before archive' };
    writeLegalCaseFiles([file], file.id); setLegalConsultationCaseId(file.id);
    const input = { report: 'Meeting result', notes: [], startedAt: 1000, endedAt: 2000 };
    const failing = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('Quota exceeded'); });
    expect(() => archiveLegalMeetingToConsultationCase(input)).toThrow('Quota exceeded');
    expect(readLegalCaseFiles()).toEqual([file]); expect(getLegalConsultationCaseId()).toBe(file.id);
    failing.mockRestore();
    const archived = archiveLegalMeetingToConsultationCase(input);
    expect(archived?.caseFile).toEqual(readLegalCaseFiles()[0]); expect(archived?.caseFile.materials).toHaveLength(1);
    expect(archived?.caseFile.notes).toContain('Meeting result'); expect(getLegalConsultationCaseId()).toBe('');
    expect(archiveLegalMeetingToConsultationCase(input)).toBeNull();
  });

  it.each(['missing', 'work', 'other account', 'logout'])('does not archive into an unavailable %s case', scope => {
    const file = createEmptyLegalCase(); writeLegalCaseFiles([file], file.id); setLegalConsultationCaseId(file.id);
    if (scope === 'missing') writeLegalCaseFiles([], '');
    if (scope === 'work') useOrganization('org-a');
    if (scope === 'other account') setLegalCaseAccount('account-b');
    if (scope === 'logout') setLegalCaseAccount();
    const writes = vi.spyOn(Storage.prototype, 'setItem');
    expect(archiveLegalMeetingToConsultationCase({ report: 'Private', notes: [], startedAt: null, endedAt: 2000 })).toBeNull();
    expect(addLegalCaseMaterial(file.id, { type: 'note', title: 'Private' })).toBeNull(); expect(writes).not.toHaveBeenCalled();
  });
});
