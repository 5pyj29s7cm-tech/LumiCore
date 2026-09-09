import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('../server/config/privacy', () => ({ requireNotStrict: vi.fn() }));
vi.mock('../server/config/keys', () => ({ getKey: () => 'synthetic' }));
vi.mock('../server/cloud/circuit_breaker', () => ({ isCircuitClosed: () => true, recordFailure: vi.fn(), recordSuccess: vi.fn() }));
import { createStream } from '../server/stt/providers/qwen';
import { recordFailure } from '../server/cloud/circuit_breaker';
class Socket {
  static OPEN = 1;
  static latest: Socket;
  readyState = 0;
  sent: any[] = [];
  onopen?: () => void;
  onmessage?: (event: any) => void;
  onerror?: (event: any) => void;
  onclose?: (event: any) => void;
  close = vi.fn(() => {
    if (this.readyState === 0) throw new Error('still connecting');
    this.readyState = 3;
    this.onclose?.({ code: 1000 });
  });
  constructor() { Socket.latest = this; }
  send(text: string) { this.sent.push(JSON.parse(text)); }
  open() { this.readyState = 1; this.onopen?.(); }
  message(value: any) { this.onmessage?.({ data: JSON.stringify(value) }); }
}
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });
describe('streaming recognition finish versus abort', () => {
  it('closes a late connection after abort without configuring it or emitting late results', () => {
    vi.stubGlobal('WebSocket', Socket);
    const session = createStream();
    const socket = Socket.latest;
    const result = vi.fn(); session.onResult(result);
    session.sendAudio(Buffer.from('discard me'));
    session.abort!();
    socket.open();
    socket.message({ type: 'session.created' });
    socket.message({ type: 'conversation.item.input_audio_transcription.completed', transcript: 'late' });
    socket.onerror?.(new Error('closed'));
    expect(socket.readyState).toBe(3);
    expect(socket.sent).toEqual([]);
    expect(result).not.toHaveBeenCalled();
    expect(recordFailure).not.toHaveBeenCalled();
  });
  it('finishes accepted audio after the handshake, then emits its final result before closing', () => {
    vi.stubGlobal('WebSocket', Socket);
    const session = createStream(); const socket = Socket.latest;
    const result = vi.fn(); session.onResult(result);
    session.sendAudio(Buffer.from('accepted'));
    session.end(); socket.open(); socket.message({ type: 'session.created' });
    expect(socket.sent.map(event => event.type)).toEqual(['session.update', 'input_audio_buffer.append', 'session.finish']);
    socket.message({ type: 'conversation.item.input_audio_transcription.completed', transcript: 'final' });
    expect(result).toHaveBeenCalledWith(expect.objectContaining({ text: 'final', isFinal: true }));
    socket.message({ type: 'session.finished' });
    expect(socket.readyState).toBe(3);
  });
});
