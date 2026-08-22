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

  it('projects active durable focus into the transient task widget instead of the chat stream', () => {
    const chat = source('src/components/AgentChatPage.tsx');
    const widget = source('src/components/ActiveTaskWidget.tsx');
    expect(chat).toContain('useFocusThreads({');
    expect(chat).toContain('<ActiveTaskWidget');
    expect(chat).toContain('focusThreads={focusThreads}');
    expect(chat).not.toContain('<FocusThreadPanel');
    expect(widget).toContain('primaryThread?.goal');
    expect(widget).toContain('primaryThread?.waitingFor');
    expect(widget).toContain('primaryThread?.nextAction');
  });

  it('binds explicit task channels to durable focus without prebuilding Chat tasks', () => {
    for (const file of ['server/socket/task.ts', 'server/socket/voice.ts']) {
      const contents = source(file);
      expect(contents).toContain('updateConversationActionFocus({');
    }

    const chat = source('server/socket/chat.ts');
    const manager = source('server/conversation/manager.ts');
    expect(chat).not.toContain('updateConversationActionFocus({');
    expect(manager).toContain("msg.taskIntent === 'task'");
    expect(manager).toContain('hasDurableCapabilityReceipt');
    expect(manager).toContain('never creates a durable task');
  });
});
