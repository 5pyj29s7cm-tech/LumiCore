import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  buildOfficialSttFinishTask,
  buildOfficialSttRunTask,
  createStream,
  detectOfficialAudioSampleRate,
  parseOfficialSttMessage,
  transcribe,
} from '../server/stt/providers/official';

class FakeWebSocket extends EventEmitter {
  static OPEN = 1;
  static latest: FakeWebSocket | null = null;
  readyState = 0;
  sent: Array<{ value: string | Buffer; binary: boolean }> = [];
  readonly url: string;
  readonly options: any;

  constructor(url: string, options: any) {
    super();
    this.url = url;
    this.options = options;
    FakeWebSocket.latest = this;
  }

  send(value: string | Buffer, options?: { binary?: boolean }) {
    this.sent.push({ value, binary: options?.binary === true || Buffer.isBuffer(value) });
  }

  close(code = 1000, reason = '') {
    this.readyState = 3;
    this.emit('close', code, Buffer.from(reason));
  }

  open() {
    this.readyState = FakeWebSocket.OPEN;
    this.emit('open');
  }

  message(value: unknown) {
    this.emit('message', Buffer.from(JSON.stringify(value)), false);
  }
}

const originalKey = process.env.RELAY_API_KEY;
const originalBaseUrl = process.env.RELAY_BASE_URL;
const originalModel = process.env.RELAY_STT_MODEL;
const originalPath = process.env.RELAY_STT_STREAM_PATH;

describe('Lumi official streaming STT protocol', () => {
  beforeEach(() => {
    process.env.RELAY_API_KEY = 'test-official-key';
    process.env.RELAY_BASE_URL = 'https://relay.example.test/v1';
    delete process.env.RELAY_STT_MODEL;
    delete process.env.RELAY_STT_STREAM_PATH;
    FakeWebSocket.latest = null;
  });

  afterEach(() => {
    if (originalKey === undefined) delete process.env.RELAY_API_KEY;
    else process.env.RELAY_API_KEY = originalKey;
    if (originalBaseUrl === undefined) delete process.env.RELAY_BASE_URL;
    else process.env.RELAY_BASE_URL = originalBaseUrl;
    if (originalModel === undefined) delete process.env.RELAY_STT_MODEL;
    else process.env.RELAY_STT_MODEL = originalModel;
    if (originalPath === undefined) delete process.env.RELAY_STT_STREAM_PATH;
    else process.env.RELAY_STT_STREAM_PATH = originalPath;
  });

  it('builds only the documented run-task and finish-task control messages', () => {
    const run = buildOfficialSttRunTask(
      'task-id',
      'aliyun/qwen-audio-3.0-asr-flash-streaming',
      'zh-CN',
      'pcm',
      16_000,
      900,
    ) as any;
    expect(run.header).toEqual({ action: 'run-task', task_id: 'task-id', streaming: 'duplex' });
    expect(run.payload).toMatchObject({
      task_group: 'audio',
      task: 'asr',
      function: 'recognition',
      model: 'aliyun/qwen-audio-3.0-asr-flash-streaming',
      parameters: { format: 'pcm', sample_rate: 16_000, language_hints: ['zh'] },
      input: {},
    });
    expect(buildOfficialSttFinishTask('task-id')).toEqual({
      header: { action: 'finish-task', task_id: 'task-id', streaming: 'duplex' },
      payload: { input: {} },
    });
    expect(JSON.stringify([run, buildOfficialSttFinishTask('task-id')])).not.toContain('input-finished');
  });

  it('detects encoded source rates instead of assuming every file is 16 kHz', () => {
    const wav = Buffer.alloc(44);
    wav.write('RIFF', 0, 'ascii');
    wav.write('WAVE', 8, 'ascii');
    wav.write('fmt ', 12, 'ascii');
    wav.writeUInt32LE(16, 16);
    wav.writeUInt16LE(1, 20);
    wav.writeUInt16LE(1, 22);
    wav.writeUInt32LE(24_000, 24);
    wav.writeUInt32LE(48_000, 28);
    wav.writeUInt16LE(2, 32);
    wav.writeUInt16LE(16, 34);
    wav.write('data', 36, 'ascii');
    expect(detectOfficialAudioSampleRate(wav, 'wav')).toBe(24_000);

    // MPEG-2 Layer III, 24 kHz (rate index 1), with a non-zero bitrate.
    const mp3 = Buffer.from([0xff, 0xf3, 0x84, 0x64, 0, 0, 0, 0]);
    expect(detectOfficialAudioSampleRate(mp3, 'mp3')).toBe(24_000);
  });

  it('declares the detected MP3 rate in the one-utterance WebSocket task', async () => {
    const mp3 = Buffer.from([0xff, 0xf3, 0x84, 0x64, 0, 0, 0, 0]);
    const promise = transcribe(mp3, 'zh-CN', {
      fileName: 'voice.mp3',
      WebSocketImpl: FakeWebSocket as any,
    });
    const socket = FakeWebSocket.latest!;
    socket.open();
    const runTask = JSON.parse(String(socket.sent[0].value));
    expect(runTask.payload.parameters.format).toBe('mp3');
    expect(runTask.payload.parameters.sample_rate).toBe(24_000);
    socket.message({ header: { event: 'task-started', task_id: runTask.header.task_id }, payload: {} });
    socket.message({
      header: { event: 'result-generated', task_id: runTask.header.task_id },
      payload: { output: { sentence: { text: 'hello', sentence_end: true } } },
    });
    await expect(promise).resolves.toMatchObject({ text: 'hello', isFinal: true });
  });

  it('waits for task-started before sending queued binary audio, then sends finish-task', () => {
    const session = createStream('zh', true, {
      WebSocketImpl: FakeWebSocket as any,
    });
    const socket = FakeWebSocket.latest!;
    const audio = Buffer.from([1, 2, 3, 4]);
    session.sendAudio(audio);
    session.end();
    expect(socket.sent).toHaveLength(0);

    socket.open();
    const runTask = JSON.parse(String(socket.sent[0].value));
    expect(runTask.header.action).toBe('run-task');
    expect(socket.sent).toHaveLength(1);

    socket.message({ header: { event: 'task-started', task_id: runTask.header.task_id }, payload: {} });
    expect(socket.sent[1]).toEqual({ value: audio, binary: true });
    expect(JSON.parse(String(socket.sent[2].value)).header.action).toBe('finish-task');
    expect(socket.url).toContain('/v1/audio/transcriptions/stream?model=aliyun%2Fqwen-audio-3.0-asr-flash-streaming');
    expect(socket.options.headers.Authorization).toBe('Bearer test-official-key');
  });

  it('uses an explicit session model instead of the deployment fallback', () => {
    process.env.RELAY_STT_MODEL = 'aliyun/legacy-asr-model';
    const session = createStream('zh', true, {
      model: 'aliyun/qwen-audio-3.0-asr-flash-streaming',
      WebSocketImpl: FakeWebSocket as any,
    });
    const socket = FakeWebSocket.latest!;
    socket.open();
    const runTask = JSON.parse(String(socket.sent[0].value));
    expect(runTask.payload.model).toBe('aliyun/qwen-audio-3.0-asr-flash-streaming');
    expect(socket.url).toContain('model=aliyun%2Fqwen-audio-3.0-asr-flash-streaming');
    session.end();
  });

  it('maps heartbeat, partial, final, and task-failed events without exposing internals', () => {
    expect(parseOfficialSttMessage({
      header: { event: 'result-generated' },
      payload: { output: { sentence: { heartbeat: true } } },
    }).result).toBeUndefined();

    expect(parseOfficialSttMessage({
      header: { event: 'result-generated', task_id: 'task-id' },
      payload: { output: { sentence: { text: '你', sentence_begin: true, sentence_end: false, begin_time: 10 } } },
    }).result).toMatchObject({ text: '你', isFinal: false, speechStarted: true, taskId: 'task-id' });

    expect(parseOfficialSttMessage({
      header: { event: 'result-generated', task_id: 'task-id' },
      payload: { output: { sentence: { text: '你好', sentence_end: true, begin_time: 10, end_time: 420 } } },
    }).result).toMatchObject({ text: '你好', isFinal: true, speechFinal: true });

    const failure = parseOfficialSttMessage({
      header: { event: 'task-failed', error_code: 'InvalidParameter', error_message: 'bad request sk-secretvalue' },
      payload: {},
    });
    expect(failure.error?.message).toContain('[redacted]');
    expect(failure.error?.message).not.toContain('sk-secretvalue');

    const gatewayFailure = parseOfficialSttMessage({
      type: 'error',
      error: { code: 'invalid_request', message: 'missing model' },
    });
    expect(gatewayFailure.error?.message).toBe('missing model');

    const mismatched = parseOfficialSttMessage({
      header: { event: 'task-started', task_id: 'other-task' },
      payload: {},
    }, 'model', 'expected-task');
    expect(mismatched.error?.message).toContain('different task');
  });

  it('settles an empty task and surfaces an unexpected close', () => {
    const session = createStream('zh', true, { WebSocketImpl: FakeWebSocket as any });
    const socket = FakeWebSocket.latest!;
    const results: any[] = [];
    const errors: Error[] = [];
    session.onResult(result => results.push(result));
    session.onError(error => errors.push(error));
    socket.open();
    const taskId = JSON.parse(String(socket.sent[0].value)).header.task_id;
    socket.message({ header: { event: 'task-started', task_id: taskId }, payload: {} });
    session.end();
    socket.message({ header: { event: 'task-finished', task_id: taskId }, payload: { output: {} } });
    expect(results).toMatchObject([{ text: '', isFinal: true, speechFinal: true, taskId }]);
    expect(errors).toHaveLength(0);

    const brokenSession = createStream('zh', true, { WebSocketImpl: FakeWebSocket as any });
    const brokenSocket = FakeWebSocket.latest!;
    const brokenErrors: Error[] = [];
    brokenSession.onError(error => brokenErrors.push(error));
    brokenSocket.close(1006, 'network lost');
    expect(brokenErrors[0]?.message).toContain('closed before completion');
  });
});
