import { describe, expect, it } from 'vitest';
import { isConfirmationBlockedToolRecord } from '../server/llm/adapter';

describe('tool confirmation detection', () => {
  it('does not treat capability documentation inside a successful result as a live confirmation block', () => {
    expect(isConfirmationBlockedToolRecord({
      name: 'client_get_state',
      arguments: {},
      result: JSON.stringify({
        requiresConfirmation: true,
        notes: 'Some unrelated actions require user confirmation.',
      }),
    })).toBe(false);
  });

  it('recognizes only an actual registry rejection or confirmation error', () => {
    expect(isConfirmationBlockedToolRecord({
      name: 'client_repair_skill',
      arguments: { skillName: 'demo' },
      result: 'Tool "client_repair_skill" requires user confirmation and was not approved.',
    })).toBe(true);
    expect(isConfirmationBlockedToolRecord({
      name: 'client_repair_skill',
      arguments: { skillName: 'demo' },
      result: '',
      error: 'Tool "client_repair_skill" requires user confirmation: package changes require approval.',
    })).toBe(true);
  });
});
