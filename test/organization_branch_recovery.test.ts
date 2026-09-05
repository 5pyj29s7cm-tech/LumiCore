import './helpers';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { promises as dns } from 'node:dns';
import { initDatabase, readDB, writeDB, flushDBOrThrow } from '../db_layer';
import * as org from '../server/org/db';
import * as branch from '../server/org/branch';
import { persistBranchSyncBatch } from '../server/org/branch_sync';
import { registerOrganizationDevice } from '../server/org/resource_acl';
import { runtimeBackgroundWork } from '../server/runtime/shutdown_work';

let sequence = 0;
let orgId: string;
let userId: string;
let branchId: string;
const queueKey = 'org.branch.client.offline_queue.v2';
function setting(key: string, value?: any) {
  const db = readDB();
  const existing = db.settings.find((item: any) => item.key === key);
  if (arguments.length === 1) return existing ? JSON.parse(existing.value) : undefined;
  if (existing) existing.value = JSON.stringify(value);
  else db.settings.push({ key, value: JSON.stringify(value) });
  writeDB(db);
}
function memory(id: string) {
  return { id, userId, orgId, domain: 'work', type: 'episodic', content: 'Synthetic work record', keywords: [],
    confidence: 0.8, createdAt: '2026-09-05T00:00:00Z', updatedAt: '2026-09-05T00:00:00Z' };
}
function connected() {
  Object.assign(branch.getBranchState(), { branchId, orgId, companyUrl: 'https://company.example',
    connectionToken: 'synthetic-branch-token', status: 'connected', currentDomain: 'work' });
}
function oversizedAction(state: 'blocked' | 'unknown') {
  return { id: 'legacy-oversized', type: 'sync', state, attempts: 1, lastError: 'Branch sync batch exceeds 1000 items',
    queuedAt: '2026-09-05T00:00:00Z', updatedAt: '2026-09-05T00:00:00Z',
    payload: { orgId, branchId, batchId: 'legacy-oversized-batch', memories: Array.from({ length: 1001 }, (_, i) => memory(`local-${i}`)), interactions: [] } };
}
function fakeCompany() {
  const sent: any[] = [];
  vi.mocked(fetch).mockImplementation(async (url, init) => {
    if (String(url).includes('/receipts/')) return new Response('{}', { status: 404 });
    const payload = JSON.parse(String(init?.body));
    sent.push(payload);
    const receipt = await persistBranchSyncBatch({ payload, authenticatedUserId: userId,
      authenticatedOrgId: orgId, authenticatedBranchId: branchId });
    return new Response(JSON.stringify({ receipt }));
  });
  return sent;
}
function gate<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
async function waitFor(check: () => boolean) {
  for (let i = 0; i < 400; i++) {
    if (check()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error('Branch operation did not reach expected checkpoint');
}
beforeAll(() => initDatabase());
beforeEach(() => {
  sequence++;
  branch.disconnectFromOrg();
  readDB().settings = readDB().settings.filter((item: any) => !String(item.key).startsWith('org.branch.client.'));
  readDB().memories = [];
  readDB().interactions = [];
  userId = `branch-recovery-user-${sequence}`;
  branchId = `branch-recovery-device-${sequence}`;
  orgId = org.createOrg('Synthetic', `branch-recovery-org-${sequence}`, userId).id;
  org.addMember(orgId, userId, 'member');
  registerOrganizationDevice({ orgId, userId, branchId });
  vi.spyOn(dns, 'lookup').mockResolvedValue([{ address: '93.184.216.34', family: 4 }] as any);
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('No network permitted')));
});
afterEach(async () => {
  await flushDBOrThrow();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('bounded immutable branch batches', () => {
  it('sends 1001 pending records as two durable uniquely identified batches', async () => {
    connected();
    readDB().memories = Array.from({ length: 1001 }, (_, i) => memory(`new-${i}`));
    writeDB(readDB());
    const sent = fakeCompany();
    expect(await branch.syncWorkData()).toEqual({ synced: 1001, errors: [] });
    expect(sent.map(item => item.memories.length + item.interactions.length)).toEqual([1000, 1]);
    expect(new Set(sent.map(item => item.batchId)).size).toBe(2);
    expect(branch.getOfflineQueueLength()).toBe(0);
  });

  it('recovers an existing explicitly rejected oversized batch without changing its original records', async () => {
    connected();
    const old = oversizedAction('blocked');
    setting(queueKey, [old]);
    const sent = fakeCompany();
    expect(await branch.syncWorkData()).toEqual({ synced: 1001, errors: [] });
    expect(sent.flatMap(item => item.memories)).toEqual(old.payload.memories);
    expect(sent.every(item => item.batchId !== old.payload.batchId)).toBe(true);
    expect(branch.getOfflineQueueLength()).toBe(0);
  });

  it('reconciles but never splits or resends an oversized unknown batch', async () => {
    connected();
    const old = oversizedAction('unknown');
    setting(queueKey, [old]);
    const sent = fakeCompany();
    const result = await branch.syncWorkData();
    expect(result.errors.join(' ')).toContain('unknown');
    expect(sent).toHaveLength(0);
    expect(fetch).toHaveBeenCalledOnce();
    expect(setting(queueKey)).toEqual([old]);
  });

  it('retains an oversized batch blocked for a different reason', async () => {
    connected();
    const old = { ...oversizedAction('blocked'), lastError: 'Permission denied' };
    setting(queueKey, [old]);
    expect((await branch.syncWorkData()).errors).toEqual(['Permission denied']);
    expect(fetch).not.toHaveBeenCalled();
    expect(setting(queueKey)).toEqual([old]);
  });

  it('serializes manual sync with reconnect queue flushing', async () => {
    connected();
    const old = oversizedAction('blocked');
    old.payload.memories = old.payload.memories.slice(0, 1);
    setting(queueKey, [{ ...old, state: 'pending', attempts: 0, lastError: '' }]);
    const sent = fakeCompany();
    const [manual, queued] = await Promise.all([branch.syncWorkData(), branch.flushOfflineQueue()]);
    expect(manual).toEqual({ synced: 1, errors: [] });
    expect(queued).toEqual({ flushed: 1, errors: [] });
    expect(sent).toHaveLength(1);
  });

  it('does not evict existing queued work when new fragments exceed queue capacity', async () => {
    connected();
    const oldQueue = Array.from({ length: 1000 }, (_, i) => ({ id: `old-${i}`, type: 'kb_query', payload: {},
      state: 'pending', attempts: 0, lastError: '', queuedAt: '2026-09-05T00:00:00Z', updatedAt: '2026-09-05T00:00:00Z' }));
    setting(queueKey, oldQueue);
    readDB().memories = [memory('must-not-evict')];
    writeDB(readDB());
    await expect(branch.syncWorkData()).rejects.toThrow('capacity exceeded');
    expect(setting(queueKey)).toEqual(oldQueue);
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('organization connection generations', () => {
  it('keeps the runtime busy until both post-connect KB and queued sync work settle', async () => {
    connected();
    const action = oversizedAction('blocked');
    action.payload.memories = action.payload.memories.slice(0, 1);
    setting(queueKey, [{ ...action, state: 'pending', attempts: 0, lastError: '' }]);
    const knowledge = gate<Response>();
    const upload = gate<Response>();
    vi.mocked(fetch).mockImplementation(async (url, init) => {
      if (String(url).endsWith('/register')) {
        const requested = JSON.parse(String(init?.body));
        return new Response(JSON.stringify({ branchToken: 'synthetic-token', branchId: requested.branchId, org: { id: orgId } }));
      }
      if (String(url).includes('/kb')) return knowledge.promise;
      if (String(url).endsWith('/ingest')) return upload.promise;
      return new Response('{}', { status: 404 });
    });
    expect(await branch.connectToOrg(orgId, 'https://company.example', 'synthetic-personal-token')).toEqual({ success: true });
    await waitFor(() => vi.mocked(fetch).mock.calls.length === 3);
    let idle = false;
    const waiting = runtimeBackgroundWork.waitForIdle().then(() => { idle = true; });
    await Promise.resolve();
    expect(idle).toBe(false);
    knowledge.resolve(new Response(JSON.stringify({ articles: [] })));
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(idle).toBe(false);
    upload.resolve(new Response(JSON.stringify({ error: 'Synthetic retryable failure' }), { status: 500 }));
    await waiting;
    expect(idle).toBe(true);
    expect(branch.getOfflineQueueLength()).toBe(1);
  });

  it('ignores a late registration success after disconnect, including post-connect work', async () => {
    const response = gate<Response>();
    vi.mocked(fetch).mockReturnValue(response.promise);
    const connecting = branch.connectToOrg(orgId, 'https://company.example', 'synthetic-personal-token');
    await waitFor(() => vi.mocked(fetch).mock.calls.length === 1);
    const signal = vi.mocked(fetch).mock.calls[0][1]!.signal!;
    branch.disconnectFromOrg();
    expect(signal.aborted).toBe(true);
    response.resolve(new Response(JSON.stringify({ branchToken: 'synthetic-token', branchId: branch.getBranchState().branchId, org: { id: orgId } })));
    expect((await connecting).success).toBe(false);
    expect(branch.getBranchState()).toMatchObject({ status: 'disconnected', orgId: null, connectionToken: null });
    expect(fetch).toHaveBeenCalledOnce();
  });

  it('keeps a newer successful connection when an older response finishes later', async () => {
    const oldResponse = gate<Response>();
    const newerOrg = `${orgId}-new`;
    vi.mocked(fetch).mockImplementation(async (url, init) => {
      if (!String(url).endsWith('/register')) return new Response(JSON.stringify({ articles: [] }));
      const requested = JSON.parse(String(init?.body));
      if (requested.orgId === orgId) return oldResponse.promise;
      return new Response(JSON.stringify({ branchToken: 'new-scoped-token', branchId: requested.branchId, org: { id: newerOrg } }));
    });
    const older = branch.connectToOrg(orgId, 'https://company.example', 'old-personal-token');
    await waitFor(() => vi.mocked(fetch).mock.calls.length === 1);
    expect(await branch.connectToOrg(newerOrg, 'https://new-company.example', 'new-personal-token')).toEqual({ success: true });
    oldResponse.resolve(new Response(JSON.stringify({ branchToken: 'old-scoped-token', branchId: branch.getBranchState().branchId, org: { id: orgId } })));
    expect((await older).success).toBe(false);
    expect(branch.getBranchState()).toMatchObject({ status: 'connected', orgId: newerOrg, connectionToken: 'new-scoped-token' });
    await branch.flushOfflineQueue();
  });
});
