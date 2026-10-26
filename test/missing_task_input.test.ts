import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import os from 'node:os';
import { missingTaskInputResult, MISSING_TASK_INPUT_REASON } from '../server/cognition/missing_task_input';
import { finalizeLumiResponse } from '../server/cognition/result_finalizer';
import { decideExecutionGuardRecovery } from '../server/cognition/execution_guard_recovery';
import type { ToolExecutionRecord } from '../server/tools/types';
import { sourceDocumentInstruction } from '../server/conversation/task_target_anchor';

const task = '把 D:/orders.xlsx 的水杯数量改成4，保留原文件和公式，另存为 D:/result.xlsx，保存后回读金额。';
function missing(overrides: Partial<ToolExecutionRecord> = {}): ToolExecutionRecord {
  return { name: 'read_xlsx', arguments: { filePath: 'D:/orders.xlsx' }, result: '', adapterStarted: true,
    taskId: 'task', requestId: 'turn', error: 'XLSX file not found: D:/orders.xlsx', ...overrides };
}
describe('required source failure boundary', () => {
  it('returns the actual missing path before generic progress guards and suppresses recovery', () => {
    const result = finalizeLumiResponse({ source: 'chat', taskText: task, responseText: '正在重试', toolRecords: [missing()], taskId: 'task', requestId: 'turn' });
    expect(result).toMatchObject({ blocked: true, reason: MISSING_TASK_INPUT_REASON });
    expect(result.text).toContain('D:/orders.xlsx');
    expect(result.text).not.toContain('执行失败');
    expect(decideExecutionGuardRecovery({ ...result, allowToolUse: true, toolRecords: [missing()], task }).recoverable).toBe(false);
  });
  it.each([
    missing({ error: 'Permission denied: D:/orders.xlsx' }),
    missing({ error: 'XLSX file not found: D:/dependency.xlsx' }),
    missing({ arguments: { filePath: 'D:/optional.xlsx' }, error: 'XLSX file not found: D:/optional.xlsx' }),
    missing({ arguments: { filePath: 'D:/result.xlsx' }, error: 'XLSX file not found: D:/result.xlsx' }),
    missing({ name: 'search_files' }),
    missing({ adapterStarted: false }),
    missing({ error: undefined, result: 'XLSX file not found: D:/orders.xlsx' }),
  ])('does not confuse other failures, outputs, or file contents with required missing input', record => {
    expect(missingTaskInputResult(task, [record])).toBeNull();
  });
  it('does not block creation of a new output', () => {
    expect(missingTaskInputResult('Create D:/orders.xlsx with a price column.', [missing()])).toBeNull();
  });
  it('allows a later verified read and ignores a previous-turn missing receipt', () => {
    expect(missingTaskInputResult(task, [missing(), missing({ error: undefined, result: 'verified contents' })])).toBeNull();
    const result = finalizeLumiResponse({ source: 'chat', taskText: task, responseText: '', toolRecords: [missing()], taskId: 'task', requestId: 'next-turn' });
    expect(result.reason).not.toBe(MISSING_TASK_INPUT_REASON);
  });
});


// Exact request/receipt shape from the joint acceptance: a complete matching
// desktop glob found the original, A, and B files, but not the requested C input.
const mergeTask = '请把桌面的“共同验收甲.docx”和“共同验收丙.docx”合并成“共同验收合并.docx”，保留两份文件的全部正文，完成后把合并文件发到当前聊天。';
const desktop = 'C:\\\\Users\\\\Administrator\\\\Desktop';
const foundInputNames = ['共同验收.docx', '共同验收乙.docx', '共同验收甲.docx'];
function completeDesktopSearch(
  argumentsOverride: Record<string, unknown> = {},
  resultOverride: Record<string, unknown> = {},
  recordOverride: Partial<ToolExecutionRecord> = {},
): ToolExecutionRecord {
  const receipt = {
    kind: 'desktop_files_summary', originalCount: 3, truncated: false,
    entries: foundInputNames.map(name => desktop + '\\\\' + name), ...resultOverride,
  };
  return {
    name: 'search_files', arguments: { pattern: '共同验收*', directory: desktop, ...argumentsOverride },
    result: JSON.stringify(receipt), adapterStarted: true, taskId: 'task', requestId: 'turn',
    terminalVerification: { status: 'verified', strategy: 'terminal_receipt', reason: 'The receipt proves observation returned, not that the observed external state is complete.' },
    envelope: {
      version: 1, status: 'verified_success', toolName: 'search_files', taskId: 'task', turnId: 'turn', requestId: 'turn',
      idempotencyKey: 'matching-desktop-search', targetIdentity: '', completedAt: '2026-10-23T07:06:43.854Z', result: receipt,
      verification: { status: 'verified', basis: 'terminal_verification', reason: 'The receipt proves observation returned, not that the observed external state is complete.' },
    }, ...recordOverride,
  };
}

describe('required merge input from complete file-search evidence', () => {
  beforeEach(() => { vi.spyOn(os, 'homedir').mockReturnValue('C:/Users/Administrator'); });
  afterEach(() => { vi.restoreAllMocks(); });
  it('names the missing C input from the real complete matching glob instead of generic execution wording', () => {
    const record = completeDesktopSearch();
    const missingInput = missingTaskInputResult(mergeTask, [record]);
    expect(missingInput).toMatchObject({ blocked: true, reason: MISSING_TASK_INPUT_REASON });
    expect(missingInput?.text).toContain('共同验收丙.docx');
    expect(missingInput?.text).not.toContain('共同验收合并.docx');
    const result = finalizeLumiResponse({ source: 'chat', taskText: mergeTask, responseText: '这次还没完成。', toolRecords: [record], taskId: 'task', requestId: 'turn' });
    expect(result).toMatchObject({ blocked: true, reason: MISSING_TASK_INPUT_REASON });
    expect(result.text).toContain('共同验收丙.docx');
    expect(result.text).not.toMatch(/可验证的执行结果|未执行或未验证|执行失败/);
    expect(decideExecutionGuardRecovery({ ...result, allowToolUse: true, toolRecords: [record], task: mergeTask }).recoverable).toBe(false);
  });

  it.each([JSON.stringify, (entries: string[]) => JSON.stringify(JSON.stringify(entries))])('uses the live search_files path array before public-summary projection', serialize => {
    const record = completeDesktopSearch({ pattern: '共同验收*.docx' }, {}, { result: serialize(foundInputNames.map(name => desktop + '/' + name)) });
    const result = finalizeLumiResponse({ source: 'chat', taskText: mergeTask, responseText: '这次还没完成。', toolRecords: [record], taskId: 'task', requestId: 'turn' });
    expect(result).toMatchObject({ blocked: true, reason: MISSING_TASK_INPUT_REASON });
    expect(result.text).toContain('共同验收丙.docx');
    expect(decideExecutionGuardRecovery({ ...result, allowToolUse: true, toolRecords: [record], task: mergeTask }).recoverable).toBe(false);
  });

  it('does not treat a capped live search path array as complete absence evidence', () => {
    const paths = Array.from({ length: 200 }, (_, i) => desktop + '/共同验收' + i + '.docx');
    expect(missingTaskInputResult(mergeTask, [completeDesktopSearch({}, {}, { result: JSON.stringify(paths) })])).toBeNull();
  });

  it('rejects live search entries outside the requested directory or with invalid shapes', () => {
    for (const entries of [['D:/other/共同验收甲.docx'], [{ path: desktop + '/共同验收甲.docx' }]]) {
      expect(missingTaskInputResult(mergeTask, [completeDesktopSearch({}, {}, { result: JSON.stringify(entries) })])).toBeNull();
    }
  });

  it('accepts an empty verified live search as no matching inputs found', () => {
    expect(missingTaskInputResult(mergeTask, [completeDesktopSearch({}, {}, { result: '[]' })])?.text).toContain('共同验收甲.docx');
  });

  it('does not use an earlier-turn live search to infer missing input', () => {
    const record = completeDesktopSearch({}, {}, { result: JSON.stringify(foundInputNames.map(name => desktop + '/' + name)) });
    const result = finalizeLumiResponse({ source: 'chat', taskText: mergeTask, responseText: '', toolRecords: [record], taskId: 'task', requestId: 'next-turn' });
    expect(result.reason).not.toBe(MISSING_TASK_INPUT_REASON);
  });

  it.each([{liveArray:false,code:false},{liveArray:true,code:false},{liveArray:true,code:true}])('preserves a grounded contextual missing-input reply instead of replacing it ($liveArray, code $code)', ({liveArray,code}) => {
    const record = completeDesktopSearch({}, {}, liveArray ? { result: JSON.stringify(foundInputNames.map(name => desktop + '/' + name)) } : {});
    const text = '桌面上有“共同验收甲.docx”和“共同验收乙.docx”，但没有找到你这次指定的“共同验收丙.docx”。你原先生成的是甲、乙两份，这次的“丙”是不是写成了别的名字？请确认要用哪份，我再按你确认的文件合并。';
    const responseText = code ? text.replaceAll('“', '`').replaceAll('”', '`') : text;
    const result = finalizeLumiResponse({ source: 'chat', taskText: mergeTask, responseText, toolRecords: [record], taskId: 'task', requestId: 'turn' });
    expect(result).toMatchObject({ text: responseText, blocked: true, reason: MISSING_TASK_INPUT_REASON });
  });

  it('recognizes a bold filename in natural missing-file guidance', () => {
    const responseText = '未找到 **共同验收丙.docx**。请确认名称是否写错，或把这份文件作为附件上传到当前聊天。';
    const result = finalizeLumiResponse({ source: 'chat', taskText: mergeTask, responseText, toolRecords: [completeDesktopSearch()], taskId: 'task', requestId: 'turn' });
    expect(result).toMatchObject({ text: responseText, blocked: true, reason: MISSING_TASK_INPUT_REASON });
  });

  it('preserves a real contextual reply with past inspection and a conditional next step', () => {
    const responseText = "桌面上没有找到 **“共同验收丙.docx”**。我搜索了桌面目录，实际存在的是以下三个同名文件：\n\n- `共同验收甲.docx`（已确认）\n- `共同验收乙.docx`\n- `共同验收.docx`\n\n**“共同验收丙.docx” 不存在。**\n\n所以目前无法按原要求执行合并。请你确认一下：\n\n1. 是否是把 **“共同验收甲.docx”** 和 **“共同验收乙.docx”** 合并？还是“丙”这个文件名另有位置/拼写差异？\n2. 目标文件名是否仍为 **“共同验收合并.docx”**？\n\n你回复确认后，我就读取两份原文、合并全部正文并生成文件发到当前聊天。";
    const result = finalizeLumiResponse({ source: 'chat', taskText: mergeTask, responseText, toolRecords: [completeDesktopSearch()], taskId: 'task', requestId: 'turn' });
    expect(result).toMatchObject({ text: responseText, blocked: true, reason: MISSING_TASK_INPUT_REASON });
  });

  it('preserves the actual contextual model reply through finalization', () => {
    const responseText = "我在桌面上核查了文件，遇到一个明确阻碍需要先和你确认。\n\n**查找结果：**\n- ✅ 找到「共同验收甲.docx」\n- ❌ **没有找到「共同验收丙.docx」**\n\n桌面上实际存在的相关文件只有这三个：\n- `C:\\Users\\Administrator\\Desktop\\共同验收甲.docx`\n- `C:\\Users\\Administrator\\Desktop\\共同验收乙.docx`\n- `C:\\Users\\Administrator\\Desktop\\共同验收.docx`\n\n由于你指定的第二份文件「共同验收丙.docx」不存在，我无法擅自替换成别的文件（合并会直接影响结果内容）。\n\n请确认一下，你说的第二份文件是哪一个？\n\n1. 是 **「共同验收乙.docx」** 吗？（可能是名称记错了）\n2. 还是 **「共同验收.docx」**？\n3. 或者「共同验收丙.docx」确实存在、只是我这边检索不到？如果是，麻烦告诉我它的完整路径或把文件放到桌面后告诉我。\n\n你确认后，我就把「共同验收甲.docx」和它合并成「共同验收合并.docx」，并保留两份的完整正文，完成后发到当前聊天。";
    const result = finalizeLumiResponse({ source: 'chat', taskText: mergeTask, responseText, toolRecords: [completeDesktopSearch()], taskId: 'task', requestId: 'turn' });
    expect(result).toMatchObject({ text: responseText, blocked: true, reason: MISSING_TASK_INPUT_REASON });
  });

  it.each([
    '已经把两份文件合并成“共同验收合并.docx”，任务完成了。',
    '没有找到“无关材料.docx”，请先提供这份文件。',
    '没有找到“旧共同验收丙.docx”，请补充这份文件。',
    '没有找到“共同验收丙.docx.bak”，请补充这份文件。',
    '我已经读取“共同验收丙.docx”，并完成了合并文件。',
    'execution_recovery_incomplete: Missing core evidence for desktop_operation.',
  ])('does not preserve an unsupported, unrelated, or internal missing-input reply: %s', responseText => {
    const result = finalizeLumiResponse({ source: 'chat', taskText: mergeTask, responseText, toolRecords: [completeDesktopSearch()], taskId: 'task', requestId: 'turn' });
    expect(result).toMatchObject({ blocked: true, reason: MISSING_TASK_INPUT_REASON });
    expect(result.text).toContain('共同验收丙.docx');
    expect(result.text).not.toBe(responseText);
  });

  it('does not infer absence from a truncated search result', () => {
    expect(missingTaskInputResult(mergeTask, [completeDesktopSearch({}, { originalCount: 119, truncated: true })])).toBeNull();
  });

  it.each([
    { directory: 'C:/Users/Administrator/Documents' },
    { pattern: '共同验收甲*' },
    { pattern: '*.xlsx' },
    { pattern: 'other*' },
  ])('does not infer absence outside the requested directory or matching pattern: %j', searchArguments => {
    expect(missingTaskInputResult(mergeTask, [completeDesktopSearch(searchArguments)])).toBeNull();
  });

  it('does not mistake the absent new merged output for a required input', () => {
    const taskWithNewOutput = '请把桌面的“共同验收甲.docx”和“共同验收乙.docx”合并成“共同验收丙.docx”，保留两份文件的全部正文，完成后把合并文件发到当前聊天。';
    expect(missingTaskInputResult(taskWithNewOutput, [completeDesktopSearch()])).toBeNull();
  });

  it('does not block a merge when both source files are present and the output is new', () => {
    const entries = [...foundInputNames, '共同验收丙.docx'].map(name => desktop + '\\\\' + name);
    expect(missingTaskInputResult(mergeTask, [completeDesktopSearch({}, { originalCount: entries.length, entries })])).toBeNull();
  });

  it('does not use a complete missing-input search from an earlier turn', () => {
    const result = finalizeLumiResponse({ source: 'chat', taskText: mergeTask, responseText: '', toolRecords: [completeDesktopSearch()], taskId: 'task', requestId: 'next-turn' });
    expect(result.reason).not.toBe(MISSING_TASK_INPUT_REASON);
  });

  it('lets a later verified read of C override an earlier complete search that did not find C', () => {
    const readC: ToolExecutionRecord = {
      name: 'read_docx', arguments: { filePath: desktop + '\\\\共同验收丙.docx' },
      result: '后来用户补齐的完整正文', adapterStarted: true, taskId: 'task', requestId: 'turn',
      terminalVerification: { status: 'verified', strategy: 'terminal_receipt', reason: 'Document contents returned.' },
    };
    expect(missingTaskInputResult(mergeTask, [completeDesktopSearch(), readC])).toBeNull();
  });

  it('lets a later search finding C override an earlier complete absence observation', () => {
    const entries = [...foundInputNames, '共同验收丙.docx'].map(name => desktop + '\\\\' + name);
    const laterSearch = completeDesktopSearch({}, { entries, originalCount: entries.length });
    expect(missingTaskInputResult(mergeTask, [completeDesktopSearch(), laterSearch])).toBeNull();
  });

  it('uses a later positive observation of C even if that later search is truncated', () => {
    const entries = [...foundInputNames, '共同验收丙.docx'].map(name => desktop + '\\\\' + name);
    const laterSearch = completeDesktopSearch({}, { entries, originalCount: 119, truncated: true });
    expect(missingTaskInputResult(mergeTask, [completeDesktopSearch(), laterSearch])).toBeNull();
  });

  it('does not use a same-named C read from another directory to revoke the missing desktop input', () => {
    const differentC: ToolExecutionRecord = {
      name: 'read_docx', arguments: { filePath: 'C:/Users/Administrator/Documents/共同验收丙.docx' },
      result: '其他目录中的同名文档', adapterStarted: true, taskId: 'task', requestId: 'turn',
      terminalVerification: { status: 'verified', strategy: 'terminal_receipt', reason: 'Document contents returned.' },
    };
    expect(missingTaskInputResult(mergeTask, [completeDesktopSearch(), differentC])?.reason).toBe(MISSING_TASK_INPUT_REASON);
  });

  it.each(['合并成', '合并为', '汇总成', '汇总为', '整合成', '整合为'])('keeps the absent output after %s out of the input set', verb => {
    const outputTask = '请把桌面的“共同验收甲.docx”和“共同验收乙.docx”' + verb + '“共同验收丙.docx”，保留两份文件的全部正文。';
    const sourceInstruction = sourceDocumentInstruction(outputTask);
    expect(sourceInstruction).toContain('共同验收甲.docx');
    expect(sourceInstruction).toContain('共同验收乙.docx');
    expect(sourceInstruction).not.toContain('共同验收丙.docx');
    expect(missingTaskInputResult(outputTask, [completeDesktopSearch()])).toBeNull();
  });

  it('does not trust a search summary with a mismatched original count as complete absence evidence', () => {
    expect(missingTaskInputResult(mergeTask, [completeDesktopSearch({}, { originalCount: 119 })])).toBeNull();
  });

  it('does not trust a verified summary whose entries escape the requested directory', () => {
    const entries = ['C:/Users/Administrator/Desktop-old/共同验收甲.docx'];
    expect(missingTaskInputResult(mergeTask, [completeDesktopSearch({}, { originalCount: entries.length, entries })])).toBeNull();
  });


  it('names the missing C input from an exact ENOENT reader failure without requiring a search', () => {
    const cPath = desktop + '\\\\共同验收丙.docx';
    const missingC: ToolExecutionRecord = {
      name: 'read_docx', arguments: { filePath: cPath }, result: '', adapterStarted: true,
      taskId: 'task', requestId: 'turn', error: "ENOENT: no such file or directory, open '" + cPath + "'",
    };
    const result = finalizeLumiResponse({ source: 'chat', taskText: mergeTask, responseText: '', toolRecords: [missingC], taskId: 'task', requestId: 'turn' });
    expect(result).toMatchObject({ blocked: true, reason: MISSING_TASK_INPUT_REASON });
    expect(result.text).toContain('共同验收丙.docx');
    expect(result.text).not.toMatch(/可验证的执行结果|未执行或未验证|执行失败/);
  });

  it('names the missing C reader input after A was successfully read in the same turn', () => {
    const readA: ToolExecutionRecord = {
      name: 'read_docx', arguments: { filePath: desktop + '\\\\共同验收甲.docx' },
      result: '蓝色纸盒，共3个', adapterStarted: true, taskId: 'task', requestId: 'turn',
      terminalVerification: { status: 'verified', strategy: 'terminal_receipt', reason: 'Document contents returned.' },
    };
    const cPath = desktop + '\\\\共同验收丙.docx';
    const missingC: ToolExecutionRecord = {
      name: 'read_docx', arguments: { filePath: cPath }, result: '', adapterStarted: true,
      taskId: 'task', requestId: 'turn', error: 'DOCX file not found: ' + cPath,
    };
    const result = finalizeLumiResponse({ source: 'chat', taskText: mergeTask, responseText: '甲已读取，仍缺丙。', toolRecords: [readA, missingC], taskId: 'task', requestId: 'turn' });
    expect(result).toMatchObject({ blocked: true, reason: MISSING_TASK_INPUT_REASON });
    expect(result.text).toContain('共同验收丙.docx');
    expect(result.text).not.toMatch(/可验证的执行结果|未执行或未验证|执行失败/);
  });

});


describe('independent source reads preserve available text when another input is missing', () => {
  beforeEach(() => { vi.spyOn(os, 'homedir').mockReturnValue('C:/Users/Administrator'); });
  afterEach(() => { vi.restoreAllMocks(); });
  const readTask = 'Read Desktop files "available-notes.docx" and "waiting-notes.docx" and return their complete texts here. Do not modify or create files.';
  const body = 'Source heading\nBlue boxes: 3\nOrange bookmarks: 9\nSOURCE_END';
  function available(overrides: Partial<ToolExecutionRecord> = {}): ToolExecutionRecord {
    return missing({ name: 'read_docx', arguments: { filePath: 'C:/Users/Administrator/Desktop/available-notes.docx' },
      error: undefined, result: body, terminalVerification: { status: 'verified', strategy: 'terminal_receipt', reason: 'Complete source read.' }, ...overrides });
  }
  function waiting(): ToolExecutionRecord {
    return missing({ name: 'read_docx', arguments: { filePath: 'C:/Users/Administrator/Desktop/waiting-notes.docx' },
      error: 'DOCX file not found: C:/Users/Administrator/Desktop/waiting-notes.docx' });
  }
  it('delivers the complete available source and the actual missing-input reason while remaining blocked', () => {
    const result = finalizeLumiResponse({ source: 'chat', taskText: readTask, responseText: '', toolRecords: [available(), waiting()], taskId: 'task', requestId: 'turn' });
    expect(result).toMatchObject({ blocked: true, reason: MISSING_TASK_INPUT_REASON });
    expect(result.text).toContain('available-notes.docx');
    expect(result.text).toContain(body);
    expect(result.text).toContain('waiting-notes.docx');
    expect(result.text).toMatch(/Supply the file|correct its path/);
  });
  it('preserves a grounded natural partial reply without duplicating the source body', () => {
    const responseText = 'available-notes.docx\n' + body + '\n\nwaiting-notes.docx was not found on the Desktop. Upload it here or provide its actual path; that part is still pending.';
    const result = finalizeLumiResponse({ source: 'chat', taskText: readTask, responseText, toolRecords: [available(), waiting()], taskId: 'task', requestId: 'turn' });
    expect(result).toMatchObject({ blocked: true, reason: MISSING_TASK_INPUT_REASON });
    expect(result.text.split(body)).toHaveLength(2);
    expect(result.text).toContain('waiting-notes.docx');
  });
  it.each([
    { arguments: { filePath: 'D:/unrequested/available-notes.docx' } },
    { requestId: 'earlier-turn' },
    { terminalVerification: undefined },
    { error: 'Could not read the source' },
    { result: JSON.stringify({ path: 'C:/Users/Administrator/Desktop/available-notes.docx', size: 25 }) },
  ])('never appends unrelated, stale, unverified, failed or metadata-only source text: %j', override => {
    const result = finalizeLumiResponse({ source: 'chat', taskText: readTask, responseText: '', toolRecords: [available(override), waiting()], taskId: 'task', requestId: 'turn' });
    expect(result.blocked).toBe(true);
    expect(result.text).not.toContain(body);
  });
  it('does not use a preparatory source read to deliver a mutation request with a missing source', () => {
    const mutationTask = 'Merge Desktop files "available-notes.docx" and "waiting-notes.docx" into "merged-notes.docx".';
    const result = finalizeLumiResponse({ source: 'chat', taskText: mutationTask, responseText: '', toolRecords: [available(), waiting()], taskId: 'task', requestId: 'turn' });
    expect(result.blocked).toBe(true);
    expect(result.text).not.toContain(body);
  });
  it('does not duplicate a full source body after user-facing whitespace formatting or a second finalization', () => {
    const responseText = 'available-notes.docx\n' + body.replaceAll('\n', '\n\n') + '\nwaiting-notes.docx was not found on the Desktop. Upload the file or provide its correct path.';
    const input = { source: 'chat', taskText: readTask, responseText, toolRecords: [available(), waiting()], taskId: 'task', requestId: 'turn' };
    const first = finalizeLumiResponse(input);
    const second = finalizeLumiResponse({ ...input, responseText: first.text.replace(/\n{2,}/g, '\n') });
    for (const result of [first, second]) {
      expect(result).toMatchObject({ blocked: true, reason: MISSING_TASK_INPUT_REASON });
      expect(result.text.match(/SOURCE_END/g)).toHaveLength(1);
      expect(result.text).toContain('waiting-notes.docx');
    }
  });

  it('delivers a repeatedly observed source only once while retaining the independent missing file', () => {
    const result = finalizeLumiResponse({ source: 'chat', taskText: readTask, responseText: '', toolRecords: [available(), waiting(), available()], taskId: 'task', requestId: 'turn' });
    expect(result).toMatchObject({ blocked: true, reason: MISSING_TASK_INPUT_REASON });
    expect(result.text.match(/SOURCE_END/g)).toHaveLength(1);
    expect(result.text).toContain('waiting-notes.docx');
  });

  it('does not hide a different source merely because it has the same complete text', () => {
    const task = 'Read Desktop files "available-notes.docx" and "matching-notes.docx" and "waiting-notes.docx" and return their complete texts here. Do not modify or create files.';
    const other = available({ arguments: { filePath: 'C:/Users/Administrator/Desktop/matching-notes.docx' } });
    const responseText = 'available-notes.docx\n' + body + '\nwaiting-notes.docx was not found on the Desktop. Upload it or provide its path.';
    const result = finalizeLumiResponse({ source: 'chat', taskText: task, responseText, toolRecords: [available(), other, waiting()], taskId: 'task', requestId: 'turn' });
    expect(result).toMatchObject({ blocked: true, reason: MISSING_TASK_INPUT_REASON });
    expect(result.text).toContain('matching-notes.docx');
    expect(result.text.match(/SOURCE_END/g)).toHaveLength(2);
  });

});
