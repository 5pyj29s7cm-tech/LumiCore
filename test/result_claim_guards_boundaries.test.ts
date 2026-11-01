import { describe, expect, it } from 'vitest';
import { groundedVerifiedDocumentObservation, leakedLegacyToolProtocol } from '../server/cognition/result_claim_guards';
import { finalizeLumiResponse } from '../server/cognition/result_finalizer';
import type { LumiResultFinalizerInput } from '../server/cognition/result_finalizer_types';
import type { ToolExecutionRecord } from '../server/tools/types';

const requestId = 'claim-guard-current';
const taskId = 'claim-guard-task';
const sourcePath = 'D:/synthetic-evidence/source-note.txt';
const body = '项目原文：本周讨论布局，尚未安排交付。';
function readRecord(content = body, overrides: Partial<ToolExecutionRecord> = {}): ToolExecutionRecord {
  return { name: 'read_file', arguments: { path: sourcePath }, requestId, taskId, result: content,
    terminalVerification: { status: 'verified', strategy: 'terminal_receipt', reason: 'Synthetic exact-path read receipt; no real file accessed.' }, ...overrides };
}
function readInput(responseText: string, records = [readRecord()]): LumiResultFinalizerInput {
  return { taskText: `读取文件 "${sourcePath}" 并展示内容。`, responseText, source: 'chat', requestId, taskId, toolRecords: records };
}

describe('verified document reply claims', () => {
  it.each([
    '我已经发送消息。',
    'I sent the file to the client.',
    '正在执行——',
    '我现在正在发送文件。',
    '文件已保存到 D:/synthetic-evidence/unrequested.txt。',
    '播放已启动，音量 72%。',
    '当前使用本地 TTS，音色是 Lumi-Neutral v2。',
  ])('does not let a completed read substantiate an unrelated execution claim: %s', response => {
    const result = groundedVerifiedDocumentObservation(readInput(response));
    expect(result).not.toBeNull();
    expect(result!.blocked).toBe(true);
    expect(result!.text).not.toContain(response);
  });
  it('retains source facts while blocking a fabricated send appended after the source', () => {
    const literal = '原文记录：我已经发送消息。\n这句话属于文件中的历史记录。';
    const input = readInput(`${literal}\n\n我已经发送文件给客户。`, [readRecord(literal)]);
    expect(groundedVerifiedDocumentObservation(input)?.blocked).toBe(true);
  });
  it.each([
    '我已经发送消息。',
    '正在执行——',
    '文件已保存到 D:/synthetic-evidence/unrequested.txt。',
  ])('keeps exact source literals as document content, not assistant execution: %s', literal => {
    const input = readInput(literal, [readRecord(literal)]);
    expect(groundedVerifiedDocumentObservation(input)).toMatchObject({ blocked: false, text: literal });
  });
  it('preserves a quoted source and a substantive independent summary', () => {
    const literal = '我已经发送消息。';
    const response = `原文说“${literal}”。这是一条历史记录，未说明收件人或日期。`;
    const input = { ...readInput(response, [readRecord(literal)]), taskText: `总结文件 "${sourcePath}"。` };
    expect(groundedVerifiedDocumentObservation(input)).toMatchObject({ blocked: false, text: response });
  });
  it('preserves negative statements and advice without fabricating an action', () => {
    const response = '没有发送文件。你可以先核对收件人。';
    expect(groundedVerifiedDocumentObservation(readInput(response))).toMatchObject({ blocked: false, text: response });
  });
  it('does not subtract a short source word from an independent send claim', () => {
    expect(groundedVerifiedDocumentObservation(readInput('I sent the file to the client.', [readRecord('sent')]))?.blocked).toBe(true);
  });
  it.each(['stale-request', 'different-task', 'different-target', 'unverified'])('rejects %s read evidence', kind => {
    const record = readRecord(body, kind === 'stale-request' ? { requestId: 'old' }
      : kind === 'different-task' ? { taskId: 'other' }
      : kind === 'different-target' ? { arguments: { path: 'D:/synthetic-evidence/other.txt' } }
      : { terminalVerification: { status: 'unverified', strategy: 'terminal_receipt', reason: 'not verified' } });
    expect(groundedVerifiedDocumentObservation(readInput(body, [record]))).toBeNull();
  });
  it('preserves a downstream blocked verdict despite a successful read', () => {
    const completionGuard = { blocked: true, text: 'The delivery is unconfirmed.', reason: 'delivery_unconfirmed' };
    expect(groundedVerifiedDocumentObservation({ ...readInput(body), completionGuard })).toEqual(completionGuard);
  });
  it('does not turn a source echo into completed analysis', () => {
    const input = { ...readInput(body), taskText: `分析文件 "${sourcePath}"。` };
    expect(groundedVerifiedDocumentObservation(input)?.blocked).toBe(true);
  });
  it('blocks an unsupported send claim at the real finalizer boundary', () => {
    const response = '我已经发送消息。';
    const result = finalizeLumiResponse(readInput(response));
    expect(result.blocked).toBe(true);
    expect(result.text).not.toContain(response);
  });
  it('completes the verified read while replacing an unsupported ongoing tail with the actual source', () => {
    expect(finalizeLumiResponse(readInput('正在执行——'))).toMatchObject({ blocked: false, text: body });
  });
  it('preserves a diagnostic claim that is the exact observed source body', () => {
    const literal = '刚才在跑自检，扫描 MCP 连接。';
    expect(finalizeLumiResponse(readInput(literal, [readRecord(literal)]))).toMatchObject({ blocked: false, text: literal });
  });
});

describe('legacy protocol boundaries', () => {
  it.each(['｜', '｜｜', '|', '||'])('blocks namespaced DSML tool protocol with marker %s', marker => {
    const responseText = `<${marker}DSML${marker}tool_calls><${marker}DSML${marker}invoke name="client_get_state"></${marker}DSML${marker}invoke></${marker}DSML${marker}tool_calls>`;
    const result = leakedLegacyToolProtocol({ taskText: '检查客户端状态。', responseText, toolRecords: [], source: 'chat' });
    expect(result?.blocked).toBe(true);
    expect(result?.text).not.toContain('DSML');
    expect(result?.text).not.toContain('client_get_state');
  });
  it.each(['<invoke name="client_get_state"/>', '```tool_call\nclient_get_state({})\n```', '[tool] client_get_state({})'])('retains ordinary protocol protection: %s', responseText => {
    expect(leakedLegacyToolProtocol({ taskText: '检查客户端状态。', responseText, source: 'chat' })?.blocked).toBe(true);
  });
  it('does not mistake ordinary XML content for a tool protocol', () => {
    expect(leakedLegacyToolProtocol(readInput('<invoice><total>33</total></invoice>'))).toBeNull();
  });
  it.each(['<invoke name="client_get_state"/>', '<｜｜DSML｜｜tool_calls></｜｜DSML｜｜tool_calls>'])('preserves exact verified source literals containing protocol syntax: %s', literal => {
    const input = readInput(literal, [readRecord(literal)]);
    expect(leakedLegacyToolProtocol(input)).toBeNull();
    expect(groundedVerifiedDocumentObservation(input)).toMatchObject({ text: literal, blocked: false });
  });
  it('does not let a stale source authorize a literal protocol response', () => {
    const literal = '<｜｜DSML｜｜tool_calls></｜｜DSML｜｜tool_calls>';
    expect(leakedLegacyToolProtocol(readInput(literal, [readRecord(literal, { requestId: 'old' })]))?.blocked).toBe(true);
  });
  it('does not expose DSML at the real finalizer boundary without any executed tool', () => {
    const result = finalizeLumiResponse({ taskText: '检查客户端状态。', responseText: '<｜｜DSML｜｜invoke name="client_get_state"/>', toolRecords: [], source: 'chat' });
    expect(result.blocked).toBe(true);
    expect(result.text).not.toContain('DSML');
  });
  it('keeps literal protocol source bytes through the real finalizer boundary', () => {
    const literal = '<invoke name="client_get_state"/>';
    expect(finalizeLumiResponse(readInput(literal, [readRecord(literal)]))).toMatchObject({ blocked: false, text: literal });
  });
});

describe('canonical CAD result priority over model protocol', () => {
  function cadInput(verified = true): LumiResultFinalizerInput {
    return { taskText: '把给定几何画进 AutoCAD，逐笔绘制并核验。', responseText: '<invoke name="unexecuted_next_tool"/>', source: 'chat', requestId, taskId,
      toolRecords: [{ name: 'mcp_cad-drafting_autocad_playback_file', arguments: {}, requestId, taskId,
        result: JSON.stringify({ status: 'completed', transport: 'mcp_autocad_com', visiblePlayback: true,
          completionMarkerExists: true, completionMarkerPath: 'D:/synthetic-evidence/cad_completed.txt', operationsPath: 'D:/synthetic-evidence/cad_operations.json',
          geometryVerified: verified, entityCountMatches: verified, operationCount: 46, expectedEntityCount: 46, entitiesAdded: verified ? 46 : 45,
          operationSetId: 'synthetic-operation-set', strokeDelayMs: 450 }),
        terminalVerification: { status: verified ? 'verified' : 'failed', strategy: 'terminal_receipt', reason: 'Synthetic host result only; no CAD executed.' } }] };
  }
  it('uses the verified current CAD result without returning unexecuted model protocol', () => {
    const result = finalizeLumiResponse(cadInput());
    expect(result.blocked).toBe(false);
    expect(result.text).toContain('46');
    expect(result.text).not.toContain('<invoke');
  });
  it('does not complete failed CAD geometry when protocol text is present', () => {
    expect(finalizeLumiResponse(cadInput(false)).blocked).toBe(true);
  });
  it('does not complete from a stale CAD result when protocol text is present', () => {
    const input = cadInput(); input.toolRecords![0].requestId = 'old';
    expect(finalizeLumiResponse(input).blocked).toBe(true);
  });
  it('does not override an explicit failed terminal verification using a successful-looking CAD payload', () => {
    const input = cadInput();
    input.toolRecords![0].terminalVerification = { status: 'failed', strategy: 'terminal_receipt', reason: 'Host rejected the completion receipt.' };
    expect(finalizeLumiResponse(input).blocked).toBe(true);
  });
});

describe('reply exclusions do not hide independent real actions', () => {
  it.each(['我打开了思路。', '我先检查一下自己的回答。'])('keeps ordinary reflective prose: %s', responseText => {
    expect(finalizeLumiResponse({ taskText: '好的', responseText, source: 'chat', toolRecords: [] })).toMatchObject({ blocked: false, text: responseText });
  });
  it.each(['我打开了思路并已发送文件给客户。', '我先读取文件再回答你的问题。'])('still rejects a physical action combined with excluded prose: %s', responseText => {
    const result = finalizeLumiResponse({ taskText: '好的', responseText, source: 'chat', toolRecords: [] });
    expect(result.blocked).toBe(true);
    expect(result.text).not.toBe(responseText);
  });
});
