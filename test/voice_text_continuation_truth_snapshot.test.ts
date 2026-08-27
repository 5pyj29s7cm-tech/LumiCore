import crypto from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  buildVoiceTextContinuationTruthFromSources,
  createVoiceTextContinuationTruthAttester,
  verifyVoiceTextContinuationTruthEnvelope,
} from '../server/evidence/voice_text_continuation_truth';
import {
  stableTaskRegressionProbeJson,
  validateVoiceTextContinuationTruth,
} from '../scripts/lib/task-regression-black-box-runner.mjs';

const RUN_ID = 'task_regression_candidate_s6_server_truth';
const BUILD_DIGEST = 'a'.repeat(64);
const USER_ID = 's6-server-truth-user';
const CONVERSATION_ID = 's6-server-truth-conversation';
const TASK_ID = 's6-server-truth-task';
const VOICE_REQUEST_ID = 's6-server-truth-voice-request';
const TEXT_REQUEST_ID = 's6-server-truth-text-request';
const MISSING_PATH = String.raw`D:\s6-sandbox\Desktop\missing-report.txt`;
const CORRECT_PATH = String.raw`D:\s6-sandbox\Desktop\correct-report.txt`;
const VOICE_TIME = '2026-08-27T00:01:00.000Z';
const CORRECTION_TIME = '2026-08-27T00:02:00.000Z';
const TEXT_TIME = '2026-08-27T00:03:00.000Z';

function digest(value: string): string {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

function fixtureDb(): any {
  return {
    conversations: [{ id: CONVERSATION_ID, userId: USER_ID }],
    conversationActionTasks: [{
      id: TASK_ID,
      conversationId: CONVERSATION_ID,
      userId: USER_ID,
      status: 'completed',
      revision: 2,
      context: {
        actionState: {
          taskCapsule: {
            schemaVersion: 1,
            taskId: TASK_ID,
            revision: 2,
            status: 'completed',
            unfinished: false,
            target: { path: CORRECT_PATH, object: 'correct-report.txt' },
            latestCorrection: {
              text: '不是 missing-report.txt，而是 correct-report.txt。',
              previousTarget: MISSING_PATH,
              replacementTarget: CORRECT_PATH,
              observedAt: CORRECTION_TIME,
            },
            rejectedTargets: [{
              identity: MISSING_PATH,
              reason: 'Rejected by explicit user correction',
              observedAt: CORRECTION_TIME,
            }],
          },
        },
      },
    }],
    conversationActionTurns: [{
      id: 's6-voice-turn-record',
      conversationId: CONVERSATION_ID,
      userId: USER_ID,
      taskId: TASK_ID,
      requestId: VOICE_REQUEST_ID,
      channel: 'voice',
      source: 'voice',
      status: 'terminal',
      terminalReason: 'task_outcome:blocked',
      userMessageId: 's6-voice-user-message',
      terminalMessageId: 's6-voice-assistant-message',
      createdAt: '2026-08-27T00:00:00.000Z',
      updatedAt: VOICE_TIME,
    }, {
      id: 's6-text-turn-record',
      conversationId: CONVERSATION_ID,
      userId: USER_ID,
      taskId: TASK_ID,
      requestId: TEXT_REQUEST_ID,
      channel: 'chat',
      source: 'task-regression-black-box',
      status: 'terminal',
      terminalReason: 'task_outcome:completed',
      userMessageId: 's6-text-user-message',
      terminalMessageId: 's6-text-assistant-message',
      createdAt: CORRECTION_TIME,
      updatedAt: TEXT_TIME,
    }],
    conversationActionReceipts: [{
      id: 's6-voice-read-receipt',
      conversationId: CONVERSATION_ID,
      taskId: TASK_ID,
      requestId: VOICE_REQUEST_ID,
      toolName: 'read_file',
      outcome: 'failed',
      inputDigest: digest(`read:${MISSING_PATH}`),
      targetIdentity: MISSING_PATH,
      createdAt: '2026-08-27T00:00:30.000Z',
    }, {
      id: 's6-text-read-receipt',
      conversationId: CONVERSATION_ID,
      taskId: TASK_ID,
      requestId: TEXT_REQUEST_ID,
      toolName: 'read_file',
      outcome: 'verified_success',
      inputDigest: digest(`read:${CORRECT_PATH}`),
      targetIdentity: CORRECT_PATH,
      createdAt: '2026-08-27T00:02:30.000Z',
    }],
    interactions: [{
      id: 's6-voice-user-message',
      userId: USER_ID,
      conversationId: CONVERSATION_ID,
      requestId: VOICE_REQUEST_ID,
      role: 'user',
      source: 'voice',
      channel: 'voice',
      mode: 'voice',
      audioInputKind: 'synthetic_accepted_transcript',
      syntheticAudio: true,
      captureSessionId: '',
      sttReceiptId: '',
      contextChainId: '',
      previousRequestId: '',
      nativeDeviceId: '',
      executionSessionId: '',
      nativeClientIdentitySha256: '',
      message: `[LUMI_REGRESSION:S6:VOICE] 请读取 ${MISSING_PATH}`,
      timestamp: '2026-08-27T00:00:00.000Z',
    }, {
      id: 's6-voice-assistant-message',
      userId: USER_ID,
      conversationId: CONVERSATION_ID,
      requestId: VOICE_REQUEST_ID,
      role: 'assistant',
      source: 'voice',
      channel: 'voice',
      message: '没有找到该文件。',
      timestamp: VOICE_TIME,
    }, {
      id: 's6-text-user-message',
      userId: USER_ID,
      conversationId: CONVERSATION_ID,
      requestId: TEXT_REQUEST_ID,
      role: 'user',
      source: 'task-regression-black-box',
      channel: 'chat',
      cognitiveIntent: 'task_correction',
      message: '纠正一下：不是 missing-report.txt，而是 correct-report.txt。',
      timestamp: CORRECTION_TIME,
    }, {
      id: 's6-text-assistant-message',
      userId: USER_ID,
      conversationId: CONVERSATION_ID,
      requestId: TEXT_REQUEST_ID,
      role: 'assistant',
      source: 'task-regression-black-box',
      channel: 'chat',
      message: '已读取正确文件。',
      timestamp: TEXT_TIME,
    }],
  };
}

function build(db = fixtureDb()) {
  return buildVoiceTextContinuationTruthFromSources({
    db,
    scenarioId: 'voice_to_text_continuation',
    acceptanceRunId: RUN_ID,
    buildIdentityDigest: BUILD_DIGEST,
    userId: USER_ID,
    conversationId: CONVERSATION_ID,
    textRequestId: TEXT_REQUEST_ID,
    taskId: TASK_ID,
    capturedAt: '2026-08-27T00:04:00.000Z',
  });
}

describe('server-derived Voice to Text continuation truth', () => {
  it('binds the exact persisted synthetic Voice failure to one corrected Text success', () => {
    const truth = build();
    expect(truth).toMatchObject({
      kind: 'lumi.voice-text-continuation-truth',
      schemaVersion: 1,
      acceptanceRunId: RUN_ID,
      buildIdentityDigest: BUILD_DIGEST,
      conversationId: CONVERSATION_ID,
      task: { taskId: TASK_ID, revision: 2, finalStatus: 'completed' },
      voiceStart: {
        request: { requestId: VOICE_REQUEST_ID, terminalStatus: 'blocked' },
        capture: {
          captureMode: 'synthetic_accepted_transcript',
          audioInputKind: 'synthetic_accepted_transcript',
          syntheticAudio: true,
          nativeDeviceId: null,
        },
        receipt: { outcome: 'failed', toolName: 'read_file' },
      },
      textContinue: {
        request: { requestId: TEXT_REQUEST_ID, terminalStatus: 'completed' },
        receipt: { outcome: 'verified_success', toolName: 'read_file' },
      },
      channelHandoff: {
        sourceRequestId: VOICE_REQUEST_ID,
        targetRequestId: TEXT_REQUEST_ID,
        sourceTaskId: TASK_ID,
        targetTaskId: TASK_ID,
      },
      targetCorrection: {
        previousTarget: MISSING_PATH,
        replacementTarget: CORRECT_PATH,
        rejectedTargetSha256: digest(MISSING_PATH),
        previousTaskTargetSha256: digest(MISSING_PATH),
        replacementTaskTargetSha256: digest(CORRECT_PATH),
      },
      evidenceDigestSha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
    });
  });

  it.each([
    ['missing synthetic marker', (db: any) => { delete db.interactions[0].syntheticAudio; }, 'voice_text_truth_voice_provenance_invalid'],
    ['partial native tuple', (db: any) => { db.interactions[0].nativeDeviceId = 'device-forged'; }, 'voice_text_truth_voice_provenance_invalid'],
    ['physical provenance', (db: any) => {
      db.interactions[0].audioInputKind = 'physical_microphone';
      db.interactions[0].syntheticAudio = false;
    }, 'voice_text_truth_voice_provenance_invalid'],
    ['third related turn', (db: any) => {
      db.conversationActionTurns.push({
        ...db.conversationActionTurns[1],
        id: 's6-injected-third-turn',
        requestId: 's6-injected-third-request',
      });
    }, 'voice_text_truth_task_turn_cardinality_invalid'],
    ['wrong historical Voice outcome', (db: any) => {
      db.conversationActionTurns[0].terminalReason = 'assistant_terminal';
    }, 'voice_text_truth_voice_blocked_state_missing'],
    ['duplicate read receipt', (db: any) => {
      db.conversationActionReceipts.push({
        ...db.conversationActionReceipts[1],
        id: 's6-duplicate-text-read-receipt',
      });
    }, 'voice_text_truth_text_read_receipt_missing_ambiguous'],
    ['capsule revision mismatch', (db: any) => {
      db.conversationActionTasks[0].context.actionState.taskCapsule.revision = 1;
    }, 'voice_text_truth_persisted_capsule_revision_invalid'],
    ['additional rejected target', (db: any) => {
      db.conversationActionTasks[0].context.actionState.taskCapsule.rejectedTargets.push({
        identity: String.raw`D:\s6-sandbox\Desktop\another.txt`,
        reason: 'unrelated',
        observedAt: CORRECTION_TIME,
      });
    }, 'voice_text_truth_persisted_rejected_target_invalid'],
  ])('fails closed for %s', (_label, mutate, code) => {
    const db = fixtureDb();
    mutate(db);
    expect(() => build(db)).toThrow(code);
  });

  it('rejects a same-basename target in another directory', () => {
    const db = fixtureDb();
    db.conversationActionTasks[0].context.actionState.taskCapsule.latestCorrection.previousTarget =
      String.raw`D:\s6-sandbox\Archive\missing-report.txt`;
    expect(() => build(db)).toThrow('voice_text_truth_persisted_previous_target_invalid');
  });

  it('keeps the runner fail-closed on a forged canonical join even with a recomputed digest', () => {
    const expected = {
      acceptanceRunId: RUN_ID,
      buildIdentityDigest: BUILD_DIGEST,
      conversationId: CONVERSATION_ID,
      taskId: TASK_ID,
      voiceRequestId: VOICE_REQUEST_ID,
      textRequestId: TEXT_REQUEST_ID,
      previousTarget: MISSING_PATH,
      replacementTarget: CORRECT_PATH,
    };
    expect(validateVoiceTextContinuationTruth(build(), expected)).toMatchObject({ ok: true });

    const forged = structuredClone(build()) as any;
    forged.targetCorrection.previousTarget = String.raw`D:\other-directory\missing-report.txt`;
    const { evidenceDigestSha256: _oldDigest, ...withoutDigest } = forged;
    forged.evidenceDigestSha256 = digest(stableTaskRegressionProbeJson(withoutDigest));
    expect(validateVoiceTextContinuationTruth(forged, expected)).toMatchObject({
      ok: false,
      issues: expect.arrayContaining(['targetCorrection:binding_invalid']),
    });
  });

  it('detaches one backend-only Ed25519 signature bound to run, build, data root, and instance', () => {
    const attester = createVoiceTextContinuationTruthAttester({
      acceptanceRunId: RUN_ID,
      buildIdentityDigest: BUILD_DIGEST,
      dataRootIdentitySha256: 'b'.repeat(64),
    });
    const envelope = attester.attest(build());
    expect(attester.descriptor).toMatchObject({
      kind: 'lumi.voice-text-continuation-truth-signer',
      algorithm: 'ed25519',
      acceptanceRunId: RUN_ID,
      buildIdentityDigest: BUILD_DIGEST,
      dataRootIdentitySha256: 'b'.repeat(64),
    });
    expect(Object.keys(attester.descriptor)).not.toContain('privateKey');
    expect(verifyVoiceTextContinuationTruthEnvelope(envelope, attester.descriptor)).toBe(true);

    const forged = structuredClone(envelope);
    forged.truth.targetCorrection.previousTarget = String.raw`D:\forged\missing-report.txt`;
    expect(verifyVoiceTextContinuationTruthEnvelope(forged, attester.descriptor)).toBe(false);

    const replacement = createVoiceTextContinuationTruthAttester({
      acceptanceRunId: RUN_ID,
      buildIdentityDigest: BUILD_DIGEST,
      dataRootIdentitySha256: 'b'.repeat(64),
    });
    expect(verifyVoiceTextContinuationTruthEnvelope(envelope, replacement.descriptor)).toBe(false);
  });

  it.each([
    ['task recordId drift', (truth: any) => { truth.task.recordId = 'forged-task-record'; },
      'voice_text_truth_task_record_binding_invalid'],
    ['receipt recordId drift', (truth: any) => {
      truth.textContinue.receipt.recordId = 'forged-receipt-record';
    }, 'voice_text_truth_receipt_record_binding_invalid'],
    ['non-canonical capturedAt', (truth: any) => {
      truth.capturedAt = '2026-08-27T00:04:00Z';
    }, 'voice_text_truth_capture_time_invalid'],
  ])('refuses to attest %s', (_label, mutate, code) => {
    const attester = createVoiceTextContinuationTruthAttester({
      acceptanceRunId: RUN_ID,
      buildIdentityDigest: BUILD_DIGEST,
      dataRootIdentitySha256: 'b'.repeat(64),
    });
    const truth = structuredClone(build()) as any;
    mutate(truth);
    const { evidenceDigestSha256: _oldDigest, ...withoutDigest } = truth;
    truth.evidenceDigestSha256 = digest(stableTaskRegressionProbeJson(withoutDigest));
    expect(() => attester.attest(truth)).toThrow(code);
  });
});
