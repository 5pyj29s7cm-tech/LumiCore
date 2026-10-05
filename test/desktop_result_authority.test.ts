import { describe, expect, it } from 'vitest';
import { finalizeLumiResponse } from '../server/cognition/result_finalizer';
import { hasMatchingDesktopOpenEvidence } from '../server/cognition/action_desktop_evidence';
import type { ToolExecutionRecord } from '../server/tools/types';

const receipt = (changes: Partial<ToolExecutionRecord> = {}): ToolExecutionRecord => ({
  name: 'desktop_open', arguments: { target: 'Notepad' },
  result: JSON.stringify({ ok: true, status: 'verified', targetMatched: true, actualTarget: { processName: 'notepad.exe', title: 'Untitled - Notepad' } }),
  ...changes,
});
describe('desktop final result shares exact receipt authority', () => {
  it('refuses invocation and observed target disagreement in both the contract and presentation', () => {
    const wrong = receipt({ arguments: { target: 'mspaint.exe' } });
    expect(hasMatchingDesktopOpenEvidence(wrong, 'Notepad')).toBe(false);
    const result = finalizeLumiResponse({ taskText: 'Open Notepad', responseText: 'Opened Notepad.', source: 'chat', toolRecords: [wrong] });
    expect(result.blocked).toBe(true);
  });
  it('refuses verified receipts from another request before any success formatter runs', () => {
    const stale = receipt({ requestId: 'old-request', taskId: 'old-task' });
    const result = finalizeLumiResponse({ taskText: 'Open Notepad', responseText: 'Opened Notepad.', source: 'chat', requestId: 'new-request', taskId: 'new-task', toolRecords: [stale] });
    expect(result.blocked).toBe(true);
  });
  it('retains receipt-only success and refuses explicit terminal failure flags', () => {
    const good = receipt();
    expect(finalizeLumiResponse({ taskText: 'Open Notepad', responseText: '', source: 'voice', toolRecords: [{ ...good, receipt: JSON.parse(good.result!), result: '' }] }).blocked).toBe(false);
    const bad = receipt({ result: JSON.stringify({ ok: true, status: 'verified', targetMatched: true, opened: false, actualTarget: { processName: 'notepad.exe' } }) });
    expect(finalizeLumiResponse({ taskText: 'Open Notepad', responseText: 'Opened Notepad.', source: 'chat', toolRecords: [bad] }).blocked).toBe(true);
  });
});
