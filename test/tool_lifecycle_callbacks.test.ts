import { describe, expect, it, vi } from 'vitest';
import { createToolLifecycleCallbacks } from '../server/socket/tool_lifecycle';
import type { ToolExecutionRecord } from '../server/tools/types';
const record: ToolExecutionRecord = { id: 'call', name: 'read_file', arguments: { path: 'file' }, result: 'content' };
describe('tool receipts and UI lifecycle ownership', () => {
  it('retains late execution evidence without updating a superseded voice work lane', () => {
    const emit = vi.fn(), onRecord = vi.fn(), onStart = vi.fn();
    const observer = createToolLifecycleCallbacks({ emit, correlationPrefix: 'voice', formatResult: value => value || '', isCurrent: () => false, onRecord, onStart });
    observer.onToolStart(record); observer.onToolCall(record);
    expect(onStart).toHaveBeenCalledExactlyOnceWith(record);
    expect(onRecord).toHaveBeenCalledExactlyOnceWith(record);
    expect(emit).not.toHaveBeenCalled();
  });
  it('keeps desktop lifecycle publication with the relay while observing its receipts', () => {
    const emit = vi.fn(), onRecord = vi.fn(), onStart = vi.fn();
    const observer = createToolLifecycleCallbacks({ emit, correlationPrefix: 'voice', formatResult: value => value || '', onRecord, onStart });
    const desktop = { ...record, name: 'client_action' };
    observer.onToolStart(desktop); observer.onToolCall(desktop);
    expect(onStart).toHaveBeenCalledExactlyOnceWith(desktop);
    expect(onRecord).toHaveBeenCalledExactlyOnceWith(desktop); expect(emit).not.toHaveBeenCalled();
  });
  it('publishes paired start and finish data under the exact canonical call ID', () => {
    const emit = vi.fn();
    const observer = createToolLifecycleCallbacks({ emit, correlationPrefix: 'chat', formatResult: value => (value || '').slice(0, 3) });
    observer.onToolStart(record); observer.onToolCall(record);
    expect(emit.mock.calls.map(([payload]) => payload.correlationId)).toEqual(['call', 'call']);
    expect(emit.mock.calls[1][0]).toMatchObject({ name: 'read_file', arguments: { path: 'file' }, result: 'con' });
  });
  it('preserves transport-specific error previews and media receipts', () => {
    const emit = vi.fn(), failed = { ...record, error: 'failed' };
    const voice = createToolLifecycleCallbacks({ emit, correlationPrefix: 'voice', formatResult: value => value || '' });
    voice.onToolCall(failed); expect(emit.mock.calls[0][0].result).toBeUndefined();
    const receipt = { kind: 'image' } as any;
    const chat = createToolLifecycleCallbacks({ emit, correlationPrefix: 'chat', formatResult: value => value || '', includeFailedResult: true, artifactReceipt: () => receipt });
    chat.onToolCall(failed); expect(emit.mock.calls[1][0]).toMatchObject({ result: 'content', error: 'failed', artifactReceipt: receipt });
  });
});
