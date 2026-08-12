import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

function source(relativePath: string): string {
  return readFileSync(path.join(process.cwd(), relativePath), 'utf8');
}

describe('focus thread client projection', () => {
  it('reloads scoped durable focus after reconnect and work events', () => {
    const hook = source('src/hooks/useFocusThreads.ts');
    expect(hook).toContain("socket.emit('focus:list', { domain, orgId: orgId || undefined }");
    expect(hook).toContain("socket.on('connect', refresh)");
    expect(hook).toContain("socket.on('agent:progress', scheduleRefresh)");
    expect(hook).toContain("socket.on('audio:work_progress', scheduleRefresh)");
    expect(hook).not.toContain('userId:');
  });

  it('shows the evidence-backed focus inside the unified command-center chat surface', () => {
    const chat = source('src/components/AgentChatPage.tsx');
    const panel = source('src/components/FocusThreadPanel.tsx');
    expect(chat).toContain('useFocusThreads({');
    expect(chat).toContain('<FocusThreadPanel');
    expect(chat).toContain('variant="strip"');
    expect(panel).toContain('thread.evidenceTaskId');
    expect(panel).toContain('thread.waitingFor');
    expect(panel).toContain('thread.resumePoint');
  });

  it('binds chat, task, and voice work to the durable commitment record', () => {
    for (const file of ['server/socket/chat.ts', 'server/socket/task.ts', 'server/socket/voice.ts']) {
      const contents = source(file);
      expect(contents).toContain('updateConversationActionFocus({');
      expect(contents).toContain('commitment: actionTaskExecution.state.goal');
    }
  });
});
