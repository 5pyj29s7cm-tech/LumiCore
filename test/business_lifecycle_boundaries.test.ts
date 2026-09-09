import './helpers';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getDataPath, getGeneratedOutputDir } from '../server/config/data_path';
import { DesktopWechatWatchService } from '../server/messaging/desktop_wechat_watch';
import { executeToolCallOrThrow } from '../server/tools/execution_engine';
import { transformWordDocument } from '../server/tools/definitions/document_tools';

const processMock = vi.hoisted(() => ({ execute: vi.fn() }));
vi.mock('child_process', async original => ({
  ...await original<typeof import('child_process')>(),
  execFile: (...args: any[]) => processMock.execute(...args),
}));
vi.mock('../server/tools/execution_engine', async original => ({ ...await original<typeof import('../server/tools/execution_engine')>(), executeToolCallOrThrow: vi.fn() }));
afterEach(() => { vi.restoreAllMocks(); processMock.execute.mockReset(); });

describe('business lifecycle cancellation and publication', () => {
  it('does not revive a dismissed or disabled desktop WeChat draft after model completion', async () => {
    for (const action of ['dismiss', 'disable']) {
      const service = new DesktopWechatWatchService();
      const userId = `watch-${action}`;
      const storePath = getDataPath(path.join('messaging', 'desktop-wechat-watch.json'));
      const config = { enabled: true, idleBeforeInspectSeconds: 15 };
      fs.mkdirSync(path.dirname(storePath), { recursive: true });
      fs.writeFileSync(storePath, JSON.stringify({ version: 1, configs: { [userId]: config }, events: [{ userId, id: action, contact: 'Synthetic', status: 'detected', detectedAt: new Date().toISOString() }] }));
      service.configure({ llmGetters: { getDeepSeek: () => null, getGemini: () => null } } as any);
      vi.mocked(executeToolCallOrThrow).mockResolvedValue(JSON.stringify({ read: true, contentSummary: 'A synthetic greeting' }));
      const notify = vi.spyOn(service as any, 'notify').mockImplementation(() => {});
      let resolve!: (value: any) => void;
      vi.spyOn(service as any, 'createDraft').mockImplementation(() => new Promise(done => { resolve = done; }));
      const pending = (service as any).processNextPendingEvent(userId, config, async () => JSON.stringify({ idle_seconds: 120 }), {});
      await vi.waitFor(() => expect(resolve).toBeTypeOf('function'));
      if (action === 'dismiss') service.dismissEvent(userId, action);
      else service.updateConfig(userId, { enabled: false });
      resolve({ replyNeeded: true, risk: 'low', reason: '', draft: 'Late draft' });
      await pending;
      const state = service.status(userId);
      expect(state.events[0].status).not.toBe('draft_ready');
      if (action === 'dismiss') expect(state.events[0].status).toBe('dismissed');
      expect(notify).not.toHaveBeenCalled();
    }
  });

  it('waits asynchronously, then publishes only a newly verified Word output', async () => {
    const directory = getGeneratedOutputDir(); fs.mkdirSync(directory, { recursive: true });
    const input = path.join(directory, 'word-input.docx'); const output = path.join(directory, 'word-output.pdf');
    fs.writeFileSync(input, 'synthetic docx'); fs.writeFileSync(output, '%PDF-old');
    let finish!: () => void;
    processMock.execute.mockImplementation((_exe, argv, options, callback) => {
      expect(options.windowsHide).toBe(true);
      const script = fs.readFileSync(argv.at(-1), 'utf8');
      expect(script).toContain('finally'); expect(script).toContain('$word.Quit(0)');
      const temporaryOutput = script.match(/SaveAs2\(\[ref\]'([^']+)'/)![1];
      finish = () => { fs.writeFileSync(temporaryOutput, '%PDF-new'); callback(null, '', ''); };
      return { on: vi.fn() };
    });
    const pending = transformWordDocument(input, output, 'pdf', '');
    await new Promise(resolve => setImmediate(resolve));
    expect(fs.readFileSync(output, 'utf8')).toBe('%PDF-old');
    finish();
    await expect(pending).resolves.toBe(8);
    expect(fs.readFileSync(output, 'utf8')).toBe('%PDF-new');
  });

  it('does not use a preexisting output as success after Word cancellation', async () => {
    const directory = getGeneratedOutputDir(); fs.mkdirSync(directory, { recursive: true });
    const input = path.join(directory, 'word-cancel.docx'); const output = path.join(directory, 'word-cancel.pdf');
    fs.writeFileSync(input, 'synthetic'); fs.writeFileSync(output, '%PDF-existing');
    const controller = new AbortController();
    processMock.execute.mockImplementation((_exe, _argv, options, callback) => {
      options.signal.addEventListener('abort', () => callback(new DOMException('cancelled', 'AbortError')), { once: true });
      return { on: vi.fn() };
    });
    const pending = transformWordDocument(input, output, 'pdf', '', { executionSignal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toThrow(/cancelled/);
    expect(fs.readFileSync(output, 'utf8')).toBe('%PDF-existing');
  });
});
