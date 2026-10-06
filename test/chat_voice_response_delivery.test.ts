import { readImplementationSource } from './implementation_source';
import { readVoiceImplementationSource } from './voice_implementation_source';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

describe('chat and voice finalized delivery paths', () => {
  const root = process.cwd();
  const chat = readImplementationSource(path.join(root, 'server/socket/chat.ts'), 'utf8');
  const voice = readVoiceImplementationSource();

  it('keeps workflow adapters out of both interactive transports', () => {
    expect(chat).not.toContain('executeSkillWorkflowAdapter');
    expect(chat).not.toContain('const finalizedWorkflow = finalizeLumiResponse({');
    expect(chat).not.toContain('estimateSkillWorkflowChatSpeechMs');

    expect(voice).not.toContain('executeSkillWorkflowAdapter');
    expect(voice).not.toContain('finalizedWorkflowSpeech');
    expect(voice).toContain('queueFinalizedSpeech(input.speechText!)');
    expect(voice).toContain('runPreparedLumiTurn({');
  });

  it('does not run named workflow regex shortcuts in main chat', () => {
    expect(chat).not.toContain('runWorkflowMatch');
    expect(chat).not.toContain('workflowQuickToolRecords');
    expect(chat).not.toContain('finalizedWorkflowQuick');
  });

  it('does not expose a parallel background response stream before finalization', () => {
    expect(chat).not.toContain('emitBackground(');
  });

  it('filters tool progress that carries terminal success wording', () => {
    expect(chat).toContain('shouldForwardPreFinalizationProgress(step)');
    expect(voice).toContain('shouldForwardPreFinalizationProgress(step)');
  });

  it('does not keep a dedicated built-in music execution path', () => {
    for (const source of [chat, voice]) {
      expect(source).not.toContain('isMusicPlaybackRequest');
      expect(source).not.toContain('adjustMusicPlayback');
      expect(source).not.toContain('searchAndPlay');
      expect(source).not.toContain('musicFinalized');
    }
    expect(voice).toContain('queueFinalizedSpeech(input.speechText!)');
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

  it('speaks the complete finalized reply without a second workflow summary', () => {
    expect(voice).not.toContain('maxCharacters: 280');
    expect(voice).not.toContain('maxSpokenCharacters');
    expect(voice).not.toContain('workflowSpeechSummary');
    expect(voice).toContain('speechText: responseText');
  });

  it('answers receipt-backed status follow-ups deterministically in both chat and voice', () => {
    expect(chat).toContain("actionFollowupIntent === 'status'");
    expect(chat).toContain('isConversationExecutionFactQuestion(visibleUserText)');
    expect(chat).toContain("executionFactQuestion ? 'chat_conversation_execution_facts' : 'chat_task_status'");
    expect(chat).toContain('getConversationActionStatus(');
    expect(chat).toContain("acceptedNormalizedIntent.target === 'previous_action'");
    expect(voice).toContain("actionFollowupIntent === 'status'");
    expect(voice).toContain("source: 'voice_task_status'");
  });
});
