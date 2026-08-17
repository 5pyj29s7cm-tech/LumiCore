import { describe, expect, it } from 'vitest';
import { summarizeToolRecordForPersistence } from '../server/cognition/tool_record_status';

describe('persisted tool status', () => {
  it('does not persist a waiting confirmation as Done', () => {
    expect(summarizeToolRecordForPersistence({
      name: 'wechat_send_message',
      arguments: { contact: 'Alice', message: 'hello' },
      result: 'Tool requires user confirmation and was not approved.',
      envelope: {
        version: 1,
        status: 'waiting_confirmation',
        toolName: 'wechat_send_message',
        taskId: 'task-1',
        turnId: 'turn-1',
        requestId: 'request-1',
        idempotencyKey: 'key-1',
        targetIdentity: 'Alice',
        completedAt: '2026-08-16T00:00:00.000Z',
        verification: { status: 'unverified', reason: 'awaiting confirmation' },
      },
    })).toBe('[Tool: wechat_send_message] Status: waiting_confirmation');
  });

  it('does not persist structured blockers as Done', () => {
    expect(summarizeToolRecordForPersistence({
      name: 'mcp_cad-drafting_autocad_playback_file',
      arguments: {},
      result: JSON.stringify({ status: 'blocked', completionMarkerExists: false }),
    })).toBe('[Tool: mcp_cad-drafting_autocad_playback_file] Status: blocked');
  });

  it('records missing completion markers and explicit failures', () => {
    expect(summarizeToolRecordForPersistence({
      name: 'mcp_cad-drafting_autocad_playback_file',
      arguments: {},
      result: JSON.stringify({ status: 'started', completionMarkerExists: false }),
    })).toContain('Missing completion evidence');

    expect(summarizeToolRecordForPersistence({
      name: 'desktop_open',
      arguments: {},
      result: '',
      error: 'timed out',
    })).toContain('Error: timed out');
  });

  it('keeps verified successful tool results as Done', () => {
    expect(summarizeToolRecordForPersistence({
      name: 'mcp_cad-drafting_autocad_playback_file',
      arguments: {},
      result: JSON.stringify({ status: 'completed', completionMarkerExists: true }),
    })).toBe('[Tool: mcp_cad-drafting_autocad_playback_file] Done');
  });
});
