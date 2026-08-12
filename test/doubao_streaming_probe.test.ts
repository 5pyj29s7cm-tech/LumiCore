import { EventEmitter } from 'events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type CapturedConnection = {
  url: string;
  options: { headers?: Record<string, string> };
};

const connections: CapturedConnection[] = [];

function uint32(value: number): Buffer {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32BE(value, 0);
  return buffer;
}

function acknowledgement(): Buffer {
  const body = Buffer.from('{}', 'utf8');
  return Buffer.concat([
    Buffer.from([0x11, 0x90, 0x10, 0x00]),
    uint32(body.length),
    body,
  ]);
}

class FakeWebSocket extends EventEmitter {
  static OPEN = 1;
  readyState = FakeWebSocket.OPEN;

  constructor(url: string, options: { headers?: Record<string, string> }) {
    super();
    connections.push({ url, options });
    queueMicrotask(() => this.emit('open'));
  }

  send(): void {
    queueMicrotask(() => this.emit('message', acknowledgement()));
  }

  close(): void {
    this.readyState = 3;
    queueMicrotask(() => this.emit('close', 1000, Buffer.alloc(0)));
  }
}

vi.mock('ws', () => ({ WebSocket: FakeWebSocket }));

describe('Doubao streaming ASR live-probe contract', () => {
  beforeEach(() => {
    connections.length = 0;
    process.env.DOUBAO_SPEECH_KEY = 'uuid-api-key-value';
  });

  afterEach(() => {
    delete process.env.DOUBAO_SPEECH_KEY;
    vi.clearAllMocks();
  });

  it('waits for a provider acknowledgement and uses only new-console auth headers', async () => {
    const { probeDoubaoStreamingConnection } = await import('../server/stt/providers/ark_stream');
    const result = await probeDoubaoStreamingConnection({ timeoutMs: 2_000 });

    expect(result).toMatchObject({
      ok: true,
      credentialMode: 'api-key',
      resourceId: 'volc.bigasr.sauc.duration',
    });
    expect(connections).toHaveLength(1);
    expect(connections[0].url).toBe('wss://openspeech.bytedance.com/api/v3/sauc/bigmodel');
    expect(connections[0].options.headers).toMatchObject({
      'X-Api-Key': 'uuid-api-key-value',
      'X-Api-Resource-Id': 'volc.bigasr.sauc.duration',
    });
    expect(connections[0].options.headers?.['X-Api-App-Key']).toBeUndefined();
    expect(connections[0].options.headers?.['X-Api-Access-Key']).toBeUndefined();
  });
});
