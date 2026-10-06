import { describe, expect, it, vi } from 'vitest';
import { extractSourceExpression } from './source_expression';

describe('voice started from the visible chat transcript', () => {
  it.each(['shared', 'local'] as const)('forwards the latest selected conversation to the %s voice owner', async kind => {
    const attachmentConversationIdRef = { current: 'previous-transcript' };
    const shared = vi.fn(); const local = vi.fn(async () => undefined);
    const start = extractSourceExpression('src/components/agent_chat/state/use_chat_media_controls.tsx', 'startVoiceSession', {
      attachmentConversationIdRef, voiceSession: kind === 'shared' ? { onStart: shared } : undefined,
      localVoiceSession: { startCall: local }, selectedVoiceId: 'selected-voice', agentId: 'lumi', activeDomain: 'work', activeOrgId: 'selected-org',
    });
    attachmentConversationIdRef.current = 'restored-history-transcript';
    start();
    if (kind === 'shared') {
      expect(shared).toHaveBeenCalledExactlyOnceWith('restored-history-transcript');
      expect(local).not.toHaveBeenCalled();
    } else {
      expect(local).toHaveBeenCalledExactlyOnceWith('selected-voice', 'lumi', 'lumi', {
        domain: 'work', orgId: 'selected-org', conversationId: 'restored-history-transcript',
      });
      expect(shared).not.toHaveBeenCalled();
    }
  });
});
