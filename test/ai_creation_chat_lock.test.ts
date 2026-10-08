import { describe, expect, it, vi } from 'vitest';
import { ChatRequestLedger } from '../src/lib/chatEventReceipts';
import { extractSourceExpression } from './source_expression';

const file = 'src/components/agent_chat/state/use_chat_media_controls.tsx';
function harness(isTyping = false) {
  const ledger = new ChatRequestLedger();
  const activeMediaGenerationRef = { current: null as null | { requestId: string; mode: 'image' | 'video' } };
  const isCreationLocked = extractSourceExpression(file, 'isCreationLocked', {
    isTyping, chatRequestLedgerRef: { current: ledger }, activeMediaGenerationRef,
  });
  const deps = { isCreationLocked, activeMediaGenerationRef, refreshKnowledgeFiles: vi.fn(),
    mediaStudioOpenRef: { current: false }, setMediaStudioMode: vi.fn(),
    mediaGenerationArtifactsRef: { current: [] }, setMediaGenerationArtifacts: vi.fn(), setMediaGeneration: vi.fn() };
  return { ledger, ...deps, open: extractSourceExpression(file, 'openMediaGenerationStudio', deps) };
}

describe('AI Creation chat task lock', () => {
  it('blocks a just registered or recovered chat before React paints its busy state', () => {
    const h = harness();
    h.ledger.begin('chat-recovered');
    expect(h.isCreationLocked()).toBe(true);
    h.open('image');
    expect(h.refreshKnowledgeFiles).not.toHaveBeenCalled();
    expect(h.setMediaStudioMode).not.toHaveBeenCalled();
    expect(h.setMediaGeneration).not.toHaveBeenCalled();
    h.ledger.settle('chat-recovered');
    expect(h.isCreationLocked()).toBe(false);
    h.open('image');
    expect(h.setMediaStudioMode).toHaveBeenCalledWith('image');
  });

  it('keeps the lock until the last queued chat settles', () => {
    const h = harness();
    h.ledger.begin('first'); h.ledger.begin('second');
    h.ledger.settle('first');
    expect(h.isCreationLocked()).toBe(true);
    h.ledger.settle('second');
    expect(h.isCreationLocked()).toBe(false);
  });

  it('allows viewing the active media job but blocks creation when another chat is pending', () => {
    const h = harness(true);
    expect(h.isCreationLocked()).toBe(true);
    h.activeMediaGenerationRef.current = { requestId: 'media', mode: 'video' };
    h.ledger.begin('media');
    expect(h.isCreationLocked()).toBe(false);
    h.open('image');
    expect(h.setMediaStudioMode).toHaveBeenCalledWith('video');
    h.ledger.begin('chat');
    expect(h.isCreationLocked()).toBe(true);
    h.ledger.settle('chat');
    expect(h.isCreationLocked()).toBe(false);
  });
});
