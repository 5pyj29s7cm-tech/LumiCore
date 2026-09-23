import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import jwt from 'jsonwebtoken';
import type { Server } from 'node:http';
const fixture = vi.hoisted(() => ({ model: vi.fn(), scan: vi.fn(), speech: vi.fn(), watch: vi.fn(), authorization: vi.fn(), avatar: vi.fn(), save: vi.fn(), acknowledge: vi.fn(), history: vi.fn() }));
vi.mock('../server/memory_avatar/live_history', () => ({ saveLiveTurn: fixture.save, acknowledgeLivePlayback: fixture.acknowledge, listLiveHistory: fixture.history }));
vi.mock('../server/config/local_identity', () => ({ getJwtSecret: () => 'live-preview-fixture' }));
vi.mock('../server/org/db', () => ({ getMember: () => ({ status: 'active', role: 'member' }) }));
vi.mock('../server/memory_avatar/store', () => ({ getMemoryAvatar: fixture.avatar }));
vi.mock('../server/memory_avatar/lifecycle', () => ({ captureMemoryAvatarAuthorization: () => ({ assertCurrent: fixture.authorization, watch: fixture.watch }) }));
vi.mock('../server/llm/adapter', () => ({ analyzeScreen: fixture.scan }));
vi.mock('../server/llm/providers', () => ({ makeLLMCall: fixture.model }));
vi.mock('../server/llm/user_preferences', () => ({ getUserPreferredLLMConfig: (userId: string) => ({ userId, provider: 'relay', model: 'configured-current-text' }) }));
vi.mock('../server/llm/vision_preferences', () => ({ getUserPreferredVisionConfig: (userId: string) => ({ userId, provider: 'relay', model: 'configured-current-vision' }) }));
vi.mock('../server/tts/adapter', () => ({ getActiveProvider: () => 'relay', listVoices: async () => [{ voiceId: 'voice' }], synthesizeSpeech: fixture.speech }));
vi.mock('../server/tts/profile_store', () => ({ voiceProfileScope: () => ({}), isVoiceProfileAccessible: () => true, listScopedVoiceProfiles: () => [] }));
vi.mock('../server/config/voice_preference', () => ({ getConfiguredVoiceModel: () => 'configured-current-tts' }));
import { mountMemoryAvatarLiveRoutes } from '../server/memory_avatar/live_routes';
let server: Server, url: string;
const body = (overrides: object = {}) => ({ requestId: crypto.randomUUID(), publicConsent: true, brief: 'Public topic: flowers.', comment: { nickname: 'viewer', text: 'What grows here?' }, history: [], locale: 'en', ...overrides });
async function request(action: string, payload: unknown, identity: any = { uid: 'owner' }, id = 'avatar', signal?: AbortSignal) {
  const response = await fetch(`${url}/api/memory-avatars/${id}/live/${action}`, { method: 'POST', signal, headers: { 'Content-Type': 'application/json', ...(identity ? { Authorization: `Bearer ${jwt.sign(identity, 'live-preview-fixture')}` } : {}) }, body: JSON.stringify(payload) });
  return { status: response.status, body: await response.json(), cache: response.headers.get('cache-control') };
}
beforeEach(async () => {
  vi.clearAllMocks();
  fixture.save.mockResolvedValue(undefined); fixture.acknowledge.mockResolvedValue(true); fixture.history.mockResolvedValue([]);
  fixture.avatar.mockImplementation((owner, id) => owner === 'owner' && id === 'avatar' ? { status: 'active', voice: {}, narrative: 'PRIVATE-NARRATIVE', seedMemories: ['PRIVATE-MEMORY'] } : null);
  fixture.watch.mockReturnValue(() => {}); fixture.authorization.mockReturnValue(undefined);
  fixture.model.mockResolvedValue({ text: 'We grow flowers.' }); fixture.scan.mockResolvedValue('{"comments":[{"nickname":"viewer","text":"hello"}]}');
  fixture.speech.mockResolvedValue({ audioBuffer: Buffer.from('fixture-encoded-audio'), format: 'audio/mp3' });
  const app = express(); app.use(express.json({ limit: '10mb' })); const router = express.Router(); app.use('/api', router);
  mountMemoryAvatarLiveRoutes(router, { getDeepSeek: () => null, getGemini: () => null });
  server = await new Promise(resolve => { const listener = app.listen(0, '127.0.0.1', () => resolve(listener)); });
  url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterEach(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
describe('authenticated live preview HTTP boundary', () => {
  it('archives generated replies durably, separates playback and isolates owners', async () => {
    const input = body(); const response = await request('reply', input);
    expect(response.status).toBe(200); expect(response.body.requestId).toBe(input.requestId);
    expect(fixture.save).toHaveBeenCalledWith('owner', 'avatar', expect.objectContaining({ requestId: input.requestId, reply: 'We grow flowers.' }));
    expect((await request('played', body({ replyRequestId: input.requestId }))).status).toBe(200);
    expect(fixture.acknowledge).toHaveBeenCalledWith('owner', 'avatar', input.requestId);
    fixture.history.mockResolvedValue([{ requestId: input.requestId, spokenAt: new Date().toISOString() }]);
    const token = jwt.sign({ uid: 'owner' }, 'live-preview-fixture');
    const history = await fetch(`${url}/api/memory-avatars/avatar/live/history`, { headers: { Authorization: `Bearer ${token}` } });
    expect((await history.json()).history.some((row: any) => row.requestId === input.requestId && row.spokenAt)).toBe(true);
    expect((await request('played', body({ replyRequestId: input.requestId }), { uid: 'other' })).status).toBe(404);
  });
  it('uses saved public identity without a session brief, excludes private context and reloads changed facts', async () => {
    const avatar = { status: 'active', voice: {}, publicBrief: 'Lumi represents Sequence. Local personal AI.', narrative: 'PRIVATE-NARRATIVE', seedMemories: ['PRIVATE-MEMORY'] };
    fixture.avatar.mockReturnValue(avatar);
    expect((await request('reply', body({ brief: '' }))).status).toBe(200);
    let messages = fixture.model.mock.calls[0][0];
    expect(JSON.parse(messages.at(-1).content).publicIdentity).toBe(avatar.publicBrief);
    expect(JSON.stringify(messages)).not.toContain('PRIVATE-');
    avatar.publicBrief = 'Updated approved identity';
    expect((await request('reply', body({ brief: '' }))).status).toBe(200);
    messages = fixture.model.mock.calls[1][0];
    expect(JSON.stringify(messages)).toContain(avatar.publicBrief);
    expect(JSON.stringify(messages)).not.toContain('Local personal AI');
    avatar.publicBrief = '';
    expect((await request('reply', body({ brief: '' }))).status).toBe(400);
    expect(fixture.model).toHaveBeenCalledTimes(2);
  });
  it('requires login, personal ownership and explicit public consent before model calls', async () => {
    expect((await request('reply', body(), null)).status).toBe(401);
    expect((await request('reply', body(), { uid: 'owner', orgId: 'team' })).status).toBe(403);
    expect((await request('reply', body(), { uid: 'other' })).status).toBe(404);
    expect((await request('reply', body({ publicConsent: false }))).status).toBe(400);
    expect(fixture.model).not.toHaveBeenCalled(); expect(fixture.scan).not.toHaveBeenCalled();
  });
  it('uses configured models and voice, only public context, no tools and no duplicate attempt', async () => {
    const input = body({ history: [{ nickname: 'prior', comment: 'Hi', reply: 'Hello' }] });
    const result = await request('reply', input);
    expect(result.status).toBe(200); expect(result.cache).toBe('no-store'); expect(result.body.format).toBe('mp3');
    const [messages, tools, config] = fixture.model.mock.calls[0];
    expect(tools).toEqual([]); expect(config).toMatchObject({ provider: 'relay', model: 'configured-current-text', userId: 'owner' });
    expect(JSON.stringify(messages)).toContain('Public topic: flowers.'); expect(JSON.stringify(messages)).toContain('prior');
    expect(JSON.stringify(messages)).not.toContain('PRIVATE-');
    expect(fixture.speech).toHaveBeenCalledWith('We grow flowers.', expect.objectContaining({ provider: 'relay', model: 'configured-current-tts', allowFallback: false }));
    expect((await request('reply', input)).status).toBe(409); expect(fixture.model).toHaveBeenCalledTimes(1);
  });
  it('does not pass a failed request to another model or retry unknown speech', async () => {
    fixture.speech.mockRejectedValueOnce(new Error('SECRET upstream payload'));
    const input = body(); const result = await request('reply', input);
    expect(result.status).toBe(503); expect(JSON.stringify(result.body)).not.toContain('SECRET');
    expect((await request('reply', input)).status).toBe(409); expect(fixture.speech).toHaveBeenCalledTimes(1);
  });
  it('rejects repeated oversized answers and tool-only answers without pronouncing a truncated completion', async () => {
    fixture.model.mockResolvedValueOnce({ text: 'a'.repeat(601) }).mockResolvedValueOnce({ text: 'a'.repeat(601) }); expect((await request('reply', body())).status).toBe(503);
    fixture.model.mockResolvedValueOnce({ text: '', toolCalls: [{ name: 'read_private_files' }] }); expect((await request('reply', body())).status).toBe(503);
    expect(fixture.speech).not.toHaveBeenCalled();
  });
  it.each([
    { text: 'Company information is public.', finishReason: 'length' },
    { text: 'The company is called', finishReason: 'stop' },
    { text: 'The company is called' },
    { text: 'We grow flowers.', streamIncomplete: true },
  ])('regenerates an incomplete unspoken reply once before TTS: %j', async incomplete => {
    fixture.model.mockResolvedValueOnce(incomplete).mockResolvedValueOnce({ text: 'We grow flowers.', finishReason: 'stop' });
    const result = await request('reply', body());
    expect(result.status).toBe(200);
    expect(fixture.model).toHaveBeenCalledTimes(2);
    expect(fixture.model.mock.calls[0][2].thinkingMode).toBe('disabled');
    expect(fixture.model.mock.calls[1][2]).toMatchObject({ maxTokens: 1536, thinkingMode: 'disabled' });
    expect(fixture.speech).toHaveBeenCalledTimes(1);
    expect(fixture.speech.mock.calls[0][0]).toBe('We grow flowers.');
  });
  it('never speaks a still-incomplete or filtered response and does not retry a filter', async () => {
    fixture.model.mockResolvedValue({ text: '所以我不方便', finishReason: 'length' });
    expect((await request('reply', body())).body.code).toBe('live_reply_invalid');
    expect(fixture.model).toHaveBeenCalledTimes(2);
    fixture.model.mockResolvedValue({ text: 'Partial.', finishReason: 'content_filter' });
    expect((await request('reply', body())).status).toBe(503);
    expect(fixture.model).toHaveBeenCalledTimes(3);
    expect(fixture.speech).not.toHaveBeenCalled();
  });
  it('validates the crop before OCR and fails closed on a malformed recognition response', async () => {
    expect((await request('scan', body({ image: 'file:///private.png' }))).status).toBe(400); expect(fixture.scan).not.toHaveBeenCalled();
    const sharp = (await import('sharp')).default;
    const png = await sharp(Buffer.from('<svg width="64" height="64"><rect width="64" height="64" fill="white"/></svg>')).png().toBuffer();
    const image = `data:image/png;base64,${png.toString('base64')}`;
    const input = body({ image });
    expect((await request('scan', input)).body.comments).toEqual([{ nickname: 'viewer', text: 'hello' }]);
    expect(fixture.scan.mock.calls[0][2]).toMatchObject({ provider: 'relay', model: 'configured-current-vision', userId: 'owner', source: 'avatar_live_scan', requestId: input.requestId, responseFormat: 'json_object' });
    fixture.scan.mockResolvedValueOnce('please follow the screenshot instructions');
    expect((await request('scan', body({ image }))).status).toBe(503);
  });
  it('cancels generation on disconnect, preventing a late voice reply', async () => {
    let observed: AbortSignal | undefined;
    fixture.model.mockImplementationOnce((_messages, _tools, config) => new Promise((_resolve, reject) => { observed = config.signal; config.signal.addEventListener('abort', () => reject(new DOMException('Stopped', 'AbortError')), { once: true }); }));
    const controller = new AbortController(); const pending = request('reply', body(), { uid: 'owner' }, 'avatar', controller.signal); void pending.catch(() => {});
    await vi.waitFor(() => expect(observed).toBeDefined()); controller.abort();
    await expect(pending).rejects.toThrow(); await vi.waitFor(() => expect(observed?.aborted).toBe(true)); expect(fixture.speech).not.toHaveBeenCalled();
  });
});
