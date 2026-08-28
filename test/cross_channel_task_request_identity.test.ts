import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const source = (relativePath: string) => readFileSync(path.join(process.cwd(), relativePath), 'utf8');

describe('foreground task and request identity wiring', () => {
  it('prepares a durable Chat task before relay creation and preserves request identity separately', () => {
    const chat = source('server/socket/chat.ts');
    const fresh = chat.indexOf('const preparesFreshAction = Boolean(');
    const prepare = chat.indexOf('prepareConversationActionExecution({', fresh);
    const durable = chat.indexOf('const durableTaskId = actionTaskExecution.state?.taskId;', prepare);
    const relay = chat.indexOf('const desktopRelay = createDesktopRelay({', durable);
    const confirmation = chat.indexOf("source: 'chat_confirmation'", relay);
    const confirmationContext = chat.slice(chat.lastIndexOf('context: {', confirmation), confirmation);

    expect(fresh).toBeGreaterThan(-1);
    expect(chat.slice(fresh, durable)).toContain('executionPipeline.capabilityPlan.taskLedgerRequired');
    expect(chat.slice(fresh, durable)).toContain('forceTask: true');
    expect(chat.slice(prepare, durable)).toContain("if ('bindingFailure' in actionTaskExecution)");
    expect(relay).toBeGreaterThan(durable);
    expect(chat.slice(relay, relay + 500)).toContain('taskId: durableTaskId');
    expect(confirmationContext).toContain('taskId: durableTaskId');
    expect(confirmationContext).toContain('turnId: requestId');
    expect(confirmationContext).toContain('requestId,');
  });

  it('never substitutes a transport request id for a prepared task id in Chat, Task, or Voice', () => {
    for (const relativePath of [
      'server/socket/chat.ts',
      'server/socket/task.ts',
      'server/socket/voice.ts',
    ]) {
      const code = source(relativePath);
      expect(code, relativePath).not.toMatch(/taskId:\s*requestId\b/);
      expect(code, relativePath).not.toMatch(
        /taskId:\s*actionTaskExecution\.state\?\.taskId\s*\|\|\s*requestId/,
      );
    }
  });

  it('binds Task and Voice desktop relays to their prepared durable task', () => {
    for (const relativePath of ['server/socket/task.ts', 'server/socket/voice.ts']) {
      const code = source(relativePath);
      const prepare = code.indexOf('prepareConversationActionExecution({');
      const relay = code.indexOf('const desktopRelay = createDesktopRelay({', prepare);
      expect(prepare, `${relativePath} preparation`).toBeGreaterThan(-1);
      expect(relay, `${relativePath} relay`).toBeGreaterThan(prepare);
      expect(code.slice(prepare, relay), relativePath).toContain('forceTask:');
      expect(code.slice(relay, relay + 500), relativePath).toContain(
        'taskId: actionTaskExecution.state?.taskId',
      );
    }
  });
});
