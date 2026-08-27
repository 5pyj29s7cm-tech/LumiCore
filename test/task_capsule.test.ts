import { describe, expect, it } from 'vitest';
import {
  buildTaskCapsuleV1,
  classifyTaskCapsuleTurn,
  formatTaskCapsuleForPrompt,
  updateTaskCapsuleV1,
  type DurableTaskCapsuleSource,
} from '../server/conversation/task_capsule';
import { prepareConversationActionTaskState } from '../server/cognition/action_continuation';

const NOW = '2026-08-27T02:30:00.000Z';
const WRONG_PATH = 'C:\\Users\\Administrator\\Desktop\\旧版路演.pptx';

function wpsSource(overrides: Partial<DurableTaskCapsuleSource> = {}): DurableTaskCapsuleSource {
  return {
    taskId: 'task-wps-analysis',
    revision: 4,
    status: 'blocked',
    unfinished: true,
    goal: '分析桌面上的 Lumia 路演资料，并整理五项结论。',
    latestInstruction: '不是这份 PPT。',
    appTarget: 'WPS',
    sourcePaths: [WRONG_PATH],
    latestBlocker: '用户指出当前打开的文件不是目标文件。',
    toolSummaries: ['desktop_open | outcome=success | token=must-not-survive'],
    receipts: [
      {
        id: 'receipt-open-wrong',
        key: 'desktop_open:wrong',
        name: 'desktop_open',
        arguments: { target: WRONG_PATH, apiKey: 'not-a-target-field' },
        result: JSON.stringify({ ok: true, rawSecret: 'raw-result-must-not-survive' }),
        error: '',
        outcome: 'success',
        terminalVerification: {
          status: 'verified',
          strategy: 'visual',
          reason: 'window matched the requested path',
        },
        recordedAt: '2026-08-27T02:28:00.000Z',
      },
      {
        id: 'receipt-read-page-count',
        key: 'wps_read_presentation:page-count',
        name: 'wps_read_presentation',
        arguments: { mode: 'page_count' },
        result: JSON.stringify({ ok: true, pages: 17, notes: 'large raw payload is omitted' }),
        error: '',
        outcome: 'success',
        terminalVerification: {
          status: 'verified',
          strategy: 'terminal_receipt',
          reason: 'page count returned',
        },
        recordedAt: '2026-08-27T02:29:00.000Z',
      },
    ],
    updatedAt: NOW,
    ...overrides,
  };
}

describe('TaskCapsuleV1', () => {
  it('rebuilds a stable corrected target from durable state without raw tool results', () => {
    const capsule = buildTaskCapsuleV1(wpsSource(), {
      currentTurnText: '文件在桌面，叫 Lumia_路演资料.ppt。',
      observedAt: NOW,
    });

    expect(capsule).not.toBeNull();
    expect(capsule).toMatchObject({
      schemaVersion: 1,
      taskId: 'task-wps-analysis',
      revision: 4,
      goal: '分析桌面上的 Lumia 路演资料，并整理五项结论。',
      currentInstruction: '文件在桌面，叫 Lumia_路演资料.ppt。',
      target: {
        label: 'Lumia_路演资料.ppt',
        path: 'Lumia_路演资料.ppt',
        application: 'WPS',
        location: 'desktop',
        status: 'candidate',
        source: 'user_correction',
      },
      latestCorrection: {
        previousTarget: WRONG_PATH,
        replacementTarget: 'Lumia_路演资料.ppt',
      },
    });
    expect(capsule?.rejectedTargets.map(item => item.identity)).toContain(WRONG_PATH);
    expect(capsule?.doNotRetry.map(item => item.fingerprint)).toContain(
      'target:c:/users/administrator/desktop/旧版路演.pptx',
    );
    expect(capsule?.completedSteps.map(step => step.toolName)).toEqual(['wps_read_presentation']);

    const serialized = JSON.stringify(capsule);
    expect(serialized).not.toContain('raw-result-must-not-survive');
    expect(serialized).not.toContain('not-a-target-field');
    expect(serialized).not.toContain('must-not-survive');
    expect(serialized).toContain('[REDACTED]');
  });

  it('updates corrections, rejected targets, and exact do-not-retry routes immutably', () => {
    const initial = buildTaskCapsuleV1(wpsSource({
      latestInstruction: '分析这份 PPT。',
      toolSummaries: [],
    }))!;
    const updated = updateTaskCapsuleV1(initial, {
      instruction: '不是旧版路演.pptx，改成 Lumia_路演资料.ppt。',
      correction: {
        text: '不是旧版路演.pptx，改成 Lumia_路演资料.ppt。',
        target: 'Lumia_路演资料.ppt',
        path: 'Lumia_路演资料.ppt',
        rejectCurrentTarget: true,
        observedAt: NOW,
      },
      doNotRetry: [{
        fingerprint: 'desktop_open:wrong',
        reason: 'The exact wrong-file open route already succeeded on the wrong target.',
        observedAt: NOW,
      }],
      updatedAt: NOW,
    });

    expect(initial.target.path).toBe(WRONG_PATH);
    expect(updated.target.path).toBe('Lumia_路演资料.ppt');
    expect(updated.latestCorrection?.previousTarget).toBe(WRONG_PATH);
    expect(updated.rejectedTargets).toContainEqual(expect.objectContaining({ identity: WRONG_PATH }));
    expect(updated.doNotRetry).toContainEqual(expect.objectContaining({ fingerprint: 'desktop_open:wrong' }));
  });

  it('keeps the structured final replacement when one correction names both old and new paths', () => {
    const targets = [0, 1, 2, 3].map(index => (
      `C:\\Users\\Administrator\\LumiCore\\formal-client-e2e-artifacts\\target-${index}.txt`
    ));
    const goal = `创建确认门控文件 ${targets[0]}，内容保持不变。`;
    const instructions = [
      goal,
      `不是 ${targets[0]}，把同一个任务的目标改成 ${targets[1]}，不要重试旧目标。`,
      `再纠正一次：不要 ${targets[1]}，改成 ${targets[2]}，仍是同一个任务。`,
      `最后一次纠正：拒绝 ${targets[2]}，最终目标是 ${targets[3]}，等待我的确认。`,
    ];
    let capsule = null as ReturnType<typeof buildTaskCapsuleV1>;

    instructions.forEach((latestInstruction, index) => {
      capsule = buildTaskCapsuleV1({
        taskId: 'task-formal-correction',
        revision: index + 1,
        status: 'waiting_confirmation',
        unfinished: true,
        goal,
        latestInstruction,
        latestInstructionRef: `message-${index}`,
        appTarget: '',
        sourcePaths: [],
        latestBlocker: '',
        toolSummaries: [],
        receipts: [],
        updatedAt: `2026-08-27T02:30:0${index}.000Z`,
      }, {
        previousCapsule: capsule,
        observedAt: `2026-08-27T02:30:0${index}.000Z`,
      });
      expect(capsule?.target.path).toBe(targets[index]);
    });

    expect(capsule?.target).toMatchObject({
      path: targets[3],
      status: 'candidate',
      source: 'user_correction',
    });
    expect(capsule?.latestCorrection).toMatchObject({
      previousTarget: targets[2],
      replacementTarget: targets[3],
      eventRef: 'message-3',
    });
    expect(capsule?.rejectedTargets.map(item => item.identity)).toEqual(
      expect.arrayContaining(targets.slice(0, 3)),
    );
    expect(capsule?.doNotRetry.map(item => item.fingerprint)).toEqual(
      expect.arrayContaining(targets.slice(0, 3).map(target => (
        `target:${target.replace(/[\\/]+/g, '/').toLowerCase()}`
      ))),
    );
  });

  it('does not bind ordinary conversational negation to an unfinished task', () => {
    const state = wpsSource();
    expect(classifyTaskCapsuleTurn('不是这个', state)).toBe('target_correction');
    expect(classifyTaskCapsuleTurn('不是这份 PPT。', state)).toBe('target_correction');
    expect(classifyTaskCapsuleTurn('不是旧版路演.pptx，改成 Lumia_路演资料.ppt。', state)).toBe('target_correction');
    expect(classifyTaskCapsuleTurn('不要用这份 PPT。', state)).toBe('target_correction');
    expect(classifyTaskCapsuleTurn('文件在桌面，叫 Lumia_路演资料.ppt。', state)).toBe('target_detail');
    expect(classifyTaskCapsuleTurn('Lumia_路演资料.ppt', state)).toBe('target_detail');
    expect(classifyTaskCapsuleTurn('准确文件名是 Lumia_路演资料.pptx，在桌面。请继续分析。', state)).toBe('target_detail');
    expect(classifyTaskCapsuleTurn('不是，我想问你今天怎么样？', state)).toBe('none');
    expect(classifyTaskCapsuleTurn('不对，我想问的是你自己的看法。', state)).toBe('none');
    expect(classifyTaskCapsuleTurn('请用更温柔的语气回答。', state)).toBe('none');
    expect(classifyTaskCapsuleTurn('Lumia_路演资料.ppt', { ...state, unfinished: false })).toBe('none');

    const rejectOnly = buildTaskCapsuleV1(state, {
      currentTurnText: '不要用这份 PPT。',
      observedAt: NOW,
    });
    expect(rejectOnly?.target).toMatchObject({ path: WRONG_PATH, status: 'rejected' });
    expect(rejectOnly?.latestCorrection?.replacementTarget).toBe('');

    const terseRejectOnly = buildTaskCapsuleV1(state, {
      currentTurnText: '不是这个',
      observedAt: NOW,
    });
    expect(terseRejectOnly?.target).toMatchObject({ path: WRONG_PATH, status: 'rejected' });
    expect(terseRejectOnly?.latestCorrection?.replacementTarget).toBe('');

    const suppliedExactName = buildTaskCapsuleV1(state, {
      currentTurnText: '准确文件名是 Lumia_路演资料.pptx，在桌面。请继续分析。',
      observedAt: NOW,
    });
    expect(suppliedExactName?.target).toMatchObject({
      path: 'Lumia_路演资料.pptx',
      location: 'desktop',
      status: 'candidate',
      source: 'user_correction',
    });
  });

  it('formats a bounded receipt-backed prompt capsule', () => {
    const capsule = buildTaskCapsuleV1(wpsSource(), {
      currentTurnText: '文件在桌面，叫 Lumia_路演资料.ppt。',
      observedAt: NOW,
    })!;
    const prompt = formatTaskCapsuleForPrompt(capsule);

    expect(prompt).toContain('Current task capsule (TaskCapsuleV1):');
    expect(prompt).toContain('- goal: 分析桌面上的 Lumia 路演资料，并整理五项结论。');
    expect(prompt).toContain('- target: Lumia_路演资料.ppt');
    expect(prompt).toContain('- completedSteps (receipt-backed only):');
    expect(prompt).toContain('- rejectedTargets:');
    expect(prompt).toContain('- doNotRetry:');
    expect(prompt).not.toContain('raw-result-must-not-survive');
    expect(prompt.length).toBeLessThan(10_000);
  });

  it('rejects the exact active-window document instead of collapsing the target to WPS', () => {
    const goal = '请分析当前 WPS 活动窗口里的演示文稿。';
    const source = wpsSource({
      goal,
      latestInstruction: goal,
      sourcePaths: [],
      latestBlocker: '',
      receipts: [{
        id: 'receipt-active-wps-draft',
        key: 'desktop_active_window:{}',
        name: 'desktop_active_window',
        arguments: {},
        result: JSON.stringify({
          ok: true,
          title: 'WPS-Quarterly-Review-Draft.pptx - WPS Office',
          processName: 'wps.exe',
          documentName: 'WPS-Quarterly-Review-Draft.pptx',
          path: '',
        }),
        error: '',
        outcome: 'success',
        terminalVerification: {
          status: 'verified',
          strategy: 'terminal_receipt',
          reason: 'active window observed',
        },
        recordedAt: NOW,
      }],
    });
    const anchored = buildTaskCapsuleV1(source, { observedAt: NOW })!;
    expect(anchored.target).toMatchObject({
      label: 'WPS-Quarterly-Review-Draft.pptx',
      object: 'WPS-Quarterly-Review-Draft.pptx',
      application: 'WPS',
      source: 'active_window',
    });

    const corrected = buildTaskCapsuleV1({
      ...source,
      revision: 5,
      latestInstruction: '不是这份文件',
      latestBlocker: '用户拒绝了当前候选文件。',
    }, {
      previousCapsule: anchored,
      observedAt: NOW,
    })!;
    expect(corrected.latestCorrection?.previousTarget).toBe('WPS-Quarterly-Review-Draft.pptx');
    expect(corrected.rejectedTargets.map(item => item.identity)).toContain('WPS-Quarterly-Review-Draft.pptx');
    expect(corrected.rejectedTargets.map(item => item.identity)).not.toContain('WPS');
  });

  it('keeps the original rejected path when the same correction revision is replayed', () => {
    const oldPath = 'D:\\isolated-s6\\artifacts\\missing-target.txt';
    const newPath = 'D:\\isolated-s6\\artifacts\\accepted-target.txt';
    const goal = 'Read the requested file.';
    const correction = `不是 ${oldPath}，而是 ${newPath}。`;
    const initial = buildTaskCapsuleV1({
      taskId: 'task-s6-correction-replay',
      revision: 1,
      status: 'blocked',
      unfinished: true,
      goal,
      latestInstruction: goal,
      sourcePaths: [oldPath],
      latestBlocker: 'The original target could not be read.',
      receipts: [],
      updatedAt: '2026-08-27T03:00:00.000Z',
    }, {
      observedAt: '2026-08-27T03:00:00.000Z',
    })!;
    const correctedSource: DurableTaskCapsuleSource = {
      taskId: 'task-s6-correction-replay',
      revision: 2,
      status: 'executing',
      unfinished: true,
      goal,
      latestInstruction: correction,
      sourcePaths: [oldPath],
      latestBlocker: '',
      receipts: [{
        id: 'receipt-read-accepted-target',
        key: `read_file:${newPath}`,
        name: 'read_file',
        arguments: { path: newPath },
        result: JSON.stringify({ ok: true, content: 'isolated S6 fixture' }),
        error: '',
        outcome: 'success',
        terminalVerification: {
          status: 'verified',
          strategy: 'terminal_receipt',
          reason: 'The corrected target was read.',
        },
        recordedAt: '2026-08-27T03:01:00.000Z',
      }],
      updatedAt: '2026-08-27T03:01:00.000Z',
    };

    const firstProjection = buildTaskCapsuleV1(correctedSource, {
      previousCapsule: initial,
      observedAt: correctedSource.updatedAt,
    })!;
    const replayedProjection = buildTaskCapsuleV1(correctedSource, {
      previousCapsule: firstProjection,
      observedAt: correctedSource.updatedAt,
    })!;

    expect(firstProjection.latestCorrection).toMatchObject({
      text: correction,
      previousTarget: oldPath,
      replacementTarget: newPath,
    });
    expect(firstProjection.target.path).toBe(newPath);
    expect(replayedProjection.latestCorrection).toEqual(firstProjection.latestCorrection);
    expect(replayedProjection.target.path).toBe(newPath);
    expect(replayedProjection.rejectedTargets.map(item => item.identity)).toEqual([oldPath]);
    expect(replayedProjection.rejectedTargets.map(item => item.identity)).not.toContain(newPath);
  });

  it('keeps the exact absolute replacement path when a correction also asks to continue', () => {
    const oldPath = String.raw`C:\Users\Administrator\AppData\Local\Temp\lumi-task-regression-debug\artifacts\s6-missing-0123456789ab.txt`;
    const newPath = String.raw`C:\Users\Administrator\AppData\Local\Temp\lumi-task-regression-debug\artifacts\s6-correct-0123456789ab.txt`;
    const goal = `[LUMI_REGRESSION:S6] 请在桌面查找并读取文件 ${oldPath}，如果找不到就明确告诉我，等我纠正后继续这个任务。`;
    const correction = `纠正一下：不是 ${oldPath}，而是 ${newPath}。请继续刚才的同一个任务。[LUMI_REGRESSION:S6:TEXT]`;
    const initial = buildTaskCapsuleV1({
      taskId: 'task-s6-exact-runner-correction',
      revision: 1,
      status: 'blocked',
      unfinished: true,
      goal,
      latestInstruction: goal,
      latestInstructionRef: 'msg-voice',
      sourcePaths: [oldPath],
      receipts: [],
      updatedAt: '2026-08-27T03:00:00.000Z',
    }, {
      observedAt: '2026-08-27T03:00:00.000Z',
    })!;
    const corrected = buildTaskCapsuleV1({
      taskId: 'task-s6-exact-runner-correction',
      revision: 2,
      status: 'planning',
      unfinished: true,
      goal,
      latestInstruction: correction,
      latestInstructionRef: 'msg-text',
      sourcePaths: [oldPath],
      receipts: [],
      updatedAt: '2026-08-27T03:01:00.000Z',
    }, {
      previousCapsule: initial,
      observedAt: '2026-08-27T03:01:00.000Z',
    })!;

    expect(corrected.latestCorrection).toMatchObject({
      eventRef: 'msg-text',
      previousTarget: oldPath,
      replacementTarget: newPath,
    });
    expect(corrected.target.path).toBe(newPath);
    expect(corrected.rejectedTargets.map(item => item.identity)).toEqual([oldPath]);
  });

  const replayGoal = 'Read the requested file.';
  const replayA = 'capsule-replay-a.txt';
  const replayB = 'capsule-replay-b.txt';
  const replayC = 'capsule-replay-c.txt';
  const replacementAB = `not ${replayA}, instead use ${replayB}.`;
  const replacementBC = `not ${replayB}, instead use ${replayC}.`;

  function replayInitial(sourcePaths: string[] = [replayA]) {
    return buildTaskCapsuleV1({
      taskId: 'task-capsule-event-replay',
      revision: 1,
      status: 'blocked',
      unfinished: true,
      goal: replayGoal,
      latestInstruction: replayGoal,
      latestInstructionRef: 'msg-goal',
      sourcePaths,
      receipts: [],
      updatedAt: '2026-08-27T04:00:00.000Z',
    }, {
      observedAt: '2026-08-27T04:00:00.000Z',
    })!;
  }

  function replayProjection(
    previousCapsule: ReturnType<typeof replayInitial>,
    input: {
      instruction: string;
      eventRef?: string;
      revision?: number;
      updatedAt?: string;
      sourcePaths?: string[];
      receipts?: DurableTaskCapsuleSource['receipts'];
      currentTurnText?: string;
      currentTurnRef?: string;
      observedAt?: string;
    },
  ) {
    const updatedAt = input.updatedAt || '2026-08-27T04:01:00.000Z';
    return buildTaskCapsuleV1({
      taskId: 'task-capsule-event-replay',
      revision: input.revision || 2,
      status: 'executing',
      unfinished: true,
      goal: replayGoal,
      latestInstruction: input.instruction,
      ...(input.eventRef ? { latestInstructionRef: input.eventRef } : {}),
      sourcePaths: input.sourcePaths || [replayA],
      receipts: input.receipts || [],
      updatedAt,
    }, {
      previousCapsule,
      currentTurnText: input.currentTurnText,
      currentTurnRef: input.currentTurnRef,
      observedAt: input.observedAt || updatedAt,
    })!;
  }

  it('replays one replacement event across a higher revision and a new confirming receipt', () => {
    const first = replayProjection(replayInitial(), {
      instruction: replacementAB,
      eventRef: 'msg-correction-ab',
    });
    const correctionSnapshot = structuredClone(first.latestCorrection);
    const rejectionSnapshot = structuredClone(first.rejectedTargets);
    const doNotRetrySnapshot = structuredClone(first.doNotRetry);
    const replayed = replayProjection(first, {
      instruction: replacementAB,
      eventRef: 'msg-correction-ab',
      revision: 9,
      updatedAt: '2026-08-27T04:05:00.000Z',
      receipts: [{
        id: 'receipt-confirm-b',
        key: `read_file:${replayB}`,
        name: 'read_file',
        arguments: { path: replayB },
        result: JSON.stringify({ ok: true }),
        error: '',
        outcome: 'success',
        terminalVerification: {
          status: 'verified',
          strategy: 'terminal_receipt',
          reason: 'The replacement target was read.',
        },
        recordedAt: '2026-08-27T04:04:00.000Z',
      }],
    });

    expect(replayed.revision).toBe(9);
    expect(replayed.target).toMatchObject({ path: replayB, status: 'confirmed' });
    expect(replayed.latestCorrection).toEqual(correctionSnapshot);
    expect(replayed.rejectedTargets).toEqual(rejectionSnapshot);
    expect(replayed.doNotRetry).toEqual(doNotRetrySnapshot);
  });

  it('replays a reject-only event without rewriting correction or exclusion timestamps', () => {
    const rejectOnly = 'not this file.';
    const first = replayProjection(replayInitial(), {
      instruction: rejectOnly,
      eventRef: 'msg-reject-only',
    });
    const replayed = replayProjection(first, {
      instruction: rejectOnly,
      eventRef: 'msg-reject-only',
      revision: 3,
      updatedAt: '2026-08-27T04:06:00.000Z',
    });

    expect(first.target).toMatchObject({ path: replayA, status: 'rejected' });
    expect(first.latestCorrection).toMatchObject({
      eventRef: 'msg-reject-only',
      previousTarget: replayA,
      replacementTarget: '',
    });
    expect(replayed.latestCorrection).toEqual(first.latestCorrection);
    expect(replayed.rejectedTargets).toEqual(first.rejectedTargets);
    expect(replayed.doNotRetry).toEqual(first.doNotRetry);
  });

  it('replays an unresolved-to-detail event while retaining an empty previous target', () => {
    const detail = `The file is named ${replayB}.`;
    const first = replayProjection(replayInitial([]), {
      instruction: detail,
      eventRef: 'msg-detail-b',
      sourcePaths: [],
    });
    const replayed = replayProjection(first, {
      instruction: detail,
      eventRef: 'msg-detail-b',
      revision: 3,
      sourcePaths: [],
      updatedAt: '2026-08-27T04:07:00.000Z',
    });

    expect(first.latestCorrection).toMatchObject({
      eventRef: 'msg-detail-b',
      previousTarget: '',
      replacementTarget: replayB,
    });
    expect(replayed.latestCorrection).toEqual(first.latestCorrection);
    expect(replayed.target.path).toBe(replayB);
    expect(replayed.rejectedTargets).toEqual([]);
  });

  it('treats a different B-to-C event as new and retains the earlier A rejection', () => {
    const correctedToB = replayProjection(replayInitial(), {
      instruction: replacementAB,
      eventRef: 'msg-correction-ab',
    });
    const correctedToC = replayProjection(correctedToB, {
      instruction: replacementBC,
      eventRef: 'msg-correction-bc',
      revision: 3,
      updatedAt: '2026-08-27T04:08:00.000Z',
    });

    expect(correctedToC.target.path).toBe(replayC);
    expect(correctedToC.latestCorrection).toMatchObject({
      eventRef: 'msg-correction-bc',
      previousTarget: replayB,
      replacementTarget: replayC,
    });
    expect(correctedToC.rejectedTargets.map(item => item.identity)).toEqual([replayA, replayB]);
    expect(correctedToC.doNotRetry.map(item => item.fingerprint)).toEqual([
      `target:${replayA}`,
      `target:${replayB}`,
    ]);
  });

  it('records identical text under a different ref without rejecting the correct current target', () => {
    const first = replayProjection(replayInitial(), {
      instruction: replacementAB,
      eventRef: 'msg-correction-ab-1',
      updatedAt: '2026-08-27T04:01:00.000Z',
    });
    const second = replayProjection(first, {
      instruction: replacementAB,
      eventRef: 'msg-correction-ab-2',
      revision: 3,
      updatedAt: '2026-08-27T04:09:00.000Z',
    });

    expect(second.latestCorrection).toMatchObject({
      eventRef: 'msg-correction-ab-2',
      observedAt: '2026-08-27T04:09:00.000Z',
      previousTarget: replayA,
      replacementTarget: replayB,
    });
    expect(second.target.path).toBe(replayB);
    expect(second.rejectedTargets.map(item => item.identity)).toEqual([replayA]);
    expect(second.doNotRetry.map(item => item.fingerprint)).not.toContain(`target:${replayB}`);
  });

  it('hydrates a ref-less legacy correction conservatively and later binds a stable ref in place', () => {
    const legacy = replayProjection(replayInitial(), {
      instruction: replacementAB,
      updatedAt: '2026-08-27T04:01:00.000Z',
    });
    const hydrated = replayProjection(legacy, {
      instruction: replacementAB,
      revision: 3,
      updatedAt: '2026-08-27T04:10:00.000Z',
    });
    const rebound = replayProjection(hydrated, {
      instruction: replacementAB,
      eventRef: 'msg-late-stable-ab',
      revision: 4,
      updatedAt: '2026-08-27T04:11:00.000Z',
    });

    expect(legacy.latestCorrection?.eventRef).toBeUndefined();
    expect(hydrated.latestCorrection).toEqual(legacy.latestCorrection);
    expect(hydrated.rejectedTargets).toEqual(legacy.rejectedTargets);
    expect(hydrated.doNotRetry).toEqual(legacy.doNotRetry);
    expect(rebound.latestCorrection).toEqual({
      ...legacy.latestCorrection,
      eventRef: 'msg-late-stable-ab',
    });
    expect(rebound.rejectedTargets).toEqual(legacy.rejectedTargets);
    expect(rebound.doNotRetry).toEqual(legacy.doNotRetry);
  });

  it('processes equal latest and current text when their durable refs differ', () => {
    const projected = replayProjection(replayInitial(), {
      instruction: replacementAB,
      eventRef: 'msg-latest-ab',
      currentTurnText: replacementAB,
      currentTurnRef: 'msg-current-ab',
      observedAt: '2026-08-27T04:12:00.000Z',
    });

    expect(projected.latestCorrection).toMatchObject({
      eventRef: 'msg-current-ab',
      observedAt: '2026-08-27T04:12:00.000Z',
      previousTarget: replayA,
      replacementTarget: replayB,
    });
    expect(projected.target.path).toBe(replayB);
    expect(projected.rejectedTargets.map(item => item.identity)).toEqual([replayA]);
  });

  it('fails closed when a same-ref correction is no longer in its expected post-state', () => {
    const first = replayProjection(replayInitial(), {
      instruction: replacementAB,
      eventRef: 'msg-correction-ab',
    });
    const inconsistent = {
      ...first,
      target: {
        ...first.target,
        label: replayC,
        object: replayC,
        path: replayC,
        status: 'candidate' as const,
        source: 'user_correction' as const,
      },
    };
    const guarded = replayProjection(inconsistent, {
      instruction: replacementAB,
      eventRef: 'msg-correction-ab',
      revision: 4,
      updatedAt: '2026-08-27T04:13:00.000Z',
    });

    expect(guarded.target.path).toBe(replayC);
    expect(guarded.latestCorrection).toEqual(first.latestCorrection);
    expect(guarded.rejectedTargets.map(item => item.identity)).toEqual([replayA]);
    expect(guarded.rejectedTargets.map(item => item.identity)).not.toContain(replayC);
  });

  it('threads the persisted user message ref into prepared durable correction state', () => {
    const toolPolicy = {
      allowedTools: ['read_file'],
      requireConfirmation: [],
      forbiddenTools: [],
      maxIterations: 4,
    };
    const initial = prepareConversationActionTaskState(null, {
      userText: `Read ${replayA}.`,
      requestId: 'request-initial',
      userMessageId: 'msg-initial',
      toolPolicy,
      forceTask: true,
    }).state!;
    const corrected = prepareConversationActionTaskState(initial, {
      userText: replacementAB,
      requestId: 'request-correction',
      userMessageId: 'msg-correction',
      toolPolicy,
      forceResume: true,
    }).state!;
    const requestFallback = prepareConversationActionTaskState(null, {
      userText: `Read ${replayC}.`,
      requestId: 'request-only-ref',
      toolPolicy,
      forceTask: true,
    }).state!;

    expect(initial.latestInstructionRef).toBe('msg-initial');
    expect(corrected.latestInstructionRef).toBe('msg-correction');
    expect(corrected.taskCapsule?.latestCorrection?.eventRef).toBe('msg-correction');
    expect(requestFallback.latestInstructionRef).toBe('request-only-ref');
  });
});
