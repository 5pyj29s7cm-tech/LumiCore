// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
const fixture = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock('../src/services/apiClient', () => ({ apiFetch: (...args: any[]) => fixture.fetch(...args) }));
import { memoryAvatarPortraitService as service } from '../src/services/memoryAvatarPortraitService';
beforeEach(() => fixture.fetch.mockReset());
const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
describe('talking portrait HTTP receipts', () => {
  it.each([{}, { provider: 'did', configured: 'yes', available: false, cloudAllowed: true }, { provider: 'did', configured: false, available: true, cloudAllowed: true }])('rejects malformed configuration instead of claiming it saved', async body => {
    fixture.fetch.mockResolvedValueOnce(response(body));
    await expect(service.saveConfig({ apiKey: 'fixture:key', cloudConsent: true })).rejects.toMatchObject({ code: 'invalid_portrait_response' });
    expect(fixture.fetch).toHaveBeenCalledOnce();
  });
  it.each(['answer', 'ice', 'cancel'] as const)('requires an explicit acknowledgement for %s', async operation => {
    fixture.fetch.mockResolvedValueOnce(response({}));
    const result = operation === 'answer' ? service.answer('person', 'stream', 'call', { type: 'answer', sdp: 'v=0\r\n' })
      : operation === 'ice' ? service.ice('person', 'stream', 'call', null) : service.cancel('person', 'call', 'request');
    await expect(result).rejects.toMatchObject({ code: 'invalid_portrait_response' });
    expect(fixture.fetch.mock.calls[0][1].redirect).toBe('error');
    expect(JSON.parse(fixture.fetch.mock.calls[0][1].body).callSessionId).toBe('call');
  });
  it('retains an unknown outcome without retrying the billed operation', async () => {
    fixture.fetch.mockResolvedValueOnce(response({ code: 'portrait_outcome_unknown', outcomeUnknown: true }, 503));
    await expect(service.create('person', 'call', 'request')).rejects.toMatchObject({ code: 'portrait_outcome_unknown', status: 503 });
    expect(fixture.fetch).toHaveBeenCalledOnce();
  });
  it('rejects invalid session offers at the API boundary', async () => {
    fixture.fetch.mockResolvedValueOnce(response({ portraitSessionId: 'stream', callSessionId: 'call', offer: { type: 'answer', sdp: 'v=0' }, iceServers: [], expiresAt: Date.now() + 1000 }));
    await expect(service.create('person', 'call', 'request')).rejects.toMatchObject({ code: 'invalid_portrait_response' });
  });
});
