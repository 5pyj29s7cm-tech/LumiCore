import { expect, it, vi } from 'vitest';
import { extractSourceExpression } from './source_expression';
function deferred() { let resolve!: (value: any) => void; const promise = new Promise<any>(done => { resolve = done; }); return { promise, resolve }; }
function harness() {
  const storage = new Map<string, string>();
  const deps = { AbortSignal, AbortController, Error, authGenerationRef: { current: 0 }, domainSwitchRequest: { current: null as AbortController | null },
    orgConnection: { orgId: 'old-org', orgName: 'Old', orgRole: 'member', connected: true }, translate: (key: string) => key,
    apiJson: vi.fn(async (_url: string, init: any) => ({ success: true, orgId: JSON.parse(init.body).orgId, orgRole: JSON.parse(init.body).orgId ? 'member' : null, token: 'synthetic-token' })),
    localStorage: { setItem: (key: string, value: string) => storage.set(key, value) }, socketService: { refreshAuth: vi.fn() },
    setOrgConnection: vi.fn(), setWorkDomain: vi.fn(), window: { dispatchEvent: vi.fn() }, CustomEvent: class { constructor(readonly type: string, readonly init: any) {} } };
  return { ...deps, storage, switchDomain: extractSourceExpression('src/contexts/AppContext.tsx', 'switchDomain', deps) };
}

it('uses the joined organization, and never trusts a caller-provided role', async () => {
  const h = harness(); expect((await h.switchDomain('work', { orgId: 'joined-org', orgName: 'Joined' })).success).toBe(true);
  expect(JSON.parse(h.apiJson.mock.calls[0][1].body)).toEqual({ orgId: 'joined-org' });
  expect(h.setOrgConnection).toHaveBeenCalledWith({ orgId: 'joined-org', orgName: 'Joined', orgRole: 'member', connected: true });
  expect(h.storage.get('lumi_auth_token')).toBe('synthetic-token'); expect(h.socketService.refreshAuth).toHaveBeenCalledOnce();
});

it.each(['account', 'caller'] as const)('drops an obsolete switch response after %s cancellation', async mode => {
  const h = harness(), pending = deferred(), controller = new AbortController(); h.apiJson.mockReturnValueOnce(pending.promise);
  const first = h.switchDomain('work', { signal: controller.signal });
  if (mode === 'account') h.authGenerationRef.current++; else controller.abort();
  pending.resolve({ success: true, orgId: 'old-org', orgRole: 'owner', token: 'obsolete' }); expect((await first).success).toBe(false);
  expect(h.storage.size).toBe(0); expect(h.setWorkDomain).not.toHaveBeenCalled(); expect(h.window.dispatchEvent).not.toHaveBeenCalled();
});

it('serializes switches and accepts an explicit retry after an invalid receipt', async () => {
  const h = harness(), pending = deferred(); h.apiJson.mockReturnValueOnce(pending.promise);
  const first = h.switchDomain('work'); expect((await h.switchDomain('personal')).success).toBe(false); expect(h.apiJson).toHaveBeenCalledOnce();
  pending.resolve({ success: true, orgId: 'wrong-org', orgRole: 'member', token: 'wrong' }); expect((await first).success).toBe(false); expect(h.storage.size).toBe(0);
  expect((await h.switchDomain('personal')).success).toBe(true); expect(h.setWorkDomain).toHaveBeenCalledWith('personal'); expect(h.apiJson).toHaveBeenCalledTimes(2);
});

it.each([{ success: true, orgId: 'old-org', orgRole: 'member' }, { success: true, orgId: 'old-org', orgRole: 'invalid', token: 'bad' }])('rejects incomplete or invalid authentication receipts', async receipt => {
  const h = harness(); h.apiJson.mockResolvedValueOnce(receipt as any); expect((await h.switchDomain('work')).success).toBe(false); expect(h.storage.size).toBe(0);
});
