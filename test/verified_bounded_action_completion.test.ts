import './helpers';
import fs from 'node:fs';
import path from 'node:path';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ makeLLMCall: vi.fn() }));
vi.mock('../server/llm/providers', async importOriginal => ({
  ...await importOriginal<typeof import('../server/llm/providers')>(),
  makeLLMCall: mocks.makeLLMCall,
}));

import { initDatabase } from '../db_layer';
import { runWithTools } from '../server/llm/adapter';
import { ToolRegistry } from '../server/tools/registry';
import { registerFileOpsTools } from '../server/tools/definitions/file_ops';
import { registerDesktopTools } from '../server/tools/definitions/desktop_tools';
import { registerDocumentTools } from '../server/tools/definitions/document_tools';
import { guardCompletionClaims } from '../server/work_product/completion_guard';
import { finalizeLumiResponse, tryFinalizeVerifiedBoundedAction } from '../server/cognition/result_finalizer';
import { resolveAcceptedTaskTarget } from '../server/conversation/task_target_anchor';
import type { LumiTurnFlow } from '../server/cognition/turn_flow';
import type { ToolContext, ToolExecutionRecord } from '../server/tools/types';

const getters = [() => null, () => null, () => null, () => null, () => null] as const;
const root = String(process.env.LUMI_DATA_DIR);
let serial = 0;
beforeAll(() => initDatabase());
beforeEach(() => mocks.makeLLMCall.mockReset());

function fixture() {
  serial += 1;
  const registry = new ToolRegistry();
  registerFileOpsTools(registry);
  const context: ToolContext = {
    userId: 'bounded-action-user', authRole: 'admin', domain: 'personal',
    taskId: `bounded-task-${serial}`, requestId: `bounded-request-${serial}`,
    userConfirmed: true, localExecution: true, source: 'command-center-chat',
  };
  const target = path.join(root, `bounded-${serial}.txt`);
  return { registry, context, target };
}

async function run(task: string, value: ReturnType<typeof fixture>, onToolCall?: (record: ToolExecutionRecord) => void) {
  return runWithTools([{ role: 'user', content: task }], value.registry,
    { provider: 'deepseek', model: 'test-model' }, onToolCall, 4,
    ...getters, undefined, value.context);
}

describe('verified bounded actions in the real shared tool loop', () => {
  it('creates the exact XLSX and reads that real workbook before delivering its contents', async () => {
    const value = fixture();
    registerDocumentTools(value.registry);
    const output = value.target.replace(/\.txt$/, '.xlsx');
    const task = `新建 ${output}，只有一个工作表“订单”，表头为商品、数量、单价、金额，只有一条数据：水杯，2，12，24。实际保存后回读表格并告诉我内容。`;
    value.context.actionIntent = task;
    mocks.makeLLMCall.mockResolvedValueOnce({ text: '', toolCalls: [
      { id: 'xlsx', name: 'create_xlsx', arguments: { filename: 'orders', sheets: [{ name: '订单', headers: ['商品', '数量', '单价', '金额'], data: [['水杯', 2, 12, 24]] }] } },
    ] }).mockResolvedValueOnce({ text: '', toolCalls: [
      { id: 'readback', name: 'read_xlsx', arguments: { filePath: output } },
    ] }).mockResolvedValueOnce({ text: '已保存并回读订单表格：水杯，数量2，单价12，金额24。', toolCalls: [] });
    const result = await run(task, value);
    expect(result.toolCalls.map(record => record.name)).toEqual(['create_xlsx', 'read_xlsx']);
    expect(result.toolCalls.every(record => !record.error && record.terminalVerification?.status === 'verified')).toBe(true);
    expect(result.toolCalls[0].arguments?.outputPath).toBe(path.resolve(output));
    expect(result.toolCalls[1].result).toContain('水杯');
    const { loadXlsxWorkbook } = await import('../server/utils/spreadsheet');
    const sheet = (await loadXlsxWorkbook(output)).getWorksheet('订单')!;
    expect(sheet.getCell('D2').value).toBe(24);
    expect(result.completionGuard, JSON.stringify(result.completionGuard)).not.toMatchObject({ blocked: true });
    expect(result.text).toContain('24');
    expect(mocks.makeLLMCall.mock.calls.length).toBeLessThanOrEqual(3);
    const claim = { task, response: '已保存并回读订单表格：金额24。' };
    expect(guardCompletionClaims({ ...claim, toolCalls: [result.toolCalls[1]] }).blocked).toBe(true);
    expect(guardCompletionClaims({ ...claim, toolCalls: [
      { ...result.toolCalls[0], terminalVerification: { status: 'unverified', strategy: 'artifact', reason: 'missing verified output' } },
      result.toolCalls[1],
    ] }).blocked).toBe(true);
  });

  it('returns a real exact file write without another model summary or queued duplicate', async () => {
    const value = fixture();
    const content = 'LC bounded write';
    mocks.makeLLMCall.mockResolvedValueOnce({ text: '', toolCalls: [
      { id: 'write', name: 'write_file', arguments: { path: value.target, content } },
      { id: 'duplicate', name: 'write_file', arguments: { path: value.target, content: 'unwanted duplicate' } },
    ] });
    const result = await run(`在 ${value.target} 新建文本文件，只写入“${content}”。`, value);
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls?.[0].terminalVerification?.status).toBe('verified');
    expect(fs.readFileSync(value.target, 'utf8')).toBe(content);
    expect(result.text).toContain(value.target);
    expect(mocks.makeLLMCall).toHaveBeenCalledTimes(1);
  });

  it('waits for the explicitly requested same-path readback, then returns without a third model call', async () => {
    const value = fixture();
    const content = 'LC bounded readback';
    mocks.makeLLMCall.mockResolvedValueOnce({ text: '', toolCalls: [
      { id: 'write', name: 'write_file', arguments: { path: value.target, content } },
    ] }).mockResolvedValueOnce({ text: '', toolCalls: [
      { id: 'readback', name: 'read_file', arguments: { path: value.target } },
    ] });
    const result = await run(`在 ${value.target} 新建文本文件，只写入“${content}”，写完回读并告诉我全文。`, value);
    expect(result.toolCalls?.map(record => record.name)).toEqual(['write_file', 'read_file']);
    expect(result.text).toContain(content);
    expect(mocks.makeLLMCall).toHaveBeenCalledTimes(2);
  });

  it('does not confuse reading the source with delivering the requested calculation', async () => {
    const value = fixture();
    fs.writeFileSync(value.target, '商品,数量,单价\n水杯,2,12\n');
    mocks.makeLLMCall.mockResolvedValueOnce({ text: '', toolCalls: [
      { id: 'read', name: 'read_file', arguments: { path: value.target } },
    ] }).mockResolvedValueOnce({ text: '水杯：2 × 12 = 24，总额为24。', toolCalls: [] });
    const result = await run(`读取 ${value.target}，按数量乘单价告诉我总额，保留原文件。`, value);
    expect(result.toolCalls?.[0].name).toBe('read_file');
    expect(result.text).toContain('24');
    expect(mocks.makeLLMCall).toHaveBeenCalledTimes(2);
  });

  it('keeps cancellation ahead of the bounded completion shortcut and retains the real write receipt', async () => {
    const value = fixture();
    let cancelled = false;
    value.context.isCancelled = () => cancelled;
    mocks.makeLLMCall.mockResolvedValueOnce({ text: '', toolCalls: [
      { id: 'write', name: 'write_file', arguments: { path: value.target, content: 'LC cancelled write' } },
    ] });
    const result = await run(`在 ${value.target} 新建文本文件，只写入“LC cancelled write”。`, value,
      () => { cancelled = true; });
    expect(fs.readFileSync(value.target, 'utf8')).toBe('LC cancelled write');
    expect(result.toolCalls?.[0].terminalVerification?.status).toBe('verified');
    expect(result.text).toMatch(/cancelled/i);
    expect(mocks.makeLLMCall).toHaveBeenCalledTimes(1);
  });

  it('ends a simple verified app launch at its real engine receipt without a second provider call', async () => {
    const value = fixture();
    registerDesktopTools(value.registry);
    value.context.desktopRelay = vi.fn(async command => JSON.stringify(command === 'desktop_active_window'
      ? { processName: 'notepad.exe', title: 'Notepad', pid: 42 }
      : { ok: true, opened: true, target: 'Notepad' }));
    mocks.makeLLMCall.mockResolvedValueOnce({ text: '', toolCalls: [
      { id: 'open', name: 'desktop_open', arguments: { target: 'Notepad' } },
    ] });
    const result = await run('打开 Notepad。', value);
    expect(vi.mocked(value.context.desktopRelay).mock.calls.map(call => call[0]))
      .toEqual(['desktop_open', 'desktop_active_window']);
    expect(result.toolCalls?.[0].terminalVerification?.status).toBe('verified');
    expect(result.text).toContain('Notepad');
    expect(mocks.makeLLMCall).toHaveBeenCalledTimes(1);
  });

  it('does not reuse a different turn receipt or prematurely finish a compound action', async () => {
    const value = fixture();
    const content = 'LC compound';
    mocks.makeLLMCall.mockResolvedValueOnce({ text: '', toolCalls: [
      { id: 'write', name: 'write_file', arguments: { path: value.target, content } },
    ] });
    const result = await run(`在 ${value.target} 新建文本文件，只写入“${content}”。`, value);
    const base = { taskText: `在 ${value.target} 新建文本文件，只写入“${content}”。`,
      responseText: '', toolRecords: result.toolCalls, source: 'chat',
      taskId: value.context.taskId, requestId: value.context.requestId };
    expect(tryFinalizeVerifiedBoundedAction({ ...base, requestId: 'different-request' })).toBeNull();
    expect(tryFinalizeVerifiedBoundedAction({ ...base,
      taskText: `在 ${value.target} 新建文本文件，只写入“${content}”，然后打开文件。` })).toBeNull();
  });

  it('separates a verified current output readback from input identity without accepting unrelated reads', () => {
    const taskId = 'produced-readback-task';
    const requestId = 'produced-readback-request';
    const source = path.join(root, 'source.csv');
    const output = path.join(root, 'output.xlsx');
    const task = '根据原文件生成表格，回读产物后说明差异。';
    const acceptedTaskTarget = resolveAcceptedTaskTarget({
      text: task, persistedHistory: [{ id: 'source-user', role: 'user', message: `读取 ${source} 并生成新的表格。` }],
    });
    expect(acceptedTaskTarget?.target.path).toBe(source);
    const verified = { taskId, requestId, turnId: requestId,
      terminalVerification: { status: 'verified' as const, strategy: 'artifact' as const, reason: 'fixture producer/readback receipt' } };
    const write: ToolExecutionRecord = { ...verified, id: 'producer', name: 'create_xlsx',
      arguments: { filePath: output }, result: JSON.stringify({ filePath: output, ok: true }) };
    const read: ToolExecutionRecord = { ...verified, id: 'readback', name: 'read_xlsx',
      arguments: { filePath: output }, result: JSON.stringify({ ok: true, sheets: [{ name: 'Sheet1', data: [['amount'], [24]] }] }) };
    const check = (toolRecords: ToolExecutionRecord[]) => finalizeLumiResponse({
      taskText: task, responseText: '回读结果已经记录，还未完成差异分析。', source: 'chat',
      taskId, requestId, flow: { routeText: task, acceptedTaskTarget } as LumiTurnFlow, toolRecords,
    });
    expect(check([write, read]).reason).not.toBe('Verified document read target did not match the requested document.');
    expect(check([{ ...write, error: 'producer failed' }, read]).reason)
      .toBe('Verified document read target did not match the requested document.');
    expect(check([{ ...write, requestId: 'other-request' }, read]).reason)
      .toBe('Verified document read target did not match the requested document.');
    const wrongInput: ToolExecutionRecord = { ...read, id: 'wrong-input', name: 'read_file',
      arguments: { path: path.join(root, 'wrong-source.csv') }, result: 'amount\n999\n' };
    expect(check([write, read, wrongInput]).reason)
      .toBe('Verified document read target did not match the requested document.');
  });
});
