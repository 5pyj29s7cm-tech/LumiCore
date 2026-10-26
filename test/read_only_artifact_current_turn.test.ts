import './helpers';
import os from 'node:os';
import { documentReadMatchesRequestedTarget, requestsExactReadOnlyArtifactInspection } from '../server/cognition/action_desktop_evidence';
import { describe, expect, it } from 'vitest';
import { buildActionEvidenceContract, hasCoreActionEvidence, formatActionContractPrompt } from '../server/cognition/action_contract';
import type { ToolExecutionRecord } from '../server/tools/types';
const taskText = 'Read D:/case-source/A.md and show its complete contents.';
const scope = { taskId: 'current-read-task', requestId: 'current-read-request' };
const read = (overrides: Partial<ToolExecutionRecord> = {}): ToolExecutionRecord => ({ ...scope, name: 'read_file', arguments: { path: 'D:/case-source/A.md' }, result: 'Complete existing source body.\nSOURCE_END', adapterStarted: true, terminalVerification: { status: 'verified', strategy: 'terminal_receipt', reason: 'Offline existing read-evidence scope test.' }, ...overrides });
const core = (rows: ToolExecutionRecord[], current?: { taskId?: string; requestId?: string }) => hasCoreActionEvidence(buildActionEvidenceContract(taskText), rows, taskText, undefined, current);
describe('existing artifact read evidence keeps the current turn scope', () => {
 it('accepts the complete verified current source', () => { expect(core([read()], scope)).toBe(true); });
 it.each([{ taskId: 'foreign-task', requestId: scope.requestId }, { taskId: scope.taskId, requestId: 'foreign-request' }])('rejects a restored receipt from a different turn %j', foreign => {
  expect(core([read()], scope)).toBe(true);
  expect(core([read(foreign)], scope)).toBe(false);
 });
 it('accepts the current receipt among restored foreign receipts', () => {
  expect(core([read({ requestId: 'foreign-request' }), read()], scope)).toBe(true);
 });
 it('keeps the established compatibility when no current scope is supplied', () => { expect(core([read()])).toBe(true); });
 it('does not let scope filtering weaken exact-path, failure or verified evidence boundaries', () => {
  expect(core([read({ arguments: { path: 'D:/other-source/A.md' } })], scope)).toBe(false);
  expect(core([read({ error: 'read failed' })], scope)).toBe(false);
  expect(core([read({ terminalVerification: undefined })], scope)).toBe(false);
  expect(core([read({ result: '{"ok":false,"content":"invented source"}' })], scope)).toBe(false);
 });
});


describe('read-only inspection uses the existing format readers for every named input', () => {
 it.each([
  ['docx', 'read_docx'],
  ['pdf', 'read_pdf'],
  ['xlsx', 'read_xlsx'],
  ['pptx', 'extract_document_text'],
  ['txt', 'read_file'],
 ])('accepts complete %s source evidence through %s without requiring file production', (extension, reader) => {
  const sourcePath = 'D:/case-source/input.' + extension;
  const task = 'Read ' + sourcePath + ' and show its complete contents. Do not modify or create files.';
  const contract = buildActionEvidenceContract(task);
  const receipt = read({ name: reader, arguments: reader === 'read_file' ? { path: sourcePath } : { filePath: sourcePath } });
  expect(contract).toMatchObject({ kind: 'artifact_work', label: 'Exact read-only file inspection' });
  expect(contract.preferredTools).toContain(reader);
  expect(contract.verificationTools).toContain(reader);
  expect(hasCoreActionEvidence(contract, [receipt], task, undefined, scope)).toBe(true);
  expect(hasCoreActionEvidence(contract, [read({ ...receipt, error: 'Source read failed' })], task, undefined, scope)).toBe(false);
  expect(hasCoreActionEvidence(contract, [read({ ...receipt, arguments: { filePath: 'D:/other-source/input.' + extension } })], task, undefined, scope)).toBe(false);
 });

 it('keeps format-aware reads and individual partial outcomes in the model-facing contract for a multi-input request', () => {
  const task = '请读取桌面的“申请材料.docx”和“补充说明.pdf”，把两份文件的完整文字分别发到当前聊天。只读取，不修改或创建文件。';
  const contract = buildActionEvidenceContract(task);
  const prompt = formatActionContractPrompt(contract);
  expect(contract).toMatchObject({ kind: 'artifact_work', label: 'Exact read-only file inspection' });
  expect(contract.preferredTools).toEqual(expect.arrayContaining(['read_docx', 'read_pdf', 'read_xlsx', 'extract_document_text', 'read_file', 'knowledge_file_stats']));
  expect(prompt).toContain('DOCX uses read_docx');
  expect(prompt).toContain('PDF uses read_pdf');
  expect(prompt).toContain('UTF-8 plain text uses read_file');
  expect(prompt).toContain('continue the other independent inputs');
  expect(prompt).toContain('without hiding the successful source bodies');
  expect(prompt).toContain('Do not create or modify files');
  expect(prompt).not.toContain('Use read_file for an exact user-named local absolute path');
 });
});


describe('every explicitly requested read source needs its own verified current-turn body', () => {
 const documentRead = (filePath: string, overrides: Partial<ToolExecutionRecord> = {}) => read({ name: 'read_docx', arguments: { filePath }, result: 'Complete source body.\nSOURCE_END', ...overrides });
 const complete = (task: string, rows: ToolExecutionRecord[]) => hasCoreActionEvidence(buildActionEvidenceContract(task), rows, task, undefined, scope);
 it('does not complete a coordinated same-clause read from only one absolute input', () => {
  const task = 'Read the files "D:/case-source/first.docx" and "D:/case-source/second.docx" and show their complete contents. Do not modify or create files.';
  const first = documentRead('D:/case-source/first.docx'), second = documentRead('D:/case-source/second.docx');
  expect(complete(task, [first])).toBe(false);
  expect(complete(task, [second])).toBe(false);
  expect(complete(task, [first, second])).toBe(true);
  for (const changed of [{ requestId: 'old-request' }, { taskId: 'old-task' }, { error: 'Source read failed' }, { terminalVerification: undefined }]) {
   expect(complete(task, [first, documentRead('D:/case-source/second.docx', changed)])).toBe(false);
  }
 });
 it.each([
  '请读取桌面的“申请材料.docx”和“补充说明.docx”，把两份文件的完整文字分别发到当前聊天。只读取，不修改或创建文件。',
  'Read Desktop files "申请材料.docx" and "补充说明.docx" and show their complete contents. Do not modify or create files.',
 ])('binds every named Desktop input to that exact standard folder: %s', task => {
  const desktop = os.homedir().replace(/\\/gu, '/') + '/Desktop/';
  const first = documentRead(desktop + '申请材料.docx'), second = documentRead(desktop + '补充说明.docx');
  expect(complete(task, [first])).toBe(false);
  expect(complete(task, [first, second])).toBe(true);
  expect(complete(task, [documentRead('D:/unrequested/申请材料.docx'), second])).toBe(false);
 });
 it('does not accept a same-basename read from outside an explicitly requested Desktop folder', () => {
  const task = 'Read Desktop files "available-notes.docx" and "waiting-notes.docx" and show their complete contents.';
  const wrong = documentRead('D:/unrequested/available-notes.docx');
  expect(documentReadMatchesRequestedTarget(wrong, task)).toBe(false);
 });
 it.each([
  'Read "D:/case-source/A.json" and report the value of field "second.docx".',
  'Read "D:/case-source/A.json" and report {"file":"second.docx"}.',
  'Read "D:/case-source/A.json". The document says “Read the file second.docx”.',
  'Read "D:/case-source/A.json". If needed, inspect "D:/case-source/optional.docx".',
 ])('does not promote document prose, quoted commands, optional reads or JSON values into another required input: %s', task => {
  const source = read({ arguments: { path: 'D:/case-source/A.json' }, result: '{"file":"second.docx"}' });
  expect(complete(task, [source])).toBe(true);
 });
 it('keeps same-named files in different explicit directories independent', () => {
  const task = 'Read the files "D:/first/source.docx" and "D:/second/source.docx" and show their complete contents.';
  const first = documentRead('D:/first/source.docx'), second = documentRead('D:/second/source.docx');
  expect(complete(task, [first])).toBe(false);
  expect(complete(task, [first, second])).toBe(true);
 });
});


describe('same-turn filename corrections keep affirmative read-only follow-ups', () => {
 it.each(['只读', '只补读', '补读', '读取'])('uses the exact read-only contract after a corrected filename and %s pronoun command', verb => {
  const task = '第二份文件名写错了，实际是桌面的“corrected-note.docx”。请' + verb + '这份，把完整正文发到当前聊天，上一份不需要再读。';
  const contract = buildActionEvidenceContract(task);
  const sourcePath = os.homedir().replace(/\\/gu, '/') + '/Desktop/corrected-note.docx';
  const accepted = { target: { status: 'confirmed', path: sourcePath, object: 'corrected-note.docx' }, source: 'current' } as any;
  const source = read({ name: 'read_docx', arguments: { filePath: sourcePath }, result: 'Corrected source title\nComplete current source body.' });
  expect(contract).toMatchObject({ kind: 'artifact_work', label: 'Exact read-only file inspection' });
  expect(contract.preferredTools).toContain('read_docx');
  expect(hasCoreActionEvidence(contract, [source], task, undefined, scope, accepted)).toBe(true);
  expect(hasCoreActionEvidence(contract, [read({ ...source, arguments: { filePath: 'D:/other/corrected-note.docx' } })], task, undefined, scope, accepted)).toBe(false);
 });
 it.each([
  '文件名为“corrected-note.docx”。上一份不需要再读。',
  '“corrected-note.docx”的只读模式是什么意思？',
  '文件正文为“请只补读这份”。',
  '例如，实际是桌面的“corrected-note.docx”。请只补读这份。',
 ])('does not invent a source read from a negative, mode discussion, quoted instruction or example: %s', task => {
  expect(requestsExactReadOnlyArtifactInspection(task)).toBe(false);
 });
 it('does not let a later read-only switch erase affirmative file creation', () => {
  const task = '请创建 D:/case-source/new-note.txt，内容为“只补读这份”。然后把文件设为只读。';
  expect(requestsExactReadOnlyArtifactInspection(task)).toBe(false);
 });
});


describe('analysis of previously read chat text does not invent a fresh file read', () => {
 const context = '根据刚才已经读出的正文，比较“source-a.docx”和“source-b.docx”的数量，分别说明是否一致以及差额。';
 it.each([
  context + '不要重新读取文件，也不要生成附件。',
  '根据刚才已经读出的正文，总结“source-a.docx”的主要内容。不要重新读取文件，也不要生成附件。',
  'Based on the text already read earlier, compare quantities in "source-a.docx" and "source-b.docx". Do not re-read files or generate attachments.',
  '根据刚才已经读出的正文，比较“读取并发送.docx”和“生成摘要.docx”的数量。不要重新读取文件。',
 ])('uses existing chat text without requiring a current source receipt: %s', task => {
  expect(requestsExactReadOnlyArtifactInspection(task)).toBe(false);
  expect(buildActionEvidenceContract(task)).toMatchObject({ kind: 'none', applies: false });
 });
 it.each([
  context + '不要重新读取原文件。然后读取桌面的“new-source.docx”，核对完整正文。',
  context + '现在重新读取桌面的“source-a.docx”，核对完整正文。',
  '原文写着“根据刚才已经读出的正文比较数量”。请读取桌面的“source-a.docx”，给出完整正文。',
  '例如，根据刚才已经读出的正文比较数量。请读取桌面的“source-a.docx”，给出完整正文。',
  '请读取桌面的“根据刚才已经读出的正文.docx”，给出完整正文和数量。',
 ])('keeps an independent affirmative new read: %s', task => {
  expect(requestsExactReadOnlyArtifactInspection(task)).toBe(true);
  const contract = buildActionEvidenceContract(task);
  expect(contract).toMatchObject({ kind: 'artifact_work', label: 'Exact read-only file inspection' });
  expect(hasCoreActionEvidence(contract, [], task, undefined, scope)).toBe(false);
 });
 it.each([
  context + '正文中的引文是“重新读取文件”。不要重新读取文件。',
  context + '假如重新读取文件，需要另行核对。不要重新读取文件。',
 ])('does not promote quoted or hypothetical rereads into a new instruction: %s', task => {
  expect(requestsExactReadOnlyArtifactInspection(task)).toBe(false);
  expect(buildActionEvidenceContract(task)).toMatchObject({ kind: 'none', applies: false });
 });
 it.each([
  [context + '不要重新读取原文件。请创建 D:/case-source/comparison.txt，内容为“数量不同”。', 'artifact_work'],
  [context + '不要重新读取原文件。然后给张律师发送消息“数量不同”。', 'messaging_send'],
 ])('keeps independent writes and sends subject to their own evidence: %s', (task, kind) => {
  const contract = buildActionEvidenceContract(task);
  expect(contract).toMatchObject({ kind, applies: true });
  expect(hasCoreActionEvidence(contract, [], task, undefined, scope)).toBe(false);
 });
 it('preserves a direct comparison answer without rerunning readers or producing files', async () => {
  const { normalizeActionIntent } = await import('../server/cognition/normalized_action_intent');
  const { finalizeLumiResponse } = await import('../server/cognition/result_finalizer');
  const task = context + '不要重新读取文件，也不要生成附件。';
  const answer = 'source-a.docx为12个，source-b.docx为9个，数量不一致，相差3个。';
  expect(normalizeActionIntent(task).kind).toBe('none');
  expect(finalizeLumiResponse({ taskText: task, responseText: answer, toolRecords: [], source: 'chat', ...scope }))
   .toMatchObject({ blocked: false, text: answer });
 });
});


describe('accepted current contracts survive known server context without inheriting history obligations', () => {
 const current = '根据刚才已经读出的正文，比较“source-a.docx”和“source-b.docx”的数量，直接在聊天回答。不要重新读取文件，也不要生成附件。';
 const accepted = { taskText: current, contract: buildActionEvidenceContract(current) };
 const routed = (text: string, marker: string, history: string) => text + '\n\n## ' + marker + '\n' + history;
 it.each([
  ['Recent action continuation context', 'Read D:/case-source/old.docx and show its complete contents.'],
  ['Recent action continuation context', 'Create D:/case-source/old.txt. Send the file to Reviewer.'],
  ['Current Turn Attachments', 'Read D:/case-source/old.docx and show its complete contents.'],
  ['Current Turn Attachments', 'Create D:/case-source/old.txt. Send the file to Reviewer.'],
  ['Internal client-surface continuation context', 'Read D:/case-source/old.docx and show its complete contents.'],
  ['Internal client-surface continuation context', 'Create D:/case-source/old.txt. Send the file to Reviewer.'],
 ])('does not revive historical actions for the exact accepted current NONE (%s): %s', async (marker, history) => {
  const task = routed(current, marker, history);
  const contract = buildActionEvidenceContract(task, undefined, accepted);
  expect(contract).toMatchObject({ kind: 'none', applies: false });
  expect(contract.components).toBeUndefined();
  // Full finalization is covered for the real historical continuation boundary.
  if (marker !== 'Recent action continuation context') return;
  const { finalizeLumiResponse } = await import('../server/cognition/result_finalizer');
  const answer = '比较已完成：source-a.docx为12个，source-b.docx为9个，数量不一致，相差3个。';
  expect(finalizeLumiResponse({ taskText: task, responseText: answer, source: 'chat', toolRecords: [],
   completionGuard: { blocked: false, text: answer }, flow: { routeText: task, acceptedActionContract: accepted } as any }))
   .toMatchObject({ blocked: false, text: answer });
 });
 it.each([
  'Read D:/case-source/new.docx and show its complete contents.',
  current + ' Then read D:/case-source/new.docx and show its complete contents.',
  current + ' Then create D:/case-source/new.txt.',
 ])('does not adopt old NONE for a different or merely prefix-matching current instruction: %s', text => {
  const task = routed(text, 'Recent action continuation context', 'Read D:/case-source/old.docx.');
  const contract = buildActionEvidenceContract(task, undefined, accepted);
  expect(contract.applies).toBe(true);
  expect(hasCoreActionEvidence(contract, [], task, undefined, scope)).toBe(false);
 });
 it.each([
  'Read D:/case-source/current.docx and show its complete contents.',
  'Create D:/case-source/current.txt with content "Current source".',
  'Read D:/case-source/current.docx and show its complete contents. Then create D:/case-source/current.txt.',
  'Read D:/case-source/current.docx and show its complete contents.\n\n请继续这个任务。',
 ])('keeps accepted fresh, compound and continuation requirements while excluding history: %s', text => {
  const currentContract = buildActionEvidenceContract(text);
  const canonical = { taskText: text, contract: currentContract };
  const task = routed(text, 'Recent action continuation context', 'Create D:/case-source/unrequested.txt. Send the file to Reviewer.');
  const observed = buildActionEvidenceContract(task, undefined, canonical);
  expect(currentContract.applies).toBe(true);
  expect(observed).toEqual(buildActionEvidenceContract(text, undefined, canonical));
  expect(JSON.stringify(observed)).not.toContain('unrequested');
  expect(hasCoreActionEvidence(observed, [], text, undefined, scope)).toBe(false);
 });
 it('still accepts a verified current read after exact canonical matching through server context', () => {
  const text = 'Read D:/case-source/current.docx and show its complete contents.';
  const canonical = { taskText: text, contract: buildActionEvidenceContract(text) };
  const task = routed(text, 'Recent action continuation context', 'Create D:/case-source/unrequested.txt.');
  const contract = buildActionEvidenceContract(task, undefined, canonical);
  const receipt = read({ name: 'read_docx', arguments: { filePath: 'D:/case-source/current.docx' } });
  expect(hasCoreActionEvidence(contract, [receipt], text, undefined, scope)).toBe(true);
 });
 it('preserves the existing exact whole-input canonical contract match', () => {
  const task = routed('Continue the accepted operation.', 'Recent action continuation context', 'Read D:/case-source/current.docx.');
  const canonical = { taskText: task, contract: accepted.contract };
  expect(buildActionEvidenceContract(task, undefined, canonical)).toMatchObject({ kind: 'none', applies: false });
 });
});
