import { beforeEach, describe, expect, it } from 'vitest';
import {
  clearAllPendingConfirmationsForTests,
  consumePendingConfirmation,
  formatPendingConfirmationPrompt,
  getPendingConfirmation,
  isExplicitConfirmationReply,
  recordPendingConfirmation,
} from '../server/tools/pending_confirmation';

describe('One-time pending tool confirmations', () => {
  beforeEach(() => clearAllPendingConfirmationsForTests());

  it('consumes only an exact tool and argument match once', () => {
    const pending = recordPendingConfirmation('u1', 'legal_submit_filing', { caseId: 'case-1', court: 'A' });
    expect(getPendingConfirmation('u1')?.id).toBe(pending.id);
    expect(consumePendingConfirmation('u1', pending.id, 'legal_submit_filing', { caseId: 'case-2', court: 'A' })).toBe(false);
    expect(consumePendingConfirmation('u1', pending.id, 'legal_submit_filing', { court: 'A', caseId: 'case-1' })).toBe(true);
    expect(consumePendingConfirmation('u1', pending.id, 'legal_submit_filing', { court: 'A', caseId: 'case-1' })).toBe(false);
  });

  it('redacts credentials before placing pending details in a model prompt', () => {
    const pending = recordPendingConfirmation('u1', 'web_login', {
      username: 'owner',
      password: 'super-secret-password',
    });
    const prompt = formatPendingConfirmationPrompt(pending);
    expect(prompt).toContain('owner');
    expect(prompt).toContain('[redacted]');
    expect(prompt).not.toContain('super-secret-password');
  });

  it('recognizes a concise confirmation without treating ordinary messages as approval', () => {
    expect(isExplicitConfirmationReply('确认')).toBe(true);
    expect(isExplicitConfirmationReply('确认执行')).toBe(true);
    expect(isExplicitConfirmationReply('确认一下这个文件内容')).toBe(false);
  });
});
