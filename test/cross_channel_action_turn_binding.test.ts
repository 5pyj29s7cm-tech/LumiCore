import { readImplementationSource } from './implementation_source';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const source = (relativePath: string) => readImplementationSource(path.join(process.cwd(), relativePath), 'utf8');

describe('cross-channel action turn ownership wiring', () => {
  it('persists and binds the exact voice transcript before action preparation', () => {
    const voice = source('server/socket/voice.ts');
    const persisted = voice.indexOf('voiceUserMessageId = writeVoiceMessage({');
    const admission = voice.indexOf('const voiceAdmission = await admitAcceptedUserTurnDurably({', persisted);
    const admittedPersist = voice.indexOf('persistAcceptedUserTurn: () => { turnAuthorization.assertCurrent(); return persistVoiceUserMessage(); },', admission);
    const flushed = voice.indexOf('flush: flushDBOrThrow', admittedPersist);
    const accepted = voice.indexOf('voiceUserMessageId = voiceAdmission.persisted;', flushed);
    const prepared = voice.indexOf('preparePlannedConversationExecution({', accepted);
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
    const prepared = messaging.indexOf('preparePlannedConversationExecution({', routed);
    const rejected = messaging.indexOf("if ('bindingFailure' in actionTaskExecution)", prepared);

    expect(persisted).toBeGreaterThan(-1);
    expect(accepted).toBeGreaterThan(persisted);
    expect(messaging.slice(persisted, accepted)).toContain('requestId,');
    expect(messaging.slice(accepted, routed)).toContain('userMessageId: persisted?.messageId');
    expect(messaging.slice(routed, prepared)).toContain('userMessageId: routeBaseMessage.userMessageId');
    expect(messaging.slice(prepared, rejected)).toContain("userMessageId: msg.userMessageId || ''");
    expect(rejected).toBeGreaterThan(prepared);
  });

  it('carries durable receipts through every single-core recovery path', () => {
    const chat = source('server/socket/chat.ts');
    const voice = source('server/socket/voice.ts');
    const messaging = source('server/regions/packs/cn/messaging_routes.ts');

    expect(chat).toContain('await runLumiEntryTurn<void>({');
    expect(voice).toContain('await runLumiEntryTurn<void>({');
    expect(messaging).toContain('return runLumiEntryTurn({');
    expect(readFileSync('server/cognition/turn_execution.ts', 'utf8')).toContain('await runPreparedLumiTurn({');
    const driver = readFileSync('server/cognition/prepared_turn.ts', 'utf8');
    expect(driver).toContain('attempt: async recovery =>');
    expect(driver).toContain('await runResolvedLumiRecovery({ model, responseText, recovery })');
    const recoveryOwner = readFileSync('server/cognition/turn_recovery.ts', 'utf8');
    expect(recoveryOwner).toContain('priorToolRecords: recovery.priorToolRecords');
    expect(recoveryOwner).toContain('completionGuard: result.completionGuard');
    const messagingModel = readFileSync('server/regions/packs/cn/messaging_turn/model_execution.ts', 'utf8');
    expect(messagingModel).toContain('projectRecords: records => currentMessagingFinalizationRecords({');
    expect(messagingModel).toContain('context.taskAwareRecords(mergeToolExecutionRecords(context.toolRecords, records))');
    expect(messagingModel).not.toContain('runResolvedLumiRecovery(');
  });

  it('starts a fail-closed lease heartbeat after preparation in every foreground channel', () => {
    const channels = [
      {
        name: 'chat',
        code: source('server/socket/chat.ts'),
        prepare: 'const actionTaskExecution = preparePlannedConversationExecution({',
        heartbeat: 'actionLeaseHeartbeat = startConversationActionExecutionHeartbeat({',
        abort: 'abortController,',
        stop: 'actionLeaseHeartbeat?.stop();',
      },
      {
        name: 'voice',
        code: source('server/socket/voice.ts'),
        prepare: 'const actionTaskExecution = preparePlannedConversationExecution({',
        heartbeat: 'actionLeaseHeartbeat = startConversationActionExecutionHeartbeat({',
        abort: 'abortController: pipelineAbort,',
        stop: 'actionLeaseHeartbeat?.stop();',
      },
      {
        name: 'messaging',
        code: source('server/regions/packs/cn/messaging_routes.ts'),
        prepare: 'const actionTaskExecution = preparePlannedConversationExecution({',
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
    expect(channels[2].code).toContain('signal: actionAbortController.signal');
    expect(channels[2].code).toContain('isCancelled: actionWasCancelled');
  });
});
