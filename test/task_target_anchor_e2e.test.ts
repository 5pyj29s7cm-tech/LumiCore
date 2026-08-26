import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  buildRecentActionContinuationBridge,
  normalizeConversationActionState,
  type ConversationActionContinuationState,
} from '../server/cognition/action_continuation';
import { guardCurrentAppToolCall } from '../server/cognition/current_app_execution';
import {
  buildTaskCapsuleV1,
  formatTaskCapsuleForPrompt,
  type DurableTaskCapsuleSource,
} from '../server/conversation/task_capsule';
import {
  buildTaskTargetAnchorProjection,
  guardTaskTargetToolCall,
  isAllowedTaskSearchDirectory,
} from '../server/conversation/task_target_anchor';
import type { ToolExecutionRecord } from '../server/tools/types';

const NOW = '2026-08-27T04:00:00.000Z';
const FILE_NAME = 'Lumia_路演资料.ppt';
const FILE_PATH = `C:\\Users\\Administrator\\Desktop\\${FILE_NAME}`;

function record(input: Partial<ToolExecutionRecord> & Pick<ToolExecutionRecord, 'name'>): ToolExecutionRecord {
  return {
    id: `record-${input.name}`,
    name: input.name,
    arguments: input.arguments || {},
    result: input.result ?? JSON.stringify({ ok: true }),
    ...input,
  } as ToolExecutionRecord;
}

const activeWps = record({
  name: 'desktop_active_window',
  result: JSON.stringify({
    ok: true,
    processName: 'wpp.exe',
    windowTitle: `${FILE_NAME} - WPS Office`,
  }),
  terminalVerification: {
    status: 'verified',
    strategy: 'terminal_receipt',
    reason: 'foreground window observed',
  },
});

const desktopSearch = record({
  name: 'search_files',
  arguments: { directory: 'C:\\Users\\Administrator\\Desktop', pattern: '*.ppt*' },
  result: JSON.stringify([{ name: FILE_NAME, path: FILE_PATH }]),
  terminalVerification: {
    status: 'verified',
    strategy: 'terminal_receipt',
    reason: 'bounded directory search completed',
  },
});

function currentWpsSource(overrides: Partial<DurableTaskCapsuleSource> = {}): DurableTaskCapsuleSource {
  return {
    taskId: 'task-current-wps-analysis',
    revision: 3,
    status: 'executing',
    unfinished: true,
    goal: '分析 WPS 当前打开的这份文件，并给出五项结论。',
    latestInstruction: '分析 WPS 当前打开的这份文件。',
    appTarget: 'WPS',
    sourcePaths: [
      'D:\\lumiOS\\dist-server\\entry.cjs',
      'D:\\lumiOS\\node_modules',
    ],
    receipts: [],
    toolSummaries: [],
    updatedAt: NOW,
    ...overrides,
  };
}

describe('real file/desktop target anchoring', () => {
  it('anchors the current WPS object from trusted foreground evidence and drops runtime artifacts', () => {
    const source = currentWpsSource({
      receipts: [{
        id: 'receipt-active-wps',
        key: 'desktop_active_window:current',
        name: activeWps.name,
        arguments: {},
        result: activeWps.result,
        error: '',
        outcome: 'success',
        terminalVerification: activeWps.terminalVerification,
        recordedAt: NOW,
      }],
    });
    const capsule = buildTaskCapsuleV1(source)!;

    expect(capsule.target).toEqual(expect.objectContaining({
      application: 'WPS',
      window: `${FILE_NAME} - WPS Office`,
      object: FILE_NAME,
      label: FILE_NAME,
      path: '',
      status: 'confirmed',
      source: 'active_window',
    }));
    expect(capsule.paths).toEqual([]);
    expect(capsule.analysisReady).toBe(true);
    expect(capsule.nextAction).toBe('analyze');
    expect(capsule.allowedSearchRoots).toEqual([
      '~/Desktop',
      '~/Documents',
      '~/Downloads',
    ]);

    const prompt = formatTaskCapsuleForPrompt(capsule);
    expect(prompt).toContain(`- targetWindow: ${FILE_NAME} - WPS Office`);
    expect(prompt).toContain(`- targetObject: ${FILE_NAME}`);
    expect(prompt).toContain('- targetStatus: confirmed');
    expect(prompt).toContain('- targetSource: active_window');
    expect(prompt).toContain('- analysisReady: yes');
    expect(prompt).not.toContain('dist-server');
    expect(prompt).not.toContain('node_modules |');
  });

  it('enforces active-window-first, bounded discovery, and exact target binding at shared preflight', () => {
    const taskText = '帮我分析一下 WPS 当前打开的这份文件。';

    expect(guardCurrentAppToolCall({
      taskText,
      toolName: 'search_files',
      arguments: { directory: 'C:\\Users\\Administrator\\Desktop', pattern: '*.ppt*' },
      toolRecords: [],
    })).toMatchObject({
      allowed: false,
      status: 'blocked',
      code: 'active_document_required',
      clarification: { required: true },
    });

    expect(guardCurrentAppToolCall({
      taskText,
      toolName: 'search_files',
      arguments: { directory: 'D:\\lumiOS\\dist-server', pattern: '*' },
      toolRecords: [activeWps],
    })).toMatchObject({
      allowed: false,
      code: 'runtime_candidate_forbidden',
    });

    expect(guardCurrentAppToolCall({
      taskText,
      toolName: 'search_files',
      arguments: { directory: 'C:\\Users\\Administrator\\Desktop', pattern: '*.ppt*' },
      toolRecords: [activeWps],
    })).toMatchObject({ allowed: true });

    // A foreground title can anchor a native/current-document interface, but
    // it is not a filesystem path for a generic extractor.
    expect(guardCurrentAppToolCall({
      taskText,
      toolName: 'extract_document_text',
      arguments: {},
      toolRecords: [activeWps],
    })).toMatchObject({ allowed: false, code: 'target_unresolved' });
    expect(guardCurrentAppToolCall({
      taskText,
      toolName: 'wps_read_presentation',
      arguments: { mode: 'outline' },
      toolRecords: [activeWps],
    })).toMatchObject({ allowed: true });

    expect(guardCurrentAppToolCall({
      taskText,
      toolName: 'extract_document_text',
      arguments: { filePath: 'D:\\lumiOS\\dist-server\\entry.cjs' },
      toolRecords: [activeWps, desktopSearch],
    })).toMatchObject({
      allowed: false,
      code: 'runtime_candidate_forbidden',
    });

    expect(guardCurrentAppToolCall({
      taskText,
      toolName: 'extract_document_text',
      arguments: { filePath: 'C:\\Users\\Administrator\\Desktop\\另一份路演.ppt' },
      toolRecords: [activeWps, desktopSearch],
    })).toMatchObject({
      allowed: false,
      code: 'target_mismatch',
    });

    expect(guardCurrentAppToolCall({
      taskText,
      toolName: 'extract_document_text',
      arguments: { filePath: FILE_PATH },
      toolRecords: [activeWps, desktopSearch],
    })).toMatchObject({
      allowed: true,
      anchor: {
        analysisReady: true,
        target: {
          application: 'WPS',
          window: `${FILE_NAME} - WPS Office`,
          object: FILE_NAME,
          path: FILE_PATH,
          status: 'confirmed',
          source: 'tool_receipt',
        },
      },
    });
  });

  it('returns a natural structured clarification instead of analyzing an unnamed window', () => {
    const unnamedWps = record({
      name: 'desktop_active_window',
      result: JSON.stringify({ ok: true, processName: 'wps.exe', windowTitle: 'WPS Office' }),
    });
    const guarded = guardTaskTargetToolCall({
      taskText: '分析 WPS 当前打开的这份资料。',
      toolName: 'extract_document_text',
      arguments: {},
      toolRecords: [unnamedWps],
    });

    expect(guarded).toMatchObject({
      allowed: false,
      status: 'blocked',
      code: 'target_unresolved',
      clarification: { required: true },
      anchor: {
        analysisReady: false,
        nextAction: 'clarify_target',
        target: {
          application: 'WPS',
          window: 'WPS Office',
          object: '',
          status: 'unresolved',
        },
      },
    });
    expect(guarded.clarification?.question).toMatch(/\u6700\u7ec8\u6587\u4ef6\u540d/);
  });

  it('allows only standard roots or a directory explicitly supplied by the user', () => {
    const explicitTask = '分析 D:\\ClientDelivery\\Q3\\report.pdf，必要时在 D:\\ClientDelivery\\Q3 里搜索。';
    expect(isAllowedTaskSearchDirectory(path.join(os.homedir(), 'Desktop'), explicitTask)).toBe(true);
    expect(isAllowedTaskSearchDirectory(path.join(os.homedir(), 'Documents'), explicitTask)).toBe(true);
    expect(isAllowedTaskSearchDirectory(path.join(os.homedir(), 'Downloads'), explicitTask)).toBe(true);
    expect(isAllowedTaskSearchDirectory('D:\\arbitrary-profile\\Desktop', explicitTask)).toBe(false);
    expect(isAllowedTaskSearchDirectory('D:\\ClientDelivery\\Q3', explicitTask)).toBe(true);
    expect(isAllowedTaskSearchDirectory('D:\\ClientDelivery\\Q3\\Archive', explicitTask)).toBe(true);
    expect(isAllowedTaskSearchDirectory('D:\\ClientDelivery\\Q3\\..\\Secrets', explicitTask)).toBe(false);
    expect(isAllowedTaskSearchDirectory(
      `${os.homedir()}\\Documents\\..\\AppData\\Roaming`,
      'search for report.pdf',
    )).toBe(false);
    expect(isAllowedTaskSearchDirectory(
      'D:\\arbitrary-profile\\Desktop',
      '在 D:\\arbitrary-profile\\Desktop 搜索 report.pdf。',
    )).toBe(true);
    expect(isAllowedTaskSearchDirectory('D:\\lumiOS\\dist-server', explicitTask)).toBe(false);
    expect(isAllowedTaskSearchDirectory('', explicitTask)).toBe(false);
  });

  it('does not treat a same-basename file as the exact anchored path', () => {
    const guarded = guardTaskTargetToolCall({
      taskText: 'read C:\\Users\\Alice\\Documents\\report.pdf',
      toolName: 'read_file',
      arguments: { path: 'D:\\Private\\report.pdf' },
      toolRecords: [],
    });

    expect(guarded).toMatchObject({
      allowed: false,
      status: 'blocked',
      code: 'target_mismatch',
    });
  });

  it('persists the corrected target and hard-blocks the rejected file on the next turn', () => {
    const wrongPath = 'C:\\Users\\Administrator\\Desktop\\旧版路演.pptx';
    const state = normalizeConversationActionState({
      version: 2,
      taskId: 'task-reject-old-file',
      revision: 7,
      status: 'blocked',
      goal: '分析 WPS 当前打开的路演文件。',
      latestInstruction: '不是旧版路演.pptx，改成 Lumia_路演资料.ppt。',
      appTarget: 'WPS',
      sourcePaths: [wrongPath],
      latestBlocker: 'wrong file',
      unfinished: true,
      evidenceTools: ['desktop_open'],
      assistantState: '',
      toolSummaries: [],
      receipts: [],
      updatedAt: NOW,
    } satisfies ConversationActionContinuationState)!;

    expect(state.taskCapsule).toMatchObject({
      target: {
        object: FILE_NAME,
        status: 'candidate',
        source: 'user_correction',
      },
      analysisReady: false,
      nextAction: 'search_bounded_roots',
    });
    expect(state.taskCapsule?.rejectedTargets).toContainEqual(expect.objectContaining({ identity: wrongPath }));
    expect(state.taskCapsule?.doNotRetry).toContainEqual(expect.objectContaining({
      fingerprint: 'target:c:/users/administrator/desktop/旧版路演.pptx',
    }));

    const bridge = buildRecentActionContinuationBridge('继续', [], state);
    expect(bridge).toContain(`- targetObject: ${FILE_NAME}`);
    expect(bridge).toContain('target:c:/users/administrator/desktop/旧版路演.pptx');
    expect(guardCurrentAppToolCall({
      taskText: `继续\n${bridge}`,
      toolName: 'desktop_open',
      arguments: { target: wrongPath },
      toolRecords: [],
    })).toMatchObject({
      allowed: false,
      code: 'rejected_target',
    });
  });

  it('never promotes list results from the process directory into a material target', () => {
    const projection = buildTaskTargetAnchorProjection({
      taskText: '我重新整理了一下资料，这个资料你帮我看一下。',
      applicationHint: 'WPS',
      sourcePaths: [
        'D:\\lumiOS\\dist-server\\entry.cjs',
        'D:\\lumiOS\\node_modules',
      ],
      evidence: [record({
        name: 'desktop_list_files',
        arguments: { path: 'D:\\lumiOS\\dist-server' },
        result: JSON.stringify(['entry.cjs', 'node.exe', 'node_modules']),
      })],
    });

    expect(projection.target).toMatchObject({
      application: 'WPS',
      object: '',
      path: '',
      status: 'unresolved',
      source: 'unknown',
    });
    expect(projection.analysisReady).toBe(false);
    expect(projection.nextAction).toBe('clarify_target');
    expect(projection.ignoredCandidates).toEqual(expect.arrayContaining([
      'D:\\lumiOS\\dist-server\\entry.cjs',
      'D:\\lumiOS\\node_modules',
    ]));
  });
});
