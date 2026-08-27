import crypto from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  createSignedPortableBuildIdentity,
  createSignedPortableManifest,
} from '../scripts/lib/portable-evidence-comparison.mjs';
import {
  portableEvidenceHmacKeyId,
  portableEvidenceSha256,
  signPortableEvidenceRecord,
} from '../scripts/lib/portable-external-evidence.mjs';
import { createPortablePairedManifestCores } from '../scripts/lib/portable-paired-runner.mjs';
import {
  PORTABLE_TRUTH_V2_EXECUTOR_WIRING_CONTRACT,
  adaptPortablePairedEvidenceToTruthV2,
  createSignedPortableTruthV2ChannelRecord,
  portableTaskRegressionCanonicalPathHmac,
  taskRegressionTruthV2ProfileSha256,
  validatePortablePairedEvidenceForTruthV2,
} from '../scripts/lib/portable-task-regression-truth-v2-adapter.mjs';
import {
  TASK_REGRESSION_V2_SCENARIO_IDS,
  TASK_REGRESSION_V2_SCENARIO_PROFILES,
} from '../scripts/lib/task-regression-truth-v2.mjs';
import {
  createVoiceTextContinuationTruthAttester,
} from '../server/evidence/voice_text_continuation_truth';

const BASELINE_KEY = Buffer.alloc(32, 0x51);
const CANDIDATE_KEY = Buffer.alloc(32, 0x52);
const NOW = '2026-08-27T12:00:00.000Z';
const TEST_ONLY_SERVER_ATTESTERS = new WeakMap<object, any>();

function digest(value: unknown) {
  return crypto.createHash('sha256').update(String(value), 'utf8').digest('hex');
}

function stableS6Json(value: any): string {
  if (Array.isArray(value)) return JSON.stringify(value.map(item => JSON.parse(stableS6Json(item))));
  if (!value || typeof value !== 'object') return JSON.stringify(value);
  return JSON.stringify(Object.fromEntries(Object.keys(value).sort().map(key => [
    key,
    JSON.parse(stableS6Json(value[key])),
  ])));
}

function buildIdentity(role: 'baseline' | 'candidate', key: Buffer) {
  return createSignedPortableBuildIdentity({
    kind: 'lumi.portable-build-identity',
    schemaVersion: 1,
    role,
    revision: (role === 'baseline' ? '1' : '2').repeat(40),
    sourceDirty: false,
    sourceFingerprintSha256: digest(`${role}:source`),
    runtimeFingerprintSha256: digest(`${role}:runtime`),
    collectedAt: role === 'baseline' ? NOW : '2026-08-27T12:01:00.000Z',
  }, key);
}

function phaseContracts() {
  return TASK_REGRESSION_V2_SCENARIO_IDS.flatMap(scenarioId => (
    TASK_REGRESSION_V2_SCENARIO_PROFILES[scenarioId].phases.map((phase: any, index: number) => ({
      scenarioId,
      phaseId: phase.phaseId,
      phase,
      turnOrdinal: index + 1,
    }))
  ));
}

function createFixture() {
  const baselineBuild = buildIdentity('baseline', BASELINE_KEY);
  const candidateBuild = buildIdentity('candidate', CANDIDATE_KEY);
  const baselineDataRootIdentitySha256 = digest('baseline-data-root');
  const candidateDataRootIdentitySha256 = digest('candidate-data-root');
  const testOnlyServerAttesters = {
    baseline: createVoiceTextContinuationTruthAttester({
      acceptanceRunId: 'truth-v2-baseline-run',
      buildIdentityDigest: baselineBuild.buildIdentityDigest,
      dataRootIdentitySha256: baselineDataRootIdentitySha256,
    }),
    candidate: createVoiceTextContinuationTruthAttester({
      acceptanceRunId: 'truth-v2-candidate-run',
      buildIdentityDigest: candidateBuild.buildIdentityDigest,
      dataRootIdentitySha256: candidateDataRootIdentitySha256,
    }),
  };
  const profileSha256 = taskRegressionTruthV2ProfileSha256();
  const collectorBundleSha256 = digest('truth-v2-collector-bundle');
  const fixturePlanSha256 = digest('truth-v2-fixture-plan');
  const timeoutPolicy = {
    turnMs: 30_000,
    providerMs: 20_000,
    passiveStoreMs: 10_000,
    settleMs: 50,
  };
  const phases = phaseContracts().map((item, index) => ({
    scenarioId: item.scenarioId,
    phaseId: item.phaseId,
    turnOrdinal: item.turnOrdinal,
    unmarkedUserTextSha256: digest(`fixture:${item.scenarioId}:${item.phaseId}`),
    expectedToolName: item.phase.action?.toolName || '',
    requirements: {
      passiveStore: true,
      providerWitness: item.phase.required.includes('provider_attempt'),
    },
    baseline: {
      requestId: `baseline_request_${index + 1}`,
      phaseNonce: `baseline-phase-nonce-${String(index + 1).padStart(4, '0')}`,
      conversationId: `baseline_conversation_${item.scenarioId}`,
      userId: 'baseline_user',
    },
    candidate: {
      requestId: `candidate_request_${index + 1}`,
      phaseNonce: `candidate-phase-nonce-${String(index + 1).padStart(4, '0')}`,
      conversationId: `candidate_conversation_${item.scenarioId}`,
      userId: 'candidate_user',
    },
  }));
  const pairedPlan = createPortablePairedManifestCores({
    parity: {
      profileSha256,
      collectorBundleSha256,
      fixturePlanSha256,
      timeoutPolicy,
      platform: process.platform,
      nodeMajor: Number.parseInt(process.versions.node.split('.')[0], 10),
    },
    baseline: {
      runId: 'truth-v2-baseline-run',
      buildIdentityDigest: baselineBuild.buildIdentityDigest,
      dataRootIdentitySha256: baselineDataRootIdentitySha256,
      hmacKeyId: portableEvidenceHmacKeyId(BASELINE_KEY),
      serverTruthSigner: testOnlyServerAttesters.baseline.descriptor,
    },
    candidate: {
      runId: 'truth-v2-candidate-run',
      buildIdentityDigest: candidateBuild.buildIdentityDigest,
      dataRootIdentitySha256: candidateDataRootIdentitySha256,
      hmacKeyId: portableEvidenceHmacKeyId(CANDIDATE_KEY),
      serverTruthSigner: testOnlyServerAttesters.candidate.descriptor,
    },
    phases,
  });
  const contract = {
    controllerArtifactSha256: digest('truth-v2-adjudication-controller'),
    collectorArtifacts: {
      runner_socket: digest('truth-v2-runner-socket-collector'),
      passive_store_probe: digest('truth-v2-passive-store-collector'),
      provider_witness: digest('truth-v2-provider-collector'),
      filesystem_witness: digest('truth-v2-filesystem-collector'),
    },
    profileSha256,
    collectorBundleSha256,
    fixturePlanSha256,
    timeoutPolicySha256: portableEvidenceSha256(timeoutPolicy),
    coverageSha256: pairedPlan.coverageSha256,
    paritySha256: pairedPlan.paritySha256,
    serverTruthSigners: {
      baseline: testOnlyServerAttesters.baseline.descriptor,
      candidate: testOnlyServerAttesters.candidate.descriptor,
    },
  };
  const baselineChannels = syntheticChannels(
    pairedPlan.baselineManifest,
    contract,
    BASELINE_KEY,
    testOnlyServerAttesters.baseline,
  );
  const candidateChannels = syntheticChannels(
    pairedPlan.candidateManifest,
    contract,
    CANDIDATE_KEY,
    testOnlyServerAttesters.candidate,
  );
  const fixture = {
    pairedPlan,
    contract,
    baseline: {
      hmacKey: BASELINE_KEY,
      signedManifest: createSignedPortableManifest(pairedPlan.baselineManifest, BASELINE_KEY),
      buildIdentity: baselineBuild,
      channels: baselineChannels,
    },
    candidate: {
      hmacKey: CANDIDATE_KEY,
      signedManifest: createSignedPortableManifest(pairedPlan.candidateManifest, CANDIDATE_KEY),
      buildIdentity: candidateBuild,
      channels: candidateChannels,
    },
  };
  // Explicit test dependency only: the attester closure (and therefore its
  // private key) is never serialized into the fixture object.
  TEST_ONLY_SERVER_ATTESTERS.set(fixture, testOnlyServerAttesters);
  return fixture;
}

function taskRef(scenarioId: string) {
  return `task_${scenarioId}`;
}

function s6Phases(manifest: any) {
  const voice = manifest.phases.find((phase: any) => (
    phase.scenarioId === 'voice_to_text_continuation' && phase.phaseId === 'voice_start'
  ));
  const text = manifest.phases.find((phase: any) => (
    phase.scenarioId === 'voice_to_text_continuation' && phase.phaseId === 'text_continue'
  ));
  if (!voice || !text) throw new Error('S6 fixture phases missing');
  return { voice, text };
}

function s6Paths(manifest: any) {
  const role = String(manifest.role || 'unknown');
  return {
    previous: `D:\\portable-truth-v2\\${role}\\voice\\missing.txt`,
    replacement: `D:\\portable-truth-v2\\${role}\\text\\correct.txt`,
  };
}

function withServerTruthDigest(value: any) {
  const result = structuredClone(value);
  delete result.evidenceDigestSha256;
  return {
    ...result,
    evidenceDigestSha256: digest(stableS6Json(result)),
  };
}

function s6ServerTruth(manifest: any) {
  const { voice, text } = s6Phases(manifest);
  const paths = s6Paths(manifest);
  const stableTask = taskRef('voice_to_text_continuation');
  const voiceUser = `user_${voice.requestId}`;
  const voiceAssistant = `assistant_${voice.requestId}`;
  const textUser = `user_${text.requestId}`;
  const textAssistant = `assistant_${text.requestId}`;
  return withServerTruthDigest({
    kind: 'lumi.voice-text-continuation-truth',
    schemaVersion: 1,
    scenarioId: 'voice_to_text_continuation',
    acceptanceRunId: manifest.runId,
    buildIdentityDigest: manifest.buildIdentityDigest,
    conversationId: voice.conversationId,
    capturedAt: NOW,
    task: {
      recordId: stableTask,
      taskId: stableTask,
      revision: 2,
      finalStatus: 'completed',
    },
    voiceStart: {
      request: {
        recordId: `turn_${voice.requestId}`,
        requestId: voice.requestId,
        taskId: stableTask,
        channel: 'voice',
        source: 'voice',
        terminalStatus: 'blocked',
        userMessageId: voiceUser,
        assistantMessageId: voiceAssistant,
        recordedAt: NOW,
      },
      userMessage: {
        recordId: voiceUser,
        source: 'voice',
        channel: 'voice',
        mode: 'voice',
        textSha256: digest(`voice:${voice.requestId}`),
        recordedAt: NOW,
      },
      capture: {
        captureMode: 'synthetic_accepted_transcript',
        audioInputKind: 'synthetic_accepted_transcript',
        syntheticAudio: true,
        captureSessionId: null,
        sttReceiptId: null,
        contextChainId: null,
        previousRequestId: null,
        nativeDeviceId: null,
        executionSessionId: null,
        nativeClientIdentitySha256: null,
      },
      receipt: {
        recordId: `receipt_${voice.requestId}`,
        receiptId: `receipt_${voice.requestId}`,
        requestId: voice.requestId,
        taskId: stableTask,
        toolName: 'read_file',
        outcome: 'failed',
        inputSha256: digest(`input:${voice.requestId}`),
        target: {
          targetKind: 'filesystem',
          targetId: paths.previous,
          targetSha256: digest(paths.previous),
        },
        recordedAt: NOW,
      },
    },
    textContinue: {
      request: {
        recordId: `turn_${text.requestId}`,
        requestId: text.requestId,
        taskId: stableTask,
        channel: 'text',
        source: 'chat',
        terminalStatus: 'completed',
        userMessageId: textUser,
        assistantMessageId: textAssistant,
        recordedAt: NOW,
      },
      userMessage: {
        recordId: textUser,
        source: 'chat',
        channel: 'text',
        cognitiveIntent: 'task_correction',
        textSha256: digest(`text:${text.requestId}`),
        recordedAt: NOW,
      },
      receipt: {
        recordId: `receipt_${text.requestId}`,
        receiptId: `receipt_${text.requestId}`,
        requestId: text.requestId,
        taskId: stableTask,
        toolName: 'read_file',
        outcome: 'verified_success',
        inputSha256: digest(`input:${text.requestId}`),
        target: {
          targetKind: 'filesystem',
          targetId: paths.replacement,
          targetSha256: digest(paths.replacement),
        },
        recordedAt: NOW,
      },
    },
    channelHandoff: {
      sourceRequestId: voice.requestId,
      targetRequestId: text.requestId,
      sourceTaskId: stableTask,
      targetTaskId: stableTask,
      sourceChannel: 'voice',
      targetChannel: 'text',
      sourceMessageIds: [voiceUser, voiceAssistant],
      targetMessageId: textUser,
      recordedAt: NOW,
    },
    targetCorrection: {
      recordId: textUser,
      source: 'user_correction',
      sourceRequestId: voice.requestId,
      targetRequestId: text.requestId,
      taskId: stableTask,
      correctionMessageId: textUser,
      previousTarget: paths.previous,
      replacementTarget: paths.replacement,
      previousTaskTargetSha256: digest(paths.previous),
      replacementTaskTargetSha256: digest(paths.replacement),
      rejectedTargetSha256: digest(paths.previous),
      recordedAt: NOW,
    },
  });
}

function targetForTool(toolName: string, manifest?: any, phase?: any, key?: Buffer) {
  if (toolName.startsWith('runtime_work_')) {
    return {
      targetKind: 'runtime_work_set',
      workSetSha256: digest(`work-set:${toolName}`),
      workCount: 2,
      source: 'verified_runtime_work_status_receipt',
    };
  }
  if (toolName === 'desktop_active_window') {
    return {
      targetKind: 'application_document',
      applicationId: 'wps.presentation',
      processName: 'wpp.exe',
      windowTitleSha256: digest('synthetic-wps-window'),
      documentTitle: 'Synthetic fixture.pptx',
      canonicalPathHmac: digest('synthetic-wps-path'),
      source: 'verified_active_window',
    };
  }
  if (manifest && phase?.scenarioId === 'voice_to_text_continuation' && key) {
    const paths = s6Paths(manifest);
    const targetPath = phase.phaseId === 'voice_start' ? paths.previous : paths.replacement;
    return {
      targetKind: 'filesystem',
      canonicalPathHmac: portableTaskRegressionCanonicalPathHmac(targetPath, key),
      displayName: targetPath.split('\\').at(-1),
      source: phase.phaseId === 'voice_start' ? 'accepted_voice_target' : 'user_correction',
    };
  }
  return {
    targetKind: 'filesystem',
    canonicalPathHmac: digest(`target:${toolName}`),
    displayName: `${toolName || 'fixture'}.txt`,
    source: 'sealed_fixture',
  };
}

function requestChannel(scenarioId: string, phaseId: string) {
  return scenarioId === 'voice_to_text_continuation' && phaseId === 'voice_start'
    ? 'voice'
    : 'text';
}

function genericObservation(kind: string, manifest: any, phase: any, profile: any, key: Buffer) {
  const requestId = phase.requestId;
  const stableTask = taskRef(phase.scenarioId);
  const channel = requestChannel(phase.scenarioId, phase.phaseId);
  const previous = manifest.phases.find((item: any) => (
    item.scenarioId === phase.scenarioId
      && manifest.phases.indexOf(item) < manifest.phases.indexOf(phase)
  ));
  if (kind === 'turn') {
    return {
      observationKind: 'turn',
      requestRef: requestId,
      userMessageRef: `user_${requestId}`,
      assistantMessageRef: `assistant_${requestId}`,
      channel,
      relation: 'new',
      targetTaskRef: stableTask,
      targetRequestRef: null,
      terminalStatus: 'completed',
      userVisibleReply: {
        messageRef: `assistant_${requestId}`,
        textSha256: digest(`reply:${requestId}`),
        textCharCount: 12,
        recordedAt: NOW,
      },
    };
  }
  if (kind === 'conversation_state') {
    return {
      observationKind: 'conversation_state',
      tasks: [{
        taskRef: stableTask,
        status: 'completed',
        revision: 1,
        activeRequestRef: null,
        goalSha256: digest(`goal:${phase.scenarioId}`),
        targetSha256: digest(`task-target:${phase.scenarioId}:${phase.phaseId}`),
        capsuleRevision: 1,
      }],
      pendingPointer: { state: 'cleared', taskRef: null, requestRef: null, revision: 1 },
      livePointer: { state: 'cleared', taskRef: null, requestRef: null, revision: 1 },
      pendingConfirmationCount: 0,
    };
  }
  if (kind === 'action_set') {
    const toolName = profile.action?.toolName || 'read_file';
    return {
      observationKind: 'action_set',
      requestRef: requestId,
      receipts: [{
        receiptRef: `receipt_${requestId}`,
        taskRef: stableTask,
        requestRef: requestId,
        toolName,
        outcome: profile.action?.outcomes?.[0] || 'verified_success',
        idempotencyKeySha256: digest(`idempotency:${requestId}`),
        inputSha256: digest(`input:${requestId}`),
        executionOrigin: 'model_tool_call',
        target: targetForTool(toolName, manifest, phase, key),
      }],
    };
  }
  if (kind === 'model_route') {
    return {
      observationKind: 'model_route',
      requestRef: requestId,
      routingReceiptRef: `routing_${requestId}`,
      selectionMode: 'pinned',
      selectedProvider: 'synthetic-provider',
      selectedModel: 'synthetic-model',
      fallbackReason: null,
      attempts: [{
        attemptOrdinal: 1,
        provider: 'synthetic-provider',
        model: 'synthetic-model',
        status: 'succeeded',
        errorCategory: null,
        visibleOutputCommitted: true,
        outboundEvidenceSha256: digest(`provider-request:${requestId}`),
        providerWitnessRef: `provider_${requestId}`,
      }],
    };
  }
  if (kind === 'model_noninvocation') {
    return {
      observationKind: 'model_noninvocation',
      requestRef: requestId,
      executionOrigin: 'request_only_control',
      reasonCode: 'synthetic_deterministic_control',
    };
  }
  if (kind === 'provider_attempt') {
    return {
      observationKind: 'provider_attempt',
      requestRef: requestId,
      attemptOrdinal: 1,
      endpointWitnessRef: `provider_${requestId}`,
      provider: 'synthetic-provider',
      model: 'synthetic-model',
      status: 'succeeded',
      httpStatus: 200,
      errorCategory: null,
      requestSha256: digest(`provider-request:${requestId}`),
      turnNonceSha256: portableEvidenceSha256(phase.phaseNonce),
      responseSha256: digest(`provider-response:${requestId}`),
      visibleOutputCommitted: true,
    };
  }
  if (kind === 'native_target') {
    return {
      observationKind: 'native_target',
      coverageKind: 'synthetic_adapter',
      applicationId: 'wps.presentation',
      processName: 'wpp.exe',
      windowTitleSha256: digest('synthetic-wps-window'),
      documentTitle: 'Synthetic fixture.pptx',
      documentIdentitySha256: digest(`native:${requestId}`),
      source: 'sealed_native_adapter',
    };
  }
  if (kind === 'target_correction') {
    const serverTruth = s6ServerTruth(manifest);
    const previousTarget = {
      targetKind: 'filesystem',
      canonicalPathHmac: portableTaskRegressionCanonicalPathHmac(
        serverTruth.targetCorrection.previousTarget,
        key,
      ),
      displayName: 'missing.txt',
      source: 'accepted_voice_target',
    };
    const replacementTarget = {
      targetKind: 'filesystem',
      canonicalPathHmac: portableTaskRegressionCanonicalPathHmac(
        serverTruth.targetCorrection.replacementTarget,
        key,
      ),
      displayName: 'correct.txt',
      source: 'user_correction',
    };
    return {
      observationKind: 'target_correction',
      sourceRequestRef: previous?.requestId || requestId,
      targetRequestRef: requestId,
      taskRef: stableTask,
      correctionMessageRef: `user_${requestId}`,
      previousTarget,
      replacementTarget,
      previousTaskTargetSha256: serverTruth.targetCorrection.previousTaskTargetSha256,
      replacementTaskTargetSha256: serverTruth.targetCorrection.replacementTaskTargetSha256,
      rejectedTargetSha256: serverTruth.targetCorrection.rejectedTargetSha256,
      source: 'user_correction',
    };
  }
  if (kind === 'channel_handoff') {
    const serverTruth = s6ServerTruth(manifest);
    return {
      observationKind: 'channel_handoff',
      sourceRequestRef: previous?.requestId || requestId,
      targetRequestRef: requestId,
      sourceChannel: 'voice',
      targetChannel: 'text',
      captureMode: 'synthetic_accepted_transcript',
      contextChainRef: null,
      sourceTaskRef: stableTask,
      targetTaskRef: stableTask,
      sourceMessageRefs: [...serverTruth.channelHandoff.sourceMessageIds],
      targetMessageRef: serverTruth.channelHandoff.targetMessageId,
    };
  }
  if (kind === 'stale_reclassification') {
    return {
      observationKind: 'stale_reclassification',
      sourceReceiptRef: `receipt_${previous?.requestId || requestId}`,
      classifierInputSha256: digest(`stale:${requestId}`),
      mismatchDimension: 'request_id',
      classification: 'stale',
      archiveRef: `archive_${requestId}`,
      sourceReceiptUnchanged: true,
      leaseReleased: true,
    };
  }
  if (kind === 'runtime_transition') {
    return {
      observationKind: 'runtime_transition',
      restartScope: 'backend-only',
      beforeEpochRef: `before_${requestId}`,
      afterEpochRef: `after_${requestId}`,
      buildIdentitySha256: manifest.buildIdentityDigest,
      dataRootSha256: manifest.dataRootIdentitySha256,
      checkpointSha256: digest(`checkpoint:${requestId}`),
    };
  }
  if (kind === 'artifact_state') {
    return {
      observationKind: 'artifact_state',
      artifactRef: `artifact_${requestId}`,
      exists: true,
      contentSha256: digest(`artifact-content:${requestId}`),
      byteLength: 32,
      mtimeMs: 1_000,
      identitySha256: digest(`artifact-identity:${requestId}`),
    };
  }
  if (kind === 'absence_window') {
    return {
      observationKind: 'absence_window',
      assertion: 'no_new_task_or_tool_execution',
      startSequence: 1,
      endSequence: 2,
      sources: [
        'socket_tool_events',
        'passive_task_store',
        'passive_receipt_store',
        'filesystem_witness',
      ],
      matcherSha256: digest(`absence:${requestId}`),
      matchedRecordCount: 0,
    };
  }
  throw new Error(`unsupported synthetic observation: ${kind}`);
}

function syntheticChannels(manifest: any, contract: any, key: Buffer, testOnlyAttester: any) {
  let sourceSequence = 0;
  const result: any[] = [];
  for (const phase of manifest.phases) {
    const profile = TASK_REGRESSION_V2_SCENARIO_PROFILES[phase.scenarioId]
      .phases.find((item: any) => item.phaseId === phase.phaseId);
    const requiredKinds = [...profile.required];
    for (const alternatives of profile.exactlyOneOf || []) {
      requiredKinds.push(alternatives.includes('model_noninvocation')
        ? 'model_noninvocation'
        : alternatives[0]);
    }
    const byChannel = new Map<string, any[]>();
    for (const kind of requiredKinds) {
      const channel = kind === 'provider_attempt'
        ? 'provider_witness'
        : ['conversation_state', 'target_correction', 'stale_reclassification', 'runtime_transition'].includes(kind)
          ? 'passive_store_probe'
          : ['native_target', 'artifact_state', 'absence_window'].includes(kind)
            ? 'filesystem_witness'
            : 'runner_socket';
      const list = byChannel.get(channel) || [];
      list.push(genericObservation(kind, manifest, phase, profile, key));
      byChannel.set(channel, list);
    }
    if (phase.requirements.passiveStore && !byChannel.has('passive_store_probe')) {
      byChannel.set('passive_store_probe', []);
    }
    const selector = {
      scenarioId: phase.scenarioId,
      phaseId: phase.phaseId,
      requestId: phase.requestId,
      phaseNonce: phase.phaseNonce,
    };
    for (const [channel, observations] of byChannel) {
      const carriesS6ServerTruth = phase.scenarioId === 'voice_to_text_continuation'
        && phase.phaseId === 'text_continue'
        && channel === 'passive_store_probe'
        && observations.some((item: any) => item.observationKind === 'target_correction');
      result.push(createSignedPortableTruthV2ChannelRecord({
        manifest,
        contract,
        selector,
        channel,
        sourceSequence: ++sourceSequence,
        capturedAt: NOW,
        observations,
        ...(carriesS6ServerTruth ? {
          serverTruth: testOnlyAttester.attest(s6ServerTruth(manifest)),
        } : {}),
      }, key));
    }
    const absence = requiredKinds.includes('absence_window')
      ? genericObservation('absence_window', manifest, phase, profile, key)
      : null;
    if (absence) {
      for (const channel of ['runner_socket', 'passive_store_probe', 'filesystem_witness']) {
        result.push(createSignedPortableTruthV2ChannelRecord({
          manifest,
          contract,
          selector,
          channel,
          sourceSequence: ++sourceSequence,
          capturedAt: NOW,
          observations: [],
          proof: {
            kind: 'exact_channel_absence_v1',
            bindingDigest: phase.bindingDigest,
            requestId: phase.requestId,
            conversationId: phase.conversationId,
            matcherSha256: absence.matcherSha256,
            matchedRecordCount: 0,
          },
        }, key));
      }
    }
  }
  return result;
}

function resign(record: any, key: Buffer) {
  const unsigned = { ...record };
  delete unsigned.attestation;
  return signPortableEvidenceRecord(unsigned, key);
}

function adapterInput(fixture: ReturnType<typeof createFixture>) {
  return {
    pairedPlan: fixture.pairedPlan,
    contract: fixture.contract,
    baseline: fixture.baseline,
    candidate: fixture.candidate,
  };
}

function mutateCandidateS6ServerTruth(
  fixture: ReturnType<typeof createFixture>,
  mutate: (truth: any) => void,
) {
  const index = fixture.candidate.channels.findIndex((record: any) => (
    record.channel === 'passive_store_probe'
      && record.binding.scenarioId === 'voice_to_text_continuation'
      && record.binding.phaseId === 'text_continue'
      && record.serverTruth
  ));
  if (index < 0) throw new Error('candidate S6 server truth record missing');
  const record = fixture.candidate.channels[index];
  const serverTruth = structuredClone(record.serverTruth.truth);
  mutate(serverTruth);
  const canonicalTruth = withServerTruthDigest(serverTruth);
  const testOnlyAttesters = TEST_ONLY_SERVER_ATTESTERS.get(fixture);
  if (!testOnlyAttesters) throw new Error('candidate test attester missing');
  fixture.candidate.channels[index] = resign({
    ...record,
    serverTruth: testOnlyAttesters.candidate.attest(canonicalTruth),
  }, CANDIDATE_KEY);
}

function candidateS6Record(fixture: ReturnType<typeof createFixture>) {
  const index = fixture.candidate.channels.findIndex((record: any) => (
    record.channel === 'passive_store_probe'
      && record.binding.scenarioId === 'voice_to_text_continuation'
      && record.binding.phaseId === 'text_continue'
      && record.serverTruth
  ));
  if (index < 0) throw new Error('candidate S6 server truth record missing');
  return { index, record: fixture.candidate.channels[index] };
}

describe('portable task-regression Truth V2 adapter', () => {
  it('projects signed exact-bound channels into eight structurally valid V2 bundles per role', () => {
    const fixture = createFixture();
    const result = adaptPortablePairedEvidenceToTruthV2(adapterInput(fixture));

    expect(result.evidenceValid).toBe(true);
    expect(result.runs.baseline.scenarioBundles).toHaveLength(8);
    expect(result.runs.candidate.scenarioBundles).toHaveLength(8);
    expect(result.runs.baseline.scenarioBundles.map((item: any) => item.bundle.scenarioId))
      .toEqual(TASK_REGRESSION_V2_SCENARIO_IDS);
    expect(result.runs.candidate.scenarioBundles.every((item: any) => (
      item.bundle.coverageMode === 'portable_external' && item.adjudication.valid === true
    ))).toBe(true);
    expect(result.decisionSource)
      .toBe('portable_signed_channels_projected_into_task_regression_truth_v2');
    expect(PORTABLE_TRUTH_V2_EXECUTOR_WIRING_CONTRACT.forbiddenDependencies)
      .toContain('candidate_specific_truth_endpoint');
    expect(PORTABLE_TRUTH_V2_EXECUTOR_WIRING_CONTRACT.forbiddenDependencies)
      .toContain('caller_asserted_physical_microphone_provenance');

    const manifest = fixture.pairedPlan.candidateManifest;
    const start = manifest.phases.find((phase: any) => (
      phase.scenarioId === 'primary_model_failover_lmstudio' && phase.phaseId === 'start'
    ));
    const primary = manifest.phases.find((phase: any) => (
      phase.scenarioId === 'primary_model_failover_lmstudio'
        && phase.phaseId === 'primary_attempt_failed'
    ));
    const primaryWitness = fixture.candidate.channels.find((record: any) => (
      record.channel === 'provider_witness'
        && record.binding.bindingDigest === primary.bindingDigest
    ));
    expect(primaryWitness.proof).toMatchObject({
      observedPhaseBindingDigests: [start.bindingDigest],
      projectedSystemBindingDigest: primary.bindingDigest,
      providerMarkerSha256: portableEvidenceSha256(start.providerMarker),
    });
  });

  it('fails closed when baseline evidence is cross-bound into the candidate role', () => {
    const fixture = createFixture();
    fixture.candidate.channels[0] = fixture.baseline.channels[0];
    expect(() => adaptPortablePairedEvidenceToTruthV2(adapterInput(fixture)))
      .toThrowError('portable_truth_v2_channel_attestation_invalid');
    const validation = validatePortablePairedEvidenceForTruthV2(adapterInput(fixture));
    expect(validation).toMatchObject({
      ok: false,
      issues: [{ code: 'portable_truth_v2_channel_attestation_invalid' }],
    });
  });

  it('refuses to produce a channel record with a key outside the manifest role', () => {
    const fixture = createFixture();
    const record = fixture.candidate.channels[0];
    const binding = record.binding;
    expect(() => createSignedPortableTruthV2ChannelRecord({
      manifest: fixture.pairedPlan.candidateManifest,
      contract: fixture.contract,
      selector: {
        scenarioId: binding.scenarioId,
        phaseId: binding.phaseId,
        requestId: binding.requestId,
        phaseNonce: binding.phaseNonce,
      },
      channel: record.channel,
      sourceSequence: record.sourceSequence,
      capturedAt: record.capturedAt,
      observations: record.observations,
      proof: record.proof,
    }, BASELINE_KEY)).toThrowError('portable_truth_v2_manifest_hmac_key_mismatch');
  });

  it('fails closed when a provider witness marker is signed against the wrong phase', () => {
    const fixture = createFixture();
    const index = fixture.candidate.channels.findIndex((record: any) => (
      record.channel === 'provider_witness'
    ));
    const record = fixture.candidate.channels[index];
    const otherPhase = fixture.pairedPlan.candidateManifest.phases.find((phase: any) => (
      phase.bindingDigest !== record.binding.bindingDigest
    ));
    fixture.candidate.channels[index] = resign({
      ...record,
      proof: {
        ...record.proof,
        providerMarkerSha256: portableEvidenceSha256(otherPhase.providerMarker),
      },
    }, CANDIDATE_KEY);
    expect(() => adaptPortablePairedEvidenceToTruthV2(adapterInput(fixture)))
      .toThrowError('portable_truth_v2_provider_marker_binding_invalid');
  });

  it('fails closed when the passive-store exact selector is missing', () => {
    const fixture = createFixture();
    const index = fixture.candidate.channels.findIndex((record: any) => (
      record.channel === 'passive_store_probe'
        && record.proof.kind === 'exact_passive_store_selector_v1'
    ));
    const record = fixture.candidate.channels[index];
    const proof = { ...record.proof };
    delete proof.requestId;
    fixture.candidate.channels[index] = resign({ ...record, proof }, CANDIDATE_KEY);
    expect(() => adaptPortablePairedEvidenceToTruthV2(adapterInput(fixture)))
      .toThrowError('portable_truth_v2_store_selector_binding_invalid');
  });

  it.each([
    ['self-reported physical capture', (observation: any) => {
      observation.captureMode = 'physical_microphone';
    }],
    ['missing capture provenance', (observation: any) => {
      delete observation.captureMode;
    }],
  ])('fails closed for an S6 handoff with %s', (_label, mutate) => {
    const fixture = createFixture();
    const index = fixture.candidate.channels.findIndex((record: any) => (
      record.channel === 'runner_socket'
        && record.observations.some((item: any) => item.observationKind === 'channel_handoff')
    ));
    const record = fixture.candidate.channels[index];
    const observations = structuredClone(record.observations);
    mutate(observations.find((item: any) => item.observationKind === 'channel_handoff'));
    fixture.candidate.channels[index] = resign({ ...record, observations }, CANDIDATE_KEY);
    expect(() => adaptPortablePairedEvidenceToTruthV2(adapterInput(fixture)))
      .toThrowError('portable_truth_v2_s6_handoff_binding_invalid');
  });

  it.each([
    ['unknown', (truth: any) => { truth.conversationId = 'unknown'; }],
    ['forged from the other role', (truth: any) => {
      truth.conversationId = 'baseline_conversation_voice_to_text_continuation';
    }],
  ])('fails closed for an S6 server truth conversationId that is %s', (_label, mutate) => {
    const fixture = createFixture();
    mutateCandidateS6ServerTruth(fixture, mutate);
    expect(() => adaptPortablePairedEvidenceToTruthV2(adapterInput(fixture)))
      .toThrowError('portable_truth_v2_s6_conversation_binding_invalid');
  });

  it('verifies the detached server signature before the outer channel HMAC', () => {
    const fixture = createFixture();
    const { index, record } = candidateS6Record(fixture);
    const forged = structuredClone(record);
    forged.serverTruth.truth.conversationId = 'caller-authored-conversation';
    // Do not refresh the outer HMAC: an inner-attestation error proves the
    // Ed25519 boundary is evaluated first.
    fixture.candidate.channels[index] = forged;
    expect(() => adaptPortablePairedEvidenceToTruthV2(adapterInput(fixture)))
      .toThrowError('portable_truth_v2_s6_inner_attestation_invalid');
  });

  it('rejects caller-authored truth even when the caller recomputes its digest and outer HMAC', () => {
    const fixture = createFixture();
    const { index, record } = candidateS6Record(fixture);
    const envelope = structuredClone(record.serverTruth);
    envelope.truth.targetCorrection.previousTarget =
      'D:\\portable-truth-v2\\candidate\\forged\\missing.txt';
    envelope.truth = withServerTruthDigest(envelope.truth);
    envelope.binding.evidenceDigestSha256 = envelope.truth.evidenceDigestSha256;
    fixture.candidate.channels[index] = resign({ ...record, serverTruth: envelope }, CANDIDATE_KEY);
    expect(() => adaptPortablePairedEvidenceToTruthV2(adapterInput(fixture)))
      .toThrowError('portable_truth_v2_s6_inner_attestation_invalid');
  });

  it('rejects unsigned raw server truth even when protected by the channel HMAC', () => {
    const fixture = createFixture();
    const { index, record } = candidateS6Record(fixture);
    fixture.candidate.channels[index] = resign({
      ...record,
      serverTruth: structuredClone(record.serverTruth.truth),
    }, CANDIDATE_KEY);
    expect(() => adaptPortablePairedEvidenceToTruthV2(adapterInput(fixture)))
      .toThrowError('portable_truth_v2_s6_inner_attestation_required');
  });

  it('rejects a caller-generated replacement public key not pinned before the phase', () => {
    const fixture = createFixture();
    const { index, record } = candidateS6Record(fixture);
    const manifest = fixture.pairedPlan.candidateManifest;
    const replacement = createVoiceTextContinuationTruthAttester({
      acceptanceRunId: manifest.runId,
      buildIdentityDigest: manifest.buildIdentityDigest,
      dataRootIdentitySha256: manifest.dataRootIdentitySha256,
    });
    const replacementEnvelope = replacement.attest(structuredClone(record.serverTruth.truth));
    fixture.candidate.channels[index] = resign({
      ...record,
      serverTruth: replacementEnvelope,
    }, CANDIDATE_KEY);
    expect(() => adaptPortablePairedEvidenceToTruthV2(adapterInput(fixture)))
      .toThrowError('portable_truth_v2_s6_inner_attestation_invalid');
  });

  it.each([
    ['run', 'acceptanceRunId', 'truth-v2-other-run'],
    ['build', 'buildIdentityDigest', 'f'.repeat(64)],
    ['server instance', 'serverInstanceNonce', 'other-server-instance-nonce-0001'],
  ])('rejects a cross-%s detached-envelope replay', (_label, field, replacement) => {
    const fixture = createFixture();
    const { index, record } = candidateS6Record(fixture);
    const envelope = structuredClone(record.serverTruth);
    envelope.binding[field] = replacement;
    fixture.candidate.channels[index] = resign({ ...record, serverTruth: envelope }, CANDIDATE_KEY);
    expect(() => adaptPortablePairedEvidenceToTruthV2(adapterInput(fixture)))
      .toThrowError('portable_truth_v2_s6_inner_attestation_invalid');
  });

  it('rejects a valid envelope replayed from another backend instance', () => {
    const fixture = createFixture();
    const replaySource = createFixture();
    const { index, record } = candidateS6Record(fixture);
    const replay = candidateS6Record(replaySource).record.serverTruth;
    fixture.candidate.channels[index] = resign({ ...record, serverTruth: replay }, CANDIDATE_KEY);
    expect(() => adaptPortablePairedEvidenceToTruthV2(adapterInput(fixture)))
      .toThrowError('portable_truth_v2_s6_inner_attestation_invalid');
  });

  it('rejects a basename-only S6 correction target', () => {
    const fixture = createFixture();
    mutateCandidateS6ServerTruth(fixture, (truth) => {
      truth.targetCorrection.previousTarget = 'missing.txt';
    });
    expect(() => adaptPortablePairedEvidenceToTruthV2(adapterInput(fixture)))
      .toThrowError('portable_truth_v2_s6_target_path_invalid');
  });

  it('rejects an S6 correction target with the same basename in another directory', () => {
    const fixture = createFixture();
    mutateCandidateS6ServerTruth(fixture, (truth) => {
      truth.targetCorrection.previousTarget =
        'D:\\portable-truth-v2\\candidate\\forged-directory\\missing.txt';
    });
    expect(() => adaptPortablePairedEvidenceToTruthV2(adapterInput(fixture)))
      .toThrowError('portable_truth_v2_s6_correction_binding_invalid');
  });

  it('keeps the S6 targetMessageRef exact to the server-derived correction message', () => {
    const fixture = createFixture();
    const index = fixture.candidate.channels.findIndex((record: any) => (
      record.channel === 'runner_socket'
        && record.observations.some((item: any) => item.observationKind === 'channel_handoff')
    ));
    const record = fixture.candidate.channels[index];
    const observations = structuredClone(record.observations);
    observations.find((item: any) => item.observationKind === 'channel_handoff')
      .targetMessageRef = 'user_forged_target_message';
    fixture.candidate.channels[index] = resign({ ...record, observations }, CANDIDATE_KEY);
    expect(() => adaptPortablePairedEvidenceToTruthV2(adapterInput(fixture)))
      .toThrowError('portable_truth_v2_s6_handoff_binding_invalid');
  });

  it('requires the signed passive-store S6 server truth record', () => {
    const fixture = createFixture();
    const index = fixture.candidate.channels.findIndex((record: any) => record.serverTruth);
    const record = fixture.candidate.channels[index];
    const unsigned = { ...record };
    delete unsigned.serverTruth;
    fixture.candidate.channels[index] = resign(unsigned, CANDIDATE_KEY);
    expect(() => adaptPortablePairedEvidenceToTruthV2(adapterInput(fixture)))
      .toThrowError('portable_truth_v2_s6_server_truth_missing');
  });

  it('fails closed for a missing required evidence channel', () => {
    const fixture = createFixture();
    const firstBinding = fixture.pairedPlan.candidateManifest.phases[0].bindingDigest;
    fixture.candidate.channels = fixture.candidate.channels.filter((record: any) => !(
      record.binding.bindingDigest === firstBinding && record.channel === 'passive_store_probe'
    ));
    expect(() => adaptPortablePairedEvidenceToTruthV2(adapterInput(fixture)))
      .toThrowError('portable_truth_v2_required_channel_missing');
  });

  it('rejects channel evidence spliced from another controller or collector build', () => {
    const controllerFixture = createFixture() as any;
    controllerFixture.contract.controllerArtifactSha256 = digest('other-controller-artifact');
    expect(() => adaptPortablePairedEvidenceToTruthV2(adapterInput(controllerFixture)))
      .toThrowError('portable_truth_v2_channel_contract_binding_invalid');

    const collectorFixture = createFixture() as any;
    collectorFixture.contract.collectorArtifacts.provider_witness = digest('other-provider-collector');
    expect(() => adaptPortablePairedEvidenceToTruthV2(adapterInput(collectorFixture)))
      .toThrowError('portable_truth_v2_channel_contract_binding_invalid');
  });

  it('rejects a signed manifest or build identity crossed between baseline and candidate', () => {
    const manifestFixture = createFixture();
    manifestFixture.candidate.signedManifest = manifestFixture.baseline.signedManifest;
    expect(() => adaptPortablePairedEvidenceToTruthV2(adapterInput(manifestFixture)))
      .toThrowError('portable_truth_v2_manifest_attestation_invalid');

    const buildFixture = createFixture();
    buildFixture.candidate.buildIdentity = buildFixture.baseline.buildIdentity;
    expect(() => adaptPortablePairedEvidenceToTruthV2(adapterInput(buildFixture)))
      .toThrowError('portable_truth_v2_build_attestation_invalid');
  });

  it.each([
    ['collectorBundleSha256', 'collector bundle'],
    ['fixturePlanSha256', 'fixture plan'],
    ['timeoutPolicySha256', 'timeout policy'],
    ['coverageSha256', 'coverage'],
    ['paritySha256', 'parity'],
  ])('rejects a cross-controller %s digest', (field, seed) => {
    const fixture = createFixture() as any;
    fixture.contract[field] = digest(`other-controller:${seed}`);
    expect(() => adaptPortablePairedEvidenceToTruthV2(adapterInput(fixture)))
      .toThrowError('portable_truth_v2_manifest_contract_binding_invalid');
  });
});
