import './helpers';
import { EventEmitter } from 'node:events';
import { Router } from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { analyzeScreen } from '../server/llm/adapter';
import { makeLLMCall } from '../server/llm/providers';
import { mountCreativeRoutes } from '../server/routes/creative_routes';
import { transcribeAudioFile } from '../server/stt/file_transcription';

vi.mock('../server/llm/providers', async importOriginal => ({
  ...await importOriginal<typeof import('../server/llm/providers')>(), makeLLMCall: vi.fn(),
}));
vi.mock('../server/stt/file_transcription', async importOriginal => ({
  ...await importOriginal<typeof import('../server/stt/file_transcription')>(), transcribeAudioFile: vi.fn(),
}));
afterEach(() => vi.clearAllMocks());

describe('interactive model and media cancellation', () => {
  it('passes screen-analysis cancellation to the model and rejects late output', async () => {
    let finish!: (value: any) => void;
    vi.mocked(makeLLMCall).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const controller = new AbortController();
    const pending = analyzeScreen('data:image/png;base64,c3ludGhldGlj', 'Describe synthetic image', {
      provider: 'openai', model: 'synthetic-vision', signal: controller.signal,
    });
    const rejected = expect(pending).rejects.toThrow();
    expect(vi.mocked(makeLLMCall).mock.calls[0][2].signal).toBe(controller.signal);
    controller.abort(); finish({ text: 'Late analysis', toolCalls: [] });
    await rejected;
  });

  it('cancels ad hoc audio transcription on disconnect without sending an error response', async () => {
    const router = Router();
    mountCreativeRoutes(router, 'unused', { getDeepSeek: () => null, getGemini: () => null });
    const handler = (router as any).stack.find((layer: any) => layer.route?.path === '/audio/transcribe').route.stack.at(-1).handle;
    const req = Object.assign(new EventEmitter(), { body: { audio: Buffer.from('synthetic').toString('base64') } });
    const res = Object.assign(new EventEmitter(), { writableEnded: false, destroyed: false, json: vi.fn(), status: vi.fn() });
    res.status.mockReturnValue(res);
    let signal!: AbortSignal;
    vi.mocked(transcribeAudioFile).mockImplementationOnce((_audio, options) => new Promise((_resolve, reject) => {
      signal = options!.signal!;
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    }));
    const next = vi.fn();
    const pending = handler(req, res, next);
    res.emit('close'); await pending;
    expect(signal.aborted).toBe(true);
    expect(res.json).not.toHaveBeenCalled();
    expect(next).not.toHaveBeenCalled();
    expect(req.listenerCount('aborted')).toBe(0);
    expect(res.listenerCount('close')).toBe(0);
  });
});
