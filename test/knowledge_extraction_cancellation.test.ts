import './helpers';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { extractKnowledgeFileContent } from '../routes/files';
import { transcribeAudioFile } from '../server/stt/file_transcription';

vi.mock('../server/stt/file_transcription', async importOriginal => ({
  ...await importOriginal<typeof import('../server/stt/file_transcription')>(),
  transcribeAudioFile: vi.fn(),
}));

afterEach(() => vi.clearAllMocks());

describe('knowledge audio extraction cancellation', () => {
  it('passes cancellation to transcription and rejects its late result', async () => {
    const sourcePath = path.join(process.env.LUMI_DATA_DIR!, 'cancelled-audio.wav');
    fs.writeFileSync(sourcePath, 'synthetic audio');
    let finish!: (value: any) => void;
    vi.mocked(transcribeAudioFile).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const controller = new AbortController();
    const pending = extractKnowledgeFileContent(sourcePath, 'synthetic-owner', controller.signal);
    const rejected = expect(pending).rejects.toThrow();
    expect(vi.mocked(transcribeAudioFile).mock.calls[0][1]?.signal).toBe(controller.signal);
    controller.abort();
    finish({ text: 'Late transcript must not be accepted', provider: 'relay', model: 'synthetic' });
    await rejected;
  });

  it('does not begin transcription after cancellation', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(extractKnowledgeFileContent('unused.wav', 'synthetic-owner', controller.signal)).rejects.toThrow();
    expect(transcribeAudioFile).not.toHaveBeenCalled();
  });
});
