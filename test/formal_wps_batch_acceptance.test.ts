import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  FORMAL_WPS_BATCH_EVIDENCE_KIND,
  FORMAL_WPS_BATCH_MANIFEST_KIND,
  FORMAL_WPS_BATCH_SCHEMA_VERSION,
  FORMAL_WPS_BATCH_SCENARIO_IDS,
  buildFormalWpsBatchAcceptanceManifest,
  formalWpsBatchDigest,
  validateFormalWpsBatchAcceptanceEvidence,
  validateFormalWpsBatchAcceptanceManifest,
} from '../scripts/formal-wps-batch-acceptance.mjs';

const BUILD_ID = 'a'.repeat(40);
const GENERATED_AT = '2026-08-27T08:00:00.000Z';
const COMPLETED_AT = '2026-08-27T08:20:00.000Z';
const PNG_BYTES = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from('formal screenshot evidence'),
]);

const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function createFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lumi-formal-wps-batch-'));
  temporaryRoots.push(root);
  const dataRoot = path.join(root, 'formal-data');
  const webviewProfile = path.join(root, 'formal-webview2');
  const evidenceRunDirectory = path.join(root, 'acceptance-evidence', 'run-1');
  const desktop = path.join(root, 'Desktop');
  for (const directory of [
    dataRoot,
    webviewProfile,
    evidenceRunDirectory,
    path.join(evidenceRunDirectory, 'screenshots'),
    path.join(evidenceRunDirectory, 'artifacts'),
    desktop,
  ]) fs.mkdirSync(directory, { recursive: true });
  const document = {
    name: 'Lumia_路演资料.pptx',
    path: path.join(desktop, 'Lumia_路演资料.pptx'),
    sha256: 'b'.repeat(64),
  };
  const rejectedDocument = {
    name: '旧版路演.pptx',
    path: path.join(desktop, '旧版路演.pptx'),
    sha256: 'c'.repeat(64),
  };
  const binding = {
    runtime: { buildId: BUILD_ID, dataRoot, webviewProfile, evidenceRunDirectory },
    document,
    rejectedDocument,
    activeWpsWindow: {
      application: 'WPS',
      processName: 'wpp.exe',
      processId: 43210,
      processStartedAt: '2026-08-27T07:50:00.000Z',
      windowTitle: `${document.name} - WPS Office`,
      nativeWindowHandle: '987654',
      capturedAt: '2026-08-27T08:04:00.000Z',
    },
    batch: {
      scope: { domain: 'personal' },
      targetTasks: [
        { taskId: 'delegation-target-1', kind: 'delegation', scope: { domain: 'personal' } },
        { taskId: 'autonomy-target-2', kind: 'autonomy', scope: { domain: 'personal' } },
      ],
      protectedTask: {
        taskId: 'takeover-protected-canary',
        kind: 'takeover',
        scope: { domain: 'personal' },
      },
    },
  };
  const manifest = buildFormalWpsBatchAcceptanceManifest({ binding, generatedAt: GENERATED_AT });
  return { root, binding, manifest };
}

function writeIndexedFile(runDirectory: string, storedPath: string, bytes: Buffer | string) {
  const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes, 'utf8');
  const target = path.join(runDirectory, ...storedPath.split('/'));
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, buffer);
  return {
    storedPath,
    bytes: buffer.length,
    sha256: crypto.createHash('sha256').update(buffer).digest('hex'),
  };
}

function receipt(input: Record<string, any>) {
  return {
    receiptId: `receipt-${input.stage}`,
    toolName: input.toolName,
    stage: input.stage,
    taskId: input.taskId,
    requestId: input.requestId,
    idempotencyKey: `${input.taskId}:${input.requestId}:${input.toolName}:${input.stage}`,
    persisted: true,
    terminalVerification: { status: 'verified', strategy: 'terminal_receipt' },
    startedAt: input.startedAt || '2026-08-27T08:05:00.000Z',
    completedAt: input.completedAt || '2026-08-27T08:05:01.000Z',
    arguments: input.arguments || {},
    result: input.result,
    ...(input.targetDocumentIdentity ? { targetDocumentIdentity: input.targetDocumentIdentity } : {}),
  };
}

function timeline(
  taskId: string,
  names: readonly string[],
  startMinute: number,
  enrich: (name: string) => Record<string, unknown> = () => ({}),
) {
  return names.map((event, index) => ({
    eventId: `${taskId}:${event}`,
    event,
    taskId,
    requestId: `${taskId}:request:${event}`,
    revision: index + 1,
    at: `2026-08-27T08:${String(startMinute + index).padStart(2, '0')}:00.000Z`,
    ...enrich(event),
  }));
}

function runtimeItem(input: {
  id: string;
  kind: string;
  phase?: string;
  status?: string;
  cancellationRequested?: boolean;
  canCancel?: boolean;
}) {
  const phase = input.phase || 'working';
  const status = input.status || 'running';
  const terminal = phase === 'cancelled';
  return {
    id: input.id,
    kind: input.kind,
    title: input.id,
    status,
    phase,
    updatedAt: '2026-08-27T08:02:00.000Z',
    cancellationRequested: input.cancellationRequested ?? terminal,
    pauseRequested: false,
    scope: { domain: 'personal' },
    conversationId: `conversation:${input.id}`,
    parentTaskId: `parent:${input.id}`,
    source: 'formal-test-fixture',
    nextAttemptAt: '',
    blocker: '',
    nextAction: terminal ? '' : 'continue_execution',
    progress: {
      checkpoint: 'phase-1',
      completedUnits: 0,
      totalUnits: 1,
      receiptCount: 0,
      toolCallCount: 0,
      attempt: 1,
      recoveryCount: 0,
    },
    controls: {
      canPause: !terminal,
      canResume: false,
      canCancel: input.canCancel ?? !terminal,
    },
    evidence: {
      terminal,
      verification: terminal ? 'unverified' : 'pending',
      evidenceCount: 0,
      toolCount: 0,
      workerCount: 0,
      reasonCode: terminal ? 'user_cancelled' : '',
    },
  };
}

function statusPayload(items: any[], status: string, observedAt: string) {
  return {
    ok: true,
    status,
    degraded: false,
    diagnostics: [],
    activeCount: items.filter(item => !['cancelled', 'completed', 'failed', 'paused', 'blocked'].includes(item.phase)).length,
    pausedCount: items.filter(item => item.phase === 'paused').length,
    blockedCount: items.filter(item => ['blocked', 'failed'].includes(item.phase)).length,
    scope: { domain: 'personal' },
    items,
    observedAt,
  };
}

function manualChecks(ids: readonly string[]) {
  return ids.map(id => ({
    id,
    status: 'passed',
    reviewerType: 'human',
    reviewer: 'formal-reviewer',
    checkedAt: COMPLETED_AT,
  }));
}

function completeEvidence(manifest: any) {
  const runDirectory = manifest.runtimeBinding.evidenceRunDirectory;
  const wpsScenario = manifest.scenarios[0];
  const batchScenario = manifest.scenarios[1];
  const accepted = wpsScenario.binding.document;
  const rejected = wpsScenario.binding.rejectedDocument;
  const wpsTaskId = 'task-wps-current-document';
  const batchTaskId = 'task-runtime-batch-cleanup';

  const wpsScreenshots = [
    ['active-wps', 'active_wps_bound'],
    ['corrected-target', 'corrected_target_visible'],
    ['final-result', 'final_result_visible'],
  ].map(([id, stage]) => ({
    id,
    stage,
    taskId: wpsTaskId,
    capturedAt: '2026-08-27T08:12:00.000Z',
    ...writeIndexedFile(runDirectory, `screenshots/${id}.png`, PNG_BYTES),
  }));
  const batchScreenshots = [
    ['status-before', 'status_before_visible'],
    ['cleanup-result', 'cleanup_result_visible'],
    ['status-after', 'status_after_visible'],
  ].map(([id, stage]) => ({
    id,
    stage,
    taskId: batchTaskId,
    capturedAt: '2026-08-27T08:18:00.000Z',
    ...writeIndexedFile(runDirectory, `screenshots/${id}.png`, PNG_BYTES),
  }));

  const wpsReceipts = [
    receipt({
      stage: 'active_window_bound',
      toolName: 'desktop_active_window',
      taskId: wpsTaskId,
      requestId: 'wps-request-window',
      result: JSON.stringify({
        ok: true,
        status: 'ok',
        processName: wpsScenario.binding.activeWpsWindow.processName,
        processId: wpsScenario.binding.activeWpsWindow.processId,
        windowTitle: wpsScenario.binding.activeWpsWindow.windowTitle,
      }),
    }),
    receipt({
      stage: 'corrected_target_resolved',
      toolName: 'search_files',
      taskId: wpsTaskId,
      requestId: 'wps-request-resolve',
      startedAt: '2026-08-27T08:08:00.000Z',
      completedAt: '2026-08-27T08:08:01.000Z',
      arguments: { directory: path.dirname(accepted.path), pattern: accepted.name },
      result: JSON.stringify([{ name: accepted.name, path: accepted.path }]),
    }),
    receipt({
      stage: 'document_read',
      toolName: 'extract_document_text',
      taskId: wpsTaskId,
      requestId: 'wps-request-read',
      startedAt: '2026-08-27T08:09:00.000Z',
      completedAt: '2026-08-27T08:09:02.000Z',
      arguments: { filePath: accepted.path },
      result: JSON.stringify({ ok: true, status: 'verified', documentPath: accepted.path, characters: 4200 }),
      targetDocumentIdentity: accepted.documentIdentity,
    }),
  ];
  const wpsReference = {
    id: 'reference-slide-3',
    documentIdentity: accepted.documentIdentity,
    locator: 'slide:3',
    contentHash: 'd'.repeat(64),
    receiptId: wpsReceipts[2].receiptId,
  };
  const wpsArtifact = {
    id: 'wps-analysis-report',
    kind: 'analysis_report',
    taskId: wpsTaskId,
    sourceDocumentIdentity: accepted.documentIdentity,
    receiptIds: [wpsReceipts[2].receiptId],
    referenceIds: [wpsReference.id],
    ...writeIndexedFile(runDirectory, 'artifacts/wps-analysis-report.md', '# Verified WPS analysis\n'),
  };
  const wpsTimeline = timeline(wpsTaskId, [
    'task_started',
    'initial_target_selected',
    'target_correction_received',
    'target_confirmed',
    'document_read_verified',
    'artifact_verified',
    'task_completed',
  ], 3, event => {
    if (event === 'initial_target_selected') return { documentIdentity: rejected.documentIdentity };
    if (event === 'target_correction_received') return {
      userMessageId: 'message-user-correction',
      fromDocumentIdentity: rejected.documentIdentity,
      toDocumentIdentity: accepted.documentIdentity,
    };
    if (event === 'target_confirmed') {
      return {
        documentIdentity: accepted.documentIdentity,
        requestId: wpsReceipts[1].requestId,
      };
    }
    if (event === 'document_read_verified') {
      return {
        documentIdentity: accepted.documentIdentity,
        requestId: wpsReceipts[2].requestId,
      };
    }
    return {};
  });

  const targetBeforeItems = batchScenario.binding.batch.targetTasks.map((item: any) => runtimeItem({
    id: item.taskId,
    kind: item.kind,
  }));
  const targetAfterItems = batchScenario.binding.batch.targetTasks.map((item: any) => runtimeItem({
    id: item.taskId,
    kind: item.kind,
    phase: 'cancelled',
    status: 'cancelled',
    cancellationRequested: true,
    canCancel: false,
  }));
  const protectedItem = runtimeItem({
    id: batchScenario.binding.batch.protectedTask.taskId,
    kind: batchScenario.binding.batch.protectedTask.kind,
  });
  const targetKinds = batchScenario.binding.batch.selectedKinds;
  const protectedKinds = [batchScenario.binding.batch.protectedTask.kind];
  const batchReceipts = [
    receipt({
      stage: 'before_targets',
      toolName: 'runtime_work_status',
      taskId: batchTaskId,
      requestId: 'batch-request-before-targets',
      arguments: { kinds: targetKinds },
      result: statusPayload(targetBeforeItems, 'active', '2026-08-27T08:11:00.000Z'),
    }),
    receipt({
      stage: 'before_protected',
      toolName: 'runtime_work_status',
      taskId: batchTaskId,
      requestId: 'batch-request-before-protected',
      startedAt: '2026-08-27T08:11:02.000Z',
      completedAt: '2026-08-27T08:11:03.000Z',
      arguments: { kinds: protectedKinds },
      result: statusPayload([protectedItem], 'active', '2026-08-27T08:11:03.000Z'),
    }),
    receipt({
      stage: 'cancel_targets',
      toolName: 'runtime_work_cancel',
      taskId: batchTaskId,
      requestId: 'batch-request-cancel',
      startedAt: '2026-08-27T08:12:00.000Z',
      completedAt: '2026-08-27T08:12:02.000Z',
      arguments: { kinds: targetKinds },
      result: {
        ok: true,
        status: 'cancelled',
        matchedCount: targetAfterItems.length,
        cancelledCount: targetAfterItems.length,
        cancellingCount: 0,
        failedCount: 0,
        items: targetAfterItems,
        observedAt: '2026-08-27T08:12:02.000Z',
      },
    }),
    receipt({
      stage: 'after_targets',
      toolName: 'runtime_work_status',
      taskId: batchTaskId,
      requestId: 'batch-request-after-targets',
      startedAt: '2026-08-27T08:13:00.000Z',
      completedAt: '2026-08-27T08:13:01.000Z',
      arguments: { kinds: targetKinds },
      result: statusPayload(targetAfterItems, 'idle', '2026-08-27T08:13:01.000Z'),
    }),
    receipt({
      stage: 'after_protected',
      toolName: 'runtime_work_status',
      taskId: batchTaskId,
      requestId: 'batch-request-after-protected',
      startedAt: '2026-08-27T08:14:00.000Z',
      completedAt: '2026-08-27T08:14:01.000Z',
      arguments: { kinds: protectedKinds },
      result: statusPayload([structuredClone(protectedItem)], 'active', '2026-08-27T08:14:01.000Z'),
    }),
  ];
  const batchArtifact = {
    id: 'runtime-cleanup-report',
    kind: 'runtime_cleanup_report',
    taskId: batchTaskId,
    cancelledTaskIds: targetAfterItems.map(item => item.id),
    protectedTaskId: protectedItem.id,
    protectedTaskUnchanged: true,
    leasesReleased: true,
    receiptIds: batchReceipts.map(item => item.receiptId),
    ...writeIndexedFile(runDirectory, 'artifacts/runtime-cleanup-report.json', '{"status":"cancelled"}\n'),
  };

  return {
    schemaVersion: FORMAL_WPS_BATCH_SCHEMA_VERSION,
    kind: FORMAL_WPS_BATCH_EVIDENCE_KIND,
    manifestDigest: manifest.manifestDigest,
    completedAt: COMPLETED_AT,
    runtimeBinding: structuredClone(manifest.runtimeBinding),
    scenarios: [
      {
        scenarioId: FORMAL_WPS_BATCH_SCENARIO_IDS[0],
        bindingFingerprint: wpsScenario.binding.fingerprint,
        taskId: wpsTaskId,
        startedAt: '2026-08-27T08:03:00.000Z',
        completedAt: '2026-08-27T08:12:30.000Z',
        timeline: wpsTimeline,
        activeWindowObservation: {
          ...wpsScenario.binding.activeWpsWindow,
          taskId: wpsTaskId,
          requestId: wpsReceipts[0].requestId,
          receiptId: wpsReceipts[0].receiptId,
          screenshotId: wpsScreenshots[0].id,
          observedAt: '2026-08-27T08:05:01.000Z',
        },
        receipts: wpsReceipts,
        screenshots: wpsScreenshots,
        artifact: wpsArtifact,
        references: [wpsReference],
        routing: [{
          mode: 'model',
          taskId: wpsTaskId,
          requestId: wpsReceipts[2].requestId,
          persisted: true,
          status: 'succeeded',
          selectedProvider: 'lmstudio',
          selectedModel: 'formal-local-model',
          attempts: [{ provider: 'lmstudio', model: 'formal-local-model', status: 'succeeded' }],
          completedAt: '2026-08-27T08:09:02.000Z',
        }],
        userFeedback: [{
          stage: 'final_result',
          taskId: wpsTaskId,
          requestId: 'wps-request-final',
          messageId: 'wps-final-assistant-message',
          status: 'completed',
          visible: true,
          contentHash: 'e'.repeat(64),
          artifactId: wpsArtifact.id,
          referenceIds: [wpsReference.id],
          internalExecutionLeak: false,
          at: '2026-08-27T08:12:00.000Z',
        }],
        manualChecks: manualChecks([
          'active-window-document-match',
          'correction-kept-same-task',
          'artifact-and-citations-reviewed',
        ]),
      },
      {
        scenarioId: FORMAL_WPS_BATCH_SCENARIO_IDS[1],
        bindingFingerprint: batchScenario.binding.fingerprint,
        controlTaskId: batchTaskId,
        startedAt: '2026-08-27T08:10:00.000Z',
        completedAt: '2026-08-27T08:19:00.000Z',
        timeline: timeline(batchTaskId, [
          'control_task_started',
          'target_status_observed',
          'protected_canary_observed',
          'batch_cancel_requested',
          'batch_cancel_verified',
          'target_status_rechecked',
          'lease_release_verified',
          'protected_canary_rechecked',
          'control_task_completed',
        ], 10, event => {
          const byEvent: Record<string, string> = {
            target_status_observed: batchReceipts[0].requestId,
            protected_canary_observed: batchReceipts[1].requestId,
            batch_cancel_requested: batchReceipts[2].requestId,
            batch_cancel_verified: batchReceipts[2].requestId,
            target_status_rechecked: batchReceipts[3].requestId,
            lease_release_verified: batchReceipts[2].requestId,
            protected_canary_rechecked: batchReceipts[4].requestId,
          };
          return byEvent[event] ? { requestId: byEvent[event] } : {};
        }),
        receipts: batchReceipts,
        leaseSnapshots: targetAfterItems.map(item => ({
          taskId: item.id,
          leaseType: 'runtime_task',
          before: {
            observedAt: '2026-08-27T08:11:00.000Z',
            leaseOwnerId: `worker:${item.id}`,
            leaseEpoch: 'runtime-epoch-1',
            activeRequestId: `active:${item.id}`,
            status: 'working',
          },
          after: {
            observedAt: '2026-08-27T08:13:00.000Z',
            leaseOwnerId: '',
            leaseEpoch: '',
            activeRequestId: '',
            status: 'cancelled',
            released: true,
            releasedAt: '2026-08-27T08:12:03.000Z',
          },
        })),
        screenshots: batchScreenshots,
        routing: batchReceipts.map(item => ({
          mode: 'deterministic',
          taskId: batchTaskId,
          requestId: item.requestId,
          routeTool: item.toolName,
          modelInvoked: false,
          persisted: true,
          observedAt: item.startedAt,
        })),
        userFeedback: [
          ['status_before', 'active', 'batch-feedback-before'],
          ['cleanup_result', 'cancelled', 'batch-feedback-cancelled'],
          ['status_after', 'idle', 'batch-feedback-after'],
        ].map(([stage, status, messageId], index) => ({
          stage,
          status,
          messageId,
          taskId: batchTaskId,
          requestId: `batch-feedback-request-${index + 1}`,
          visible: true,
          contentHash: String(index + 5).repeat(64),
          internalExecutionLeak: false,
          at: `2026-08-27T08:${15 + index}:00.000Z`,
        })),
        artifact: batchArtifact,
        manualChecks: manualChecks([
          'exact-target-set-reviewed',
          'protected-canary-unchanged',
          'leases-released',
          'visible-feedback-reviewed',
        ]),
      },
    ],
  };
}

describe('formal WPS and runtime batch acceptance manifest', () => {
  it('defines two validation-only scenarios with exact runtime, window, document, and task-set bindings', () => {
    const { manifest } = createFixture();
    expect(manifest).toMatchObject({
      schemaVersion: FORMAL_WPS_BATCH_SCHEMA_VERSION,
      kind: FORMAL_WPS_BATCH_MANIFEST_KIND,
      generatedAt: GENERATED_AT,
      executionPolicy: {
        mode: 'orchestration_and_validation_only',
        launchClient: false,
        operateWps: false,
        synthesizeResults: false,
        retainEvidence: true,
        defaultOutcome: 'incomplete',
      },
    });
    expect(manifest.manifestDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(manifest.scenarios.map((scenario: any) => scenario.scenarioId)).toEqual(FORMAL_WPS_BATCH_SCENARIO_IDS);
    expect(manifest.scenarios[0].binding).toMatchObject({
      activeWpsWindow: {
        application: 'WPS',
        processName: 'wpp.exe',
        processId: 43210,
        nativeWindowHandle: '987654',
        windowIdentity: expect.stringMatching(/^[a-f0-9]{64}$/),
      },
      document: { documentIdentity: expect.stringMatching(/^[a-f0-9]{64}$/) },
      rejectedDocument: { documentIdentity: expect.stringMatching(/^[a-f0-9]{64}$/) },
    });
    expect(manifest.scenarios[1].binding.batch).toMatchObject({
      selectedKinds: ['autonomy', 'delegation'],
      batchIdentity: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(validateFormalWpsBatchAcceptanceManifest(manifest)).toEqual({ ok: true, errors: [] });
  });

  it('fails closed when runtime paths, exact WPS identity, corrected document, or protected canary are invalid', () => {
    const { binding } = createFixture();
    const build = (mutator: (value: any) => void) => {
      const copy = structuredClone(binding);
      mutator(copy);
      let thrown: any;
      try {
        buildFormalWpsBatchAcceptanceManifest({ binding: copy, generatedAt: GENERATED_AT });
      } catch (error) {
        thrown = error;
      }
      return thrown;
    };
    expect(build(value => { value.runtime.dataRoot = 'relative-data'; })).toMatchObject({ code: 'formal_data_root_invalid' });
    expect(build(value => { value.activeWpsWindow.processName = 'chrome.exe'; })).toMatchObject({ code: 'active_wps_process_invalid' });
    expect(build(value => { value.activeWpsWindow.windowTitle = 'WPS Office'; })).toMatchObject({ code: 'active_wps_title_document_mismatch' });
    expect(build(value => { value.document.path = value.rejectedDocument.path; value.document.name = value.rejectedDocument.name; })).toMatchObject({ code: 'wps_document_paths_not_distinct' });
    expect(build(value => {
      value.batch.protectedTask.kind = 'delegation';
      value.batch.protectedTask.scope = { domain: 'personal' };
    })).toMatchObject({ code: 'batch_protected_task_not_outside_selection' });
  });

  it('detects a redigested manifest that expands tools or removes evidence gates', () => {
    const { manifest } = createFixture();
    const expanded = structuredClone(manifest);
    expanded.scenarios[0].allowedTools.push('desktop_run_command');
    expanded.manifestDigest = formalWpsBatchDigest(expanded);
    expect(validateFormalWpsBatchAcceptanceManifest(expanded)).toMatchObject({
      ok: false,
      errors: expect.arrayContaining([
        'wps-current-document-correction-analysis:scenario_definition_changed',
        'wps-current-document-correction-analysis:allowed_tools_changed',
      ]),
    });

    const weakened = structuredClone(manifest);
    weakened.scenarios[1].requiredHumanChecks.pop();
    weakened.manifestDigest = formalWpsBatchDigest(weakened);
    expect(validateFormalWpsBatchAcceptanceManifest(weakened)).toMatchObject({
      ok: false,
      errors: expect.arrayContaining(['runtime-status-batch-cleanup:human_checks_changed']),
    });
  });
});

describe('formal WPS and runtime batch evidence validation', () => {
  it('passes only complete filesystem-backed receipts, timelines, routes, screenshots, artifacts, and human confirmation', () => {
    const { manifest } = createFixture();
    const evidence = completeEvidence(manifest);
    expect(validateFormalWpsBatchAcceptanceEvidence(manifest, evidence)).toEqual({
      ok: true,
      status: 'evidence_package_complete',
      packageComplete: true,
      filesystemVerified: true,
      runtimeProvenanceVerified: false,
      acceptanceDecision: 'not_adjudicated',
      acceptancePassed: false,
      missing: [],
      failures: [],
      errors: [],
    });
  });

  it('keeps missing screenshots, receipts, timeline entries, and human confirmation incomplete', () => {
    const cases: Array<[string, (evidence: any) => void, string]> = [
      ['screenshot', evidence => { evidence.scenarios[0].screenshots = []; }, 'wps:screenshots_missing'],
      ['receipt', evidence => {
        evidence.scenarios[0].receipts = evidence.scenarios[0].receipts
          .filter((item: any) => item.stage !== 'corrected_target_resolved');
      }, 'wps:receipt_stage_missing:corrected_target_resolved'],
      ['timeline', evidence => {
        evidence.scenarios[0].timeline = evidence.scenarios[0].timeline
          .filter((item: any) => item.event !== 'artifact_verified');
      }, 'wps:timeline_event_missing:artifact_verified'],
      ['human confirmation', evidence => { evidence.scenarios[0].manualChecks = []; }, 'wps:human_confirmation_missing'],
    ];
    for (const [, mutate, expectedCode] of cases) {
      const { manifest } = createFixture();
      const evidence = completeEvidence(manifest);
      mutate(evidence);
      const result = validateFormalWpsBatchAcceptanceEvidence(manifest, evidence);
      expect(result).toMatchObject({ ok: false, status: 'incomplete', failures: [] });
      expect(result.missing).toContain(expectedCode);
    }
  });

  it('rejects a WPS correction that changes task, reuses the rejected path, or detaches citations from the exact document', () => {
    const { manifest } = createFixture();
    const evidence = completeEvidence(manifest);
    const wps = evidence.scenarios[0];
    wps.timeline.find((item: any) => item.event === 'target_correction_received').taskId = 'different-task';
    wps.receipts.find((item: any) => item.stage === 'document_read').arguments.filePath = manifest.scenarios[0].binding.rejectedDocument.path;
    wps.references[0].documentIdentity = manifest.scenarios[0].binding.rejectedDocument.documentIdentity;
    const result = validateFormalWpsBatchAcceptanceEvidence(manifest, evidence);
    expect(result).toMatchObject({
      ok: false,
      status: 'failed',
      failures: expect.arrayContaining([
        'wps:timeline:3:task_id_mismatch',
        'wps:document_read_target_mismatch',
        'wps:rejected_target_reused_after_correction',
        'wps:reference:1:document_mismatch',
      ]),
    });
  });

  it('rejects non-terminal cleanup, duplicate cancellation, an unreleased lease, or a changed protected canary', () => {
    const { manifest } = createFixture();
    const evidence = completeEvidence(manifest);
    const batch = evidence.scenarios[1];
    const cancel = batch.receipts.find((item: any) => item.stage === 'cancel_targets');
    cancel.result.status = 'cancelling';
    cancel.result.cancelledCount = 1;
    cancel.result.cancellingCount = 1;
    batch.receipts.push({
      ...structuredClone(cancel),
      receiptId: 'duplicate-cancel-receipt',
      requestId: 'duplicate-cancel-request',
      idempotencyKey: 'duplicate-cancel-idempotency',
    });
    batch.leaseSnapshots[0].after.leaseOwnerId = 'worker-still-owning';
    const protectedAfter = batch.receipts.find((item: any) => item.stage === 'after_protected').result.items[0];
    protectedAfter.cancellationRequested = true;
    const result = validateFormalWpsBatchAcceptanceEvidence(manifest, evidence);
    expect(result).toMatchObject({
      ok: false,
      status: 'failed',
      failures: expect.arrayContaining([
        'batch:cancel_tool_not_exactly_once',
        'batch:cancel_not_terminally_verified',
        'batch:lease_not_released:autonomy-target-2',
        'batch:protected_task_changed',
      ]),
    });
  });

  it('rejects cancellation overreach and a target set that was not exact before execution', () => {
    const { manifest } = createFixture();
    const evidence = completeEvidence(manifest);
    const batch = evidence.scenarios[1];
    const before = batch.receipts.find((item: any) => item.stage === 'before_targets').result;
    before.items.push(runtimeItem({ id: 'unexpected-active-task', kind: 'delegation' }));
    before.activeCount += 1;
    const cancel = batch.receipts.find((item: any) => item.stage === 'cancel_targets').result;
    cancel.items.push(runtimeItem({
      id: 'unexpected-active-task',
      kind: 'delegation',
      phase: 'cancelled',
      status: 'cancelled',
      cancellationRequested: true,
      canCancel: false,
    }));
    cancel.matchedCount += 1;
    cancel.cancelledCount += 1;
    const result = validateFormalWpsBatchAcceptanceEvidence(manifest, evidence);
    expect(result).toMatchObject({
      ok: false,
      status: 'failed',
      failures: expect.arrayContaining([
        'batch:before_target_set_not_exact',
        'batch:cancel_not_terminally_verified',
      ]),
    });
  });

  it('verifies retained file bytes and rejects a changed screenshot or rebound runtime profile', () => {
    const { manifest } = createFixture();
    const evidence = completeEvidence(manifest);
    const screenshot = evidence.scenarios[0].screenshots[0];
    fs.appendFileSync(path.join(manifest.runtimeBinding.evidenceRunDirectory, screenshot.storedPath), 'tampered');
    evidence.runtimeBinding.webviewProfile = path.join(manifest.runtimeBinding.dataRoot, 'different-webview');
    const result = validateFormalWpsBatchAcceptanceEvidence(manifest, evidence);
    expect(result).toMatchObject({ ok: false, status: 'failed' });
    expect(result.failures).toEqual(expect.arrayContaining([
      'evidence:runtime_binding_mismatch',
      'wps:screenshot:active_wps_bound:size_mismatch',
      'wps:screenshot:active_wps_bound:sha256_mismatch',
    ]));
  });

  it('never promotes absent evidence into a pass', () => {
    const { manifest } = createFixture();
    expect(validateFormalWpsBatchAcceptanceEvidence(manifest, undefined)).toEqual({
      ok: false,
      status: 'incomplete',
      packageComplete: false,
      filesystemVerified: false,
      runtimeProvenanceVerified: false,
      acceptanceDecision: 'not_adjudicated',
      acceptancePassed: false,
      missing: ['evidence:envelope_missing'],
      failures: [],
      errors: ['evidence:envelope_missing'],
    });
  });
});
