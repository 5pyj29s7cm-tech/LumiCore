import { describe, expect, it } from 'vitest';
import { summarizeToolRecordForPersistence } from '../server/cognition/tool_record_status';

describe('persisted tool status', () => {
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
