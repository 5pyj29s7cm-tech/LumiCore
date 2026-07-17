import { describe, expect, it } from 'vitest';
import { shouldRunVisibleActionPreflight } from '../server/socket/chat';
import {
  classifyComplexity,
  shouldAttemptOrchestration,
} from '../server/agents/orchestrator';

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

  it('keeps ordinary desktop control on Lumi but honors an explicit team request', () => {
    const ordinary = '\u5217\u51fa\u684c\u9762\u6587\u4ef6';
    expect(shouldAttemptOrchestration({
      channel: 'chat',
      text: ordinary,
      complexity: classifyComplexity(ordinary, { userId: 'ordinary_desktop' }),
      allowToolUse: true,
      clientActionOnly: false,
      selfRepair: false,
      capabilityLane: 'desktop_control',
      cognitionCategory: 'command',
    })).toBe(false);

    const team = '\u7ec4\u5efa\u56e2\u961f\uff0c\u5148\u67e5\u770b\u5f53\u524d\u6d3b\u52a8\u7a97\u53e3\uff0c\u518d\u5217\u51fa\u684c\u9762\u6587\u4ef6\u3002';
    expect(shouldAttemptOrchestration({
      channel: 'chat',
      text: team,
      complexity: classifyComplexity(team, { userId: 'team_desktop' }),
      allowToolUse: true,
      clientActionOnly: false,
      selfRepair: false,
      capabilityLane: 'desktop_control',
      cognitionCategory: 'command',
    })).toBe(true);
  });
});
