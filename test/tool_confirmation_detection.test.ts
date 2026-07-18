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

  it('never auto-approves client skill repair through the chat/voice confirmation rule', async () => {
    const { ToolRegistry } = await import('../server/tools/registry');
    const { registerClientSelfTools } = await import('../server/tools/definitions/client_self_tools');
    const { canAutoApproveAction } = await import('../server/tools/action_constitution');
    const registry = new ToolRegistry();
    registerClientSelfTools(registry);

    const result = await registry.execute('client_repair_skill', { skillName: 'demo' }, {
      userId: 'confirmation-boundary-user',
      toolPolicy: {
        allowedTools: ['client_repair_skill'],
        requireConfirmation: ['client_repair_skill'],
        forbiddenTools: [],
        maxIterations: 1,
      },
      requestConfirmation: async (name, args) => canAutoApproveAction(name, args),
    });

    expect(result).toContain('requires user confirmation and was not approved');
  });
});
