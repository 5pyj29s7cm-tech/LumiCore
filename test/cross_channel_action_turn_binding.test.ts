import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const source = (relativePath: string) => readFileSync(path.join(process.cwd(), relativePath), 'utf8');

describe('cross-channel action turn ownership wiring', () => {
  it('persists and binds the exact task socket transcript before action preparation', () => {
    const task = source('server/socket/task.ts');
    const admission = task.indexOf('const taskAdmission = await admitAcceptedUserTurnDurably({');
    const persisted = task.indexOf('persistAcceptedUserTurn: () => addMessageIdempotent({', admission);
    const flushed = task.indexOf('flush: flushDBOrThrow', persisted);
    const accepted = task.indexOf('const taskUserMessageId = taskAdmission.persisted;', flushed);
    const prepared = task.indexOf('const actionTaskExecution = prepareConversationActionExecution({', accepted);
    const rejected = task.indexOf("if ('bindingFailure' in actionTaskExecution)", prepared);

    expect(admission).toBeGreaterThan(-1);
    expect(persisted).toBeGreaterThan(-1);
    expect(flushed).toBeGreaterThan(persisted);
    expect(accepted).toBeGreaterThan(flushed);
    expect(task.slice(persisted, prepared)).toContain('deferActionPreparation: true');
    expect(task).toContain('.filter(message => message.id !== taskUserMessageId)');
    expect(task.slice(prepared, rejected)).toContain('userMessageId: taskUserMessageId');
    expect(rejected).toBeGreaterThan(prepared);
  });

  it('persists and binds the exact voice transcript before action preparation', () => {
    const voice = source('server/socket/voice.ts');
    const persisted = voice.indexOf('voiceUserMessageId = addMessageIdempotent({');
    const admission = voice.indexOf('const voiceAdmission = await admitAcceptedUserTurnDurably({', persisted);
    const admittedPersist = voice.indexOf('persistAcceptedUserTurn: () => persistVoiceUserMessage()', admission);
    const flushed = voice.indexOf('flush: flushDBOrThrow', admittedPersist);
    const accepted = voice.indexOf('voiceUserMessageId = voiceAdmission.persisted;', flushed);
    const prepared = voice.indexOf('prepareConversationActionExecution({', accepted);
    const rejected = voice.indexOf("if ('bindingFailure' in actionTaskExecution)", prepared);

    expect(persisted).toBeGreaterThan(-1);
    expect(admission).toBeGreaterThan(persisted);
    expect(admittedPersist).toBeGreaterThan(admission);
    expect(flushed).toBeGreaterThan(admittedPersist);
    expect(accepted).toBeGreaterThan(flushed);
    expect(voice.slice(persisted, admittedPersist)).toContain('deferActionPreparation: true');
    expect(voice.slice(prepared, rejected)).toContain('userMessageId: voiceUserMessageId');
    expect(rejected).toBeGreaterThan(prepared);
  });

  it('carries the exact durable remote transcript identity through enrichment and rejects binding failure', () => {
    const messaging = source('server/regions/packs/cn/messaging_routes.ts');
    const persisted = messaging.indexOf('const messageId = addMessageIdempotent({');
    const accepted = messaging.indexOf('const acceptedMessage: IncomingMessage = {', persisted);
    const routed = messaging.indexOf('const routeBaseMessage = accepted.message', accepted);
    const prepared = messaging.indexOf('prepareConversationActionExecution({', routed);
    const rejected = messaging.indexOf("if ('bindingFailure' in actionTaskExecution)", prepared);

    expect(persisted).toBeGreaterThan(-1);
    expect(accepted).toBeGreaterThan(persisted);
    expect(messaging.slice(persisted, accepted)).toContain('requestId,');
    expect(messaging.slice(accepted, routed)).toContain('userMessageId: persisted?.messageId');
    expect(messaging.slice(routed, prepared)).toContain('userMessageId: routeBaseMessage.userMessageId');
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

  it('starts a fail-closed lease heartbeat after preparation in every foreground channel', () => {
    const channels = [
      {
        name: 'chat',
        code: source('server/socket/chat.ts'),
        prepare: 'const actionTaskExecution = bindsExistingAction',
        heartbeat: 'actionLeaseHeartbeat = startConversationActionExecutionHeartbeat({',
        abort: 'abortController,',
        stop: 'actionLeaseHeartbeat?.stop();',
      },
      {
        name: 'task',
        code: source('server/socket/task.ts'),
        prepare: 'const actionTaskExecution = prepareConversationActionExecution({',
        heartbeat: 'actionLeaseHeartbeat = startConversationActionExecutionHeartbeat({',
        abort: 'abortController: taskAbortController,',
        stop: 'actionLeaseHeartbeat?.stop();',
      },
      {
        name: 'voice',
        code: source('server/socket/voice.ts'),
        prepare: 'const actionTaskExecution = turnFlow.conceptualCapabilityQuestion',
        heartbeat: 'actionLeaseHeartbeat = startConversationActionExecutionHeartbeat({',
        abort: 'abortController: pipelineAbort,',
        stop: 'actionLeaseHeartbeat?.stop();',
      },
      {
        name: 'messaging',
        code: source('server/regions/packs/cn/messaging_routes.ts'),
        prepare: 'const actionTaskExecution = isIdentityBound && conversation',
        heartbeat: '? startConversationActionExecutionHeartbeat({',
        abort: 'abortController: actionAbortController,',
        stop: 'actionLeaseHeartbeat?.stop();',
      },
    ];

    for (const channel of channels) {
      const prepared = channel.code.indexOf(channel.prepare);
      const heartbeat = channel.code.indexOf(channel.heartbeat, prepared);
      const abort = channel.code.indexOf(channel.abort, heartbeat);
      const stop = channel.code.indexOf(channel.stop);
      expect(prepared, `${channel.name} preparation`).toBeGreaterThan(-1);
      expect(heartbeat, `${channel.name} heartbeat`).toBeGreaterThan(prepared);
      expect(abort, `${channel.name} heartbeat abort controller`).toBeGreaterThan(heartbeat);
      expect(stop, `${channel.name} heartbeat stop`).toBeGreaterThan(-1);
    }

    expect(channels[0].code).toContain('recordChatExecutionPersistenceUnknownDurably(');
    expect(channels[1].code).toContain('recordChatExecutionPersistenceUnknownDurably(');
    expect(channels[2].code).toContain('recordChatExecutionPersistenceUnknownDurably(');
    expect(channels[3].code).toContain('signal: actionAbortController.signal');
    expect(channels[3].code).toContain('isCancelled: actionWasCancelled');
  });
});
