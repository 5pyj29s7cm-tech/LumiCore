import { readImplementationSource } from './implementation_source';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const source = (relativePath: string) => readImplementationSource(path.join(process.cwd(), relativePath), 'utf8');

describe('foreground task and request identity wiring', () => {
  it('prepares a durable Chat task before relay creation and preserves request identity separately', () => {
    const chat = source('server/socket/chat.ts');
    const fresh = chat.indexOf('const actionTaskExecution = preparePlannedConversationExecution({');
    const prepare = fresh;
    const durable = chat.indexOf('const durableTaskId = actionTaskExecution.state?.taskId;', prepare);
    const relay = chat.indexOf('const desktopRelay = createDesktopRelay({', durable);
    const confirmation = chat.indexOf("source: 'chat_confirmation'", relay);
    const confirmationContext = chat.slice(chat.lastIndexOf('context: {', confirmation), confirmation);
    const contextStart = chat.indexOf('const toolContext: ToolContext = {', relay);
    const admittedContext = chat.slice(contextStart, chat.indexOf('\n      };', contextStart));

    expect(fresh).toBeGreaterThan(-1);
    const taskOwner = readFileSync('server/conversation/planned_execution.ts', 'utf8');
    expect(chat.slice(fresh, durable)).toContain('execution: executionPipeline');
    expect(taskOwner).toContain('execution.capabilityPlan.taskLedgerRequired');
    expect(taskOwner).toContain('forceTask, forceResume:');
    expect(chat.slice(prepare, durable)).toContain("if ('bindingFailure' in actionTaskExecution)");
    expect(relay).toBeGreaterThan(durable);
    expect(chat.slice(relay, relay + 500)).toContain('taskId: durableTaskId');
    expect(contextStart).toBeGreaterThan(relay);
    expect(contextStart).toBeLessThan(confirmation);
    expect(admittedContext).toContain('taskId: durableTaskId');
    expect(admittedContext).toContain('turnId: requestId');
    expect(admittedContext).toContain('turnRowId: actionTaskExecution.turnRowId');
    expect(admittedContext).toContain('requestId,');
    expect(confirmationContext).toContain('...toolContext');
  });

  it('never substitutes a transport request id for a prepared task id in Chat, Task, or Voice', () => {
    for (const relativePath of [
      'server/socket/chat.ts',
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
    for (const relativePath of ['server/socket/voice.ts']) {
      const code = source(relativePath);
      const prepare = code.indexOf('preparePlannedConversationExecution({');
      const relay = code.indexOf('const desktopRelay = createDesktopRelay({', prepare);
      expect(prepare, `${relativePath} preparation`).toBeGreaterThan(-1);
      expect(relay, `${relativePath} relay`).toBeGreaterThan(prepare);
      expect(code.slice(prepare, relay), relativePath).toContain('execution: executionPipeline');
      expect(code.slice(relay, relay + 500), relativePath).toContain(
        'taskId: actionTaskExecution.state?.taskId',
      );
    }
  });
});
