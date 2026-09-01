import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { projectAgentActivity } from '../src/lib/agentStatusTruth';

describe('agent user-visible status truth', () => {
  it('keeps model response generation in the thinking presentation', () => {
    expect(projectAgentActivity('responding')).toBe('thinking');
    expect(projectAgentActivity('thinking')).toBe('thinking');
  });

  it('requires server acceptance or exact-request tool evidence for executing UI', () => {
    expect(projectAgentActivity('executing')).toBe('thinking');
    expect(projectAgentActivity('executing', { executionAccepted: true })).toBe('executing');
    expect(projectAgentActivity('executing', { hasToolEvidence: true })).toBe('executing');
  });

  it('preserves explicit confirmation and cancellation states', () => {
    expect(projectAgentActivity('waiting_confirmation')).toBe('waiting_confirmation');
    expect(projectAgentActivity('cancelling')).toBe('cancelling');
    expect(projectAgentActivity('idle')).toBeNull();
  });

  it('routes both chat surfaces through the shared truthful projection', () => {
    const agentChat = readFileSync(join(process.cwd(), 'src/components/AgentChatPage.tsx'), 'utf8');
    const taskChat = readFileSync(join(process.cwd(), 'src/components/ChatPanel.tsx'), 'utf8');
    expect(agentChat).toContain('projectAgentActivity(data.status');
    expect(taskChat).toContain('projectAgentActivity(data.status');
    expect(agentChat).not.toContain("data.status === 'responding' || data.status === 'executing'");
  });
});
