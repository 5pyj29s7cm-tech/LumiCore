import { describe, expect, it } from 'vitest';
import { buildChatConversationScopeKey } from '../src/lib/chatConversationScope';

describe('chat conversation scope isolation', () => {
  it('separates personal and organization conversations for the same agent', () => {
    expect(buildChatConversationScopeKey('lumi', 'personal')).toBe('lumi:personal:');
    expect(buildChatConversationScopeKey('lumi', 'work', 'org-a')).toBe('lumi:work:org-a');
    expect(buildChatConversationScopeKey('lumi', 'work', 'org-b')).toBe('lumi:work:org-b');
  });

  it('does not leak a stale organization id into personal scope', () => {
    expect(buildChatConversationScopeKey('lumi', 'personal', 'org-a')).toBe('lumi:personal:');
  });
});
