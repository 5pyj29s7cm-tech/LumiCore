import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createSafeConsoleMirror,
  pruneRuntimeLogFiles,
  RuntimeFileSink,
  sanitizeRuntimeLogLine,
} from '../server/runtime/file_logger';
import { tailLogFile } from '../server/routes/system_routes';

const temporaryDirectories: string[] = [];

function makeTemporaryDirectory(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lumi-runtime-log-'));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe('runtime file logger', () => {
  it('redacts credentials and omits screenshot payloads', () => {
    const line = sanitizeRuntimeLogLine([
      '[TTS] request',
      { apiKey: 'sk-private-value', voiceId: 'voice-b' },
      `data:image/jpeg;base64,${'A'.repeat(2_000)}`,
      `image_base64=${'B'.repeat(2_000)}`,
    ]);

    expect(line).toContain("apiKey: '[redacted]'");
    expect(line).toContain('voice-b');
    expect(line).toContain('[image data omitted]');
    expect(line).not.toContain('sk-private-value');
    expect(line).not.toContain('A'.repeat(128));
    expect(line).not.toContain('B'.repeat(128));
  });

  it('omits chat, answer, prompt, tool argument and document bodies by default', () => {
    const line = sanitizeRuntimeLogLine([
      '[ChatHandler] agent:chat RECEIVED:',
      {
        requestId: 'request-structured-1',
        message: 'PRIVATE CHAT BODY',
        responseText: 'PRIVATE ANSWER BODY',
        documentContent: 'PRIVATE DOCUMENT BODY',
        arguments: { prompt: 'PRIVATE TOOL PROMPT' },
      },
      'responseText:',
      'PRIVATE STREAMED ANSWER',
    ]);

    expect(line).toContain('request-structured-1');
    expect(line).toContain('[content omitted');
    expect(line).not.toContain('PRIVATE CHAT BODY');
    expect(line).not.toContain('PRIVATE ANSWER BODY');
    expect(line).not.toContain('PRIVATE DOCUMENT BODY');
    expect(line).not.toContain('PRIVATE TOOL PROMPT');
    expect(line).not.toContain('PRIVATE STREAMED ANSWER');
  });

  it('never throws for circular objects, throwing getters or revoked proxies', () => {
    const circular: Record<string, unknown> = { status: 'ok' };
    circular.self = circular;
    const throwingGetter = Object.create(null);
    Object.defineProperty(throwingGetter, 'content', {
      enumerable: true,
      get() { throw new Error('getter must not escape'); },
    });
    const revocable = Proxy.revocable({ status: 'hidden' }, {});
    revocable.revoke();

    expect(() => sanitizeRuntimeLogLine([
      '[Runtime] adversarial diagnostic',
      circular,
      throwingGetter,
      revocable.proxy,
    ])).not.toThrow();
    const line = sanitizeRuntimeLogLine(['[Runtime] circular diagnostic', circular]);
    expect(line).toContain('circular reference');
  });

  it('isolates failures from both the original console and the log sink', () => {
    const mirror = createSafeConsoleMirror(
      () => { throw new Error('console unavailable'); },
      'error',
      () => { throw new Error('disk unavailable'); },
    );
    expect(() => mirror('[Runtime] failure', { status: 'failed' })).not.toThrow();
  });

  it('bounds a single diagnostic line', () => {
    const line = sanitizeRuntimeLogLine(['[Runtime] payload', 'x'.repeat(20_000)]);
    expect(line.length).toBeLessThanOrEqual(12_020);
    expect(line).not.toContain('x'.repeat(128));
  });

  it('rotates by size and date while bounding file count and total bytes', async () => {
    const runtimeDir = makeTemporaryDirectory();
    let clock = new Date('2026-08-25T01:00:00.000Z');
    const sink = new RuntimeFileSink({
      runtimeDir,
      now: () => clock,
      maxFileBytes: 260,
      maxTotalBytes: 650,
      retainedFiles: 3,
    });

    for (let index = 0; index < 6; index += 1) {
      sink.write('info', `component="Rotation" index=${index} detail="${'x'.repeat(100)}"`);
    }
    clock = new Date('2026-08-26T01:00:00.000Z');
    sink.write('warn', 'component="Rotation" event="new date"');
    await sink.close();

    const files = fs.readdirSync(runtimeDir)
      .filter(name => /^server-\d{8}(?:-\d{3})?\.log$/.test(name));
    const totalBytes = files.reduce((total, name) => total + fs.statSync(path.join(runtimeDir, name)).size, 0);
    expect(files.length).toBeLessThanOrEqual(3);
    expect(totalBytes).toBeLessThanOrEqual(650);
    expect(files.some(name => name.startsWith('server-20260826'))).toBe(true);
    expect(files.some(name => /-\d{3}\.log$/.test(name))).toBe(true);
  });

  it('prunes by logical log date even when an older stream closes later', () => {
    const runtimeDir = makeTemporaryDirectory();
    const oldPath = path.join(runtimeDir, 'server-20260825-999.log');
    const newPath = path.join(runtimeDir, 'server-20260826.log');
    fs.writeFileSync(oldPath, 'old date\n', 'utf8');
    fs.writeFileSync(newPath, 'new date\n', 'utf8');
    fs.utimesSync(oldPath, new Date('2026-08-27T00:00:00.000Z'), new Date('2026-08-27T00:00:00.000Z'));
    fs.utimesSync(newPath, new Date('2026-08-25T00:00:00.000Z'), new Date('2026-08-25T00:00:00.000Z'));

    pruneRuntimeLogFiles(runtimeDir, { retainedFiles: 1, maxTotalBytes: 1024 });

    expect(fs.existsSync(newPath)).toBe(true);
    expect(fs.existsSync(oldPath)).toBe(false);
  });

  it('reads only a bounded tail and returns complete final lines', async () => {
    const runtimeDir = makeTemporaryDirectory();
    const filePath = path.join(runtimeDir, 'server-20260825.log');
    const lines = Array.from({ length: 100 }, (_, index) => `line-${String(index).padStart(3, '0')} payload`);
    fs.writeFileSync(filePath, `${lines.join('\n')}\n`, 'utf8');

    await expect(tailLogFile(filePath, 3, 96)).resolves.toEqual(lines.slice(-3));
    await expect(tailLogFile(path.join(runtimeDir, 'missing.log'), 3, 96)).resolves.toEqual([]);
  });
});
