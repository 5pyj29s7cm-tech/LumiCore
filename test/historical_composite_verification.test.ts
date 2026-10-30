import { expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { guardCompletionClaims } from '../server/work_product/completion_guard';
import { normalizeActionIntent } from '../server/cognition/normalized_action_intent';
import { buildActionContract, buildActionEvidenceContract, hasCoreActionEvidence } from '../server/cognition/action_contract';

const source = 'Read the file "D:/source.txt" and show its complete contents.';
const output = 'Then create the file "D:/output.txt" containing "DONE" and read it back.';
const sends = [
  ['另外通过微信把新文件发送给王经理。', '王经理'],
  ['再用微信给李女士发送文件。', '李女士'],
  ['请先通过微信把文件发送给陈经理。', '陈经理'],
  ['通过微信再把文件发送给陈经理。', '陈经理'],
  ['现在使用邮件给测试联系人发送文件。', '测试联系人'],
  ['另外把新文件发送给王经理。', '王经理'],
  ['请通过微信把解释如何发送文件的文字发送给我。', '我'],
  ['请通过微信给测试联系人发送如何使用微信的解释。', '测试联系人'],
  ['通过微信给王经理发消息今天几点到？', '王经理'],
  ['请通过微信给王经理发消息：你好吗？', '王经理'],
];
it.each(sends)('keeps discourse and channel qualifiers attached to the same external send: %s', (text, target) => {
  expect(normalizeActionIntent(text)).toMatchObject({ kind: 'messaging_send', target, sideEffectClass: 'external_commit' });
  const contract = buildActionContract(text);
  expect(contract.kind).toBe('messaging_send');
  expect(hasCoreActionEvidence(contract, [], text)).toBe(false);
});
it.each([0, 1, 2])('preserves an explicit send at independent clause position %s', index => {
  const parts = [source, output]; parts.splice(index, 0, sends[0][0]);
  const contract = buildActionEvidenceContract(parts.join(' '));
  expect(contract.components).toHaveLength(3);
  expect(contract.components!.filter(component => component.contract.kind === 'messaging_send')).toHaveLength(1);
  expect(hasCoreActionEvidence(contract, [], parts.join(' '))).toBe(false);
});
it.each([
  '不要另外通过微信把新文件发送给王经理。',
  '请勿再用微信给李女士发送文件。',
  '如果再用微信给李女士发送文件，会发生什么？',
  '假设另外通过微信把新文件发送给王经理，只解释这个例子。',
  '网页写着“另外通过微信把新文件发送给王经理”。请解释这句文字。',
  '原文写着“再用微信给李女士发送文件”。',
  '请写一段“再用微信给李女士发送文件”的说明。',
  '怎么再用微信给李女士发送文件？',
  '请读取 "D:/再用微信给李女士发送文件.txt"。',
  '请打开 https://example.invalid/再用微信给李女士发送文件 。',
  '请用微信演示如何给王经理发送文件。',
  '现在通过教程了解如何给王经理发送文件。',
  '请用微信告诉我如何给王经理发送文件。',
  '请通过微信说明给王经理发送文件的方法。',
  '请先通过微信把文件发送给王经理吗？',
  '另外通过微信把新文件发送给王经理？',
  '再用微信给李女士发送文件吗？',
  '请用微信详细解释一下如何给王经理发送文件。',
  '请通过微信教我一下怎么给李女士发送文件。',
])('does not grant delivery from negation, conditions, quotation or location operands: %s', text => {
  expect(normalizeActionIntent(text).kind).not.toBe('messaging_send');
  const contract = buildActionEvidenceContract(`${source} ${output} ${text}`);
  expect(contract.components?.some(component => component.contract.kind === 'messaging_send')).not.toBe(true);
});

const turn = { taskId: 'history-guard-task', requestId: 'history-guard-request' };
it.each(['complete', 'missing', 'old-turn', 'wrong-hash'])('keeps existing artifact retrieval under its own evidence contract: %s', variation => {
  const projectId = '00000000-0000-4000-8000-000000000001';
  const output = path.join(process.env.LUMI_DATA_DIR!, 'existing-artifact.mp4');
  const bytes = Buffer.from('Synthetic existing bytes only'); fs.writeFileSync(output, bytes);
  const task = `请把已有工程 ${projectId} 第3版已经保存的视频，以可播放或下载的视频附件发在这里。不要修改工程或任何文件。`;
  const contract = buildActionContract(task); expect(contract.artifactMode).toBe('retrieve');
  const payload = { ok: true, verified: true, status: 'retrieved', projectId, revision: 3, outputPath: output,
    artifacts: [{ type: 'video', path: output, size: bytes.length, sha256: variation === 'wrong-hash' ? '0'.repeat(64) : createHash('sha256').update(bytes).digest('hex') }] };
  const record: any = { ...turn, ...(variation === 'old-turn' ? { requestId: 'older-request' } : {}), name: 'chat_song_read', arguments: { projectId, revision: 3, includeOutput: true }, result: JSON.stringify(payload),
    terminalVerification: { status: 'verified', strategy: 'state_diff', reason: 'Synthetic retrieval' },
    capability: { capabilityId: 'creative.chat_song_read', lane: 'media', operation: 'observe', risk: 'low', sideEffects: [{ type: 'local_read', scope: 'synthetic artifact', reversible: true }], verification: { strategy: 'state_diff', required: true, requiredFields: ['ok','verified'], requiredValues: { ok: true, verified: true }, successStatuses: ['read', 'retrieved'], successSignals: [], limitations: [] } } };
  const result = guardCompletionClaims({ ...turn, task, response: '已取回已有文件，见附件。', toolCalls: variation === 'missing' ? [] : [record], acceptedActionContract: { taskText: task, contract } });
  expect(result.blocked).toBe(variation !== 'complete');
});

const desktopTask = '在当前WPS里面新建一个空白文档并写入：SYNTHETIC';
const desktopRecords: any[] = [
  { ...turn, name: 'desktop_active_window', arguments: {}, result: '{"title":"WPS Office","process_name":"wps.exe"}' },
  { ...turn, name: 'desktop_keyboard_press', arguments: { key: 'ctrl+n' }, result: 'Pressed: ctrl+n' },
  { ...turn, name: 'desktop_ui_type', arguments: { name: '正文', text: 'SYNTHETIC' }, result: '{"status":"ok","action":"type","typedLength":9}' },
  { ...turn, name: 'ocr_screen', arguments: {}, result: 'WPS Office 文档正文：SYNTHETIC' },
];
it.each([false, true])('still requires actual desktop mutation evidence for an accepted desktop contract: %s', complete => {
  expect(buildActionContract(desktopTask).kind).toBe('desktop_operation');
  const result = guardCompletionClaims({ ...turn, task: desktopTask, response: '已新建文档并写入指定内容。', toolCalls: complete ? desktopRecords : desktopRecords.slice(0, 1) });
  expect(result.blocked).toBe(!complete);
});

it.each([false, true])('verifies the desktop child of a composite independently of the local file: %s', complete => {
  const folder = path.join(process.env.LUMI_DATA_DIR!, 'composite-ui'); fs.mkdirSync(folder, { recursive: true });
  const sourcePath = path.join(folder, 'source.txt'), outputPath = path.join(folder, 'output.txt'); fs.writeFileSync(sourcePath, 'SOURCE'); fs.writeFileSync(outputPath, 'DONE');
  const task = `Read the file "${sourcePath}" and show its complete contents. Then create the file "${outputPath}" containing "DONE" and read it back. ${desktopTask}`;
  const contract = buildActionEvidenceContract(task);
  expect(contract.components?.some(component => component.contract.kind === 'desktop_operation')).toBe(true);
  const read = (p: string, result: string) => ({ ...turn, name: 'read_file', arguments: { path: p }, result, terminalVerification: { status: 'verified', strategy: 'terminal_receipt', reason: 'Synthetic current read' } });
  const records: any[] = [read(sourcePath, 'SOURCE'), { ...turn, name: 'write_file', arguments: { path: outputPath, content: 'DONE' }, result: 'File written: ' + outputPath, terminalVerification: { status: 'verified', strategy: 'artifact', reason: 'Synthetic current output' } }, read(outputPath, 'DONE'), ...(complete ? desktopRecords : [])];
  expect(hasCoreActionEvidence(contract, records, task, undefined, turn)).toBe(complete);
  expect(guardCompletionClaims({ ...turn, task, response: '所有操作已完成。', toolCalls: records, acceptedActionContract: { taskText: task, contract } }).blocked).toBe(!complete);
});
