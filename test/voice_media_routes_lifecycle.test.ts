import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('../server/media/process', () => ({ runMediaProcess: vi.fn() }));
vi.mock('../server/tts/adapter', () => ({
  synthesizeSpeech: vi.fn(), cloneVoice: vi.fn(), getVoiceCloneStatus: vi.fn(),
  designVoice: vi.fn(), listVoices: vi.fn(), getActiveProvider: () => 'ark', isTTSProviderConfigured: () => true,
}));
vi.mock('../server/tts/profile_store', () => ({
  addScopedVoiceProfile: vi.fn(), isVoiceProfileAccessible: () => true,
  listScopedVoiceProfiles: () => [], removeScopedVoiceProfile: vi.fn(), updateScopedVoiceProfile: vi.fn(),
  voiceProfileScope: () => ({ userId: 'synthetic', domain: 'personal', orgId: '' }),
}));
import router from '../routes/voice';
import { runMediaProcess } from '../server/media/process';
import { cloneVoice, synthesizeSpeech } from '../server/tts/adapter';
import { addScopedVoiceProfile } from '../server/tts/profile_store';
import { getDataPath } from '../server/config/data_path';
const handler = (url: string) => (router as any).stack.find((layer: any) => layer.route?.path === url && layer.route.methods.post).route.stack.at(-1).handle;
function exchange(body: any, uid = 'synthetic-voice-owner') {
  const req = Object.assign(new EventEmitter(), { body, user: { uid }, protocol: 'http', get: () => '127.0.0.1' });
  const res = Object.assign(new EventEmitter(), { writableEnded: false, destroyed: false, status: vi.fn(), json: vi.fn(), set: vi.fn(), send: vi.fn() });
  res.status.mockReturnValue(res); return { req, res };
}
function samples() {
  const uid = `synthetic-${Date.now()}`;
  const directory = path.join(getDataPath('voice_samples'), uid); fs.mkdirSync(directory, { recursive: true });
  const files = ['one.webm', 'two.webm'].map(name => path.join(directory, name));
  files.forEach(file => fs.writeFileSync(file, 'synthetic encoded media'));
  return { uid, files, body: { provider: 'ark', speakerId: 'prepaid-synthetic', name: 'test', sampleUrls: files.map(file => `/api/voice/samples/${uid}/${path.basename(file)}`) } };
}
afterEach(() => { vi.clearAllMocks(); });
describe('voice HTTP process ownership', () => {
  it('cleans every partial conversion after the second decoder fails', async () => {
    const input = samples(); const outputs: string[] = [];
    vi.mocked(runMediaProcess).mockImplementation(async (_binary, args) => {
      const output = args.at(-1)!; outputs.push(output); fs.writeFileSync(output, 'partial');
      if (outputs.length === 2) throw new Error('synthetic decoder failure');
      return '';
    });
    const { req, res } = exchange(input.body, input.uid);
    await handler('/voice/clone')(req, res);
    expect(outputs).toHaveLength(2);
    expect([...input.files, ...outputs].some(file => fs.existsSync(file))).toBe(false);
    expect(cloneVoice).not.toHaveBeenCalled(); expect(res.status).toHaveBeenCalledWith(400);
    expect(req.listenerCount('aborted')).toBe(0); expect(res.listenerCount('close')).toBe(0);
  });
  it('cancels conversion on disconnect and never submits the cloud clone', async () => {
    const input = samples(); const outputs: string[] = [];
    vi.mocked(runMediaProcess).mockImplementation((_binary, args, signal) => new Promise((_resolve, reject) => {
      const output = args.at(-1)!; outputs.push(output); fs.writeFileSync(output, 'partial');
      signal!.addEventListener('abort', () => reject(signal!.reason), { once: true });
    }));
    const { req, res } = exchange(input.body, input.uid);
    const pending = handler('/voice/clone')(req, res);
    expect(outputs).toHaveLength(1); res.emit('close'); await pending;
    expect([...input.files, ...outputs].some(file => fs.existsSync(file))).toBe(false);
    expect(cloneVoice).not.toHaveBeenCalled(); expect(res.json).not.toHaveBeenCalled();
  });
  it('keeps the profile of a cloud clone accepted before disconnection', async () => {
    const input = samples();
    vi.mocked(runMediaProcess).mockResolvedValue('');
    let finish!: (value: any) => void;
    vi.mocked(cloneVoice).mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const { req, res } = exchange(input.body, input.uid);
    const pending = handler('/voice/clone')(req, res);
    await vi.waitFor(() => expect(cloneVoice).toHaveBeenCalledOnce());
    res.emit('close'); finish({ voiceId: 'accepted-voice', status: 'training' }); await pending;
    expect(addScopedVoiceProfile).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ voiceId: 'accepted-voice', status: 'training' }));
    expect(res.json).not.toHaveBeenCalled();
  });
  it('propagates HTTP disconnect to synthesis without writing a stale audio response', async () => {
    vi.mocked(synthesizeSpeech).mockImplementation((_text, config) => new Promise((_resolve, reject) => {
      config!.signal!.addEventListener('abort', () => reject(config!.signal!.reason), { once: true });
    }));
    const { req, res } = exchange({ text: 'synthetic', provider: 'ark' });
    const pending = handler('/voice/synthesize')(req, res);
    const signal = vi.mocked(synthesizeSpeech).mock.calls[0][1]!.signal!;
    res.emit('close'); await pending; expect(signal.aborted).toBe(true);
    expect(res.send).not.toHaveBeenCalled(); expect(res.json).not.toHaveBeenCalled();
  });
});
