// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createEmptyLegalCase, deletePersonalLegalCaseFromRuntime, getActiveLegalCaseId, LEGAL_CASES_STORAGE, LEGAL_CASES_CHANGED_EVENT, mergePersonalLegalCaseRuntimeSnapshot, readLegalCaseFiles, refreshPersonalLegalCasesFromRuntime, setLegalCaseAccount, syncPersonalLegalCaseToRuntime, updateLegalCase, writeLegalCaseFiles } from '../src/lib/legalCaseStore';
let serial = 0;
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
function fixture(id = 'case-a') { return { ...createEmptyLegalCase(), id, title: 'Backend case', notes: 'Complete notes tail', updatedAt: '2026-10-01T00:00:00.000Z', materials: [{ id: 'material-a', type: 'note' as const, title: 'Original', createdAt: '2026-10-01T00:00:00.000Z', content: 'Original body '.repeat(1000) + ' FULL TAIL' }] }; }
function deferred() { let resolve!: (value: Response) => void; const promise = new Promise<Response>(r => { resolve = r; }); return { promise, resolve }; }
beforeEach(() => { localStorage.clear(); localStorage.setItem('lumi_work_domain', 'personal'); setLegalCaseAccount('hydration-owner-' + ++serial); });
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });
describe('shared backend personal case hydration', () => {
  it('shows complete backend cases from an empty cache without a write request or choosing an active case', async () => {
    const file = fixture(), fetcher = vi.fn().mockResolvedValue(response({ cases: [file], removedCaseIds: [] })); vi.stubGlobal('fetch', fetcher);
    const loaded = await refreshPersonalLegalCasesFromRuntime();
    expect(loaded[0].materials[0].content).toBe(file.materials[0].content); expect(loaded[0].notes).toBe(file.notes);
    expect(getActiveLegalCaseId()).toBe(''); expect(fetcher).toHaveBeenCalledTimes(1); expect(fetcher.mock.calls[0][1].method).toBeUndefined();
  });
  it('retains newer local edits and an unsynced local case while restoring missing backend cases', async () => {
    const local = { ...fixture(), title: 'New local title', updatedAt: '2026-10-03T00:00:00.000Z' }, unsynced = fixture('not-yet-uploaded');
    writeLegalCaseFiles([local, unsynced]); vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response({ cases: [fixture(), fixture('backend-only')], removedCaseIds: [] })));
    const loaded = await refreshPersonalLegalCasesFromRuntime();
    expect(loaded.find(x => x.id === local.id)!.title).toBe('New local title'); expect(loaded.map(x => x.id).sort()).toEqual(['backend-only', 'case-a', 'not-yet-uploaded']);
  });
  it('preserves edits made after GET began', async () => {
    writeLegalCaseFiles([fixture()]); const pending = deferred(); vi.stubGlobal('fetch', vi.fn().mockReturnValue(pending.promise));
    const reading = refreshPersonalLegalCasesFromRuntime(); updateLegalCase('case-a', { title: 'Edited during network request' });
    pending.resolve(response({ cases: [fixture()], removedCaseIds: [] })); await reading;
    expect(readLegalCaseFiles()[0].title).toBe('Edited during network request');
  });
  it.each(['account', 'work-domain', 'cancel'])('discards a stale response after %s changes', async mode => {
    const pending = deferred(); vi.stubGlobal('fetch', vi.fn().mockReturnValue(pending.promise)); const controller = new AbortController();
    const reading = refreshPersonalLegalCasesFromRuntime(controller.signal); const rejected = expect(reading).rejects.toMatchObject({ name: 'AbortError' });
    if (mode === 'account') setLegalCaseAccount('different-owner-' + serial);
    if (mode === 'work-domain') { localStorage.setItem('lumi_work_domain', 'work'); localStorage.setItem('lumi_org_connection', JSON.stringify({ orgId: 'org-a' })); }
    if (mode === 'cancel') controller.abort();
    pending.resolve(response({ cases: [fixture()], removedCaseIds: [] })); await rejected;
    expect(readLegalCaseFiles()).toEqual([]); expect([...Array(localStorage.length)].map((_, i) => localStorage.key(i)).filter(x => x?.startsWith(LEGAL_CASES_STORAGE))).toEqual([]);
  });
  it('removes a backend-deleted case and refuses a delayed snapshot without reviving it', async () => {
    const deleted = fixture(); writeLegalCaseFiles([deleted]); vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response({ cases: [], removedCaseIds: [deleted.id] })));
    await refreshPersonalLegalCasesFromRuntime(); expect(readLegalCaseFiles()).toEqual([]);
    expect(mergePersonalLegalCaseRuntimeSnapshot({ ...deleted, updatedAt: '2099-01-01T00:00:00.000Z' })).toBeNull(); expect(readLegalCaseFiles()).toEqual([]);
  });
  it('keeps material tombstones when another client sends an old material with a newer header', async () => {
    const file = fixture(); writeLegalCaseFiles([{ ...file, materials: [], removedMaterialIds: ['material-a'] }]);
    mergePersonalLegalCaseRuntimeSnapshot({ ...file, updatedAt: '2026-10-04T00:00:00.000Z' });
    expect(readLegalCaseFiles()[0].materials).toEqual([]); expect(readLegalCaseFiles()[0].removedMaterialIds).toContain('material-a');
  });
  it('does not rewrite unchanged snapshots or emit another cache change', async () => {
    const file = fixture(); mergePersonalLegalCaseRuntimeSnapshot(file); const event = vi.fn(); window.addEventListener(LEGAL_CASES_CHANGED_EVENT, event);
    try { vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response({ cases: [file], removedCaseIds: [] }))); await refreshPersonalLegalCasesFromRuntime(); expect(event).not.toHaveBeenCalled(); } finally { window.removeEventListener(LEGAL_CASES_CHANGED_EVENT, event); }
  });
  it('waits for an actual deletion receipt and then blocks a delayed upload', async () => {
    const file = fixture(); writeLegalCaseFiles([file]); const pending = deferred(); const fetcher = vi.fn().mockReturnValue(pending.promise); vi.stubGlobal('fetch', fetcher);
    const deleting = deletePersonalLegalCaseFromRuntime(file.id); expect(readLegalCaseFiles()).toHaveLength(1);
    pending.resolve(response({ caseId: file.id, tombstoned: true, deleted: true })); await deleting; expect(readLegalCaseFiles()).toEqual([]);
    await syncPersonalLegalCaseToRuntime(file); expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('does not erase local data when the backend rejects deletion', async () => {
    const file = fixture(); writeLegalCaseFiles([file]); vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response({ error: 'Owner denied' }, 403)));
    await expect(deletePersonalLegalCaseFromRuntime(file.id)).rejects.toThrow('Owner denied'); expect(readLegalCaseFiles()).toHaveLength(1);
  });
});
