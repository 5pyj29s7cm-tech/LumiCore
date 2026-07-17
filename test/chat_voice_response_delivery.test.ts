import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

describe('chat and voice finalized delivery paths', () => {
  const root = process.cwd();
  const chat = readFileSync(path.join(root, 'server/socket/chat.ts'), 'utf8');
  const voice = readFileSync(path.join(root, 'server/socket/voice.ts'), 'utf8');

  it('buffers special workflow narration and finalizes the shared tool ledger', () => {
    expect(chat).toContain('speak: async () => 0');
    expect(chat).toContain('const finalizedWorkflow = finalizeLumiResponse({');
    expect(chat).not.toContain('estimateSkillWorkflowChatSpeechMs');

    expect(voice).toContain('speak: async () => 0');
    expect(voice).toContain('queueFinalizedSpeech(responseText)');
    expect(voice).toContain('source: specialWorkflow.source');
  });

  it('runs named workflow shortcuts through the same finalizer', () => {
    expect(chat).toContain('const workflowQuickToolRecords: ToolExecutionRecord[] = []');
    expect(chat).toContain('const finalizedWorkflowQuick = finalizeLumiResponse({');
    expect(chat).toContain('toolRecords: workflowQuickToolRecords');
  });

  it('does not forward background orchestrator chunks before finalization', () => {
    expect(chat).not.toContain(
      '(message) => emitBackground("agent:chunk", { text: message, agentName: "Lumi Orchestrator" })',
    );
  });

  it('filters tool progress that carries terminal success wording', () => {
    expect(chat).toContain('shouldForwardPreFinalizationProgress(step)');
    expect(voice).toContain('shouldForwardPreFinalizationProgress(step)');
  });

  it('does not speak a music action acknowledgement before playback executes', () => {
    expect(voice).not.toContain('acknowledging before playback');
    expect(voice).toContain('const musicFinalized = finalizeLumiResponse({');
    expect(voice).toContain('queueFinalizedSpeech(responseText)');
  });

  it('keeps exactly one finalized voice music-intent execution path', () => {
    expect(voice.match(/if \(isMusicPlaybackRequest\(userText\)/g) || []).toHaveLength(1);
    expect(voice.match(/adjustMusicPlayback\(session\.userId, socket, userText\)/g) || []).toHaveLength(1);
    expect(voice.match(/searchAndPlay\(session\.userId, socket, userText\)/g) || []).toHaveLength(1);
    expect(voice).not.toContain('voice_music_shortcut_error_');
    expect(voice).not.toContain('Music intent shortcut');
  });

  it('marks every agent response as finalized and exposes guard state', () => {
    for (const source of [chat, voice]) {
      const payloads = Array.from(
        source.matchAll(/agent:response["'],\s*\{([\s\S]{0,700}?)\}\);/g),
        match => match[1],
      );
      expect(payloads.length).toBeGreaterThan(0);
      for (const payload of payloads) {
        expect(payload).toMatch(/\bfinalized\s*:/);
        expect(payload).toMatch(/\bblocked\s*:/);
        expect(payload).toMatch(/\breason\s*:/);
      }
    }
  });

  it('keeps ordinary voice replies complete and summarizes only the self-intro workflow', () => {
    expect(voice).not.toContain('maxCharacters: 280');
    expect(voice).not.toContain('maxSpokenCharacters');
    expect(voice).toContain('workflowSpeechSummary');
    expect(voice).toContain('finalizedWorkflowSpeech');
  });
});
