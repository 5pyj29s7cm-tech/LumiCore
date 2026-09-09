import './helpers';
import { describe, expect, it } from 'vitest';
import {
  buildTaskTargetAnchorProjection,
  guardTaskTargetToolCall,
  resolveAcceptedTaskTarget,
} from '../server/conversation/task_target_anchor';
import {
  buildActionContract,
  documentReadMatchesRequestedTarget,
  hasCoreActionEvidence,
  hasRequestedArtifactPostWriteReadback,
} from '../server/cognition/action_contract';
import { hasExplicitNoMutationInstruction, hasRequestedArtifactMutation } from '../server/cognition/tool_intent';
import type { ToolExecutionRecord } from '../server/tools/types';

const source = 'C:/Users/Administrator/Documents/orders.csv';
const other = 'C:/Users/Administrator/Documents/other/orders.csv';
const followup = '现在执行刚才的读取和计算，把每项金额和总额告诉我，不修改原文件。';
const history = [{ id: 'prior-user', role: 'user', message: `我要处理 ${source}，按数量乘单价计算每项金额和总额。现在只说明计划，不要读取文件，也不要执行操作。` }];
const read = (target = source): ToolExecutionRecord => ({
  id: 'read', name: 'read_file', arguments: { path: target },
  result: '商品,数量,单价\n水杯,2,12\n笔记本,3,8\n贴纸,4,3',
  terminalVerification: { status: 'verified', strategy: 'terminal_receipt', reason: 'verified read' },
} as ToolExecutionRecord);

describe('server-owned continuous file tasks', () => {
  it('keeps the full input path when a quantity changes and another output is named', () => {
    const text = `修改 ${source}，水杯数量改成4，另存为 C:/Users/Administrator/Documents/updated.csv`;
    const projection = buildTaskTargetAnchorProjection({ taskText: text });
    expect(projection.target.path.replaceAll('\\', '/')).toBe(source);
  });

  it('still recognizes an actual explicit replacement file', () => {
    const text = `不是 ${source}，而是 ${other}，请读取。`;
    expect(buildTaskTargetAnchorProjection({ taskText: text }).target.path.replaceAll('\\', '/')).toBe(other);
  });

  it('uses the prior user target for plan acceptance without granting prior execution authority', () => {
    const accepted = resolveAcceptedTaskTarget({ text: followup, persistedHistory: history });
    expect(accepted).toMatchObject({ source: 'prior_user_message', sourceId: 'prior-user' });
    expect(accepted?.target.path.replaceAll('\\', '/')).toBe(source);
    const guard = guardTaskTargetToolCall({ taskText: followup, toolName: 'read_file', arguments: { path: source }, acceptedTaskTarget: accepted });
    expect(guard.allowed).toBe(true);
    expect(documentReadMatchesRequestedTarget(read(), followup, accepted)).toBe(true);
    expect(hasCoreActionEvidence(buildActionContract(followup), [read()], followup, undefined, undefined, accepted)).toBe(true);
  });

  it('keeps exact path identity across directories in every layer', () => {
    const accepted = resolveAcceptedTaskTarget({ text: followup, persistedHistory: history });
    expect(guardTaskTargetToolCall({ taskText: followup, toolName: 'read_file', arguments: { path: other }, acceptedTaskTarget: accepted }).allowed).toBe(false);
    expect(documentReadMatchesRequestedTarget(read(other), followup, accepted)).toBe(false);
    expect(hasCoreActionEvidence(buildActionContract(followup), [read(other)], followup, undefined, undefined, accepted)).toBe(false);
  });

  it('binds a preserved input independently of an explicit save-as destination', () => {
    const text = '把刚才读取的 CSV 做成 Excel，原文件不动，另存为 C:/Users/Administrator/Documents/result.xlsx。保存后回读。';
    const accepted = resolveAcceptedTaskTarget({ text: followup, persistedHistory: history });
    expect(documentReadMatchesRequestedTarget(read(), text, accepted)).toBe(true);
    expect(documentReadMatchesRequestedTarget(read(other), text, accepted)).toBe(false);
    expect(documentReadMatchesRequestedTarget(read('C:/Users/Administrator/Documents/result.xlsx'), text, accepted)).toBe(false);
    expect(documentReadMatchesRequestedTarget(read(), text)).toBe(false);
    const explicit = `读取 ${source} 并计算，原文件不动，另存为 C:/Users/Administrator/Documents/result.xlsx。`;
    expect(documentReadMatchesRequestedTarget(read(), explicit)).toBe(true);
    expect(documentReadMatchesRequestedTarget(read(other), explicit, accepted)).toBe(false);
  });

  it('keeps a previously read CSV reference when later history names a produced Excel', () => {
    const intervening = { id:'export-request', role:'user', message:'创建表格，另存为 C:/Users/Administrator/Documents/exported.xlsx。' };
    const text='把刚才读取的那份 CSV 做成 Excel，原文件不动，另存为 C:/Users/Administrator/Documents/retry.xlsx。';
    expect(resolveAcceptedTaskTarget({text,persistedHistory:[...history,intervening]})?.target.path.replaceAll('\\','/')).toBe(source);
    expect(resolveAcceptedTaskTarget({text:'修改刚才的表格，数量改成4。',persistedHistory:[...history,intervening]})?.target.status).toBe('unresolved');
    expect(resolveAcceptedTaskTarget({text,persistedHistory:[intervening]})).toBeUndefined();
  });

  it('recovers a typed prior read from verified receipts when the older user path is outside the history window', () => {
    const text='把刚才读取的那份 CSV 做成 Excel，原文件不动，另存为 C:/Users/Administrator/Documents/retry.xlsx。';
    const receipt={id:'delivered',role:'assistant',requestId:'read-request',toolCalls:[{...read(),requestId:'read-request'}]};
    expect(resolveAcceptedTaskTarget({text,persistedHistory:[receipt]})?.target.path.replaceAll('\\','/')).toBe(source);
    expect(resolveAcceptedTaskTarget({text,persistedHistory:[{...receipt,requestId:'other-request'}]})).toBeUndefined();
    expect(resolveAcceptedTaskTarget({text,persistedHistory:[{...receipt,toolCalls:[{...read(),requestId:'read-request',error:'failed'}]}]})).toBeUndefined();
    const ambiguous={...receipt,toolCalls:[...receipt.toolCalls,{...read(other),requestId:'read-request'}]};
    expect(resolveAcceptedTaskTarget({text,persistedHistory:[ambiguous]})?.target.status).toBe('unresolved');
  });

  it('does not recover an assistant-invented file or attach an old task to a greeting', () => {
    expect(resolveAcceptedTaskTarget({ text: followup, persistedHistory: [{ role: 'assistant', message: `我会读取 ${other}` }] })).toBeUndefined();
    expect(resolveAcceptedTaskTarget({ text: '你好，今天心情怎么样？', persistedHistory: history })).toBeUndefined();
  });

  it('uses a new exact current target instead of a prior one', () => {
    expect(resolveAcceptedTaskTarget({ text: `现在读取 ${other}`, persistedHistory: history })?.target.path.replaceAll('\\', '/')).toBe(other);
  });

  it('keeps quantity recalculation read-only against the same accepted file', () => {
    const text = '水杯数量改成4，其他不变，只口头重新算一下，不修改原文件。';
    const accepted = resolveAcceptedTaskTarget({ text, persistedHistory: history });
    expect(accepted?.target.path.replaceAll('\\', '/')).toBe(source);
    expect(hasCoreActionEvidence(buildActionContract(text), [read()], text, undefined, undefined, accepted)).toBe(true);
  });

  it.each(['不修改原文件', '不要修改原文件', '保持原文件原样', '原文件不动'])('treats %s consistently as read-only', clause => {
    const text = `读取 ${source} 并计算总额，${clause}。`;
    expect(hasExplicitNoMutationInstruction(text)).toBe(true);
    expect(hasRequestedArtifactMutation(text)).toBe(false);
    const contract = buildActionContract(text);
    expect(hasCoreActionEvidence(contract, [read()], text)).toBe(true);
    const pathInfo = { ...read(), name: 'desktop_path_info', arguments: { target: source }, result: JSON.stringify({ exists: true, isDirectory: false }) };
    expect(hasCoreActionEvidence(contract, [pathInfo], text)).toBe(false);
  });

  it('does not treat an input read as completion when a new artifact is requested', () => {
    const text = `读取 ${source}，不要修改原文件，将结果另存为 C:/Users/Administrator/Documents/result.xlsx。`;
    expect(hasRequestedArtifactMutation(text)).toBe(true);
    expect(hasCoreActionEvidence(buildActionContract(text), [read()], text)).toBe(false);
  });

  it('does not conflate reading CSV with returning its result in chat', () => {
    const text = '创建并登记可复用技能：输入是订单CSV路径，读取商品、数量、单价三列，在聊天中返回明细和总额。';
    expect(buildActionContract(text).kind).not.toBe('messaging_read');
    expect(buildActionContract('读取微信最近的聊天记录').kind).toBe('messaging_read');
  });

  it('accepts real spreadsheet readback after writing the same output', () => {
    const target = 'C:/Users/Administrator/Documents/result.xlsx';
    const write = { ...read(), name: 'create_xlsx', arguments: { filePath: target }, result: JSON.stringify({ ok: true, filePath: target }) };
    const verification = { ...read(target), name: 'read_xlsx', arguments: { filePath: target } };
    const text = `创建 ${target}，然后回读核验。`;
    expect(hasRequestedArtifactPostWriteReadback([write], text)).toBe(false);
    expect(hasRequestedArtifactPostWriteReadback([write, verification], text)).toBe(true);
    const accepted = resolveAcceptedTaskTarget({ text: followup, persistedHistory: history });
    expect(guardTaskTargetToolCall({ taskText: followup, toolName: 'read_xlsx', arguments: { filePath: target }, acceptedTaskTarget: accepted }).allowed).toBe(false);
    expect(guardTaskTargetToolCall({ taskText: followup, toolName: 'read_xlsx', arguments: { filePath: target }, acceptedTaskTarget: accepted, toolRecords: [write] }).allowed).toBe(true);
    expect(guardTaskTargetToolCall({ taskText: followup, toolName: 'read_xlsx', arguments: { filePath: target }, acceptedTaskTarget: accepted, toolRecords: [{ ...write, error: 'write failed' }] }).allowed).toBe(false);
  });
});
