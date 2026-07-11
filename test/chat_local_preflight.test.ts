import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';
import { shouldRunVisibleActionPreflight } from '../server/socket/chat';

describe('chat local action preflight', () => {
  it('does not scan desktop folders for a runtime-state inspection', () => {
    expect(shouldRunVisibleActionPreflight(
      '\u8bf7\u53ea\u8bfb\u53d6\u5f53\u524d\u6d3b\u52a8\u7a97\u53e3\u6807\u9898\u548c\u684c\u9762\u8fd0\u884c\u72b6\u6001',
      [],
    )).toBe(false);
  });

  it('still scans when the current turn asks for a desktop file or folder', () => {
    expect(shouldRunVisibleActionPreflight(
      '\u8bf7\u8bfb\u53d6\u684c\u9762\u4e0a\u7684\u6848\u4ef6\u6587\u4ef6\u5939',
      [],
    )).toBe(true);
    expect(shouldRunVisibleActionPreflight(
      'Please review the contract.pdf file on the desktop',
      [],
    )).toBe(true);
  });

  it('keeps desktop-control work on Lumi instead of short-circuiting through the orchestrator', () => {
    const source = fs.readFileSync(path.join(process.cwd(), 'server', 'socket', 'chat.ts'), 'utf8');
    expect(source).toContain("capabilitySelection.lane !== 'desktop_control'");
  });
});
