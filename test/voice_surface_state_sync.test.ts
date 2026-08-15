import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

function source(relativePath: string): string {
  return fs.readFileSync(path.join(process.cwd(), relativePath), 'utf8');
}

describe('desktop voice surface state synchronization', () => {
  it('gives the home surface and command center one microphone-session owner', () => {
    const desktop = source('src/components/DesktopUI.tsx');
    const chat = source('src/components/AgentChatPage.tsx');
    const hook = source('src/hooks/useVoiceCall.ts');

    expect(desktop).toContain('voiceSession={{');
    expect(desktop).toContain('callState,');
    expect(desktop).toContain('onStart: startStandardVoiceCall');
    expect(desktop).toContain('onEnd: endVoiceCallFromUI');

    expect(chat).toContain('disabled: usesSharedVoiceSession');
    expect(chat).toContain('voiceSession?.callState ?? localVoiceSession.callState');
    expect(chat).toContain('onStart={startVoiceSession}');
    expect(chat).toContain('onEnd={endVoiceSession}');

    expect(hook).toContain('if (disabled || !socket) return;');
    expect(hook).toContain('LUMI_VOICE_TRANSCRIPT_EVENT');
  });

  it('keeps desktop voice transcripts visible in the integrated command-center chat', () => {
    const chat = source('src/components/AgentChatPage.tsx');
    const hook = source('src/hooks/useVoiceCall.ts');

    expect(hook).toContain('new CustomEvent<VoiceTranscriptEventDetail>');
    expect(chat).toContain('window.addEventListener(LUMI_VOICE_TRANSCRIPT_EVENT');
    expect(chat).toContain('lastSharedTranscriptRef');
    expect(chat).toContain("source: 'voice'");
  });
});
