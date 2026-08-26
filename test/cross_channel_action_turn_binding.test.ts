import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const source = (relativePath: string) => readFileSync(path.join(process.cwd(), relativePath), 'utf8');

describe('cross-channel action turn ownership wiring', () => {
  it('persists and binds the exact task socket transcript before action preparation', () => {
    const task = source('server/socket/task.ts');
    const persisted = task.indexOf('const taskUserMessageId = addMessageIdempotent({');
    const prepared = task.indexOf('const actionTaskExecution = prepareConversationActionExecution({', persisted);
    const rejected = task.indexOf("if ('bindingFailure' in actionTaskExecution)", prepared);

    expect(persisted).toBeGreaterThan(-1);
    expect(task.slice(persisted, prepared)).toContain('deferActionPreparation: true');
    expect(task).toContain('.filter(message => message.id !== taskUserMessageId)');
    expect(task.slice(prepared, rejected)).toContain('userMessageId: taskUserMessageId');
    expect(rejected).toBeGreaterThan(prepared);
  });

  it('persists and binds the exact voice transcript before action preparation', () => {
    const voice = source('server/socket/voice.ts');
    const persisted = voice.indexOf('voiceUserMessageId = addMessageIdempotent({');
    const accepted = voice.indexOf('persistVoiceUserMessage();', persisted);
    const prepared = voice.indexOf('prepareConversationActionExecution({', accepted);
    const rejected = voice.indexOf("if ('bindingFailure' in actionTaskExecution)", prepared);

    expect(persisted).toBeGreaterThan(-1);
    expect(accepted).toBeGreaterThan(persisted);
    expect(voice.slice(persisted, accepted)).toContain('deferActionPreparation: true');
    expect(voice.slice(prepared, rejected)).toContain('userMessageId: voiceUserMessageId');
    expect(rejected).toBeGreaterThan(prepared);
  });

  it('carries the exact remote transcript identity through enrichment and rejects binding failure', () => {
    const messaging = source('server/regions/packs/cn/messaging_routes.ts');
    const persisted = messaging.indexOf('const messageId = addMessageIdempotent({');
    const routed = messaging.indexOf('const routeBaseMessage: IncomingMessage = {', persisted);
    const prepared = messaging.indexOf('prepareConversationActionExecution({', routed);
    const rejected = messaging.indexOf("if ('bindingFailure' in actionTaskExecution)", prepared);

    expect(persisted).toBeGreaterThan(-1);
    expect(messaging.slice(persisted, routed)).toContain('requestId,');
    expect(messaging.slice(routed, prepared)).toContain('userMessageId: persistedUserMessage?.messageId');
    expect(messaging.slice(prepared, rejected)).toContain("userMessageId: msg.userMessageId || ''");
    expect(rejected).toBeGreaterThan(prepared);
  });

  it('passes the exact persisted execution graph on every non-background recovery path', () => {
    const task = source('server/socket/task.ts');
    const voice = source('server/socket/voice.ts');
    const messaging = source('server/regions/packs/cn/messaging_routes.ts');

    expect(task).toContain('resumeExecutionGraph: taskModelRecovery?.graph');
    expect(voice).toContain('resumeExecutionGraph: voiceModelRecovery?.graph');
    expect(messaging).toContain('resumeExecutionGraph: recovery?.graph');
  });
});
